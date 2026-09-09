# jarate

Monorepo for the pi + piscord agent stack. One repo, one installer, every agent box in sync.

## Layout

```
jarate/
  piscord/     piscord plugin (pi <-> Discord bridge) @ marzukia/piscord main HEAD
  dispatch/    pi-bg, pi-wait (cgroup-escape pi-bg), ORCHESTRATION.md
  bin/         agent-say (agent-to-agent Discord messaging)
  install.sh   idempotent installer, --dry-run supported
```

## Install

```
./install.sh              # sync everything for the calling user
./install.sh --dry-run    # show what would change
./install.sh --piscord-dir /home/frank/git/piscord   # frank: his bridge is a git checkout
```

What it does:

- rsync `piscord/` -> `~/.pi/agent/piscord` (`--delete`, preserves `.git` and `node_modules` at the destination), then `bun install` only if `package.json` changed
- copy `dispatch/pi-bg` + `dispatch/pi-wait` -> `~/scripts/`
- copy `bin/agent-say` -> `~/bin/agent-say`
- print summary + a `pi.service` restart reminder

What it never does:

- touch `~/.pi/agent/settings.json` (it lives outside the sync dir)
- restart or kill any pi process
- modify `marzukia/piscord` (upstream stays untouched)

## Verify piscord

```
cd piscord && bun install
bun x tsc --noEmit
bun x bun test    # 164 pass
```

## frank cross-user run

frank's bridge is a git checkout at `/home/frank/git/piscord`; keep its `.git`, and do NOT restart his pi.service:

```
sshpass -p 'REDACTED' ssh andryo@127.0.0.1 \
  "echo 'REDACTED' | sudo -S -u frank XDG_RUNTIME_DIR=/run/user/1002 \
   bash -c 'cd /path/to/jarate && ./install.sh --piscord-dir /home/frank/git/piscord'"
```
