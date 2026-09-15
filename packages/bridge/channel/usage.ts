/**
 * /usage — token usage for the current session (default) or lifetime
 * ("all"), read from pi's session store (~/.pi/agent/sessions, one jsonl file
 * per session).
 *
 * Each line is one session entry. Only entries with `"type":"message"`
 * (NOT `"message_update"` streaming deltas) and `message.role ===
 * "assistant"` carry billable `usage`. Assistant turns are de-duplicated by
 * their top-level entry `id`; entries with missing or all-zero usage are
 * skipped; a partial last line (live jsonl still being written) is tolerated.
 *
 * Cost model: OpenRouter list rates for our vLLM model, canonical table in
 * /home/monky/scripts/pi-token-cost.py:
 *   prompt 0.42/1M, completion 3.00/1M, cacheRead 0.085/1M.
 * cacheWrite is priced at the prompt rate (same assumption as that script;
 * it is 0 on our vLLM so it never affects the estimate).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { findSessionFile, sessionsBaseDir } from "./undo";

export interface UsageStats {
  turns: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

const EMPTY: UsageStats = {
  turns: 0,
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
};

const PRICING_PER_M = {
  prompt: 0.42,
  completion: 3.0,
  cacheRead: 0.085,
  // cacheWrite has no list price; billed at the prompt rate (assumption).
  cacheWrite: 0.42,
} as const;

export function estimateCost(s: UsageStats): number {
  return (
    (s.input * PRICING_PER_M.prompt +
      s.output * PRICING_PER_M.completion +
      s.cacheRead * PRICING_PER_M.cacheRead +
      s.cacheWrite * PRICING_PER_M.cacheWrite) /
    1_000_000
  );
}

/** Human-readable token count: 999 -> "999", 61000 -> "61K", 8.2e6 ->
 *  "8.2M", 1e9 -> "1.0B". B (not a wider M) keeps the /context frame rows
 *  at 4 cols: `1000.0M` would push `└ biggest: ...` to 34 cols
 *  (PR #64 review P3). */
export function fmtTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${Math.round(n / 1000)}K`;
  if (n < 1_000_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  return `${(n / 1_000_000_000).toFixed(1)}B`;
}

/**
 * Sum assistant `usage` across the messages of ONE run — the agent_end
 * `event.messages`, i.e. every step's assistant reply of THIS run (pi's
 * run loop accumulates all steps there; a failed run's synthetic failure
 * message carries EMPTY_USAGE and sums to zero). Same four fields as the
 * session-file parser (input/output/cacheRead/cacheWrite); in-memory run
 * messages are unique, so no id dedup is needed.
 */
export function sumRunUsage(messages: unknown[]): UsageStats {
  const s: UsageStats = { ...EMPTY };
  for (const m of messages) {
    const msg = m as { role?: unknown; usage?: unknown } | null | undefined;
    if (msg?.role !== "assistant") continue;
    const u = msg.usage;
    if (typeof u !== "object" || u === null) continue;
    const num = (k: string): number => {
      const v = (u as Record<string, unknown>)[k];
      return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0;
    };
    const input = num("input");
    const output = num("output");
    const cacheRead = num("cacheRead");
    const cacheWrite = num("cacheWrite");
    if (input + output + cacheRead + cacheWrite === 0) continue;
    s.turns += 1;
    s.input += input;
    s.output += output;
    s.cacheRead += cacheRead;
    s.cacheWrite += cacheWrite;
  }
  return s;
}

/** True when the stats carry any billable tokens at all. */
export function hasUsage(s: UsageStats): boolean {
  return s.input + s.output + s.cacheRead + s.cacheWrite > 0;
}

function addEntry(s: UsageStats, entry: unknown, seen: Set<string>): void {
  const o = entry as {
    type?: unknown;
    id?: unknown;
    message?: { role?: unknown; usage?: unknown };
  };
  if (o.type !== "message" || o.message?.role !== "assistant") return;
  const u = o.message.usage;
  if (typeof u !== "object" || u === null) return;
  const num = (k: string): number => {
    const v = (u as Record<string, unknown>)[k];
    return typeof v === "number" && Number.isFinite(v) ? v : 0;
  };
  const input = num("input");
  const output = num("output");
  const cacheRead = num("cacheRead");
  const cacheWrite = num("cacheWrite");
  if (input + output + cacheRead + cacheWrite === 0) return; // skip zero usage
  const id = typeof o.id === "string" ? o.id : null;
  if (id !== null) {
    if (seen.has(id)) return; // dedup: count each assistant turn once
    seen.add(id);
  }
  s.turns += 1;
  s.input += input;
  s.output += output;
  s.cacheRead += cacheRead;
  s.cacheWrite += cacheWrite;
}

/** Stream a file line by line (never loaded whole); yields a torn last line.
 *  Shared scanner for /usage and /context — do not duplicate. */
export async function* linesOf(file: string): AsyncGenerator<string> {
  // NOTE: must be runtime-agnostic - the bridge runs inside pi (node), not
  // bun. Bun.file() threw ReferenceError in production and the caller's
  // catch turned it into all-zero stats (2026-09-10 /usage incident).
  const dec = new TextDecoder();
  let buf = "";
  for await (const chunk of fs.createReadStream(file)) {
    buf += dec.decode(chunk, { stream: true });
    for (;;) {
      const i = buf.indexOf("\n");
      if (i === -1) break;
      let line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      yield line;
    }
  }
  buf += dec.decode();
  if (buf.length > 0) yield buf; // trailing line without final newline
}

/**
 * Stream one session jsonl file and sum assistant usage. The file is read
 * line by line (never loaded whole); a torn last line or any unparseable
 * line is skipped.
 */
export async function summarizeSessionFile(
  file: string,
  seen: Set<string> = new Set(),
  target: UsageStats = { ...EMPTY },
): Promise<UsageStats> {
  const s = target;
  try {
    for await (const line of linesOf(file)) {
      if (!line || line.indexOf('"type":"message"') === -1) continue;
      let entry: unknown;
      try {
        entry = JSON.parse(line);
      } catch {
        continue; // partial / torn line — tolerate
      }
      addEntry(s, entry, seen);
    }
  } catch {
    // unreadable file: return what we have
  }
  return s;
}

/** Date (YYYY-MM-DD) from a pi session filename; null when unrecognizable. */
function dateFromName(file: string): string | null {
  const m = path.basename(file).match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
}

function dateFromMtime(file: string): string {
  try {
    return new Date(fs.statSync(file).mtimeMs).toISOString().slice(0, 10);
  } catch {
    return "unknown";
  }
}

export function usageLine(
  label: string,
  dateStr: string,
  s: UsageStats,
): string {
  const cacheReadPart =
    label === "session" || s.cacheRead > 0 ? ` | cacheRead ${s.cacheRead}` : "";
  return `[usage] ${label.padEnd(10)}${dateStr.padEnd(17)} | ${s.turns.toLocaleString("en-US")} turns | in ${fmtTokens(s.input)} | out ${fmtTokens(s.output)}${cacheReadPart} | est $${estimateCost(s).toFixed(2)}`;
}

/**
 * Build the /usage reply.
 *
 * @param arg       the raw command arg ("" | "session" | "all" | other)
 * @param cwd       the agent's working dir (fallback session discovery)
 * @param sessionFile the ACTIVE session file, resolved by the caller via the
 *                    same path as /undo (/reset): ctx session file, else
 *                    findSessionFile(cwd). Null when unknown.
 */
export async function renderUsage(
  arg: string | undefined,
  cwd: string,
  sessionFile: string | null,
): Promise<string> {
  const scope = (arg ?? "").trim().toLowerCase();
  if (
    scope !== "" &&
    scope !== "session" &&
    scope !== "all" &&
    scope !== "last"
  )
    return "[!] usage: /usage [all|session|last]";

  if (scope === "all") {
    const base = sessionsBaseDir();
    const files: string[] = [];
    const collect = (dir: string) => {
      for (const f of fs.readdirSync(dir)) {
        if (!f.endsWith(".jsonl")) continue; // skips *.jsonl.reset-* / *.undo-tmp
        files.push(path.join(dir, f));
      }
    };
    let earliest: string | null = null;
    try {
      for (const d of fs.readdirSync(base)) {
        const sub = path.join(base, d);
        try {
          if (!fs.statSync(sub).isDirectory()) continue;
        } catch {
          continue;
        }
        collect(sub);
      }
      collect(base); // files directly under base, if any
    } catch {
      return "[!] no session files found";
    }
    if (files.length === 0) return "[!] no session files found";
    const seen = new Set<string>();
    let s: UsageStats = { ...EMPTY };
    for (const f of files) {
      s = await summarizeSessionFile(f, seen, s);
      const d = dateFromName(f);
      if (d && (!earliest || d < earliest)) earliest = d;
    }
    const span = `${earliest ?? dateFromMtime(files[0])}..now`;
    return usageLine("lifetime", span, s);
  }

  // default + "session": the current session file
  const file = sessionFile ?? findSessionFile(cwd);
  if (!file) return "[!] no session file found";
  const s = await summarizeSessionFile(file);
  return usageLine("session", dateFromName(file) ?? dateFromMtime(file), s);
}
