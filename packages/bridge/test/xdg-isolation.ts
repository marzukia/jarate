/**
 * bun test preload — isolate test env from the live bridge (issue #128).
 *
 * Redirects XDG_RUNTIME_DIR to a per-run tmpdir BEFORE any bridge module
 * loads (wired via [test] preload in bunfig.toml), so anything test code
 * drops under the user-slice XDG (sockets, state files) never clobbers
 * what the live pi process holds when the suite runs under a real login
 * XDG (developer shell, deploy.sh). No active test asserts this anymore
 * (the socket-isolation regression test went with the vault/pat daemons);
 * the preload stays as cheap insurance for future socket use. The live
 * directory is preserved in JARETE_TEST_LIVE_XDG.
 *
 * Cleanup: `process.on("exit")` NEVER fires under `bun test` (verified
 * 2026-10-06, bun 1.4.0 — it does fire for `bun script.ts`), so the
 * per-run tmp dir is actually reclaimed by the stale sweep below: every
 * preload start removes prior-run dirs older than 1h (concurrent live
 * runs protected by the age bound). systemd tmpfiles on /tmp is the
 * backstop. The exit handler stays for non-test invocations.
 */
import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

if (!process.env.JARETE_TEST_LIVE_XDG) {
  const t = tmpdir();
  try {
    const now = Date.now();
    for (const name of readdirSync(t)) {
      if (!name.startsWith("jarate-test-xdg-")) continue;
      const p = join(t, name);
      try {
        if (now - statSync(p).mtimeMs > 3_600_000) {
          rmSync(p, { recursive: true, force: true });
        }
      } catch {
        // raced or unreadable: skip
      }
    }
  } catch {
    // tmpdir unreadable: sweep is best-effort
  }
  const live =
    process.env.XDG_RUNTIME_DIR ??
    join("/run/user", String(process.getuid?.() ?? 0));
  const isolated = mkdtempSync(join(tmpdir(), "jarate-test-xdg-"));
  process.env.JARETE_TEST_LIVE_XDG = live;
  process.env.XDG_RUNTIME_DIR = isolated;
  console.error(
    `[test] XDG isolated for this run: live=${live} tmp=${isolated}`,
  );
  process.on("exit", () => {
    try {
      rmSync(isolated, { recursive: true, force: true });
    } catch {
      // inert under bun test (see header); sweep + tmpfiles reclaim it
    }
  });
}
