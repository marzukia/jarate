/**
 * dispatch/pi-restart — sanctioned pi.service restart (issue #260).
 *
 * Runs the real bash script against a fake HOME with stubbed
 * systemd-run / systemctl. The script:
 * - saves the in-flight note to ~/.config/pi-inflight.md (600) or
 *   removes it when no note is given
 * - schedules the postcheck one-shot via `systemd-run --user
 *   --on-active=<delay>s` targeting $HOME/scripts/pi-postcheck.sh
 * - restarts pi.service detached in a background subshell (the test
 *   sees the systemctl stub call once the subshell releases the
 *   output pipes)
 * - a failed timer schedule prints the [!] line but the restart still
 *   goes out
 */
import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "bun";

const RESTART = path.join(import.meta.dir, "pi-restart");

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

interface Fixture {
  tmp: string;
  home: string;
  env: Record<string, string>;
  setSystemdRunRc: (rc: number) => void;
  run: (args: string[]) => Promise<{ code: number; out: string; err: string }>;
  calls: () => string[];
}

function fixture(): Fixture {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pirestart-"));
  tmpDirs.push(tmp);
  const home = path.join(tmp, "home");
  const bin = path.join(tmp, "bin");
  const callsPath = path.join(tmp, "stub-calls.txt");
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(bin, { recursive: true });
  fs.mkdirSync(path.join(home, ".config"), { recursive: true });

  // stub systemd-run: logs argv; rc from the env knob (default 0)
  fs.writeFileSync(
    path.join(bin, "systemd-run"),
    '#!/bin/sh\necho "systemd-run $*" >> "$STUB_CALLS"\nif [ -n "$STUB_SYSTEMD_RUN_RC" ]; then exit "$STUB_SYSTEMD_RUN_RC"; fi\nexit 0\n',
  );
  // stub systemctl: logs argv
  fs.writeFileSync(
    path.join(bin, "systemctl"),
    '#!/bin/sh\necho "systemctl $*" >> "$STUB_CALLS"\n',
  );
  for (const f of ["systemd-run", "systemctl"]) {
    fs.chmodSync(path.join(bin, f), 0o755);
  }

  const env = { ...process.env } as Record<string, string>;
  env.HOME = home;
  env.PATH = `${bin}:${env.PATH ?? ""}`;
  env.STUB_CALLS = callsPath;
  env.STUB_SYSTEMD_RUN_RC = "0";
  return {
    tmp,
    home,
    env,
    setSystemdRunRc: (rc: number) => {
      env.STUB_SYSTEMD_RUN_RC = String(rc);
    },
    run: async (args: string[]) => {
      // The restart subshell (sleep 5; systemctl ...) inherits the
      // output pipes, so the read holds until it exits (~5s) — by the
      // time this resolves, the calls log is complete.
      const p = spawn(["bash", RESTART, ...args], {
        env,
        cwd: tmp,
        stdout: "pipe",
        stderr: "pipe",
      });
      const [out, err] = await Promise.all([
        new Response(p.stdout).text(),
        new Response(p.stderr).text(),
      ]);
      const code = await p.exited;
      return { code, out, err };
    },
    calls: () =>
      fs.existsSync(callsPath)
        ? fs.readFileSync(callsPath, "utf8").trim().split("\n").filter(Boolean)
        : [],
  };
}

describe("pi-restart (issue #260)", () => {
  test("note saved (600) + postcheck one-shot scheduled + restart out", async () => {
    const f = fixture();
    const r = await f.run(["90", "the note text"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("postcheck at +90s (pi-postcheck-");
    expect(r.out).toContain("restart in 5s");

    const inflight = path.join(f.home, ".config", "pi-inflight.md");
    expect(fs.readFileSync(inflight, "utf8")).toBe("the note text\n");
    expect(fs.statSync(inflight).mode & 0o777).toBe(0o600);

    const sd = f.calls().find((c) => c.startsWith("systemd-run "));
    expect(sd).toBeDefined();
    expect(sd).toMatch(
      new RegExp(
        `^systemd-run --user --on-active=90s --unit=pi-postcheck-\\d+ ${f.home.replace(
          /[.*+?^${}()|[\]\\]/g,
          "\\$&",
        )}/scripts/pi-postcheck\\.sh$`,
      ),
    );

    expect(f.calls()).toContain("systemctl --user restart pi.service");
  }, 15000); // the script's own `sleep 5` eats most of the default 5s timeout

  test("no note -> inflight marker removed, default 90s delay", async () => {
    const f = fixture();
    const inflight = path.join(f.home, ".config", "pi-inflight.md");
    fs.writeFileSync(inflight, "stale note\n");
    const r = await f.run([]);
    expect(r.code).toBe(0);
    expect(fs.existsSync(inflight)).toBe(false);
    const sd = f.calls().find((c) => c.startsWith("systemd-run "));
    expect(sd).toContain("--on-active=90s");
    expect(f.calls()).toContain("systemctl --user restart pi.service");
  }, 15000);

  test("timer schedule failure -> [!] line, restart still goes out", async () => {
    const f = fixture();
    f.setSystemdRunRc(1);
    const r = await f.run(["30", "x"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain(
      "pi-restart: [!] postcheck timer FAILED to schedule",
    );
    expect(f.calls()).toContain("systemctl --user restart pi.service");
  }, 15000);
});
