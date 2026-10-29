# Handover defects — #306 (P0)

Diagnosis for the three handover defect classes, verified in code at
`22d8bf58` (base `main`). One root cause per symptom; all three are
fixable in place, no protocol change.

## 1. Restart boundary

### 1a. Duplicate `restart-wake · planned` embeds, 21.7 min apart

Evidence: snowflakes `1565239434729754655`
(2026-10-29T05:42:41.982Z) and `1565244903061987410`
(2026-10-29T06:04:25.734Z) — 21.73 min (1310 s) apart. A single
retry cannot produce this: `postWakePayload`
(`packages/bridge/channel/restart-wake.ts:263-290`) retries at most 3
times at 15 s spacing (`sleep(15_000)`, :274). Two embeds 1310 s apart
are therefore **two separate process startups, each posting its own
card**.

Root cause: the wake is posted on every real startup —
`runRestartWake` (`restart-wake.ts:364-385`) finds a clean-stop marker
(`readCleanStop`, :366-371) and posts "planned". The marker is
rewritten on every clean shutdown (`writeCleanStop`, :122-146, called
from `session_shutdown`, `index.ts:1950-1964`) and consumed on the next
startup, so every real startup after a clean stop re-classifies as
"planned" and re-posts. The dedupe, `claimWake`
(`restart-wake.ts:169-191`), only suppresses startups within
`WAKE_DEDUP_WINDOW_MS = 60_000` (:157). Two clean startups 21.7 min
apart (e.g. a planned restart whose respawn is followed by a second
restart) both post.

Secondary: `postWakePayload` is not idempotent — if attempt N succeeds
server-side but the response is lost, attempt N+1 creates a second
message with identical content (Discord message-create has no
idempotency key). A consumer-side dedupe key is required for
at-most-once regardless of the window.

### 1b. Older message replayed after a newer one (out of order)

Root cause: the op window rewinds the persisted cursor and the delivery
filter is cursor-only.

- `beginRestartOp` (`packages/bridge/channel/restart-ops.ts:314-335`)
  records `rewindTo = getChannelCursor(ch.id)` at op start;
  `rewindOpCursor` (:338-341) applies it; `session_shutdown`
  (`index.ts:1966-1970`) re-rewinds before the disconnects.
- On respawn the first poll (`pollDiscord`,
  `packages/bridge/channel/discord.ts:1127-1179`, `after=cursor`)
  re-fetches every message between the rewind point and the pre-shutdown
  cursor — including messages already delivered (the older wake card,
  inbounds committed during the op window).
- The delivery filter, `deliverInboundMessage`
  (`discord.ts:571-610`), is cursor-only: `id === lastMessageId` or
  `isOlderSnowflake(id, lastMessageId)` (:513-520). There is no
  persistent per-message-id record, so anything re-fetched after a
  rewind is re-delivered even though it was already delivered. An older
  message (the pre-rewind wake card) is thus delivered after the newer
  one — the observed out-of-order replay.

### 1c. The message just before/during a restart does not reach the
resumed session (silent amnesia)

Root cause: the delivered-set commit happens at pi's *acceptance*, not
at pi's *persistence*.

1. `sendToPi` (`index.ts:3860-3900`) calls
   `pi.sendMessage(..., { triggerTurn: true, deliverAs: "steer" })` and
   immediately (synchronously) commits the id to the persistent
   delivered set (`rewakeCommitDelivered`, `index.ts:3897`;
   `restart-queue.ts:266-282`) and drops the in-memory queue copy
   (`dropQueuedInbound`, :3900).
2. While pi is streaming, `sendCustomMessage` routes the message into
   the **in-memory steering queue** (`agent.steer` →
   `steeringQueue.enqueue`, pi-agent-core `agent.js:173-175`) — it is
   not appended to the session file until the current turn ends
   (`continue()` drains the queue).
3. A planned restart (SIGTERM) in that window kills the process before
   the drain. On respawn: the id is in the delivered set, so the #180
   startup history scan (`restart-queue.ts:296-355`) skips it; the
   persisted cursor is past it, so the poll (`after=cursor`) never
   re-fetches it. The message is gone from pi's context — the resume
   acts without it, silently.

## 2. Size-guard head-condense: task framing cut from a 212k-token
handover

Root cause: `condenseBody` (`packages/bridge/channel/handover.ts:155-162`)
keeps only the first ~40% of a section's lines. The Transcript section
is rendered **current-state-first** by `serializeTranscript`
(`packages/bridge/channel/transcript.ts:30-60`: newest span first, then
`…[older span]`, then the oldest span) — so the section's first lines
are the newest work and its last lines are the oldest task framing.
Cutting the tail removes exactly the active-task framing; the "condensed
by size guard" result keeps only the newest head.

`sizeGuard` (`handover.ts:134-150`) is the only condenser and is applied
from `handoverCompaction` (:778-790). `## State`, `## References`,
`## Last user asks` are protected (`GUARD_PROTECTED`, :123-127) and the
Transcript is the only condensed section — so its framing is the only
thing lost.

## 3. Reference: #291 last-turn drop (fixed at `f82fa69d` — do not
regress)

`serializeTranscript` (`transcript.ts:82-94`) captures the transcript
through the last completed turn on the compact path. The size-guard fix
must keep the transcript HEAD (newest span, which contains the
protected last turn) intact — see fix (c).

## Fixes

(a) **Idempotent restart-wake post** — (i) widen
`WAKE_DEDUP_WINDOW_MS` to 30 min, class-aware (an "unplanned" startup
still posts — the crash signal must not be suppressed); (ii)
consumer-side dedupe: a persistent seen-key set (hash of the wake
embed) in the bridge state JSON, checked in `deliverInboundMessage`,
so a double-posted card reaches the session at most once.

(b) **At-most-once, in-order delivery across restarts** — (i) a
persistent seen-message-id set per channel in `channel-state.json`
(snowflake-ordered, capped, age-pruned); `deliverInboundMessage` drops
ids already seen in addition to the cursor checks; (ii) amnesia fix: at
startup, cross-check the delivered set against the resumed session file
(same-file guard) and re-queue accepted-but-unpersisted ids, so a
message committed at acceptance but lost to a mid-turn restart is
delivered to the resumed session.

(c) **Size guard protects the transcript head + task framing** —
`condenseBody` keeps the first 20% (newest work) AND the last 20%
(oldest task framing, untruncated) and condenses the middle; repeated
passes converge (nested shrink) and the guarded output is idempotent.

Regression tests for all three, following the existing bridge test
pattern (`discord.test.ts`, `handover.test.ts`, `restart-queue.test.ts`,
`restart-wake.test.ts`).
