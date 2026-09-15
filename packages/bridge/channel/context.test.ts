import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  CONTEXT_MAX_N,
  type CtxScan,
  estTokens,
  fmtAge,
  formatContext,
  renderContext,
  scanContextFile,
} from "./context";
import { matchCommand } from "./index";

// ─── Fixtures ──────────────────────────────────────────────────────────────
// Entry shapes match pi's session jsonl (see a real session file: message
// entries carry assistant / toolResult roles, bridge inbounds are
// custom_message, plus non-conversation noise like compaction).

const pad = (ch: string, n: number) => ch.repeat(n);
const T0 = "2026-09-10T08:00:00.000Z";
const T = (offsetSec: number) =>
  new Date(Date.parse(T0) + offsetSec * 1000).toISOString();

const sessionEntry = (ts: string = T0): string =>
  JSON.stringify({
    type: "session",
    version: 3,
    id: "sess",
    timestamp: ts,
    cwd: "/cwd",
  });

const compaction = (id: string, ts: string): string =>
  JSON.stringify({
    type: "compaction",
    id,
    timestamp: ts,
    summary: pad("s", 500),
    tokensBefore: 999999,
  });

const cm = (id: string, content: string, ts: string): string =>
  JSON.stringify({
    type: "custom_message",
    customType: "channel-inbound",
    content,
    display: true,
    id,
    parentId: `p-${id}`,
    timestamp: ts,
  });

const asstThink = (id: string, chars: number, ts: string): string =>
  JSON.stringify({
    type: "message",
    id,
    parentId: `p-${id}`,
    timestamp: ts,
    message: {
      role: "assistant",
      content: [
        {
          type: "thinking",
          thinking: pad("x", chars),
          thinkingSignature: "reasoning",
        },
      ],
    },
  });

const asstText = (id: string, text: string, ts: string): string =>
  JSON.stringify({
    type: "message",
    id,
    parentId: `p-${id}`,
    timestamp: ts,
    message: { role: "assistant", content: [{ type: "text", text }] },
  });

const asstCall = (
  id: string,
  name: string,
  arguments_: Record<string, unknown>,
  ts: string,
): string =>
  JSON.stringify({
    type: "message",
    id,
    parentId: `p-${id}`,
    timestamp: ts,
    message: {
      role: "assistant",
      content: [
        { type: "toolCall", id: `c-${id}`, name, arguments: arguments_ },
      ],
    },
  });

const toolResult = (
  id: string,
  name: string,
  text: string,
  ts: string,
): string =>
  JSON.stringify({
    type: "message",
    id,
    parentId: `p-${id}`,
    timestamp: ts,
    message: {
      role: "toolResult",
      toolCallId: `c-${id}`,
      toolName: name,
      content: [{ type: "text", text }],
    },
  });

const toolResultImage = (
  id: string,
  name: string,
  dataLen: number,
  ts: string,
): string =>
  JSON.stringify({
    type: "message",
    id,
    parentId: `p-${id}`,
    timestamp: ts,
    message: {
      role: "toolResult",
      toolCallId: `c-${id}`,
      toolName: name,
      content: [{ type: "image", data: pad("A", dataLen) }],
    },
  });

function writeSession(base: string, name: string, lines: string[]): string {
  fs.mkdirSync(base, { recursive: true });
  const p = path.join(base, name);
  fs.writeFileSync(p, `${lines.join("\n")}\n`);
  return p;
}

let tmp: string;
let oldHome: string | undefined;

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "context-test-"));
  oldHome = process.env.HOME;
});

/** Point HOME at a fresh per-test agent home (empty session store). */
function setHome(name: string): string {
  const home = path.join(tmp, name);
  fs.mkdirSync(path.join(home, ".pi", "agent", "sessions"), {
    recursive: true,
  });
  process.env.HOME = home;
  return path.join(home, ".pi", "agent", "sessions");
}

afterAll(() => {
  if (oldHome === undefined) delete process.env.HOME;
  else process.env.HOME = oldHome;
  fs.rmSync(tmp, { recursive: true, force: true });
});

// ─── estTokens / fmtAge ────────────────────────────────────────────────────

describe("estTokens (char/4, rounds up)", () => {
  test("never undercounts; 4 chars = 1 token", () => {
    expect(estTokens(0)).toBe(0);
    expect(estTokens(1)).toBe(1);
    expect(estTokens(3)).toBe(1);
    expect(estTokens(4)).toBe(1);
    expect(estTokens(5)).toBe(2);
    expect(estTokens(40_000)).toBe(10_000);
  });
});

describe("fmtAge", () => {
  test("s/m/h+d, zero sub-units drop, clamped at negative and NaN", () => {
    expect(fmtAge(0)).toBe("0s");
    expect(fmtAge(59_999)).toBe("59s");
    expect(fmtAge(60_000)).toBe("1m");
    expect(fmtAge(3600_000)).toBe("1h");
    expect(fmtAge(3 * 3600_000 + 12 * 60_000)).toBe("3h12m");
    expect(fmtAge(23 * 3600_000 + 59 * 60_000)).toBe("23h59m");
    expect(fmtAge(86_400_000)).toBe("1d");
    expect(fmtAge(25 * 3600_000)).toBe("1d1h");
    expect(fmtAge(-5)).toBe("0s");
    expect(fmtAge(NaN)).toBe("0s");
  });
});

// ─── scanContextFile ───────────────────────────────────────────────────────

describe("scanContextFile", () => {
  test("one item per content block; sorted desc; baseTs = first message", async () => {
    const f = writeSession(tmp, "scan1.jsonl", [
      sessionEntry(),
      cm("u1", "hello world", T(0)), // 11 chars -> user/text
      asstThink("a1", 8000, T(180)), // assistant/thinking
      toolResult("t1", "bash", pad("b", 4000), T(300)), // tool/toolResult
      asstCall("a2", "bash", { command: "ls" }, T(360)), // assistant/toolCall
      toolResult("t2", "read", pad("r", 12000), T(600)), // tool/toolResult
    ]);
    const s = await scanContextFile(f);
    expect(s.baseTs).toBe(Date.parse(T0));
    const callChars = 4 + JSON.stringify({ command: "ls" }).length;
    expect(s.items.map((i) => [i.role, i.type, i.chars])).toEqual([
      ["tool", "toolResult", 12000 + 4], // text + toolName "read"
      ["assistant", "thinking", 8000],
      ["tool", "toolResult", 4000 + 4], // text + toolName "bash"
      ["assistant", "toolCall", callChars], // name "bash" + serialized args
      ["user", "text", 11],
    ]);
    expect(s.items[0].tool).toBe("read");
    expect(s.items[3].tool).toBe("bash");
    expect(s.items[4].tool).toBeUndefined();
    expect(s.totalChars).toBe(12004 + 8000 + 4004 + callChars + 11);
  });

  test("dedupes entries by id (same guard as /usage)", async () => {
    const line = toolResult("t1", "bash", pad("b", 1000), T(60));
    const f = writeSession(tmp, "scan-dup.jsonl", [
      sessionEntry(),
      line,
      line, // re-appended entry: counted once
      toolResult("t2", "read", pad("r", 2000), T(120)),
    ]);
    const s = await scanContextFile(f);
    expect(s.items).toHaveLength(2);
    expect(s.totalChars).toBe(2004 + 1004);
  });

  test("counts image data chars; ignores non-conversation entries", async () => {
    const f = writeSession(tmp, "scan-img.jsonl", [
      sessionEntry(),
      compaction("c1", T(10)),
      JSON.stringify({ type: "model_change", id: "m1", timestamp: T(11) }),
      toolResultImage("t1", "read", 16_000, T(120)),
      asstText("a1", "done", T(180)),
    ]);
    const s = await scanContextFile(f);
    expect(s.items.map((i) => [i.type, i.chars])).toEqual([
      ["toolResult", 16_000 + 4],
      ["text", 4],
    ]);
  });

  test("tolerates a torn last line; skips user role message content strings", async () => {
    const f = path.join(tmp, "scan-torn.jsonl");
    fs.writeFileSync(
      f,
      [
        sessionEntry(),
        asstThink("a1", 800, T(60)),
        '{"type":"message","id":"torn","message":{"role":"ass',
      ].join("\n"),
    );
    const s = await scanContextFile(f);
    expect(s.items).toHaveLength(1);
    expect(s.totalChars).toBe(800);
  });

  test("unreadable path (a directory) throws", async () => {
    const d = path.join(tmp, "scan-dir");
    fs.mkdirSync(d, { recursive: true });
    await expect(scanContextFile(d)).rejects.toThrow();
  });
});

// ─── formatContext ─────────────────────────────────────────────────────────

/** The 5-item fixture from the scan test, as a scan result. */
async function fiveItemScan(): Promise<ReturnType<typeof scanContextFile>> {
  const f = writeSession(tmp, "fmt1.jsonl", [
    sessionEntry(),
    cm("u1", "hello world", T(0)),
    asstThink("a1", 8000, T(180)),
    toolResult("t1", "bash", pad("b", 4000), T(300)),
    asstCall("a2", "bash", { command: "ls" }, T(360)),
    toolResult("t2", "read", pad("r", 12000), T(600)),
  ]);
  return scanContextFile(f);
}

describe("formatContext", () => {
  test("exact frame, deterministic now (n=5 shows everything)", async () => {
    const s = await fiveItemScan();
    // now = 1h after session start: header age 1h, item ages relative
    const now = Date.parse(T0) + 3600_000;
    expect(formatContext(s, 5, now)).toBe(
      [
        "[context] est tokens (char/4)",
        "┌ top 5 of 5 items · total 6K",
        "│ session 2026-09-10 · age 1h",
        "│  1 tool      toolResult    3K 10m",
        "│  2 assistant thinking      2K 3m",
        "│  3 tool      toolResult    1K 5m",
        "│  4 assistant toolCall       5 6m",
        "│  5 user      text           3 0s",
        "├ totals",
        "│ user          3  (1)",
        "│ assistant    2K  (2)",
        "│ tool         4K  (2)",
        "└ biggest: tool toolResult    3K (read)",
      ].join("\n"),
    );
  });

  test("every line stays within the 40-col mobile budget", async () => {
    const s = await fiveItemScan();
    const now = Date.parse(T0) + 3600_000;
    const text = formatContext(s, CONTEXT_MAX_N, now);
    for (const line of text.split("\n"))
      expect(line.length).toBeLessThanOrEqual(40);
  });

  test("biggest line worst case: assistant toolCall + tool name stays <= 40", () => {
    const s: CtxScan = {
      items: [
        {
          role: "assistant",
          type: "toolCall",
          chars: 92000,
          ts: 0,
          tool: "bash",
        },
      ],
      totalChars: 92000,
      baseTs: 0,
    };
    const text = formatContext(s, 10, Date.parse(T0));
    const biggest = text.split("\n").pop()!;
    expect(biggest).toBe("└ biggest: asst toolCall     23K (bash)");
    expect(biggest.length).toBeLessThanOrEqual(40);
  });

  test("empty scan: (no sized items), no biggest line", () => {
    expect(
      formatContext(
        { items: [], totalChars: 0, baseTs: 0 },
        10,
        Date.parse(T0),
      ),
    ).toBe(
      [
        "[context] est tokens (char/4)",
        "┌ top 0 of 0 items · total 0",
        "│ session unknown · age ?",
        "│ (no sized items)",
        "├ totals",
        "│ user          0  (0)",
        "│ assistant     0  (0)",
        "│ tool          0  (0)",
        "└ no entries",
      ].join("\n"),
    );
  });
});

// ─── renderContext ─────────────────────────────────────────────────────────

describe("renderContext", () => {
  test("15 items: default top-10 order + /context 20 shows all 16", async () => {
    const lines = [sessionEntry(), cm("u0", "start", T(0))];
    for (let i = 1; i <= 15; i++)
      lines.push(toolResult(`t${i}`, "bash", pad("x", i * 10_000), T(i * 60)));
    const f = writeSession(tmp, "topn.jsonl", lines);

    const def = await renderContext(undefined, "/cwd", f);
    // sizes are i*10_000 + 4 ("bash"); top-10 = i 15..6, in order
    expect(def).toContain("┌ top 10 of 16 items · total 300K");
    expect(def).toContain("│  1 tool      toolResult   38K 15m");
    expect(def).toContain("│ 10 tool      toolResult   15K 6m");
    expect(def).not.toContain("│ 11 ");

    const wide = await renderContext("20", "/cwd", f);
    // asked for 20, only 16 exist: shows 16 (incl. the user item, rank 16)
    expect(wide).toContain("┌ top 16 of 16 items · total 300K");
    expect(wide).toContain("│ 15 tool      toolResult    3K 1m");
  });

  test("count arg validation: empty/1 ok-ish, 0, 41, abc, -5 rejected", async () => {
    const f = writeSession(tmp, "args.jsonl", [sessionEntry()]);
    const usage = `[!] usage: /context [1-${CONTEXT_MAX_N}]`;
    expect(await renderContext("abc", "/cwd", f)).toBe(usage);
    expect(await renderContext("0", "/cwd", f)).toBe(usage);
    expect(await renderContext(String(CONTEXT_MAX_N + 1), "/cwd", f)).toBe(
      usage,
    );
    expect(await renderContext("-5", "/cwd", f)).toBe(usage);
    expect(await renderContext("", "/cwd", f)).not.toBe(usage);
    expect(await renderContext(" 20 ", "/cwd", f)).not.toBe(usage);
    expect(await renderContext(undefined, "/cwd", f)).not.toBe(usage);
  });

  test("no active session -> one [!] line, no stack", async () => {
    setHome("h-none");
    expect(await renderContext(undefined, "/cwd", null)).toBe(
      "[!] no session file found",
    );
  });

  test("unreadable file (directory) -> one [!] line, no stack", async () => {
    const d = path.join(tmp, "h-unreadable-dir");
    fs.mkdirSync(d, { recursive: true });
    expect(await renderContext(undefined, "/cwd", d)).toBe(
      "[!] session file unreadable",
    );
  });

  test("fallback: sessionFile null -> findSessionFile(cwd)", async () => {
    const sessions = setHome("h-fallback");
    const f = writeSession(
      path.join(sessions, "--cwd--"),
      "2026-09-10T08-00-00-000Z_00000000-0000-0000-0000-000000000001.jsonl",
      [
        sessionEntry(),
        cm("u1", "go", T(0)), // sets baseTs so the tool result ages 1m
        toolResult("t1", "bash", pad("b", 8000), T(60)),
      ],
    );
    const text = await renderContext(undefined, "/cwd", null);
    expect(text).toContain("┌ top 2 of 2 items · total 2K");
    expect(text).toContain("│  1 tool      toolResult    2K 1m");
    // sanity: it really read the discovered file
    expect(f).toContain("h-fallback");
  });
});

// ─── command matching ──────────────────────────────────────────────────────

describe("matchCommand", () => {
  test("/context variants", () => {
    expect(matchCommand("/context")).toEqual({
      name: "context",
      arg: undefined,
    });
    expect(matchCommand("/context 20")).toEqual({ name: "context", arg: "20" });
    expect(matchCommand("/CONTEXT")).toEqual({
      // case preserved here; the runChannelCommand switch lowercases
      name: "CONTEXT",
      arg: undefined,
    });
    // a plain message mentioning /context mid-sentence is not a command
    expect(matchCommand("did you try /context 20?")).toBeNull();
  });
});
