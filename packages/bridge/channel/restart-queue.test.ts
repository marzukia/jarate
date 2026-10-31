import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  type BgScanChannel,
  collectRewakeOrphans,
  loadRewakeQueue,
  REWAKE_DELIVERED_CAP,
  REWAKE_DELIVERED_META_CAP,
  REWAKE_LOOKBACK_DEFAULT,
  REWAKE_LOOKBACK_ENV,
  REWAKE_LOOKBACK_MAX,
  REWAKE_SCAN_MAX_AGE_MS,
  type RewakePendingEntry,
  readSessionPrompts,
  rewakeAddPending,
  rewakeClearPending,
  rewakeCommitDelivered,
  rewakeLookbackBound,
  rewakePending,
  rewakeQueuePath,
  rewakeRemovePending,
  rewakeSetPendingAck,
  rewakeUnpersisted,
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

// the 2026-10-21 de-prefix shape: content "" + one embed whose author
// starts pi-bg (the bridge-built body is the serialized embed)
const msg = (
  id: string,
  body = `<embed>\nAuthor: pi-bg worker \u00b7 ${id}\nTitle: worker \u00b7 OK\ntask ${id} done\n</embed>`,
): ChannelMessage => ({
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
    const edited = {
      ...msg("m1"),
      body: "<embed>\nAuthor: pi-bg worker \u00b7 m1\nTitle: worker \u00b7 OK\ntask m1 done EDITED\n</embed>",
    };
    rewakeUpdatePendingMsg(dir, "ch1", "m1", edited);
    const file = loadRewakeQueue(dir, "ch1");
    expect(file.pending).toHaveLength(1);
    expect(file.pending[0].msg.body).toBe(
      "<embed>\nAuthor: pi-bg worker \u00b7 m1\nTitle: worker \u00b7 OK\ntask m1 done EDITED\n</embed>",
    );
    expect(file.pending[0].queuedAt).toBe(1000); // FIFO position kept
  });

  test("set pending ack mirrors the ack id into the file (live restart path, index.ts queueInLine)", () => {
    rewakeAddPending(dir, "ch1", entry("m1"));
    rewakeSetPendingAck(dir, "ch1", "m1", "ack-1");
    const file = loadRewakeQueue(dir, "ch1");
    expect(file.pending).toHaveLength(1);
    expect(file.pending[0].ackId).toBe("ack-1");
    expect(file.pending[0].queuedAt).toBe(1000); // FIFO position kept
    const p = rewakeQueuePath(dir, "ch1");
    const once = fs.readFileSync(p, "utf8");
    rewakeSetPendingAck(dir, "ch1", "m1", "ack-1"); // same id: no write
    expect(fs.readFileSync(p, "utf8")).toBe(once);
    rewakeSetPendingAck(dir, "ch1", "nope", "ack-x"); // absent id: no write
    expect(fs.readFileSync(p, "utf8")).toBe(once);
    // a restart with a fresh process sees the ack id on drain
    expect(rewakePending(dir, "ch1")[0].ackId).toBe("ack-1");
  });

  test("update pending msg of an absent id → no rewrite (no-op)", () => {
    rewakeAddPending(dir, "ch1", entry("m1"));
    const p = rewakeQueuePath(dir, "ch1");
    const before = fs.readFileSync(p, "utf8");
    rewakeUpdatePendingMsg(dir, "ch1", "nope", msg("nope"));
    expect(fs.readFileSync(p, "utf8")).toBe(before); // no-op: no write
  });

  test("delivered id cap is decoupled from the lookback clamp (#1083: sized to survive many restarts)", () => {
    // The old tie (LOOKBACK_MAX + 1 = 201) evicted an id 201+ commits
    // after its commit — a busy 3h window breaks it and the boot scan
    // re-queued the already-delivered post. The cap now outlives
    // realistic commit volume; meta detail is capped separately + small.
    expect(REWAKE_DELIVERED_CAP).toBeGreaterThan(REWAKE_LOOKBACK_MAX);
    expect(REWAKE_DELIVERED_CAP).toBeGreaterThanOrEqual(5000);
    expect(REWAKE_DELIVERED_META_CAP).toBeLessThan(REWAKE_DELIVERED_CAP);
  });

  test("delivered meta is capped separately (REWAKE_DELIVERED_META_CAP) while ids keep the full horizon", () => {
    for (let i = 0; i < REWAKE_DELIVERED_META_CAP + 10; i++)
      rewakeCommitDelivered(dir, "ch1", `m${i}`, {
        prompt: `prompt ${i}`,
        msg: msg(`m${i}`),
        at: Date.now(),
        sf: `/tmp/s.jsonl`,
      });
    const file = loadRewakeQueue(dir, "ch1");
    // ids: all 60 kept (well under the 5,000 cap)
    expect(file.delivered.length).toBe(REWAKE_DELIVERED_META_CAP + 10);
    // meta: pruned to the cap, newest kept (oldest evicted)
    expect(Object.keys(file.deliveredMeta ?? {}).length).toBe(
      REWAKE_DELIVERED_META_CAP,
    );
    expect(file.deliveredMeta?.["m0"]).toBeUndefined(); // oldest evicted
    expect(file.deliveredMeta?.["m9"]).toBeUndefined(); // 10 oldest evicted
    expect(file.deliveredMeta?.["m10"]).toBeDefined(); // kept floor
    expect(file.deliveredMeta?.[`m${REWAKE_DELIVERED_META_CAP + 9}`]).toBeDefined(); // newest kept
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
    // Seed an over-cap list directly (5,000+ file writes per test is
    // not the point — the splice happens at commit time).
    saveRewakeQueue(dir, "ch1", {
      v: 1,
      pending: [],
      delivered: Array.from({ length: REWAKE_DELIVERED_CAP + 5 }, (_, i) => `d${i}`),
    });
    rewakeCommitDelivered(dir, "ch1", `d${REWAKE_DELIVERED_CAP + 5}`);
    const file = loadRewakeQueue(dir, "ch1");
    expect(file.delivered.length).toBe(REWAKE_DELIVERED_CAP);
    expect(file.delivered[0]).toBe("d6"); // d0..d5 dropped
    expect(file.delivered.at(-1)).toBe(`d${REWAKE_DELIVERED_CAP + 5}`);
  });

  test("corrupt file (not JSON) → empty state, no throw (option 1 backstop)", () => {
    fs.writeFileSync(rewakeQueuePath(dir, "ch1"), "{not json");
    expect(loadRewakeQueue(dir, "ch1")).toEqual({
      v: 1,
      pending: [],
      delivered: [],
    });
  });

  test("saveRewakeQueue: atomic write leaves no tmp residue (shared pid+ts scheme)", () => {
    saveRewakeQueue(dir, "ch1", {
      v: 1,
      pending: [entry("m1")],
      delivered: [],
    });
    expect(fs.readdirSync(dir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
    expect(
      loadRewakeQueue(dir, "ch1").pending.map((p) => p.msg.messageId),
    ).toEqual(["m1"]);
  });

  test("saveRewakeQueue: I/O failure → false, orphan tmp left in the shared scheme", () => {
    fs.mkdirSync(rewakeQueuePath(dir, "ch1")); // rename over a dir fails
    expect(
      saveRewakeQueue(dir, "ch1", { v: 1, pending: [], delivered: [] }),
    ).toBe(false);
    const residue = fs
      .readdirSync(dir)
      .filter((f) => f.startsWith("rewake-ch1.json.") && f.endsWith(".tmp"));
    expect(residue).toHaveLength(1);
  });

  test("collectRewakeOrphans: sweeps <file>.<pid>.<ts>.tmp only; null stateDir → 0", () => {
    saveRewakeQueue(dir, "ch1", { v: 1, pending: [], delivered: [] });
    fs.writeFileSync(path.join(dir, "rewake-ch1.json.42.1234.tmp"), "stale");
    fs.writeFileSync(path.join(dir, "rewake-ch1.json.other.tmp"), "stale");
    fs.writeFileSync(path.join(dir, "unrelated.tmp"), "keep");
    fs.writeFileSync(path.join(dir, "rewake-ch2.json.42.1234.tmp"), "other ch");
    expect(collectRewakeOrphans(dir, "ch1")).toBe(2);
    expect(collectRewakeOrphans(null, "ch1")).toBe(0);
    expect(collectRewakeOrphans(undefined, "ch1")).toBe(0);
    expect(collectRewakeOrphans(dir, "ch1")).toBe(0); // idempotent
    expect(fs.existsSync(path.join(dir, "unrelated.tmp"))).toBe(true);
    expect(fs.existsSync(path.join(dir, "rewake-ch2.json.42.1234.tmp"))).toBe(
      true,
    );
    expect(fs.existsSync(rewakeQueuePath(dir, "ch1"))).toBe(true);
  });

  test("collectRewakeOrphans: empty dir → 0, no throw", () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), "rewake-empty-"));
    expect(collectRewakeOrphans(empty, "ch1")).toBe(0);
    fs.rmSync(empty, { recursive: true, force: true });
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

  // A raw machine-wake webhook post (the 2026-10-21 de-prefix shape):
  // webhook_id set + empty content + one embed whose author starts
  // pi-bg.
  const bgPost = (id: string, ts: string) => ({
    id,
    webhook_id: "1546769099252695103",
    content: "",
    embeds: [
      {
        author: { name: `pi-bg worker \u00b7 ${id}` },
        title: "worker \u00b7 OK",
        description: `task ${id} done`,
      },
    ],
    timestamp: ts,
    author: { id: "1546769099252695103", bot: true, username: "beepy" },
  });
  // A legacy (pre-2026-10-21) machine-wake post: webhook_id set +
  // [bg:-prefixed content, no embed — in-flight history + dead-letter
  // re-posts keep this shape for one release.
  const legacyBgPost = (id: string, ts: string) => ({
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

  test("undelivered machine-wake webhook post (Author: pi-bg) in the window → re-queued (file + callback)", async () => {
    const now = new Date().toISOString();
    const { r, requeued } = await runScan([bgPost("1001", now)]);
    expect(r).toEqual({ scanned: 1, requeued: 1 });
    expect(requeued[0].msg.messageId).toBe("1001");
    expect(requeued[0].msg.body).toBe(
      "<embed>\nAuthor: pi-bg worker \u00b7 1001\nTitle: worker \u00b7 OK\ntask 1001 done\n</embed>",
    );
    expect(rewakePending(dir, "ch1").map((p) => p.msg.messageId)).toEqual([
      "1001",
    ]);
  });

  test("migration arm: legacy [bg: content post is re-queued (one release)", async () => {
    const now = new Date().toISOString();
    const { r, requeued } = await runScan([legacyBgPost("4001", now)]);
    expect(r).toEqual({ scanned: 1, requeued: 1 });
    expect(requeued[0].msg.messageId).toBe("4001");
    expect(requeued[0].msg.body).toBe("[bg:worker:OK] 4001"); // verbatim
  });

  test("embed-only pi-bg callback (content='') is a machine wake → re-queued (incident shape)", async () => {
    const now = new Date().toISOString();
    const { r, requeued } = await runScan([embedCallback("2001", now)]);
    expect(r.requeued).toBe(1);
    expect(requeued[0].msg.messageId).toBe("2001");
    // The bridge-built body: serialized embed, no [bg: prefix anywhere.
    expect(requeued[0].msg.body).toContain("Author: pi-bg ticket");
  });

  test("delivered set dedupes: an already-committed machine-wake post is NOT re-queued", async () => {
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

// ─── #306 amnesia: accepted-but-unpersisted resurrection ────────────────

describe("restart-queue #306 amnesia (accepted-but-unpersisted)", () => {
  let dir: string;
  // #307 F1 /tmp hygiene: the session file lives in the per-test mkdtemp dir
  // (hydrogen's /tmp is shared across agent test runs; a bare name collides
  // and lingers - the 2026-10-29 stale-file class). afterEach's rmSync(dir)
  // covers cleanup.
  let SESSION = "";
  const NOW = Date.parse("2026-10-29T06:00:00Z");

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "piscord-amnesia-"));
    SESSION = path.join(dir, "session-abc.jsonl");
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const meta = (
    id: string,
    over: Partial<import("./restart-queue").DeliveredMeta> = {},
  ): import("./restart-queue").DeliveredMeta => ({
    prompt: `ctx\n\nbody ${id}`,
    msg: msg(id),
    at: NOW,
    sf: SESSION,
    ...over,
  });

  // Write a pi session file (JSONL) with the given custom_message prompts.
  const writeSession = (prompts: string[]) => {
    const lines = prompts.map((p) =>
      JSON.stringify({ type: "custom_message", content: p }),
    );
    fs.writeFileSync(SESSION, lines.join("\n") + "\n");
  };

  test("accepted but NOT persisted → re-queued (the amnesia gap)", () => {
    rewakeCommitDelivered(dir, "ch1", "100", meta("100"));
    // The session file has a DIFFERENT prompt — 100 was never persisted.
    writeSession(["ctx\n\nsome other body"]);
    const out = rewakeUnpersisted(dir, "ch1", SESSION, NOW);
    expect(out.map((e) => e.id)).toEqual(["100"]);
    expect(out[0].msg.messageId).toBe("100");
  });

  test("accepted AND persisted → NOT re-queued (answered in the session)", () => {
    rewakeCommitDelivered(dir, "ch1", "100", meta("100"));
    // The session file HAS 100's exact prompt — pi persisted it.
    writeSession(["ctx\n\nbody 100"]);
    const out = rewakeUnpersisted(dir, "ch1", SESSION, NOW);
    expect(out).toEqual([]);
  });

  test("same-file guard: a /new session (different file) re-queues nothing", () => {
    rewakeCommitDelivered(dir, "ch1", "100", meta("100"));
    writeSession([]); // the NEW session file is empty
    // Check against a DIFFERENT session file than the one committed against.
    const out = rewakeUnpersisted(
      dir,
      "ch1",
      path.join(dir, "session-NEW.jsonl"),
      NOW,
    );
    expect(out).toEqual([]);
  });

  test("age guard: a commit older than 24h is never re-queued", () => {
    const stale = NOW - 25 * 3_600_000;
    rewakeCommitDelivered(dir, "ch1", "100", meta("100", { at: stale }));
    writeSession([]);
    const out = rewakeUnpersisted(dir, "ch1", SESSION, NOW);
    expect(out).toEqual([]);
  });

  test("no commit metadata (pre-field file) → nothing to check, no re-queue", () => {
    rewakeCommitDelivered(dir, "ch1", "100"); // no meta
    writeSession([]);
    const out = rewakeUnpersisted(dir, "ch1", SESSION, NOW);
    expect(out).toEqual([]);
  });

  test("no session file (unknown) → no re-queue (conservative)", () => {
    rewakeCommitDelivered(dir, "ch1", "100", meta("100"));
    const out = rewakeUnpersisted(dir, "ch1", null, NOW);
    expect(out).toEqual([]);
  });

  test("readSessionPrompts: custom_message + user-role messages", () => {
    const f = path.join(dir, "s.jsonl");
    fs.writeFileSync(
      f,
      [
        JSON.stringify({ type: "custom_message", content: "prompt A" }),
        JSON.stringify({
          type: "message",
          message: { role: "user", content: "user text" },
        }),
        JSON.stringify({
          type: "message",
          message: {
            role: "user",
            content: [{ type: "text", text: "block1" }, "block2"],
          },
        }),
        JSON.stringify({ type: "message", message: { role: "assistant" } }),
        "not json",
      ].join("\n") + "\n",
    );
    const prompts = readSessionPrompts(f);
    expect(prompts.has("prompt A")).toBe(true);
    expect(prompts.has("user text")).toBe(true);
    expect(prompts.has("block1block2")).toBe(true);
    expect(prompts.size).toBe(3); // assistant + the bad line are not prompts
  });

  test("unreadable session file → empty set (no re-queue, never throws)", () => {
    rewakeCommitDelivered(dir, "ch1", "100", meta("100"));
    const out = rewakeUnpersisted(
      dir,
      "ch1",
      path.join(dir, "does-not-exist.jsonl"),
      NOW,
    );
    expect(out).toEqual([]);
  });
});
