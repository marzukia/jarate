/**
 * Todo board: per-channel state, rendering, and worker-intake helpers.
 *
 * State lives at ~/.pi/agent/todos/<channelId>.json (atomic tmp+rename
 * write). The Discord board message (post/edit-in-place) is wired in
 * channel/index.ts via syncTodoBoard — this module is pure-ish: only the
 * load/save/clear/list functions touch the filesystem.
 *
 * The `home` parameter on every fs function exists for test isolation
 * (tests point it at a temp dir instead of the real $HOME).
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { atomicWriteJson } from "./durable-store";
import { compactionLoopCapBytes } from "./size-caps";
import { getDefaultChannel, loadChannelConfig } from "./types";

export type TodoStatus = "pending" | "in_progress" | "completed" | "cancelled";

export const TODO_STATUSES: TodoStatus[] = [
  "pending",
  "in_progress",
  "completed",
  "cancelled",
];

export interface Todo {
  content: string;
  status: TodoStatus;
}

export interface TodoBoard {
  channelId: string;
  todos: Todo[];
  updatedAt: string;
  /** Discord message id of the posted board (edited in place on updates). */
  boardMessageId?: string;
}

// ─── State file ────────────────────────────────────────────────────────────

/**
 * Live $HOME resolution. node's os.homedir() is cached after first call
 * in some runtimes (bun), which breaks per-test HOME isolation — read the
 * env var directly, fall back to the (possibly cached) os value.
 */
export function defaultHome(): string {
  return process.env.HOME || os.homedir();
}

export function todosDir(home = defaultHome()): string {
  return path.join(home, ".pi", "agent", "todos");
}

export function boardPath(channelId: string, home = defaultHome()): string {
  return path.join(todosDir(home), `${channelId}.json`);
}

/** Load a channel's board; null when missing or unreadable/corrupt. */
export function loadBoard(
  channelId: string,
  home = defaultHome(),
): TodoBoard | null {
  let raw: string;
  try {
    raw = fs.readFileSync(boardPath(channelId, home), "utf8");
  } catch {
    return null;
  }
  try {
    const data = JSON.parse(raw);
    if (!data || !Array.isArray(data.todos)) return null;
    const todos: Todo[] = [];
    for (const t of data.todos) {
      if (typeof t?.content !== "string" || !t.content) continue;
      todos.push({ content: t.content, status: sanitizeStatus(t.status) });
    }
    const board: TodoBoard = {
      channelId:
        typeof data.channelId === "string" ? data.channelId : channelId,
      todos,
      updatedAt: typeof data.updatedAt === "string" ? data.updatedAt : "",
    };
    if (typeof data.boardMessageId === "string" && data.boardMessageId)
      board.boardMessageId = data.boardMessageId;
    return board;
  } catch {
    return null;
  }
}

/** Save a board atomically (write tmp file in the same dir, rename over).
 *
 * #384 guard A — the write cap: when the serialized board exceeds
 * MAX_BOARD_BYTES (= K_bytes, derived from the runtime context window),
 * the board is written VERBATIM to a sibling archive
 * `<boardfile>.oversize-<UTC stamp>`, the existing board file is left
 * UNCHANGED, and the result carries the deterministic channel wake line.
 * Property: a board on disk never exceeds the cap via saveBoard. */
export interface SaveBoardResult {
  saved: boolean;
  /** Serialized UTF-8 byte size. */
  size: number;
  /** The derived cap (K_bytes) at save time. */
  cap: number;
  /** Set when rejected: the verbatim archive path. */
  archivePath?: string;
  /** Set when rejected: the deterministic channel wake line. */
  wakeLine?: string;
}

/** Compact UTC stamp for archive names: YYYYMMDD-HHMMSS. */
export function utcStamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
}

export function saveBoard(
  board: TodoBoard,
  home = defaultHome(),
  now = new Date(),
): SaveBoardResult {
  const target = boardPath(board.channelId, home);
  const json = JSON.stringify(board, null, 2); // atomicWriteJson shape
  const size = Buffer.byteLength(json, "utf8");
  const cap = compactionLoopCapBytes(undefined, home);
  if (size <= cap) {
    atomicWriteJson(target, board);
    return { saved: true, size, cap };
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const archivePath = `${target}.oversize-${utcStamp(now)}`;
  fs.writeFileSync(archivePath, json);
  const wakeLine = `board_oversize ${board.channelId}: new board ${size} B > cap ${cap} B — archived to ${archivePath}; trim the board`;
  return { saved: false, size, cap, archivePath, wakeLine };
}

/** The board file's byte size (0 when absent). Guard B: the render cap
 *  names the on-disk size in its marker line. */
export function boardFileSize(channelId: string, home = defaultHome()): number {
  try {
    return fs.statSync(boardPath(channelId, home)).size;
  } catch {
    return 0;
  }
}

/** Remove a channel's board file (no-op when absent). */
export function clearBoard(channelId: string, home = defaultHome()): void {
  try {
    fs.unlinkSync(boardPath(channelId, home));
  } catch {
    /* absent or unreadable: fine */
  }
}

/** Every board on disk (corrupt files skipped), sorted by channel id. */
export function listBoards(home = defaultHome()): TodoBoard[] {
  let files: string[] = [];
  try {
    files = fs.readdirSync(todosDir(home));
  } catch {
    return [];
  }
  const out: TodoBoard[] = [];
  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    const b = loadBoard(f.slice(0, -5), home);
    if (b) out.push(b);
  }
  out.sort((a, b) => a.channelId.localeCompare(b.channelId));
  return out;
}

// ─── Coercion ──────────────────────────────────────────────────────────────

/** Coerce an unknown status; unknown/missing → "pending". */
export function sanitizeStatus(s: unknown): TodoStatus {
  return TODO_STATUSES.includes(s as TodoStatus)
    ? (s as TodoStatus)
    : "pending";
}

/** Coerce raw tool params / parsed state into clean todos (order preserved). */
export function sanitizeTodos(input: unknown): Todo[] {
  if (!Array.isArray(input)) return [];
  const out: Todo[] = [];
  for (const t of input) {
    if (typeof t?.content !== "string" || !t.content.trim()) continue;
    out.push({ content: t.content.trim(), status: sanitizeStatus(t.status) });
  }
  return out;
}

// ─── Rendering ─────────────────────────────────────────────────────────────

/** Items still needing work (pending + in_progress). */
export function openCount(todos: Todo[]): number {
  return todos.filter(
    (t) => t.status === "pending" || t.status === "in_progress",
  ).length;
}

/**
 * One line per item: a normal Discord markdown bullet (Andryo 2026-10-18:
 * summaries are markdown lists, no frame, no width budget - text wraps
 * natively). Status semantics without the box glyph:
 *   pending     = plain bullet
 *   in_progress = bold
 *   completed   = strikethrough
 *   cancelled   = strikethrough (markdown has no second "closed" state;
 *                 the old ┤ glyph distinction is dropped)
 * Content ships in FULL - no truncation.
 */
export function todoLine(t: Todo): string {
  switch (t.status) {
    case "pending":
      return `- ${t.content}`;
    case "in_progress":
      return `- **${t.content}**`;
    case "completed":
      return `- ~~${t.content}~~`;
    case "cancelled":
      return `- ~~${t.content}~~`;
  }
}

/**
 * Clip to max code points, trailing ellipsis when cut. Shared end-clip
 * helper (bridge index.ts uses it for the in-turn run frame lines).
 * If the cut lands between a backslash and the char it escapes (escaped
 * markdown), shift the cut back one so no dangling `\` sits before the
 * ellipsis.
 */
export function fit(s: string, max: number): string {
  if (s.length <= max) return s;
  if (max <= 1) return "…";
  let cut = max - 1;
  let backslashes = 0;
  while (backslashes < cut && s[cut - 1 - backslashes] === "\\") backslashes++;
  if (backslashes % 2 === 1) cut--; // odd run: cut split a 2-char unit
  return `${s.slice(0, cut)}…`;
}

/**
 * Board header: a plain bold line (the old `┌ todos · N open` frame top).
 * `title` is the channel name for /todos all; the in-channel board uses
 * the default.
 */
export function renderBoardHeader(todos: Todo[], title = "todos"): string {
  return `**${title} · ${openCount(todos)} open**`;
}

/**
 * Full board text: bold header + blank line + one bullet per item.
 * Normal markdown - no fence, no box characters, no width budget.
 */
export function renderBoard(todos: Todo[], title = "todos"): string {
  const lines = [renderBoardHeader(todos, title), ""];
  for (const t of todos) lines.push(todoLine(t));
  return lines.join("\n");
}

/**
 * <todo-board> LLM context block (re-injected on every inbound run), or
 * "" when the board is empty.
 *
 * #384 guard B — the render cap: a HARD bound (MAX_BOARD_INJECT_BYTES
 * = K_bytes) on every injection on every path. saveBoard is bypassable
 * (direct JSON edits were the actual growth path of the 2026-11-25
 * incident), so this cap is the real bound. `totalBoardBytes` names the
 * on-disk size in the marker line. */
export function todoBoardContextBlock(
  todos: Todo[],
  totalBoardBytes = 0,
  capBytes = compactionLoopCapBytes(),
): string {
  return renderBoardBlock(todos, totalBoardBytes, capBytes);
}

/** Per-item text budget: 2000 chars, truncated with an ellipsis. */
export const BOARD_INJECT_ITEM_CHAR_CAP = 2000;

/** The guard-B cap marker line (one deterministic line for the whole
 *  excluded remainder). */
export function boardCapMarkerLine(
  excluded: number,
  totalBoardBytes: number,
): string {
  return `… ${excluded} more board items over the inject cap — the board file is ${totalBoardBytes} B, trim it`;
}

/** The capped <todo-board> block for a channel's on-disk board ("" when
 *  absent/empty) — the single injection path (inbound channel-ctx and
 *  the handover doc's State section). */
export function loadedBoardContextBlock(
  channelId: string,
  home = defaultHome(),
): string {
  const board = loadBoard(channelId, home);
  if (!board || board.todos.length === 0) return "";
  return todoBoardContextBlock(board.todos, boardFileSize(channelId, home));
}

/** The guard-B capped doc text for a cwd's default channel's board
 *  ("" when none/empty/broken) — the handover doc's State section.
 *  One board load; a broken board must not break the doc. */
export function boardDocText(cwd: string, home = defaultHome()): string {
  try {
    const cfg = loadChannelConfig(cwd);
    const ch = cfg ? getDefaultChannel(cfg) : null;
    if (!ch) return "";
    const board = loadBoard(ch.id, home);
    return board ? boardContextBlock(board, home) : "";
  } catch {
    return "";
  }
}

/** The guard-B capped block for an already-loaded board ("" when
 *  empty) — one board load for the doc's State section. */
function boardContextBlock(board: TodoBoard, home = defaultHome()): string {
  if (board.todos.length === 0) return "";
  return todoBoardContextBlock(
    board.todos,
    boardFileSize(board.channelId, home),
  );
}

/**
 * Capped <todo-board> block. Per-item text budget 2000 chars (fit);
 * items in board order until the byte cap; the remainder replaced by
 * one deterministic marker line. A board that fits renders
 * byte-identical to the historical (uncapped) output. Property: block
 * bytes <= cap + fixed overhead (one marker line) for any input. */
export function renderBoardBlock(
  todos: Todo[],
  totalBoardBytes = 0,
  capBytes = compactionLoopCapBytes(),
): string {
  if (todos.length === 0) return "";
  const itemLines = todos.map((t) =>
    todoLine({ ...t, content: fit(t.content, BOARD_INJECT_ITEM_CHAR_CAP) }),
  );
  const open = "<todo-board>\n";
  const close = "\n</todo-board>";
  const kept: string[] = [];
  let used = Buffer.byteLength(open, "utf8");
  let stopped = false;
  for (let i = 0; i < itemLines.length; i++) {
    const cost =
      (kept.length > 0 ? 1 : 0) + Buffer.byteLength(itemLines[i], "utf8");
    // The first item always ships (after the 2000-char clip a single
    // item is far under any real cap); later items stop at the cap.
    if (kept.length > 0 && used + cost > capBytes) {
      stopped = true;
      break;
    }
    kept.push(itemLines[i]);
    used += cost;
  }
  let block = `${open}${kept.join("\n")}${close}`;
  if (stopped) {
    const excluded = itemLines.length - kept.length;
    block = `${open}${[...kept, boardCapMarkerLine(excluded, totalBoardBytes)].join("\n")}${close}`;
  }
  return block;
}

// ─── Worker intake (pi-bg callbacks) ───────────────────────────────────────

/**
 * Extract "TODO: <content>" lines from a message body. Lines may appear
 * anywhere in the body (pi-bg embeds serialize field values verbatim).
 */
export function extractTodoLines(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split("\n")) {
    const m = line.trim().match(/^TODO:\s*(.+)$/);
    if (m) out.push(m[1].trim());
  }
  return out;
}

/**
 * Append new todo lines to an existing list as pending items. Dedupe on
 * exact content; existing items are never touched or reordered.
 */
export function mergeTodoLines(existing: Todo[], lines: string[]): Todo[] {
  const out = [...existing];
  const seen = new Set(out.map((t) => t.content));
  for (const l of lines) {
    if (!l || seen.has(l)) continue;
    seen.add(l);
    out.push({ content: l, status: "pending" });
  }
  return out;
}

/**
 * True when an inbound body looks like a machine-wake callback (pi-bg
 * producer card):
 *  - an embed whose author is `pi-bg …` — the 2026-10-21 de-prefix shape
 *    (producers post content "" + an embed author starting `pi-bg`;
 *    serializeEmbeds renders it as `Author: pi-bg …`)
 *  - OR the plain-italic restart-wake content `*restart-wake · …*` —
 *    the 2026-10-31 restyle (machine surfaces: no embeds, no fences;
 *    the wake is ONE short italic line)
 *  - OR the legacy content prefix `[bg:` — kept for ONE release (2026-10-21
 *    operator decision: strip the visible `[bg:` prefix from jarate
 *    producers): in-flight channel history and dead-letter re-posts (P5,
 *    verbatim) still ship the old shape, and hall-monitor's webhooks are
 *    not restyled yet. Drop this arm after the migration release.
 */
export function isBgCallbackBody(body: string): boolean {
  return (
    body.startsWith("[bg:") ||
    /\bAuthor: pi-bg\b/.test(body) ||
    body.replace(/^\*+/, "").startsWith("restart-wake \u00b7")
  );
}
