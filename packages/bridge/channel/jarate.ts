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
import { shellWords } from "../../../bin/shell-words";

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
 * kill also takes down grandchild helpers (a hung helper holding the
 * stdout pipe would otherwise delay the close event past the cap).
 *
 * `opts.timeoutMs`: per-call cap; defaults to `jarateTimeoutMs()` (30s,
 * overridable via JARATE_TOOL_TIMEOUT_MS for tests).
 */
export function runJarate(
  cmd: string,
  args: string,
  opts: { env?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
): Promise<JarateResult> {
  const env = opts.env ?? process.env;
  const timeoutMs = opts.timeoutMs ?? jarateTimeoutMs();
  const jarate = path.join(env.HOME ?? "", "bin", "jarate");
  return new Promise((resolve) => {
    let p: ReturnType<typeof spawn>;
    // One flag grammar (#148): the tool's single args string is re-split
    // with the shared shellWords parser (bin/shell-words.ts), so the
    // entrypoint sees real argv (quoted values, --flag=value, two-word
    // re-joins). Unparseable -> executable JSON doc, no spawn.
    let argv: string[];
    try {
      argv = [cmd, ...shellWords(args)];
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e);
      resolve({
        out: JSON.stringify({
          ok: false,
          error: `jarate: args not parseable: ${why}. Re-send with balanced quotes, e.g. jarate ${cmd} --since "<value>"`,
        }),
        code: 2,
        timedOut: false,
      });
      return;
    }
    try {
      p = spawn(jarate, argv, { env, detached: true });
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
    }, timeoutMs);
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
export function jarateText(r: JarateResult, timeoutMs?: number): string {
  if (r.timedOut) {
    return JSON.stringify({
      ok: false,
      error: `jarate timed out after ${Math.round((timeoutMs ?? jarateTimeoutMs()) / 1000)}s`,
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

const JARATE_COMMANDS = [
  "setup",
  "ctx-report",
  "journal-errors",
  "projects",
  "projects-backfill",
  "agents-check",
  "agents-bless",
];

/**
 * Register the single `jarate` tool (cmd + args string). Subcommands are
 * documented in the description; output is one JSON doc — check `ok`.
 */
export function registerJarateTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "jarate",
    label: "jarate ops",
    description:
      "Machine-ops helpers as JSON (ok:true|false + error, snake_case). " +
      "setup <bot-token> <channel> [--yes]: fresh-node FTUE (default dry-run; --yes executes). " +
      "ctx-report: this agent's context % + lifetime token cost (pi-token-cost). " +
      "journal-errors [--since S] [--agent N]: pi.service warnings, all agents (since = absolute datetime, default 1h back). " +
      "projects [--project T] [--since D] [--agent A]: per-project rollup over pi-bg run records (runs/tokens/cost; untagged -> unspecified). " +
      "projects-backfill [--agent A] [--dry-run] [--set RUN=TAG]: tag historical untagged run records. " +
      "agents-check: AGENTS.md vs manifest (drift tripwire, read-only). " +
      "agents-bless [note]: rewrite the AGENTS.md manifest (re-bless an approved change).",
    promptSnippet:
      "jarate <cmd> <args>: machine ops (ctx-report, journal-errors) as JSON",
    promptGuidelines: [
      "Use jarate for machine state: context/cost (ctx-report), pi.service warnings (journal-errors).",
      "jarate takes one cmd + one space-separated args string; output is a single JSON doc — check ok before trusting fields.",
    ],
    parameters: Type.Object({
      cmd: Type.String({
        enum: JARATE_COMMANDS,
        description: "jarate subcommand",
      }),
      args: Type.Optional(
        Type.String({
          description:
            'args for the subcommand, space-separated (may be empty). Values with spaces go in double quotes; `--flag value` and `--flag=value` both work. Example: --since "2026-10-05 00:00:00"',
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
      const args = params.args ?? "";
      const r = await runJarate(params.cmd, args);
      return {
        content: [
          {
            type: "text",
            text: jarateText(r),
          },
        ],
        details: {},
      };
    },
  });
}
