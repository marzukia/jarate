---
name: channel
description: Transparent Discord channel bridge (bot token). Messages forwarded as plain user messages. Responses auto-forwarded to last active channel. Reply context injected on replies. send-file tool uploads files. Commands: /stop, /btw, /help, /status, /reset, /verbose.
---

# Channel — Transparent Bridge

## How it works

1. Message from channel → forwarded as normal user message
2. LLM responds normally (no idea it came from a channel)
3. Response auto-forwarded to the channel that last messaged

When the user replies to a message, its author + text arrive as a
`<replied-message>` block in the context — treat it as "the user is
pointing at this".

Other bots' messages are ignored (no echo loops; agent-say traffic does not
trigger a run). Outbound messages suppress accidental pings; a real
`<@id>` you write still pings.

## Commands

- `stop` / `/stop` — anyone: abort the in-flight run
- `/btw <question>` — anyone: quick side question, answer briefly
- `/help` — anyone: list the commands
- `/status` — owner: context-window usage, model, uptime
- `/reset` — owner: abort and restart the pi session
- `/verbose on|off` — owner: toggle tool-call forwarding until restart

A trailing `. btw` on any message marks it as a side question; answer
briefly instead of diving into work.

Voice-note attachments (audio content type, duration, waveform, or
audio file extension) are labeled `[voice note: name (12s)]` inline and
delivered immediately. Other file attachments are downloaded on arrival
into a batch folder (20 MB per-file cap; oversize or failed downloads
are noted next to the file in the LLM message). By default, file-only
messages fire a turn immediately with a synthesized prompt like
`[user sent file without text: IMG_1358.jpg]`. Set `"bufferFileOnly": true`
on a channel to buffer them for up to 10 minutes until the user sends
follow-up text (the buffer posts one visible
`[buffered] N file(s) - send text to attach them` ack line; follow-up
with its own attachments also flushes the buffer; a batch that never
gets follow-up text is auto-flushed as a file-only turn at 10 minutes).

### Sending files to the user

Use the `send-file` tool to upload local file(s) to the channel in one
message (images show in a grid). 25 MB per-file cap. Prefer it over
webdrop links for anything small. Do not paste long paths instead.

## Reply threading

Inbound messages carry stable ids in the channel context: a single message
sets a `msgId=` attribute on the `<channel-ctx>` block, and a burst of
rapid-fire messages merges into one steer with a `[msgId=...]` marker on
each part. Replies thread to the last message of the burst by default.

When replying to a specific person in a multi-person thread, prefix your
reply with `<reply-to:MSGID>` using their id from the `[msgId=...]`
markers in the message (each burst part carries its own marker) or from
the `msgId=` attribute of the channel-ctx block. The tag is stripped
before sending. If the id does not match one of the triggering
messages, the reply falls back to the default (last) target.

## Stay in lane

In a shared channel, a message may be aimed at **another** agent or person.
You are **not required to reply** when any of these are true:

1. The message is a reply to someone else's turn (you are not the author of the quoted message).
2. Two other people (or an agent + a person) are mid-conversation and you are not addressed.
3. You are @-mentioned only to observe, not to act.

You **may** reply only when:

- you are explicitly addressed (by name or by being the one being asked),
- you have something directly relevant that the current speakers have not covered,
- or the sender @-mentions you and expects your input.

**No reply is a valid reply.** Do not pad the channel with acks, one-line
performances, or side commentary on a thread that is not yours. When in doubt
whether a message is for you, the default is to stay silent.

## Attribute precisely

When a `<replied-message author="X">` block is present, **X is the one who
spoke the quoted words.** Do not restate their statement as if it were the
current sender's. Do not attribute their words to anyone else. When you
reference what someone said, name the actual speaker (e.g. "Jash said…", not
"you said…" when Jash is the author). Misattribution is a comprehension error,
not a tone issue — read the `author=` tag before you quote or paraphrase.

## Configuration

```json
// .pi/settings.json
{
  "channels": [
    {
      "id": "disc-main",
      "name": "Main Discord",
      "type": "discord",
      "enabled": true,
      "channel": "123456789",
      "botToken": "your-bot-token",
      "default": true
    }
  ]
}
```

### Channel Fields

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
| `forwardToolCalls` | optional | `true` — tool calls/results included in auto-forwarded responses |
| `default` | optional | Active channel on startup |
| `startupMessage` | optional | Posted once when the channel connects |
| `ack` | optional | `false` — disable the 👀 ack reaction (default `true`) |

### Discord

Standard bot token + REST API polling (5s interval). Reacts with 👀 to
acknowledge new messages unless the channel sets `ack: false` (then the
typing indicator is the only "seen" signal). Responses auto-formatted for Discord (deep
headings clamped to ###, code blocks hoisted out of lists, tables →
`**header** value` lines, headings → bold, links → `text (<url>)`).

Embeds are serialized to readable text for the LLM. Oversized inbound
images are resized to max 2000 px / 4 MB when `sharp` is installed.
`MEMORY.md` in the workspace is summarized (heading TOC) into the
channel context so the agent knows what it remembers.
