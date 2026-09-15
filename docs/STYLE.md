# STYLE — chat + output format rules (v3)

Applies to: monky Discord replies, pi-bg embeds, slash-command output.
Source of truth for the format rules; AGENTS.md "Voice" points here.
Last revised: 2026-09-15 (frame gap rule + injection decision).

## 1 Language
1.1 Serious / task talk: ASD-STE100. Simple words, short sentences,
    active voice. No fluff.
1.2 Casual talk: same word discipline, relaxed tone.
1.3 No hedging leads. Give the take; caveat in a second sentence.
1.4 Cut words. Less, not more.

## 2 Chat frames (machine state in Discord)
2.1 Machine state goes in a code fence, rendered as a box-drawing frame.
2.2 Full border: `┌` top, `├`/`┣` rows, `└` bottom. Never ship an open
    frame. Wrapped continuations keep the pipe: a row on the gutter
    (`├`/`┣`/`│`) continues with `│ ` (pipe + space); `┌`/`└`/plain lines
    continue with two spaces. Both gutters are 2 cols. (Andryo 2026-09-16,
    screenshot: bare 2-space wraps under ├ read as detached.)
2.3 <= 40 cols per line (mobile budget, MEASURED 2026-09-15 labeled-line test on Andryo's phone: 40 holds, 42 wraps; zoomed code view fits ~31 - acceptable). Wrap or shorten, never overflow.
2.4 A frame is SELF-CONTAINED: nothing after the closing `└`. Extra
    context goes before the frame.
2.5 Blank line before a fence: yes. Blank line after a fence: only if the
    message ends. If text must follow the fence, use a SINGLE newline
    (a blank line renders as a visible gap in Discord).
2.6 State glyphs: `┣` active, `├` pending/done, `┤` cancelled.

## 3 Plain text
3.1 No emoji. ASCII state tags instead: `[ok] [!] [new] [queued] [-]`.
3.2 URLs bare or [label](url) — never in inline code (kills clickable).
3.3 No walls of text. Short paragraphs, one idea each.
3.4 Code: only when it is code. Numbers/ids in prose stay bare.

## 4 Tool output (jarate + pi-bg)
4.1 jarate stdout: ONE JSON document, snake_case, no color, no emoji.
    (docs/JARATE.md)
4.2 Slash commands: bracketed tag + one line, fenced only when the
    content is multi-line. (docs/COMMANDS.md tag table)
4.3 pi-bg embeds: `┌ ok · <run_id>` frame, untagged, <= 40 cols.
    (docs/DISPATCH.md)
4.4 Machine output posted to Discord (script errors, command output,
    logs, JSON, paths) goes in a code fence - never bare prose. One-line
    errors: inline code. Multi-line or raw logs: fenced block.
    (2026-09-15 Andryo: pi-restart's bare "Failed to start transient
    timer unit" line; applies to all jarate scripts incl. pi-postcheck.)

## 5 Precedence
AGENTS.md (injected) > this file > session habit. Edit this file when a
rule is confirmed by Andryo; keep it under 60 lines so re-ingest is cheap.
