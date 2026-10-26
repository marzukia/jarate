# Deterministic piping — context transfer between run continuations

**Operator order 2026-10-27 (via warden).** Case study:
https://drop.junkyard.sh/f56919a45691c8b5c77b105a.html (G1 fleet runs 551–557,
2026-10-26; first perplexion = ticket 555, turn 161, 14:27:35Z).

The operator's question: how do we improve the compaction mechanism to avoid
the perplexion failure? The directive: **deterministic piping** — context
transfer between run continuations with **zero LLM in the loop**.

---

## 1. The failure, in one paragraph

Ticket 555, turn 161: a 58,946-char thinking-only message burned the entire
16,384-token output budget re-deriving the same worker-race analysis 7–9×,
truncated mid-sentence (`stopReason=length`), zero text blocks → empty final
→ pi compaction + `g6_reason=empty-final` salvage at wall 2300/3000. The
degradation was **gradual** (five escalating, recovered rumination episodes:
8.7k → 19k → 12k → 23k → 11.4k chars, then the fatal 58.9k), **not anchored
to any compaction boundary** (all 7 fleet compaction boundaries were followed
by clean turns; the fatal turn was 26 min after the last compaction, mid
context-growth 89.7k → 107.5k). No garbled tokens, no factual drift, no
context loss — SHAs and numbers all correct. The loss is in the **reasoning
loop accumulating with long context**, not in the tokens.

Consequence for handoffs: the run ended `g6_reason=empty-final`, and the
continuation brief for the re-dispatch is **hand-written by a requesting
agent (an LLM)** — possibly the same degraded model class — from a salvage
manifest that says only `rc: 0 / g6_reason: empty-final`. The handoff is
itself a model artifact. If the model that ruminated to death also writes the
brief, the rumination's framing travels into the next session.

## 2. What exists today (3 layers — verified anchors)

### Layer 1 — in-run: pi's LLM compaction (third-party, do not modify)

`@earendil-works/pi-coding-agent` compaction: near the context limit pi
summarizes the session with the session model. Lossy, model-authored.
**Fleet-side piping AROUND it**, never inside it.

### Layer 2 — run end: fleetwork salvage → terminal wake → hand-written brief

Exact code paths (hall-monitor, `deploy/fleetwork/`):

- `run-wrapper.sh` — G6 terminal assert (issue #115): on clean pi exit
  (rc 0) with empty final text and no written artifact →
  `G6_REASON=empty-final` → `$ART/terminal` marker; the salvage block tars
  the worktree + session + `salvage-manifest.txt` (`ticket/ts/rc/
  stop_signal/g6_reason`) → `refs/heads/fleetwork-salvage/<ticket>`.
- `executor.py` — `map_state()` maps the marker to `failed/<token>`;
  `finish()` captures `git_state()` (branch/head/dirty/files_changed),
  `parse_session()` (tokens/turns/compactions), uploads the terminal record
  to `/api/fleet/runs`.
- `fleet/runs.py` — `terminal_actions()` (exactly-once) → `post_run_message()`
  + `post_wake()` (the #30 orchestrator wake line via
  `ORCHESTRATOR_WAKE_WEBHOOK`; payload = ticket/agent/side/state/
  kill_reason/rc/worktree/record_token/pushed/head/base_commit/dirty_at_end —
  **no brief, no summary**).
- `wake-receiver.py` — formats the one-line wake the orchestrator eats.
- **The requesting agent (an LLM) then hand-writes the continuation brief**
  and files `POST /fleet/dispatch`. This is the lossy seam: the handoff is a
  model artifact, possibly written by a degraded model, from a manifest that
  carries no state at all (555's manifest is 5 lines).

### Layer 3 — bridge handoff (jarate, this repo)

`packages/bridge/channel/handover.ts`:

- `shouldHandoff()` — gate: manual, or threshold compaction at/over
  `HANDOFF_DEFAULTS.threshold` (0.8 of the TOTAL context window).
- `buildHandover()` → `extractDeterministic()` (pure, no LLM: file tags
  cumulative + capped newest-first, refs/worktrees/links, last user asks,
  todo board, dispatch state) → `serializeTranscript()` (kept tail first,
  bounded, per-message cap 4 000, total cap 60 000) →
  `renderDeterministic()` — **the LLM prose pass is already retired**; the
  doc is transcript-first + deterministic sections. Written to
  `~/.jarate/handovers/<stamp>-<slug>.md` + `latest.md` pointer.
- `buildSeedKickoff()` — the boot seed for the fresh session: digest +
  forced read of `latest.md`.

So the bridge already pipes deterministically **in-run at the 80% threshold**
for persistent sessions. What is missing: (a) a shared, stable schema the
fleetwork continuation path can consume; (b) triggers for the run-end failure
classes (`empty-final`, `stopReason=length`, rumination); (c) the re-dispatch
contract that makes the generated doc the next run's brief verbatim.

## 3. Design: deterministic piping

### 3.1 Trigger spec — when to hand off deterministically

Four triggers, evaluated by the tailer/executor (in-run) and by the wrapper
(terminal). Any one fires the generator; the fired trigger is recorded in the
handoff header (auditable).

| Trigger | Signal | Source |
|---|---|---|
| `context-threshold` | last usage total ≥ 80% of the context window (matches the bridge's `HANDOFF_DEFAULTS.threshold = 0.8`) | `live.json` (the tailer's per-cycle file, already read by `executor.read_live()`) or the last assistant `usage` in `session.jsonl` |
| `empty-final` | clean pi exit, no final text, no written artifact | G6 marker `$ART/terminal` (`run-wrapper.sh` G6 block) |
| `stop-length` | last assistant message `stopReason=length` with zero text blocks (the 555 case: the ONLY `stopReason=length` in 862 turns) | last message in `session.jsonl` |
| `rumination` | mechanical, in-run: repeated near-duplicate thinking windows (see 3.2) — the same 40-char shingle ≥ 5× inside one thinking block, or 3+ consecutive turns with thinking ≥ 8 000 chars (the 555 escalation: 8.7k→19k→12k→23k→11.4k→58.9k) | thinking blocks in `session.jsonl` |

`rumination` is the optional early-warning trigger: it fires BEFORE the
budget is burned (the 555 episodes at 8.7k–23k chars all recovered — a
deterministic handoff at episode 3–4 would have cut the loop before the
fatal turn). It is advisory: at `rumination` alone the generator writes the
handoff doc but the run continues (the doc is the compaction replacement,
mechanism A); at `stop-length`/`empty-final` the run is already terminal and
the doc becomes the re-dispatch brief.

### 3.2 Extractor spec — mechanical, verbatim, no LLM

Input: `session.jsonl` (+ `.fleetwork/brief` when readable, else the first
user message — the dispatch brief is the first user message verbatim; the
worktree when present). Output: the handoff doc (3.3). Every section is a
byte-for-byte copy or a mechanical transform (cap/dedupe/regex); nothing is
paraphrased.

1. **Original brief (verbatim)** — `.fleetwork/brief` if readable, else the
   first user-role message text from the session. Never summarized.
2. **Todo board** — verbatim board render (bridge runs); absent for
   fleetwork runs (rendered as `(none)`).
3. **Git state** — `git status --porcelain` in the worktree: branch, HEAD,
   dirty, files changed (the same capture `executor.git_state()` makes; the
   generator is self-contained so it works wrapper-side, pre-reap).
4. **Key file paths touched** — from tool calls in the session:
   read/write/edit paths, cumulative, deduped, **newest first, capped at 10**
   (mirrors the bridge's `FILE_TAG_CAP = 10` and its read=read-only
   invariant: a file modified later leaves the read list).
5. **Decisions (marked lines only)** — lines of assistant text that carry an
   explicit marker (`DECISION:` / `DECIDED:` / `NOTE:` prefix). Unmarked
   reasoning is NOT a decision; it is the rumination substrate and stays out
   of the handoff.
6. **Last N tool calls + truncated results** — the last 10
   toolCall/toolResult pairs, each result truncated at 2 000 chars
   (mechanical cut, `…[truncated]` marker). This is the "where exactly did
   the work stop" evidence — the 555 case: the last real work was
   `grep -E "wait_idle|armed|..." /tmp/g1-fix7.err | tail -25` (turn 160).
7. **Exact next action** — the last assistant text block verbatim (the stated
   intent). When the last turn is `stopReason=length` with no text (555),
   the next action is mechanical: `resume: last tool call <name> <args>` +
   the last stated intent from the previous turn — never a re-derivation.
8. **Bounded verbatim transcript tail** — last 12 messages, each capped at
   4 000 chars (mirrors the bridge's `MSG_CAP`), chronological, with a
   `…[transcript truncated]` marker. The 58,946-char thinking block is
   CAPPED to 4 000 chars — the rumination loop does not travel.
9. **Usage footer** — tokens/turns/wall/model from the session +
   `live.json` (the 555 footer: 161 turns, 123 922 total, Qwen3.8/helium).

No LLM call anywhere in the extractor. The generator is a pure function of
`(session.jsonl, brief, worktree) → (handoff.md, handoff.json)`; the same
input bytes always produce the same output bytes (deterministic; the only
non-determinism is the `extracted_at` timestamp, which is not part of the
section hashes).

### 3.3 Handoff schema (stable, versioned)

`handoff.md` — fixed section order, `detpipe/1`:

```
# Deterministic handoff - <ticket> - <extracted_at>
## 0. Trigger            (context-threshold | empty-final | stop-length | rumination; fired-by + evidence line)
## 1. Original brief     (verbatim)
## 2. Git state          (branch / HEAD / dirty / files changed)
## 3. Files touched      (read / modified, newest first, capped 10)
## 4. Decisions          (marked lines only)
## 5. Last tool calls    (N pairs, results truncated at 2000)
## 6. Next action        (verbatim last intent + mechanical resume line)
## 7. Transcript tail    (bounded, verbatim, capped 4000/message)
## 8. Usage              (tokens / turns / wall / model)
```

`handoff.json` — the machine sidecar:

```json
{
  "schema": "detpipe/1",
  "ticket": 555,
  "trigger": "stop-length",
  "extracted_at": "2026-10-27T...Z",
  "source": { "session_file": "...", "brief": "session-first-user", "worktree": "..." },
  "sha256": { "brief": "...", "git_state": "...", "files": "...",
              "decisions": "...", "tool_calls": "...", "next_action": "...",
              "transcript_tail": "...", "usage": "..." }
}
```

The per-section sha256 is the audit: the next run (or the warden) can
re-derive each section from the session record and verify the handoff was
not altered in transit. A handoff that fails its own hash check is
untrusted — the run is flagged, not silently continued.

### 3.4 Re-dispatch contract — who calls, where it lands

**Terminal path (the 555 case).** `run-wrapper.sh`, after the G6 block,
invokes the generator (best-effort, warn-only, never changes the exit
code): `python3 <detpipe> --session $ART/session.jsonl --wt $WT --ticket $T
--art $ART` → writes `handoff.md` + `handoff.json` into `$ART` (`.fleetwork/`),
so they land in the salvage tar and are durable on
`refs/heads/fleetwork-salvage/<ticket>` even when the worktree is gc'd.
`executor.finish()` adds `handoff_file` to the terminal record;
`wake-receiver.py` adds a `handoff=<ref-or-path>` field to the #30 wake
line. The requesting agent's job shrinks from *write the continuation brief*
to *attach the handoff verbatim + pick the next task item from section 1/6*.
The continuation brief is the handoff doc, byte-for-byte, plus at most one
line of operator intent. **No model-authored summary crosses the seam.**

**In-run path (forced handoff, where feasible).** The bridge
(`handover.ts`) already returns a deterministic doc as pi's custom
compaction result at the 80% threshold (mechanism A) and seeds the fresh
session from it (mechanism B, `buildSeedKickoff`). The change: the bridge
shells out to the detpipe generator (or imports the same pure functions)
so the in-run doc and the terminal doc share ONE schema — a persistent
session compacted at 80% and a fleetwork run salvaged at `empty-final`
produce interchangeable handoffs. The new triggers (`stop-length`,
`rumination`) are added to `shouldHandoff()` as event reasons; the
`rumination` detector is the pure function of 3.2.

**New-session contract.** A continuation session starts from:
(1) the deterministic handoff doc (sections 0–8), (2) the bounded verbatim
transcript tail (section 7 — the only raw conversation content carried),
(3) the todo board if present. It does NOT start from the previous
session's full context, and it does NOT start from a model-authored
summary. The new session's first turn is a small context (handoff doc ≈
12k-token cap, matching the bridge's `sizeGuardTokens`), so the
rumination substrate (long context + tight loop) starts at ~12k, not
~124k.

### 3.5 Why this class avoids the perplexion failure

1. **The handoff no longer carries a model-authored summary.** 555's
   continuation brief today is written by an LLM reading a 5-line manifest.
   With detpipe it is a byte-identical copy of what was observed: the
   original brief, the git state, the last 10 tool calls, the last stated
   intent. A degraded model cannot corrupt a copy.
2. **The new session never inherits the rumination loop.** The 58,946-char
   thinking block is capped to 4 000 chars; the transcript tail is 12
   messages. The repeated-shingle substrate (the same 40-char window 7–9×)
   is not in the new context — the loop has no seed. The case study's
   verdict (gradual accumulation with long context, not a compaction
   cliff) means cutting the context at the trigger point is exactly the
   right intervention: the fatal turn was at 107.5k input; the detpipe
   continuation starts at ~12k.
3. **State is checkable/auditable.** `handoff.json` carries per-section
   sha256 over the session record; the trigger is recorded with evidence
   (the `stopReason=length` line, the usage numbers). A handoff is either
   verified or flagged — there is no silent lossy middle. The 555 case is
   replayable: the generator run against
   `/srv/fleetwork/work/555/.fleetwork/session.jsonl` reproduces the demo
   committed with this doc (`dispatch/detpipe/demo/`).
4. **The in-run trigger cuts the loop before the budget.** The 555 episodes
   (8.7k→19k→12k→23k→11.4k→58.9k) all recovered by the model noticing it
   was "going in circles" and resetting — a model-side fix that failed on
   turn 161. The mechanical detector (repeated shingles, escalating thinking
   size) fires at episode 3–4, before the 16 384-token budget is gone, and
   hands off deterministically: the reset no longer depends on the model
   noticing.

### 3.6 Cross-repo notes (hall-monitor — warden routes the issue)

Changes needed in `marzukia/hall-monitor` (`deploy/fleetwork/`):

1. **`run-wrapper.sh`** — after the G6 block (before the salvage tar),
   invoke the detpipe generator against `$ART/session.jsonl` + `$WT` +
   `$T`; warn-only on failure (a missing handoff must never block the
   salvage). The `handoff.md`/`handoff.json` in `$ART` then ride the
   existing salvage tar.
2. **`executor.py`** — `finish()`: add `handoff_file` (path in the
   worktree/artifact dir) to the terminal record. Optional in-run trigger:
   `read_live()` already reads `live.json`; when tokens ≥ 80% of the
   profile window, fire a `kind=handoff` wall-flag-style wake (the F62
   pattern) so the requesting agent can pre-stage the continuation.
3. **`wake-receiver.py`** — add the `handoff` field to the #30 wake line
   (one field, stdlib-only, mirroring `work_signal`).
4. **`fleet/runs.py`** — no change (the record carries the new field;
   `terminal_actions()` is unchanged).

No changes to `@earendil-works/pi-coding-agent` (pi stays untouched — the
piping is around it). No changes to the bridge's LLM path (already
retired).

## 4. Reference implementation

`dispatch/detpipe/` — Python (uv + ruff), zero LLM calls, zero third-party
runtime deps (stdlib only; uv manages the dev deps: pytest, ruff).

- `detpipe.py` — the generator: session parser (pi v3 JSONL), trigger
  evaluator, mechanical extractor, doc + sidecar renderer, rumination
  detector. CLI:
  `python -m detpipe --session <session.jsonl> [--brief <file>] [--worktree
  <dir>] [--out <handoff.md>] [--json <handoff.json>] [--tail N]
  [--tool-calls N] [--window N]`.
- `tests/test_detpipe.py` — pytest: fixture built from the REAL ticket-555
  session (the case-study turn 161: stopReason=length, 58 946-char thinking
  block, usage input=107 538/output=16 384/total=123 922) + synthetic
  sessions for each trigger.
- `demo/handoff-555.md` + `demo/handoff-555.json` — generated from the real
  555 session record, committed to this branch (the audit trail).

## 5. Verification

- `uv run pytest` in `dispatch/detpipe/` — all tests pass, including the
  555-fixture test that asserts: trigger `stop-length` fires; the thinking
  block is capped; the brief section is the verbatim first user message;
  the sidecar hashes re-derive from the session.
- `uv run ruff check` — clean.
- Demo: `python -m detpipe --session /srv/fleetwork/work/555/.fleetwork/
  session.jsonl --out demo/handoff-555.md --json demo/handoff-555.json`
  (reproducible; committed output).
