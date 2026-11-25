/**
 * #384 — the five deterministic guards, hermetic (isolated HOME per the
 * #382 pattern, injected clock, no network, no LLM). One test per
 * guard; the cap rule is asserted as the formula (262144 -> 83884 B;
 * a small window to prove proportionality), never a hardcoded constant.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { isolateHomeForTests } from "../test/home-isolation";
import { citationFootnote, citationLintNote, citedIds } from "./citation-lint";
import {
  autoCompactGateBlocked,
  isAutoCompactPaused,
  noteCompactionEvent,
} from "./compact-breaker";
import { buildHandover, type HandoffSettings } from "./handover";
import { applyHandoverCap } from "./handover-cap";
import {
  compactionLoopCapBytes,
  deriveCapBytes,
  modelsJsonContextWindow,
  setRuntimeContextWindow,
} from "./size-caps";
import {
  boardCapMarkerLine,
  loadBoard,
  renderBoardBlock,
  saveBoard,
  type Todo,
  type TodoBoard,
  todoLine,
} from "./todos";

isolateHomeForTests();

const NOW = new Date("2026-11-25T12:00:00Z");
const home = (): string => process.env.HOME as string;
const bytes = (s: string): number => Buffer.byteLength(s, "utf8");
const boardPath = (h: string, channelId: string): string =>
  path.join(h, ".pi", "agent", "todos", `${channelId}.json`);

// ─── Cap rule (derived at runtime — never a constant) ────────────────

describe("#384 cap rule (deriveCapBytes)", () => {
  test("262144 -> 83884 B (the incident window)", () => {
    expect(deriveCapBytes(262144)).toBe(83_884);
  });
  test("small windows: proportional (no hardcoded 83884)", () => {
    expect(deriveCapBytes(131_072)).toBe(41_940);
    expect(deriveCapBytes(65_536)).toBe(20_968);
    expect(deriveCapBytes(4096)).toBe(1_308);
  });
  test("non-positive window -> null (the fallback cap stands)", () => {
    expect(deriveCapBytes(0)).toBeNull();
    expect(deriveCapBytes(-1)).toBeNull();
    expect(compactionLoopCapBytes(0)).toBe(deriveCapBytes(131_072)!);
  });
  test("runtime registration drives the cap", () => {
    setRuntimeContextWindow(65_536);
    try {
      expect(compactionLoopCapBytes()).toBe(20_968);
    } finally {
      setRuntimeContextWindow(null);
    }
  });
  test("models.json fallback reads the configured model", () => {
    const h = home();
    fs.mkdirSync(path.join(h, ".pi", "agent"), { recursive: true });
    fs.writeFileSync(
      path.join(h, ".pi", "agent", "settings.json"),
      JSON.stringify({
        defaultProvider: "hydrogen",
        defaultModel: "qwen3.8-27b",
      }),
    );
    fs.writeFileSync(
      path.join(h, ".pi", "agent", "models.json"),
      JSON.stringify({
        providers: {
          hydrogen: {
            models: [
              { id: "other", contextWindow: 1111 },
              { id: "qwen3.8-27b", contextWindow: 123_456 },
            ],
          },
        },
      }),
    );
    expect(modelsJsonContextWindow(h)).toBe(123_456);
    expect(compactionLoopCapBytes(undefined, h)).toBe(39_504);
  });
});

// ─── Fixture: the 344,712 B incident board (deterministic) ──────────

function buildOversizeFixture(): { board: TodoBoard; total: number } {
  const small: Array<[string, Todo["status"]]> = [
    ["trim the incident board before the next deploy window", "pending"],
    ["review PR #381 timer-leg guard", "completed"],
    ["ship the compact-loop breaker", "in_progress"],
    ["rotate the hall-monitor keys", "pending"],
    ["archive the 2026-11-25 incident notes", "pending"],
    ["fix the wiki link rot in docs/DEPLOY.md", "completed"],
    ["re-test the restart wake replay path", "pending"],
  ];
  const board: TodoBoard = {
    channelId: "ch-fix",
    updatedAt: "2026-11-25T07:59:00Z",
    todos: [
      ...small.map(([content, status]) => ({ content, status })),
      // The one ~138.8 KB item (the incident's untrimmed entry).
      {
        content: `incident board item ${"W".repeat(138_800)}`,
        status: "in_progress",
      },
    ],
  };
  const size = () => bytes(JSON.stringify(board, null, 2));
  let i = 0;
  while (size() < 344_712) {
    // Spread the remainder over the 7 small items (deterministic).
    const idx = i % 7;
    board.todos[idx]!.content += `z${String(i++).padStart(6, "0")}`;
  }
  return { board, total: size() };
}

// ─── Guard A: the board write cap ────────────────────────────────────

describe("#384 guard A (saveBoard cap)", () => {
  afterEach(() => {
    setRuntimeContextWindow(null);
  });
  test("over-cap save: archive verbatim, existing board unchanged, wake line", () => {
    const h = home();
    setRuntimeContextWindow(128_000); // cap = 40960 B
    const existing: TodoBoard = {
      channelId: "chA",
      updatedAt: "2026-11-25T08:00:00Z",
      todos: [{ content: "the only real item", status: "pending" }],
    };
    expect(saveBoard(existing, h, NOW).saved).toBe(true);
    const before = fs.readFileSync(boardPath(h, "chA"), "utf8");

    const oversized: TodoBoard = {
      channelId: "chA",
      updatedAt: "2026-11-25T08:05:00Z",
      boardMessageId: "123",
      todos: [
        { content: "a".repeat(40_900), status: "pending" },
        { content: "small item", status: "pending" },
      ],
    };
    const newBytes = bytes(JSON.stringify(oversized, null, 2));
    expect(newBytes).toBeGreaterThan(40_960);

    const r = saveBoard(oversized, h, NOW);
    const archive = `${boardPath(h, "chA")}.oversize-20261125-120000`;
    expect(r.saved).toBe(false);
    expect(r.wakeLine).toBe(
      `board_oversize chA: new board ${newBytes} B > cap 40960 B — archived to ${archive}; trim the board`,
    );
    // The existing board file is unchanged.
    expect(fs.readFileSync(boardPath(h, "chA"), "utf8")).toBe(before);
    // The archive is verbatim.
    expect(fs.existsSync(archive)).toBe(true);
    expect(fs.readFileSync(archive, "utf8")).toBe(
      JSON.stringify(oversized, null, 2),
    );
  });
  test("under-cap save still writes", () => {
    const h = home();
    setRuntimeContextWindow(128_000);
    const board: TodoBoard = {
      channelId: "chA2",
      updatedAt: "2026-11-25T08:00:00Z",
      todos: [{ content: "fits", status: "pending" }],
    };
    const r = saveBoard(board, h, NOW);
    expect(r.saved).toBe(true);
    expect(loadBoard("chA2", h)?.updatedAt).toBe("2026-11-25T08:00:00Z");
  });
});

// ─── Guard B: the inject cap ─────────────────────────────────────────

describe("#384 guard B (renderBoardBlock cap)", () => {
  const cap = deriveCapBytes(262_144)!; // 83884
  // Fixed block overhead: the open tag + one separator + the close tag.
  const overhead = bytes("<todo-board>\n\n\n</todo-board>");
  test("344,712 B board -> block within cap + fixed overhead", () => {
    const { board, total } = buildOversizeFixture();
    expect(total).toBeGreaterThanOrEqual(344_712);
    const block = renderBoardBlock(board.todos, total, cap);
    // Every item is clipped to 2000 chars; the 8-item block fits.
    expect(bytes(block)).toBeLessThanOrEqual(cap + overhead);
    expect(block).toContain("- **incident board item WWW");
  });
  test("many items -> byte cap trips, one deterministic marker", () => {
    const todos: Todo[] = Array.from({ length: 60 }, (_, i) => ({
      content: `item ${i} ${"q".repeat(1_900)}`,
      status: "pending" as const,
    }));
    const total = 200_000;
    const block = renderBoardBlock(todos, total, cap);
    const lines = block.split("\n");
    const keptCount = lines.filter((l) => l.startsWith("- ")).length;
    const markers = lines.filter((l) => l.startsWith("… "));
    expect(markers.length).toBe(1);
    expect(keptCount).toBeGreaterThan(1);
    expect(keptCount).toBeLessThan(60);
    const n = 60 - keptCount;
    expect(markers[0]).toBe(boardCapMarkerLine(n, total));
    expect(bytes(block)).toBeLessThanOrEqual(
      cap + bytes(markers[0]!) + overhead,
    );
  });
  test("small board: byte-identical to the old injection output", () => {
    const todos: Todo[] = [
      { content: "ship the thing", status: "pending" },
      { content: "done thing", status: "completed" },
      { content: "working thing", status: "in_progress" },
    ];
    const legacy = `<todo-board>\n${todos.map(todoLine).join("\n")}\n</todo-board>`;
    expect(renderBoardBlock(todos, 0, cap)).toBe(legacy);
  });
});

// ─── Guard C: the write cap (buildHandover) ──────────────────────────

describe("#384 guard C (handover write cap)", () => {
  const cap = deriveCapBytes(262_144)!; // 83884
  let cwd = "";
  let storeDir = "";
  beforeEach(() => {
    const h = home();
    cwd = path.join(h, "proj");
    fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
    fs.writeFileSync(
      path.join(cwd, ".pi", "settings.json"),
      JSON.stringify({
        channels: [
          {
            id: "ch-fix",
            type: "discord",
            channel: "1",
            enabled: true,
            default: true,
          },
        ],
      }),
    );
    const { board } = buildOversizeFixture();
    fs.mkdirSync(path.join(h, ".pi", "agent", "todos"), { recursive: true });
    fs.writeFileSync(boardPath(h, "ch-fix"), JSON.stringify(board, null, 2));
    storeDir = path.join(h, ".jarate", "handovers");
  });
  const ctx = (contextWindow: number): any => ({
    cwd,
    model: { id: "m", name: "M", provider: "p" },
    sessionManager: {
      getSessionFile: () => null,
      getSessionId: () => "sess-384",
      getEntries: () => new Array(5).fill({ type: "message" }),
    },
    getContextUsage: () => ({
      tokens: 240_000,
      contextWindow,
      percent: 91,
    }),
  });
  const prep = () => ({
    firstKeptEntryId: "entry-keep-1",
    messagesToSummarize: [
      { role: "user" as const, content: "fix the bug in PR #42" },
      { role: "assistant" as const, content: "ok, reading /a/b.ts" },
    ],
    turnPrefixMessages: [
      { role: "user" as const, content: "push branch pi-bg/384" },
    ],
    isSplitTurn: false,
    tokensBefore: 200_000,
    fileOps: {
      read: new Set(["/a/b.ts"]),
      written: new Set(["/a/c.ts"]),
      edited: new Set(["/a/d.ts"]),
    },
  });
  const writtenDoc = (): string => {
    const f = fs
      .readdirSync(storeDir)
      .filter((x) => x.endsWith(".md") && x !== "latest.md")[0];
    return fs.readFileSync(path.join(storeDir, f), "utf8");
  };
  const settings = (): HandoffSettings => ({
    enabled: true,
    threshold: 0.8,
    sizeGuardTokens: 12_000,
    storeDir,
  });
  test("344 KB board, 262144 window: doc on disk <= 83884 B", async () => {
    await buildHandover({
      preparation: prep() as any,
      branchEntries: [],
      ctx: ctx(262_144),
      settings: settings(),
      now: NOW,
    });
    const doc = writtenDoc();
    expect(bytes(doc)).toBeLessThanOrEqual(83_884);
    expect(doc).toContain("<todo-board>");
  });
  test("small window: the cap is proportional (131072 -> 41940)", async () => {
    await buildHandover({
      preparation: prep() as any,
      branchEntries: [],
      ctx: ctx(131_072),
      settings: settings(),
      now: NOW,
    });
    expect(bytes(writtenDoc())).toBeLessThanOrEqual(41_940);
  });
  test("per-section budgets hold on a huge doc", () => {
    const doc = [
      "# Handover - 2026-11-25 · session s · 200k tokens → handoff",
      `## Transcript (current state first)\n${Array.from({ length: 300 }, (_, i) => `line ${i} ${"t".repeat(290)}`).join("\n")}`,
      `## References\n- link: ${"r".repeat(2_500)}`,
      `## Operator instructions (recent)\n${Array.from({ length: 15 }, () => `- ${"i".repeat(500)}`).join("\n")}`,
      `## State\n- context: c\n- model: m\n- session: s\n- dispatch:\n${Array.from({ length: 6 }, () => `  ${"d".repeat(600)}`).join("\n")}\n- scheduled:\n${Array.from({ length: 6 }, () => `  ${"s".repeat(600)}`).join("\n")}\n- todos:\n  (none)`,
      `## Last user asks\n(none)`,
      `## Last sent message\n(none)`,
      `<read-files>\n/a/b.ts\n</read-files>\n<modified-files>\n</modified-files>`,
    ].join("\n\n");
    expect(bytes(doc)).toBeGreaterThan(cap);
    const capped = applyHandoverCap(doc, cap);
    expect(bytes(capped)).toBeLessThanOrEqual(cap + 40);
    const section = (title: string): string =>
      capped.split(`\n## ${title}\n`)[1]!.split("\n## ")[0];
    // Ops: the 12 newest entries, each <= 400 chars.
    const ops = section("Operator instructions (recent)")
      .split("\n")
      .filter((l) => l.startsWith("- "));
    expect(ops.length).toBe(12);
    expect(ops.every((l) => l.length <= 400)).toBe(true);
    // State fields: <= 4 continuation lines each, <= 500 chars per line.
    const stateLines = section("State").split("\n");
    const field = (marker: string): string[] => {
      const i = stateLines.indexOf(marker);
      const out: string[] = [];
      for (let j = i + 1; j < stateLines.length; j++) {
        if (stateLines[j]!.startsWith("- ")) break;
        out.push(stateLines[j]!);
      }
      return out;
    };
    expect(field("- dispatch:").length).toBe(4);
    expect(field("- scheduled:").length).toBe(4);
    expect(field("- dispatch:").every((l) => l.length <= 500)).toBe(true);
    expect(field("- scheduled:").every((l) => l.length <= 500)).toBe(true);
    // The transcript takes the remaining budget: condensed (from 300
    // lines) until the doc fits the cap.
    expect(
      section("Transcript (current state first)").split("\n").length,
    ).toBeLessThan(300);
  });
});

// ─── Guard D: the compaction rate breaker ────────────────────────────

describe("#384 guard D (compact-loop breaker)", () => {
  let stateDir = "";
  const T0 = 1_764_000_000_000; // fixed clock
  beforeEach(() => {
    stateDir = path.join(home(), ".tmp");
  });
  test("third compaction in 60m trips: one loud line, auto-reset at 120m", () => {
    expect(noteCompactionEvent(stateDir, "chD", T0).tripped).toBe(false);
    expect(noteCompactionEvent(stateDir, "chD", T0 + 10 * 60_000).tripped).toBe(
      false,
    );
    const third = noteCompactionEvent(stateDir, "chD", T0 + 20 * 60_000);
    expect(third.tripped).toBe(true);
    expect(third.line).toBe(
      "COMPACT-LOOP chD: 3 compactions in 60m — auto-compact paused, operator action required",
    );
    expect(isAutoCompactPaused(stateDir, "chD", T0 + 30 * 60_000)).toBe(true);
    // One line per trip: subsequent events carry no line.
    const fourth = noteCompactionEvent(stateDir, "chD", T0 + 30 * 60_000);
    expect(fourth.tripped).toBe(false);
    expect(fourth.line).toBeNull();
    expect(
      autoCompactGateBlocked(path.dirname(stateDir), "chD", T0 + 40 * 60_000),
    ).toBe(true);
    // Auto-reset at 120 minutes: unpauses, and the breaker can re-trip.
    const reset = T0 + 20 * 60_000 + 121 * 60_000;
    expect(isAutoCompactPaused(stateDir, "chD", reset)).toBe(false);
    expect(noteCompactionEvent(stateDir, "chD", reset).tripped).toBe(false); // the 60m window now holds only fresh events
    noteCompactionEvent(stateDir, "chD", reset + 60_000);
    const retrip = noteCompactionEvent(stateDir, "chD", reset + 2 * 60_000);
    expect(retrip.tripped).toBe(true);
  });
  test("a quiet channel never trips", () => {
    noteCompactionEvent(stateDir, "chQuiet", T0);
    expect(isAutoCompactPaused(stateDir, "chQuiet", T0 + 59 * 60_000)).toBe(
      false,
    );
    expect(
      noteCompactionEvent(stateDir, "chQuiet", T0 + 59 * 60_000).tripped,
    ).toBe(false);
  });
});

// ─── Guard E: the citation lint ──────────────────────────────────────

describe("#384 guard E (citation lint)", () => {
  const SEEN = "1575057997171750837";
  const ABSENT = "99999999999999999";
  test("absent 17-digit id gets exactly the footnote; seen id does not", () => {
    const body = `operator said ${SEEN} and cited ${ABSENT} in this thread`;
    expect(citedIds(body)).toEqual([SEEN, ABSENT]);
    expect(citationLintNote(body, new Set([SEEN]))).toBe(
      citationFootnote(ABSENT),
    );
  });
  test("all-known body: no note; empty seen set: no note", () => {
    const body = `only ${SEEN} here`;
    expect(citationLintNote(body, new Set([SEEN]))).toBeNull();
    expect(citationLintNote(body, new Set())).toBeNull();
  });
  test("16- and 21-digit runs are not cited ids", () => {
    expect(citedIds("1234567890123456 987654321098765432101")).toEqual([]);
  });
});
