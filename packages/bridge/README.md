# @jarate/bridge

Discord channel bridge for pi (the `channel/` package of the jarate
monorepo; `marzukia/piscord` is the legacy standalone upstream).

The bridge is transparent. A channel message arrives at the agent as a plain
user message. The agent's response is forwarded back to the channel that
last messaged it. The agent sees a small `<channel-ctx>` block (channel type,
sender, format hints) so it can tailor its answer. Five LLM tools are added:
`send-file`, `todo`, `sleep`, `task`, and `jarate`.

## Features

- Discord via bot token: gateway `MESSAGE_CREATE` push, with a REST poller
  as backfill (60 s while the gateway is up, 5 s while it is down)
- Long answers are split into Discord-sized messages (under 2000 chars).
  Fenced code blocks are never split mid-block
- Replies are threaded to the message that triggered them. In a multi-person
  burst the agent can thread to a specific person with a `<reply-to:MSGID>`
  tag (see Reply threading)
- 👀 ack on receive (per-channel `ack: false` disables it), removed when
  the reply lands
- Typing indicator while the agent works. Gateway presence with live
  context-window usage in the bot status
- Mid-run assistant text is forwarded live as each step finalizes, so the
  channel shows progress while the agent works (not just the typing indicator)
- Leaked thinking tags are stripped before sending
- Commands: 22 slash commands + bare `stop` + `!` shell (owner) — full
  list: `/stop`, `/btw`, `/help`, `/status`, `/usage`, `/context`, `/reset`,
  `/restart`, `/undo`, `/redo`, `/verbose`, `/hold`, `/compact`, `/handover`,
  `/model`, `/jobs`, `/todos`, `/sleep`, `/tasks`, `/diff`, `/new-worktree`,
  `/merge-worktree` (see the Commands section)
- Voice notes: audio attachments are labeled `[voice note: name (12s)]`
  and delivered immediately instead of waiting for follow-up text
- `/btw <question>` and a trailing `. btw` ask a quick side question the
  agent answers briefly, without disturbing the main run
- Embeds (polls, rich embeds) are serialized to readable text for the LLM
- Oversized inbound images are resized (max 2000 px) and compressed
  (max 4 MB) via optional `sharp` before reaching the agent
- File attachments are downloaded on arrival into a batch folder
  (20 MB per-file cap; oversize or failed downloads are noted in the LLM
  message, file-only messages buffer for 10 min)
- Poll/send errors are sanitized before they hit the TUI log (bearer
  tokens, API keys, Discord tokens, query-string secrets)
- Messages that arrive mid-run are queued, not debounced: one message = one
  run, delivered at run end (and armed as a mid-run interrupt that takes
  over if the current step is still going after ~3 s)
- Reply context: when a message replies to another message, the referenced
  message's author + text are injected as a `<replied-message>` block so
  the agent knows what is being pointed at
- `send-file` LLM tool: the agent uploads local file(s) to the channel in
  one message (multipart, 25 MB per-file cap) — no webdrop round-trip
- Other bots are skipped on inbound (inter-agent traffic does not burn a run;
  no echo loops)
- Message cursor is persisted per channel (`.tmp/channel-state.json`), so
  messages sent while pi was down are picked up on restart
- Outbound messages are ping-suppressed by default (`allowed_mentions:
  {parse: []}`); real `<@id>` mentions in the text still ping

### LLM tools

- `send-file {files: string[]}` — upload local file(s) to the active
  Discord channel in one message. Images render in a grid. 25 MB per-file
  cap, unknown extensions sent as `application/octet-stream`.
- `todo` — channel todo board (add/list/done/clear).
- `sleep` — durable "wake me at X" scheduler for this session.
- `task` — schedule, change or cancel prompt tasks (one-shot + cron).
- `jarate` — one tool over the `$HOME/bin/jarate` JSON entrypoint (issue #17).

## Install

The bridge ships as the `packages/bridge` directory of the jarate monorepo
(marzukia/jarate). Add the checkout path to `packages` in your
`.pi/settings.json` — the fleet boxes point at their checkout:

```json
{
  "packages": ["<path-to-jarate-checkout>/packages/bridge"]
}
```

pi loads the extension from the `channel/` directory at session start.
Update by pulling the checkout (`git pull --ff-only`) and restarting pi.

## Reply threading

Each inbound message carries a stable id in the agent's channel context
(single messages: a `msgId=` attribute on `<channel-ctx>`; burst-merged
messages: a `[msgId=...]` marker per part). Replies thread to the last
message of the triggering burst by default.

To thread to a specific person instead, the agent prefixes its reply with
`<reply-to:MSGID>` using that person's `msgId`. The tag is stripped before
sending; if the id is not one of the triggering message ids, the reply falls
back to the default target. Only the first chunk of a long (chunked) reply
carries the thread.

## Configuration

```json
{
  "channels": [
    {
      "id": "discord-monky",
      "name": "MONKY",
      "type": "discord",
      "enabled": true,
      "channel": "<channel-id>",
      "botToken": "your-bot-token",
      "default": true,
      "ownerUserId": "your-discord-user-id",
      "ownerUserIds": ["second-operator-id"],
      "forwardToolCalls": false
    },
  ]
}
```

### Channel fields

| Field | Required | Description |
|-------|----------|-------------|
| `id` | yes | Unique id |
| `name` | yes | Display name |
| `type` | yes | `"discord"` |
| `enabled` | yes | Connect on startup |
| `channel` | yes | Discord channel ID (numeric id or `#name`) |
| `botToken` | discord | Discord bot token |
| `ownerUserId` | optional | Discord user id allowed to use owner commands |
| `ownerUserIds` | optional | list of further owner ids (checked alongside `ownerUserId`) |
| `forwardToolCalls` | optional | `true` — tool calls/results appended to forwarded responses |
| `default` | optional | Active channel on startup |
| `startupMessage` | optional | Posted once when the channel connects |
| `ack` | optional | `false` — disable the 👀 ack reaction (default `true`) |

### Commands

Anyone: `stop` / `/stop` (abort the in-flight run), `/btw <question>` (quick
side question), `/help` (list the commands).

Owner: `/status` (context-window usage, model, uptime), `/usage` (token
usage), `/context [N]` (window breakdown), `/reset` (new session),
`/restart` (restart pi, resume this session), `/undo [N]` / `/redo` (revert
reapply turns), `/verbose [0|1|2|on|off]` (tool-call detail level, bare
`/verbose` toggles), `/hold [on|off]` (buffer inbound messages), `/compact`
(compact session context), `/handover` (compact via the handover doc),
`/model [name]` (switch or list models), `/jobs` (recent pi-bg run
history), `/todos`, `/sleep [list|cancel <id>]`, `/tasks [list|add|...]`,
`/diff [range|file]` (publish a diff to a viewer URL), `/new-worktree [ref]`
/ `/merge-worktree [squash]`.

`! <cmd>` runs a shell command in the working directory (owner, 60 s cap).

## Layout

```
channel/    extension source (TypeScript, loaded by pi via jiti)
  index.ts    bridge logic: inbound/outbound, commands, chunking, mid-turn queue
  discord.ts  Discord client: gateway MESSAGE_CREATE + REST backfill poll,
              send, react, typing, presence
  queue.ts    `. queue` suffix detection (park without arming an interrupt)
  frame.ts    in-turn tool-call frame column budget
  format.ts   markdown → Discord pipeline (headings, lists, tables, escapes)
  sanitize.ts sensitive-data redaction for log lines
  censor.ts   secret egress censor (docs/secret-censor.md)
  types.ts    config and message types
  voice.ts    voice-note attachment detection
  transcribe.ts  voice-note transcription via whisper.cpp
  btw.ts      trailing ". btw" side-question detection
  image-optimizer.ts  optional sharp-based image resizing/compression
  context.ts  /context window breakdown
  usage.ts    /usage token usage
  diff.ts     /diff viewer URL publishing
  jobs.ts     /jobs dispatch scan + history
  todos.ts    /todos board
  tasks.ts    scheduled prompt tasks
  sleep.ts    session sleep scheduler
  undo.ts     /undo + /redo (store + revert)
  worktree.ts /new-worktree + /merge-worktree
  handover.ts /handover compaction
  restart-queue.ts  re-wake queue survival across restart
  restart-wake.ts   post-restart wake
  fleet-run.ts  fleet dispatch run detection
  jarate.ts   `jarate` LLM tool
  *.test.ts   bun:test suites for the helpers
skills/     bundled skill: channel configuration reference
```

## Development

```sh
bun install
bun test          # helper unit tests
bunx tsc --noEmit # typecheck
```

## Notes

- Discord outbound formatting: `####`+ headings become `###`, code blocks
  are hoisted out of list items, tables become `**header** value` key-value
  lines, backticks in code are escaped, headings become bold, links become
  `text (<url>)`
- REST calls retry on HTTP 429 (up to 3 attempts). Polling backs off on
  error so a bad token does not burn API quota
- The gateway client reconnects with exponential backoff (5 s to 5 min)

## License

MIT — see [LICENSE](LICENSE).
