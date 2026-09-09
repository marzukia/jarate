import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  boardPath,
  clearBoard,
  extractTodoLines,
  isBgCallbackBody,
  listBoards,
  loadBoard,
  mergeTodoLines,
  openCount,
  renderBoard,
  renderBoardHeader,
  sanitizeStatus,
  sanitizeTodos,
  saveBoard,
  todoBoardContextBlock,
  todoLine,
  type Todo,
  type TodoBoard,
} from "./todos";

describe("todos: state file ops", () => {
  let home = "";

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "piscord-todos-"));
  });

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  test("saveBoard creates the dir and writes valid JSON (tmp+rename)", () => {
    const board: TodoBoard = {
      channelId: "ch1",
      todos: [{ content: "fix the bug", status: "in_progress" }],
      updatedAt: "2026-09-09T00:00:00.000Z",
    };
    saveBoard(board, home);
    const p = boardPath("ch1", home);
    expect(fs.existsSync(p)).toBe(true);
    expect(JSON.parse(fs.readFileSync(p, "utf8"))).toEqual(board);
    // atomic write leaves no tmp litter
    expect(fs.readdirSync(path.dirname(p)).filter(f => f.endsWith(".tmp"))).toEqual([]);
  });

  test("loadBoard round-trips and tolerates corrupt/missing files", () => {
    expect(loadBoard("nope", home)).toBeNull();

    const board: TodoBoard = {
      channelId: "ch1",
      todos: [
        { content: "a", status: "pending" },
        { content: "b", status: "completed" },
      ],
      updatedAt: "t",
      boardMessageId: "m123",
    };
    saveBoard(board, home);
    expect(loadBoard("ch1", home)).toEqual(board);

    fs.writeFileSync(boardPath("bad", home), "{not json", { encoding: "utf8" });
    expect(loadBoard("bad", home)).toBeNull();
  });

  test("loadBoard coerces bad statuses and drops empty items", () => {
    fs.mkdirSync(path.join(home, ".pi", "agent", "todos"), { recursive: true });
    fs.writeFileSync(boardPath("ch2", home), JSON.stringify({
      channelId: "ch2",
      todos: [
        { content: "ok", status: "pending" },
        { content: "weird", status: "bogus" },
        { content: "", status: "pending" },
        { status: "pending" },
      ],
      updatedAt: "t",
    }));
    const b = loadBoard("ch2", home);
    expect(b?.todos).toEqual([
      { content: "ok", status: "pending" },
      { content: "weird", status: "pending" },
    ]);
  });

  test("clearBoard removes the file (no-op when absent)", () => {
    saveBoard({ channelId: "ch1", todos: [{ content: "a", status: "pending" }], updatedAt: "t" }, home);
    clearBoard("ch1", home);
    expect(loadBoard("ch1", home)).toBeNull();
    expect(() => clearBoard("ch1", home)).not.toThrow();
  });

  test("listBoards returns every board sorted, skipping corrupt files", () => {
    saveBoard({ channelId: "zz", todos: [{ content: "z", status: "pending" }], updatedAt: "t" }, home);
    saveBoard({ channelId: "aa", todos: [], updatedAt: "t" }, home);
    fs.mkdirSync(path.join(home, ".pi", "agent", "todos"), { recursive: true });
    fs.writeFileSync(boardPath("corrupt", home), "x", { encoding: "utf8" });
    const boards = listBoards(home);
    expect(boards.map(b => b.channelId)).toEqual(["aa", "zz"]);
    expect(listBoards(path.join(home, "empty"))).toEqual([]);
  });
});

describe("todos: coercion", () => {
  test("sanitizeStatus maps unknown values to pending", () => {
    expect(sanitizeStatus("in_progress")).toBe("in_progress");
    expect(sanitizeStatus("cancelled")).toBe("cancelled");
    expect(sanitizeStatus("done")).toBe("pending");
    expect(sanitizeStatus(undefined)).toBe("pending");
  });

  test("sanitizeTodos drops non-strings/empty, trims, preserves order", () => {
    const out = sanitizeTodos([
      { content: "  fix it  ", status: "in_progress" },
      { content: "", status: "pending" },
      { content: 42, status: "pending" },
      null,
      { content: "test it", status: "nope" },
    ]);
    expect(out).toEqual([
      { content: "fix it", status: "in_progress" },
      { content: "test it", status: "pending" },
    ]);
    expect(sanitizeTodos("nope")).toEqual([]);
    expect(sanitizeTodos(undefined)).toEqual([]);
  });
});

describe("todos: rendering", () => {
  const all: Todo[] = [
    { content: "write tests", status: "pending" },
    { content: "fix the bug", status: "in_progress" },
    { content: "read the docs", status: "completed" },
    { content: "old idea", status: "cancelled" },
  ];

  test("header counts only pending + in_progress as open", () => {
    expect(renderBoardHeader(all)).toBe("▤ todos · 2 open");
    expect(openCount(all)).toBe(2);
    expect(openCount([])).toBe(0);
    expect(openCount([{ content: "x", status: "completed" }])).toBe(0);
  });

  test("each status renders its glyph", () => {
    expect(todoLine({ content: "a", status: "pending" })).toBe("⬦ a");
    expect(todoLine({ content: "b", status: "in_progress" })).toBe("⬥ **b**");
    expect(todoLine({ content: "c", status: "completed" })).toBe("✓ ~~c~~");
    expect(todoLine({ content: "d", status: "cancelled" })).toBe("✕ d");
  });

  test("renderBoard is header + one line per item", () => {
    expect(renderBoard(all)).toBe(
      ["▤ todos · 2 open", "⬦ write tests", "⬥ **fix the bug**", "✓ ~~read the docs~~", "✕ old idea"].join("\n"),
    );
  });

  test("todoBoardContextBlock wraps items and is empty for an empty board", () => {
    expect(todoBoardContextBlock([])).toBe("");
    expect(todoBoardContextBlock([{ content: "a", status: "pending" }])).toBe(
      "<todo-board>\n⬦ a\n</todo-board>",
    );
  });
});

describe("todos: worker intake", () => {
  test("extractTodoLines picks 'TODO: ' lines anywhere in the body", () => {
    const body = "[bg: worker OK · r1]\n\n<embed>\nresult: ```bash\ndone\nTODO: follow up on X\nTODO:verify Y\nTODO:   zed  \nno todo here TODO later\n``` \n</embed>";
    expect(extractTodoLines(body)).toEqual(["follow up on X", "verify Y", "zed"]);
    expect(extractTodoLines("nothing here")).toEqual([]);
  });

  test("mergeTodoLines appends pending, dedupes exact content, keeps order", () => {
    const existing: Todo[] = [
      { content: "alpha", status: "in_progress" },
      { content: "beta", status: "completed" },
    ];
    const merged = mergeTodoLines(existing, ["gamma", "alpha", "beta", "", "gamma"]);
    expect(merged).toEqual([
      { content: "alpha", status: "in_progress" },
      { content: "beta", status: "completed" },
      { content: "gamma", status: "pending" },
    ]);
    // existing list is not mutated
    expect(existing).toEqual([
      { content: "alpha", status: "in_progress" },
      { content: "beta", status: "completed" },
    ]);
  });

  test("isBgCallbackBody recognizes content-prefix and embed-author shapes", () => {
    expect(isBgCallbackBody("[bg: worker OK · r1]")).toBe(true);
    expect(isBgCallbackBody("[bg:worker:OK] legacy")).toBe(true);
    expect(isBgCallbackBody("<embed>\nAuthor: pi-bg ticket · r1\nTitle: ✓ worker · OK\n</embed>")).toBe(true);
    expect(isBgCallbackBody("hello TODO: world")).toBe(false);
    expect(isBgCallbackBody("")).toBe(false);
  });
});

// silence unused-import lint for jest (kept for timer hygiene consistency
// with the other test files)
void jest;
