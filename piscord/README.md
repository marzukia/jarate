# piscord

Discord channel bridge for pi.

The bridge is transparent. A channel message arrives at the agent as a plain
user message. The agent's response is forwarded back to the channel that
last messaged it. The agent sees a small `<channel-ctx>` block (channel type,
sender, format hints) so it can tailor its answer. No extra LLM tools are
added.

## Features

- Discord via bot token (REST polling, 5 s)
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
- Commands: `stop` / `/stop`, `/btw <question>`, `/help` (anyone),
  `/status`, `/reset`, `/verbose on|off` (owner)
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
- Channel context includes a table of contents of `MEMORY.md` when present
- Poll/send errors are sanitized before they hit the TUI log (bearer
  tokens, API keys, Discord tokens, query-string secrets)
- Messages that arrive mid-run are debounced (2.5 s quiet window) and
  delivered as one steer, so the agent pivots at the next step boundary
- Reply context: when a message replies to another message, the referenced
  message's author + text are injected as a `<replied-message>` block so
  the agent knows what is being pointed at
- `send-file` LLM tool: the agent uploads local file(s) to the channel in
  one message (multipart, 25 MB per-file cap) — no webdrop round-trip
- Other bots are skipped on inbound (agent-say traffic does not burn a run;
  no echo loops)
- Message cursor is persisted per channel (`.tmp/channel-state.json`), so
  messages sent while pi was down are picked up on restart
- Outbound messages are ping-suppressed by default (`allowed_mentions:
  {parse: []}`); real `<@id>` mentions in the text still ping

### LLM tools

- `send-file {files: string[]}` — upload local file(s) to the active
  Discord channel in one message. Images render in a grid. 25 MB per-file
  cap, unknown extensions sent as `application/octet-stream`.

## Install

pi supports git package sources. Add the repo URL to `packages` in your
`.pi/settings.json` (a deploy key or credential is needed for private
repos):

```json
{
  "packages": ["git@github.com:marzukia/piscord"]
}
```

pi clones the repo, installs its dependencies, and loads the extension from
the `channel/` directory at session start. Update by re-running the pi
package install/update (git fetch + dependency repair), then restart pi.

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
      "channel": "1545018100590846033",
      "botToken": "your-bot-token",
      "default": true,
      "ownerUserId": "your-discord-user-id",
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
| `forwardToolCalls` | optional | `true` — tool calls/results appended to forwarded responses |
| `default` | optional | Active channel on startup |
| `startupMessage` | optional | Posted once when the channel connects |
| `ack` | optional | `false` — disable the 👀 ack reaction (default `true`) |

### Commands

- `stop` / `/stop` — anyone in the channel aborts the in-flight run
- `/btw <question>` — anyone: quick side question, answered briefly
- `/help` — anyone: list the commands
- `/jobs` — anyone: list in-flight pi-bg dispatches
- `/status` — owner: context-window usage, model, uptime
- `/reset` — owner: abort and restart the pi session
- `/verbose on|off` — owner: toggle tool-call forwarding until restart
  (bare `/verbose` toggles)
- `/compact [instructions]` — owner: compact session context (optionally with
  custom instructions)
- `/model [name]` — owner: switch model, or list models when bare
- `! <command>` — owner: run `bash -c` in the working directory (60s cap,
  20k-char capture, 4k-char display)

## Layout

```
channel/    extension source (TypeScript, loaded by pi via jiti)
  index.ts    bridge logic: inbound/outbound, commands, chunking, debounce
  discord.ts  Discord REST client: poll, send, react, typing, gateway presence
  format.ts   markdown → Discord pipeline (headings, lists, tables, escapes)
  voice.ts    voice-note attachment detection
  btw.ts      trailing ". btw" side-question detection
  memory.ts   MEMORY.md table of contents for channel context
  sanitize.ts  sensitive-data redaction for log lines
  image-optimizer.ts  optional sharp-based image resizing/compression
  types.ts    config and message types
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
