# Wave 3 queue (2026-09-15, Andryo GO "all of those")

11 open issues. Ordering minimizes same-file merge conflicts + puts security first.

## Wave A (dispatched 07:5x)
| ticket | issues | area | notes |
|---|---|---|---|
| A1 | #54 | bridge censor | PAT leak, security-adjacent, small |
| A2 | #52+#51 | dispatch | heartbeat + one-shot lifecycle |
| A3 | #57 | dispatch | silent exit=1, RCA exists (rca-57-silent-deaths.md) |

A2+A3 both touch dispatch/ → merge A2 first, A3 second (resolve conflicts inline if small).

## Wave B (as slots free)
| order | issues | area | why this order |
|---|---|---|---|
| B1 | #50 | dispatch | DEAD-embed dedup — same files as A2/A3, needs them landed |
| B2 | #37 | dispatch | JB_ROOT symlinks — dispatch, last dispatch item |
| B3 | #48 | bridge | /context digest — index.ts, start bridge queue |
| B4 | #46 | bridge | /undo N — index.ts, after B3 (same file) |
| B5 | #43 | bridge | /tasks add|reschedule — index.ts, after B4 |
| B6 | #42 | bridge | voice-note transcription — index.ts + audio path, last; worker scouts whisper options in-task |

Each: worker → reviewer (PASS) → merge → next slot. Callbacks drive it.

## Done this session (closed stale)
#12 #13 #38 #40 #44 #45 (wave 2c) · #56 (#62)
