# pi-bg /tmp temp-file leak (inode exhaustion, 2026-09-14)

## Incident
/tmp (32G tmpfs, 1M inode cap) hit **100% inodes** on 2026-09-14. Every
`mkdtemp` in /tmp returned ENOSPC. Symptoms:
- jarate test suite: 382/670 fails on main (all tmp-dir based tests), 421/717 in worktrees
- any bun/node/python temp use fleet-wide

## Perpetrators (top-level /tmp entries, pre-cleanup)
```
23,856  pibg-test*    <- dispatch/pi-bg.test.ts temp dirs, never removed
 8,216  pibg-wd-*     <- watchdog temp dirs
 4,894  pibg-tail*    <- tail temp dirs
 1,577  recall-p* / recall-e* each
 42,782 total top-level entries (vs ~40 normal)
```

## Fix applied (ops, 2026-09-14)
- purged pibg-*/recall-*/agent-say*/jarate-t*/loadrepo*/dispatch* older than 6h (29,306 entries)
- purged weasyprint-*/check-dist-*/nf-saved-motion-*/playwright*/tmpXXXX older than 1h
- /etc/tmpfiles.d/agent-tmp.conf: `e /tmp 1777 root root 2d` (daily age-reap)
- inodes: 1,048,576 used -> 233,803 (23%)

## TODO (code)
- pi-bg.test.ts (and wd/tail tests): remove temp dirs in afterEach
- pi-bg/pi-wait/watchdog runtime: unlink own /tmp files on exit (trap EXIT)
- consider TMPDIR=<repo>/.tmp for test temp (off the shared tmpfs)

## Detection
`df -i /tmp` — alert at >80%. Suggested: jarate ctx-report or watchdog
adds inode usage; tripwire at 90%.
