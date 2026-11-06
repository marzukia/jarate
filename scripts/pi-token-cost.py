#!/usr/bin/env python3
"""Measure total pi LLM token usage across agent home dirs and price it.

Vendored 2026-11-06 from /home/monky/scripts/pi-token-cost.py (hydrogen) so
the ctx-report dependency is versioned in-repo (jarate-migration A2, #346).
The repo copy is the source; the box ~/scripts copy tracks it.

DEPRECATED ESTIMATOR. Authoritative token costs live in hall-monitor
(deploy/fleetwork/price-sheet.json, priced by deploy/fleetwork/pi_token_cost.py
and the Run ledger). The ctx-report cost leg moves to the hallmon ledger in
B5; this script is deleted in B6.

Usage:
    pi-token-cost.py [HOME ...] [--model qwen/qwen3.8-27b] [--json]

Defaults to HOME = /home/monky /home/frank /home/jimmy. Each HOME is a pi
agent home dir (contains .pi/agent*/sessions/*/*.jsonl).

How it works:
  * For every HOME it scans *.jsonl session files and sums assistant usage.
  * Only lines with "type":"message" (NOT "message_update" streaming deltas)
    and message.role == "assistant" are counted, once each.
  * Dedup rule: assistant turns are de-duplicated by their top-level session
    entry "id". On this fleet those ids are globally unique per turn and never
    span two files, so summing each id once = each billed turn exactly once
    (verified 0 cross-file id overlap).
  * Token accounting (verified on all lines): totalTokens == input + output +
    cacheRead. So "input" = NEW (uncached) prompt tokens and "cacheRead" =
    cached prompt tokens; "output" = completion tokens.
  * Cost model (OpenRouter, $/token -> we use $/1M internally is just 1e6 scale):
        cost = input*prompt + output*completion
             + cacheRead*cache_read + cacheWrite*(cache_write or prompt)
    When the model entry has no input_cache_write price, cacheWrite is priced
    at the prompt rate (assumption, noted in the report).

For a HOME not readable by the current user (e.g. /home/frank owned 0700),
the scan is run remotely. No secret is ever hardcoded in this file:
    primary   ssh -o BatchMode=yes SSH_USER@127.0.0.1 "sudo -n -u <owner> <scan>"
    fallback  sshpass -e ssh SSH_USER@127.0.0.1 \
                "echo 'PASS' | sudo -S -u <owner> <scan>"
The fallback reads PASS from ~/.config/sudo-pass (last resort, only when the
primary keyless path is unavailable) and passes it via the SSHPASS env
(sshpass -e), never in argv. On hydrogen the primary path is live: monky ->
andryo keyless ssh, andryo passwordless sudo. The owner user is derived from
the basename of HOME.
"""
import sys
import os
import json
import glob
import base64
import subprocess
import argparse
import urllib.request

DEFAULT_HOMES = ["/home/monky", "/home/frank", "/home/jimmy"]
DEFAULT_MODEL = "qwen/qwen3.8-27b"
SSH_HOST = "andryo@127.0.0.1"
SSH_USER = "andryo"
def _load_sudo_pass():
    import os
    for p in (os.path.expanduser("~/.config/sudo-pass"), "/home/monky/.config/sudo-pass"):
        try:
            with open(p) as fh:
                v = fh.read().strip()
                if v:
                    return v
        except Exception:
            continue
    return ""
SUDO_PASS = _load_sudo_pass()

# Runs in the target user's context (local subprocess or remote sudo).
# Reads the home dir from $PI_HOME. Prints a single JSON stats object.
PARSER = r"""
import json, glob, os, sys
home = os.environ["PI_HOME"]
files = sorted(set(glob.glob(os.path.join(home, ".pi", "agent*", "sessions", "*", "*.jsonl")))
               | set(glob.glob(os.path.join(home, ".pi", "agent*", "sessions", "*", "*.jsonl.reset-*"))))
# .reset-* = pre-compaction history pi rotates out of the live file
# (2026-10-10: the jsonl-only glob silently dropped ~3B tokens of billing
# data, mostly frank's long compacted sessions). Dedup by id below
# handles any turn present in both forms.
stats = {"files": 0, "turns": 0, "input": 0, "output": 0,
         "cacheRead": 0, "cacheWrite": 0, "reasoning": 0, "totalTokens": 0}
seen = set()
for f in files:
    try:
        fh = open(f, "r")
    except Exception:
        continue
    stats["files"] += 1
    for line in fh:
        if '"type":"message"' not in line:
            continue  # skip message_update streaming deltas + other types
        try:
            o = json.loads(line)
        except Exception:
            continue
        m = o.get("message", {})
        if m.get("role") != "assistant":
            continue
        u = m.get("usage")
        if not isinstance(u, dict):
            continue
        tid = o.get("id")
        if tid is not None:
            if tid in seen:
                continue  # dedup: count each assistant turn once
            seen.add(tid)
        for k in ("input", "output", "cacheRead", "cacheWrite", "reasoning", "totalTokens"):
            stats[k] += u.get(k, 0) or 0
        stats["turns"] += 1
    fh.close()
print(json.dumps(stats))
"""


def _run_local(home):
    env = dict(os.environ, PI_HOME=home)
    p = subprocess.run([sys.executable, "-c", PARSER],
                       env=env, capture_output=True, text=True)
    if p.returncode != 0:
        raise RuntimeError("local scan failed: " + (p.stderr or "").strip())
    return json.loads(p.stdout.strip().splitlines()[-1])


def _run_remote(home):
    owner = os.path.basename(home.rstrip("/"))
    b64 = base64.b64encode(PARSER.encode()).decode()
    driver = ('PI_HOME=%s python3 -c '
              '"import base64,os,sys;'
              'exec(base64.b64decode(sys.argv[1]).decode())" %s'
              % (home, b64))
    # primary: keyless ssh + passwordless sudo (no secret in argv or env)
    inner = "sudo -n -u %s bash -c '%s'" % (owner, driver)
    p = subprocess.run(["ssh", "-o", "BatchMode=yes", SSH_HOST, inner],
                       capture_output=True, text=True)
    if p.returncode != 0 and SUDO_PASS:
        # fallback: sshpass + passworded sudo (last resort)
        inner_pw = "echo '%s' | sudo -S -u %s bash -c '%s'" % (SUDO_PASS, owner, driver)
        p = subprocess.run(["sshpass", "-e", "ssh", SSH_HOST, inner_pw],
                           capture_output=True, text=True,
                           env=dict(os.environ, SSHPASS=SUDO_PASS))
    out = p.stdout.strip()
    # drop the [sudo] password echo line if present
    last = [ln for ln in out.splitlines() if ln.strip().startswith("{")]
    if p.returncode != 0 and not last:
        raise RuntimeError("remote scan failed: " + (p.stderr or "").strip())
    return json.loads(last[-1])


def scan_home(home):
    """Return stats dict for one agent home, local or via sudo."""
    if os.access(os.path.join(home, ".pi"), os.R_OK):
        return _run_local(home)
    return _run_remote(home)


def fetch_pricing(model):
    """Return OpenRouter pricing dict for a model id ($/token strings)."""
    url = "https://openrouter.ai/api/v1/models"
    with urllib.request.urlopen(url, timeout=30) as r:
        data = json.load(r)
    for m in data.get("data", []):
        if m.get("id") == model:
            return m.get("pricing", {})
    # fuzzy: qwen + 27b, plain (non -vl / non -reasoning)
    cands = [m for m in data.get("data", [])
             if "qwen" in m.get("id", "").lower() and "27b" in m.get("id", "").lower()]
    plain = [m for m in cands
             if "-vl" not in m["id"] and "reasoning" not in m["id"].lower()]
    if plain:
        return plain[0].get("pricing", {})
    if cands:
        return cands[0].get("pricing", {})
    raise RuntimeError("model %s not found on OpenRouter" % model)


def _pp(v):
    return float(v) if v is not None else None


def price_agent(stats, pricing):
    prompt = _pp(pricing.get("prompt")) or 0.0
    completion = _pp(pricing.get("completion")) or 0.0
    cache_read = _pp(pricing.get("input_cache_read"))
    cache_write = _pp(pricing.get("input_cache_write"))
    if cache_read is None:
        cache_read = prompt  # no cache price -> bill at prompt rate
    if cache_write is None:
        cache_write = prompt  # no cache-write price -> bill at prompt rate (assumption)
    cost = (stats["input"] * prompt
            + stats["output"] * completion
            + stats["cacheRead"] * cache_read
            + stats["cacheWrite"] * cache_write)
    return {
        "prompt_per_m": prompt * 1e6,
        "completion_per_m": completion * 1e6,
        "cache_read_per_m": cache_read * 1e6,
        "cache_write_per_m": cache_write * 1e6,
        "cache_read_assumed": _pp(pricing.get("input_cache_read")) is None,
        "cache_write_assumed": _pp(pricing.get("input_cache_write")) is None,
        "cost": cost,
    }


def main(argv):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("homes", nargs="*", default=DEFAULT_HOMES)
    ap.add_argument("--model", default=DEFAULT_MODEL)
    ap.add_argument("--json", action="store_true", help="print raw JSON")
    args = ap.parse_args(argv)

    pricing = fetch_pricing(args.model)
    rows = []
    for home in args.homes:
        stats = scan_home(home)
        priced = price_agent(stats, pricing)
        rows.append({"home": home, "stats": stats, "pricing": priced})

    if args.json:
        print(json.dumps({"model": args.model,
                          "openrouter_pricing": pricing,
                          "agents": rows}, indent=2))
        return 0

    p = rows[0]["pricing"]

    # Mechanical, jarate-STYLE output: a box-drawing frame (<= 40 cols, full
    # border, 2-col gutter, self-contained) that reads on Discord mobile. Each
    # agent = one row; the TOTAL row closes the frame. Token counts in SI
    # (K/M/B, 2 dp), cost as $X,XXX.XX. Agents sorted alphabetically.
    def tok(n):  # tokens -> "1.23M" / "4.56B" / "955K" (2 dp, SI 1e3/1e6/1e9)
        if n >= 1e9:
            return "%.2fB" % (n / 1e9)
        if n >= 1e6:
            return "%.2fM" % (n / 1e6)
        if n >= 1e3:
            return "%.0fK" % (n / 1e3)
        return str(n)

    def money(x):
        return "${:,.0f}".format(x)

    rows = sorted(rows, key=lambda r: os.path.basename(r["home"]))

    tot = dict(files=0, turns=0, input=0, output=0, cacheRead=0, cacheWrite=0,
               totalTokens=0, cost=0.0)
    body = []
    for r in rows:
        s = r["stats"]
        body.append((os.path.basename(r["home"]), s, r["pricing"]["cost"]))
        tot["files"] += s["files"]; tot["turns"] += s["turns"]
        tot["input"] += s["input"]; tot["output"] += s["output"]
        tot["cacheRead"] += s["cacheRead"]; tot["cacheWrite"] += s["cacheWrite"]
        tot["totalTokens"] += s["totalTokens"]; tot["cost"] += r["pricing"]["cost"]

    # jarate frame: EVERY line gets a gutter (┌ top, ├ rows, └ bottom),
    # exactly like the /jobs + pi-bg embeds. No right border. 2-col gutter.
    # One block per agent: a ├ header + ├ breakdown rows; TOTAL uses └ on
    # its final row. All rows <= ~38 cols.
    out = ["┌ tokens · %s" % args.model.split("/")[-1]]
    # Flat frame, one section per agent + a TOTAL, matching the canonical
    # usageFrame convention (usage.ts): "├ field : value", aligned colons,
    # "└" on the final line of each section. No nested │ │ tree.
    def money2(x):
        return "${:,.2f}".format(x)

    # aligned label width for the field names (in/out/cached/est/total)
    FIELD_W = 7  # "cached " is the widest field label (6) + 1

    def section(title, s, cost):
        lines = ["┌ %s" % title]
        lines.append("├ %-*s: %s" % (FIELD_W, "total", tok(s["totalTokens"])))
        lines.append("├ %-*s: %s" % (FIELD_W, "in", tok(s["input"])))
        lines.append("├ %-*s: %s" % (FIELD_W, "out", tok(s["output"])))
        lines.append("├ %-*s: %s" % (FIELD_W, "cached", tok(s["cacheRead"])))
        lines.append("└ %-*s: %s" % (FIELD_W, "est", money2(cost)))
        return lines

    out = []
    for i, (label, s, cost) in enumerate(body):
        if i > 0:
            out.append("")  # blank line between agent sections
        out.extend(section(label, s, cost))
    out.append("")
    out.extend(section("TOTAL", tot, tot["cost"]))
    print("\n".join(out))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
