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
 * Cost model: per-model OpenRouter list rates (USD per 1M tokens), keyed by
 * the `model` field on pi's assistant messages (exact match). Local vLLM
 * models (qwen3.8-27b, any provider) and unknown models fall back to
 * VLLM_QWEN_RATES - the historical single rate (OpenRouter list rates for
 * our vLLM model, canonical table in /home/monky/scripts/pi-token-cost.py:
 * prompt 0.42/1M, completion 3.00/1M, cacheRead 0.085/1M; cacheWrite at the
 * prompt rate, the script's assumption - it is 0 on our vLLM so it never
 * affects the estimate). OpenRouter API fetch 2026-11-05
 * (https://openrouter.ai/api/v1/models): x-ai/grok-4.6 = 2.00 / 6.00 /
 * 0.50 (no cacheWrite listed = not billed; the >200K-prompt override tier
 * is not modeled - the estimator is a single-rate approximation);
 * deepseek/deepseek-v4.1-flash = 0.045 / 0.50 / 0.018 (no cacheWrite
 * listed).
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
  /** Per-model breakdown, keyed by the message `model` field ("" when the
   * message carries no model). Set lazily on the first usage-bearing turn;
   * estimateCost prices each bucket at its model's rate. Absent on zero-usage
   * stats (keeps the historical shape for empty results). */
  models?: Record<string, UsageStats>;
}

const EMPTY: UsageStats = {
  turns: 0,
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
};

/** USD per 1M tokens. */
export interface ModelRates {
  prompt: number;
  completion: number;
  cacheRead: number;
  cacheWrite: number;
}

const VLLM_QWEN_RATES: ModelRates = {
  prompt: 0.42,
  completion: 3.0,
  cacheRead: 0.085,
  // cacheWrite has no list price; billed at the prompt rate (assumption).
  cacheWrite: 0.42,
};

const OPENROUTER_RATES: Record<string, ModelRates> = {
  "x-ai/grok-4.6": {
    prompt: 2.0,
    completion: 6.0,
    cacheRead: 0.5,
    cacheWrite: 0.0,
  },
  "deepseek/deepseek-v4.1-flash": {
    prompt: 0.045,
    completion: 0.5,
    cacheRead: 0.018,
    cacheWrite: 0.0,
  },
};

/** The rate table for a message's model id: exact table match, else the
 * local vLLM qwen fallback. "" / missing model = fallback. */
export function ratesFor(model: string | undefined): ModelRates {
  return (model && OPENROUTER_RATES[model]) || VLLM_QWEN_RATES;
}

function costAt(s: UsageStats, r: ModelRates): number {
  return (
    (s.input * r.prompt +
      s.output * r.completion +
      s.cacheRead * r.cacheRead +
      s.cacheWrite * r.cacheWrite) /
    1_000_000
  );
}

export function estimateCost(s: UsageStats): number {
  if (s.models) {
    let total = 0;
    for (const [m, bucket] of Object.entries(s.models))
      total += costAt(bucket, ratesFor(m || undefined));
    return total;
  }
  return costAt(s, VLLM_QWEN_RATES);
}

/** Accumulate one usage-bearing turn into the total AND its per-model
 * bucket (lazy init on first hit). */
function addBucket(
  s: UsageStats,
  model: string,
  input: number,
  output: number,
  cacheRead: number,
  cacheWrite: number,
): void {
  if (s.models === undefined) s.models = {};
  let b = s.models[model];
  if (b === undefined) {
    b = { turns: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    s.models[model] = b;
  }
  b.turns += 1;
  b.input += input;
  b.output += output;
  b.cacheRead += cacheRead;
  b.cacheWrite += cacheWrite;
}

/** Human-readable token count: 999 -> "999", 61000 -> "61K", 8.2e6 ->
 *  "8.2M", 1e9 -> "1.0B". B (not a wider M) keeps big counts at 4 chars -
 *  compact for the /context and /usage summary lines (PR #64 review P3). */
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
    const msg = m as
      | {
          role?: unknown;
          usage?: unknown;
          model?: unknown;
        }
      | null
      | undefined;
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
    addBucket(
      s,
      typeof msg.model === "string" ? msg.model : "",
      input,
      output,
      cacheRead,
      cacheWrite,
    );
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
    message?: { role?: unknown; usage?: unknown; model?: unknown };
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
  addBucket(
    s,
    typeof o.message.model === "string" ? o.message.model : "",
    input,
    output,
    cacheRead,
    cacheWrite,
  );
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

/**
 * Build the /usage reply as a normal markdown list (Andryo 2026-10-18:
 * summaries are markdown lists, no frame, no width budget). Bold header
 * line + key: value bullets - the caller posts it UNfenced so Discord
 * renders it as plain text (a fenced list would show the markdown
 * literally).
 */
export function usageSummary(
  label: string,
  span: string,
  s: UsageStats,
): string {
  // share of the TOTAL prompt (new + cached) served from cache - the
  // number operator watches; cacheRead can exceed the new-input count.
  const total = s.input + s.cacheRead;
  const pct = total > 0 ? Math.round((s.cacheRead / total) * 100) : 0;
  // Per-model breakdown only when two or more distinct models carry tokens -
  // the single-model line stays byte-identical to the historical shape.
  let estLine = `- est: $${estimateCost(s).toFixed(2)}`;
  if (s.models) {
    const names = Object.keys(s.models).filter((m) => {
      const b = s.models![m];
      return b.input + b.output + b.cacheRead + b.cacheWrite > 0;
    });
    if (names.length > 1) {
      const parts = names.map(
        (m) =>
          `${m || "default"} $${costAt(s.models![m], ratesFor(m || undefined)).toFixed(2)}`,
      );
      estLine = `- est: $${estimateCost(s).toFixed(2)} (${parts.join(" · ")})`;
    }
  }
  return [
    `**usage · ${label}**`,
    "",
    `- span: ${span}`,
    `- turns: ${s.turns.toLocaleString("en-US")}`,
    `- in: ${fmtTokens(s.input)}`,
    `- out: ${fmtTokens(s.output)}`,
    `- cached: ${fmtTokens(s.cacheRead)} (${pct}%)`,
    estLine,
  ].join("\n");
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
    return "usage: /usage [all|session|last]";

  if (scope === "all") {
    const base = sessionsBaseDir();
    const files: string[] = [];
    const collect = (dir: string) => {
      for (const f of fs.readdirSync(dir)) {
        if (!f.endsWith(".jsonl")) continue; // skips *.jsonl.reset-* / *.jsonl.<pid>.<ts>.tmp
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
      return "no session files found";
    }
    if (files.length === 0) return "no session files found";
    const seen = new Set<string>();
    let s: UsageStats = { ...EMPTY };
    for (const f of files) {
      s = await summarizeSessionFile(f, seen, s);
      const d = dateFromName(f);
      if (d && (!earliest || d < earliest)) earliest = d;
    }
    const span = `${earliest ?? dateFromMtime(files[0])}..now`;
    return usageSummary("lifetime", span, s);
  }

  // default + "session": the current session file
  const file = sessionFile ?? findSessionFile(cwd);
  if (!file) return "no session file found";
  const s = await summarizeSessionFile(file);
  return usageSummary("session", dateFromName(file) ?? dateFromMtime(file), s);
}
