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
  isHandoffFreshWindow,
  lastHandoffAt,
  loadPreviousHandover,
  parseKickoff,
  parseLlmProse,
  parsePriorTags,
  renderTemplate,
  resolveHandoffSettings,
  serializeTranscript,
  shouldHandoff,
  sizeGuard,
  writeHandover,
} from "./handover";
import extension, {
  clearAllCompacting,
  handleInbound,
  isCompacting,
  isHandoffInFlight,
  moveSessionFileAside,
  setHandoffInFlight,
  setHandoverCompleteForTest,
  setSystemdRestartHookForTest,
  stopAllOpTicks,
} from "./index";
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
  test("no prior doc → current fileOps only", () => {
    const s = extractDeterministic(basePrep(), [], emptyCtx);
    expect(s.readFiles).toEqual(["/home/monky/code/app/src/a.ts"]);
    expect(s.modifiedFiles).toEqual([
      "/home/monky/code/app/src/b.ts",
      "/home/monky/code/app/src/c.ts",
    ]);
  });
  test("refs: PR #ids + pi-bg ticket ids, deduped", () => {
    const s = extractDeterministic(basePrep(), [], emptyCtx);
    expect(s.refs).toContain("#42");
    expect(s.refs).toContain("20260923-021858-3964667");
    expect(s.refs.filter((r) => r === "#42")).toHaveLength(1);
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
  test("links: deduped, trailing punctuation stripped", () => {
    const s = extractDeterministic(
      {
        ...basePrep(),
        messagesToSummarize: [
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
  test("last user asks: channel-inbound details.body, channel-ctx stripped, last 3", () => {
    const entries = [
      {
        id: "e1",
        type: "custom_message",
        customType: "channel-inbound",
        timestamp: 1,
        details: {
          body: '<channel-ctx type="discord">junk</channel-ctx>first ask',
        },
      },
      {
        id: "e2",
        type: "custom_message",
        customType: "channel-inbound",
        timestamp: 2,
        details: { body: "second ask" },
      },
      {
        id: "e3",
        type: "custom_message",
        customType: "channel-inbound",
        timestamp: 3,
        details: { body: "third ask" },
      },
      {
        id: "e4",
        type: "custom_message",
        customType: "channel-inbound",
        timestamp: 4,
        details: { body: "fourth ask" },
      },
    ];
    const s = extractDeterministic(basePrep(), entries as any, emptyCtx);
    expect(s.lastUserAsks).toEqual(["second ask", "third ask", "fourth ask"]);
    expect(s.lastUserAsks[0]).not.toContain("channel-ctx");
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
    modelLabel: "hydrogen/qwen3.8-27b",
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
      "10 · Last 3 user asks",
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
    expect(doc).toContain("- model: hydrogen/qwen3.8-27b");
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
      "10 · Last 3 user asks",
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
  test("3 lines: mission, in-flight, last ask", () => {
    const k = parseKickoff(doc);
    const lines = k.split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe("Mission: Ship the bridge with tests.");
    expect(lines[1]).toBe("In-flight: Wiring the compact handler.");
    expect(lines[2]).toBe("Last ask: 1. do the thing");
  });
  test("missing sections → (none) lines", () => {
    const k = parseKickoff("# bare doc\nno sections");
    const lines = k.split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain("(none)");
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
    // preamble + 3-line digest + the read instruction
    expect(lines[1]).toBe("Mission: Ship the bridge with tests.");
    expect(lines[2]).toBe("In-flight: Wiring the compact handler.");
    expect(lines[3]).toBe("Last ask: 1. do the thing");
    expect(lines[4]).toBe(
      `Read ${path.join(home, ".jarate", "handovers", "latest.md")} before continuing. Answer the last pending user question if any.`,
    );
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

  test("defaults: enabled FALSE (PR1), threshold 0.8, cap 64000000", () => {
    const s = resolveHandoffSettings(path.join(tmp, "proj"), {});
    expect(s.enabled).toBe(false);
    expect(s.threshold).toBe(0.8);
    expect(s.restartFileCap).toBe(64_000_000);
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
  const PROSE = [
    "[MISSION] Ship the bridge.",
    "[IN_FLIGHT] Next: wire the handler",
    "[DONE] Wrote tests",
    "[BLOCKERS] (none)",
    "[DECISIONS] Chose bun",
    "[FOLLOWUPS] Tag corpus",
    "[GOTCHAS] vLLM is sacred",
  ].join("\n");

  test("success: doc returned, written to store, tags match details", async () => {
    const complete = jest.fn(async () => PROSE);
    const doc = await buildHandover({
      preparation: basePrep(),
      branchEntries: [],
      ctx,
      pi,
      settings: settings(),
      complete,
      now: NOW,
    });
    expect(complete).toHaveBeenCalledTimes(1);
    expect(doc).toContain("session sess-77");
    expect(doc).toContain("## 1 · Mission");
    expect(doc).toContain("Ship the bridge.");
    const files = fs.readdirSync(storeDir);
    expect(files).toContain("latest.md");
    expect(files.some((f) => f.startsWith("20260923-1430-"))).toBe(true);
    expect(loadPreviousHandover({ storeDir })).toBe(doc);
    // details the wiring derives from the doc
    const tags = parsePriorTags(doc);
    expect(tags.readFiles).toContain("/home/monky/code/app/src/a.ts");
    expect(tags.modifiedFiles).toContain("/home/monky/code/app/src/b.ts");
  });
  test("system prompt + user prompt shape (prior doc is the base, F6)", async () => {
    let sys = "";
    let usr = "";
    const complete = jest.fn(async (s: string, u: string) => {
      sys = s;
      usr = u;
      return PROSE;
    });
    await buildHandover({
      preparation: basePrep(),
      branchEntries: [],
      ctx,
      pi,
      settings: settings(),
      complete,
      priorDoc: PRIOR_DOC,
      instructions: "keep the decisions",
      now: NOW,
    });
    expect(sys).toContain("[MISSION]");
    expect(usr).toContain("Build the bridge."); // prior doc text
    expect(usr).toContain("OPERATOR INSTRUCTIONS: keep the decisions");
    expect(usr).toContain("[user] fix the bug in PR #42"); // transcript
    expect(usr).toContain("refs: #42"); // skeleton facts
  });
  test("cumulative: prior tags flow into the new doc's tags", async () => {
    const doc = await buildHandover({
      preparation: basePrep(),
      branchEntries: [],
      ctx,
      pi,
      settings: settings(),
      complete: async () => PROSE,
      priorDoc: PRIOR_DOC,
      now: NOW,
    });
    const tags = parsePriorTags(doc);
    expect(tags.readFiles).toContain("/home/monky/code/app/src/old1.ts");
    expect(tags.readFiles).toContain("/home/monky/code/app/src/a.ts");
    expect(tags.modifiedFiles).toContain("/home/monky/code/app/src/old3.ts");
  });
  test("LLM failure → throw (wiring falls back to built-in)", async () => {
    const complete = jest.fn(async () => {
      throw new Error("boom");
    });
    await expect(
      buildHandover({
        preparation: basePrep(),
        branchEntries: [],
        ctx,
        pi,
        settings: settings(),
        complete,
        now: NOW,
      }),
    ).rejects.toThrow("boom");
  });
  test("empty LLM output → (none) sections, no throw", async () => {
    const doc = await buildHandover({
      preparation: basePrep(),
      branchEntries: [],
      ctx,
      pi,
      settings: settings(),
      complete: async () => "",
      now: NOW,
    });
    expect(doc).toMatch(/## 1 · Mission\n\(none\)/);
    expect(doc).toMatch(/## 8 · Gotchas & Constraints\n\(none\)/);
  });
  test("huge LLM output is size-guarded to the configured budget", async () => {
    const huge = [
      "[DONE]",
      ...Array.from(
        { length: 500 },
        (_, i) => `done item ${i} with enough words to burn real token budget`,
      ),
    ].join("\n");
    const doc = await buildHandover({
      preparation: basePrep(),
      branchEntries: [],
      ctx,
      pi,
      settings: settings({ sizeGuardTokens: 5_000 }),
      complete: async () => huge,
      now: NOW,
    });
    expect(estTokens(doc)).toBeLessThanOrEqual(5_000);
    expect(doc).toContain("… (condensed by size guard)");
  });
  test("MINOR-2: aborted signal (operator /stop) → no double fail post", async () => {
    const realFetch = globalThis.fetch;
    const fetchCalls: { url: string; body?: any }[] = [];
    globalThis.fetch = (async (url: any, init?: any) => {
      fetchCalls.push({ url: String(url), body: init?.body });
      return { ok: true, status: 200, json: async () => ({ id: "o" }) };
    }) as any;
    // a channel config so the fail notice WOULD be postable
    fs.mkdirSync(path.join(tmp, ".pi"), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, ".pi", "settings.json"),
      JSON.stringify({
        channels: [
          {
            id: "ch1",
            name: "Test",
            type: "discord",
            botToken: "tok1",
            ownerUserId: "uid",
          },
        ],
      }),
    );
    const posts = () =>
      fetchCalls.filter(
        (c) =>
          typeof c.body === "string" && c.body.includes("handover gen failed"),
      );
    const ac = new AbortController();
    ac.abort(); // operator /stop
    await expect(
      buildHandover({
        preparation: basePrep(),
        branchEntries: [],
        ctx,
        pi,
        settings: settings(),
        complete: async () => {
          throw new Error("Compaction cancelled");
        },
        signal: ac.signal,
        now: NOW,
      }),
    ).rejects.toThrow("Compaction cancelled");
    expect(posts()).toHaveLength(0); // pi's own cancel notice covers it
    // control: a non-aborted failure DOES post
    await expect(
      buildHandover({
        preparation: basePrep(),
        branchEntries: [],
        ctx,
        pi,
        settings: settings(),
        complete: async () => {
          throw new Error("boom");
        },
        signal: new AbortController().signal,
        now: NOW,
      }),
    ).rejects.toThrow("boom");
    expect(posts()).toHaveLength(1);
    globalThis.fetch = realFetch;
  });
  test("event signal is forwarded to the LLM call", async () => {
    const ac = new AbortController();
    let seen: AbortSignal | undefined;
    const complete = jest.fn(
      async (_s: string, _u: string, o?: { signal?: AbortSignal }) => {
        seen = o?.signal;
        return PROSE;
      },
    );
    await buildHandover({
      preparation: basePrep(),
      branchEntries: [],
      ctx,
      pi,
      settings: settings(),
      complete,
      signal: ac.signal,
      now: NOW,
    });
    expect(seen).toBeInstanceOf(AbortSignal);
    expect(seen).not.toBe(ac.signal); // combined with the timeout
    expect(seen?.aborted).toBe(false);
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

  test("disabled (PR1 default): built-in path, LLM not called", async () => {
    writeSettings({ channels: CHANNELS }); // no handoff block → enabled false
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
    expect(c.summary).toContain("## 1 · Mission");
    expect(c.summary).toContain("Ship the bridge.");
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

  test("LLM failure → undefined (built-in fallback) + sanitized channel notice", async () => {
    setHandoverCompleteForTest(async () => {
      throw new Error("HTTP 500 Internal Server Error");
    });
    const out = await handlers.session_before_compact(mkEvent("manual"), ctx);
    expect(out).toBeUndefined();
    expect(isHandoffInFlight()).toBe(false);
    const posts = channelPosts();
    expect(
      posts.some((p: string) =>
        p.includes("[!] handover gen failed - used standard compact"),
      ),
    ).toBe(true);
    // no raw stack in the channel
    expect(posts.join("\n")).not.toContain("500 Internal Server Error");
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

  test("/handover: owner triggers compact, disabled notice posted (PR1 default)", async () => {
    writeSettings({ channels: CHANNELS }); // handoff disabled
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
    // the command was not consumed: delivered to pi as plain text
    expect(sent).toHaveLength(1);
  });
});
