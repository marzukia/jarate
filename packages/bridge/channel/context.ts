/**
 * /context — what is eating the session window (issue #48).
 *
 * ctx hits 95%, /compact is the hammer, but nobody can see WHY the window
 * is full: one 20k-token tool result? twenty 3k bash outputs? The session
 * JSONL has all the data; this module exposes it.
 *
 * /context parses the channel's ACTIVE session file (same discovery as
 * /usage: caller-resolved ctx session file, else findSessionFile(cwd)) and
 * reports, in one 40-col framed block:
 *   - top-N items by token ESTIMATE (default 10, `/context 20` accepts a
 *     count, capped at 40 to stay under Discord's 2000-char message limit)
 *   - totals by category (user / assistant / tool)
 *   - a "biggest eater" one-liner
 *
 * No model in the loop: every size is the char/4 heuristic (labeled "est"
 * in the output; no pricing).
 *
 * Item model: one item per content block, so a single assistant turn
 * surfaces as separate thinking / toolCall / text rows, and each toolResult
 * entry is one row (toolName + text + image data). Entries are deduped by
 * entry id, the same guard as /usage's assistant dedup. Non-conversation
 * entries (session, compaction, model_change, ...) are not counted.
 *
 * The frame obeys the 40-col mobile budget (docs/COMMANDS.md): box-drawing,
 * ASCII tags, no emoji.
 */

import { findSessionFile } from "./undo";
import { fmtTokens, linesOf } from "./usage";

export type CtxRole = "user" | "assistant" | "tool";
export type CtxType = "text" | "thinking" | "toolCall" | "toolResult";

/** One sized unit of context: a single content block of one session entry. */
export interface CtxItem {
  role: CtxRole;
  type: CtxType;
  chars: number;
  ts: number; // owning entry's timestamp, epoch ms (0 = missing)
  tool?: string; // tool name for toolCall / toolResult rows
}

export interface CtxScan {
  /** All sized items, sorted by chars desc (stable: file order on ties). */
  items: CtxItem[];
  totalChars: number;
  /** Earliest entry timestamp, epoch ms (0 = none). */
  baseTs: number;
}

/** char/4 heuristic — rounds up so the estimate never undercounts. */
export function estTokens(chars: number): number {
  return Math.ceil(chars / 4);
}

/** Compact age: 45s / 12m / 3h12m / 1d3h (max 6 chars, 40-col budget).
 *  Zero sub-units drop: 1h not 1h0m. */
export function fmtAge(ms: number): string {
  let s = Math.floor(ms / 1000);
  if (!Number.isFinite(s) || s < 0) s = 0;
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 === 0 ? `${h}h` : `${h}h${m % 60}m`;
  const d = Math.floor(h / 24);
  return h % 24 === 0 ? `${d}d` : `${d}d${h % 24}h`;
}

/** Safe JSON length (for toolCall arguments): 0 when unstringifiable. */
function jsonLen(v: unknown): number {
  if (v === undefined || v === null) return 2; // "{}"
  try {
    return JSON.stringify(v).length;
  } catch {
    return 0;
  }
}

/**
 * Stream ONE session jsonl file and extract the sized context items.
 * Reuses /usage's line scanner (linesOf: never loads the file whole,
 * tolerates a torn last line). Unparseable lines are skipped; entries are
 * deduped by id. Throws when the file cannot be opened (the caller turns
 * that into a one-line [!] error).
 */
export async function scanContextFile(file: string): Promise<CtxScan> {
  const items: CtxItem[] = [];
  const seen = new Set<string>();
  let totalChars = 0;
  let baseTs = 0;

  const add = (
    role: CtxRole,
    type: CtxType,
    chars: number,
    ts: number,
    tool?: string,
  ): void => {
    if (!Number.isFinite(chars) || chars <= 0) return;
    items.push({ role, type, chars, ts, tool });
    totalChars += chars;
  };

  for await (const line of linesOf(file)) {
    // Fast filter mirrors /usage: only conversation entries matter, and a
    // line that is not one never goes through JSON.parse.
    if (
      line.indexOf('"type":"message"') === -1 &&
      line.indexOf('"type":"custom_message"') === -1
    )
      continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue; // partial / torn line — tolerate
    }
    const o = entry as {
      type?: unknown;
      id?: unknown;
      timestamp?: unknown;
      content?: unknown;
      message?: unknown;
    };
    if (o.type !== "message" && o.type !== "custom_message") continue;
    const ts = typeof o.timestamp === "string" ? Date.parse(o.timestamp) : NaN;
    if (Number.isFinite(ts) && (baseTs === 0 || ts < baseTs)) baseTs = ts;
    const id = typeof o.id === "string" ? o.id : null;
    if (id !== null) {
      if (seen.has(id)) continue; // dedup: count each entry once
      seen.add(id);
    }

    if (o.type === "custom_message") {
      // Bridge inbound: content is the full prompt string (channel-ctx +
      // text) — that is exactly what the model sees, so count it whole.
      const c = o.content;
      add("user", "text", typeof c === "string" ? c.length : jsonLen(c), ts);
      continue;
    }

    const m = o.message as
      | { role?: unknown; toolName?: unknown; content?: unknown }
      | undefined;
    if (!m) continue;

    if (m.role === "toolResult") {
      // One row per tool result: the name + every text/image block.
      // Image data (base64) is counted as chars — a big over-estimate of
      // image tokens, but the point is to find the big eater.
      let chars = typeof m.toolName === "string" ? m.toolName.length : 0;
      const content = Array.isArray(m.content)
        ? m.content
        : typeof m.content === "string"
          ? [m.content]
          : [];
      for (const b of content) {
        if (typeof b === "string") {
          chars += b.length;
          continue;
        }
        const blk = b as { type?: unknown; text?: unknown; data?: unknown };
        if (blk?.type === "text" && typeof blk.text === "string")
          chars += blk.text.length;
        else if (blk?.type === "image" && typeof blk.data === "string")
          chars += blk.data.length;
      }
      add(
        "tool",
        "toolResult",
        chars,
        ts,
        typeof m.toolName === "string" ? m.toolName : undefined,
      );
      continue;
    }

    if (m.role !== "assistant" && m.role !== "user") continue;
    const role: CtxRole = m.role === "user" ? "user" : "assistant";
    const content = Array.isArray(m.content)
      ? m.content
      : typeof m.content === "string"
        ? [m.content]
        : [];
    for (const b of content) {
      if (typeof b === "string") {
        add(role, "text", b.length, ts);
        continue;
      }
      const blk = b as {
        type?: unknown;
        text?: unknown;
        thinking?: unknown;
        name?: unknown;
        arguments?: unknown;
      };
      if (blk?.type === "thinking" && typeof blk.thinking === "string")
        add(role, "thinking", blk.thinking.length, ts);
      else if (blk?.type === "toolCall") {
        // What the model sees: name + serialized arguments.
        const name = typeof blk.name === "string" ? blk.name : "";
        add(
          role,
          "toolCall",
          name.length + jsonLen(blk.arguments),
          ts,
          name || undefined,
        );
      } else if (blk?.type === "text" && typeof blk.text === "string")
        add(role, "text", blk.text.length, ts);
    }
  }

  // Stable sort: ties keep file order.
  items.sort((a, b) => b.chars - a.chars);
  return { items, totalChars, baseTs };
}

/**
 * Build the /context frame (WITHOUT the outer code fence — the caller
 * wraps it). Every line stays within the 40-col mobile budget.
 *
 * @param scan    parsed session items
 * @param n       requested top-N (already validated)
 * @param now     injectable clock (tests); defaults to Date.now()
 */
export function formatContext(
  scan: CtxScan,
  n: number,
  now = Date.now(),
): string {
  const { items, totalChars, baseTs } = scan;
  const shown = Math.min(n, items.length);
  const L: string[] = [];
  L.push("[context] est tokens (char/4)");
  L.push(
    `┌ top ${shown} of ${items.length} items · total ${fmtTokens(estTokens(totalChars))}`,
  );
  const date =
    baseTs > 0 ? new Date(baseTs).toISOString().slice(0, 10) : "unknown";
  L.push(`│ session ${date} · age ${baseTs > 0 ? fmtAge(now - baseTs) : "?"}`);
  for (let i = 0; i < shown; i++) {
    const it = items[i];
    const age = it.ts > 0 && baseTs > 0 ? fmtAge(it.ts - baseTs) : "?";
    L.push(
      `│ ${String(i + 1).padStart(2)} ${it.role.padEnd(9)} ${it.type.padEnd(10)} ${fmtTokens(estTokens(it.chars)).padStart(5)} ${age}`,
    );
  }
  if (shown === 0) L.push("│ (no sized items)");
  L.push("├ totals");
  for (const role of ["user", "assistant", "tool"] as const) {
    let chars = 0;
    let count = 0;
    for (const it of items)
      if (it.role === role) {
        chars += it.chars;
        count += 1;
      }
    L.push(
      `│ ${role.padEnd(9)} ${fmtTokens(estTokens(chars)).padStart(5)}  (${count})`,
    );
  }
  if (shown > 0) {
    const top = items[0];
    const name = top.tool ? ` (${top.tool.slice(0, 4)})` : "";
    // "asst" keeps the worst case (assistant + toolCall + tool name) at 40
    L.push(
      `└ biggest: ${top.role === "assistant" ? "asst" : top.role} ${top.type.padEnd(10)} ${fmtTokens(estTokens(top.chars)).padStart(5)}${name}`,
    );
  } else {
    // empty scan still closes the frame (STYLE 2.2: never ship open)
    L.push("└ no entries");
  }
  return L.join("\n");
}

/** Max count arg: 40 rows keeps the frame under Discord's 2000-char cap. */
export const CONTEXT_MAX_N = 40;

/**
 * Build the /context reply (one framed block, or a one-line [!] error —
 * never a stack).
 *
 * @param arg         raw command arg ("" | "20" | other)
 * @param cwd         the agent's working dir (fallback session discovery)
 * @param sessionFile the ACTIVE session file, resolved by the caller via
 *                    the same path as /usage (/undo): ctx session file,
 *                    else findSessionFile(cwd). Null when unknown.
 */
export async function renderContext(
  arg: string | undefined,
  cwd: string,
  sessionFile: string | null,
): Promise<string> {
  let n = 10;
  const raw = (arg ?? "").trim();
  if (raw !== "") {
    if (!/^\d+$/.test(raw)) return `[!] usage: /context [1-${CONTEXT_MAX_N}]`;
    n = Number.parseInt(raw, 10);
    if (n < 1 || n > CONTEXT_MAX_N)
      return `[!] usage: /context [1-${CONTEXT_MAX_N}]`;
  }
  const file = sessionFile ?? findSessionFile(cwd);
  if (!file) return "[!] no session file found";
  let scan: CtxScan;
  try {
    scan = await scanContextFile(file);
  } catch {
    return "[!] session file unreadable";
  }
  return formatContext(scan, n);
}
