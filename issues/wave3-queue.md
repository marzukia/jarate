# Wave 3 queue (2026-09-15, Andryo GO "all of those")

11 open issues. Ordering minimizes same-file merge conflicts + puts security first.

## Wave A
| ticket | issues | status |
|---|---|---|
| A1 | #54 | MERGED 5ae9c6b8 (censor: github shapes + sbk_ class) |
| A2 | #52+#51 | MERGED 8399493a (heartbeat + one-shot lifecycle + DEAD dedupe) |
| A3 | #57 | reviewer 1279583 running (worker 37cbee3e: retry1 on silent exit 1) |

## Wave B
| order | issues | status |
|---|---|---|
| B1 | #50 | CLOSED - satisfied by A2 (8399493a, deadlog dedupe) |
| B2 | #37 | CLOSED - already fixed on main (pi-bg:217 readlink -f + test) |
| B3 | #48 | MERGED e14149ee+ffc63e90/4d60ab29 (/context digest + STYLE nits) |
| B4 | #46 | worker 1556660 running (/undo N multi-turn) |
| B5 | #43 | waiting - bridge serial after #46 |
| B6 | #42 | waiting - bridge serial last (voice-note, whisper scout in-task) |

## Done this session (closed stale)
#12 #13 #38 #40 #44 #45 (wave 2c) · #56 (#62) · #37 · #50

## Notes
- Deployed head tracks main via 30s poller (gate: typecheck + tests).
- Deploy test spawns briefly count toward the pi-bg cap (false "at cap").
- Reviewer FAIL loop = one fix round, then decide.
- /var/tmp/reviews is frank-owned (no group write) - monky review outputs
  land in /var/tmp/ flat or the worktree.
