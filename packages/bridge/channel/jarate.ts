// jarate — ONE LLM tool over the $HOME/bin/jarate JSON entrypoint (issue #17).
//
// The entrypoint owns the JSON contract (ok:true|false + error, snake_case,
// deterministic field order). This tool is a thin spawn: cmd + args string
// in, one JSON doc as text out. pi-bg workers (no extensions) run the same
// entrypoint via plain bash — identical surface.

import { spawn } from "node:child_process";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

/** 30s cap, overridable for tests. */
export function jarateTimeoutMs(): number {
  return Number(process.env.JARATE_TOOL_TIMEOUT_MS ?? 30_000);
}

const OUT_CAP = 20_000;

export interface JarateResult {
  out: string;
  code: number;
  timedOut: boolean;
}

/**
 * Spawn $HOME/bin/jarate with [cmd, args]. Mirrors runShellPassthrough's
 * timeout/cap idiom (index.ts): SIGKILL on timeout, first 20k chars kept.
 * `detached: true` puts the child in its own process group so the timeout
 * kill also takes down grandchild helpers (a hung `ssh`/`bun` holding the
 * stdout pipe would otherwise delay the close event past the cap).
 */
export function runJarate(
  cmd: string,
  args: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<JarateResult> {
  const jarate = path.join(env.HOME ?? "", "bin", "jarate");
  return new Promise((resolve) => {
    let p: ReturnType<typeof spawn>;
    try {
      p = spawn(jarate, [cmd, args], { env, detached: true });
    } catch (e) {
      resolve({
        out: `spawn failed: ${e instanceof Error ? e.message : String(e)}`,
        code: 1,
        timedOut: false,
      });
      return;
    }
    let out = "";
    let timedOut = false;
    const cap = (s: string) => {
      if (out.length < OUT_CAP) out += s.slice(0, OUT_CAP - out.length);
    };
    const t = setTimeout(() => {
      timedOut = true;
      try {
        if (p.pid)
          process.kill(-p.pid, "SIGKILL"); // whole group
        else p.kill("SIGKILL");
      } catch {
        try {
          p.kill("SIGKILL");
        } catch {
          /* already dead */
        }
      }
    }, jarateTimeoutMs());
    p.stdout?.on("data", (d) => cap(String(d)));
    p.stderr?.on("data", (d) => cap(String(d)));
    p.on("error", (e) => {
      clearTimeout(t);
      resolve({ out: `spawn failed: ${e.message}`, code: 1, timedOut: false });
    });
    p.on("close", (code) => {
      clearTimeout(t);
      resolve({ out, code: code ?? 1, timedOut });
    });
  });
}

/**
 * Normalize a run to the single JSON shape the LLM relies on:
 *   - timeout      -> {"ok":false,"error":"jarate timed out after Ns"}
 *   - exit 0       -> entrypoint stdout (it emitted its own JSON doc)
 *   - non-zero     -> stdout if it starts with '{' (entrypoint error doc),
 *                     else a synthesized ok:false with the output tail.
 */
export function jarateText(r: JarateResult): string {
  if (r.timedOut) {
    return JSON.stringify({
      ok: false,
      error: `jarate timed out after ${Math.round(jarateTimeoutMs() / 1000)}s`,
    });
  }
  const out = r.out.trim();
  if (r.code === 0 && out) return out;
  if (out.startsWith("{")) return out;
  const tail = out.slice(0, 500) || "no output";
  return JSON.stringify({
    ok: false,
    error: `jarate exited ${r.code}: ${tail}`,
  });
}

const JARATE_COMMANDS = ["ctx-report", "journal-errors", "memory-grep", "rag"];

/**
 * Register the single `jarate` tool (cmd + args string). Subcommands are
 * documented in the description; output is one JSON doc — check `ok`.
 */
export function registerJarateTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "jarate",
    label: "jarate ops",
    description:
      "Machine-ops helpers as JSON (ok:true|false + error, snake_case, read-only). " +
      "ctx-report: this agent's context % + lifetime token cost (pi-token-cost). " +
      "journal-errors [--since S] [--agent N]: pi.service warnings, all agents (since = absolute datetime, default 1h back). " +
      "memory-grep <query> [--root D] [--regex]: search ~/memory, top-20 matches. " +
      "rag <question> [--project P]: RAG query over project knowledge (recall).",
    promptSnippet:
      "jarate <cmd> <args>: machine ops (ctx-report, journal-errors, memory-grep, rag) as JSON",
    promptGuidelines: [
      "Use jarate for machine state: context/cost (ctx-report), pi.service warnings (journal-errors), memory search (memory-grep), project knowledge (rag).",
      "jarate takes one cmd + one space-separated args string; output is a single JSON doc — check ok before trusting fields.",
    ],
    parameters: Type.Object({
      cmd: Type.String({
        enum: JARATE_COMMANDS,
        description: "jarate subcommand",
      }),
      args: Type.Optional(
        Type.String({
          description: "space-separated args for the subcommand (may be empty)",
        }),
      ),
    }),
    async execute(
      _toolCallId,
      params: { cmd: string; args?: string },
      _signal,
      _onUpdate,
      _ctx,
    ) {
      const r = await runJarate(params.cmd, params.args ?? "");
      return {
        content: [{ type: "text", text: jarateText(r) }],
        details: {},
      };
    },
  });
}
