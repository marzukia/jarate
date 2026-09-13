import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { CLAIM_TTL_MS, MAX_WAKE_MS } from "./sleep";
import {
  CRON_CAP_MINUTES,
  cancelTask,
  collectOrphanTaskTmpFiles,
  completeTask,
  dueTasks,
  formatTaskLine,
  formatTaskPrompt,
  loadTasks,
  markTaskClaimed,
  nextCronFire,
  parseCron,
  parseTaskSpec,
  scheduleTask,
  tasksPath,
} from "./tasks";

// 2026-09-10 is a Thursday.
const NOW = Date.parse("2026-09-10T12:00:00Z");

describe("tasks: parseCron", () => {
  test("daily 06:00 parses with dom/dow any", () => {
    const r = parseCron("0 6 * * *");
    expect(r.error).toBeUndefined();
    expect(r.fields!.minute).toEqual(new Set([0]));
    expect(r.fields!.hour).toEqual(new Set([6]));
    expect(r.fields!.domAny).toBe(true);
    expect(r.fields!.dowAny).toBe(true);
  });

  test("wrong field count -> error", () => {
    expect(parseCron("0 6 * *").error).toContain("5 fields");
    expect(parseCron("0 6 * * * *").error).toContain("5 fields");
  });

  test("out-of-range values -> error", () => {
    expect(parseCron("60 * * * *").error).toContain("minute");
    expect(parseCron("0 24 * * *").error).toContain("hour");
    expect(parseCron("0 0 32 * *").error).toContain("day-of-month");
    expect(parseCron("0 0 0 * *").error).toContain("day-of-month");
    expect(parseCron("0 0 * 13 *").error).toContain("month");
    expect(parseCron("0 0 * * 8").error).toContain("day-of-week");
  });

  test("dow 7 is an alias for 0 (Sunday)", () => {
    const r = parseCron("0 0 * * 7");
    expect(r.error).toBeUndefined();
    expect(r.fields!.dow).toEqual(new Set([0]));
  });

  test("steps: */15 and range/step; plain value/step is rejected", () => {
    expect(parseCron("*/15 * * * *").fields!.minute).toEqual(
      new Set([0, 15, 30, 45]),
    );
    expect(parseCron("0-30/10 * * * *").fields!.minute).toEqual(
      new Set([0, 10, 20, 30]),
    );
    expect(parseCron("5/15 * * * *").error).toContain("step needs");
    expect(parseCron("*/0 * * * *").error).toContain("bad step");
  });

  test("comma lists and backwards range", () => {
    expect(parseCron("0,15,30,45 * * * *").fields!.minute).toEqual(
      new Set([0, 15, 30, 45]),
    );
    expect(parseCron("30-15 * * * *").error).toContain("backwards");
    expect(parseCron("0,,15 * * * *").error).toContain("empty");
  });

  test("month and dow names", () => {
    expect(parseCron("0 0 * jan,mar *").fields!.month).toEqual(new Set([1, 3]));
    expect(parseCron("0 0 * * mon-fri").fields!.dow).toEqual(
      new Set([1, 2, 3, 4, 5]),
    );
  });

  test("domAny/dowAny are true only for literal * (OR-rule driver)", () => {
    expect(parseCron("0 0 1 * 1").fields!.domAny).toBe(false);
    expect(parseCron("0 0 1 * 1").fields!.dowAny).toBe(false);
    expect(parseCron("0 0 * * 1").fields!.domAny).toBe(true);
    expect(parseCron("0 0 1 * *").fields!.dowAny).toBe(true);
  });
});

describe("tasks: nextCronFire (fake clock, UTC)", () => {
  const TZ = "UTC";

  test("next daily 06:00 strictly after the given time", () => {
    // Thu 12:00Z -> Fri 06:00Z
    expect(nextCronFire("0 6 * * *", NOW, TZ)).toBe(
      Date.parse("2026-09-11T06:00:00Z"),
    );
    // exactly on a slot -> the NEXT slot, not the same one
    expect(
      nextCronFire("0 6 * * *", Date.parse("2026-09-10T06:00:00Z"), TZ),
    ).toBe(Date.parse("2026-09-11T06:00:00Z"));
  });

  test("later slot the same day is found", () => {
    expect(nextCronFire("30 12 * * *", NOW, TZ)).toBe(
      Date.parse("2026-09-10T12:30:00Z"),
    );
  });

  test("sub-minute timestamps are aligned forward to the next minute", () => {
    // 12:00:45 -> scan starts 12:01, finds 12:30
    expect(
      nextCronFire("30 12 * * *", Date.parse("2026-09-10T12:00:45Z"), TZ),
    ).toBe(Date.parse("2026-09-10T12:30:00Z"));
  });

  test("dow-only: next Friday (2026-09-10 is a Thursday)", () => {
    expect(nextCronFire("0 6 * * fri", NOW, TZ)).toBe(
      Date.parse("2026-09-11T06:00:00Z"),
    );
  });

  test("dom/dow OR rule: matches 13th OR Friday", () => {
    // "0 0 13 * 5": from Thu 2026-09-10 -> Fri 2026-09-11 00:00Z (dow hit)
    expect(nextCronFire("0 0 13 * 5", NOW, TZ)).toBe(
      Date.parse("2026-09-11T00:00:00Z"),
    );
    // from Sat 2026-09-12 00:00Z (strictly after): next 13th is Sun
    // 2026-09-13 (dom hit) — beats the next Friday (18th)
    expect(
      nextCronFire("0 0 13 * 5", Date.parse("2026-09-12T00:00:00Z"), TZ),
    ).toBe(Date.parse("2026-09-13T00:00:00Z"));
  });

  test("dom-restricted: 31st only (September has no 31st)", () => {
    // from 2026-09-10 -> 2026-10-31
    expect(nextCronFire("0 0 31 * *", NOW, TZ)).toBe(
      Date.parse("2026-10-31T00:00:00Z"),
    );
  });

  test("impossible date: 0 0 31 4 * is null within the cap", () => {
    expect(nextCronFire("0 0 31 4 *", NOW, TZ, 366 * 24 * 60)).toBeNull();
    // ...and the default 5y cap also gives up (bounded scan)
    expect(nextCronFire("0 0 31 4 *", NOW, TZ)).toBeNull();
  });

  test("leap day: 0 0 29 2 * fires 2028-02-29", () => {
    expect(nextCronFire("0 0 29 2 *", NOW, TZ)).toBe(
      Date.parse("2028-02-29T00:00:00Z"),
    );
  });

  test("custom timezone: Melbourne (AEST, UTC+10 in September)", () => {
    // 2026-09-10T00:00Z = 10:00 AEST -> next local 06:00 = 20:00Z same day
    expect(
      nextCronFire(
        "0 6 * * *",
        Date.parse("2026-09-10T00:00:00Z"),
        "Australia/Melbourne",
      ),
    ).toBe(Date.parse("2026-09-10T20:00:00Z"));
  });

  test("unknown tz -> null", () => {
    expect(nextCronFire("0 6 * * *", NOW, "Not/AZone")).toBeNull();
  });

  test("cap is honored: tiny cap can miss the next fire", () => {
    // next daily fire is 18h away; a 10-minute cap finds nothing
    expect(nextCronFire("0 6 * * *", NOW, TZ, 10)).toBeNull();
    expect(CRON_CAP_MINUTES).toBe(5 * 366 * 1440);
  });
});

describe("tasks: parseTaskSpec (fake clock)", () => {
  test("prompt is required", () => {
    expect(parseTaskSpec({ minutes: 5 }, NOW).error).toContain("prompt");
    expect(
      parseTaskSpec({ prompt: "  ", cron: "0 6 * * *" }, NOW).error,
    ).toContain("prompt");
  });

  test("exactly one of minutes/at/cron", () => {
    expect(
      parseTaskSpec(
        { prompt: "x", minutes: 5, at: "2026-09-11T00:00:00Z" },
        NOW,
      ).error,
    ).toContain("exactly one");
    expect(
      parseTaskSpec(
        { prompt: "x", cron: "0 6 * * *", at: "2026-09-11T00:00:00Z" },
        NOW,
      ).error,
    ).toContain("exactly one");
    expect(parseTaskSpec({ prompt: "x" }, NOW).error).toContain("exactly one");
  });

  test("minutes -> one-shot 'at' spec", () => {
    const r = parseTaskSpec({ prompt: "check CI", minutes: 30 }, NOW);
    expect(r.spec).toMatchObject({
      kind: "at",
      atMs: NOW + 30 * 60000,
      nextFireAt: NOW + 30 * 60000,
    });
  });

  test("minutes bounds", () => {
    expect(parseTaskSpec({ prompt: "x", minutes: 0 }, NOW).error).toContain(
      "greater than 0",
    );
    expect(
      parseTaskSpec({ prompt: "x", minutes: MAX_WAKE_MS / 60000 + 1 }, NOW)
        .error,
    ).toContain("too large");
    const ok = parseTaskSpec(
      { prompt: "x", minutes: MAX_WAKE_MS / 60000 },
      NOW,
    );
    expect(ok.spec).toBeDefined();
  });

  test("at -> one-shot 'at' spec; past/invalid/too far rejected", () => {
    const r = parseTaskSpec({ prompt: "x", at: "2026-09-10T15:00:00Z" }, NOW);
    expect(r.spec).toMatchObject({
      kind: "at",
      atMs: Date.parse("2026-09-10T15:00:00Z"),
    });
    expect(
      parseTaskSpec({ prompt: "x", at: "2026-09-09T15:00:00Z" }, NOW).error,
    ).toContain("future");
    expect(parseTaskSpec({ prompt: "x", at: "tomorrow" }, NOW).error).toContain(
      "invalid at",
    );
    expect(
      parseTaskSpec(
        { prompt: "x", at: new Date(NOW + MAX_WAKE_MS + 1000).toISOString() },
        NOW,
      ).error,
    ).toContain("too far out");
  });

  test("cron -> recurring spec with computed first fire", () => {
    const r = parseTaskSpec(
      { prompt: "fleet check", cron: "0 6 * * *", tz: "UTC" },
      NOW,
    );
    expect(r.spec).toMatchObject({
      kind: "cron",
      cron: "0 6 * * *",
      tz: "UTC",
      nextFireAt: Date.parse("2026-09-11T06:00:00Z"),
    });
  });

  test("invalid cron / impossible cron -> error", () => {
    expect(
      parseTaskSpec({ prompt: "x", cron: "61 6 * * *" }, NOW).error,
    ).toContain("invalid cron");
    expect(
      parseTaskSpec({ prompt: "x", cron: "0 0 31 4 *" }, NOW).error,
    ).toContain("does not fire within 5 years");
  });

  test("tz is validated for any kind; unknown tz -> error", () => {
    expect(
      parseTaskSpec({ prompt: "x", minutes: 5, tz: "Not/AZone" }, NOW).error,
    ).toContain("unknown timezone");
    // tz on an 'at' spec is valid input (it just does not apply)
    const r = parseTaskSpec(
      { prompt: "x", at: "2026-09-10T15:00:00Z", tz: "UTC" },
      NOW,
    );
    expect(r.spec).toBeDefined();
  });
});

describe("tasks: state file + lifecycle (fake clock, tmp home)", () => {
  let tmp = "";

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "piscord-tasks-"));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test("scheduleTask + loadTasks roundtrip (both kinds)", () => {
    const at = scheduleTask({
      channelId: "ch1",
      channelName: "Test",
      prompt: "check the build",
      spec: {
        kind: "at",
        atMs: NOW + 120 * 60000,
        nextFireAt: NOW + 120 * 60000,
      },
      home: tmp,
      now: NOW,
    });
    const cron = scheduleTask({
      channelId: "ch2",
      prompt: "run the fleet check",
      spec: {
        kind: "cron",
        cron: "0 6 * * *",
        tz: "UTC",
        nextFireAt: Date.parse("2026-09-11T06:00:00Z"),
      },
      home: tmp,
      now: NOW + 1,
    });
    expect(fs.existsSync(tasksPath(tmp))).toBe(true);
    const loaded = loadTasks(tmp);
    expect(loaded).toHaveLength(2);
    expect(loaded.find((t) => t.id === at.id)).toMatchObject({
      channelId: "ch1",
      channelName: "Test",
      prompt: "check the build",
      kind: "at",
      atMs: NOW + 120 * 60000,
      nextFireAt: NOW + 120 * 60000,
      status: "pending",
    });
    expect(loaded.find((t) => t.id === cron.id)).toMatchObject({
      channelId: "ch2",
      kind: "cron",
      cron: "0 6 * * *",
      tz: "UTC",
      nextFireAt: Date.parse("2026-09-11T06:00:00Z"),
      status: "pending",
    });
  });

  test("corrupt or missing file -> empty list", () => {
    expect(loadTasks(tmp)).toHaveLength(0);
    fs.mkdirSync(path.dirname(tasksPath(tmp)), { recursive: true });
    fs.writeFileSync(tasksPath(tmp), "{ not json");
    expect(loadTasks(tmp)).toHaveLength(0);
    fs.writeFileSync(tasksPath(tmp), JSON.stringify({ noTasks: true }));
    expect(loadTasks(tmp)).toHaveLength(0);
  });

  test("cancelTask removes by id; false for unknown id", () => {
    const t = scheduleTask({
      channelId: "ch1",
      prompt: "x",
      spec: { kind: "at", atMs: NOW + 60000, nextFireAt: NOW + 60000 },
      home: tmp,
      now: NOW,
    });
    expect(cancelTask("nope", tmp)).toBe(false);
    expect(cancelTask(t.id, tmp)).toBe(true);
    expect(loadTasks(tmp)).toHaveLength(0);
    expect(cancelTask(t.id, tmp)).toBe(false);
  });

  test("markTaskClaimed; claimed task is not due until stale", () => {
    const t = scheduleTask({
      channelId: "ch1",
      prompt: "x",
      spec: { kind: "at", atMs: NOW - 1000, nextFireAt: NOW - 1000 },
      home: tmp,
      now: NOW - 2000,
    });
    expect(dueTasks("ch1", NOW, tmp).map((x) => x.id)).toEqual([t.id]);
    markTaskClaimed(t.id, NOW, tmp);
    expect(dueTasks("ch1", NOW, tmp)).toHaveLength(0);
    expect(loadTasks(tmp)[0]).toMatchObject({
      status: "claimed",
      claimedAt: NOW,
    });
    // stale claim (crash between claim and completion) -> due again
    expect(
      dueTasks("ch1", NOW + CLAIM_TTL_MS + 1, tmp).map((x) => x.id),
    ).toEqual([t.id]);
  });

  test("dueTasks filters by channel", () => {
    scheduleTask({
      channelId: "ch1",
      prompt: "x",
      spec: { kind: "at", atMs: NOW - 1000, nextFireAt: NOW - 1000 },
      home: tmp,
      now: NOW - 2000,
    });
    expect(dueTasks("ch1", NOW, tmp)).toHaveLength(1);
    expect(dueTasks("ch2", NOW, tmp)).toHaveLength(0);
  });

  test("completeTask: one-shot is removed (bounded store)", () => {
    const t = scheduleTask({
      channelId: "ch1",
      prompt: "x",
      spec: { kind: "at", atMs: NOW - 1000, nextFireAt: NOW - 1000 },
      home: tmp,
      now: NOW - 2000,
    });
    markTaskClaimed(t.id, NOW - 500, tmp);
    expect(completeTask(t.id, NOW, tmp)).toBe(true);
    expect(loadTasks(tmp)).toHaveLength(0);
    expect(completeTask(t.id, NOW, tmp)).toBe(false);
  });

  test("completeTask: cron advances to the next slot strictly after now", () => {
    const fire = Date.parse("2026-09-10T06:00:00Z");
    const t = scheduleTask({
      channelId: "ch1",
      prompt: "daily",
      spec: {
        kind: "cron",
        cron: "0 6 * * *",
        tz: "UTC",
        nextFireAt: fire,
      },
      home: tmp,
      now: NOW - 2 * 86400000,
    });
    markTaskClaimed(t.id, fire, tmp);
    // delivered a few seconds into the slot
    const delivered = fire + 10000;
    expect(completeTask(t.id, delivered, tmp)).toBe(true);
    const done = loadTasks(tmp)[0];
    expect(done).toMatchObject({
      status: "pending",
      lastFiredAt: fire,
      nextFireAt: Date.parse("2026-09-11T06:00:00Z"),
    });
    expect(done.claimedAt).toBeUndefined();
    // not immediately due again
    expect(dueTasks("ch1", delivered + 1, tmp)).toHaveLength(0);
  });

  test("completeTask: repeated fires keep updating lastFiredAt", () => {
    const t = scheduleTask({
      channelId: "ch1",
      prompt: "daily",
      spec: {
        kind: "cron",
        cron: "0 6 * * *",
        tz: "UTC",
        nextFireAt: Date.parse("2026-09-10T06:00:00Z"),
      },
      home: tmp,
      now: NOW - 5 * 86400000,
    });
    markTaskClaimed(t.id, Date.parse("2026-09-10T06:00:00Z"), tmp);
    completeTask(t.id, Date.parse("2026-09-10T06:00:10Z"), tmp);
    markTaskClaimed(t.id, Date.parse("2026-09-11T06:00:00Z"), tmp);
    completeTask(t.id, Date.parse("2026-09-11T06:00:05Z"), tmp);
    const done = loadTasks(tmp)[0];
    expect(done.lastFiredAt).toBe(Date.parse("2026-09-11T06:00:00Z"));
    expect(done.nextFireAt).toBe(Date.parse("2026-09-12T06:00:00Z"));
  });

  test("missed slots while down are skipped, not replayed", () => {
    // daily 06:00, bridge was down from 05:00 on the 10th to 07:00 on the 12th
    const t = scheduleTask({
      channelId: "ch1",
      prompt: "daily",
      spec: {
        kind: "cron",
        cron: "0 6 * * *",
        tz: "UTC",
        nextFireAt: Date.parse("2026-09-10T06:00:00Z"),
      },
      home: tmp,
      now: NOW - 3 * 86400000,
    });
    const backUp = Date.parse("2026-09-12T07:00:00Z");
    markTaskClaimed(t.id, backUp, tmp);
    completeTask(t.id, backUp, tmp);
    const done = loadTasks(tmp)[0];
    // 10th + 11th slots missed -> next is the 13th, not a replay
    expect(done.nextFireAt).toBe(Date.parse("2026-09-13T06:00:00Z"));
    expect(done.lastFiredAt).toBe(Date.parse("2026-09-10T06:00:00Z"));
  });

  test("collectOrphanTaskTmpFiles removes crash-leftover tmp files only", () => {
    const dir = path.dirname(tasksPath(tmp));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(tasksPath(tmp), JSON.stringify({ tasks: [] }));
    const orphan = `${tasksPath(tmp)}.1234.5678.tmp`;
    fs.writeFileSync(orphan, "stale");
    fs.writeFileSync(path.join(dir, "unrelated.tmp"), "keep");
    expect(collectOrphanTaskTmpFiles(tmp)).toBe(1);
    expect(fs.existsSync(orphan)).toBe(false);
    expect(fs.existsSync(path.join(dir, "unrelated.tmp"))).toBe(true);
    expect(collectOrphanTaskTmpFiles(tmp)).toBe(0);
  });
});

describe("tasks: rendering", () => {
  test("formatTaskPrompt: one-shot and cron", () => {
    const at = {
      id: "a1",
      channelId: "ch1",
      prompt: "check the build",
      kind: "at" as const,
      atMs: Date.parse("2026-09-13T14:00:00Z"),
      createdAt: NOW,
      nextFireAt: Date.parse("2026-09-13T14:00:00Z"),
      status: "pending" as const,
    };
    expect(formatTaskPrompt(at)).toBe(
      "[task] one-shot task due 2026-09-13 14:00 UTC: check the build",
    );
    const cron = {
      ...at,
      id: "a2",
      kind: "cron" as const,
      atMs: undefined,
      cron: "0 6 * * *",
      tz: "Australia/Melbourne",
      nextFireAt: Date.parse("2026-09-13T20:00:00Z"),
    };
    expect(formatTaskPrompt(cron)).toBe(
      '[task] recurring task "0 6 * * *" (Australia/Melbourne) due 2026-09-13 20:00 UTC: check the build',
    );
  });

  test("formatTaskLine: upcoming one-shot with relative countdown", () => {
    const t = {
      id: "m1",
      channelId: "ch1",
      channelName: "Test",
      prompt: "check the build",
      kind: "at" as const,
      atMs: NOW + 2 * 3600000,
      createdAt: NOW,
      nextFireAt: NOW + 2 * 3600000,
      status: "pending" as const,
    };
    expect(formatTaskLine(t, undefined, NOW)).toBe(
      `- m1 · Test · at ${new Date(NOW + 2 * 3600000).toISOString()} · next ${new Date(
        NOW + 2 * 3600000,
      ).toISOString()} (in 2h) · check the build`,
    );
  });

  test("formatTaskLine: cron with tz, due and claimed states, long prompt", () => {
    const cron = {
      id: "m2",
      channelId: "ch1",
      prompt: "x".repeat(80),
      kind: "cron" as const,
      cron: "0 6 * * *",
      createdAt: NOW,
      nextFireAt: Date.parse("2026-09-13T06:00:00Z"),
      status: "pending" as const,
    };
    expect(formatTaskLine(cron, "Test", NOW)).toBe(
      `- m2 · Test · cron "0 6 * * *" (system tz) · next 2026-09-13T06:00:00.000Z ` +
        `(in 3d) · ${"x".repeat(60)}…`,
    );
    const due = { ...cron, nextFireAt: NOW - 1000 };
    expect(formatTaskLine(due, undefined, NOW)).toContain(" (due) ·");
    const claimed = { ...cron, status: "claimed" as const };
    expect(formatTaskLine(claimed, undefined, NOW)).toContain(" (claimed) ·");
  });
});
