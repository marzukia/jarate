import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  CLAIM_TTL_MS,
  MAX_WAKE_MS,
  cancelWake,
  dueWakes,
  formatDurationMs,
  formatWakePrompt,
  loadWakes,
  markClaimed,
  parseWakeAt,
  scheduleWake,
  saveWakes,
  wakesPath,
  type SleepWake,
} from "./sleep";

const NOW = Date.parse("2026-09-10T12:00:00Z");

describe("sleep: parseWakeAt", () => {
  test("minutes -> now + minutes", () => {
    expect(parseWakeAt({ minutes: 30 }, NOW).wakeAt).toBe(NOW + 30 * 60000);
  });

  test("numeric string minutes accepted", () => {
    expect(parseWakeAt({ minutes: "45" }, NOW).wakeAt).toBe(NOW + 45 * 60000);
  });

  test("ISO until -> parsed time", () => {
    const r = parseWakeAt({ until: "2026-09-10T15:00:00Z" }, NOW);
    expect(r.wakeAt).toBe(Date.parse("2026-09-10T15:00:00Z"));
  });

  test("both minutes and until -> error", () => {
    const r = parseWakeAt({ minutes: 5, until: "2026-09-10T15:00:00Z" }, NOW);
    expect(r.error).toContain("not both");
  });

  test("neither -> error", () => {
    expect(parseWakeAt({}, NOW).error).toContain("minutes");
  });

  test("invalid ISO -> error", () => {
    expect(parseWakeAt({ until: "tomorrow" }, NOW).error).toContain("invalid until");
  });

  test("past until -> error", () => {
    expect(parseWakeAt({ until: "2026-09-09T15:00:00Z" }, NOW).error).toContain("future");
  });

  test("zero/negative/non-numeric minutes -> error", () => {
    expect(parseWakeAt({ minutes: 0 }, NOW).error).toContain("greater than 0");
    expect(parseWakeAt({ minutes: -3 }, NOW).error).toContain("greater than 0");
    expect(parseWakeAt({ minutes: "abc" }, NOW).error).toContain("number");
  });

  test("minutes over 30d cap -> error", () => {
    expect(parseWakeAt({ minutes: MAX_WAKE_MS / 60000 + 1 }, NOW).error).toContain("too large");
  });
});

describe("sleep: state file", () => {
  let tmp = "";

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "piscord-sleep-"));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test("scheduleWake writes the file and loadWakes reads it back", () => {
    const wake = scheduleWake({ channelId: "ch1", channelName: "Test", wakeAt: NOW + 60000, note: "check CI", home: tmp, now: NOW });
    expect(fs.existsSync(wakesPath(tmp))).toBe(true);
    const loaded = loadWakes(tmp);
    expect(loaded).toHaveLength(1);
    expect(loaded[0]).toMatchObject({
      id: wake.id,
      channelId: "ch1",
      channelName: "Test",
      wakeAt: NOW + 60000,
      createdAt: NOW,
      note: "check CI",
      status: "pending",
    });
  });

  test("scheduleWake appends; ids are unique", () => {
    const a = scheduleWake({ channelId: "ch1", wakeAt: NOW + 60000, home: tmp, now: NOW });
    const b = scheduleWake({ channelId: "ch2", wakeAt: NOW + 120000, home: tmp, now: NOW + 1 });
    const loaded = loadWakes(tmp);
    expect(loaded).toHaveLength(2);
    expect(a.id).not.toBe(b.id);
  });

  test("cancelWake removes by id; false for unknown id", () => {
    const a = scheduleWake({ channelId: "ch1", wakeAt: NOW + 60000, home: tmp, now: NOW });
    expect(cancelWake("nope", tmp)).toBe(false);
    expect(cancelWake(a.id, tmp)).toBe(true);
    expect(loadWakes(tmp)).toHaveLength(0);
    expect(cancelWake(a.id, tmp)).toBe(false);
  });

  test("markClaimed sets status + claimedAt; pending claim is not due", () => {
    const a = scheduleWake({ channelId: "ch1", wakeAt: NOW - 1000, home: tmp, now: NOW - 2000 });
    expect(dueWakes("ch1", NOW, tmp).map(w => w.id)).toEqual([a.id]);
    markClaimed(a.id, NOW, tmp);
    expect(dueWakes("ch1", NOW, tmp)).toHaveLength(0);
    const loaded = loadWakes(tmp)[0];
    expect(loaded.status).toBe("claimed");
    expect(loaded.claimedAt).toBe(NOW);
  });

  test("stale claim re-due after CLAIM_TTL_MS (restart simulation: re-read the file)", () => {
    const a = scheduleWake({ channelId: "ch1", wakeAt: NOW - 1000, home: tmp, now: NOW - 2000 });
    markClaimed(a.id, NOW, tmp);
    // process died; new process re-reads the file at now+TTL+1ms
    expect(dueWakes("ch1", NOW + CLAIM_TTL_MS + 1, tmp).map(w => w.id)).toEqual([a.id]);
  });

  test("dueWakes only matches the channel", () => {
    scheduleWake({ channelId: "ch1", wakeAt: NOW - 1000, home: tmp, now: NOW - 2000 });
    scheduleWake({ channelId: "ch2", wakeAt: NOW - 1000, home: tmp, now: NOW - 2000 });
    expect(dueWakes("ch1", NOW, tmp)).toHaveLength(1);
    expect(dueWakes("ch2", NOW, tmp)).toHaveLength(1);
    expect(dueWakes("ch3", NOW, tmp)).toHaveLength(0);
  });

  test("future wake is not due", () => {
    scheduleWake({ channelId: "ch1", wakeAt: NOW + 60000, home: tmp, now: NOW });
    expect(dueWakes("ch1", NOW, tmp)).toHaveLength(0);
  });

  test("corrupt file -> empty list; missing file -> empty list", () => {
    expect(loadWakes(tmp)).toHaveLength(0);
    fs.mkdirSync(path.dirname(wakesPath(tmp)), { recursive: true });
    fs.writeFileSync(wakesPath(tmp), "{not json");
    expect(loadWakes(tmp)).toHaveLength(0);
  });

  test("loadWakes drops entries missing required fields", () => {
    saveWakes([
      { id: "x", channelId: "c", wakeAt: NOW, createdAt: NOW, status: "pending" } as SleepWake,
      { id: "" } as unknown as SleepWake,
      { id: "y", channelId: "c", wakeAt: "nope", createdAt: NOW, status: "pending" } as unknown as SleepWake,
    ], tmp);
    const loaded = loadWakes(tmp);
    expect(loaded).toHaveLength(1);
    expect(loaded[0].id).toBe("x");
  });
});

describe("sleep: wake prompt", () => {
  test("includes until, slept duration, and note", () => {
    const wake: SleepWake = {
      id: "a1",
      channelId: "ch1",
      wakeAt: Date.parse("2026-09-10T15:00:00Z"),
      createdAt: Date.parse("2026-09-10T14:30:00Z"),
      status: "pending",
      note: "check the deploy",
    };
    const text = formatWakePrompt(wake, Date.parse("2026-09-10T15:00:00Z"));
    expect(text).toContain("Woke after sleeping until 2026-09-10 15:00 UTC");
    expect(text).toContain("slept 30m");
    expect(text).toContain("Note: check the deploy");
    expect(text).toContain("Continue the work you were waiting for.");
  });

  test("no note line when note is absent", () => {
    const wake: SleepWake = {
      id: "a2", channelId: "ch1",
      wakeAt: NOW + 3600000, createdAt: NOW, status: "pending",
    };
    expect(formatWakePrompt(wake, NOW + 3600000)).not.toContain("Note:");
  });

  test("formatDurationMs", () => {
    expect(formatDurationMs(30 * 60000)).toBe("30m");
    expect(formatDurationMs(2 * 3600000)).toBe("2h");
    expect(formatDurationMs(26 * 3600000)).toBe("1d");
    expect(formatDurationMs(1)).toBe("1m");
  });
});
