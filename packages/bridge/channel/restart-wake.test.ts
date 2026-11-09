import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { setLivenessHttp } from "./liveness-event";
import {
  buildWakePayload,
  claimWake,
  cleanStopPath,
  elapsedSeconds,
  elapsedStr,
  MAX_INFLIGHT,
  markWakePosted,
  type RunRecord,
  readCleanStop,
  readRunRecords,
  runRestartWake,
  selectInflight,
  WAKE_AUDIT_WINDOW_MS,
  WAKE_DEDUP_POSTED_WINDOW_MS,
  wakeAuditEvaluate,
  wakeAuditInit,
  wakeAuditOutcome,
  wakeAuditStart,
  writeCleanStop,
} from "./restart-wake";
import {
  isStartupMessageSuppressedForThisStart,
  resetStartupMessageSuppressionForTests,
} from "./startup-suppress";

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "piscord-wake-"));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function writeRuns(runDir: string, recs: unknown[]): void {
  fs.mkdirSync(runDir, { recursive: true });
  recs.forEach((r, i) => {
    fs.writeFileSync(
      path.join(runDir, `pi-bg-rec-${String(i).padStart(2, "0")}.json`),
      JSON.stringify(r),
    );
  });
}

const T0 = Date.parse("2026-10-01T12:00:00Z"); // fixed "now" for determinism

function rec(over: Partial<RunRecord>): RunRecord {
  return {
    run: "20261001-110000-1",
    profile: "worker",
    project: null,
    cwd: "/home/monky/projects/jarate",
    started: "2026-10-01T11:37:00Z",
    delivery: "webhook",
    state: "running",
    ...over,
  };
}

// fake liveness event POST (hall-monitor#757 leg B): a queue of
// (status|Error) results per call; records the url, the X-Agent-Key
// header and the body. arm/disarm swap the injected HTTP leg.
function fakeLiveness(results: Array<number | Error>): {
  calls: Array<{
    url: string;
    headers: Record<string, string>;
    body: string | undefined;
  }>;
  arm: () => void;
  disarm: () => void;
} {
  const calls: Array<{
    url: string;
    headers: Record<string, string>;
    body: string | undefined;
  }> = [];
  const impl = async (
    url: string,
    init: RequestInit,
  ): Promise<{ ok: boolean; status: number }> => {
    const r = results.shift();
    calls.push({
      url: String(url),
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: typeof init?.body === "string" ? init.body : undefined,
    });
    if (r instanceof Error) throw r;
    const status = r ?? 200;
    return { ok: status >= 200 && status < 300, status };
  };
  return {
    calls,
    arm: () => setLivenessHttp(impl as never),
    disarm: () => setLivenessHttp(null),
  };
}

// the bridge's existing hall-monitor setting (the event target).
const LIVENESS_ENV = {
  url: "http://hm.example/api",
  key: "test-agent-key",
  agent: "testagent",
};

function armLivenessEnv(): void {
  process.env.JARATE_INBOX_URL = LIVENESS_ENV.url;
  process.env.JARATE_INBOX_KEY = LIVENESS_ENV.key;
  process.env.JARATE_INBOX_AGENT = LIVENESS_ENV.agent;
  // pin the key-file seam to a missing file: the env key is the source,
  // never a real on-box key file
  process.env.JARATE_INBOX_KEY_FILE = "/nonexistent/jarate-test-agent-key";
}

function disarmLivenessEnv(): void {
  delete process.env.JARATE_INBOX_URL;
  delete process.env.JARATE_INBOX_KEY;
  delete process.env.JARATE_INBOX_AGENT;
  delete process.env.JARATE_INBOX_KEY_FILE;
}

// ─── wake line builder (2026-10-31: plain italic, no embeds) ──────────

describe("buildWakePayload (issue #111, 2026-10-31 plain-italic shape)", () => {
  test("clean + zero inflight = exactly the spec planned line", () => {
    const p = buildWakePayload({ clean: true, runs: [] });
    expect(p.content).toBe("*restart-wake \u00b7 planned*");
  });

  test("unclean + zero inflight = exactly the spec unplanned line", () => {
    const p = buildWakePayload({ clean: false, runs: [] });
    expect(p.content).toBe("*restart-wake \u00b7 unplanned*");
  });

  test("terminal states are not inflight (done/killed ignored)", () => {
    const runs = [
      rec({ run: "a", state: "done", finished: "2026-10-01T12:00:00Z" }),
      rec({ run: "b", state: "killed", reason: "pi-bg-kill" }),
    ];
    const p = buildWakePayload({ clean: true, runs });
    expect(p.content).toBe("*restart-wake \u00b7 planned*");
  });

  test("inflight suffix: count of state=running records on the same line", () => {
    const runs = [
      rec({
        run: "20261001-103700-9",
        profile: "reviewer",
        started: "2026-10-01T11:37:00Z",
      }),
      rec({
        run: "20261001-115900-10",
        profile: "worker",
        started: "2026-10-01T11:59:30Z",
        state: "running",
      }),
      rec({ run: "done-run", state: "done" }),
    ];
    const p = buildWakePayload({ clean: false, runs });
    expect(p.content).toBe(
      "*restart-wake \u00b7 unplanned \u00b7 in-flight 2*",
    );
  });

  test("many inflight: the count is the FULL total, not the capped list", () => {
    const runs = Array.from({ length: MAX_INFLIGHT + 2 }, (_, i) =>
      rec({ run: `20261001-11${String(i).padStart(2, "0")}-0` }),
    );
    const p = buildWakePayload({ clean: true, runs });
    expect(p.content).toBe(
      `*restart-wake \u00b7 planned \u00b7 in-flight ${MAX_INFLIGHT + 2}*`,
    );
  });

  test("no width budget: long profile does not change the count line", () => {
    const profile = "x".repeat(60);
    const p = buildWakePayload({
      clean: true,
      runs: [rec({ run: "20261001-110000-1", state: "running", profile })],
    });
    expect(p.content).toBe("*restart-wake \u00b7 planned \u00b7 in-flight 1*");
  });

  test("missing profile degrades without crashing (count still 1)", () => {
    const p = buildWakePayload({
      clean: true,
      runs: [{ run: "20261001-110000-1", state: "running" } as RunRecord],
    });
    expect(p.content).toBe("*restart-wake \u00b7 planned \u00b7 in-flight 1*");
  });
});

describe("selectInflight / elapsed", () => {
  test("filters state=running only", () => {
    const { list, more } = selectInflight([
      rec({ run: "a", state: "running" }),
      rec({ run: "b", state: "done" }),
      rec({ run: "c", state: "running" }),
      { run: "d" } as RunRecord, // no state
    ]);
    expect(list.map((r) => r.run)).toEqual(["a", "c"]);
    expect(more).toBe(0);
  });

  test("elapsedSeconds: unparseable or future start = 0", () => {
    expect(elapsedSeconds("2026-10-01T11:59:30Z", T0)).toBe(30);
    expect(elapsedSeconds(undefined, T0)).toBe(0);
    expect(elapsedSeconds("garbage", T0)).toBe(0);
    expect(elapsedSeconds("2026-10-01T12:05:00Z", T0)).toBe(0);
  });

  test("elapsedStr shapes (same as /jobs)", () => {
    expect(elapsedStr(9)).toBe("9s");
    expect(elapsedStr(1500)).toBe("25m");
    expect(elapsedStr(3 * 3600 + 12 * 60)).toBe("3h12m");
    expect(elapsedStr(2 * 86400)).toBe("2d");
  });
});

// ─── run-record reading ──────────────────────────────────────────────────

describe("readRunRecords", () => {
  test("missing dir = [] (never throws)", () => {
    expect(readRunRecords(path.join(tmp, "nope"))).toEqual([]);
  });

  test("reads *.json, skips non-json and corrupt records", () => {
    const d = path.join(tmp, "runs");
    writeRuns(d, [rec({ run: "ok" })]);
    fs.writeFileSync(path.join(d, "notes.txt"), "not json");
    fs.writeFileSync(path.join(d, "pi-bg-bad-00.json"), "{not json");
    fs.writeFileSync(
      path.join(d, "pi-bg-norun-00.json"),
      JSON.stringify({ state: "running" }),
    );
    const out = readRunRecords(d);
    expect(out).toHaveLength(1);
    expect(out[0].run).toBe("ok");
  });
});

// ─── clean vs unclean detection ──────────────────────────────────────────

describe("clean-stop marker (issue #111)", () => {
  test("absent marker = unclean", () => {
    expect(readCleanStop(tmp, T0)).toBe("unclean");
  });

  test("fresh marker = planned, and the marker is consumed", () => {
    writeCleanStop(tmp, new Date(T0 - 60_000));
    expect(cleanStopPath(tmp)).toBe(path.join(tmp, "clean-stop"));
    expect(readCleanStop(tmp, T0)).toBe("planned");
    expect(fs.existsSync(cleanStopPath(tmp))).toBe(false); // consumed
  });

  test("stale marker (> 24h) = unclean", () => {
    writeCleanStop(tmp, new Date(T0 - 25 * 3_600_000));
    expect(readCleanStop(tmp, T0)).toBe("unclean");
  });

  test("unparseable marker = unclean", () => {
    fs.mkdirSync(tmp, { recursive: true });
    fs.writeFileSync(cleanStopPath(tmp), "not-a-timestamp");
    expect(readCleanStop(tmp, T0)).toBe("unclean");
  });

  test("future marker (clock skew) = unclean", () => {
    writeCleanStop(tmp, new Date(T0 + 3_600_000));
    expect(readCleanStop(tmp, T0)).toBe("unclean");
  });

  test("writeCleanStop survives a missing state dir (creates it)", () => {
    const d = path.join(tmp, "deep", "nested");
    expect(writeCleanStop(d, new Date(T0))).toBe(true);
    expect(readCleanStop(d, T0)).toBe("planned");
  });
});

// ─── startup dedup (#322 G3: <epoch-ms> <class> <posted:0|1>) ─────────

describe("claimWake dedup (#322 G3)", () => {
  test("first claim wins; an UNPOSTED claim never suppresses (crash between claim and post)", () => {
    expect(claimWake(tmp, T0)).toEqual({ claimed: true, prev: null });
    // the prior claim never posted: the next start 10s later takes over
    expect(claimWake(tmp, T0 + 10_000).claimed).toBe(true);
  });

  test("a POSTED claim in-window (<= 5m) suppresses, older than the window posts", () => {
    expect(claimWake(tmp, T0)).toEqual({ claimed: true, prev: null });
    expect(markWakePosted(tmp, T0, "planned")).toBe(true);
    const suppressed = claimWake(tmp, T0 + 4 * 60_000);
    expect(suppressed.claimed).toBe(false);
    expect(suppressed.prev).toEqual({ t: T0, klass: "planned", posted: true });
    // past the window: take over
    expect(
      claimWake(tmp, T0 + WAKE_DEDUP_POSTED_WINDOW_MS + 10_000).claimed,
    ).toBe(true);
  });

  test("posted claim exactly at the window edge is taken over", () => {
    claimWake(tmp, T0);
    markWakePosted(tmp, T0, "planned");
    expect(claimWake(tmp, T0 + WAKE_DEDUP_POSTED_WINDOW_MS).claimed).toBe(true);
  });

  test("unreadable claim content = assume held (no post)", () => {
    fs.mkdirSync(tmp, { recursive: true });
    fs.writeFileSync(
      path.join(tmp, "restart-wake.lock"),
      "\u0000garbage\u0000",
    );
    const r = claimWake(tmp, T0);
    expect(r.claimed).toBe(false);
    expect(r.prev).not.toBeNull();
    // and the foreign claim file is left in place (not torn down)
    expect(fs.existsSync(path.join(tmp, "restart-wake.lock"))).toBe(true);
  });

  test("class-aware: a different restart class always takes over (crash signal never suppressed)", () => {
    claimWake(tmp, T0, "planned");
    markWakePosted(tmp, T0, "planned");
    expect(claimWake(tmp, T0 + 10_000, "unclean").claimed).toBe(true);
  });

  test("#306 21.7min double-post signature no longer suppresses: the 5m window is sized to the crash-flap class (a suppressed start is at most a duplicate card, G1 logs it)", () => {
    claimWake(tmp, T0, "planned");
    markWakePosted(tmp, T0, "planned");
    expect(claimWake(tmp, T0 + 21 * 60_000 + 43_000, "planned").claimed).toBe(
      true,
    );
  });

  test("legacy 2-field and 1-field claims are posted=0: they never suppress", () => {
    fs.mkdirSync(tmp, { recursive: true });
    fs.writeFileSync(path.join(tmp, "restart-wake.lock"), `${T0} planned\n`);
    expect(claimWake(tmp, T0 + 10_000, "planned").claimed).toBe(true);
    // the original 1-field legacy format (no class)
    fs.writeFileSync(path.join(tmp, "restart-wake.lock"), `${T0}\n`);
    expect(claimWake(tmp, T0 + 10_000, "unclean").claimed).toBe(true);
  });
});

describe("markWakePosted (#322 G3)", () => {
  test("sets posted=1 on the matching claim (atomic)", () => {
    claimWake(tmp, T0, "planned");
    expect(markWakePosted(tmp, T0, "planned")).toBe(true);
    expect(fs.readFileSync(path.join(tmp, "restart-wake.lock"), "utf8")).toBe(
      `${T0} planned 1\n`,
    );
  });

  test("never flips a taken-over file (different epoch)", () => {
    claimWake(tmp, T0, "planned");
    expect(markWakePosted(tmp, T0 + 5_000, "planned")).toBe(false);
  });

  test("missing claim file = false (never throws)", () => {
    expect(markWakePosted(tmp, T0, "planned")).toBe(false);
  });

  test("a legacy 2-field own claim (epoch+class match) gets the posted flag", () => {
    fs.mkdirSync(tmp, { recursive: true });
    fs.writeFileSync(path.join(tmp, "restart-wake.lock"), `${T0} planned\n`);
    expect(markWakePosted(tmp, T0, "planned")).toBe(true);
    expect(fs.readFileSync(path.join(tmp, "restart-wake.lock"), "utf8")).toBe(
      `${T0} planned 1\n`,
    );
  });
});

// ─── orchestrator ────────────────────────────────────────────────────────

describe("runRestartWake (issue #111; hall-monitor#757 leg B)", () => {
  const runDir = () => path.join(tmp, "runs");
  const stateDir = () => path.join(tmp, ".tmp");
  let log: string[];

  beforeEach(() => {
    // #328: an unclean start sets the once-per-process startup-suppress
    // flag; reset between tests (shared module registry)
    resetStartupMessageSuppressionForTests();
    log = [];
    armLivenessEnv();
  });

  afterEach(() => {
    disarmLivenessEnv();
  });

  test("reason != startup: no event, marker NOT consumed (hot reload)", async () => {
    writeCleanStop(stateDir(), new Date(T0 - 60_000));
    const fl = fakeLiveness([200]);
    fl.arm();
    const r = await runRestartWake({
      reason: "reload",
      stateDir: stateDir(),
      runDir: runDir(),
      now: T0,
      log: (l) => log.push(l),
    });
    fl.disarm();
    expect(r).toEqual({ posted: false, reason: "not-startup" });
    expect(fs.existsSync(cleanStopPath(stateDir()))).toBe(true);
    expect(fl.calls).toHaveLength(0);
  });

  test("no liveness config (dev run): one local log line, no event", async () => {
    disarmLivenessEnv();
    const fl = fakeLiveness([200]);
    fl.arm();
    const r = await runRestartWake({
      reason: "startup",
      stateDir: stateDir(),
      runDir: runDir(),
      now: T0,
      log: (l) => log.push(l),
    });
    fl.disarm();
    expect(r).toEqual({ posted: false, reason: "no-channel" });
    expect(fl.calls).toHaveLength(0);
    expect(log.join("\n")).toContain("[wake] no-channel");
  });

  test("full wake: unclean restart, 1 inflight = ONE back_online event, agent key + detail", async () => {
    // #328: the planned class no longer posts a card (the startup
    // message is the post), so the event path is exercised here with
    // the unclean class (no marker).
    writeRuns(runDir(), [rec({ run: "20261001-113000-7" })]);
    const fl = fakeLiveness([200]);
    fl.arm();
    const r = await runRestartWake({
      reason: "startup",
      stateDir: stateDir(),
      runDir: runDir(),
      now: T0,
      log: (l) => log.push(l),
    });
    fl.disarm();
    expect(r.posted).toBe(true);
    expect(r.reason).toBe("posted");
    expect(r.restartClass).toBe("unclean");
    expect(fl.calls).toHaveLength(1);
    expect(fl.calls[0].url).toBe(`${LIVENESS_ENV.url}/fleet/liveness/event`);
    expect(fl.calls[0].headers["X-Agent-Key"]).toBe(LIVENESS_ENV.key);
    const posted = JSON.parse(fl.calls[0].body ?? "{}");
    expect(posted.agent).toBe(LIVENESS_ENV.agent);
    expect(posted.event).toBe("back_online");
    // plain (the italic channel markup is the webhook leg's concern)
    expect(posted.detail).toBe(
      "restart-wake \u00b7 unplanned \u00b7 in-flight 1",
    );
    // the result message still carries the pre-leg-B shape (logs/audit)
    expect(r.message).toBe(
      "*restart-wake \u00b7 unplanned \u00b7 in-flight 1*",
    );
  });

  test("unclean, zero inflight = the plain unplanned line (no suffix)", async () => {
    const fl = fakeLiveness([200]);
    fl.arm();
    const r = await runRestartWake({
      reason: "startup",
      stateDir: stateDir(),
      runDir: runDir(),
      now: T0,
      log: (l) => log.push(l),
    });
    fl.disarm();
    expect(r.posted).toBe(true);
    expect(r.restartClass).toBe("unclean");
    const posted = JSON.parse(fl.calls[0].body ?? "{}");
    expect(posted.detail).toBe("restart-wake \u00b7 unplanned");
  });

  test("dedup: second startup within the 5m window of a posted claim does not post", async () => {
    const fl = fakeLiveness([200, 200]);
    fl.arm();
    const a = await runRestartWake({
      reason: "startup",
      stateDir: stateDir(),
      runDir: runDir(),
      now: T0,
      log: (l) => log.push(l),
    });
    const b = await runRestartWake({
      reason: "startup",
      stateDir: stateDir(),
      runDir: runDir(),
      now: T0 + 30_000,
      log: (l) => log.push(l),
    });
    fl.disarm();
    expect(a.posted).toBe(true);
    expect(b).toMatchObject({ posted: false, reason: "dedup" });
    expect(fl.calls).toHaveLength(1);
  });

  test("post failure: reported, never throws (log-only)", async () => {
    const fl = fakeLiveness([500]);
    fl.arm();
    const r = await runRestartWake({
      reason: "startup",
      stateDir: stateDir(),
      runDir: runDir(),
      now: T0,
      log: (l) => log.push(l),
    });
    fl.disarm();
    expect(r).toMatchObject({ posted: false, reason: "post-failed" });
    expect(log.join(" ")).toContain("post-failed");
  });

  test("G3: a failed post leaves the claim unposted — the next start in-window still posts", async () => {
    const fl = fakeLiveness([500, 200]);
    fl.arm();
    const a = await runRestartWake({
      reason: "startup",
      stateDir: stateDir(),
      runDir: runDir(),
      now: T0,
      log: (l) => log.push(l),
    });
    const b = await runRestartWake({
      reason: "startup",
      stateDir: stateDir(),
      runDir: runDir(),
      now: T0 + 30_000,
      log: (l) => log.push(l),
    });
    fl.disarm();
    expect(a).toMatchObject({ posted: false, reason: "post-failed" });
    expect(b.posted).toBe(true);
    expect(fl.calls).toHaveLength(2); // the signal cannot go dark twice in a row
  });

  test("G3: a legacy 2-field claim does not suppress", async () => {
    fs.mkdirSync(stateDir(), { recursive: true });
    fs.writeFileSync(
      path.join(stateDir(), "restart-wake.lock"),
      `${T0} planned\n`,
    );
    const fl = fakeLiveness([200]);
    fl.arm();
    const r = await runRestartWake({
      reason: "startup",
      stateDir: stateDir(),
      runDir: runDir(),
      now: T0 + 10_000,
      log: (l) => log.push(l),
    });
    fl.disarm();
    expect(r.posted).toBe(true);
    expect(fl.calls).toHaveLength(1);
  });

  test("G3: posted claim <= 5m old suppresses; posted claim > 5m old posts", async () => {
    const fl = fakeLiveness([200, 200]);
    fl.arm();
    const base = {
      stateDir: stateDir(),
      runDir: runDir(),
      log: (l: string) => log.push(l),
    };
    await runRestartWake({ ...base, reason: "startup", now: T0 });
    // 4m after the post: in-window, same class, posted -> suppressed
    const b = await runRestartWake({
      ...base,
      reason: "startup",
      now: T0 + 4 * 60_000,
    });
    expect(b).toMatchObject({ posted: false, reason: "dedup" });
    // 6m after the post: the window is over -> posts
    const c = await runRestartWake({
      ...base,
      reason: "startup",
      now: T0 + 6 * 60_000,
    });
    fl.disarm();
    expect(c.posted).toBe(true);
    expect(fl.calls).toHaveLength(2);
  });
});

// ─── #322 G1: every terminal reason logs one line ────────────────────

describe("runRestartWake G1 (issue #322: no silent terminal state)", () => {
  const runDir = () => path.join(tmp, "runs");
  const stateDir = () => path.join(tmp, ".tmp");
  let log: string[];

  beforeEach(() => {
    resetStartupMessageSuppressionForTests();
    log = [];
    armLivenessEnv();
  });

  afterEach(() => {
    disarmLivenessEnv();
    resetStartupMessageSuppressionForTests();
  });

  const run = (over: Partial<Parameters<typeof runRestartWake>[0]>) =>
    runRestartWake({
      reason: "startup",
      stateDir: stateDir(),
      runDir: runDir(),
      now: T0,
      log: (l) => log.push(l),
      ...over,
    } as Parameters<typeof runRestartWake>[0]);

  test("not-startup logs its reason", async () => {
    const fl = fakeLiveness([200]);
    fl.arm();
    await run({ reason: "reload" });
    fl.disarm();
    expect(log.join("\n")).toContain("[wake] not-startup: reason=reload");
  });

  test("no-channel logs its reason", async () => {
    disarmLivenessEnv();
    const fl = fakeLiveness([200]);
    fl.arm();
    await run({});
    fl.disarm();
    expect(log.join("\n")).toContain("[wake] no-channel");
  });

  test("posted logs its reason", async () => {
    const fl = fakeLiveness([200]);
    fl.arm();
    await run({});
    fl.disarm();
    expect(log.join("\n")).toContain("[wake] posted: class=unclean");
  });

  test("post-failed logs its reason", async () => {
    const fl = fakeLiveness([500]);
    fl.arm();
    await run({});
    fl.disarm();
    expect(log.join("\n")).toContain("[wake] post-failed");
  });

  test("dedup logs its G1 line: age and same-class value are correct", async () => {
    const fl = fakeLiveness([200, 200]);
    fl.arm();
    await run({});
    log = [];
    const b = await run({ now: T0 + 30_000 });
    fl.disarm();
    expect(b).toMatchObject({ posted: false, reason: "dedup" });
    expect(log).toEqual(["[wake] dedup suppressed: age=30000 same-class=true"]);
  });

  // terminal tokens (incl. the #328 suppressed-planned branch); every startup
  // must end in exactly one
  const terminalTokens =
    /not-startup|no-channel|dedup suppressed|posted:|post-failed|suppressed-planned/;

  test("every startup ends in exactly one terminal line (grep-able)", async () => {
    type Case = {
      label: string;
      over: Record<string, unknown>;
      noLiveness?: boolean;
      fail?: boolean;
      cleanStop?: boolean;
    };
    const cases: Case[] = [
      { label: "not-startup", over: { reason: "reload" } },
      { label: "no-channel", over: {}, noLiveness: true },
      { label: "posted", over: {} },
      { label: "post-failed", over: {}, fail: true },
      {
        label: "suppressed-planned",
        over: {},
        cleanStop: true,
      }, // #328: a fresh marker = planned
    ];
    for (const c of cases) {
      const sd = fs.mkdtempSync(path.join(os.tmpdir(), "piscord-g1-"));
      try {
        if (c.cleanStop) writeCleanStop(sd, new Date(T0 - 60_000));
        if (c.noLiveness) disarmLivenessEnv();
        else armLivenessEnv();
        const fl = fakeLiveness(c.fail ? [500] : [200]);
        fl.arm();
        log = [];
        await runRestartWake({
          reason: "startup",
          stateDir: sd,
          runDir: runDir(),
          now: T0,
          log: (l) => log.push(l),
          ...c.over,
        });
        fl.disarm();
        const hits = log.filter((l) => terminalTokens.test(l));
        expect(hits, c.label).toHaveLength(1);
      } finally {
        fs.rmSync(sd, { recursive: true, force: true });
      }
    }
    // the dedup branch: a shared state dir, first start posts, the second
    const fresh = fs.mkdtempSync(path.join(os.tmpdir(), "piscord-g1-"));
    try {
      armLivenessEnv();
      const fl = fakeLiveness([200, 200]);
      fl.arm();
      log = [];
      await runRestartWake({
        reason: "startup",
        stateDir: fresh,
        runDir: runDir(),
        now: T0,
        log: (l) => log.push(l),
      });
      log = [];
      await runRestartWake({
        reason: "startup",
        stateDir: fresh,
        runDir: runDir(),
        now: T0 + 30_000,
        log: (l) => log.push(l),
      });
      fl.disarm();
      expect(log.filter((l) => terminalTokens.test(l))).toHaveLength(1);
      expect(log.join("\n")).toContain("dedup suppressed");
    } finally {
      fs.rmSync(fresh, { recursive: true, force: true });
    }
  });
});

describe("wake audit G2 (issue #322)", () => {
  const W = WAKE_AUDIT_WINDOW_MS;

  test("invariant holds: no flag when every startup has a terminal outcome", () => {
    const s = wakeAuditInit();
    const ws = 100 * W;
    expect(wakeAuditStart(s, ws + 10_000)).toBeNull();
    wakeAuditOutcome(s, "posted");
    expect(wakeAuditStart(s, ws + 20_000)).toBeNull();
    wakeAuditOutcome(s, "dedup");
    // #328: the suppressed-planned bucket keeps the invariant closed
    expect(wakeAuditStart(s, ws + 30_000)).toBeNull();
    wakeAuditOutcome(s, "suppressed-planned");
    // window roll evaluates the closed window: 3 starts == 3 accounted
    expect(wakeAuditStart(s, ws + W + 1_000)).toBeNull();
    wakeAuditOutcome(s, "posted"); // balance the new window
    expect(wakeAuditEvaluate(s)).toBeNull();
  });

  test("violation: a startup with no terminal outcome -> one deterministic flag line", () => {
    const s = wakeAuditInit();
    const ws = 100 * W;
    wakeAuditStart(s, ws + 10_000); // start with no outcome (the gap)
    wakeAuditStart(s, ws + 20_000);
    wakeAuditOutcome(s, "posted"); // only one accounted
    const flag = wakeAuditStart(s, ws + W + 1_000); // closes the window
    expect(flag).toBe(
      `[wake] audit flag: window=${ws} starts=2 accounted=1 ` +
        "(posted=1 dedup=0 post-failed=0 no-channel=0 suppressed-planned=0)",
    );
    // the new window starts clean
    wakeAuditOutcome(s, "posted");
    expect(wakeAuditEvaluate(s)).toBeNull();
  });

  test("wakeAuditEvaluate: null when the invariant holds, the flag line when it does not", () => {
    const s = wakeAuditInit();
    s.windowStart = 100 * W;
    s.starts = 1;
    s.posted = 1;
    expect(wakeAuditEvaluate(s)).toBeNull();
    // #328: the suppressed-planned bucket accounts for a startup too
    s.starts = 2;
    s.suppressedPlanned = 1;
    expect(wakeAuditEvaluate(s)).toBeNull();
    s.suppressedPlanned = 0; // one startup never accounted
    expect(wakeAuditEvaluate(s)).toContain("[wake] audit flag:");
    expect(wakeAuditEvaluate(s)).toContain("starts=2");
    expect(wakeAuditEvaluate(s)).toContain("accounted=1");
  });

  test("runRestartWake logs the flag line when a closed window violates the invariant", async () => {
    // an unclean start sets the #328 once-per-process suppress flag;
    // reset it afterwards (shared module registry)
    resetStartupMessageSuppressionForTests();
    const s = wakeAuditInit();
    const ws = Math.floor(T0 / W) * W;
    const log: string[] = [];
    armLivenessEnv();
    const fl = fakeLiveness([200, 200]);
    fl.arm();
    const base = {
      stateDir: path.join(tmp, ".tmp"),
      runDir: path.join(tmp, "runs"),
      log: (l: string) => log.push(l),
      auditState: s,
    };
    const r1 = await runRestartWake({
      ...base,
      reason: "startup",
      now: ws + 10_000,
    });
    expect(r1.reason).toBe("posted");
    // a startup that never reaches a terminal state (the gap G2 catches)
    wakeAuditStart(s, ws + 30_000);
    const r2 = await runRestartWake({
      ...base,
      reason: "startup",
      now: ws + W + 10_000,
    });
    fl.disarm();
    disarmLivenessEnv();
    expect(r2.reason).toBe("posted");
    expect(fl.calls).toHaveLength(2);
    const joined = log.join("\n");
    expect(joined).toContain("[wake] audit flag:");
    expect(joined).toContain("starts=2");
    expect(joined).toContain("accounted=1");
    resetStartupMessageSuppressionForTests();
  });
});

// ─── #328: one post per restart (planned -> startup message only,
// unplanned -> restart-wake card only) ──────────────────────────────

describe("runRestartWake #328 (one post per restart; leg B: event + startup message)", () => {
  const runDir = () => path.join(tmp, "runs");
  const stateDir = () => path.join(tmp, ".tmp");
  let log: string[];

  beforeEach(() => {
    log = [];
    armLivenessEnv();
    resetStartupMessageSuppressionForTests();
  });

  afterEach(() => {
    disarmLivenessEnv();
    resetStartupMessageSuppressionForTests();
  });

  const run = (over: Partial<Parameters<typeof runRestartWake>[0]>) =>
    runRestartWake({
      reason: "startup",
      stateDir: stateDir(),
      runDir: runDir(),
      now: T0,
      log: (l) => log.push(l),
      ...over,
    } as Parameters<typeof runRestartWake>[0]);

  test("planned: the event is NOT sent (zero event calls), reason is suppressed-planned, the startup message is NOT suppressed", async () => {
    writeCleanStop(stateDir(), new Date(T0 - 60_000));
    const fl = fakeLiveness([200]);
    fl.arm();
    const r = await run({});
    fl.disarm();
    expect(r).toEqual({
      posted: false,
      reason: "suppressed-planned",
      restartClass: "planned",
    });
    expect(fl.calls).toHaveLength(0); // no card -> no hall-monitor page
    expect(log.join("\n")).toContain(
      "[wake] suppressed-planned: startup message is the post",
    );
    // the startup message is the one post: the flag stays unset
    expect(isStartupMessageSuppressedForThisStart()).toBe(false);
  });

  test("planned consumes the marker but takes no claim: the next unclean start still sends its event", async () => {
    writeCleanStop(stateDir(), new Date(T0 - 60_000));
    const fl = fakeLiveness([200, 200]);
    fl.arm();
    const a = await run({});
    expect(a.reason).toBe("suppressed-planned");
    expect(fs.existsSync(cleanStopPath(stateDir()))).toBe(false); // consumed
    const b = await run({ now: T0 + 30_000 });
    fl.disarm();
    expect(b).toMatchObject({ posted: true, reason: "posted" });
    expect(fl.calls).toHaveLength(1); // only the unclean event was ever sent
  });

  test("unclean: the event is the post and the startup message is suppressed (flag set)", async () => {
    const fl = fakeLiveness([200]);
    fl.arm();
    const r = await run({});
    fl.disarm();
    expect(r).toMatchObject({
      posted: true,
      reason: "posted",
      restartClass: "unclean",
    });
    expect(fl.calls).toHaveLength(1);
    expect(isStartupMessageSuppressedForThisStart()).toBe(true);
  });

  test("crash-flap: the deduped second unclean start also suppresses the startup message (one event total)", async () => {
    const fl = fakeLiveness([200, 200]);
    fl.arm();
    const a = await run({});
    expect(a.posted).toBe(true);
    expect(isStartupMessageSuppressedForThisStart()).toBe(true);
    const b = await run({ now: T0 + 30_000 });
    fl.disarm();
    expect(b).toMatchObject({ posted: false, reason: "dedup" });
    expect(isStartupMessageSuppressedForThisStart()).toBe(true);
    expect(fl.calls).toHaveLength(1); // the second start adds no post
  });

  test("G2: a window mixing posted + suppressed-planned + dedup stays closed (no flag)", async () => {
    const s = wakeAuditInit();
    const ws = Math.floor(T0 / WAKE_AUDIT_WINDOW_MS) * WAKE_AUDIT_WINDOW_MS;
    const logLines: string[] = [];
    const fl = fakeLiveness([200, 200]);
    fl.arm();
    const base = {
      stateDir: stateDir(),
      runDir: runDir(),
      log: (l: string) => logLines.push(l),
      auditState: s,
    };
    // start 1: unclean -> posted
    const r1 = await runRestartWake({
      ...base,
      reason: "startup",
      now: ws + 10_000,
    });
    expect(r1.reason).toBe("posted");
    // start 2: planned -> suppressed-planned (the marker is fresh)
    writeCleanStop(stateDir(), new Date(ws + 20_000 - 60_000));
    const r2 = await runRestartWake({
      ...base,
      reason: "startup",
      now: ws + 20_000,
    });
    expect(r2.reason).toBe("suppressed-planned");
    // start 3: unclean, 15s after start 1's posted claim -> dedup
    const r3 = await runRestartWake({
      ...base,
      reason: "startup",
      now: ws + 25_000,
    });
    fl.disarm();
    expect(r3.reason).toBe("dedup");
    expect(wakeAuditEvaluate(s)).toBeNull();
    expect(logLines.join("\n")).not.toContain("[wake] audit flag:");
  });
});
