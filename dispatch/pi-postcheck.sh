#!/usr/bin/env bash
# pi-postcheck: runs ~90s after a pi.service restart (systemd-run --on-active).
# 1) posts a visible status line to THIS agent's default channel (bot API,
#    code-formatted per STYLE.md 4.4)
# 2) posts a heartbeat to the pi-dispatch Discord WEBHOOK, content tagged
#    "[bg: pi-restart]" (isBgWebhook exemption in the bridge - without the
#    tag the other-bot filter swallows it). The webhook post is polled back
#    as a turn and wakes the agent. Shape (2026-10-19, Andryo): the same
#    EMBED CARD family as the other [bg: producers - content is ONE line
#    (`[bg: pi-restart] <status>` - the wake marker on line 1), plus ONE
#    embed (title/color/description/fields/footer, no timestamp). The
#    in-flight note lines ride the embed's `in-flight` field as RAW LINES,
#    verbatim (no frame, no width budget - they are the actionable part).
# Portable across agent boxes: channel id + bot token come from the LOCAL
# ~/.pi/agent/settings.json default channel; all paths are $HOME-relative.
# Canonical home: dispatch/pi-postcheck.sh (install.sh links it into
# ~/scripts; pi-restart invokes $HOME/scripts/pi-postcheck.sh).
set -u
F='```'
SETTINGS="$HOME/.pi/agent/settings.json"
HOOK=$(cat "$HOME/.config/pi-dispatch/webhook" 2>/dev/null || true)
INFLIGHT=$(cat "$HOME/.config/pi-inflight.md" 2>/dev/null || true)
MSG=''
TAG='[ok]'
CH_ID=''
TOKEN=''
if [ ! -f "$SETTINGS" ]; then
  MSG='`[!] pi-postcheck: settings.json missing`'
  TAG='[!]'
else
  read -r CH_ID TOKEN < <(python3 -c "
import json
d = json.load(open('$SETTINGS'))
chs = [c for c in d.get('channels', []) if c.get('enabled')]
c = next((x for x in chs if x.get('default')), chs[0] if chs else {})
print(c.get('channel', ''), c.get('botToken', ''))
" 2>/dev/null)
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
  # carries the detail; the heartbeat line carries only the state.
  # 2026-10-19 (Andryo): EMBED CARD family (the same visual as the pi-bg
  # completion posts) - ONE content line (the wake marker) + ONE embed
  # (title/color/description/fields/footer, no timestamp). The in-flight
  # note lines ship as the `in-flight` field (raw lines, verbatim - no
  # frame, no width budget; blank lines dropped). No python3 -> empty
  # body (degraded, same as before: the channel post still lands).
  if [ "$TAG" = '[!]' ]; then
    STATUS=$(printf '%s not healthy 90s after restart' "$TAG")
  else
    STATUS=$(printf '%s healthy 90s after restart' "$TAG")
  fi
  BODY=$(python3 - "$TAG" "$STATUS" "$INFLIGHT" <<'PY' 2>/dev/null
import json, sys
tag, status, inflight = sys.argv[1:4]
if tag == "[ok]":
    title, color, desc = (
        "postcheck \u00b7 ok", 0x57F287,
        "pi.service restart health check (90s after restart).")
else:
    title, color, desc = (
        "postcheck \u00b7 fail", 0xED4245,
        "pi.service restart health check FAILED (90s after restart) - the channel post carries the detail.")
embed = {
    "title": title, "color": color, "description": desc,
    "footer": {"text": "pi-postcheck"},
}
lines = [l for l in inflight.splitlines() if l.strip()]
if lines:
    embed["fields"] = [{"name": "in-flight", "value": "\n".join(lines)}]
print(json.dumps({"content": "[bg: pi-restart] " + status, "embeds": [embed]}))
PY
  )
  curl -s -m 10 -X POST "$HOOK" -H "Content-Type: application/json" \
    -d "${BODY}" > /dev/null
fi
