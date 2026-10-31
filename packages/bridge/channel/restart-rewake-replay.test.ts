// #1083 regression: raw-restart re-delivery of an already-delivered
// restart-wake embed. The #180 option-1 startup history scan
// (scanUndeliveredBgInbounds) re-fetches up to N messages OLDER than
// the persisted cursor and re-queues any webhook post missing from the
// rewake file's delivered set. Pre-fix, that set was capped at 201
// (REWAKE_LOOKBACK_MAX + 1 — sized to the scan window, not to
// restarts-since) and empty when the file was lost/corrupt, while the
// #306 seen/seenWake sets (channel-state.json) were never consulted on
// the re-wake delivery path. A 3h25m-old embed passes the 72h age
// guard with 68h of margin.
//
// Ported from the #1083 investigation repro (4 cases: control /
// cap-eviction / file-loss / seen-not-consulted — all demonstrated the
// gap pre-fix) plus the two required proofs: fix A drops a seen
// webhook post (incl. a double-posted wake card via its wake key) and
// fix B raises the delivered-id horizon beyond 201 commits worth.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  loadChannelStateFile,
  type SeenState,
  seedSeenSets,
  wakeEmbedKey,
} from "./channel-state";
import {
  type BgScanChannel,
  loadRewakeQueue,
  rewakeCommitDelivered,
  saveRewakeQueue,
  scanUndeliveredBgInbounds,
} from "./restart-queue";

import type { ChannelConfig } from "./types";

const DISCORD_ID = "123456789012345678";
// the cursor is PAST the candidate: the normal poll is strictly
// after=<cursor>, so only the boot scan (before=<cursor>) can fetch it.
const CURSOR = "999999999999999999";
const CONFIG: ChannelConfig = {
  id: "ch1",
  name: "Replay",
  type: "discord",
  enabled: true,
  channel: DISCORD_ID,
  botToken: "tok1",
};

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "rewake-replay-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

// Pinned clock: 2026-10-31 08:00Z. The incident embed was 3h25m old.
const NOW = Date.parse("2026-10-31T08:00:00.000Z");
const T_3H25M = Date.parse("2026-10-31T04:35:00.000Z");

/** A webhook-posted (webhook_id set → isBgWebhook exempts it) machine
 *  wake post, 3h25m old (well inside the 72h age guard). */
const raw = (
  id: string | number,
  ts = T_3H25M,
  extra: Record<string, unknown> = {},
): Record<string, unknown> => ({
  id: String(id),
  webhook_id: "wh-1",
  timestamp: new Date(ts).toISOString(),
  ...extra,
});

const channels: BgScanChannel[] = [
  { config: CONFIG, discordId: DISCORD_ID, cursor: CURSOR, token: "tok1" },
];

async function scan(
  raws: Record<string, unknown>[],
  seenLookup?: (configId: string) => SeenState | null,
) {
  const requeued: string[] = [];
  const r = await scanUndeliveredBgInbounds({
    stateDir: dir,
    channels,
    fetcher: async () => raws,
    requeue: (e) => {
      requeued.push(e.msg.messageId);
    },
    seenLookup,
    now: NOW,
  });
  return { ...r, requeuedIds: requeued };
}

/** The boot-path seen seed: channel-state.json → seen state for the
 *  scan (keyed by Discord channel id). */
const seenFromDisk = (chId: string): SeenState | null =>
  chId === CONFIG.id
    ? seedSeenSets(loadChannelStateFile(dir), DISCORD_ID)
    : null;

const writeStateFile = (seen: string[], seenWake: string[]) => {
  fs.writeFileSync(
    path.join(dir, "channel-state.json"),
    JSON.stringify({
      cursors: { [DISCORD_ID]: CURSOR },
      channels: {},
      seen: { [DISCORD_ID]: seen },
      seenWake: { [DISCORD_ID]: seenWake },
    }),
  );
};

// One wake line shape (the #306 double-post target: same content, two
// message ids, one wake key - the 2026-10-31 plain-italic shape).
const WAKE_LINE = "*restart-wake · planned*";
const wakeRaw = (id: string | number) =>
  raw(id, T_3H25M, { content: WAKE_LINE });

describe("#1083 restart re-wake replay (port of the investigation repro)", () => {
  test("control: a committed post is NOT re-queued (delivered set is the primary authority)", async () => {
    rewakeCommitDelivered(dir, "ch1", "100");
    const r = await scan([raw(100)]);
    expect(r.requeued).toBe(0);
  });

  test("fix B: the delivered-id horizon outlives 201 commits (cap eviction)", async () => {
    // The embed was committed 3h25m ago; the busy window since then
    // landed 301 commits — over the old cap (REWAKE_LOOKBACK_MAX + 1
    // = 201, which spliced the id out) and under the new one (5,000).
    rewakeCommitDelivered(dir, "ch1", "100");
    for (let i = 0; i < 300; i++) rewakeCommitDelivered(dir, "ch1", `f${i}`);
    // The id survived the window (pre-fix: evicted → the scan
    // re-queued the 3h25m-old embed).
    expect(loadRewakeQueue(dir, "ch1").delivered).toContain("100");
    // No seen store (its 500 cap / 72h prune could evict too) — the
    // delivered set alone must close the gap.
    const r = await scan([raw(100)]);
    expect(r.requeued).toBe(0);
  });

  test("fix A: lost rewake file (empty delivered set) — the seen store drops the post", async () => {
    // The rewake file is missing: loadRewakeQueue falls back to an
    // empty delivered set (at-least-once bias). Pre-fix, the scan
    // re-queued the 3h25m-old embed (the 72h age guard has 68h of
    // margin). The seen set (channel-state.json — deploy.sh never
    // touches it) is the only surviving record.
    expect(fs.existsSync(path.join(dir, "rewake-ch1.json"))).toBe(false);
    writeStateFile(["200"], []);
    const r = await scan([raw(200)], seenFromDisk);
    expect(r.requeued).toBe(0);
  });

  test("fix A: healthy rewake file but the id is absent (commit evicted) — the seen store drops the post", async () => {
    // The delivered set exists but does not contain the id (evicted
    // pre-fix, or the commit never landed). The seen store is the
    // independent record that was never consulted on this path before
    // #1083.
    saveRewakeQueue(dir, "ch1", { v: 1, pending: [], delivered: ["other"] });
    writeStateFile(["300"], []);
    const r = await scan([raw(300)], seenFromDisk);
    expect(r.requeued).toBe(0);
  });

  test("fix A: a double-posted wake card (new id, same embed) is dropped by the seen wake key", async () => {
    // The #306 design target: the re-post has a NEW message id the id
    // checks miss; only its wake key (content hash) survives. The
    // original card's id is gone from both stores — only the key is
    // in seenWake.
    const key = wakeEmbedKey(wakeRaw("400"));
    expect(key).not.toBeNull();
    writeStateFile([], [key as string]);
    const r = await scan([wakeRaw(401)], seenFromDisk);
    expect(r.requeued).toBe(0);
    // Sanity: the id "401" is unknown to seen.ids / delivered — the
    // drop came from the wake key, not an id match.
    const seen = seedSeenSets(loadChannelStateFile(dir), DISCORD_ID);
    expect(seen.seenIds.has("401")).toBe(false);
  });

  test("at-least-once bias is preserved: uncommitted + unseen posts are still re-queued", async () => {
    // No files at all (worst case): the scan must still re-queue — the
    // seen cross-check only ADDS drops, it never replaces the
    // delivered check or fabricates a drop.
    const r = await scan([raw(500)]);
    expect(r.requeued).toBe(1);
    expect(r.requeuedIds).toEqual(["500"]);
  });

  test("at-least-once bias is preserved: a stale (>72h) post is still age-guarded, seen or not", async () => {
    const stale = raw(600, Date.parse("2026-10-27T04:35:00.000Z")); // 4 days old
    // No seen store: the age guard alone drops it.
    expect((await scan([stale])).requeued).toBe(0);
    // Seen store present: same drop (seen adds nothing here).
    writeStateFile(["600"], []);
    expect((await scan([stale], seenFromDisk)).requeued).toBe(0);
  });
});
