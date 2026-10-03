import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  buildWakeMessage,
  claimWake,
  cleanStopPath,
  elapsedSeconds,
  elapsedStr,
  MAX_INFLIGHT,
  postWakeText,
  type RunRecord,
  readCleanStop,
  readRunRecords,
  runRestartWake,
  selectInflight,
  WAKE_DEDUP_WINDOW_MS,
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

describe("buildWakeMessage (issue #111)", () => {
  test("clean + zero inflight = ONE short line, no list", () => {
    expect(buildWakeMessage({ clean: true, runs: [], now: T0 })).toBe(
      "[ok] back online (planned restart) - no in-flight pi-bg work",
    );
  });

  test("unclean + zero inflight = ONE short line naming the class", () => {
    expect(buildWakeMessage({ clean: false, runs: [], now: T0 })).toBe(
      "[!] back online (unplanned restart - last turn may have been interrupted) - no in-flight pi-bg work",
    );
  });

  test("terminal states are not inflight (done/killed ignored)", () => {
    const runs = [
      rec({ run: "a", state: "done", finished: "2026-10-01T12:00:00Z" }),
      rec({ run: "b", state: "killed", reason: "pi-bg-kill" }),
    ];
    expect(buildWakeMessage({ clean: true, runs, now: T0 })).toContain(
      "no in-flight pi-bg work",
    );
  });

  test("inflight list: ticket, profile, elapsed, cwd, task (fixture records)", () => {
    const runs = [
      rec({
        run: "20261001-103700-9",
        profile: "reviewer",
        cwd: "/home/monky/.pi-bg-wt/jarate/20261001-103700-9",
        started: "2026-10-01T11:37:00Z", // 23m before T0
      }),
      rec({
        run: "20261001-115900-10",
        profile: "worker",
        cwd: "/home/monky/projects/jarate",
        started: "2026-10-01T11:59:30Z", // 30s before T0
      }),
    ];
    const taskFor = (id: string) =>
      id === "20261001-103700-9"
        ? "adversarially review pi-bg/20261001-103700-9 for issue #110"
        : undefined; // second run: wrapper dead, no task text
    const msg = buildWakeMessage({ clean: false, runs, taskFor, now: T0 });
    const expected = [
      "[!] back online (unplanned restart - last turn may have been interrupted) - 2 in-flight pi-bg run(s)",
      "- 20261001-103700-9 reviewer 23m",
      "  cwd /home/monky/.pi-bg-wt/jarate/20261001-103700-9",
      "  task adversarially review pi-bg/20261001-103700-9 for issue #110",
      "- 20261001-115900-10 worker 30s",
      "  cwd /home/monky/projects/jarate",
    ].join("\n");
    expect(msg).toBe(expected);
  });

  test("oldest first, capped at MAX_INFLIGHT with a /jobs pointer", () => {
    const runs = Array.from({ length: MAX_INFLIGHT + 2 }, (_, i) =>
      rec({
        run: `20261001-11${String(i).padStart(2, "0")}-0`,
        started: `2026-10-01T11:${String(i).padStart(2, "0")}:00Z`,
      }),
    );
    const msg = buildWakeMessage({ clean: true, runs, now: T0 });
    const lines = msg.split("\n");
    expect(lines[0]).toBe(
      `[ok] back online (planned restart) - ${MAX_INFLIGHT} in-flight pi-bg run(s)`,
    );
    // oldest (i=0) listed first, newest (i>=10) dropped
    expect(lines[1]).toBe("- 20261001-1100-0 worker 1h0m");
    expect(lines).toContain(`- +2 more - see /jobs`);
    expect(lines).not.toContain("20261001-1110-0");
    expect(lines).not.toContain("20261001-1111-0");
  });

  test("task text clipped to ~80 chars, single line", () => {
    const long = "x".repeat(200);
    const msg = buildWakeMessage({
      clean: true,
      runs: [rec({})],
      taskFor: () => `${long}\nsecond line`,
      now: T0,
    });
    const taskLine = msg.split("\n").find((l) => l.startsWith("  task "));
    expect(taskLine).toBe(`  task ${"x".repeat(80)}`);
  });

  test("missing profile / cwd / started degrade without crashing", () => {
    const msg = buildWakeMessage({
      clean: true,
      runs: [{ run: "20261001-110000-1", state: "running" } as RunRecord],
      now: T0,
    });
    expect(msg).toBe(
      [
        "[ok] back online (planned restart) - 1 in-flight pi-bg run(s)",
        "- 20261001-110000-1 unknown 0s",
      ].join("\n"),
    );
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

describe("postWakeText (issue #111)", () => {
  const target: WakeTarget = { channelId: "1545018100590846033" };
  const opts = { backoffMs: 1, timeoutMs: 50 };

  test("no token, no webhook = silent no-op (dev runs)", async () => {
    const { impl, calls } = fakeFetch([200]);
    await expect(
      postWakeText(target, "back online", { ...opts, fetchImpl: impl }),
    ).resolves.toBe(false);
    expect(calls).toHaveLength(0);
  });

  test("bot route: posts content to the channel messages API", async () => {
    const { impl, calls } = fakeFetch([200]);
    await expect(
      postWakeText({ ...target, botToken: "tok" }, "back online", {
        ...opts,
        fetchImpl: impl,
      }),
    ).resolves.toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(
      "https://discord.com/api/v10/channels/1545018100590846033/messages",
    );
    expect(calls[0].headers.Authorization).toBe("Bot tok");
  });

  test("webhook-only route works", async () => {
    const { impl, calls } = fakeFetch([200]);
    await expect(
      postWakeText(
        { ...target, webhookUrl: "https://discord.com/api/webhooks/1/abc" },
        "hi",
        { ...opts, fetchImpl: impl },
      ),
    ).resolves.toBe(true);
    expect(calls[0].url).toBe("https://discord.com/api/webhooks/1/abc");
  });

  test("3 attempts on failure, backoff between (pi-bg pattern)", async () => {
    const { impl, calls } = fakeFetch([500, 502, 200]);
    const t0 = Date.now();
    await expect(
      postWakeText({ ...target, botToken: "tok" }, "hi", {
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
      postWakeText({ ...target, botToken: "tok" }, "hi", {
        ...opts,
        fetchImpl: impl,
      }),
    ).resolves.toBe(false);
    expect(calls).toHaveLength(3);
  });

  test("bot route dead falls through to webhook route", async () => {
    const { impl, calls } = fakeFetch([500, 500, 500, 200]);
    await expect(
      postWakeText(
        { ...target, botToken: "tok", webhookUrl: "https://h/1" },
        "hi",
        { ...opts, fetchImpl: impl },
      ),
    ).resolves.toBe(true);
    expect(calls).toHaveLength(4);
    expect(calls[3].url).toBe("https://h/1");
  });
});

// ─── orchestrator ────────────────────────────────────────────────────────

describe("runRestartWake (issue #111)", () => {
  const runDir = () => path.join(tmp, "runs");
  const stateDir = () => path.join(tmp, ".tmp");
  const target: WakeTarget = { channelId: "1", botToken: "tok" };
  let log: string[];

  beforeEach(() => {
    log = [];
  });

  test("reason != startup: no post, marker NOT consumed (hot reload)", async () => {
    writeCleanStop(stateDir(), new Date(T0 - 60_000));
    const { impl } = fakeFetch([200]);
    const r = await runRestartWake({
      reason: "reload",
      stateDir: stateDir(),
      runDir: runDir(),
      target,
      jobs: [],
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
      jobs: [],
      now: T0,
      fetchImpl: impl,
      log: (l) => log.push(l),
    });
    expect(r).toEqual({ posted: false, reason: "no-channel" });
    expect(calls).toHaveLength(0);
  });

  test("full wake: planned restart, 1 inflight, posted with summary", async () => {
    writeCleanStop(stateDir(), new Date(T0 - 10_000));
    writeRuns(runDir(), [rec({ run: "20261001-113000-7" })]);
    const { impl, calls } = fakeFetch([200]);
    const r = await runRestartWake({
      reason: "startup",
      stateDir: stateDir(),
      runDir: runDir(),
      target,
      jobs: [],
      now: T0,
      fetchImpl: impl,
      log: (l) => log.push(l),
    });
    expect(r.posted).toBe(true);
    expect(r.reason).toBe("posted");
    expect(r.restartClass).toBe("planned");
    expect(calls).toHaveLength(1);
    const posted = JSON.parse(calls[0].body ?? "{}");
    expect(posted.content).toContain("[ok] back online (planned restart)");
    expect(posted.content).toContain("- 20261001-113000-7 worker 23m");
  });

  test("unclean + inflight message body matches the builder", async () => {
    writeRuns(runDir(), [rec({ run: "20261001-113000-7" })]);
    const { impl } = fakeFetch([200]);
    const r = await runRestartWake({
      reason: "startup",
      stateDir: stateDir(),
      runDir: runDir(),
      target,
      jobs: [],
      now: T0,
      fetchImpl: impl,
      log: (l) => log.push(l),
    });
    expect(r.posted).toBe(true);
    expect(r.restartClass).toBe("unclean");
    expect(r.message).toBe(
      [
        "[!] back online (unplanned restart - last turn may have been interrupted) - 1 in-flight pi-bg run(s)",
        "- 20261001-113000-7 worker 23m",
        "  cwd /home/monky/projects/jarate",
      ].join("\n"),
    );
  });

  test("dedup: second startup within 60s does not post", async () => {
    const { impl, calls } = fakeFetch([200, 200]);
    const a = await runRestartWake({
      reason: "startup",
      stateDir: stateDir(),
      runDir: runDir(),
      target,
      jobs: [],
      now: T0,
      fetchImpl: impl,
      log: (l) => log.push(l),
    });
    const b = await runRestartWake({
      reason: "startup",
      stateDir: stateDir(),
      runDir: runDir(),
      target,
      jobs: [],
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
      new Error("e3"),
    ]);
    const r = await runRestartWake({
      reason: "startup",
      stateDir: stateDir(),
      runDir: runDir(),
      target,
      jobs: [],
      now: T0,
      fetchImpl: impl,
      postOpts: { backoffMs: 1, timeoutMs: 50 },
      log: (l) => log.push(l),
    });
    expect(r).toMatchObject({ posted: false, reason: "post-failed" });
    expect(log.join(" ")).toContain("post failed");
  });

  test("task text enriched from live wrappers (jobs by ticket id)", async () => {
    writeRuns(runDir(), [rec({ run: "20261001-113000-7" })]);
    const { impl } = fakeFetch([200]);
    const r = await runRestartWake({
      reason: "startup",
      stateDir: stateDir(),
      runDir: runDir(),
      target,
      jobs: [
        {
          id: "20261001-113000-7",
          age: "20:00",
          profile: "worker",
          task: "fix the thing",
        },
        { id: null, age: "01:00", profile: "worker", task: "unresolved" },
      ],
      now: T0,
      fetchImpl: impl,
      log: (l) => log.push(l),
    });
    expect(r.message).toContain("  task fix the thing");
    expect(r.message).not.toContain("unresolved");
  });
});
