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

export type TodoStatus = "pending" | "in_progress" | "completed" | "cancelled";

export const TODO_STATUSES: TodoStatus[] = ["pending", "in_progress", "completed", "cancelled"];

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
export function loadBoard(channelId: string, home = defaultHome()): TodoBoard | null {
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
      channelId: typeof data.channelId === "string" ? data.channelId : channelId,
      todos,
      updatedAt: typeof data.updatedAt === "string" ? data.updatedAt : "",
    };
    if (typeof data.boardMessageId === "string" && data.boardMessageId) board.boardMessageId = data.boardMessageId;
    return board;
  } catch {
    return null;
  }
}

/** Save a board atomically (write tmp file in the same dir, rename over). */
export function saveBoard(board: TodoBoard, home = defaultHome()): void {
  const dir = todosDir(home);
  fs.mkdirSync(dir, { recursive: true });
  const target = boardPath(board.channelId, home);
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(board, null, 2));
  fs.renameSync(tmp, target);
}

/** Remove a channel's board file (no-op when absent). */
export function clearBoard(channelId: string, home = defaultHome()): void {
  try {
    fs.unlinkSync(boardPath(channelId, home));
  } catch { /* absent or unreadable: fine */ }
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
  return TODO_STATUSES.includes(s as TodoStatus) ? (s as TodoStatus) : "pending";
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
  return todos.filter(t => t.status === "pending" || t.status === "in_progress").length;
}

/** One line per item, glyph per status. */
export function todoLine(t: Todo): string {
  switch (t.status) {
    case "pending": return `⬦ ${t.content}`;
    case "in_progress": return `⬥ **${t.content}**`;
    case "completed": return `✓ ~~${t.content}~~`;
    case "cancelled": return `✕ ${t.content}`;
  }
}

export function renderBoardHeader(todos: Todo[]): string {
  return `▤ todos · ${openCount(todos)} open`;
}

/** Full board text: header + one line per item. */
export function renderBoard(todos: Todo[]): string {
  const lines = [renderBoardHeader(todos)];
  for (const t of todos) lines.push(todoLine(t));
  return lines.join("\n");
}

/**
 * <todo-board> LLM context block (re-injected on every inbound run), or
 * "" when the board is empty.
 */
export function todoBoardContextBlock(todos: Todo[]): string {
  if (todos.length === 0) return "";
  return `<todo-board>\n${todos.map(todoLine).join("\n")}\n</todo-board>`;
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
  const seen = new Set(out.map(t => t.content));
  for (const l of lines) {
    if (!l || seen.has(l)) continue;
    seen.add(l);
    out.push({ content: l, status: "pending" });
  }
  return out;
}

/**
 * True when an inbound body looks like a pi-bg webhook callback (content
 * prefixed "[bg:" or an embed whose author is "pi-bg …").
 */
export function isBgCallbackBody(body: string): boolean {
  return body.startsWith("[bg:") || /\bAuthor: pi-bg\b/.test(body);
}
