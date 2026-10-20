#!/usr/bin/env bash
# pi-postcheck: runs ~90s after a pi.service restart (systemd-run --on-active).
# 1) posts a visible status line to THIS agent's default channel (bot API,
#    code-formatted per STYLE.md 4.4) - bot REST, no wake, keeps its shape
# 2) posts a heartbeat to the pi-dispatch Discord WEBHOOK (the machine-
#    wake lane: the webhook post is what isBgWebhook exempts from the
#    other-bot filter - a bot-API post would be self-skipped). The webhook
#    post is polled back as a turn and wakes the agent. Shape (2026-10-19
#    EMBED CARD family; 2026-10-21, Andryo: the visible [bg: content
#    prefix is dropped): content is EMPTY, the EMBED AUTHOR is
#    `pi-bg pi-restart · ok|fail` (the machine-wake marker - the
#    serialized "Author: pi-bg" is what isBgCallbackBody classifies),
#    plus ONE embed (title/color/description/fields/footer, no
#    timestamp). The in-flight note lines ride the embed's `in-flight`
#    field as RAW LINES, verbatim (no frame, no width budget - they are
#    the actionable part).
# Portable across agent boxes: channel id + bot token come from the LOCAL
# ~/.pi/agent/settings.json default channel; all paths are $HOME-relative.
# Canonical home: dispatch/pi-postcheck.sh (install.sh links it into
# ~/scripts; pi-restart invokes $HOME/scripts/pi-postcheck.sh).
set -u
# Shared contracts (issue #262 DRY): the webhook resolver ($PI_DISPATCH_WEBHOOK
# else head -1 of the webhook file) and the settings channel selection
# (bridge parity, jrate_common.default_channel) - dispatch/lib.sh.
source "$(dirname "$(readlink -f "$0")")/lib.sh"
F='```'
SETTINGS="$HOME/.pi/agent/settings.json"
HOOK="$(jrate_webhook)"
INFLIGHT=$(cat "$HOME/.config/pi-inflight.md" 2>/dev/null || true)
MSG=''
TAG='[ok]'
CH_ID=''
TOKEN=''
if [ ! -f "$SETTINGS" ]; then
  MSG='`[!] pi-postcheck: settings.json missing`'
  TAG='[!]'
else
  read -r CH_ID TOKEN < <(python3 - "$SETTINGS" <<'PY' 2>/dev/null
import json, os, sys
sys.path.insert(0, os.environ["JRATE_LIB_DIR"])
from jrate_common import default_channel
d = json.load(open(sys.argv[1]))
c = default_channel(d.get("channels", []))
print(c.get("channel", ""), c.get("botToken", ""))
PY
)
  if [ -z "$TOKEN" ]; then
    MSG='`[!] pi-postcheck: no bot token in settings.json`'
    TAG='[!]'
  elif ! systemctl --user is-active -q pi.service; then
    MSG='`[!] pi.service not active after restart`'
    TAG='[!]'
  else
    # Only systemd's own lines are real service errors. pi's stdout
    # (bash[...]) is an event JSON stream full of "error" field names -
    # grepping it gives false alarms (2026-09-15: two [!] posts quoting
    # pi's own JSON). The XDG_RUNTIME_DIR prefix must be LITERAL: an
    # assignment prefix from variable expansion ($JL) is executed as a
    # command by bash, so the pipeline read nothing (polish sweep C1 -
    # the systemd-error branch was dead code).
    ERRS=$(XDG_RUNTIME_DIR="/run/user/$(id -u)" journalctl --user -u pi.service --since -3min --no-pager 2>/dev/null | grep -a "systemd\[" | grep -aiE "error|failed|crash|exception|fatal" | grep -aiv "0 failed" | head -1 | cut -c1-160)
    if [ -n "$ERRS" ]; then
      MSG=$(printf '%s\n%s\n%s\n%s' '`[!] pi restarted, systemd error:`' "$F" "$ERRS" "$F")
      TAG='[!]'
    else
      MSG='`[ok] pi post-check: service healthy 90s after restart`'
    fi
  fi
fi
# 1) visible status line
if [ -n "$CH_ID" ] && [ -n "${TOKEN:-}" ]; then
  curl -s -m 10 -X POST "https://discord.com/api/v10/channels/$CH_ID/messages" \
    -H "Authorization: Bot $TOKEN" -H "Content-Type: application/json" \
    -d "$(python3 -c "import json,sys;print(json.dumps({'content': sys.argv[1]}))" "$MSG")" > /dev/null
fi
# 2) heartbeat through the webhook bus (wakes the agent)
if [ -n "$HOOK" ]; then
  # C1 (polish sweep): state-aware wording. The failure path used to read
  # "[!] healthy 90s after restart" - a lie. The channel message above
  # carries the detail; the heartbeat carries only the state - on the
  # embed author/title (2026-10-21 de-prefix: the [bg: content line is
  # gone, content is EMPTY, marker rides the Author: pi-bg author).
  # 2026-10-19 (Andryo): EMBED CARD family (the same visual as the pi-bg
  # completion posts) - ONE embed (title/color/description/fields/footer,
  # no timestamp). The in-flight note lines ship as the `in-flight` field
  # (raw lines, verbatim - no frame, no width budget; blank lines
  # dropped). No python3 -> empty body (degraded, same as before: the
  # channel post still lands). Embed colors come from jrate_common
  # (issue #262 DRY).
  BODY=$(python3 - "$TAG" "$INFLIGHT" <<'PY' 2>/dev/null
import json, os, sys
sys.path.insert(0, os.environ["JRATE_LIB_DIR"])
from jrate_common import GREEN_OK, RED_FAIL
tag, inflight = sys.argv[1:3]
if tag == "[ok]":
    author, title, color, desc = (
        "pi-bg pi-restart \u00b7 ok", "postcheck \u00b7 ok", GREEN_OK,
        "pi.service restart health check (90s after restart).")
else:
    author, title, color, desc = (
        "pi-bg pi-restart \u00b7 fail", "postcheck \u00b7 fail", RED_FAIL,
        "pi.service restart health check FAILED (90s after restart) - the channel post carries the detail.")
embed = {
    "author": {"name": author},
    "title": title, "color": color, "description": desc,
    "footer": {"text": "pi-postcheck"},
}
lines = [l for l in inflight.splitlines() if l.strip()]
if lines:
    val, kept = "\n".join(lines), []
    if len(val) > 1000:  # Discord field-value limit is 1024: an over-long
        # field 400s the WHOLE wake post (review MEDIUM 2026-10-19)
        total = 0
        for l in lines:
            if total + len(l) + 1 > 985:
                break
            kept.append(l)
            total += len(l) + 1
        val = "\n".join(kept) + f"\u2026 +{len(lines) - len(kept)} lines - see /jobs"
    embed["fields"] = [{"name": "in-flight", "value": val}]
print(json.dumps({"content": "", "embeds": [embed]}))
PY
  )
  curl -s -m 10 -X POST "$HOOK" -H "Content-Type: application/json" \
    -d "${BODY}" > /dev/null
fi
