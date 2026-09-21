/**
 * MCP bridge — connects pi to MCP servers over streamable HTTP.
 *
 * Config: `mcp` array in ~/.pi/agent/settings.json
 *   { "mcp": [ { "name": "tavily", "url": "https://mcp.tavily.com/mcp/?tavilyApiKey=${TAVILY_API_KEY}" } ] }
 *
 * `${VAR}` references are resolved from the process environment, so API keys
 * live in a secrets file supplied by pi.service's EnvironmentFile
 * (e.g. TAVILY_API_KEY in ~/.pi/agent/secrets.env, chmod 600) rather than
 * sitting in settings.json next to other credentials. An unresolved
 * reference is reported on stderr and expands to an empty string.
 *
 * For each server, fetches tools via tools/list and registers them as
 * native pi tools. Tool calls are proxied via tools/call.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

// ─── Config ────────────────────────────────────────────────────────────────

interface McpServerConfig {
  name: string;
  url: string;
  /** Only register these tools (optional). */
  tools?: string[];
}

function expandEnv(value: string, missing: Set<string>): string {
  return value.replace(
    /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g,
    (_m, name: string) => {
      const v = process.env[name];
      if (v === undefined) {
        missing.add(name);
        return "";
      }
      return v;
    },
  );
}

function loadMcpConfigs(): McpServerConfig[] {
  const candidates = [
    path.join(process.env.HOME || "", ".pi/agent/settings.json"),
    "/root/.pi/agent/settings.json",
  ];
  for (const file of candidates) {
    try {
      if (!fs.existsSync(file)) continue;
      const settings = JSON.parse(fs.readFileSync(file, "utf8"));
      const mcp = settings?.mcp;
      if (Array.isArray(mcp)) {
        // Secrets stay out of settings.json: `${VAR}` is resolved from the
        // process environment, which pi.service supplies via EnvironmentFile
        // (e.g. TAVILY_API_KEY in ~/.pi/agent/secrets.env).
        return mcp
          .filter((c: any) => c?.url)
          .map((c: any) => {
            const missing = new Set<string>();
            const url = expandEnv(String(c.url), missing);
            if (missing.size > 0) {
              console.error(
                `[mcp] ${c.name}: unresolved env var(s): ${[...missing].join(", ")}`,
              );
            }
            return { ...c, url };
          });
      }
    } catch {
      /* ignore */
    }
  }
  return [];
}

// ─── MCP client (streamable HTTP, stateless or session-based) ──────────────

interface McpClient {
  name: string;
  url: string;
  sessionId: string | null;
  protocolVersion: string | null;
  request: (method: string, params?: any) => Promise<any>;
}

async function parseMcpResponse(resp: Response): Promise<any> {
  const _ct = resp.headers.get("content-type") || "";
  const text = await resp.text();
  const sessionId = resp.headers.get("mcp-session-id");
  return { body: extractJsonRpc(text), sessionId };
}

function extractJsonRpc(text: string): any {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  // Plain JSON
  if (trimmed.startsWith("{")) {
    return JSON.parse(trimmed);
  }
  // SSE: "event: message\ndata: {...}" lines (possibly multiple)
  const out: any[] = [];
  for (const line of trimmed.split("\n")) {
    const l = line.trim();
    if (l.startsWith("data:")) {
      const payload = l.slice(5).trim();
      try {
        const obj = JSON.parse(payload);
        out.push(obj);
      } catch {
        /* skip malformed */
      }
    }
  }
  if (out.length === 0) return undefined;
  // Prefer the one with a result/error
  return out.find((o) => o && (o.result !== undefined || o.error)) ?? out[0];
}

async function createMcpClient(config: McpServerConfig): Promise<McpClient> {
  let sessionId: string | null = null;
  let protocolVersion: string | null = null;

  async function request(method: string, params?: any): Promise<any> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    };
    if (sessionId) headers["MCP-Session-Id"] = sessionId;
    if (protocolVersion) headers["MCP-Protocol-Version"] = protocolVersion;

    const resp = await fetch(config.url, {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method, params }),
    });
    if (!resp.ok) {
      const errText = await resp.text().catch(() => "");
      throw new Error(
        `MCP ${method}: HTTP ${resp.status} ${errText.slice(0, 200)}`,
      );
    }
    const parsed = await parseMcpResponse(resp);
    if (parsed.sessionId) sessionId = parsed.sessionId;

    if (parsed.body?.error) {
      throw new Error(
        `MCP ${method}: ${parsed.body.error.message || JSON.stringify(parsed.body.error)}`,
      );
    }
    if (method === "initialize") {
      protocolVersion = parsed.body?.result?.protocolVersion ?? null;
    }
    return parsed.body?.result;
  }

  // Handshake
  const initResult = await request("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "pi", version: "0.0.0" },
  });
  if (initResult?.protocolVersion) protocolVersion = initResult.protocolVersion;

  return {
    name: config.name,
    url: config.url,
    sessionId,
    protocolVersion,
    request,
  };
}

// ─── Extension ─────────────────────────────────────────────────────────────

export default async function (pi: ExtensionAPI) {
  const configs = loadMcpConfigs();
  if (configs.length === 0) return;

  const registered = new Set<string>(["bash", "read", "write", "edit"]);

  for (const config of configs) {
    let client: McpClient;
    try {
      client = await createMcpClient(config);
    } catch (err) {
      console.error(
        `[mcp] ${config.name}: failed to connect: ${(err as Error).message}`,
      );
      continue;
    }

    let tools: any[] = [];
    try {
      const result = await client.request("tools/list");
      tools = result?.tools || [];
    } catch (err) {
      console.error(
        `[mcp] ${config.name}: tools/list failed: ${(err as Error).message}`,
      );
      continue;
    }

    for (const tool of tools) {
      if (!tool?.name || !tool?.inputSchema) continue;
      if (config.tools && !config.tools.includes(tool.name)) continue;

      let name = tool.name;
      if (registered.has(name)) {
        name = `${config.name}_${tool.name}`;
        if (registered.has(name)) continue;
      }
      registered.add(name);

      const description =
        tool.description || `MCP tool ${tool.name} (${config.name})`;
      const parameters = Type.Unsafe({
        type: "object",
        properties: tool.inputSchema.properties || {},
        required: tool.inputSchema.required || [],
        additionalProperties: false,
      }) as any;

      pi.registerTool({
        name,
        label: `${config.name}: ${tool.name}`,
        description,
        promptSnippet: description.slice(0, 160),
        parameters,
        async execute(_toolCallId, params, signal) {
          if (signal?.aborted)
            return {
              content: [{ type: "text", text: "Cancelled" }],
              details: {},
            };

          const result = await client.request("tools/call", {
            name: tool.name,
            arguments: params || {},
          });

          const isError = result?.isError === true;
          const parts: string[] = [];
          if (Array.isArray(result?.content)) {
            for (const item of result.content) {
              if (item?.type === "text" && typeof item.text === "string") {
                parts.push(item.text);
              } else if (item?.type === "image") {
                parts.push(`[image: ${item.mimeType || "unknown"}]`);
              }
            }
          }
          if (
            result?.structuredContent &&
            Object.keys(result.structuredContent).length > 0
          ) {
            try {
              parts.push(JSON.stringify(result.structuredContent, null, 2));
            } catch {
              /* ignore */
            }
          }
          const text =
            parts.length > 0
              ? parts.join("\n")
              : JSON.stringify(result ?? null);

          return {
            content: [{ type: "text" as const, text: text.slice(0, 100_000) }],
            details: { mcpServer: config.name, mcpTool: tool.name },
            isError,
          };
        },
      });
    }
  }
}
