"""detpipe tests — synthetic triggers + the REAL ticket-555 session.

The 555 fixture asserts the case-study facts (2026-10-26, turn 161):
stopReason=length, 58,946-char thinking-only block, usage
input=107,538 / output=16,384 / total=123,922, g6_reason=empty-final.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import detpipe  # noqa: E402

REAL_555 = "/srv/fleetwork/work/555/.fleetwork/session.jsonl"

# The 555 t161 signature: the same 40-char window repeated 7-9x. The
# repeated unit is 40 chars (a multiple of the shingle step, 8) so the
# shingle grid is alignment-stable across copies (mechanical detector).
REPEAT = "signal_batch=26 and signal_batch=27.  "  # 40 chars
FATAL_THINKING = (
    REPEAT * 400
    + "OK I'm going in circles. Let me just look at the problem from a "
    "different angle. The fix is to ensure that the worker is not "
    "executing tasks during the capture. 3"
)


def write_session(
    path: Path, turns: list[dict], user_text: str = "BRIEF VERBATIM"
) -> None:
    lines = [
        json.dumps(
            {
                "type": "session",
                "version": 3,
                "id": "test-sess",
                "timestamp": "2026-10-26T13:50:49Z",
                "cwd": "/tmp/wt",
            }
        )
    ]
    if user_text:
        lines.append(
            json.dumps(
                {
                    "type": "message",
                    "id": "u1",
                    "timestamp": "2026-10-26T13:50:49Z",
                    "message": {
                        "role": "user",
                        "content": [{"type": "text", "text": user_text}],
                    },
                }
            )
        )
    for i, t in enumerate(turns):
        content = []
        if t.get("thinking"):
            content.append({"type": "thinking", "thinking": t["thinking"]})
        if t.get("text"):
            content.append({"type": "text", "text": t["text"]})
        for tc in t.get("tool_calls", []):
            content.append(
                {
                    "type": "toolCall",
                    "id": tc["id"],
                    "name": tc["name"],
                    "arguments": tc.get("arguments", {}),
                }
            )
        lines.append(
            json.dumps(
                {
                    "type": "message",
                    "id": f"a{i}",
                    "timestamp": t.get("ts", "2026-10-26T14:00:00Z"),
                    "message": {
                        "role": "assistant",
                        "content": content,
                        "stopReason": t.get("stop_reason", "stop"),
                        "usage": t.get(
                            "usage",
                            {"input": 1000, "output": 100, "totalTokens": 1100},
                        ),
                        "model": "Qwen3.8",
                        "provider": "helium",
                    },
                }
            )
        )
        for tc in t.get("tool_calls", []):
            if tc.get("result") is not None:
                lines.append(
                    json.dumps(
                        {
                            "type": "message",
                            "id": f"r{tc['id']}",
                            "timestamp": t.get("ts", "2026-10-26T14:00:01Z"),
                            "message": {
                                "role": "toolResult",
                                "toolCallId": tc["id"],
                                "toolName": tc["name"],
                                "isError": tc.get("error", False),
                                "content": [
                                    {"type": "text", "text": tc["result"]}
                                ],
                            },
                        }
                    )
                )
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def test_stop_length_trigger_and_caps(tmp_path: Path) -> None:
    """The 555 case: stopReason=length, thinking-only, zero text."""
    s = tmp_path / "s.jsonl"
    write_session(
        s,
        [
            {
                "thinking": "short coherent thinking",
                "text": "Now I can see the problem clearly.",
                "tool_calls": [
                    {
                        "id": "c1",
                        "name": "read",
                        "arguments": {"path": "/tmp/a.cpp"},
                        "result": "line1\nline2",
                    }
                ],
            },
            {
                "thinking": FATAL_THINKING,
                "stop_reason": "length",
                "usage": {
                    "input": 107538,
                    "output": 16384,
                    "totalTokens": 123922,
                },
            },
        ],
    )
    # window=1M isolates stop-length/rumination (no context-threshold).
    doc, sidecar = detpipe.generate(
        s, window=1_000_000, extracted_at="2026-10-27T00:00:00Z"
    )
    trig = sidecar["triggers"]
    assert "stop-length" in trig
    assert "rumination" in trig
    # The thinking block is capped in the transcript tail (4000 chars).
    tail = doc.split("## 7. Transcript tail")[1].split("## 8.")[0]
    assert "…[truncated]" in tail
    assert "signal_batch=26" in tail  # verbatim content survives the cap
    # Next action: mechanical resume, not a re-derivation.
    na = doc.split("## 6. Next action")[1].split("## 7.")[0]
    assert "truncated" in na
    assert "last stated intent" in na
    # Brief verbatim.
    brief = doc.split("## 1. Original brief")[1].split("## 2.")[0]
    assert "BRIEF VERBATIM" in brief
    # Sidecar hashes re-derive.
    import hashlib

    body = doc.split("## 1. Original brief (verbatim)")[1].split("## 2.")[0].strip("\n")
    assert sidecar["sha256"]["brief"] == hashlib.sha256(body.encode()).hexdigest()
    assert sidecar["schema"] == "detpipe/1"
    assert sidecar["trigger"] == "stop-length"


def test_empty_final_trigger(tmp_path: Path) -> None:
    s = tmp_path / "s.jsonl"
    write_session(
        s,
        [
            {
                "tool_calls": [
                    {
                        "id": "c1",
                        "name": "bash",
                        "arguments": {"command": "sleep 170"},
                        "result": "",
                    }
                ]
            }
        ],
    )
    _, sidecar = detpipe.generate(s)
    assert "empty-final" in sidecar["triggers"]
    assert "stop-length" not in sidecar["triggers"]


def test_context_threshold_trigger(tmp_path: Path) -> None:
    s = tmp_path / "s.jsonl"
    write_session(
        s,
        [
            {
                "text": "done",
                "usage": {"input": 110000, "output": 1000, "totalTokens": 111000},
            }
        ],
    )
    _, sidecar = detpipe.generate(s, window=131072)
    assert "context-threshold" in sidecar["triggers"]
    # Under threshold: no trigger.
    _, sidecar2 = detpipe.generate(s, window=1_000_000)
    assert "context-threshold" not in sidecar2["triggers"]


def test_rumination_escalation(tmp_path: Path) -> None:
    s = tmp_path / "s.jsonl"
    big = "x" * 8_500  # >= 8000 chars, no repeated shingles
    write_session(
        s,
        [
            {"thinking": big, "text": "a"},
            {"thinking": big, "text": "b"},
            {"thinking": big, "text": "c"},
        ],
    )
    rep = detpipe.rumination_report(detpipe.parse_session(s).turns)
    assert rep["escalation"] is True
    assert rep["fired"] is True


def test_files_touched_newest_first_and_invariant(tmp_path: Path) -> None:
    s = tmp_path / "s.jsonl"
    write_session(
        s,
        [
            {
                "tool_calls": [
                    {
                        "id": "c1",
                        "name": "read",
                        "arguments": {"path": "/a"},
                        "result": "",
                    },
                    {
                        "id": "c2",
                        "name": "read",
                        "arguments": {"path": "/b"},
                        "result": "",
                    },
                ]
            },
            {
                "tool_calls": [
                    {
                        "id": "c3",
                        "name": "write",
                        "arguments": {"path": "/a"},
                        "result": "",
                    },
                    {
                        "id": "c4",
                        "name": "edit",
                        "arguments": {"path": "/c"},
                        "result": "",
                    },
                ]
            },
        ],
    )
    rd, mod = detpipe.extract_files_touched(detpipe.parse_session(s))
    # /a is modified later -> leaves the read list (read=read-only invariant).
    assert rd == ["/b"]
    # Newest first: /c (t1 edit) before /a (t1 write).
    assert mod == ["/c", "/a"]


def test_brief_fallback_to_first_user_message(tmp_path: Path) -> None:
    s = tmp_path / "s.jsonl"
    write_session(s, [{"text": "ok"}], user_text="THE DISPATCH BRIEF VERBATIM")
    doc, _ = detpipe.generate(s, brief_path=str(tmp_path / "missing-brief"))
    assert "THE DISPATCH BRIEF VERBATIM" in doc


def test_tool_call_results_truncated(tmp_path: Path) -> None:
    s = tmp_path / "s.jsonl"
    write_session(
        s,
        [
            {
                "tool_calls": [
                    {
                        "id": "c1",
                        "name": "bash",
                        "arguments": {"command": "ls"},
                        "result": "x" * 5_000,
                    }
                ]
            }
        ],
    )
    doc, _ = detpipe.generate(s)
    tc = doc.split("## 5. Last tool calls")[1].split("## 6.")[0]
    assert "…[truncated]" in tc
    assert len(tc) < 6_000


def test_real_555_session() -> None:
    """Against the REAL ticket-555 session (case study, 2026-10-26)."""
    if not Path(REAL_555).is_file():
        import pytest

        pytest.skip("555 session not readable on this host")
    sess = detpipe.parse_session(REAL_555)
    assert len(sess.turns) == 161
    last = sess.turns[-1]
    assert last.stop_reason == "length"
    assert last.usage.get("input") == 107538
    assert last.usage.get("output") == 16384
    assert last.usage.get("totalTokens") == 123922
    assert len(last.thinking) >= 50_000
    assert not last.text.strip()
    triggers = detpipe.evaluate_triggers(sess, window=131072)
    names = [t["trigger"] for t in triggers]
    assert "stop-length" in names
    assert "rumination" in names
    doc, sidecar = detpipe.generate(REAL_555)
    assert "signal_batch=26" in doc  # the repeated analysis, verbatim, capped
    assert "…[truncated]" in doc


def test_determinism(tmp_path: Path) -> None:
    """Same input bytes -> same output bytes (the piping contract)."""
    s = tmp_path / "s.jsonl"
    write_session(
        s,
        [
            {
                "thinking": FATAL_THINKING,
                "stop_reason": "length",
                "usage": {"input": 107538, "output": 16384, "totalTokens": 123922},
            }
        ],
    )
    d1, sc1 = detpipe.generate(s, window=1_000_000, extracted_at="2026-10-27T00:00:00Z")
    d2, sc2 = detpipe.generate(s, window=1_000_000, extracted_at="2026-10-27T00:00:00Z")
    assert d1 == d2
    assert sc1 == sc2
