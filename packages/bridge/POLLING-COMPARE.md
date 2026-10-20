# Piscord vs Kimaki: Discord message ingestion

Research: why piscord's ingestion feels laggy/lossy vs kimaki. Read-only study, 2026-07-09.
> Note 2026-09-08: pre-gateway-rewrite lines marked as updated/done; the mechanism
> section below now reflects the MESSAGE_CREATE gateway ingestion.
User complaint: "the polling shit is bad and doesn't work good with agents like Kimaki does".

## piscord mechanism

**Gateway MESSAGE_CREATE ingestion** (since 2026-09-08, `49b7abe`), with the REST
poller kept as a backfill safety net (60s interval while the gateway is up, 5s while down).

- A `setInterval` fires `pollDiscord()` per configured channel at a
  **dynamic** interval: **60000 ms** backfill while the gateway is up,
  **5000 ms** while it is down (`channel/discord.ts:30-32` `POLL_INTERVAL_MS`/
  `POLL_BACKFILL_MS`, `:485-495` `currentPollIntervalMs`/`restartPollTimer`).
- Each poll: `GET /channels/{id}/messages?after={lastMessageId}&limit=10`
  (`channel/discord.ts:545-547`). Bootstraps with `?limit=1` to seed the cursor
  (`:258-262`) — only when no persisted cursor exists: cursors now survive
  restarts in `.tmp/channel-state.json` (`:255, 391-397`), so a restart resumes
  exactly where it left off instead of re-reading history.
- **Dedupe** is the shared per-channel cursor: `deliverInboundMessage` drops
  anything at or below `state.lastMessageId` (`discord.ts:660-661`) and advances it
  on delivery (`:662-663`) — one delivery path for both the gateway and the poll
  lane. No in-memory seen-set. At-least-once: on fetch error the cursor is not
  advanced, so the next poll re-reads.
- **Self-skip**: bot's own user id resolved via `/users/@me` (`discord.ts:257`);
  messages from it are skipped (`discord.ts:666`). If `botUserId` is null the skip is a
  no-op — own messages get ingested until identity resolves (retried each poll, `:529-534`).
- **Retry**: `discordFetch` retries up to 3 attempts, honoring 429 `retry_after`
  (`discord.ts:72-110`). On poll error: exponential backoff pause
  `5s * 2^n` capped at **60s** via `pollPauseUntil` (`discord.ts:564-568`). A
  `state.polling` flag skips timer ticks while a poll is in flight (`discord.ts:524`),
  so a slow poll adds its full in-flight time to backfill latency.
- **Per-poll latency bound**: 0–60s (interval) + poll in-flight time (0–~4.5s with 429
  retries) + up to 60s of error backoff. Live messages ride the gateway (hundreds of
  ms); the poll only bounds the backfill.
- **Inbound gateway** (updated 2026-09-08, `49b7abe`): the per-token WebSocket
  IDENTIFYs with `GUILDS | GUILD_MESSAGES | DIRECT_MESSAGES | GUILD_MESSAGE_CONTENT`
  (`discord.ts` `GATEWAY_INTENTS`) and ingests `MESSAGE_CREATE` directly — presence,
  `INTERACTIONS_CREATE` (slash commands), and messages all ride one socket. The REST
  poller is a 60s backfill safety net while the gateway is up (5s when it is down).
- **Busy-turn handling** (`channel/index.ts`): when a run is active, inbound
  messages are **queued, not merged** — each one is appended to the per-channel
  `midTurnQueues` FIFO (`index.ts:327`) with a `[queued] N in line` ack (verbose 1+,
  silent at verbose 0) and armed as a mid-run interrupt: if the current step is still
  going after ~3 s (`PISCORD_INTERRUPT_STEP_TIMEOUT_MS`, default 3000, `index.ts:665-667`),
  the step is interrupted and the message takes over as a new run. At run end each
  queued message is delivered verbatim as its own run (one message = one run); the
  queue survives a process restart (`restart-queue.ts`, #180). Idle messages forward
  immediately.
- **Attachment-only messages** (files, no text) are buffered in `pendingAttachments`
  with a **10 min TTL** until a follow-up text arrives
  (`index.ts:225-228, 660-671`).
- **Ack UX**: 👀 reaction on each new message unless a command suppressed it
  (`discord.ts:683`); un-reacted on turn end (`index.ts:3628` area).
- **Outage behaviour**: cursors persist across restarts (`.tmp/channel-state.json`,
  `discord.ts:255, 391-397`), so anything sent while the agent was down **is replayed**
  by the first poll after connect (the 2026-07-09 "not replayed" behavior is gone).

## flaws (ranked by user impact)

1. **5s polling floor on every message** — even when Discord could deliver in <200 ms.
   This is the "it lags" complaint. `discord.ts:30,495`. **Done 2026-09-08
   (`49b7abe`)**: live messages ride the gateway; the 5s poll only runs while the
   gateway is down.
2. **Steer delay stacks: poll + burst buffer** — a message sent while the agent is
   working waits up to 5s (poll) + 2.5s (burst window) before reaching the LLM, and
   rapid messages are *rewritten* into a numbered merge (`index.ts:719-735`), changing
   wording and losing per-message reply targeting (only the last id is kept, `:732`).
   **Done (midTurnQueues)**: mid-run messages are queued verbatim (one message = one
   run), with per-message ids and reply targeting intact; the poll no longer gates
   live ingestion.
3. **Missed messages on startup / after downtime** — cursor seeds from the last message
   at connect time; nothing sent before the first successful poll is ever seen
   (`discord.ts:184-188`). A gateway session with resume + replay would not miss these.
   **Done (cursor persistence, `.tmp/channel-state.json`)**: the cursor survives
   restarts and the first poll backfills the downtime window.
4. **Latency spikes during errors** — poll backoff pauses ingestion for up to 60s
   (`discord.ts:564-568`), and in-flight polls skip timer ticks entirely
   (`discord.ts:524`). A 429 during a burst delays *all* queued messages.
   **Mitigated 2026-09-08**: the backoff now only delays the 60s backfill, not the
   gateway's live lane.
5. **In-memory only, no persistence** — burst buffers, pending attachment batches, and
   the message cursor all live in process state; a crash mid-turn silently drops
   un-forwarded messages (`index.ts:61-65, 228`; `discord.ts:25-35`). Kimaki persists
   queue state and uses thread-scoped ingress serialization.
   **Partially done**: the cursor persists (see flaw 3) and the mid-turn re-wake queue
   survives a process restart (`restart-queue.ts`, #180); pending attachment batches
   are still in-memory.
6. **Self-echo window before identity resolves** — if `/users/@me` fails at connect,
   own messages are ingested (agent hears itself) until the first poll resolves it
   (`discord.ts:158-167, 251`).
7. **`limit=10` cursor is fine but single-threaded per channel** — a very chatty channel
   (>10 msg/5s) works (cursor catches up next tick) but every extra message costs an
   extra REST call in a tight loop; at guild scale this is where rate limits bite.
   `discord.ts:545`. **Reduced**: the poll is a 60s backfill now, so the per-channel
   REST budget is ~10x lower.

## kimaki mechanism

Repo: github.com/remorses/kimaki (cloned at /tmp/kimaki). Agent = the `cli` package
("kimaki"), Discord via **discord.js ^14.26.3** (`cli/package.json:72`).

- **Event-driven gateway push.** One `discord.js` `Client` per bot with intents
  `Guilds, GuildMessages, MessageContent, GuildVoiceStates`
  (`cli/src/discord-bot.ts:289-295`). Ingestion is the **`Events.MessageCreate`** event
  (`discord-bot.ts:483`) — Discord pushes every message over the WebSocket, latency
  bounded by network round-trip (hundreds of ms), no interval.
- **No polling at all for messages.** REST is used only for fetches of *partial*
  (chunked/lazy) messages (`discord-bot.ts:550-562`) and outbound sends.
- **Reconnect = resume with replay.** discord.js handles RESUME automatically;
  `ShardResume` logs replayed events (`discord-bot.ts:452-458`). Sustained failure
  (50 reconnect attempts) triggers a full self-restart (`discord-bot.ts:424-451`).
  A bot down for minutes replays missed messages on resume instead of seeding a fresh
  cursor and skipping them.
- **Busy turns: queue, not buffer.** `MessageCreate` runs inside a per-thread ingress
  slot (`reserveThreadIngress` / `runInThreadIngressSlot`,
  `cli/src/session-handler/thread-session-runtime.ts:225-248`) which serializes ingress
  so rapid messages cannot race. Messages are then `enqueueIncoming()`
  (`thread-session-runtime.ts:3479`): if the session is busy the item sits in a
  per-thread `queueItems` FIFO and `tryDrainQueue()` (`:3827`) dispatches it the moment
  the session becomes idle (`isSessionBusy` check, `:3846-3851`). Default mode defers to
  opencode's server-side pending-turn serialization; `local-queue` mode keeps kimaki's
  own FIFO with position feedback (`:3415-3471`). No fixed-time merge: a single message
  queued behind an active run is dispatched at run end, verbatim.
- **Self/bot filtering by author id** at the top of the handler
  (`discord-bot.ts:508-518`), plus mention-mode and permission gates — all synchronous
  per-event, so filtering costs nothing.

**Why kimaki reacts better for a long-running agent:** push (no interval), resume
replay (no miss window), FIFO queue drained at idle (no fixed 2.5s merge window, no
wording rewrite), and per-thread serialization that makes concurrent ingress
race-free. The two systems' core difference (as of the 2026-07-09 study):
piscord *asks Discord every 5s what happened*; kimaki *lets Discord tell it, and
queues what arrives while busy*. Since the 2026-09-08 gateway rewrite piscord
has converged on that model: push ingestion plus a per-channel FIFO queue for
busy turns.

## fixes for piscord (ranked)

1. **Ingest MESSAGE_CREATE over the existing presence gateway** (biggest win, reuses
   infra). **Done 2026-09-08** (`49b7abe` + follow-ups): IDENTIFY now sends
   `GUILDS | GUILD_MESSAGES | DIRECT_MESSAGES | GUILD_MESSAGE_CONTENT` and handles
   `MESSAGE_CREATE` op 0 → build the same `ChannelMessage` and call
   `callbacks.onMessage`. Drop the REST poller to a slow **safety-net poll**
   (e.g. 60s, same `after` cursor) that backfills anything missed during a gateway
   outage. Dedupe: keep `lastMessageId` as a snowflake floor — gateway events below
   the cursor are dropped, poll results below it dropped; events above the cursor
   advance the cursor. Self-skip already works off `botUserId` from READY `d.user`
   (no more `/users/@me` race). Needs the bot's `Message Content` intent enabled in
   the developer portal (privileged intent).
2. **Queue inbound per channel, drain on `agent_end`** instead of the 2.5s burst
   rewrite. Replace `burstBuffers` (`index.ts:64-65, 718-735`) with a FIFO: append the
   message verbatim; on `agent_end` (`index.ts:445` area) drain the queue and send each
   message as its own steer (or one combined message that keeps each original text, no
   renumbering). Keeps mid-turn races safe because pi's `deliverAs: "steer"` already
   serializes into the active turn. **Done (post 2026-09, `midTurnQueues`)**: the burst
   rewrite is gone; the per-channel FIFO delivers each queued message verbatim as its
   own run at run end, with a mid-run interrupt taking over if the step is still going.
3. **Persist the cursor + pending inbound** across restarts. Write
   `lastMessageId` (and pending attachment batches) to `.tmp/channel-state.json` on
   each advance; seed from it at connect before falling back to `?limit=1`
   (`discord.ts:184-188`). Fixes the startup/downtime miss window even without
   gateway resume. **Done (cursor half)**: `lastMessageId` persists per channel in
   `.tmp/channel-state.json` and seeds at connect (`discord.ts:255, 391-397`); pending
   attachment batches are still in-memory.
4. **Bound in-flight poll latency** while polling still exists: shorten
   `POLL_INTERVAL_MS` to ~1000-2000ms only as an interim (REST budget: one guild-
   scoped messages GET/s per channel is well under the 50 req/5s bucket), and make
   the `polling` flag non-blocking — let a new tick start the next poll instead of
   skipping (`discord.ts:225-227`) or, better, drop the timer once gateway ingest is
   live. Cap the error pause at ~10s (`discord.ts:295`).
5. **Resolve bot identity before starting ingest** (or skip unknown authors): fetch
   `/users/@me` at connect and only start the poller/gateway handler once `botUserId`
   is set, closing the self-echo window (`discord.ts:158-167, 251`). With the gateway
   fix, READY supplies it synchronously.
6. **Minor**: raise `limit=10` → `limit=50` on the poll path (fewer backfill calls);
   add a `lastPoll` timestamp to the existing `ChannelStatus` type (`types.ts`) for
   observability of ingest staleness. Status: the `lastPoll` field landed on
   `ChannelStatus` (`types.ts:132`) — that type is currently dead code (see the
   dead-code sweep issue); the `limit` raise is still open.
