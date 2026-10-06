import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  type BgScanChannel,
  loadRewakeQueue,
  REWAKE_DELIVERED_CAP,
  REWAKE_LOOKBACK_DEFAULT,
  REWAKE_LOOKBACK_ENV,
  REWAKE_LOOKBACK_MAX,
  REWAKE_SCAN_MAX_AGE_MS,
  type RewakePendingEntry,
  rewakeAddPending,
  rewakeClearPending,
  rewakeCommitDelivered,
  rewakeLookbackBound,
  rewakePending,
  rewakeQueuePath,
  rewakeRemovePending,
  rewakeUpdatePendingMsg,
  saveRewakeQueue,
  scanUndeliveredBgInbounds,
} from "./restart-queue";
import type { ChannelConfig, ChannelMessage } from "./types";

const CH: ChannelConfig = {
  id: "ch1",
  name: "Test",
  type: "discord",
  enabled: true,
  channel: "111",
  botToken: "tok1",
};

const msg = (id: string, body = `[bg:worker:OK] ${id}`): ChannelMessage => ({
  channelId: "ch1",
  channelName: "Test",
  channelType: "discord",
  messageId: id,
  from: "Beepy",
  fromId: "1546769099252695103",
  body,
  timestamp: new Date().toISOString(),
  attachments: [],
  isRoom: false,
});

const entry = (id: string, queuedAt = 1000): RewakePendingEntry => ({
  msg: msg(id),
  queuedAt,
});

describe("restart-queue state file (#180)", () => {
  let dir = "";

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "rewake-test-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("queue → file on disk; re-queue same id → no duplicate", () => {
    rewakeAddPending(dir, "ch1", entry("m1"));
    rewakeAddPending(dir, "ch1", entry("m1"));
    const file = loadRewakeQueue(dir, "ch1");
    expect(file.pending.map((p) => p.msg.messageId)).toEqual(["m1"]);
  });

  test("commit (sendToPi parity) → pending pruned, id in delivered set", () => {
    rewakeAddPending(dir, "ch1", entry("m1"));
    rewakeCommitDelivered(dir, "ch1", "m1");
    const file = loadRewakeQueue(dir, "ch1");
    expect(file.pending).toEqual([]);
    expect(file.delivered).toEqual(["m1"]);
  });

  test("commit of an already-delivered id → no rewrite (contents unchanged)", () => {
    rewakeCommitDelivered(dir, "ch1", "m1");
    const p = rewakeQueuePath(dir, "ch1");
    const once = fs.readFileSync(p, "utf8");
    rewakeCommitDelivered(dir, "ch1", "m1");
    expect(fs.readFileSync(p, "utf8")).toBe(once);
  });

  test("remove pending → pruned; remove absent → no rewrite", () => {
    rewakeAddPending(dir, "ch1", entry("m1"));
    const p = rewakeQueuePath(dir, "ch1");
    const before = fs.readFileSync(p, "utf8");
    rewakeRemovePending(dir, "ch1", "nope");
    expect(fs.readFileSync(p, "utf8")).toBe(before); // no-op: no write
    rewakeRemovePending(dir, "ch1", "m1");
    expect(loadRewakeQueue(dir, "ch1").pending).toEqual([]);
  });

  test("update pending msg rewrites the file entry (F2: edit survives a restart)", () => {
    rewakeAddPending(dir, "ch1", entry("m1"));
    const edited = { ...msg("m1"), body: "[bg:worker:OK] m1 EDITED" };
    rewakeUpdatePendingMsg(dir, "ch1", "m1", edited);
    const file = loadRewakeQueue(dir, "ch1");
    expect(file.pending).toHaveLength(1);
    expect(file.pending[0].msg.body).toBe("[bg:worker:OK] m1 EDITED");
    expect(file.pending[0].queuedAt).toBe(1000); // FIFO position kept
  });

  test("update pending msg of an absent id → no rewrite (no-op)", () => {
    rewakeAddPending(dir, "ch1", entry("m1"));
    const p = rewakeQueuePath(dir, "ch1");
    const before = fs.readFileSync(p, "utf8");
    rewakeUpdatePendingMsg(dir, "ch1", "nope", msg("nope"));
    expect(fs.readFileSync(p, "utf8")).toBe(before); // no-op: no write
  });

  test("delivered cap is tied to the lookback clamp (F3: margin at the edge)", () => {
    expect(REWAKE_DELIVERED_CAP).toBe(REWAKE_LOOKBACK_MAX + 1);
  });

  test("clear pending empties the line but keeps the delivered set", () => {
    rewakeAddPending(dir, "ch1", entry("m1"));
    rewakeCommitDelivered(dir, "ch1", "m2");
    rewakeClearPending(dir, "ch1");
    const file = loadRewakeQueue(dir, "ch1");
    expect(file.pending).toEqual([]);
    expect(file.delivered).toEqual(["m2"]);
    // clearing an already-empty line writes nothing
    const p = rewakeQueuePath(dir, "ch1");
    const once = fs.readFileSync(p, "utf8");
    rewakeClearPending(dir, "ch1");
    expect(fs.readFileSync(p, "utf8")).toBe(once);
  });

  test("delivered set is capped (oldest drop off) — a restart with an empty queue writes no file at all", () => {
    // No file exists before the first state change.
    expect(fs.existsSync(rewakeQueuePath(dir, "ch1"))).toBe(false);
    for (let i = 0; i < REWAKE_DELIVERED_CAP + 5; i++)
      rewakeCommitDelivered(dir, "ch1", `d${i}`);
    const file = loadRewakeQueue(dir, "ch1");
    expect(file.delivered.length).toBe(REWAKE_DELIVERED_CAP);
    expect(file.delivered[0]).toBe("d5"); // d0..d4 dropped
    expect(file.delivered.at(-1)).toBe(`d${REWAKE_DELIVERED_CAP + 4}`);
  });

  test("corrupt file (not JSON) → empty state, no throw (option 1 backstop)", () => {
    fs.writeFileSync(rewakeQueuePath(dir, "ch1"), "{not json");
    expect(loadRewakeQueue(dir, "ch1")).toEqual({
      v: 1,
      pending: [],
      delivered: [],
    });
  });

  test("partial file (wrong section shapes) → per-section fallback", () => {
    fs.writeFileSync(
      rewakeQueuePath(dir, "ch1"),
      JSON.stringify({ pending: "nope", delivered: [123, "d1", null] }),
    );
    const file = loadRewakeQueue(dir, "ch1");
    expect(file.pending).toEqual([]);
    expect(file.delivered).toEqual(["d1"]);
  });

  test("pending entry with a malformed msg is dropped, good ones kept", () => {
    saveRewakeQueue(dir, "ch1", {
      v: 1,
      pending: [
        { msg: { messageId: "" }, queuedAt: 1 },
        { msg: "not-an-object", queuedAt: 2 },
        entry("m1"),
      ],
      delivered: [],
    } as any);
    expect(rewakePending(dir, "ch1").map((p) => p.msg.messageId)).toEqual([
      "m1",
    ]);
  });

  test("null/undefined stateDir → every op is a no-op (dev runs, tests)", () => {
    rewakeAddPending(null, "ch1", entry("m1"));
    rewakeAddPending(undefined, "ch1", entry("m1"));
    rewakeRemovePending(null, "ch1", "m1");
    rewakeClearPending(undefined, "ch1");
    rewakeCommitDelivered(null, "ch1", "m1");
    rewakeUpdatePendingMsg(null, "ch1", "m1", msg("m1"));
    rewakeUpdatePendingMsg(undefined, "ch1", "m1", msg("m1"));
    expect(rewakePending(undefined, "ch1")).toEqual([]);
  });

  describe("rewakeLookbackBound", () => {
    test("default when unset", () => {
      expect(rewakeLookbackBound({} as NodeJS.ProcessEnv)).toBe(
        REWAKE_LOOKBACK_DEFAULT,
      );
    });
    test("env override is honored", () => {
      expect(
        rewakeLookbackBound({
          [REWAKE_LOOKBACK_ENV]: "7",
        } as NodeJS.ProcessEnv),
      ).toBe(7);
    });
    test("clamped to [1, max]", () => {
      expect(
        rewakeLookbackBound({
          [REWAKE_LOOKBACK_ENV]: "0",
        } as NodeJS.ProcessEnv),
      ).toBe(REWAKE_LOOKBACK_DEFAULT);
      expect(
        rewakeLookbackBound({
          [REWAKE_LOOKBACK_ENV]: "-3",
        } as NodeJS.ProcessEnv),
      ).toBe(REWAKE_LOOKBACK_DEFAULT);
      expect(
        rewakeLookbackBound({
          [REWAKE_LOOKBACK_ENV]: "9999",
        } as NodeJS.ProcessEnv),
      ).toBe(REWAKE_LOOKBACK_MAX);
      expect(
        rewakeLookbackBound({
          [REWAKE_LOOKBACK_ENV]: "abc",
        } as NodeJS.ProcessEnv),
      ).toBe(REWAKE_LOOKBACK_DEFAULT);
    });
  });
});

describe("restart-queue option 1: bounded startup history scan", () => {
  let dir = "";

  // A raw [bg: webhook post: webhook_id set + [bg:-prefixed content.
  const bgPost = (id: string, ts: string) => ({
    id,
    webhook_id: "1546769099252695103",
    content: `[bg:worker:OK] ${id}`,
    timestamp: ts,
    author: { id: "1546769099252695103", bot: true, username: "beepy" },
  });
  // The incident shape: embed-only pi-bg callback (content = '').
  const embedCallback = (id: string, ts: string) => ({
    id,
    webhook_id: "1546769099252695103",
    content: "",
    embeds: [
      {
        author: { name: "pi-bg ticket · 20261006-040516-3580612" },
        title: "reviewer · PASS · 14m27s",
      },
    ],
    timestamp: ts,
    author: { id: "1546769099252695103", bot: true, username: "beepy" },
  });
  // A human message (no webhook_id) — including one quoting a callback.
  const humanPost = (id: string, content: string, ts: string) => ({
    id,
    content,
    timestamp: ts,
    author: { id: "108801968763305984", bot: false, global_name: "andy" },
  });

  const scanChannel = (over: Partial<BgScanChannel> = {}): BgScanChannel => ({
    config: CH,
    discordId: "111",
    cursor: "9000",
    token: "tok1",
    ...over,
  });

  const runScan = async (
    window: any[],
    over: Partial<Parameters<typeof scanUndeliveredBgInbounds>[0]> = {},
  ) => {
    const calls: string[] = [];
    const requeued: RewakePendingEntry[] = [];
    const r = await scanUndeliveredBgInbounds({
      stateDir: dir,
      channels: [scanChannel()],
      fetcher: async (_t, url) => {
        calls.push(url);
        return window;
      },
      requeue: (e) => {
        requeued.push(e);
        rewakeAddPending(dir, "ch1", e);
      },
      ...over,
    });
    return { r, calls, requeued };
  };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "rewake-scan-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("lookback bound is respected in the fetch (default + env override)", async () => {
    const now = new Date().toISOString();
    const { calls } = await runScan([bgPost("1001", now)]);
    expect(calls[0]).toBe(
      `/channels/111/messages?before=9000&limit=${REWAKE_LOOKBACK_DEFAULT}`,
    );
    const { calls: c2 } = await runScan([bgPost("1001", now)], {
      lookback: 5,
    });
    expect(c2[0]).toBe(`/channels/111/messages?before=9000&limit=5`);
  });

  test("undelivered [bg: webhook post in the window → re-queued (file + callback)", async () => {
    const now = new Date().toISOString();
    const { r, requeued } = await runScan([bgPost("1001", now)]);
    expect(r).toEqual({ scanned: 1, requeued: 1 });
    expect(requeued[0].msg.messageId).toBe("1001");
    expect(requeued[0].msg.body).toBe("[bg:worker:OK] 1001");
    expect(rewakePending(dir, "ch1").map((p) => p.msg.messageId)).toEqual([
      "1001",
    ]);
  });

  test("embed-only pi-bg callback (content='') is a machine wake → re-queued (incident shape)", async () => {
    const now = new Date().toISOString();
    const { r, requeued } = await runScan([embedCallback("2001", now)]);
    expect(r.requeued).toBe(1);
    expect(requeued[0].msg.messageId).toBe("2001");
    // The bridge-built body: serialized embed, no [bg: prefix anywhere.
    expect(requeued[0].msg.body).toContain("Author: pi-bg ticket");
  });

  test("delivered set dedupes: an already-committed [bg: post is NOT re-queued", async () => {
    const now = new Date().toISOString();
    rewakeCommitDelivered(dir, "ch1", "1001");
    const { r } = await runScan([bgPost("1001", now)]);
    expect(r).toEqual({ scanned: 1, requeued: 0 });
  });

  test("F1 secondary: an id committed mid-fetch (startup replay delivery) is NOT re-queued", async () => {
    const now = new Date().toISOString();
    // The fetch commits the id before it resolves — a startup replay /
    // wake-fail-kick delivery landing while the scan fetch is in flight.
    // The scan's dedupe must see the commit and skip the id (exactly once).
    const r = await scanUndeliveredBgInbounds({
      stateDir: dir,
      channels: [scanChannel()],
      fetcher: async (_t, _url) => {
        rewakeCommitDelivered(dir, "ch1", "1001");
        return [bgPost("1001", now)];
      },
      requeue: (e) => {
        rewakeAddPending(dir, "ch1", e);
      },
    });
    expect(r).toEqual({ scanned: 1, requeued: 0 });
    expect(rewakePending(dir, "ch1")).toEqual([]);
  });

  test("pending dedupes: a survived queued entry is NOT re-queued again", async () => {
    const now = new Date().toISOString();
    rewakeAddPending(dir, "ch1", entry("1001"));
    const { r } = await runScan([bgPost("1001", now)]);
    expect(r).toEqual({ scanned: 1, requeued: 0 });
  });

  test("non-bg human messages in the window are never re-queued (incl. quoting a callback)", async () => {
    const now = new Date().toISOString();
    const { r, requeued } = await runScan([
      humanPost("3001", "plain human message", now),
      humanPost(
        "3002",
        "<embed>\nAuthor: pi-bg ticket · 20261006-040516-3580612\n</embed>",
        now,
      ),
    ]);
    expect(r).toEqual({ scanned: 2, requeued: 0 });
    expect(requeued).toEqual([]);
  });

  test("the cursor message itself is skipped (already accounted for)", async () => {
    const now = new Date().toISOString();
    const { r } = await runScan([bgPost("9000", now)]); // id === cursor
    expect(r.requeued).toBe(0);
  });

  test("stale candidate (older than the 72h age guard) is skipped", async () => {
    const fresh = new Date().toISOString();
    const stale = new Date(
      Date.now() - REWAKE_SCAN_MAX_AGE_MS - 60_000,
    ).toISOString();
    const { r } = await runScan([bgPost("1001", stale), bgPost("1002", fresh)]);
    expect(r.requeued).toBe(1);
    expect(rewakePending(dir, "ch1").map((p) => p.msg.messageId)).toEqual([
      "1002",
    ]);
  });

  test("multiple candidates are re-queued oldest-first (snowflake order)", async () => {
    const now = new Date().toISOString();
    const { requeued } = await runScan([
      bgPost("1003", now),
      bgPost("1001", now),
      bgPost("1002", now),
    ]);
    expect(requeued.map((e) => e.msg.messageId)).toEqual([
      "1001",
      "1002",
      "1003",
    ]);
  });

  test("no cursor (fresh channel) → no fetch at all", async () => {
    const calls: string[] = [];
    const r = await scanUndeliveredBgInbounds({
      stateDir: dir,
      channels: [scanChannel({ cursor: null })],
      fetcher: async (_t, url) => {
        calls.push(url);
        return [];
      },
      requeue: () => {},
    });
    expect(r).toEqual({ scanned: 0, requeued: 0 });
    expect(calls).toEqual([]);
  });

  test("fetch failure (boot-time network down) → silent no-op, never throws", async () => {
    const r = await scanUndeliveredBgInbounds({
      stateDir: dir,
      channels: [scanChannel()],
      fetcher: async () => {
        throw new Error("ECONNREFUSED");
      },
      requeue: () => {},
    });
    expect(r).toEqual({ scanned: 0, requeued: 0 });
  });

  test("non-array fetch result (API oddity) → treated as empty window", async () => {
    const { r } = await runScan({ id: "out1" } as unknown as any[]);
    expect(r).toEqual({ scanned: 0, requeued: 0 });
  });
});
