import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { matchCommand } from "./index";
import {
  estimateCost,
  fmtTokens,
  hasUsage,
  renderUsage,
  summarizeSessionFile,
  sumRunUsage,
} from "./usage";

// ─── Fixtures ──────────────────────────────────────────────────────────────
// Entry shapes match pi's session jsonl (assistant message with usage).

const asst = (id: string, usage: Record<string, number> | undefined): string =>
  JSON.stringify({
    type: "message",
    id,
    parentId: `p-${id}`,
    timestamp: "2026-09-10T08:00:00.000Z",
    message: { role: "assistant", content: [], usage },
  });

const user = (id: string): string =>
  JSON.stringify({
    type: "message",
    id,
    parentId: `u-${id}`,
    timestamp: "2026-09-10T08:00:00.000Z",
    message: { role: "user", content: [] },
  });

const delta = (id: string): string =>
  JSON.stringify({
    type: "message_update",
    id,
    message: {
      role: "assistant",
      usage: { input: 100, output: 100, cacheRead: 100, cacheWrite: 100 },
    },
  });

function writeSession(
  base: string,
  name: string,
  lines: string[],
  trailingPartial = false,
): string {
  fs.mkdirSync(base, { recursive: true });
  const p = path.join(base, name);
  let body = lines.join("\n") + (lines.length > 0 ? "\n" : "");
  if (trailingPartial)
    body += '{"type":"message","id":"torn","message":{"role":"ass';
  fs.writeFileSync(p, body);
  return p;
}

let tmp: string;
let oldHome: string | undefined;

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "usage-test-"));
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

const A = (n: number, o: number, cr = 0, cw = 0) => ({
  input: n,
  output: o,
  cacheRead: cr,
  cacheWrite: cw,
});

// ─── fmtTokens / estimateCost ──────────────────────────────────────────────

describe("fmtTokens", () => {
  test("units: raw below 1K, K integer, M one decimal", () => {
    expect(fmtTokens(0)).toBe("0");
    expect(fmtTokens(999)).toBe("999");
    expect(fmtTokens(61_000)).toBe("61K");
    expect(fmtTokens(999_500)).toBe("1000K");
    expect(fmtTokens(8_200_000)).toBe("8.2M");
    expect(fmtTokens(627_600_000)).toBe("627.6M");
    expect(fmtTokens(6_400_000)).toBe("6.4M");
    // B for >= 1e9: keeps the /context footer at 31 cols (1000.0M was 34,
    // PR #64 review P3)
    expect(fmtTokens(1_000_000_000)).toBe("1.0B");
    expect(fmtTokens(2_500_000_000)).toBe("2.5B");
    expect(fmtTokens(999_999_999)).toBe("1000.0M");
  });
});

describe("estimateCost (OpenRouter list rates, pi-token-cost.py)", () => {
  test("prompt 0.42/1M + completion 3.00/1M + cacheRead 0.085/1M", () => {
    const s = {
      turns: 1,
      input: 1_000_000,
      output: 1_000_000,
      cacheRead: 1_000_000,
      cacheWrite: 0,
    };
    expect(estimateCost(s)).toBeCloseTo(0.42 + 3.0 + 0.085, 10);
    // cacheWrite prices at the prompt rate (script assumption)
    s.cacheWrite = 1_000_000;
    expect(estimateCost(s)).toBeCloseTo(0.42 + 3.0 + 0.085 + 0.42, 10);
  });
});

// ─── summarizeSessionFile ──────────────────────────────────────────────────

describe("sumRunUsage (#40)", () => {
  test("sums assistant usage across the run's steps", () => {
    // agent_end carries every step of the run; each assistant reply has
    // its own usage
    const msgs = [
      { role: "user", content: [] },
      { role: "assistant", usage: A(1000, 100, 500) },
      { role: "toolResult", content: [] },
      { role: "assistant", usage: A(2000, 200, 700, 50) },
      { role: "assistant", usage: A(3000, 300, 900) },
    ];
    const s = sumRunUsage(msgs);
    expect(s.turns).toBe(3);
    expect(s.input).toBe(6000);
    expect(s.output).toBe(600);
    expect(s.cacheRead).toBe(2100);
    expect(s.cacheWrite).toBe(50);
    expect(hasUsage(s)).toBe(true);
  });

  test("ignores non-assistant roles, missing usage, and zero usage", () => {
    const s = sumRunUsage([
      { role: "user", usage: A(999, 999) }, // wrong role: skipped
      { role: "assistant" }, // no usage: skipped
      { role: "assistant", usage: A(0, 0, 0, 0) }, // zero: skipped
      { role: "assistant", usage: { input: 10, output: 5 } },
    ]);
    expect(s.turns).toBe(1);
    expect(s.input).toBe(10);
    expect(s.output).toBe(5);
  });

  test("partial usage objects (vLLM: no cacheWrite) and bad numbers tolerated", () => {
    const s = sumRunUsage([
      { role: "assistant", usage: { input: 100, output: 10 } },
      {
        role: "assistant",
        usage: { input: "x", output: 20, cacheRead: NaN, cacheWrite: -5 },
      },
    ]);
    expect(s.turns).toBe(2);
    expect(s.input).toBe(100); // "x" and NaN count as 0
    expect(s.output).toBe(30);
    expect(s.cacheRead).toBe(0);
    expect(s.cacheWrite).toBe(0); // negative counts as 0
  });

  test("empty run (failed before any step) -> zeros, hasUsage false", () => {
    const s = sumRunUsage([]);
    expect(s).toEqual({
      turns: 0,
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    });
    expect(hasUsage(s)).toBe(false);
  });
});

describe("summarizeSessionFile", () => {
  test("sums assistant usage; skips deltas, users, missing + zero usage", async () => {
    const f = writeSession(tmp, "s1.jsonl", [
      user("u1"),
      asst("a1", A(100, 10, 5, 1)),
      delta("a1"), // streaming delta with usage: must not double-count
      asst("a2", undefined), // no usage: skip
      asst("a3", A(0, 0, 0, 0)), // zero usage: skip
      asst("a4", A(200, 20, 7, 2)),
      asst("a1", A(999, 999)), // duplicate id: counted once
    ]);
    const s = await summarizeSessionFile(f);
    expect(s).toEqual({
      turns: 2,
      input: 300,
      output: 30,
      cacheRead: 12,
      cacheWrite: 3,
    });
  });

  test("tolerates a torn partial last line (live jsonl)", async () => {
    const f = writeSession(tmp, "s2.jsonl", [asst("a1", A(10, 2))], true);
    const s = await summarizeSessionFile(f);
    expect(s.turns).toBe(1);
    expect(s.input).toBe(10);
  });

  test("missing file yields zeros, not a throw", async () => {
    const s = await summarizeSessionFile(path.join(tmp, "nope.jsonl"));
    expect(s.turns).toBe(0);
  });
});

// ─── /usage output ─────────────────────────────────────────────────────────

describe("renderUsage", () => {
  test("session scope: exact line (no arg = session)", async () => {
    const sessions = setHome("h-session");
    const f = writeSession(
      path.join(sessions, "--cwd--"),
      "2026-09-10T08-00-00-000Z_00000000-0000-0000-0000-000000000001.jsonl",
      [
        user("u1"),
        asst("a1", A(1_500_000, 20_000)),
        asst("a2", A(3_000_000, 10_000)),
        asst("a3", A(3_700_000, 31_000)),
      ],
    );
    const text = await renderUsage(undefined, "/cwd", f);
    // in 8.2M @0.42 = 3.444 ; out 61K @3.00 = 0.183 ; est 3.627 -> 3.63
    expect(text).toBe(
      "[usage] session   2026-09-10        | 3 turns | in 8.2M | out 61K | cacheRead 0 | est $3.63",
    );
    expect(text).toBe(await renderUsage("session", "/cwd", f));
  });

  test("session scope reports cacheRead as-is when nonzero", async () => {
    const sessions = setHome("h-cr");
    const f = writeSession(
      path.join(sessions, "--cwd--"),
      "2026-09-09T00-00-00-000Z_00000000-0000-0000-0000-000000000002.jsonl",
      [asst("a1", A(1_000, 100, 4_000))],
    );
    const text = await renderUsage(undefined, "/cwd", f);
    // 1000*0.42 + 100*3.0 + 4000*0.085 = 1060 /1e6 -> $0.00
    expect(text).toBe(
      "[usage] session   2026-09-09        | 1 turns | in 1K | out 100 | cacheRead 4000 | est $0.00",
    );
  });

  test("lifetime scope: exact line across every session file (id dedup across files)", async () => {
    const sessions = setHome("h-lifetime");
    const d1 = path.join(sessions, "--a--");
    const d2 = path.join(sessions, "--b--");
    writeSession(
      d1,
      "2026-08-01T00-00-00-000Z_00000000-0000-0000-0000-000000000010.jsonl",
      [asst("t1", A(2_000, 100)), asst("shared", A(1_000, 50))],
    );
    writeSession(
      d2,
      "2026-08-15T00-00-00-000Z_00000000-0000-0000-0000-000000000011.jsonl",
      [asst("t2", A(2_000, 100)), asst("shared", A(1_000, 50))],
    );
    writeSession(
      d2,
      "2026-09-01T00-00-00-000Z_00000000-0000-0000-0000-000000000012.jsonl",
      [asst("t3", A(3_400, 400))],
    );
    const text = await renderUsage("all", "/cwd", null);
    // turns: t1..t3 + shared once = 4 ; in 8400 ; out 650
    // cost: 8400*0.42/1e6 + 650*3.00/1e6 = 0.005478 -> $0.01
    expect(text).toBe(
      "[usage] lifetime  2026-08-01..now   | 4 turns | in 8K | out 650 | est $0.01",
    );
  });

  test("lifetime scope shows cacheRead only when nonzero", async () => {
    const sessions = setHome("h-lt-cr");
    writeSession(
      path.join(sessions, "--cr--"),
      "2026-08-02T00-00-00-000Z_00000000-0000-0000-0000-000000000020.jsonl",
      [asst("c1", A(1_000, 100, 2_500))],
    );
    const text = await renderUsage("all", "/cwd", null);
    expect(text).toContain("| cacheRead 2500 |");
  });

  test("unknown arg -> usage error; missing session file handled", async () => {
    setHome("h-empty");
    expect(await renderUsage("bogus", "/cwd", null)).toBe(
      "[!] usage: /usage [all|session|last]",
    );
    expect(await renderUsage(undefined, "/cwd", null)).toBe(
      "[!] no session file found",
    );
  });

  test("empty lifetime store -> error line, not a throw", async () => {
    const emptyHome = path.join(tmp, "h-no-store");
    fs.mkdirSync(emptyHome, { recursive: true });
    process.env.HOME = emptyHome;
    expect(await renderUsage("all", "/cwd", null)).toBe(
      "[!] no session files found",
    );
  });
});

// ─── command matching ──────────────────────────────────────────────────────

describe("matchCommand", () => {
  test("/usage variants", () => {
    expect(matchCommand("/usage")).toEqual({ name: "usage", arg: undefined });
    expect(matchCommand("/usage all")).toEqual({ name: "usage", arg: "all" });
    expect(matchCommand("/usage session")).toEqual({
      name: "usage",
      arg: "session",
    });
    // a plain message mentioning /usage mid-sentence is not a command
    expect(matchCommand("did you try /usage all?")).toBeNull();
  });
});
