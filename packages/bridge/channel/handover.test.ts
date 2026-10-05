import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  clearDiscordStatesForTest,
  seedChannelStateForTest,
  setChannelCursor,
} from "./discord";
import {
  assembleDoc,
  buildHandover,
  buildHeader,
  buildLlmPrompt,
  buildSeedKickoff,
  type ExtractCtxState,
  estTokens,
  extractDeterministic,
  extractLinks,
  extractRefs,
  extractWorktrees,
  formatContextLine,
  formatSessionStats,
  HANDOFF_DEFAULTS,
  HANDOFF_FRESH_WINDOW_MS,
  type HandoffSettings,
  type HandoverPreparation,
  inboundSender,
  isHandoffFreshWindow,
  isHumanInbound,
  keptTailMessages,
  lastHandoffAt,
  liveKickoffState,
  loadPreviousHandover,
  msgText,
  ORCHESTRATOR_PRIME_LINE,
  parseKickoff,
  parseLlmProse,
  parsePriorTags,
  renderDeterministic,
  renderTemplate,
  resolveHandoffSettings,
  serializeTranscript,
  shouldHandoff,
  sizeGuard,
  splitDoc,
  writeHandover,
} from "./handover";
import extension, {
  clearAllCompacting,
  handleInbound,
  isCompacting,
  isHandoffInFlight,
  isHandoffRestartArmed,
  moveSessionFileAside,
  opWindowLabel,
  setHandoffInFlight,
  setHandoffRestartArmed,
  setHandoverCompleteForTest,
  setSystemdRestartHookForTest,
  stopAllOpTicks,
} from "./index";
import { renderBoardPlain, saveBoard, type Todo } from "./todos";
import type { ChannelMessage } from "./types";

// ─── Fixtures ───────────────────────────────────────────────────────────────

const NOW = new Date("2026-09-23T14:30:00");

const basePrep = (): HandoverPreparation => ({
  firstKeptEntryId: "entry-keep-1",
  messagesToSummarize: [
    {
      role: "user",
      content: "fix the bug in PR #42 and open https://example.com/a.",
    },
    { role: "assistant", content: "ok, reading /home/monky/code/app/src/a.ts" },
    { role: "toolResult", content: "read file /home/monky/code/app/src/a.ts" },
  ],
  turnPrefixMessages: [
    { role: "user", content: "push branch pi-bg/20260923-021858-3964667" },
  ],
  isSplitTurn: false,
  tokensBefore: 183_000,
  fileOps: {
    read: new Set(["/home/monky/code/app/src/a.ts"]),
    written: new Set(["/home/monky/code/app/src/b.ts"]),
    edited: new Set(["/home/monky/code/app/src/c.ts"]),
  },
});

const emptyCtx: ExtractCtxState = { priorDoc: null };

const PRIOR_DOC = [
  "# Handover - 2026-09-22 · session old · 100k tokens → handoff",
  "",
  "## 1 · Mission",
  "Build the bridge.",
  "",
  "## 2 · In-flight (NOW)",
  "Old task.",
  "",
  "## 7 · References",
  "- PR/issues/tickets: #40",
  "",
  "<read-files>",
  "/home/monky/code/app/src/old1.ts",
  "/home/monky/code/app/src/old2.ts",
  "</read-files>",
  "<modified-files>",
  "/home/monky/code/app/src/old3.ts",
  "</modified-files>",
].join("\n");

// ─── shouldHandoff ──────────────────────────────────────────────────────────

describe("shouldHandoff (gate)", () => {
  const flags = (
    over: Partial<{
      enabled: boolean;
      inFlight: boolean;
      percent: number | null;
      freshWindow: boolean;
    }> = {},
  ) => ({
    enabled: true,
    threshold: 0.8,
    inFlight: false,
    percent: 85,
    freshWindow: false,
    ...over,
  });
  test("disabled → false for manual AND threshold", () => {
    expect(
      shouldHandoff({ reason: "manual" }, { ...flags(), enabled: false }),
    ).toBe(false);
    expect(
      shouldHandoff({ reason: "threshold" }, { ...flags(), enabled: false }),
    ).toBe(false);
  });
  test("in-flight → false (F10 double-compaction guard)", () => {
    expect(shouldHandoff({ reason: "manual" }, flags({ inFlight: true }))).toBe(
      false,
    );
    expect(
      shouldHandoff({ reason: "threshold" }, flags({ inFlight: true })),
    ).toBe(false);
  });
  test("fresh window → false (PR2: just-seeded session not yet eligible)", () => {
    // even a manual /handover within 5m of the last doc write falls to
    // the built-in compact (the doc is the base for the NEXT handoff)
    expect(
      shouldHandoff({ reason: "manual" }, flags({ freshWindow: true })),
    ).toBe(false);
    expect(
      shouldHandoff({ reason: "threshold" }, flags({ freshWindow: true })),
    ).toBe(false);
  });
  test("enabled + manual → true", () => {
    expect(shouldHandoff({ reason: "manual" }, flags())).toBe(true);
  });
  test("threshold: percent at/over fraction of TOTAL window → true", () => {
    // 0.8 of the window = 80%
    expect(shouldHandoff({ reason: "threshold" }, flags({ percent: 80 }))).toBe(
      true,
    );
    expect(shouldHandoff({ reason: "threshold" }, flags({ percent: 95 }))).toBe(
      true,
    );
    expect(
      shouldHandoff({ reason: "threshold" }, flags({ percent: 79.9 })),
    ).toBe(false);
  });
  test("threshold + unknown percent → true (pi already picked the point)", () => {
    expect(
      shouldHandoff({ reason: "threshold" }, flags({ percent: null })),
    ).toBe(true);
  });
  test("overflow and other reasons → false (built-in path)", () => {
    expect(shouldHandoff({ reason: "overflow" }, flags())).toBe(false);
    expect(shouldHandoff({ reason: "something" }, flags())).toBe(false);
  });
});

// ─── parsePriorTags (F9 cumulative base) ────────────────────────────────────

describe("parsePriorTags", () => {
  test("extracts read + modified tags", () => {
    const t = parsePriorTags(PRIOR_DOC);
    expect(t.readFiles).toEqual([
      "/home/monky/code/app/src/old1.ts",
      "/home/monky/code/app/src/old2.ts",
    ]);
    expect(t.modifiedFiles).toEqual(["/home/monky/code/app/src/old3.ts"]);
  });
  test("missing tags → empty arrays", () => {
    const t = parsePriorTags("# no tags here\n");
    expect(t.readFiles).toEqual([]);
    expect(t.modifiedFiles).toEqual([]);
  });
  test("null doc → empty arrays", () => {
    const t = parsePriorTags(null);
    expect(t.readFiles).toEqual([]);
    expect(t.modifiedFiles).toEqual([]);
  });
  test("blank lines and whitespace are skipped", () => {
    const t = parsePriorTags(
      "<read-files>\n\n  /x/y.ts  \n\n</read-files>\n<modified-files>\n </modified-files>",
    );
    expect(t.readFiles).toEqual(["/x/y.ts"]);
    expect(t.modifiedFiles).toEqual([]);
  });
  test("anchors to the LAST occurrence, not the first (RCA F4a)", () => {
    // A transcript scrape of handover.ts source mid-doc can contain the
    // tag text with a dummy body; the doc's own footer is always last.
    const doc = [
      "## Transcript (current state first)",
      "<read-files>",
      "/scrapped/first.ts",
      "</read-files>",
      "...",
      "<read-files>",
      "/real/footer.ts",
      "</read-files>",
    ].join("\n");
    expect(parsePriorTags(doc).readFiles).toEqual(["/real/footer.ts"]);
  });
  test("drops uninterpolated template lines (RCA F4a live bug)", () => {
    // The live 2026-10-05 doc carried the literal footer text below —
    // a template that never interpolated. It must not survive as a path.
    // ("$" + "{..." keeps the placeholder literal out of a template lint.)
    const readLit = "\\n" + "$" + "{list(s.readFiles)}";
    const modifiedLit = "\\n" + "$" + "{list(s.modifiedFiles)}";
    const doc = [
      "<read-files>",
      readLit,
      "/home/monky/projects/jarate/packages/bridge/channel/handover.ts",
      "</read-files>",
      "<modified-files>",
      modifiedLit,
      "/home/monky/projects/jarate/packages/bridge/channel/index.ts",
      "</modified-files>",
    ].join("\n");
    expect(parsePriorTags(doc)).toEqual({
      readFiles: [
        "/home/monky/projects/jarate/packages/bridge/channel/handover.ts",
      ],
      modifiedFiles: [
        "/home/monky/projects/jarate/packages/bridge/channel/index.ts",
      ],
    });
  });
});

// ─── extractDeterministic ───────────────────────────────────────────────────

describe("extractDeterministic", () => {
  test("file tags CUMULATIVE: prior doc ∪ current fileOps (F9)", () => {
    const s = extractDeterministic(basePrep(), [], {
      ...emptyCtx,
      priorDoc: PRIOR_DOC,
    });
    expect(s.readFiles).toEqual(
      expect.arrayContaining([
        "/home/monky/code/app/src/old1.ts",
        "/home/monky/code/app/src/a.ts",
      ]),
    );
    expect(s.modifiedFiles).toEqual(
      expect.arrayContaining([
        "/home/monky/code/app/src/old3.ts",
        "/home/monky/code/app/src/b.ts",
        "/home/monky/code/app/src/c.ts",
      ]),
    );
    // every file appears exactly once
    expect(new Set(s.readFiles).size).toBe(s.readFiles.length);
    expect(new Set(s.modifiedFiles).size).toBe(s.modifiedFiles.length);
  });
  test("modified files are excluded from the read list (pi convention)", () => {
    const s = extractDeterministic(basePrep(), [], emptyCtx);
    expect(s.readFiles).not.toContain("/home/monky/code/app/src/b.ts");
    expect(s.readFiles).not.toContain("/home/monky/code/app/src/c.ts");
    expect(s.readFiles).toContain("/home/monky/code/app/src/a.ts");
  });
  test("no prior doc → current fileOps only, newest first", () => {
    const s = extractDeterministic(basePrep(), [], emptyCtx);
    expect(s.readFiles).toEqual(["/home/monky/code/app/src/a.ts"]);
    // c.ts was edited after b.ts was written → c first (RCA F4a ordering)
    expect(s.modifiedFiles).toEqual([
      "/home/monky/code/app/src/c.ts",
      "/home/monky/code/app/src/b.ts",
    ]);
  });
  test("file tags are capped at 10, newest first (RCA F4a)", () => {
    const p = basePrep();
    p.fileOps.read = new Set(
      Array.from({ length: 12 }, (_, i) => `/r/f${i}.ts`),
    );
    p.fileOps.edited = new Set();
    p.fileOps.written = new Set();
    const s = extractDeterministic(p, [], emptyCtx);
    expect(s.readFiles).toHaveLength(10);
    expect(s.readFiles[0]).toBe("/r/f11.ts"); // newest first
    expect(s.readFiles[9]).toBe("/r/f2.ts"); // oldest kept
  });
  test("refs: PR #ids + pi-bg ticket ids, deduped, LAST ~50% of span (RCA F4b)", () => {
    // 8-message span: the refs in the OLDEST half are the work the session
    // moved on from — they must drop out of References.
    const p = basePrep();
    p.messagesToSummarize = Array.from({ length: 8 }, (_, i) => ({
      role: "user",
      content:
        i < 4
          ? `old half ${i} PR #41 ticket 20260101-000000-1111111`
          : `new half ${i} PR #42 ticket 20260923-021858-3964667`,
    })) as any;
    p.turnPrefixMessages = [];
    const s = extractDeterministic(p, [], emptyCtx);
    expect(s.refs).toContain("#42");
    expect(s.refs).toContain("20260923-021858-3964667");
    expect(s.refs.filter((r) => r === "#42")).toHaveLength(1);
    expect(s.refs).not.toContain("#41");
    expect(s.refs).not.toContain("20260101-000000-1111111");
  });
  test("worktrees: paths + pi-bg/<id> branches", () => {
    const s = extractDeterministic(
      {
        ...basePrep(),
        messagesToSummarize: [
          {
            role: "user",
            content:
              "work in /home/monky/.pi-bg-wt/jarate/20260923-021858-3964667 on pi-bg/20260923-021858-3964667",
          },
        ],
      },
      [],
      emptyCtx,
    );
    expect(s.worktrees).toContain(
      "/home/monky/.pi-bg-wt/jarate/20260923-021858-3964667",
    );
    expect(s.worktrees).toContain("pi-bg/20260923-021858-3964667");
  });
  test("worktrees: only the LAST ~20 messages (RCA F4b)", () => {
    const p = basePrep();
    p.messagesToSummarize = Array.from({ length: 25 }, (_, i) => ({
      role: "user",
      content:
        i < 5
          ? `old worktree /home/monky/.pi-bg-wt/jarate/20260101-000000-1111111 pi-bg/20260101-000000-1111111`
          : `new worktree /home/monky/.pi-bg-wt/jarate/20260923-021858-3964667 pi-bg/20260923-021858-3964667`,
    })) as any;
    p.turnPrefixMessages = [];
    const s = extractDeterministic(p, [], emptyCtx);
    expect(s.worktrees).toContain("pi-bg/20260923-021858-3964667");
    expect(s.worktrees).toContain(
      "/home/monky/.pi-bg-wt/jarate/20260923-021858-3964667",
    );
    expect(s.worktrees).not.toContain("pi-bg/20260101-000000-1111111");
    expect(s.worktrees).not.toContain(
      "/home/monky/.pi-bg-wt/jarate/20260101-000000-1111111",
    );
  });
  test("links: deduped, trailing punctuation stripped (in the refs window)", () => {
    // The refs window is the LAST ~50% of the span — put the links in the
    // newest message (the turn prefix) so they are in scope.
    const s = extractDeterministic(
      {
        ...basePrep(),
        messagesToSummarize: [{ role: "user", content: "first msg" }],
        turnPrefixMessages: [
          {
            role: "user",
            content:
              "see https://example.com/a. and https://example.com/a and https://example.com/b,",
          },
        ],
      },
      [],
      emptyCtx,
    );
    expect(s.links).toEqual(["https://example.com/a", "https://example.com/b"]);
  });
  // Real channel-inbound entries carry the full prompt text in `content`
  // (channel-ctx block as the FIRST line) plus the clean body in
  // `details.body`. Machine inbounds (Beepy webhook, [bg: heartbeats) come
  // through the same customType; bridge-injected wakes carry no channel-ctx.
  const inb = (i: number, from: string | null, body: string) => ({
    id: `e${i}`,
    type: "custom_message",
    customType: "channel-inbound",
    timestamp: i,
    content:
      from != null
        ? `<channel-ctx type="discord" name="test" from="${from}" msgId="m${i}">ctx</channel-ctx>\n\n${body}`
        : body,
    details: { body },
  });
  test("last user asks: HUMAN inbounds only, last 2 (RCA F3)", () => {
    const entries = [
      inb(1, "andy", "first ask"),
      // Beepy relay (pi-bg webhook): machine, even with free text
      inb(
        2,
        "Beepy",
        "<embed>\nAuthor: pi-bg ticket · OK\n```bash\n[ok] pass\n```</embed>",
      ),
      inb(3, "Beepy", "[bg: heartbeat] 1 in-flight"),
      // bridge-injected (no channel-ctx): not a human ask
      inb(
        4,
        null,
        "[task] one-shot task due 2026-10-04 06:00 UTC: fire the morning check",
      ),
      // human, empty body (file-only message): not an ask
      inb(5, "andy", "(empty)"),
      inb(6, "andy", "second ask"),
      inb(7, "andy", "third ask"),
      inb(8, "andy", "fourth ask"),
    ];
    const s = extractDeterministic(basePrep(), entries as any, emptyCtx);
    expect(s.lastUserAsks).toEqual(["third ask", "fourth ask"]);
    // the ctx block never leaks into an ask
    expect(s.lastUserAsks.join("\n")).not.toContain("channel-ctx");
  });
  test("last user asks: (none) when no human inbounds (RCA F3)", () => {
    const p = basePrep();
    p.messagesToSummarize = [];
    p.turnPrefixMessages = [];
    const entries = [
      inb(1, "Beepy", "<embed>x</embed>"),
      inb(2, null, "[bg: restart-wake] session restarted"),
    ];
    const s = extractDeterministic(p, entries as any, emptyCtx);
    expect(s.lastUserAsks).toEqual([]);
    const doc = renderDeterministic(s, "", buildHeader(NOW, "s", 100_000));
    expect(doc).toContain("## Last user asks\n(none)");
  });
  test("last user asks: fallback to user-role messages when no inbound entries", () => {
    const s = extractDeterministic(basePrep(), [], emptyCtx);
    expect(s.lastUserAsks.length).toBeGreaterThan(0);
    expect(s.lastUserAsks[s.lastUserAsks.length - 1]).toContain(
      "push branch pi-bg/",
    );
  });
  test("context line: from usage when available, else tokensBefore", () => {
    const withUsage = formatContextLine(
      { tokens: 210_000, contextWindow: 262_144, percent: 80.1 },
      183_000,
    );
    expect(withUsage).toContain("80%");
    expect(withUsage).toContain("262k");
    const without = formatContextLine(null, 183_000);
    expect(without).toBe("183k tokens before compaction");
    const nullTokens = formatContextLine(
      { tokens: null, contextWindow: 262_144, percent: null },
      183_000,
    );
    expect(nullTokens).toContain("?");
  });
  test("session stats: file + size + entries", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "handover-stats-"));
    const f = path.join(tmp, "s.jsonl");
    fs.writeFileSync(f, "x".repeat(2 * 1024 * 1024)); // 2MB
    try {
      const s = formatSessionStats(f, 123);
      expect(s).toContain("s.jsonl");
      expect(s).toContain("2.0MB");
      expect(s).toContain("123 entries");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
    expect(formatSessionStats(null, null)).toBe("unknown");
  });
});

// ─── extract* helpers (standalone) ──────────────────────────────────────────

describe("extractRefs / extractWorktrees / extractLinks", () => {
  test("extractRefs ignores bare issue-looking numbers without #", () => {
    expect(extractRefs("issue 123 no hash, PR #7")).toEqual(["#7"]);
  });
  test("extractWorktrees empty corpus → []", () => {
    expect(extractWorktrees("nothing here")).toEqual([]);
  });
  test("extractLinks empty corpus → []", () => {
    expect(extractLinks("no urls")).toEqual([]);
  });
});

// ─── serializeTranscript ────────────────────────────────────────────────────

describe("serializeTranscript", () => {
  test("role labels + span order (summarize then turn prefix)", () => {
    const t = serializeTranscript(basePrep());
    const iUser = t.indexOf("[user] fix the bug in PR #42");
    const iAsst = t.indexOf("[assistant] ok, reading");
    const iTool = t.indexOf("[tool] read file");
    const iPrefix = t.indexOf("[user] push branch");
    expect(iUser).toBeGreaterThan(-1);
    expect(iAsst).toBeGreaterThan(iUser);
    expect(iTool).toBeGreaterThan(iAsst);
    expect(iPrefix).toBeGreaterThan(iTool);
  });
  test("long messages are truncated per-message", () => {
    const p = basePrep();
    p.messagesToSummarize.push({
      role: "assistant",
      content: "z".repeat(5_000),
    });
    const t = serializeTranscript(p);
    expect(t).toContain("…[truncated]");
  });
  test("kept tail is serialized FIRST, in full (RCA F2)", () => {
    const p = basePrep();
    p.firstKeptEntryId = "keep-1";
    const tail = keptTailMessages(p, [
      {
        id: "sum-1",
        type: "message",
        message: { role: "user", content: "old summarized" },
      } as any,
      {
        id: "keep-1",
        type: "message",
        message: { role: "user", content: "kept work A" },
      } as any,
      {
        id: "keep-2",
        type: "message",
        message: { role: "assistant", content: "kept work B" },
      } as any,
    ]);
    expect(tail.map((m) => msgText(m))).toEqual(["kept work A", "kept work B"]);
    const t = serializeTranscript(p, tail);
    // tail before span, chronological inside the tail
    const iTailA = t.indexOf("[user] kept work A");
    const iTailB = t.indexOf("[assistant] kept work B");
    const iSpan = t.indexOf("[user] fix the bug in PR #42");
    expect(iTailA).toBeGreaterThan(-1);
    expect(iTailA).toBeLessThan(iTailB);
    expect(iTailB).toBeLessThan(iSpan);
    expect(t).toContain("…[older span]");
    // the entry BEFORE firstKeptEntryId is summarized span content, not tail
    expect(t).not.toContain("old summarized");
  });
  test("span over 60K: NEWEST span messages kept, oldest dropped (RCA F2)", () => {
    const p = basePrep();
    p.messagesToSummarize = Array.from({ length: 120 }, (_, i) => ({
      role: "user",
      content: `span msg ${i} ${"x".repeat(600)}`,
    })) as any;
    p.turnPrefixMessages = [];
    const t = serializeTranscript(p);
    // newest span message survives; oldest is cut
    expect(t).toContain("span msg 119 ");
    expect(t).not.toContain("span msg 0 ");
    expect(t).toContain("…[transcript truncated]");
    // chronological order is preserved within the kept subset
    expect(t.indexOf("span msg 118 ")).toBeLessThan(t.indexOf("span msg 119 "));
    // the doc stays under the cap
    expect(t.length).toBeLessThanOrEqual(60_000 + 64);
  });
  test("tail alone over 60K: oldest tail entries dropped, newest kept (RCA F2)", () => {
    const p = basePrep();
    p.messagesToSummarize = [];
    p.turnPrefixMessages = [];
    p.firstKeptEntryId = "k0";
    const entries = Array.from({ length: 120 }, (_, i) => ({
      id: `k${i}`,
      type: "message",
      message: { role: "user", content: `tail msg ${i} ${"y".repeat(600)}` },
    })) as any;
    const tail = keptTailMessages(p, entries);
    expect(tail).toHaveLength(120);
    const t = serializeTranscript(p, tail);
    expect(t).toContain("tail msg 119 ");
    expect(t).not.toContain("tail msg 0 ");
    expect(t).toMatch(
      /…\[kept tail truncated: \d+ oldest kept entries dropped\]/,
    );
  });
});

// ─── inbound sender + human filter (RCA F3) ─────────────────────────────────

describe("inboundSender / isHumanInbound (RCA F3)", () => {
  const inb = (from: string | null, body: string, content?: string) => ({
    id: "e1",
    type: "custom_message",
    customType: "channel-inbound",
    timestamp: 1,
    content:
      content ??
      (from != null
        ? `<channel-ctx type="discord" from="${from}">ctx</channel-ctx>\n\n${body}`
        : body),
    details: { body },
  });
  test("1:1 from= attribute", () => {
    expect(inboundSender(inb("andy", "hi") as any)).toBe("andy");
  });
  test("room sender= attribute wins over from=", () => {
    const e = inb(
      null,
      "hi",
      `<channel-ctx type="discord" name="fleet" room="general" sender="cain" msgId="m1">ctx</channel-ctx>\n\nhi`,
    );
    expect(inboundSender(e as any)).toBe("cain");
  });
  test("no channel-ctx (bridge-injected wake) → null", () => {
    expect(
      inboundSender(inb(null, "[bg: restart-wake] session restarted") as any),
    ).toBeNull();
  });
  test("human free text → true", () => {
    expect(isHumanInbound(inb("andy", "ship it") as any)).toBe(true);
  });
  test("Beepy relay → false (case-insensitive)", () => {
    expect(isHumanInbound(inb("BEEPY", "hello") as any)).toBe(false);
  });
  test("<embed> body → false", () => {
    expect(
      isHumanInbound(inb("andy", "<embed>\nAuthor: pi-bg</embed>") as any),
    ).toBe(false);
  });
  test("[bg: heartbeat body → false", () => {
    expect(
      isHumanInbound(inb("andy", "[bg: heartbeat] 1 in-flight") as any),
    ).toBe(false);
  });
  test("empty body / (empty) → false", () => {
    expect(isHumanInbound(inb("andy", "") as any)).toBe(false);
    expect(isHumanInbound(inb("andy", "(empty)") as any)).toBe(false);
  });
  test("todo-board-only body → false (framing stripped)", () => {
    expect(
      isHumanInbound(
        inb("andy", "<todo-board>\n├ done thing\n</todo-board>") as any,
      ),
    ).toBe(false);
  });
  test("no channel-ctx → false even with free text", () => {
    expect(isHumanInbound(inb(null, "fire the morning check") as any)).toBe(
      false,
    );
  });
});

// ─── keptTailMessages edge cases (RCA F2) ──────────────────────────────────

describe("keptTailMessages (RCA F2)", () => {
  test("firstKeptEntryId not on the branch → [] (span-only doc)", () => {
    const p = basePrep();
    p.firstKeptEntryId = "no-such-id";
    expect(
      keptTailMessages(p, [
        {
          id: "other",
          type: "message",
          message: { role: "user", content: "x" },
        } as any,
      ]),
    ).toEqual([]);
  });
  test("no branch entries → []", () => {
    expect(keptTailMessages(basePrep(), [])).toEqual([]);
  });
  test("custom_message tail entries project to context messages", () => {
    const p = basePrep();
    p.firstKeptEntryId = "c1";
    const tail = keptTailMessages(p, [
      {
        id: "c1",
        type: "custom_message",
        customType: "channel-inbound",
        timestamp: 1,
        content:
          '<channel-ctx type="discord" from="andy">ctx</channel-ctx>\n\ntail ask',
        details: { body: "tail ask" },
      } as any,
    ]);
    expect(tail).toHaveLength(1);
    expect(msgText(tail[0])).toContain("tail ask");
  });
});

// ─── buildLlmPrompt ─────────────────────────────────────────────────────────

describe("buildLlmPrompt", () => {
  test("includes prior doc (F6 base), skeleton, transcript", () => {
    const p = buildLlmPrompt({
      prior: PRIOR_DOC,
      skeleton: "refs: #40\ncontext: 183k tokens before compaction",
      transcript: "[user] hello",
    });
    expect(p).toContain("PRIOR HANDOVER DOC");
    expect(p).toContain("Build the bridge.");
    expect(p).toContain("DETERMINISTIC SKELETON");
    expect(p).toContain("refs: #40");
    expect(p).toContain("TRANSCRIPT");
    expect(p).toContain("[user] hello");
  });
  test("first handover: (none — first handover)", () => {
    const p = buildLlmPrompt({ prior: null, skeleton: "s", transcript: "t" });
    expect(p).toContain("(none — first handover)");
  });
  test("operator instructions forwarded", () => {
    const p = buildLlmPrompt({
      prior: null,
      skeleton: "s",
      transcript: "t",
      instructions: "keep decisions",
    });
    expect(p).toContain("OPERATOR INSTRUCTIONS: keep decisions");
  });
});

// ─── parseLlmProse ──────────────────────────────────────────────────────────

describe("parseLlmProse", () => {
  const FULL = [
    "Sure, here you go:",
    "[MISSION] Ship the bridge.",
    "Line two of mission.",
    "[IN_FLIGHT] Fixing the bug",
    "[DONE] Wrote the tests",
    "[BLOCKERS] (none)",
    "[DECISIONS] Chose bun over npm",
    "[FOLLOWUPS] Tag the corpus",
    "[GOTCHAS] vLLM is sacred",
  ].join("\n");
  test("parses all seven sections", () => {
    const p = parseLlmProse(FULL);
    expect(p.mission).toBe("Ship the bridge.\nLine two of mission.");
    expect(p.inFlight).toBe("Fixing the bug");
    expect(p.done).toBe("Wrote the tests");
    expect(p.blockers).toBe("(none)");
    expect(p.decisions).toBe("Chose bun over npm");
    expect(p.followups).toBe("Tag the corpus");
    expect(p.gotchas).toBe("vLLM is sacred");
  });
  test("preamble before the first marker is dropped", () => {
    const p = parseLlmProse("Sure, here you go:\n[MISSION] x");
    expect(p.mission).toBe("x");
  });
  test("inline marker text is kept", () => {
    const p = parseLlmProse("[MISSION] one-liner\n[DONE] done-thing");
    expect(p.mission).toBe("one-liner");
    expect(p.done).toBe("done-thing");
  });
  test("missing sections → empty string", () => {
    const p = parseLlmProse("[MISSION] only");
    expect(p.mission).toBe("only");
    expect(p.inFlight).toBe("");
    expect(p.gotchas).toBe("");
  });
  test("case-insensitive markers", () => {
    const p = parseLlmProse("[mission] lower");
    expect(p.mission).toBe("lower");
  });
});

// ─── renderTemplate ─────────────────────────────────────────────────────────

describe("renderTemplate", () => {
  const state = extractDeterministic(basePrep(), [], {
    ...emptyCtx,
    priorDoc: PRIOR_DOC,
    contextUsage: null,
    modelLabel: "vllm/qwen3.8-27b",
    sessionFile: null,
    sessionEntryCount: null,
  });
  const prose = {
    mission: "Ship the bridge.",
    inFlight: "Fixing the bug",
    done: "Wrote the tests",
    blockers: "",
    decisions: "Chose bun over npm",
    followups: "",
    gotchas: "vLLM is sacred",
  };
  const doc = renderTemplate(state, prose, buildHeader(NOW, "sess-1", 183_000));
  test("header line", () => {
    expect(
      doc.startsWith(
        "# Handover - 2026-09-23 · session sess-1 · 183k tokens → handoff",
      ),
    ).toBe(true);
  });
  test("all ten sections in order", () => {
    const idx = (t: string) => doc.indexOf(`## ${t}`);
    const titles = [
      "1 · Mission",
      "2 · In-flight (NOW)",
      "3 · Done (condensed)",
      "4 · Blockers",
      "5 · Decisions & Rationale",
      "6 · Open follow-ups",
      "7 · References",
      "8 · Gotchas & Constraints",
      "9 · State (machine)",
      "10 · Last user asks",
    ];
    let last = -1;
    for (const t of titles) {
      const i = idx(t);
      expect(i).toBeGreaterThan(last);
      last = i;
    }
  });
  test("empty prose sections render (none)", () => {
    expect(doc).toMatch(/## 4 · Blockers\n\(none\)/);
    expect(doc).toMatch(/## 6 · Open follow-ups\n\(none\)/);
  });
  test("deterministic sections carry the extracted facts", () => {
    expect(doc).toContain("- PR/issues/tickets:");
    expect(doc).toContain("#42");
    expect(doc).toContain("https://example.com/a");
    expect(doc).toContain("- model: vllm/qwen3.8-27b");
    expect(doc).toContain("183k tokens before compaction");
    expect(doc).toContain("1. fix the bug in PR #42");
  });
  test("file tags cumulative + machine-parseable", () => {
    const t = parsePriorTags(doc);
    expect(t.readFiles).toEqual(
      expect.arrayContaining([
        "/home/monky/code/app/src/old1.ts",
        "/home/monky/code/app/src/a.ts",
      ]),
    );
    expect(t.modifiedFiles).toEqual(
      expect.arrayContaining(["/home/monky/code/app/src/b.ts"]),
    );
    expect(doc).toMatch(
      /<read-files>[\s\S]*<\/read-files>\s*<modified-files>[\s\S]*<\/modified-files>\s*$/,
    );
  });
  test("empty file sets round-trip to [] (no (none) placeholder in tags)", () => {
    const emptyState = extractDeterministic(
      {
        ...basePrep(),
        messagesToSummarize: [],
        turnPrefixMessages: [],
        fileOps: { read: new Set(), written: new Set(), edited: new Set() },
      },
      [],
      emptyCtx,
    );
    const d = renderTemplate(
      emptyState,
      {
        mission: "m",
        inFlight: "i",
        done: "d",
        blockers: "b",
        decisions: "d",
        followups: "f",
        gotchas: "g",
      },
      buildHeader(NOW, "s", 1_000),
    );
    expect(d).toContain("<read-files>\n</read-files>");
    const t = parsePriorTags(d);
    expect(t.readFiles).toEqual([]);
    expect(t.modifiedFiles).toEqual([]);
    // and a prior doc with (none) in the tags is still parsed clean
    expect(
      parsePriorTags("<read-files>\n(none)\n</read-files>").readFiles,
    ).toEqual([]);
  });
});

// ─── sizeGuard ──────────────────────────────────────────────────────────────

describe("sizeGuard", () => {
  const state = extractDeterministic(basePrep(), [], emptyCtx);
  const bigDone = Array.from(
    { length: 300 },
    (_, i) =>
      `did thing number ${i} with a fairly long description to burn space`,
  ).join("\n");
  const prose = {
    mission: "m",
    inFlight: "i",
    done: bigDone,
    blockers: "b",
    decisions: "d",
    followups: "f",
    gotchas: "g",
  };
  const doc = renderTemplate(state, prose, buildHeader(NOW, "s", 1_000));
  test("small doc passes through unchanged", () => {
    const small = renderTemplate(
      state,
      {
        mission: "m",
        inFlight: "i",
        done: "d",
        blockers: "b",
        decisions: "d",
        followups: "f",
        gotchas: "g",
      },
      buildHeader(NOW, "s", 1_000),
    );
    expect(sizeGuard(small, 12_000)).toBe(small);
  });
  test("oversized doc is cut under budget, condensed marker present", () => {
    expect(estTokens(doc)).toBeGreaterThan(4_000);
    const out = sizeGuard(doc, 4_000);
    expect(estTokens(out)).toBeLessThanOrEqual(4_000);
    expect(out).toContain("… (condensed by size guard)");
  });
  test("protected sections survive the cut", () => {
    const out = sizeGuard(doc, 4_000);
    for (const t of [
      "2 · In-flight (NOW)",
      "7 · References",
      "8 · Gotchas & Constraints",
      "9 · State (machine)",
      "10 · Last user asks",
    ]) {
      expect(out).toContain(`## ${t}`);
    }
    // in-flight + gotchas bodies intact (never condensed)
    expect(out).toContain("\ni\n");
    expect(out).toMatch(/## 8 · Gotchas & Constraints\ng\n/);
    // file tags survive at the end
    expect(out).toMatch(/<read-files>[\s\S]*<\/modified-files>\s*$/);
  });
  test("idempotent: guarding an already-guarded doc changes nothing", () => {
    const once = sizeGuard(doc, 4_000);
    const twice = sizeGuard(once, 4_000);
    expect(twice).toBe(once);
  });
});

// ─── splitDoc / assembleDoc header round-trip (issue #134 double-##) ────────

describe("splitDoc / assembleDoc headers (issue #134)", () => {
  const doc = [
    "# Handover - 2026-10-03 · session s · 246k tokens → handoff",
    "",
    "## Transcript (about to be compacted)",
    "[user] x",
    "",
    "## State",
    "- dispatch:",
    "┌ jobs · none in flight",
    "└",
    "",
    "## Last user asks",
    "1. ask",
    "",
    "<read-files>\n</read-files>\n<modified-files>\n</modified-files>",
  ].join("\n");
  test("titles carry no '## ' prefix; round-trip keeps a single '## '", () => {
    const parts = splitDoc(doc);
    expect(parts.sections.map((s) => s.title)).toEqual([
      "Transcript (about to be compacted)",
      "State",
      "Last user asks",
    ]);
    const out = assembleDoc(parts);
    expect(out).not.toContain("## ##");
    expect(out).toContain("## Transcript (about to be compacted)");
    // stable: a second round-trip changes nothing
    expect(assembleDoc(splitDoc(out))).toBe(out);
  });
  test("sizeGuard reassembly over budget → single-## headers, no '## ## '", () => {
    const big = Array.from(
      { length: 500 },
      (_, i) => `line ${i} to burn space in the state box`,
    ).join("\n");
    const d = doc.replace(
      "┌ jobs · none in flight",
      `┌ jobs · none in flight\n${big}`,
    );
    expect(estTokens(d)).toBeGreaterThan(4_000);
    const out = sizeGuard(d, 4_000);
    expect(out).not.toContain("## ##");
    expect(out).toContain("## State");
  });
});

// ─── store: writeHandover / loadPreviousHandover ────────────────────────────

describe("writeHandover + loadPreviousHandover", () => {
  let tmp = "";
  let oldHome = "";
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "handover-store-"));
    oldHome = process.env.HOME || "";
    process.env.HOME = tmp;
  });
  afterEach(() => {
    process.env.HOME = oldHome;
    fs.rmSync(tmp, { recursive: true, force: true });
  });
  test("missing store → null (first handover)", () => {
    expect(loadPreviousHandover()).toBeNull();
  });
  test("write → file + latest.md pointer; reload roundtrip", () => {
    const doc = "# Handover - 2026-09-23 · test\ntext";
    const { path: p, latest } = writeHandover(doc, { now: NOW });
    expect(p).toMatch(/\.jarate\/handovers\/20260923-1430-[0-9a-z]+\.md$/);
    expect(fs.existsSync(p)).toBe(true);
    expect(fs.readFileSync(p, "utf8")).toBe(doc);
    const latestRaw = fs.readFileSync(latest, "utf8");
    expect(latestRaw).toContain(`path: ${p}`);
    expect(latestRaw).toContain("fingerprint:");
    expect(loadPreviousHandover()).toBe(doc);
  });
  test("second write → pointer moves to the newest file", () => {
    writeHandover("# first", { now: new Date("2026-09-23T14:00:00") });
    const second = writeHandover("# second", {
      now: new Date("2026-09-23T15:00:00"),
    });
    expect(loadPreviousHandover()).toBe("# second");
    expect(second.path).toContain("20260923-1500");
  });
  test("explicit storeDir override (settings)", () => {
    const dir = path.join(tmp, "custom");
    writeHandover("# d", { storeDir: dir, now: NOW });
    expect(loadPreviousHandover({ storeDir: dir })).toBe("# d");
    expect(loadPreviousHandover()).toBeNull();
  });
});

// ─── parseKickoff (PR2 groundwork) ──────────────────────────────────────────

describe("parseKickoff", () => {
  const doc = [
    "# Handover - 2026-09-23 · session s · 100k tokens → handoff",
    "",
    "## 1 · Mission",
    "Ship the bridge with tests.",
    "",
    "## 2 · In-flight (NOW)",
    "Wiring the compact handler.",
    "More detail line.",
    "",
    "## 3 · Done (condensed)",
    "Nothing yet.",
    "",
    "## 10 · Last 3 user asks",
    "1. do the thing",
    "2. and this",
  ].join("\n");
  test("5 lines: mission, in-flight, last ask (NEWEST), scheduled + orchestrator priming", () => {
    const k = parseKickoff(doc);
    const lines = k.split("\n");
    expect(lines).toHaveLength(5);
    expect(lines[0]).toBe("Mission: Ship the bridge with tests.");
    expect(lines[1]).toBe("In-flight: Wiring the compact handler.");
    // MINOR-1: the pending ask is the newest (line 2), not the oldest.
    expect(lines[2]).toBe("Last ask: 2. and this");
    // issue #140: no live task store → (none); never doc-scraped.
    expect(lines[3]).toBe("Scheduled: (none)");
    // issue #134: the fresh session re-learns its orchestrator role.
    expect(lines[4]).toBe(ORCHESTRATOR_PRIME_LINE);
  });
  test("missing sections → (none) lines", () => {
    const k = parseKickoff("# bare doc\nno sections");
    const lines = k.split("\n");
    expect(lines).toHaveLength(5);
    expect(lines[0]).toContain("(none)");
    expect(lines[3]).toBe("Scheduled: (none)");
    expect(lines[4]).toBe(ORCHESTRATOR_PRIME_LINE);
  });
});

// ─── issue #140: boot seed loses pending scheduled tasks ────────────────────

describe("parseKickoff scheduled tasks (issue #140)", () => {
  // Pre-fix doc shape: no scheduled section anywhere, and the pending task
  // only shows up as a CONSUMED [task] fire in the inbound asks.
  const doc = [
    "# Handover - 2026-10-04 · session s · 100k tokens → handoff",
    "",
    "## State",
    "- dispatch:",
    "  (none)",
    "- todos:",
    "  (none)",
    "",
    "## Last user asks",
    "1. [task] one-shot task due 2026-10-04 06:00 UTC: fire the morning check",
  ].join("\n");
  const taskLine =
    "- m3x2k9-ab12 · franky · at 2026-10-04T06:00:00.000Z · next 2026-10-04T06:00:00.000Z (in 5h) · check the build";

  test("live.scheduledText present → Scheduled line verbatim", () => {
    const k = parseKickoff(doc, { scheduledText: taskLine });
    expect(k.split("\n")[3]).toBe(`Scheduled: ${taskLine}`);
  });
  test("multiple tasks → every line carried under Scheduled", () => {
    const k = parseKickoff(doc, {
      scheduledText: `${taskLine}\n- cron-1-x · franky · cron "0 6 * * *" (system tz) · next 2026-10-05T06:00:00.000Z (in 15h) · run the fleet check`,
    });
    const lines = k.split("\n");
    expect(lines[3]).toBe(`Scheduled: ${taskLine}`);
    expect(lines[4]).toContain("- cron-1-x ·");
    expect(lines[5]).toBe(ORCHESTRATOR_PRIME_LINE);
  });
  test("absent and explicit null → Scheduled: (none)", () => {
    expect(parseKickoff(doc).split("\n")[3]).toBe("Scheduled: (none)");
    expect(parseKickoff(doc, { scheduledText: null }).split("\n")[3]).toBe(
      "Scheduled: (none)",
    );
    expect(parseKickoff(doc, { scheduledText: "" }).split("\n")[3]).toBe(
      "Scheduled: (none)",
    );
  });
  test("never doc-scraped: a doc State box with scheduled lines does not leak", () => {
    const fakeDoc = [
      "# Handover - 2026-10-04 · session s · 100k tokens → handoff",
      "",
      "## State",
      "- scheduled:",
      "- ghost-1 · franky · at 2026-10-04T06:00:00.000Z · next 2026-10-04T06:00:00.000Z (in 5h) · ghost prompt",
    ].join("\n");
    // no live state at all: doc-scraping would surface the ghost line
    expect(parseKickoff(fakeDoc).split("\n")[3]).toBe("Scheduled: (none)");
    // and the pre-fix doc without any scheduled section contributes nothing
    expect(parseKickoff(doc).split("\n")[3]).toBe("Scheduled: (none)");
  });
});

describe("boardSummaryLine open-only math (issue #140)", () => {
  const doc = "# Handover - 2026-10-04 · session s · 100k tokens → handoff\n";
  const t = (content: string, status: Todo["status"]): Todo => ({
    content,
    status,
  });
  // Fixtures are REAL renderBoardPlain output (review F1, #141): the old
  // hand-written '├ ~~done~~' completed shape is the MARKED-UP todoLine,
  // which renderBoardPlain never emits — a plain completed item renders as
  // '├ done', indistinguishable from pending. That is exactly why the
  // production Mission path reads structured openTodos, not this text.

  test("structured path: 2 pending after 3 completed → open-only line (F1 repro)", () => {
    // The reviewer's exact repro: completed items listed first (normal
    // top-down work order). The string-parse fallback over the SAME board
    // would show 'done one; done two; done three' as the mission.
    const todos: Todo[] = [
      t("done one", "completed"),
      t("done two", "completed"),
      t("done three", "completed"),
      t("open one", "pending"),
      t("open two", "pending"),
    ];
    const board = renderBoardPlain(todos);
    const k = parseKickoff(doc, {
      todoBoard: board,
      openTodos: { count: 2, items: ["open one", "open two"] },
    });
    expect(k.split("\n")[0]).toBe("Mission: 2 open: open one; open two");
  });
  test("structured path: 5 open + 2 completed + 1 cancelled → first 3 open (+2 more)", () => {
    const todos: Todo[] = [
      t("done one", "completed"),
      t("done two", "completed"),
      t("dropped one", "cancelled"),
      t("open one", "pending"),
      t("open two", "pending"),
      t("open three", "in_progress"),
      t("open four", "pending"),
      t("open five", "pending"),
    ];
    const board = renderBoardPlain(todos);
    const k = parseKickoff(doc, {
      todoBoard: board,
      openTodos: {
        count: 5,
        items: ["open one", "open two", "open three", "open four", "open five"],
      },
    });
    expect(k.split("\n")[0]).toBe(
      "Mission: 5 open: open one; open two; open three (+2 more)",
    );
  });
  test("structured path: all completed → '0 open'", () => {
    const board = renderBoardPlain([
      t("done one", "completed"),
      t("done two", "completed"),
    ]);
    const k = parseKickoff(doc, {
      todoBoard: board,
      openTodos: { count: 0, items: [] },
    });
    expect(k.split("\n")[0]).toBe("Mission: 0 open");
  });
  test("fallback on REAL render: 6 open + 5 completed → '(+3 more)' open-only math", () => {
    // no openTodos: the string-parse fallback over real renderer output.
    // Open items listed first, so the shown list is open; the (+N more)
    // math must be open-only (max(0, 6 - 3) = 3, not 11 - 3 = 8).
    const todos: Todo[] = [
      t("open one", "pending"),
      t("open two", "pending"),
      t("open three", "in_progress"),
      t("open four", "pending"),
      t("open five", "pending"),
      t("open six", "pending"),
      t("done one", "completed"),
      t("done two", "completed"),
      t("done three", "completed"),
      t("done four", "completed"),
      t("done five", "completed"),
    ];
    const k = parseKickoff(doc, { todoBoard: renderBoardPlain(todos) });
    expect(k.split("\n")[0]).toBe(
      "Mission: 6 open: open one; open two; open three (+3 more)",
    );
  });
  test("fallback KNOWN LIMIT pinned: completed shares the pending gutter", () => {
    // Same board as the F1 repro, parsed as a string: the shown list
    // surfaces completed items. The structured path (above) is what
    // production uses; this pins the fallback's documented limit so it
    // cannot silently regress again.
    const todos: Todo[] = [
      t("done one", "completed"),
      t("done two", "completed"),
      t("done three", "completed"),
      t("open one", "pending"),
      t("open two", "pending"),
    ];
    const board = renderBoardPlain(todos);
    expect(parseKickoff(doc, { todoBoard: board }).split("\n")[0]).toBe(
      "Mission: 2 open: done one; done two; done three",
    );
  });
  test("fallback no header → item-count branch (synthetic shape)", () => {
    // renderBoardPlain always emits a header; this synthetic no-header
    // shape pins the fallback's count branch. Completed items are
    // indistinguishable from pending here, so the count includes them
    // (the same known limit, no-header variant).
    const b = ["├ open a", "├ open b", "├ done c", "└"].join("\n");
    expect(parseKickoff(doc, { todoBoard: b }).split("\n")[0]).toBe(
      "Mission: 3 todos: open a; open b; done c",
    );
  });
  test("fallback: '├ ~~' no-op guard still strips marked-up strikethrough", () => {
    // renderBoardPlain never emits ~~ (strikethrough is the marked-up
    // todoLine only); the guard defends hand-written / doc-scraped
    // marked-up strings.
    const b = ["├ open a", "├ ~~done c~~", "└"].join("\n");
    expect(parseKickoff(doc, { todoBoard: b }).split("\n")[0]).toBe(
      "Mission: 1 todos: open a",
    );
  });
});

// ─── issue #134: post-compact worker amnesia (live seed state) ───────────────

describe("parseKickoff live state (issue #134)", () => {
  // The deterministic doc shape: NO Mission / In-flight sections — the LLM
  // prose was retired, so doc-scraping both always yielded (none).
  const detDoc = [
    "# Handover - 2026-10-03 · session s · 246k tokens → handoff",
    "",
    "## Transcript (about to be compacted)",
    "[user] work the thing",
    "",
    "## State",
    "- context: 246k / 262k tokens (94%)",
    "- dispatch:",
    "┌ jobs · 1 in flight",
    "┣ 20261003-081922-478435 worker · 01:07:43",
    "│ task line",
    "└",
    "- todos:",
    "┌ todos · 2 open",
    "├ ship the bridge",
    "┣ wire the compact",
    "└",
    "",
    "## Last user asks",
    "1. first ask",
    "2. Don't matter neon is down",
  ].join("\n");
  const jobsFrame = [
    "┌ jobs · 1 in flight",
    "┣ 20261003-081922-478435 worker · 01:07:43",
    "│ task line",
    "└",
    "",
    "┌ recent (newest first) · 1",
    "├ ok · 2h · 20261003-010101-111111",
    "└",
  ].join("\n");
  const board = [
    "┌ todos · 2 open",
    "├ ship the bridge",
    "┣ wire the compact",
    "└",
  ].join("\n");

  test("live dispatch frame → In-flight carries the ticket id", () => {
    const k = parseKickoff(detDoc, {
      dispatchText: jobsFrame,
      todoBoard: board,
    });
    const lines = k.split("\n");
    expect(lines[1]).toBe(
      "In-flight: 20261003-081922-478435 worker · 01:07:43",
    );
    // last ask is preserved from the doc as before
    expect(lines[2]).toBe("Last ask: 2. Don't matter neon is down");
  });
  test("live board → Mission is the open-board summary", () => {
    const k = parseKickoff(detDoc, {
      dispatchText: jobsFrame,
      todoBoard: board,
    });
    expect(k.split("\n")[0]).toBe(
      "Mission: 2 open: ship the bridge; wire the compact",
    );
  });
  test("empty board + zero jobs → both (none)", () => {
    const k = parseKickoff(detDoc, {
      dispatchText: "┌ jobs · none in flight\n└",
      todoBoard: "",
    });
    const lines = k.split("\n");
    expect(lines[0]).toBe("Mission: (none)");
    expect(lines[1]).toBe("In-flight: (none)");
  });
  test("deterministic doc without live state → (none) (the amnesia pin)", () => {
    const k = parseKickoff(detDoc);
    const lines = k.split("\n");
    expect(lines[0]).toBe("Mission: (none)");
    expect(lines[1]).toBe("In-flight: (none)");
    expect(lines[4]).toBe(ORCHESTRATOR_PRIME_LINE);
  });
  test("multiple in-flight jobs → '; '-joined on one line", () => {
    const multi = [
      "┌ jobs · 2 in flight",
      "┣ 20261003-081922-478435 worker · 01:07:43",
      "┣ 20261003-090000-123456 reviewer · 00:12:00",
      "└",
    ].join("\n");
    const k = parseKickoff(detDoc, { dispatchText: multi, todoBoard: "" });
    expect(k.split("\n")[1]).toBe(
      "In-flight: 20261003-081922-478435 worker · 01:07:43; 20261003-090000-123456 reviewer · 00:12:00",
    );
  });
  test("renderDeterministic doc + live state → seed carries the ticket id", () => {
    const state = extractDeterministic(basePrep(), [], {
      ...emptyCtx,
      dispatchText: jobsFrame,
      todoText: board,
    });
    const doc = renderDeterministic(
      state,
      serializeTranscript(basePrep()),
      buildHeader(NOW, "s", 246_000),
    );
    const k = parseKickoff(doc, { dispatchText: jobsFrame, todoBoard: board });
    expect(k).toContain("In-flight: 20261003-081922-478435 worker · 01:07:43");
    expect(k).toContain("Mission: 2 open: ship the bridge; wire the compact");
    expect(k).toContain(ORCHESTRATOR_PRIME_LINE);
  });
});

// ─── Fresh window + seed kickoff (PR2 mechanism B) ───────────────────────────

describe("fresh window (just-seeded guard)", () => {
  let tmp = "";
  let storeDir = "";
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "handover-fresh-"));
    storeDir = path.join(tmp, "handovers");
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });
  test("no store → not fresh", () => {
    expect(lastHandoffAt(storeDir, tmp)).toBe(0);
    expect(isHandoffFreshWindow(storeDir, NOW.getTime(), tmp)).toBe(false);
  });
  test("fresh doc (now) → fresh; 6m later → not fresh", () => {
    writeHandover("# d", { storeDir, now: NOW });
    expect(lastHandoffAt(storeDir, tmp)).toBe(NOW.getTime());
    expect(isHandoffFreshWindow(storeDir, NOW.getTime() + 60_000, tmp)).toBe(
      true,
    );
    expect(
      isHandoffFreshWindow(storeDir, NOW.getTime() + 6 * 60_000, tmp),
    ).toBe(false);
    expect(
      isHandoffFreshWindow(
        storeDir,
        NOW.getTime() + HANDOFF_FRESH_WINDOW_MS,
        tmp,
      ),
    ).toBe(false);
  });
  test("corrupt latest.md → not fresh (guard degrades open)", () => {
    fs.mkdirSync(storeDir, { recursive: true });
    fs.writeFileSync(path.join(storeDir, "latest.md"), "path: /nope\n");
    expect(isHandoffFreshWindow(storeDir, Date.now(), tmp)).toBe(false);
  });
});

describe("buildSeedKickoff (F4/F8)", () => {
  const doc = [
    "# Handover - 2026-09-23 · session s · 100k tokens → handoff",
    "",
    "## 1 · Mission",
    "Ship the bridge with tests.",
    "",
    "## 2 · In-flight (NOW)",
    "Wiring the compact handler.",
    "",
    "## 10 · Last 3 user asks",
    "1. do the thing",
  ].join("\n");
  test("digest + forced read of latest.md + pending-question instruction", () => {
    const home = "/home/monky";
    const k = buildSeedKickoff(doc, "~/.jarate/handovers", home);
    const lines = k.split("\n");
    // preamble + 5-line digest + the read instruction
    expect(lines[1]).toBe("Mission: Ship the bridge with tests.");
    expect(lines[2]).toBe("In-flight: Wiring the compact handler.");
    expect(lines[3]).toBe("Last ask: 1. do the thing");
    expect(lines[4]).toBe("Scheduled: (none)");
    expect(lines[5]).toBe(ORCHESTRATOR_PRIME_LINE);
    expect(lines[6]).toBe(
      `Read ${path.join(home, ".jarate", "handovers", "latest.md")} before continuing. Answer the last pending user question if any.`,
    );
  });
  test("live state → seed carries ticket id + orchestrator line (issue #134)", () => {
    const detDoc = [
      "# Handover - 2026-10-03 · session s · 246k tokens → handoff",
      "",
      "## State",
      "- dispatch:",
      "┌ jobs · 1 in flight",
      "┣ 20261003-081922-478435 worker · 01:07:43",
      "└",
      "",
      "## Last user asks",
      "1. ask",
    ].join("\n");
    const k = buildSeedKickoff(detDoc, "/abs/handovers", "/home/monky", {
      dispatchText:
        "┌ jobs · 1 in flight\n┣ 20261003-081922-478435 worker · 01:07:43\n└",
      todoBoard: "┌ todos · 1 open\n├ ship it\n└",
    });
    expect(k).toContain("In-flight: 20261003-081922-478435 worker · 01:07:43");
    expect(k).toContain("Mission: 1 open: ship it");
    expect(k).toContain(ORCHESTRATOR_PRIME_LINE);
    expect(k).toContain("Last ask: 1. ask");
  });
  test("absolute storeDir is not re-expanded", () => {
    const k = buildSeedKickoff(doc, "/abs/handovers", "/home/monky");
    expect(k).toContain("Read /abs/handovers/latest.md before continuing.");
  });
});

// ─── resolveHandoffSettings ─────────────────────────────────────────────────

describe("resolveHandoffSettings", () => {
  let tmp = "";
  let oldHome = "";
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "handover-cfg-"));
    oldHome = process.env.HOME || "";
    process.env.HOME = path.join(tmp, "home");
    fs.mkdirSync(path.join(tmp, "home", ".pi", "agent"), { recursive: true });
    fs.mkdirSync(path.join(tmp, "proj", ".pi"), { recursive: true });
  });
  afterEach(() => {
    process.env.HOME = oldHome;
    fs.rmSync(tmp, { recursive: true, force: true });
  });
  const write = (p: string, obj: unknown) =>
    fs.writeFileSync(p, JSON.stringify(obj));

  test("defaults: enabled TRUE (PR2), threshold 0.8, cap 2000000 (issue #85)", () => {
    const s = resolveHandoffSettings(path.join(tmp, "proj"), {});
    expect(s.enabled).toBe(true);
    expect(s.threshold).toBe(0.8);
    // 2MB (was 64MB, issue #85): a full 262k-window compact writes a
    // 1–5MB session file, so the old default made the restart unreachable.
    expect(s.restartFileCap).toBe(2_000_000);
    expect(s.sizeGuardTokens).toBe(12_000);
    expect(s.storeDir).toBe("~/.jarate/handovers");
  });
  test("global handoff block is read", () => {
    write(path.join(tmp, "home", ".pi", "agent", "settings.json"), {
      handoff: { enabled: true, threshold: 0.9 },
    });
    const s = resolveHandoffSettings(path.join(tmp, "proj"), {});
    expect(s.enabled).toBe(true);
    expect(s.threshold).toBe(0.9);
  });
  test("project block overrides global", () => {
    write(path.join(tmp, "home", ".pi", "agent", "settings.json"), {
      handoff: { enabled: true, threshold: 0.9 },
    });
    write(path.join(tmp, "proj", ".pi", "settings.json"), {
      handoff: { threshold: 0.7, sizeGuardTokens: 9000 },
    });
    const s = resolveHandoffSettings(path.join(tmp, "proj"), {});
    expect(s.enabled).toBe(true);
    expect(s.threshold).toBe(0.7);
    expect(s.sizeGuardTokens).toBe(9000);
  });
  test("env HANDOFF_THRESHOLD overrides settings", () => {
    write(path.join(tmp, "proj", ".pi", "settings.json"), {
      handoff: { threshold: 0.7 },
    });
    const s = resolveHandoffSettings(path.join(tmp, "proj"), {
      HANDOFF_THRESHOLD: "0.55",
    } as NodeJS.ProcessEnv);
    expect(s.threshold).toBe(0.55);
  });
  test("env HANDOFF_RESTART_FILE_CAP overrides", () => {
    const s = resolveHandoffSettings(path.join(tmp, "proj"), {
      HANDOFF_RESTART_FILE_CAP: "32000000",
    } as NodeJS.ProcessEnv);
    expect(s.restartFileCap).toBe(32_000_000);
  });
  test("env HANDOFF_ENABLED overrides settings both ways", () => {
    write(path.join(tmp, "home", ".pi", "agent", "settings.json"), {
      handoff: { enabled: false },
    });
    expect(
      resolveHandoffSettings(path.join(tmp, "proj"), {
        HANDOFF_ENABLED: "1",
      } as NodeJS.ProcessEnv).enabled,
    ).toBe(true);
    expect(
      resolveHandoffSettings(path.join(tmp, "proj"), {
        HANDOFF_ENABLED: "true",
      } as NodeJS.ProcessEnv).enabled,
    ).toBe(true);
    write(path.join(tmp, "home", ".pi", "agent", "settings.json"), {
      handoff: { enabled: true },
    });
    expect(
      resolveHandoffSettings(path.join(tmp, "proj"), {
        HANDOFF_ENABLED: "0",
      } as NodeJS.ProcessEnv).enabled,
    ).toBe(false);
    // unset env → settings value stands
    expect(
      resolveHandoffSettings(path.join(tmp, "proj"), {} as NodeJS.ProcessEnv)
        .enabled,
    ).toBe(true);
  });
  test("invalid values fall back to defaults", () => {
    write(path.join(tmp, "proj", ".pi", "settings.json"), {
      handoff: { threshold: 2.5, sizeGuardTokens: -5, storeDir: "" },
    });
    const s = resolveHandoffSettings(path.join(tmp, "proj"), {});
    expect(s.threshold).toBe(HANDOFF_DEFAULTS.threshold);
    expect(s.sizeGuardTokens).toBe(HANDOFF_DEFAULTS.sizeGuardTokens);
    expect(s.storeDir).toBe(HANDOFF_DEFAULTS.storeDir);
  });
  test("env override wins over an invalid settings value", () => {
    write(path.join(tmp, "proj", ".pi", "settings.json"), {
      handoff: { threshold: "nope" },
    });
    const s = resolveHandoffSettings(path.join(tmp, "proj"), {
      HANDOFF_THRESHOLD: "0.6",
    } as NodeJS.ProcessEnv);
    expect(s.threshold).toBe(0.6);
  });
});

// ─── buildHandover (LLM seam) ───────────────────────────────────────────────

describe("buildHandover", () => {
  let tmp = "";
  let oldHome = "";
  let storeDir = "";
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "handover-build-"));
    oldHome = process.env.HOME || "";
    process.env.HOME = tmp;
    storeDir = path.join(tmp, "handovers");
  });
  afterEach(() => {
    process.env.HOME = oldHome;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const settings = (over: Partial<HandoffSettings> = {}): HandoffSettings => ({
    ...HANDOFF_DEFAULTS,
    storeDir,
    enabled: true,
    ...over,
  });
  const ctx: any = {
    cwd: tmp,
    model: { id: "m", name: "M", provider: "p" },
    modelRegistry: {},
    sessionManager: {
      getSessionFile: () => null,
      getSessionId: () => "sess-77",
      getEntries: () => new Array(5).fill({ type: "message" }),
    },
    getContextUsage: () => ({
      tokens: 200_000,
      contextWindow: 262_144,
      percent: 76,
    }),
  };
  const pi: any = { sendMessage: () => {} };

  test("deterministic: doc returned, written to store, no LLM call", async () => {
    const complete = jest.fn(async () => "should not be called");
    const doc = await buildHandover({
      preparation: basePrep(),
      branchEntries: [],
      ctx,
      pi,
      settings: settings(),
      complete,
      now: NOW,
    });
    expect(complete).not.toHaveBeenCalled(); // NO LLM call
    expect(doc).toContain("session sess-77");
    expect(doc).toContain("## Transcript");
    expect(doc).toContain("## References");
    expect(doc).toContain("## State");
    const files = fs.readdirSync(storeDir);
    expect(files).toContain("latest.md");
    expect(loadPreviousHandover({ storeDir })).toBe(doc);
    const tags = parsePriorTags(doc);
    expect(tags.readFiles).toContain("/home/monky/code/app/src/a.ts");
    expect(tags.modifiedFiles).toContain("/home/monky/code/app/src/b.ts");
  });

  test("deterministic: transcript span is embedded in the doc", async () => {
    const doc = await buildHandover({
      preparation: basePrep(),
      branchEntries: [],
      ctx,
      pi,
      settings: settings(),
      now: NOW,
    });
    // the actual user/assistant/tool text from the span is in the doc
    expect(doc).toContain("fix the bug in PR #42"); // user ask
    expect(doc).toContain("ok, reading /home/monky/code/app/src/a.ts"); // assistant reply
  });
  test("deterministic: kept tail is carried into the doc in full (RCA F2)", async () => {
    const p = basePrep();
    p.firstKeptEntryId = "keep-tail-1";
    const doc = await buildHandover({
      preparation: p,
      branchEntries: [
        {
          id: "summarized-1",
          type: "message",
          message: { role: "user", content: "old summarized work" },
        } as any,
        {
          id: "keep-tail-1",
          type: "message",
          message: { role: "user", content: "kept work A" },
        } as any,
        {
          id: "keep-tail-2",
          type: "message",
          message: { role: "assistant", content: "kept work B" },
        } as any,
      ],
      ctx,
      pi,
      settings: settings(),
      now: NOW,
    });
    // new deterministic section title: the doc leads with current state
    expect(doc).toContain("## Transcript (current state first)");
    // the kept tail (dropped from pi's context by the restart) is in the doc
    expect(doc).toContain("[user] kept work A");
    expect(doc).toContain("[assistant] kept work B");
    expect(doc).toContain("…[older span]");
    // tail before span, and the summarized entry stays out of the tail
    const iTail = doc.indexOf("kept work A");
    const iSpan = doc.indexOf("fix the bug in PR #42");
    expect(iTail).toBeGreaterThan(-1);
    expect(iTail).toBeLessThan(iSpan);
    expect(doc).not.toContain("old summarized work");
  });

  test("deterministic: prior tags flow into the new doc", async () => {
    const doc = await buildHandover({
      preparation: basePrep(),
      branchEntries: [],
      ctx,
      pi,
      settings: settings(),
      priorDoc: PRIOR_DOC,
      now: NOW,
    });
    const tags = parsePriorTags(doc);
    expect(tags.readFiles).toContain("/home/monky/code/app/src/old1.ts");
    expect(tags.readFiles).toContain("/home/monky/code/app/src/a.ts");
    expect(tags.modifiedFiles).toContain("/home/monky/code/app/src/old3.ts");
  });

  test("deterministic: huge transcript is size-guarded to the budget", async () => {
    const hugePrep = {
      ...basePrep(),
      messagesToSummarize: Array.from(
        { length: 200 },
        (_, i) =>
          ({
            role: "assistant",
            content: [
              {
                type: "text",
                text: `done item ${i} with enough words to burn real token budget for the size guard test`,
              },
            ],
          }) as any,
      ),
    };
    const doc = await buildHandover({
      preparation: hugePrep,
      branchEntries: [],
      ctx,
      pi,
      settings: settings({ sizeGuardTokens: 5_000 }),
      now: NOW,
    });
    expect(estTokens(doc)).toBeLessThanOrEqual(5_000);
  });

  test("deterministic: empty transcript -> (none), no throw", async () => {
    const prep = {
      ...basePrep(),
      messagesToSummarize: [],
      turnPrefixMessages: [],
    };
    const doc = await buildHandover({
      preparation: prep,
      branchEntries: [],
      ctx,
      pi,
      settings: settings(),
      now: NOW,
    });
    expect(doc).toContain("## Transcript");
  });

  test("doc State box carries the pending task (issue #140)", async () => {
    // HOME is tmp: write the task store the way tasks.test.ts does it.
    const dir = path.join(tmp, ".pi", "agent", "tasks");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "tasks.json"),
      JSON.stringify({
        tasks: [
          {
            id: "m3x2k9-ab12",
            channelId: "ch1",
            channelName: "franky",
            prompt: "fire the morning check",
            kind: "at",
            atMs: NOW.getTime() + 5 * 3600_000,
            createdAt: NOW.getTime(),
            nextFireAt: NOW.getTime() + 5 * 3600_000,
            status: "pending",
          },
        ],
      }),
    );
    const doc = await buildHandover({
      preparation: basePrep(),
      branchEntries: [],
      ctx,
      pi,
      settings: settings(),
      now: NOW,
    });
    expect(doc).toContain("- scheduled:");
    expect(doc).toContain("m3x2k9-ab12");
    expect(doc).toContain("fire the morning check");
    // the scheduled block sits after dispatch, before todos
    const iDispatch = doc.indexOf("- dispatch:");
    const iScheduled = doc.indexOf("- scheduled:");
    const iTodos = doc.indexOf("- todos:");
    expect(iDispatch).toBeGreaterThan(-1);
    expect(iScheduled).toBeGreaterThan(iDispatch);
    expect(iTodos).toBeGreaterThan(iScheduled);
  });

  test("empty task store → '- scheduled:' (none) in the doc State box", async () => {
    const doc = await buildHandover({
      preparation: basePrep(),
      branchEntries: [],
      ctx,
      pi,
      settings: settings(),
      now: NOW,
    });
    expect(doc).toMatch(/- scheduled:\n {2}\(none\)/);
  });
});

// ─── liveKickoffState: the task store enters the seed (issue #140) ─────────

describe("liveKickoffState scheduled pipe (issue #140)", () => {
  let tmp = "";
  let oldHome = "";

  const writeTasks = (tasks: unknown[]) => {
    const dir = path.join(tmp, ".pi", "agent", "tasks");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "tasks.json"), JSON.stringify({ tasks }));
  };

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "handover-live-"));
    oldHome = process.env.HOME || "";
    process.env.HOME = tmp;
  });

  afterEach(() => {
    process.env.HOME = oldHome;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test("pending + claimed tasks → scheduledText, cap 5 lines", () => {
    const t = (id: string) => ({
      id,
      channelId: "ch1",
      channelName: "franky",
      prompt: `prompt for ${id}`,
      kind: "at",
      atMs: NOW.getTime() + 60_000,
      createdAt: NOW.getTime(),
      nextFireAt: NOW.getTime() + 60_000,
      status: "pending",
    });
    const tasks: unknown[] = Array.from({ length: 7 }, (_, i) =>
      t(`task-${i}`),
    );
    tasks.push({
      ...t("claimed-1"),
      status: "claimed",
      claimedAt: NOW.getTime(),
    });
    writeTasks(tasks);
    const lines = (liveKickoffState(tmp).scheduledText ?? "").split("\n");
    expect(lines).toHaveLength(5); // cap 5
    expect(lines[0]).toContain("task-0");
    expect(lines[0]).toContain("prompt for task-0");
  });
  test("empty store → null", () => {
    writeTasks([]);
    expect(liveKickoffState(tmp).scheduledText).toBeNull();
  });
  test("missing file → null (a missing store cannot break the seed)", () => {
    expect(liveKickoffState(tmp).scheduledText).toBeNull();
  });
  test("corrupt store → null (a corrupt store cannot break the seed)", () => {
    const dir = path.join(tmp, ".pi", "agent", "tasks");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "tasks.json"), "{not json");
    expect(liveKickoffState(tmp).scheduledText).toBeNull();
  });
  test("wrong-shape store → null", () => {
    const dir = path.join(tmp, ".pi", "agent", "tasks");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "tasks.json"), JSON.stringify({ nope: 1 }));
    expect(liveKickoffState(tmp).scheduledText).toBeNull();
  });
  test("liveKickoffState: todoBoard + openTodos from ONE board load (F1)", () => {
    // channel config scoped to the tmp cwd (one default channel, ch1)
    const piDir = path.join(tmp, ".pi");
    fs.mkdirSync(piDir, { recursive: true });
    fs.writeFileSync(
      path.join(piDir, "settings.json"),
      JSON.stringify({
        channels: [{ id: "ch1", name: "franky", enabled: true, default: true }],
      }),
    );
    const todos: Todo[] = [
      { content: "done one", status: "completed" },
      { content: "done two", status: "completed" },
      { content: "open one", status: "pending" },
      { content: "open two", status: "in_progress" },
    ];
    saveBoard({ channelId: "ch1", todos, updatedAt: "" }, tmp);
    const live = liveKickoffState(tmp);
    // todoBoard is the REAL renderBoardPlain text (completed = plain ├)
    expect(live.todoBoard).toBe(renderBoardPlain(todos));
    // openTodos: open only (pending | in_progress), board order
    expect(live.openTodos).toEqual({
      count: 2,
      items: ["open one", "open two"],
    });
  });
  test("liveKickoffState: empty board → todoBoard + openTodos both null", () => {
    const piDir = path.join(tmp, ".pi");
    fs.mkdirSync(piDir, { recursive: true });
    fs.writeFileSync(
      path.join(piDir, "settings.json"),
      JSON.stringify({
        channels: [{ id: "ch1", name: "franky", enabled: true, default: true }],
      }),
    );
    saveBoard({ channelId: "ch1", todos: [], updatedAt: "" }, tmp);
    const live = liveKickoffState(tmp);
    expect(live.todoBoard).toBeNull();
    expect(live.openTodos).toBeNull();
  });
});

// ─── moveSessionFileAside (F5) ──────────────────────────────────────────────

describe("moveSessionFileAside (F5)", () => {
  let tmp = "";
  let oldHome = "";
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "handover-move-"));
    oldHome = process.env.HOME || "";
    process.env.HOME = tmp;
  });
  afterEach(() => {
    process.env.HOME = oldHome;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const mkSession = (name: string, ageMs: number): string => {
    const dir = path.join(tmp, ".pi", "agent", "sessions", "profile");
    fs.mkdirSync(dir, { recursive: true });
    const f = path.join(dir, name);
    fs.writeFileSync(f, "{}");
    const t = Date.now() - ageMs;
    fs.utimesSync(f, t / 1000, t / 1000);
    return f;
  };

  test("explicit target is moved even when another file is newer", () => {
    const live = mkSession("live.jsonl", 60_000); // older
    const other = mkSession("newer.jsonl", 1_000); // newer mtime
    const ctx: any = {
      cwd: tmp,
      sessionManager: { getSessionFile: () => live },
    };
    moveSessionFileAside(ctx, live);
    expect(fs.existsSync(live)).toBe(false);
    expect(
      fs
        .readdirSync(path.dirname(live))
        .some((f) => f.startsWith("live.jsonl.reset-")),
    ).toBe(true);
    expect(fs.existsSync(other)).toBe(true); // the mtime trap is avoided
  });
  test("explicit target missing → mtime fallback picks the newest", () => {
    const old = mkSession("old.jsonl", 60_000);
    const newer = mkSession("newer.jsonl", 1_000);
    const ctx: any = {
      cwd: tmp,
      sessionManager: { getSessionFile: () => path.join(tmp, "gone.jsonl") },
    };
    moveSessionFileAside(ctx);
    expect(fs.existsSync(newer)).toBe(false);
    expect(fs.existsSync(old)).toBe(true);
  });
  test("no sessionManager at all → mtime fallback still works", () => {
    const newer = mkSession("newer.jsonl", 1_000);
    moveSessionFileAside({ cwd: tmp } as any);
    expect(fs.existsSync(newer)).toBe(false);
  });
});

// ─── session_before_compact wiring (index.ts) ───────────────────────────────

describe("session_before_compact wiring", () => {
  let tmp = "";
  let oldHome = "";
  let handlers: Record<string, (...a: any[]) => any> = {};
  let fetchCalls: { url: string; method: string; body?: any }[] = [];
  let sent: any[] = [];
  let ctx: any;
  let compacts = 0;
  const realFetch = globalThis.fetch;

  const mkEvent = (reason: string) => ({
    type: "session_before_compact",
    preparation: basePrep(),
    branchEntries: [],
    reason,
    willRetry: false,
    signal: new AbortController().signal,
  });

  const channelPosts = () =>
    fetchCalls
      .filter(
        (c) => c.url.includes("/channels/ch1/messages") && c.method === "POST",
      )
      .map(
        (c) =>
          (typeof c.body === "string" ? JSON.parse(c.body) : c.body).content,
      );

  const writeSettings = (obj: unknown) =>
    fs.writeFileSync(
      path.join(tmp, "proj", ".pi", "settings.json"),
      JSON.stringify(obj),
    );

  const CHANNELS = [
    {
      id: "ch1",
      name: "Test",
      type: "discord",
      botToken: "tok1",
      ownerUserId: "uid",
      ack: true,
    },
  ];

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "handover-wiring-"));
    oldHome = process.env.HOME || "";
    const home = path.join(tmp, "home");
    process.env.HOME = home;
    fs.mkdirSync(path.join(tmp, "proj", ".pi"), { recursive: true });
    writeSettings({
      channels: CHANNELS,
      handoff: {
        enabled: true,
        storeDir: path.join(home, ".jarate", "handovers"),
      },
    });
    handlers = {};
    fetchCalls = [];
    sent = [];
    compacts = 0;
    const pi: any = {
      registerMessageRenderer: () => {},
      registerTool: () => {},
      on: (n: string, fn: any) => {
        handlers[n] = fn;
      },
      sendMessage: (m: any) => {
        sent.push(m);
      },
    };
    extension(pi);
    ctx = {
      cwd: path.join(tmp, "proj"),
      ui: { setStatus: () => {} },
      isIdle: () => true,
      hasPendingMessages: () => false,
      abort: () => {},
      compact: () => {
        compacts++;
      },
      modelRegistry: { getAvailable: () => [] },
      getContextUsage: () => ({
        tokens: 210_000,
        contextWindow: 262_144,
        percent: 80.1,
      }),
      model: { id: "cur", name: "Cur", provider: "test" },
      sessionManager: {
        getSessionFile: () => null,
        getSessionId: () => "sess-9",
        getEntries: () => new Array(12).fill({ type: "message" }),
      },
      shutdown: () => {},
    };
    globalThis.fetch = (async (url: any, init?: any) => {
      fetchCalls.push({
        url: String(url),
        method: init?.method ?? "GET",
        body: init?.body,
      });
      return {
        ok: true,
        status: 200,
        json: async () => ({ id: "out1" }),
        text: async () => "",
      };
    }) as any;
    seedChannelStateForTest("ch1", "ch1", path.join(tmp, "tmp"));
    setChannelCursor("ch1", "1000");
    setSystemdRestartHookForTest(() => {});
  });

  afterEach(() => {
    setHandoverCompleteForTest(null);
    setHandoffInFlight(false);
    setHandoffRestartArmed(false);
    stopAllOpTicks();
    clearAllCompacting();
    clearDiscordStatesForTest();
    process.env.HOME = oldHome;
    globalThis.fetch = realFetch;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const PROSE = [
    "[MISSION] Ship the bridge.",
    "[IN_FLIGHT] Wire the handler",
    "[DONE] Wrote tests",
    "[BLOCKERS] (none)",
    "[DECISIONS] Chose bun",
    "[FOLLOWUPS] Tag corpus",
    "[GOTCHAS] vLLM is sacred",
  ].join("\n");

  test("disabled (explicit opt-out): built-in path, LLM not called", async () => {
    writeSettings({ channels: CHANNELS, handoff: { enabled: false } }); // explicit opt-out
    let called = 0;
    setHandoverCompleteForTest(async () => {
      called++;
      return PROSE;
    });
    const out = await handlers.session_before_compact(mkEvent("manual"), ctx);
    expect(out).toBeUndefined();
    expect(called).toBe(0);
    expect(isHandoffInFlight()).toBe(false);
  });

  test("enabled + manual → CompactionResult with durable doc + details tags", async () => {
    setHandoverCompleteForTest(async () => PROSE);
    const out = await handlers.session_before_compact(mkEvent("manual"), ctx);
    expect(out).toBeDefined();
    const c = out.compaction;
    expect(c.summary).toContain("# Handover - ");
    expect(c.summary).toContain("## Transcript");
    expect(c.summary).toContain("fix the bug in PR #42");
    expect(c.firstKeptEntryId).toBe("entry-keep-1");
    expect(c.tokensBefore).toBe(183_000);
    expect(c.details.readFiles).toContain("/home/monky/code/app/src/a.ts");
    expect(c.details.modifiedFiles).toContain("/home/monky/code/app/src/b.ts");
    // doc persisted to the store
    expect(
      fs.existsSync(
        path.join(tmp, "home", ".jarate", "handovers", "latest.md"),
      ),
    ).toBe(true);
    expect(isHandoffInFlight()).toBe(false);
  });

  test("arms the restart when it writes a doc (issue #85: compact -> fresh session)", async () => {
    setHandoverCompleteForTest(async () => PROSE);
    expect(isHandoffRestartArmed()).toBe(false);
    const out = await handlers.session_before_compact(mkEvent("manual"), ctx);
    expect(out).toBeDefined();
    // A doc was written -> the triggering restart is armed, so it is exempt
    // from the fresh window this doc just set (maybeHandoffRestart).
    expect(isHandoffRestartArmed()).toBe(true);
  });

  test("does not arm the restart on the built-in path (no doc written)", async () => {
    writeSettings({ channels: CHANNELS, handoff: { enabled: false } });
    setHandoverCompleteForTest(async () => PROSE);
    expect(isHandoffRestartArmed()).toBe(false);
    const out = await handlers.session_before_compact(mkEvent("manual"), ctx);
    expect(out).toBeUndefined();
    expect(isHandoffRestartArmed()).toBe(false); // no doc -> no arm
  });

  test("enabled + threshold: at/over HANDOFF_THRESHOLD → handover", async () => {
    setHandoverCompleteForTest(async () => PROSE);
    const out = await handlers.session_before_compact(
      mkEvent("threshold"),
      ctx,
    );
    expect(out).toBeDefined();
    expect(out.compaction.summary).toContain("183k tokens → handoff");
  });

  test("enabled + threshold under the line → built-in path", async () => {
    ctx.getContextUsage = () => ({
      tokens: 180_000,
      contextWindow: 262_144,
      percent: 68.7,
    });
    let called = 0;
    setHandoverCompleteForTest(async () => {
      called++;
      return PROSE;
    });
    const out = await handlers.session_before_compact(
      mkEvent("threshold"),
      ctx,
    );
    expect(out).toBeUndefined();
    expect(called).toBe(0);
  });

  test("deterministic: no LLM call, so no fallback needed (500 is gone)", async () => {
    // The old LLM-failure→fallback path is gone: there is no LLM call, so
    // there is no 500 to fall back from. A manual compact always produces
    // the doc.
    const out = await handlers.session_before_compact(mkEvent("manual"), ctx);
    expect(out).toBeDefined();
    expect(out?.compaction?.summary).toContain("## Transcript");
    expect(isHandoffInFlight()).toBe(false);
  });

  test("F10: in-flight flag set synchronously; concurrent compaction refused", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    setHandoverCompleteForTest(async () => {
      await gate;
      return PROSE;
    });
    const p1 = handlers.session_before_compact(mkEvent("manual"), ctx);
    // handler entry is sync up to the first await: flag is already set
    expect(isHandoffInFlight()).toBe(true);
    const p2 = await handlers.session_before_compact(mkEvent("manual"), ctx);
    expect(p2).toBeUndefined(); // gated while p1 is in flight
    release();
    const out1 = await p1;
    expect(out1).toBeDefined();
    expect(isHandoffInFlight()).toBe(false);
  });

  test("/handover: owner triggers compact, disabled notice posted (opt-out)", async () => {
    writeSettings({ channels: CHANNELS, handoff: { enabled: false } }); // handoff opted out
    const msg: ChannelMessage = {
      channelId: "ch1",
      channelName: "Test",
      channelType: "discord",
      messageId: "m1",
      from: "owner",
      fromId: "uid",
      body: "/handover",
      timestamp: new Date().toISOString(),
      attachments: [],
      isRoom: false,
    };
    await handleInbound(
      { on: () => {}, sendMessage: () => {} } as any,
      msg,
      ctx,
    );
    expect(compacts).toBe(1);
    expect(
      channelPosts().some((p: string) => p.includes("[!] handoff disabled")),
    ).toBe(true);
  });

  test("/handover: non-owner not executed, falls through as plain text", async () => {
    const msg: ChannelMessage = {
      channelId: "ch1",
      channelName: "Test",
      channelType: "discord",
      messageId: "m2",
      from: "stranger",
      fromId: "other",
      body: "/handover",
      timestamp: new Date().toISOString(),
      attachments: [],
      isRoom: false,
    };
    const pi: any = {
      on: () => {},
      sendMessage: (m: any) => {
        sent.push(m);
      },
    };
    await handleInbound(pi, msg, ctx);
    expect(compacts).toBe(0);
    expect(isCompacting("ch1")).toBe(false);
    // not the owner: refused explicitly — never handed to pi as plain text
    // (2026-09-23: a recognised command silently became a prompt when the
    // sender was not permitted, which reads as the bridge ignoring commands)
    expect(sent).toHaveLength(0);
  });
});

// ─── Proactive token-% auto-compact gate (agent_end wiring) ───────────────
// After every settled turn: context at/over the handoff threshold, nothing
// in flight → the same compact /compact runs (startCompact). The doc is
// written by the session_before_compact path; the size gate on
// session_compact decides the restart as before.

describe("auto-compact token-% gate", () => {
  let tmp = "";
  let oldHome = "";
  let handlers: Record<string, (...a: any[]) => any> = {};
  let fetchCalls: { url: string; method: string; body?: any }[] = [];
  let ctx: any;
  let compacts = 0;
  const realFetch = globalThis.fetch;

  const mkEvent = (reason: string) => ({
    type: "session_before_compact",
    preparation: basePrep(),
    branchEntries: [],
    reason,
    willRetry: false,
    signal: new AbortController().signal,
  });

  const writeSettings = (obj: unknown) =>
    fs.writeFileSync(
      path.join(tmp, "proj", ".pi", "settings.json"),
      JSON.stringify(obj),
    );

  const CHANNELS = [
    {
      id: "ch1",
      name: "Test",
      type: "discord",
      botToken: "tok1",
      ownerUserId: "uid",
      ack: true,
    },
  ];

  const flushMacrotasks = () => new Promise((r) => setTimeout(r, 20));

  const PROSE = [
    "[MISSION] Ship the bridge.",
    "[IN_FLIGHT] Wire the handler",
    "[DONE] Wrote tests",
    "[BLOCKERS] (none)",
    "[DECISIONS] Chose bun",
    "[FOLLOWUPS] Tag corpus",
    "[GOTCHAS] vLLM is sacred",
  ].join("\n");

  beforeEach(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "handover-autocompact-"));
    oldHome = process.env.HOME || "";
    const home = path.join(tmp, "home");
    process.env.HOME = home;
    fs.mkdirSync(path.join(tmp, "proj", ".pi"), { recursive: true });
    writeSettings({
      channels: CHANNELS,
      handoff: {
        enabled: true,
        storeDir: path.join(home, ".jarate", "handovers"),
      },
    });
    handlers = {};
    fetchCalls = [];
    compacts = 0;
    const pi: any = {
      registerMessageRenderer: () => {},
      registerTool: () => {},
      on: (n: string, fn: any) => {
        handlers[n] = fn;
      },
      sendMessage: () => {},
    };
    extension(pi);
    ctx = {
      cwd: path.join(tmp, "proj"),
      ui: { setStatus: () => {} },
      isIdle: () => true,
      hasPendingMessages: () => false,
      abort: () => {},
      compact: () => {
        compacts++;
      },
      modelRegistry: { getAvailable: () => [] },
      // 80.1%: at/over the default 0.8 threshold.
      getContextUsage: () => ({
        tokens: 210_000,
        contextWindow: 262_144,
        percent: 80.1,
      }),
      model: { id: "cur", name: "Cur", provider: "test" },
      sessionManager: {
        getSessionFile: () => null,
        getSessionId: () => "sess-9",
        getEntries: () => new Array(12).fill({ type: "message" }),
      },
      shutdown: () => {},
    };
    globalThis.fetch = (async (url: any, init?: any) => {
      fetchCalls.push({
        url: String(url),
        method: init?.method ?? "GET",
        body: init?.body,
      });
      return {
        ok: true,
        status: 200,
        json: async () => ({ id: "out1" }),
        text: async () => "",
      };
    }) as any;
    seedChannelStateForTest("ch1", "ch1", path.join(tmp, "tmp"));
    setChannelCursor("ch1", "1000");
    setSystemdRestartHookForTest(() => {});
    // lastActiveChannel = ch1, no run started: /status is read-only.
    await handleInbound(
      { on: () => {}, sendMessage: () => {} } as any,
      {
        channelId: "ch1",
        channelName: "Test",
        channelType: "discord",
        messageId: "s1",
        from: "owner",
        fromId: "uid",
        body: "/status",
        timestamp: new Date().toISOString(),
        attachments: [],
        isRoom: false,
      },
      ctx,
    );
  });

  afterEach(() => {
    setHandoverCompleteForTest(null);
    setHandoffInFlight(false);
    setHandoffRestartArmed(false);
    stopAllOpTicks();
    clearAllCompacting();
    clearDiscordStatesForTest();
    process.env.HOME = oldHome;
    globalThis.fetch = realFetch;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test("at/over threshold + idle + enabled + nothing in flight → compact", async () => {
    const logs: string[] = [];
    const realLog = console.log;
    console.log = (...a: any[]) => {
      logs.push(a.join(" "));
    };
    try {
      await handlers.agent_end({ messages: [] }, ctx);
      await flushMacrotasks();
    } finally {
      console.log = realLog;
    }
    expect(compacts).toBe(1);
    // the /compact path was used: op window open, label "compacting"
    expect(isCompacting("ch1")).toBe(true);
    expect(opWindowLabel("ch1")).toBe("compacting");
    expect(
      logs.some(
        (l) =>
          l ===
          `[handoff] auto-compact: ctx 80.1% >= ${HANDOFF_DEFAULTS.threshold * 100}%`,
      ),
    ).toBe(true);
  });

  test("under threshold → not triggered (invisible)", async () => {
    ctx.getContextUsage = () => ({
      tokens: 200_000,
      contextWindow: 262_144,
      percent: 79.9,
    });
    await handlers.agent_end({ messages: [] }, ctx);
    await flushMacrotasks();
    expect(compacts).toBe(0);
    expect(isCompacting("ch1")).toBe(false);
  });

  test("over threshold but handoff in flight → not triggered (no double)", async () => {
    setHandoffInFlight(true);
    await handlers.agent_end({ messages: [] }, ctx);
    await flushMacrotasks();
    expect(compacts).toBe(0);
    expect(isCompacting("ch1")).toBe(false);
  });

  test("over threshold but in the fresh window → not triggered", async () => {
    // a doc was just written (e.g. by the compact this gate would start):
    // the seeded session is not handoff-eligible for HANDOFF_FRESH_WINDOW_MS
    const home = path.join(tmp, "home");
    writeHandover("# Handover - just written\n", {
      storeDir: path.join(home, ".jarate", "handovers"),
      home,
    });
    expect(isHandoffFreshWindow(path.join(home, ".jarate", "handovers"))).toBe(
      true,
    );
    await handlers.agent_end({ messages: [] }, ctx);
    await flushMacrotasks();
    expect(compacts).toBe(0);
    expect(isCompacting("ch1")).toBe(false);
  });

  test("disabled → not triggered", async () => {
    const home = path.join(tmp, "home");
    writeSettings({
      channels: CHANNELS,
      handoff: {
        enabled: false,
        storeDir: path.join(home, ".jarate", "handovers"),
      },
    });
    await handlers.agent_end({ messages: [] }, ctx);
    await flushMacrotasks();
    expect(compacts).toBe(0);
    expect(isCompacting("ch1")).toBe(false);
  });

  test("no loop: settle → compact → doc → settle does NOT re-fire", async () => {
    // 1) settled turn over threshold: the gate fires the compact.
    await handlers.agent_end({ messages: [] }, ctx);
    await flushMacrotasks();
    expect(compacts).toBe(1);
    expect(isCompacting("ch1")).toBe(true);
    // 2) pi compacts: session_before_compact writes the handover doc
    //    (the SAME path /compact + shouldHandoff uses).
    setHandoverCompleteForTest(async () => PROSE);
    const out = await handlers.session_before_compact(mkEvent("manual"), ctx);
    expect(out).toBeDefined();
    expect(
      fs.existsSync(
        path.join(tmp, "home", ".jarate", "handovers", "latest.md"),
      ),
    ).toBe(true);
    // 3) the compact settles: window closed, size gate ran (no-op — the
    //    mock session file is null, far under the restart cap).
    handlers.session_compact({}, ctx);
    await flushMacrotasks();
    expect(isCompacting("ch1")).toBe(false);
    // 4) next settled turn: still over threshold, but the fresh window
    //    (doc just written) blocks a re-fire — no tight loop.
    await handlers.agent_end({ messages: [] }, ctx);
    await flushMacrotasks();
    expect(compacts).toBe(1);
    expect(isCompacting("ch1")).toBe(false);
  });
});
