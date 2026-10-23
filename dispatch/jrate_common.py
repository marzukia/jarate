"""Shared python helpers for the dispatch/ shell scripts (issue #262).

Imported by the python heredocs in jarate-bg and pi-postcheck.sh (the drain,
#279, retired jarate-wait/-tail/-kill; the watchdog went in #280/3c).
dispatch/lib.sh
points $JRATE_LIB_DIR at this file's directory; each heredoc does
``sys.path.insert(0, os.environ["JRATE_LIB_DIR"])`` before importing.

Everything here is byte-sensitive: the 40-col frame contract is
docs/STYLE.md 2.3 and the dispatch tests pin exact strings, so a change
here changes the webhook output of every [bg: producer.
"""

# --- 40-col frame geometry (docs/STYLE.md 2.3) -----------------------------
# Layout: 2-col bar prefix + 6-col label + " : " (3) + value.
FRAME_W = 40  # mobile budget (docs/STYLE.md 2.3, measured 2026-09-15)
VAL_W = FRAME_W - 11  # 29-col value budget


def clip_end(s, max):
    """Clip to max cols, ellipsizing the TAIL."""
    s = str(s)
    return s if len(s) <= max else (s[: max - 1] + "\u2026" if max > 1 else "\u2026")


def clip_start(s, max):
    """Clip to max cols, ellipsizing the HEAD (long id/paths keep their
    tail - the actionable end)."""
    s = str(s)
    return s if len(s) <= max else (
        "\u2026" + s[len(s) - (max - 1):] if max > 1 else "\u2026"
    )


def kv(key, val, head=False):
    """One `├ key : value` frame line, clipped to the 40-col budget."""
    cut = clip_start if head else clip_end
    return "\u251c " + key.ljust(6) + " : " + cut(val, VAL_W)


# --- Discord embed colors (single source, issue #262) ----------------------
# The same semantics were previously re-typed as decimal/hex literals in
# five heredocs across four files. (The watchdog's ORANGE_DEAD/RED_STUCK/
# YELLOW_WARN went with the script, #280/3c.)
GREEN_ALIVE = 0x2ECC71  # green: running / informational (SIGNAL, EVENT)
RED_FAIL = 0xED4245  # red: failure (postcheck fail)
GREEN_OK = 0x57F287  # green: ok (postcheck ok)


# --- settings channel selection --------------------------------------------
def default_channel(channels):
    """Bridge parity (channel/types.ts getDefaultChannel): the first
    enabled channel marked default, else the first enabled channel,
    else {} (the caller degrades on an empty result)."""
    chs = [c for c in (channels or []) if c.get("enabled")]
    for c in chs:
        if c.get("default"):
            return c
    return chs[0] if chs else {}
