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
 * (channel/socket-isolation.test.ts). The tmp dir is removed on exit.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

if (!process.env.JARETE_TEST_LIVE_XDG) {
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
      // best effort: tmp reaps the rest
    }
  });
}
