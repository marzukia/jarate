"""detpipe — deterministic handoff generator (zero LLM in the loop).

Operator order 2026-10-27 (via warden): context transfer between run
continuations with no model-authored summary. See docs/DETERMINISTIC-PIPING.md.

Pure function of (session.jsonl, brief, worktree) -> (handoff.md,
handoff.json). Stdlib only; no LLM calls, no network.

Triggers (any one fires; the fired trigger + evidence are recorded):
  context-threshold  last usage total >= 80% of the context window
  empty-final        last assistant message has zero text blocks
  stop-length        last assistant message stopReason=length, no text
  rumination         repeated near-duplicate thinking windows (mechanical)

Every section is a byte-for-byte copy or a mechanical transform
(cap/dedupe/regex). Nothing is paraphrased.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import subprocess
import sys
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path

SCHEMA = "detpipe/1"

# Mechanical caps (mirrors packages/bridge/channel/handover.ts).
FILE_CAP = 10          # files per tag, newest first (bridge FILE_TAG_CAP)
MSG_CAP = 4_000        # per-message transcript cap (bridge MSG_CAP)
RESULT_CAP = 2_000     # tool result cap
DECISION_CAP = 20      # marked decision lines
DEFAULT_TAIL = 12      # transcript tail messages
DEFAULT_TOOL_CALLS = 10
DEFAULT_WINDOW = 131_072
THRESHOLD = 0.8

# Rumination detector thresholds (case study 555: the same 40-char window
# 7-9x inside the fatal block; episodes 8.7k->19k->12k->23k->11.4k->58.9k).
SHINGLE_LEN = 40
SHINGLE_STEP = 8
SHINGLE_REPEAT = 5     # >=5 repeats of one 40-char window = episode
BIG_THINKING = 8_000   # chars
ESCALATION_TURNS = 3   # consecutive big-thinking turns

READ_TOOLS = {"read"}
MODIFY_TOOLS = {"write", "edit", "apply_patch"}
DECISION_RE = re.compile(r"^\s*(DECISION|DECIDED|NOTE)\s*:", re.IGNORECASE)


@dataclass
class Turn:
    """One assistant message (mechanical view)."""

    index: int
    timestamp: str
    stop_reason: str
    thinking: str
    text: str
    tool_calls: list[dict] = field(default_factory=list)
    usage: dict = field(default_factory=dict)
    model: str = ""
    provider: str = ""


@dataclass
class Session:
    session_id: str
    cwd: str
    first_user_text: str
    turns: list[Turn]
    tool_results: dict  # toolCallId -> {name, text, isError}
    compactions: int
    model: str
    provider: str


def _block_text(content) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        out = []
        for b in content:
            if isinstance(b, dict) and b.get("type") == "text":
                out.append(str(b.get("text") or ""))
        return "\n".join(out)
    return ""


def _thinking_text(content) -> str:
    if not isinstance(content, list):
        return ""
    out = []
    for b in content:
        if isinstance(b, dict) and b.get("type") == "thinking":
            out.append(str(b.get("thinking") or ""))
    return "\n".join(out)


def _tool_calls(content) -> list[dict]:
    if not isinstance(content, list):
        return []
    out = []
    for b in content:
        if isinstance(b, dict) and b.get("type") == "toolCall":
            out.append(
                {
                    "id": str(b.get("id") or ""),
                    "name": str(b.get("name") or ""),
                    "arguments": b.get("arguments") or {},
                }
            )
    return out


def parse_session(path: str | Path) -> Session:
    """Parse a pi v3 session JSONL (mechanical; no LLM)."""
    p = Path(path)
    session_id = ""
    cwd = ""
    first_user = ""
    turns: list[Turn] = []
    tool_results: dict = {}
    compactions = 0
    model = ""
    provider = ""
    with p.open(encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                ev = json.loads(line)
            except ValueError:
                continue
            t = ev.get("type")
            if t == "session":
                session_id = str(ev.get("id") or "")
                cwd = str(ev.get("cwd") or "")
            elif t == "compaction":
                compactions += 1
            elif t != "message":
                continue
            m = ev.get("message") or {}
            role = m.get("role")
            if role == "user" and not first_user:
                first_user = _block_text(m.get("content"))
            elif role == "assistant":
                usage = m.get("usage") or {}
                turns.append(
                    Turn(
                        index=len(turns),
                        timestamp=str(ev.get("timestamp") or ""),
                        stop_reason=str(m.get("stopReason") or ""),
                        thinking=_thinking_text(m.get("content")),
                        text=_block_text(m.get("content")),
                        tool_calls=_tool_calls(m.get("content")),
                        usage=usage,
                        model=str(m.get("model") or ""),
                        provider=str(m.get("provider") or ""),
                    )
                )
                model = m.get("model") or model
                provider = m.get("provider") or provider
            elif role == "toolResult":
                tid = str(m.get("toolCallId") or "")
                if tid:
                    tool_results[tid] = {
                        "name": str(m.get("toolName") or ""),
                        "text": _block_text(m.get("content")),
                        "isError": bool(m.get("isError")),
                    }
    return Session(
        session_id=session_id,
        cwd=cwd,
        first_user_text=first_user,
        turns=turns,
        tool_results=tool_results,
        compactions=compactions,
        model=str(model),
        provider=str(provider),
    )


# ─── Triggers ─────────────────────────────────────────────────────────────


def _shingle_counts(text: str) -> dict:
    """40-char windows, step 8; counts per distinct window (mechanical)."""
    counts: dict = {}
    if len(text) < SHINGLE_LEN:
        return counts
    for i in range(0, len(text) - SHINGLE_LEN + 1, SHINGLE_STEP):
        s = text[i : i + SHINGLE_LEN]
        counts[s] = counts.get(s, 0) + 1
    return counts


def rumination_report(turns: list[Turn], last_n: int = 5) -> dict:
    """Mechanical rumination detector over the last N turns.

    episode: one thinking block with a 40-char window repeated >=5x
    (555 t161: the same window 7-9x).
    escalation: >=3 consecutive turns with thinking >= 8000 chars
    (555: 8.7k -> 19k -> 12k -> 23k -> 11.4k -> 58.9k).
    """
    recent = turns[-last_n:] if turns else []
    episodes = []
    for t in recent:
        if not t.thinking:
            continue
        counts = _shingle_counts(t.thinking)
        top = max(counts.values()) if counts else 0
        if top >= SHINGLE_REPEAT:
            episodes.append(
                {
                    "turn": t.index,
                    "thinking_chars": len(t.thinking),
                    "max_shingle_repeat": top,
                }
            )
    big = [len(t.thinking) >= BIG_THINKING for t in recent]
    escalation = False
    run = 0
    for b in big:
        run = run + 1 if b else 0
        if run >= ESCALATION_TURNS:
            escalation = True
    return {
        "episodes": episodes,
        "escalation": escalation,
        "fired": bool(episodes) or escalation,
    }


def evaluate_triggers(
    sess: Session, window: int = DEFAULT_WINDOW
) -> list[dict]:
    """Fired triggers, in priority order (each with its evidence line)."""
    fired: list[dict] = []
    if not sess.turns:
        return fired
    last = sess.turns[-1]
    usage_total = (last.usage or {}).get("totalTokens")
    if isinstance(usage_total, (int, float)) and usage_total >= THRESHOLD * window:
        fired.append(
            {
                "trigger": "context-threshold",
                "evidence": (
                    f"last usage totalTokens={usage_total} >= "
                    f"{THRESHOLD:.0%} of window {window}"
                ),
            }
        )
    if last.stop_reason == "length" and not last.text.strip():
        fired.append(
            {
                "trigger": "stop-length",
                "evidence": (
                    f"last turn {last.index} stopReason=length, "
                    f"zero text blocks, thinking {len(last.thinking)} chars"
                ),
            }
        )
    elif not last.text.strip():
        fired.append(
            {
                "trigger": "empty-final",
                "evidence": f"last turn {last.index} has zero text blocks",
            }
        )
    rep = rumination_report(sess.turns)
    if rep["fired"]:
        eps = ", ".join(
            f"t{e['turn']}({e['thinking_chars']}ch,{e['max_shingle_repeat']}x)"
            for e in rep["episodes"]
        )
        fired.append(
            {
                "trigger": "rumination",
                "evidence": (
                    f"episodes: {eps or '(none)'}; "
                    f"escalation={rep['escalation']}"
                ),
            }
        )
    return fired


# ─── Extraction (mechanical, verbatim) ────────────────────────────────────


def extract_brief(sess: Session, brief_path: str | None) -> str:
    """Original brief verbatim: .fleetwork/brief if readable, else the
    first user message (the dispatch brief is the first user message)."""
    if brief_path:
        try:
            return Path(brief_path).read_text(encoding="utf-8").strip()
        except OSError:
            pass
    return sess.first_user_text.strip()


def extract_git_state(worktree: str | None) -> str:
    """Branch / HEAD / dirty / files changed (self-contained, pre-reap)."""
    if not worktree:
        return "(none — no worktree)"
    wt = Path(worktree)
    if not (wt / ".git").exists() and not (wt / ".fleetwork").exists():
        # a detached worktree carries .git as a file; tolerate both
        if not (wt / ".git").exists():
            return "(none — not a git worktree)"

    def git(*args: str) -> str:
        r = subprocess.run(
            ["git", "-C", str(wt), *args],
            capture_output=True,
            text=True,
            timeout=30,
        )
        return r.stdout.strip() if r.returncode == 0 else ""

    branch = git("rev-parse", "--abbrev-ref", "HEAD") or "(detached)"
    head = git("rev-parse", "HEAD")
    porcelain = git("status", "--porcelain")
    dirty = bool(porcelain)
    files = [ln[3:].strip() for ln in porcelain.splitlines() if ln[:3] != "??"]
    untracked = [ln[3:].strip() for ln in porcelain.splitlines() if ln[:3] == "??"]
    lines = [
        f"branch: {branch}",
        f"head: {head or '(unknown)'}",
        f"dirty: {'yes' if dirty else 'no'}",
    ]
    if files:
        lines.append(f"files changed: {', '.join(files[:20])}")
    if untracked:
        lines.append(f"untracked: {', '.join(untracked[:10])}")
    return "\n".join(lines)


def extract_files_touched(sess: Session) -> tuple[list[str], list[str]]:
    """Read/modified file paths from tool calls: cumulative, deduped,
    newest first, capped; read=read-only invariant (a file modified
    later leaves the read list)."""
    read: list[str] = []
    modified: list[str] = []
    for t in sess.turns:
        for tc in t.tool_calls:
            args = tc.get("arguments") if isinstance(tc.get("arguments"), dict) else {}
            p = str(args.get("path") or args.get("filePath") or "")
            if not p:
                continue
            if tc["name"] in READ_TOOLS:
                read.append(p)
            elif tc["name"] in MODIFY_TOOLS:
                modified.append(p)

    def newest_first(items: list[str]) -> list[str]:
        seen: set = set()
        out: list[str] = []
        for it in reversed(items):
            if it not in seen:
                seen.add(it)
                out.append(it)
        return out

    mod = newest_first(modified)
    mod_set = set(mod)
    rd = [p for p in newest_first(read) if p not in mod_set]
    return rd[:FILE_CAP], mod[:FILE_CAP]


def extract_decisions(sess: Session) -> list[str]:
    """Marked lines only: DECISION: / DECIDED: / NOTE: prefixes in
    assistant text. Unmarked reasoning is not a decision."""
    out: list[str] = []
    seen: set = set()
    for t in sess.turns:
        for line in t.text.splitlines():
            if DECISION_RE.match(line):
                s = line.strip()
                if s not in seen:
                    seen.add(s)
                    out.append(s)
    return out[:DECISION_CAP]


def extract_tool_calls(sess: Session, n: int = DEFAULT_TOOL_CALLS) -> list[str]:
    """Last N toolCall/toolResult pairs, results truncated (mechanical)."""
    pairs: list[tuple[Turn, dict]] = []
    for t in sess.turns:
        for tc in t.tool_calls:
            res = sess.tool_results.get(tc["id"])
            pairs.append((t, {"tc": tc, "res": res}))
    out: list[str] = []
    for t, pr in pairs[-n:]:
        tc = pr["tc"]
        res = pr["res"]
        args = json.dumps(tc["arguments"], sort_keys=True, default=str)
        line = f"[t{t.index}] {tc['name']} {args}"
        if len(line) > RESULT_CAP:
            line = line[:RESULT_CAP] + "…[truncated]"
        out.append(line)
        if res is not None:
            body = res["text"].strip()
            err = " (error)" if res["isError"] else ""
            if len(body) > RESULT_CAP:
                body = body[:RESULT_CAP] + "…[truncated]"
            out.append(f"  ->{err} {body}" if body else f"  ->{err} (empty)")
        else:
            out.append("  -> (no result recorded)")
    return out


def extract_next_action(sess: Session) -> str:
    """Last stated intent verbatim; on stop-length with no text, the
    mechanical resume line (never a re-derivation)."""
    if not sess.turns:
        return "(none — no assistant turns)"
    last = sess.turns[-1]
    if last.text.strip():
        t = last.text.strip()
        if len(t) > 2_000:
            t = t[:2_000] + "…[truncated]"
        return t
    # No text on the last turn: resume from the last real intent.
    lines = [f"resume: last turn {last.index} truncated "
            f"(stopReason={last.stop_reason or 'unknown'}), zero text"]
    for t in reversed(sess.turns[:-1]):
        if t.text.strip():
            intent = t.text.strip()
            if len(intent) > 2_000:
                intent = intent[:2_000] + "…[truncated]"
            lines.append(f"last stated intent (t{t.index}): {intent}")
            break
    if last.tool_calls:
        tc = last.tool_calls[-1]
        args = json.dumps(tc["arguments"], sort_keys=True, default=str)
        lines.append(f"pending tool call: {tc['name']} {args}")
    return "\n".join(lines)


def extract_transcript_tail(sess: Session, n: int = DEFAULT_TAIL) -> str:
    """Last N messages, verbatim, per-message capped, chronological."""
    msgs: list[tuple[str, str]] = []
    # user (first) + turns + toolResults in order is not reconstructable
    # from the parsed view alone; render what we have, newest last.
    if sess.first_user_text:
        msgs.append(("user", sess.first_user_text))
    for t in sess.turns:
        parts = []
        if t.thinking:
            parts.append(f"[thinking] {t.thinking}")
        if t.text:
            parts.append(f"[text] {t.text}")
        for tc in t.tool_calls:
            args = json.dumps(tc["arguments"], sort_keys=True, default=str)
            parts.append(f"[toolCall] {tc['name']} {args}")
        if parts:
            msgs.append((f"assistant t{t.index}", "\n".join(parts)))
    out: list[str] = []
    for role, body in msgs[-n:]:
        b = body.strip()
        if not b:
            continue
        if len(b) > MSG_CAP:
            b = b[:MSG_CAP] + "\n…[truncated]"
        out.append(f"[{role}] {b}")
    if len(msgs) > n:
        out.insert(0, f"…[transcript truncated: {len(msgs) - n} older messages dropped]")
    return "\n".join(out)


def extract_usage(sess: Session) -> str:
    if not sess.turns:
        return "(none)"
    last = sess.turns[-1]
    u = last.usage or {}
    return (
        f"turns: {len(sess.turns)}\n"
        f"last usage: input={u.get('input', '?')} "
        f"output={u.get('output', '?')} total={u.get('totalTokens', '?')}\n"
        f"compactions: {sess.compactions}\n"
        f"model: {sess.provider}/{sess.model}"
    )


# ─── Rendering ─────────────────────────────────────────────────────────────


def cap(s: str, n: int) -> str:
    return s if len(s) <= n else s[:n] + "…[truncated]"


def render_handoff(
    sess: Session,
    triggers: list[dict],
    brief: str,
    git_state: str,
    files_read: list[str],
    files_modified: list[str],
    decisions: list[str],
    tool_calls: list[str],
    next_action: str,
    transcript: str,
    usage: str,
    extracted_at: str,
) -> tuple[str, dict]:
    """Render (handoff.md, handoff.json). Section bodies are hashed in
    the sidecar (audit: re-derivable from the session record)."""
    trig = (
        "; ".join(f"{t['trigger']} ({t['evidence']})" for t in triggers)
        or "(none — manual generation)"
    )
    files = "\n".join(
        [f"read: {', '.join(files_read) or '(none)'}"]
        + [f"modified: {', '.join(files_modified) or '(none)'}"]
    )
    dec = "\n".join(decisions) if decisions else "(none)"
    tc = "\n".join(tool_calls) if tool_calls else "(none)"
    sections = {
        "trigger": trig,
        "brief": brief or "(none)",
        "git_state": git_state,
        "files": files,
        "decisions": dec,
        "tool_calls": tc,
        "next_action": next_action,
        "transcript_tail": transcript or "(none)",
        "usage": usage,
    }
    titles = [
        "0. Trigger",
        "1. Original brief (verbatim)",
        "2. Git state",
        "3. Files touched",
        "4. Decisions (marked lines only)",
        "5. Last tool calls (truncated results)",
        "6. Next action",
        "7. Transcript tail (bounded, verbatim)",
        "8. Usage",
    ]
    md = [f"# Deterministic handoff - {sess.session_id or 'unknown'} - {extracted_at}"]
    for title, key in zip(titles, sections, strict=True):
        md.append(f"## {title}\n{sections[key]}")
    doc = "\n\n".join(md) + "\n"
    sidecar = {
        "schema": SCHEMA,
        "session": sess.session_id,
        "trigger": triggers[0]["trigger"] if triggers else None,
        "triggers": [t["trigger"] for t in triggers],
        "extracted_at": extracted_at,
        "source": {"cwd": sess.cwd},
        "sha256": {
            k: hashlib.sha256(v.encode("utf-8")).hexdigest() for k, v in sections.items()
        },
    }
    return doc, sidecar


def generate(
    session_path: str | Path,
    brief_path: str | None = None,
    worktree: str | None = None,
    window: int = DEFAULT_WINDOW,
    tail: int = DEFAULT_TAIL,
    tool_calls: int = DEFAULT_TOOL_CALLS,
    extracted_at: str | None = None,
) -> tuple[str, dict]:
    """The pure entry point: session record -> (handoff.md, handoff.json)."""
    sess = parse_session(session_path)
    triggers = evaluate_triggers(sess, window)
    return render_handoff(
        sess,
        triggers,
        extract_brief(sess, brief_path),
        extract_git_state(worktree),
        *extract_files_touched(sess),
        extract_decisions(sess),
        extract_tool_calls(sess, tool_calls),
        extract_next_action(sess),
        extract_transcript_tail(sess, tail),
        extract_usage(sess),
        extracted_at or datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    )


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="detpipe", description=__doc__)
    ap.add_argument("--session", required=True, help="pi session JSONL")
    ap.add_argument(
        "--brief", default=None, help=".fleetwork/brief (else first user message)"
    )
    ap.add_argument("--worktree", default=None, help="worktree dir (git state)")
    ap.add_argument("--window", type=int, default=DEFAULT_WINDOW)
    ap.add_argument("--tail", type=int, default=DEFAULT_TAIL)
    ap.add_argument("--tool-calls", type=int, default=DEFAULT_TOOL_CALLS)
    ap.add_argument("--out", default=None, help="handoff.md path (default stdout)")
    ap.add_argument("--json", default=None, help="handoff.json path")
    ap.add_argument("--at", default=None, help="extracted_at stamp (reproducible output)")
    args = ap.parse_args(argv)
    doc, sidecar = generate(
        args.session,
        brief_path=args.brief,
        worktree=args.worktree,
        window=args.window,
        tail=args.tail,
        tool_calls=args.tool_calls,
        extracted_at=args.at,
    )
    if args.out:
        Path(args.out).write_text(doc, encoding="utf-8")
    else:
        sys.stdout.write(doc)
    if args.json:
        Path(args.json).write_text(
            json.dumps(sidecar, indent=2, sort_keys=True) + "\n", encoding="utf-8"
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
