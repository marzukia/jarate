import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  buildWakePayload,
  claimWake,
  cleanStopPath,
  defaultDispatchWebhook,
  elapsedSeconds,
  elapsedStr,
  MAX_INFLIGHT,
  markWakePosted,
  postWakePayload,
  type RunRecord,
  readCleanStop,
  readRunRecords,
  runRestartWake,
  selectInflight,
  WAKE_AUDIT_WINDOW_MS,
  WAKE_DEDUP_POSTED_WINDOW_MS,
  type WakePayload,
  type WakeTarget,
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

// fake fetch: queue of (status|Error) results per call
function fakeFetch(results: Array<number | Error>): {
  impl: typeof fetch;
  calls: Array<{
    url: string;
    headers: Record<string, string>;
    body: string | undefined;
  }>;
} {
  const calls: Array<{
    url: string;
    headers: Record<string, string>;
    body: string | undefined;
  }> = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    const r = results.shift();
    calls.push({
      url: String(url),
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: typeof init?.body === "string" ? init.body : undefined,
    });
    if (r instanceof Error) throw r;
    return new Response(null, { status: r ?? 200 });
  }) as unknown as typeof fetch;
  return { impl, calls };
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

// ─── bus webhook resolution (file branch + env precedence) ─────────────

describe("defaultDispatchWebhook", () => {
  const savedEnv = process.env.PI_DISPATCH_WEBHOOK;

  afterEach(() => {
    if (savedEnv === undefined) delete process.env.PI_DISPATCH_WEBHOOK;
    else process.env.PI_DISPATCH_WEBHOOK = savedEnv;
  });

  test("file branch: <home>/.config/pi-dispatch/webhook when env unset", () => {
    delete process.env.PI_DISPATCH_WEBHOOK;
    const p = path.join(tmp, ".config", "pi-dispatch");
    fs.mkdirSync(p, { recursive: true });
    fs.writeFileSync(path.join(p, "webhook"), "https://file.example/hook\n");
    expect(defaultDispatchWebhook(tmp)).toBe("https://file.example/hook");
  });

  test("env beats file; env unset + missing file = null", () => {
    process.env.PI_DISPATCH_WEBHOOK = "https://env.example/hook";
    expect(defaultDispatchWebhook(tmp)).toBe("https://env.example/hook");
    delete process.env.PI_DISPATCH_WEBHOOK;
    expect(defaultDispatchWebhook(tmp)).toBe(null);
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

// ─── bounded post (pi-bg pattern) ────────────────────────────────────────

describe("postWakePayload (issue #111)", () => {
  const target: WakeTarget = { channelId: "1545018100590846033" };
  const opts = { backoffMs: 1, timeoutMs: 50 };
  const payload = (): WakePayload => ({
    content: "*restart-wake \u00b7 planned*",
  });

  test("no token, no webhook = silent no-op (dev runs)", async () => {
    const { impl, calls } = fakeFetch([200]);
    await expect(
      postWakePayload(target, payload(), { ...opts, fetchImpl: impl }),
    ).resolves.toBe(false);
    expect(calls).toHaveLength(0);
  });

  test("bot route: posts the italic wake content to the channel messages API", async () => {
    const { impl, calls } = fakeFetch([200]);
    await expect(
      postWakePayload({ ...target, botToken: "tok" }, payload(), {
        ...opts,
        fetchImpl: impl,
      }),
    ).resolves.toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(
      "https://discord.com/api/v10/channels/1545018100590846033/messages",
    );
    expect(calls[0].headers.Authorization).toBe("Bot tok");
    const body = JSON.parse(calls[0].body ?? "{}");
    expect(body.content).toBe(payload().content);
    expect(body.embeds).toBeUndefined();
  });

  test("webhook-only route works", async () => {
    const { impl, calls } = fakeFetch([200]);
    await expect(
      postWakePayload(
        { ...target, webhookUrl: "https://discord.com/api/webhooks/1/abc" },
        payload(),
        { ...opts, fetchImpl: impl },
      ),
    ).resolves.toBe(true);
    expect(calls[0].url).toBe("https://discord.com/api/webhooks/1/abc");
  });

  test("3 attempts on failure, backoff between (pi-bg pattern)", async () => {
    const { impl, calls } = fakeFetch([500, 502, 200]);
    const t0 = Date.now();
    await expect(
      postWakePayload({ ...target, botToken: "tok" }, payload(), {
        ...opts,
        fetchImpl: impl,
      }),
    ).resolves.toBe(true);
    expect(calls).toHaveLength(3);
    expect(Date.now() - t0).toBeLessThan(5_000); // backoff is 1ms here
  });

  test("all attempts fail = false (never throws)", async () => {
    const boom = new Error("network down");
    const { impl, calls } = fakeFetch([boom, 500, boom]);
    await expect(
      postWakePayload({ ...target, botToken: "tok" }, payload(), {
        ...opts,
        fetchImpl: impl,
      }),
    ).resolves.toBe(false);
    expect(calls).toHaveLength(3);
  });

  test("webhook FIRST when both configured (the webhook bus is the wake route)", async () => {
    const { impl, calls } = fakeFetch([200]);
    await expect(
      postWakePayload(
        {
          ...target,
          botToken: "tok",
          webhookUrl: "https://discord.com/api/webhooks/1/abc",
        },
        payload(),
        { ...opts, fetchImpl: impl },
      ),
    ).resolves.toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://discord.com/api/webhooks/1/abc");
  });

  test("webhook dead falls through to bot route", async () => {
    const { impl, calls } = fakeFetch([500, 500, 500, 200]);
    await expect(
      postWakePayload(
        { ...target, botToken: "tok", webhookUrl: "https://h/1" },
        payload(),
        { ...opts, fetchImpl: impl },
      ),
    ).resolves.toBe(true);
    expect(calls).toHaveLength(4);
    expect(calls[3].url).toBe(
      "https://discord.com/api/v10/channels/1545018100590846033/messages",
    );
  });
});

// ─── orchestrator ────────────────────────────────────────────────────────

describe("runRestartWake (issue #111)", () => {
  const runDir = () => path.join(tmp, "runs");
  const stateDir = () => path.join(tmp, ".tmp");
  const target: WakeTarget = { channelId: "1", botToken: "tok" };
  let log: string[];
  const savedBusHook = process.env.PI_DISPATCH_WEBHOOK;

  beforeEach(() => {
    log = [];
    // deterministic bus-webhook resolution (the real file is env-dependent)
    process.env.PI_DISPATCH_WEBHOOK = "https://bus.example/hook";
  });

  afterEach(() => {
    if (savedBusHook === undefined) delete process.env.PI_DISPATCH_WEBHOOK;
    else process.env.PI_DISPATCH_WEBHOOK = savedBusHook;
  });

  test("reason != startup: no post, marker NOT consumed (hot reload)", async () => {
    writeCleanStop(stateDir(), new Date(T0 - 60_000));
    const { impl } = fakeFetch([200]);
    const r = await runRestartWake({
      reason: "reload",
      stateDir: stateDir(),
      runDir: runDir(),
      target,
      now: T0,
      fetchImpl: impl,
      log: (l) => log.push(l),
    });
    expect(r).toEqual({ posted: false, reason: "not-startup" });
    expect(fs.existsSync(cleanStopPath(stateDir()))).toBe(true);
  });

  test("no target (dev run): silent no-op, fetch never called", async () => {
    const { impl, calls } = fakeFetch([200]);
    const r = await runRestartWake({
      reason: "startup",
      stateDir: stateDir(),
      runDir: runDir(),
      target: null,
      now: T0,
      fetchImpl: impl,
      log: (l) => log.push(l),
    });
    expect(r).toEqual({ posted: false, reason: "no-channel" });
    expect(calls).toHaveLength(0);
  });

  test("full wake: unclean restart, 1 inflight, italic line, bus webhook first", async () => {
    // #328: the planned class no longer posts a card (the startup
    // message is the post), so the card path is exercised here with
    // the unclean class (no marker).
    writeRuns(runDir(), [rec({ run: "20261001-113000-7" })]);
    const { impl, calls } = fakeFetch([200]);
    const r = await runRestartWake({
      reason: "startup",
      stateDir: stateDir(),
      runDir: runDir(),
      target,
      now: T0,
      fetchImpl: impl,
      log: (l) => log.push(l),
    });
    expect(r.posted).toBe(true);
    expect(r.reason).toBe("posted");
    expect(r.restartClass).toBe("unclean");
    expect(calls).toHaveLength(1);
    // the channel config has no webhookUrl -> the pi-bg bus resolves it,
    // and the webhook post is the FIRST route (isBgWebhook)
    expect(calls[0].url).toBe("https://bus.example/hook");
    const posted = JSON.parse(calls[0].body ?? "{}");
    expect(posted.content).toBe(
      "*restart-wake \u00b7 unplanned \u00b7 in-flight 1*",
    );
    expect(posted.embeds).toBeUndefined();
    expect(r.message).toBe(
      "*restart-wake \u00b7 unplanned \u00b7 in-flight 1*",
    );
  });

  test("channel webhookUrl beats the resolved bus webhook", async () => {
    const { impl, calls } = fakeFetch([200]);
    await runRestartWake({
      reason: "startup",
      stateDir: stateDir(),
      runDir: runDir(),
      target: { ...target, webhookUrl: "https://ch.example/hook" },
      now: T0,
      fetchImpl: impl,
      log: (l) => log.push(l),
    });
    expect(calls[0].url).toBe("https://ch.example/hook");
  });

  test("unclean + inflight posted line matches the builder", async () => {
    writeRuns(runDir(), [rec({ run: "20261001-113000-7" })]);
    const { impl, calls } = fakeFetch([200]);
    const r = await runRestartWake({
      reason: "startup",
      stateDir: stateDir(),
      runDir: runDir(),
      target,
      now: T0,
      fetchImpl: impl,
      log: (l) => log.push(l),
    });
    expect(r.posted).toBe(true);
    expect(r.restartClass).toBe("unclean");
    const posted = JSON.parse(calls[0].body ?? "{}");
    expect(posted.content).toBe(
      "*restart-wake \u00b7 unplanned \u00b7 in-flight 1*",
    );
    expect(posted.embeds).toBeUndefined();
  });

  test("dedup: second startup within the 5m window of a posted claim does not post", async () => {
    const { impl, calls } = fakeFetch([200, 200]);
    const a = await runRestartWake({
      reason: "startup",
      stateDir: stateDir(),
      runDir: runDir(),
      target,
      now: T0,
      fetchImpl: impl,
      log: (l) => log.push(l),
    });
    const b = await runRestartWake({
      reason: "startup",
      stateDir: stateDir(),
      runDir: runDir(),
      target,
      now: T0 + 30_000,
      fetchImpl: impl,
      log: (l) => log.push(l),
    });
    expect(a.posted).toBe(true);
    expect(b).toMatchObject({ posted: false, reason: "dedup" });
    expect(calls).toHaveLength(1);
  });

  test("post failure: bounded, reported, never throws", async () => {
    const { impl } = fakeFetch([
      new Error("e1"),
      new Error("e2"),
      new Error("e3"), // bus webhook route: 3 attempts
      new Error("e4"),
      new Error("e5"),
      new Error("e6"), // bot route: 3 attempts
    ]);
    const r = await runRestartWake({
      reason: "startup",
      stateDir: stateDir(),
      runDir: runDir(),
      target,
      now: T0,
      fetchImpl: impl,
      postOpts: { backoffMs: 1, timeoutMs: 50 },
      log: (l) => log.push(l),
    });
    expect(r).toMatchObject({ posted: false, reason: "post-failed" });
    expect(log.join(" ")).toContain("post-failed");
  });

  test("G3: a failed post leaves the claim unposted — the next start in-window still posts", async () => {
    const boom = [500, 500, 500, 500, 500, 500, 200]; // 6 failures, then success
    const { impl, calls } = fakeFetch(boom);
    const postOpts = { backoffMs: 1, timeoutMs: 50 };
    const a = await runRestartWake({
      reason: "startup",
      stateDir: stateDir(),
      runDir: runDir(),
      target,
      now: T0,
      fetchImpl: impl,
      postOpts,
      log: (l) => log.push(l),
    });
    expect(a).toMatchObject({ posted: false, reason: "post-failed" });
    const b = await runRestartWake({
      reason: "startup",
      stateDir: stateDir(),
      runDir: runDir(),
      target,
      now: T0 + 30_000,
      fetchImpl: impl,
      postOpts,
      log: (l) => log.push(l),
    });
    expect(b.posted).toBe(true);
    expect(calls).toHaveLength(7); // the signal cannot go dark twice in a row
  });

  test("G3: a legacy 2-field claim does not suppress", async () => {
    fs.mkdirSync(stateDir(), { recursive: true });
    fs.writeFileSync(
      path.join(stateDir(), "restart-wake.lock"),
      `${T0} planned\n`,
    );
    const { impl, calls } = fakeFetch([200]);
    const r = await runRestartWake({
      reason: "startup",
      stateDir: stateDir(),
      runDir: runDir(),
      target,
      now: T0 + 10_000,
      fetchImpl: impl,
      log: (l) => log.push(l),
    });
    expect(r.posted).toBe(true);
    expect(calls).toHaveLength(1);
  });

  test("G3: posted claim <= 5m old suppresses; posted claim > 5m old posts", async () => {
    const { impl, calls } = fakeFetch([200, 200]);
    const base = {
      stateDir: stateDir(),
      runDir: runDir(),
      target,
      fetchImpl: impl,
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
    expect(c.posted).toBe(true);
    expect(calls).toHaveLength(2);
  });
});

// ─── #322 G1: every terminal reason logs one line ────────────────────

describe("runRestartWake G1 (issue #322: no silent terminal state)", () => {
  const runDir = () => path.join(tmp, "runs");
  const stateDir = () => path.join(tmp, ".tmp");
  const target: WakeTarget = { channelId: "1", botToken: "tok" };
  let log: string[];
  const savedBusHook = process.env.PI_DISPATCH_WEBHOOK;

  beforeEach(() => {
    log = [];
    process.env.PI_DISPATCH_WEBHOOK = "https://bus.example/hook";
  });

  afterEach(() => {
    if (savedBusHook === undefined) delete process.env.PI_DISPATCH_WEBHOOK;
    else process.env.PI_DISPATCH_WEBHOOK = savedBusHook;
  });

  const run = (over: Partial<Parameters<typeof runRestartWake>[0]>) =>
    runRestartWake({
      reason: "startup",
      stateDir: stateDir(),
      runDir: runDir(),
      target,
      now: T0,
      log: (l) => log.push(l),
      ...over,
    } as Parameters<typeof runRestartWake>[0]);

  // the terminal tokens (including the #328 suppressed-planned branch);
  // each startup must end in exactly one
  const terminalTokens =
    /not-startup|no-channel|dedup suppressed|posted:|post-failed|suppressed-planned/;

  test("not-startup logs its reason", async () => {
    await run({ reason: "reload" });
    expect(log.join("\n")).toContain("[wake] not-startup: reason=reload");
  });

  test("no-channel logs its reason", async () => {
    await run({ target: null });
    expect(log.join("\n")).toContain("[wake] no-channel");
  });

  test("posted logs its reason", async () => {
    const { impl } = fakeFetch([200]);
    await run({ fetchImpl: impl });
    expect(log.join("\n")).toContain("[wake] posted: class=unclean");
  });

  test("post-failed logs its reason", async () => {
    const { impl } = fakeFetch([500, 500, 500, 500, 500, 500]);
    await run({ fetchImpl: impl, postOpts: { backoffMs: 1, timeoutMs: 50 } });
    expect(log.join("\n")).toContain("[wake] post-failed");
  });

  test("dedup suppresses with the G1 line: age and same-class values are correct", async () => {
    const { impl } = fakeFetch([200, 200]);
    await run({ fetchImpl: impl });
    log = [];
    const b = await run({ fetchImpl: impl, now: T0 + 30_000 });
    expect(b).toMatchObject({ posted: false, reason: "dedup" });
    // the dedup path logs EXACTLY one line, with the prior claim's age
    // and its same-class verdict
    expect(log).toEqual(["[wake] dedup suppressed: age=30000 same-class=true"]);
  });

  test("every startup ends in exactly one terminal line (grep-able)", async () => {
    const cases: Array<{ label: string; over: Record<string, unknown> }> = [
      { label: "not-startup", over: { reason: "reload" } },
      { label: "no-channel", over: { target: null } },
      { label: "posted", over: {} },
      {
        label: "post-failed",
        over: { postOpts: { backoffMs: 1, timeoutMs: 50 } },
      },
      { label: "suppressed-planned", over: {} }, // #328: fresh marker = planned
    ];
    for (const c of cases) {
      // fresh state dir per case: the claim file must not leak across
      const sd = fs.mkdtempSync(path.join(os.tmpdir(), "piscord-g1-"));
      try {
        // the suppressed-planned branch: a fresh clean-stop marker makes
        // the start classified planned (startup message is the post)
        if (c.label === "suppressed-planned")
          writeCleanStop(sd, new Date(T0 - 60_000));
        const { impl } = fakeFetch(
          c.label === "posted" ? [200] : [500, 500, 500, 500, 500, 500],
        );
        log = [];
        await runRestartWake({
          reason: "startup",
          stateDir: sd,
          runDir: runDir(),
          target,
          now: T0,
          fetchImpl: impl,
          log: (l) => log.push(l),
          ...c.over,
        });
        const hits = log.filter((l) => terminalTokens.test(l));
        expect(hits, c.label).toHaveLength(1);
      } finally {
        fs.rmSync(sd, { recursive: true, force: true });
      }
    }
    // the dedup branch: one state dir, posted first start, second start
    const fresh = fs.mkdtempSync(path.join(os.tmpdir(), "piscord-g1-"));
    try {
      const { impl: impl2 } = fakeFetch([200, 200]);
      log = [];
      await runRestartWake({
        reason: "startup",
        stateDir: fresh,
        runDir: runDir(),
        target,
        now: T0,
        fetchImpl: impl2,
        log: (l) => log.push(l),
      });
      log = [];
      await runRestartWake({
        reason: "startup",
        stateDir: fresh,
        runDir: runDir(),
        target,
        now: T0 + 30_000,
        fetchImpl: impl2,
        log: (l) => log.push(l),
      });
      expect(log.filter((l) => terminalTokens.test(l))).toHaveLength(1);
      expect(log.join("\n")).toContain("dedup suppressed");
    } finally {
      fs.rmSync(fresh, { recursive: true, force: true });
    }
  });
});

// ─── #322 G2: per-window numeric audit (no inference) ──────────────────

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
    const s = wakeAuditInit();
    const ws = Math.floor(T0 / W) * W;
    const log: string[] = [];
    const { impl, calls } = fakeFetch([200, 200]);
    const base = {
      stateDir: path.join(tmp, ".tmp"),
      runDir: path.join(tmp, "runs"),
      target: { channelId: "1", botToken: "tok" } as WakeTarget,
      fetchImpl: impl,
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
    expect(r2.reason).toBe("posted");
    expect(calls).toHaveLength(2);
    const joined = log.join("\n");
    expect(joined).toContain("[wake] audit flag:");
    expect(joined).toContain("starts=2");
    expect(joined).toContain("accounted=1");
  });
});

// ─── #328: one post per restart (planned -> startup message only,
// unplanned -> restart-wake card only) ──────────────────────────────

describe("runRestartWake #328 (one post per restart)", () => {
  const runDir = () => path.join(tmp, "runs");
  const stateDir = () => path.join(tmp, ".tmp");
  const target: WakeTarget = { channelId: "1", botToken: "tok" };
  let log: string[];
  const savedBusHook = process.env.PI_DISPATCH_WEBHOOK;

  beforeEach(() => {
    log = [];
    process.env.PI_DISPATCH_WEBHOOK = "https://bus.example/hook";
    resetStartupMessageSuppressionForTests();
  });

  afterEach(() => {
    if (savedBusHook === undefined) delete process.env.PI_DISPATCH_WEBHOOK;
    else process.env.PI_DISPATCH_WEBHOOK = savedBusHook;
    resetStartupMessageSuppressionForTests();
  });

  const run = (over: Partial<Parameters<typeof runRestartWake>[0]>) =>
    runRestartWake({
      reason: "startup",
      stateDir: stateDir(),
      runDir: runDir(),
      target,
      now: T0,
      log: (l) => log.push(l),
      ...over,
    } as Parameters<typeof runRestartWake>[0]);

  test("planned: the card is NOT sent (zero fetch calls), reason is suppressed-planned, the startup message is NOT suppressed", async () => {
    writeCleanStop(stateDir(), new Date(T0 - 60_000));
    const { impl, calls } = fakeFetch([200]);
    const r = await run({ fetchImpl: impl });
    expect(r).toEqual({
      posted: false,
      reason: "suppressed-planned",
      restartClass: "planned",
    });
    expect(calls).toHaveLength(0); // no card -> no hall-monitor page
    expect(log.join("\n")).toContain(
      "[wake] suppressed-planned: startup message is the post",
    );
    // the startup message is the one post: the flag stays unset
    expect(isStartupMessageSuppressedForThisStart()).toBe(false);
  });

  test("planned consumes the marker but takes no claim: the next unclean start still posts its card", async () => {
    writeCleanStop(stateDir(), new Date(T0 - 60_000));
    const { impl, calls } = fakeFetch([200, 200]);
    const a = await run({ fetchImpl: impl });
    expect(a.reason).toBe("suppressed-planned");
    expect(fs.existsSync(cleanStopPath(stateDir()))).toBe(false); // consumed
    const b = await run({ fetchImpl: impl, now: T0 + 30_000 });
    expect(b).toMatchObject({ posted: true, reason: "posted" });
    expect(calls).toHaveLength(1); // only the unclean card was ever posted
  });

  test("unclean: the card is the post and the startup message is suppressed (flag set)", async () => {
    const { impl, calls } = fakeFetch([200]);
    const r = await run({ fetchImpl: impl });
    expect(r).toMatchObject({
      posted: true,
      reason: "posted",
      restartClass: "unclean",
    });
    expect(calls).toHaveLength(1);
    expect(isStartupMessageSuppressedForThisStart()).toBe(true);
  });

  test("crash-flap: the deduped second unclean start also suppresses the startup message (one card total)", async () => {
    const { impl, calls } = fakeFetch([200, 200]);
    const a = await run({ fetchImpl: impl });
    expect(a.posted).toBe(true);
    expect(isStartupMessageSuppressedForThisStart()).toBe(true);
    const b = await run({ fetchImpl: impl, now: T0 + 30_000 });
    expect(b).toMatchObject({ posted: false, reason: "dedup" });
    expect(isStartupMessageSuppressedForThisStart()).toBe(true);
    expect(calls).toHaveLength(1); // the second start adds no post
  });

  test("G2: a window mixing posted + suppressed-planned + dedup stays closed (no flag)", async () => {
    const s = wakeAuditInit();
    const ws = Math.floor(T0 / WAKE_AUDIT_WINDOW_MS) * WAKE_AUDIT_WINDOW_MS;
    const logLines: string[] = [];
    const { impl } = fakeFetch([200, 200]);
    const base = {
      stateDir: stateDir(),
      runDir: runDir(),
      target,
      fetchImpl: impl,
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
    expect(r3.reason).toBe("dedup");
    expect(wakeAuditEvaluate(s)).toBeNull();
    expect(logLines.join("\n")).not.toContain("[wake] audit flag:");
  });
});
