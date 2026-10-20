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
  postWakePayload,
  type RunRecord,
  readCleanStop,
  readRunRecords,
  runRestartWake,
  selectInflight,
  WAKE_DEDUP_WINDOW_MS,
  WAKE_TAG,
  type WakePayload,
  type WakeTarget,
  writeCleanStop,
} from "./restart-wake";

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

// ─── inflight summary builder (fixture run records) ──────────────────────

describe("buildWakePayload (issue #111 + embed card family)", () => {
  test("clean + zero inflight = one-line [bg: content + green planned embed", () => {
    const p = buildWakePayload({ clean: true, runs: [], now: T0 });
    expect(p.content).toBe(`${WAKE_TAG} planned restart, 0 in-flight`);
    expect(p.embeds).toHaveLength(1);
    const e = p.embeds[0];
    expect(e.title).toBe("restart-wake \u00b7 planned");
    expect(e.color).toBe(0x57f287);
    expect(e.description).toBe(
      "pi restarted as planned (clean stop) - back online. No in-flight pi-bg work.",
    );
    expect(e.footer.text).toBe("restart-wake");
    expect(e.fields).toBeUndefined();
  });

  test("unclean + zero inflight = red unplanned embed, no-in-flight fact in description", () => {
    const p = buildWakePayload({ clean: false, runs: [], now: T0 });
    expect(p.content).toBe(`${WAKE_TAG} unplanned restart, 0 in-flight`);
    const e = p.embeds[0];
    expect(e.title).toBe("restart-wake \u00b7 unplanned");
    expect(e.color).toBe(0xed4245);
    expect(e.description).toBe(
      "pi is back online but the last stop was NOT clean (crash, OOM, or kill) - the last turn was interrupted. No in-flight pi-bg work.",
    );
    expect(e.footer.text).toBe("restart-wake");
  });

  test("terminal states are not inflight (done/killed ignored)", () => {
    const runs = [
      rec({ run: "a", state: "done", finished: "2026-10-01T12:00:00Z" }),
      rec({ run: "b", state: "killed", reason: "pi-bg-kill" }),
    ];
    const p = buildWakePayload({ clean: true, runs, now: T0 });
    expect(p.content).toBe(`${WAKE_TAG} planned restart, 0 in-flight`);
    expect(p.embeds[0].description).toContain("No in-flight pi-bg work.");
    expect(p.embeds[0].fields).toBeUndefined();
  });

  test("inflight rows: ticket profile age, one row each (detail in /jobs)", () => {
    const runs = [
      rec({
        run: "20261001-103700-9",
        profile: "reviewer",
        started: "2026-10-01T11:37:00Z", // 23m before T0
      }),
      rec({
        run: "20261001-115900-10",
        profile: "worker",
        started: "2026-10-01T11:59:30Z", // 30s before T0
      }),
    ];
    const p = buildWakePayload({ clean: false, runs, now: T0 });
    expect(p.content).toBe(`${WAKE_TAG} unplanned restart, 2 in-flight`);
    expect(p.embeds[0].fields).toEqual([
      {
        name: "in-flight",
        value: "20261001-103700-9 reviewer 23m\n20261001-115900-10 worker 30s",
      },
    ]);
  });

  test("oldest first, capped at MAX_INFLIGHT with a /jobs pointer", () => {
    const runs = Array.from({ length: MAX_INFLIGHT + 2 }, (_, i) =>
      rec({
        run: `20261001-11${String(i).padStart(2, "0")}-0`,
        started: `2026-10-01T11:${String(i).padStart(2, "0")}:00Z`,
      }),
    );
    const p = buildWakePayload({ clean: true, runs, now: T0 });
    expect(p.content).toBe(
      `${WAKE_TAG} planned restart, ${MAX_INFLIGHT} in-flight`,
    );
    const value = p.embeds[0].fields?.[0]?.value ?? "";
    const lines = value.split("\n");
    // oldest (i=0) listed first, newest (i>=10) dropped
    expect(lines[0]).toBe("20261001-1100-0 worker 1h0m");
    expect(lines).toContain("+2 more - see /jobs");
    expect(value).not.toContain("20261001-1110-0");
    expect(value).not.toContain("20261001-1111-0");
  });

  test("no width budget: long profile ships in full, never clipped", () => {
    const profile = "x".repeat(60);
    const p = buildWakePayload({
      clean: true,
      runs: [rec({ run: "20261001-110000-1", state: "running", profile })],
      now: T0,
    });
    const value = p.embeds[0].fields?.[0]?.value ?? "";
    expect(value).toContain(`20261001-110000-1 ${profile} 23m`);
    expect(value).not.toContain("…");
  });

  test("emoji profile stays intact (no clip to split a surrogate pair)", () => {
    const emoji = "\u{1F600}"; // 2 code units, 1 code point
    const p = buildWakePayload({
      clean: true,
      runs: [rec({ profile: emoji.repeat(30) })],
      now: T0,
    });
    const loneSurrogate =
      /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
    expect(JSON.stringify(p).match(loneSurrogate)).toBe(null);
  });

  test("missing profile / started degrade without crashing", () => {
    const p = buildWakePayload({
      clean: true,
      runs: [{ run: "20261001-110000-1", state: "running" } as RunRecord],
      now: T0,
    });
    expect(p.content).toBe(`${WAKE_TAG} planned restart, 1 in-flight`);
    expect(p.embeds[0].fields).toEqual([
      { name: "in-flight", value: "20261001-110000-1 ? 0s" },
    ]);
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

// ─── startup dedup (60s window) ──────────────────────────────────────────

describe("claimWake dedup (issue #111)", () => {
  test("first claim wins; racing start within 60s loses", () => {
    expect(claimWake(tmp, T0)).toBe(true);
    expect(claimWake(tmp, T0 + 59_000)).toBe(false);
    // a crash at T0+30s that never posted: the next start after the
    // window still claims
    expect(claimWake(tmp, T0 + WAKE_DEDUP_WINDOW_MS + 1)).toBe(true);
  });

  test("stale claim (>= 60s old) is taken over", () => {
    expect(claimWake(tmp, T0)).toBe(true);
    expect(claimWake(tmp, T0 + WAKE_DEDUP_WINDOW_MS)).toBe(true);
  });

  test("unreadable claim content = assume held (no post)", () => {
    fs.mkdirSync(tmp, { recursive: true });
    fs.writeFileSync(
      path.join(tmp, "restart-wake.lock"),
      "\u0000garbage\u0000",
    );
    expect(claimWake(tmp, T0)).toBe(false);
    // and the foreign claim file is left in place (not torn down)
    expect(fs.existsSync(path.join(tmp, "restart-wake.lock"))).toBe(true);
  });

  test("a crash after claiming eats the window, then it opens again", () => {
    // start claims, dies before posting (lock file stays, fresh ts)
    expect(claimWake(tmp, T0)).toBe(true);
    // another start 10s later sees the fresh claim: no double post
    expect(claimWake(tmp, T0 + 10_000)).toBe(false);
    // after the 60s window the claim is stale: next start takes over
    expect(claimWake(tmp, T0 + WAKE_DEDUP_WINDOW_MS + 10_000)).toBe(true);
  });
});

// ─── bounded post (pi-bg pattern) ────────────────────────────────────────

describe("postWakePayload (issue #111)", () => {
  const target: WakeTarget = { channelId: "1545018100590846033" };
  const opts = { backoffMs: 1, timeoutMs: 50 };
  const payload = (): WakePayload => ({
    content: `${WAKE_TAG} planned restart, 0 in-flight`,
    embeds: [
      {
        title: "restart-wake \u00b7 planned",
        color: 0x57f287,
        description:
          "pi restarted as planned (clean stop) - back online. No in-flight pi-bg work.",
        footer: { text: "restart-wake" },
      },
    ],
  });

  test("no token, no webhook = silent no-op (dev runs)", async () => {
    const { impl, calls } = fakeFetch([200]);
    await expect(
      postWakePayload(target, payload(), { ...opts, fetchImpl: impl }),
    ).resolves.toBe(false);
    expect(calls).toHaveLength(0);
  });

  test("bot route: posts content + embeds to the channel messages API", async () => {
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
    expect(body.embeds).toHaveLength(1);
    expect(body.embeds[0].title).toBe("restart-wake \u00b7 planned");
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

  test("webhook FIRST when both configured (the [bg: bus is the wake route)", async () => {
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

  test("full wake: planned restart, 1 inflight, embed card, bus webhook first", async () => {
    writeCleanStop(stateDir(), new Date(T0 - 10_000));
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
    expect(r.restartClass).toBe("planned");
    expect(calls).toHaveLength(1);
    // the channel config has no webhookUrl -> the pi-bg bus resolves it,
    // and the [bg: post is the FIRST route
    expect(calls[0].url).toBe("https://bus.example/hook");
    const posted = JSON.parse(calls[0].body ?? "{}");
    expect(posted.content).toBe(`${WAKE_TAG} planned restart, 1 in-flight`);
    expect(posted.embeds).toHaveLength(1);
    expect(posted.embeds[0].title).toBe("restart-wake \u00b7 planned");
    expect(posted.embeds[0].color).toBe(0x57f287);
    expect(posted.embeds[0].footer.text).toBe("restart-wake");
    expect(posted.embeds[0].fields).toEqual([
      { name: "in-flight", value: "20261001-113000-7 worker 23m" },
    ]);
  });

  test("channel webhookUrl beats the resolved bus webhook", async () => {
    writeCleanStop(stateDir(), new Date(T0 - 10_000));
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

  test("unclean + inflight message body matches the builder", async () => {
    writeRuns(runDir(), [rec({ run: "20261001-113000-7" })]);
    const { impl } = fakeFetch([200]);
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
    expect(r.message).toBe(`${WAKE_TAG} unplanned restart, 1 in-flight`);
  });

  test("dedup: second startup within 60s does not post", async () => {
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
    expect(log.join(" ")).toContain("post failed");
  });
});
