/**
 * bun test preload — isolate test sockets from the live bridge (issue #128).
 *
 * The vault + pat daemons bind $XDG_RUNTIME_DIR/jarate/{vault,pat}.sock and
 * bindSocket() unlinks a pre-existing entry before listen. Running the
 * suite under a real login XDG (developer shell, deploy.sh) therefore
 * clobbers the socket file entries the live pi process holds, and every
 * jarate CLI dispatch on the live path hits the test's server for the
 * duration of the run.
 *
 * This preload redirects XDG_RUNTIME_DIR to a per-run tmpdir BEFORE any
 * bridge module loads (wired via [test] preload in bunfig.toml), so all
 * test socket creation lands in the tmp dir. The live directory is
 * preserved in JARETE_TEST_LIVE_XDG for regression assertions
 * (channel/socket-isolation.test.ts).
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
