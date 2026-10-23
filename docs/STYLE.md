# STYLE — chat + output format rules (v4)

Applies to: monky Discord replies, pi-bg embeds, slash-command output. Source of truth for format rules (AGENTS.md "Voice" points here).
Last revised: 2026-10-20 (v4: summaries = markdown lists; 40-col budget in-turn frames only; 2026-10-20 ruling: [ok]/[!] tags = machine output only, queue/interrupt acks silent at verbose 0).

## 1 Language
1.1 Serious / task talk: ASD-STE100. Simple words, short sentences,
    active voice. No fluff.
1.2 Casual talk: same word discipline, relaxed tone.
1.3 No hedging leads. Give the take; caveat in a second sentence.
1.4 Cut words. Less, not more.

## 2 Frames + summaries in Discord
2.1 Frames exist for ONE thing: in-turn tool-call run frames (bash/...
    lines while a turn runs). Full border: `┌` top, `├`/`┣` rows, `└`
    bottom; never ship an open frame. <= 40 cols/line (FRAME_COL_MAX;
    mobile budget, measured 2026-09-15: 40 holds, 42 wraps). Wraps keep
    the gutter: a row continues with `│ ` (pipe + space), plain lines
    with two spaces. (operator 2026-09-16.)
2.2 A frame is SELF-CONTAINED: nothing after the closing `└`. Extra
    context goes BEFORE the frame. Blank line before a fence: yes;
    after: only if the message ends (else a single newline).
2.3 SUMMARIES are normal Discord markdown - no fence, no box-drawing,
    no width budget, no truncation (Andryo 2026-10-18). Bullets are
    `- `, full text, wrap naturally. Status via markdown: in-progress
    = `**bold**`, closed = `~~strikethrough~~`. A list gets a bold
    header line (`**todos · N open**`) with a BLANK line before the
    bullets. Applies to: the todo board, /todos, /jobs, /usage,
    /context, /tasks, /sleep list, restart wake, handover state.
2.4 Every /command reply ships in a code fence - success, error, and
    usage paths alike (operator 2026-09-16) - EXCEPT summary bodies,
    which ship as markdown per 2.3 (2026-10-18). No 40-col wrap inside
    any fence: fence bodies ship verbatim; raw log lines are hard-capped
    at 160 chars, not wrapped (2026-10-05 C9).
2.5 State glyphs (in-turn frames only): `┣` active, `├` pending/done,
    `┤` cancelled.

## 3 Plain text
3.1 No emoji. [ok]/[!] are MACHINE OUTPUT only (Andryo 2026-10-20):
    fenced /command replies, pi-postcheck lines, bg-card embeds. Chat
    one-liners (compacted, restart wake, interrupted, run failure) are
    plain words - no tag. Queue acks ([queued] N in line) + the
    mid-run interrupt (ticks the ack) are SILENT at verbose 0, post at
    verbose 1+.
3.2 URLs bare or [label](url) — never in inline code (kills clickable).
3.3 No walls of text. Short paragraphs, one idea each.
3.4 Code: only when it is code. Numbers/ids in prose stay bare.

## 4 Tool output (jarate + jarate-bg)
4.1 jarate stdout: ONE JSON document, snake_case, no color, no emoji.
    (docs/JARATE.md)
4.2 Slash commands: defer to 2.4 (fence; summary bodies per 2.3).
    (docs/COMMANDS.md tag table)
4.3 pi-bg embeds: `┌ ok · <run_id>` frame, untagged, <= 40 cols.
    (retired lane; last full frame spec in the pre-#281 docs/DISPATCH.md)
4.4 Machine output posted to Discord (script errors, command output,
    logs, JSON, paths) goes in a code fence - never bare prose. One-line
    errors: inline code. Multi-line or raw logs: fenced block.
    (2026-09-15 operator: pi-restart's bare "Failed to start transient
    timer unit" line; applies to all jarate scripts incl. pi-postcheck.)

## 5 Precedence
AGENTS.md (injected) > this file > session habit. Edit this file when a
rule is confirmed by the operator; keep it under 60 lines so re-ingest is cheap.
