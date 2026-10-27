# RCA — issue #291: handover amnesia (post-compact resume re-does finished work)

Base: main @ 4aa5f832. Generator: `packages/bridge/channel/handover.ts`
(1510 lines), wired from `session_before_compact` in `packages/bridge/channel/index.ts`
(~line 3713: `buildHandover({ preparation: event.preparation, branchEntries: event.branchEntries, ... })`).

## The 3 code paths

### P1 — transcript capture (`serializeTranscript` + `keptTailMessages`, handover.ts:530-630)

- `serializeTranscript(p, keptTail)`: transcript = KEPT TAIL (branchEntries at/after
  `preparation.firstKeptEntryId`, via `keptTailMessages`) rendered first, in full,
  then the SPAN (`messagesToSummarize` + `turnPrefixMessages`) walked newest→oldest
  filling the remaining `TRANSCRIPT_CAP` (60_000 chars).
- pi's cut point (`findProjectedCutPoint`, pi compaction.js): walks back from newest
  until >= `keepRecentTokens` (20k default), cuts at a user/assistant message. When
  the cut lands MID-TURN (`isSplitTurn`), the turn's user message goes to
  `turnPrefixMessages` (span) and the rest of the turn to the kept tail.
- THE GAP: the cap truncation gives the kept tail first claim. If the tail alone
  overflows 60k (a tool-heavy last turn easily does), the span gets ZERO budget —
  the last completed turn's USER TURN is silently dropped and the transcript starts
  mid-turn ("current state ends mid-conversation"). Same when the last turn sits
  wholly in the tail and the tail-oldest drop removes its user message. The
  assistant's answer (newest tail state) survives; the question that started the
  turn does not → the resumed agent does not know what the last turn was about →
  re-does the work.

### P2 — last-ask derivation (`extractDeterministic`, handover.ts:382-401)

- `lastUserAsks` = last 2 HUMAN channel-inbound entries in `branchEntries`
  (`isHumanInbound` filter) — with NO check whether an assistant answer landed
  after them. Fallback: user-role span messages (also unfiltered).
- THE GAP: the pointer lands on an already-handled ask (the answer landed moments
  before the snapshot). The seed kickoff then says "Answer the last pending user
  question" → the resumed agent re-answers / re-dispatches.

### P3 — mid-turn boundary (no marker)

- When `preparation.isSplitTurn` (capture boundary mid-turn) the doc silently
  truncates: the tail starts at the cut point (mid-turn) and the span ends with
  the turn prefix. No marker says the boundary is mid-turn, so a reader (or the
  resumed agent) cannot tell the tail begins mid-conversation.

## Planned change (surgical: 2 functions + 1 marker, no generator rewrite)

1. **`serializeTranscript`**: capture THROUGH the last completed turn. The turn's
   anchor = the NEWEST user line in the capture range (span then tail,
   chronological); the turn = anchor + everything after it. The turn always
   survives the cap: if it alone overflows, keep the anchor + the NEWEST lines
   that fit (the MIDDLE is dropped with a `…[mid-turn truncated: N entries
   dropped from the middle of the last turn]` marker — never the turn's start or
   its end). Pre-turn content (older span / older tail) fills the remainder,
   newest first, with the existing truncation markers.
2. **`extractDeterministic`**: an ask is PENDING only when NO assistant message
   follows it within the captured range. Channel-inbound path: skip asks with an
   assistant entry after them in `branchEntries`. Fallback (span user messages):
   skip asks with an assistant message after them in the span OR any assistant in
   the kept tail (the tail is entirely newer than the span). `lastUserAsks` =
   last 2 pending asks.
3. **`serializeTranscript`**: when `p.isSplitTurn`, emit an explicit
   `…[mid-turn at compact: ...]` marker at the tail→span boundary (where the
   split turn's continuation meets its user turn) instead of silent truncation.

Tests: last-turn-completed-before-compact (Q+R in transcript, no stale pointer),
stale last-ask (pointer moves to the truly open ask), mid-turn marker present
when the boundary is ambiguous, plus cap-overflow cases (turn over 60k keeps
anchor + newest; existing truncation behavior preserved).

## Implementation note (size gate)

`serializeTranscript` + `formatTranscriptLine` + `keptTailMessages` + `msgText`
moved to the sibling module `packages/bridge/channel/transcript.ts` (size gate:
ratcheted files may only shrink; handover.ts budget 1409 non-blank lines).
handover.ts re-exports them (`keptTailMessages`, `msgText`,
`serializeTranscript`) so existing importers (tests, buildHandover) are
untouched. No behavior change from the split — the move is verbatim.
