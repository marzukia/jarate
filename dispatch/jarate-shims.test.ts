/**
 * dispatch/pi-* shims (jarate #151): the old names stay resolvable as
 * executable deprecation shims. Contract per shim:
 *   - exactly one stderr line: "<old>: deprecated, use <new> (jarate #151)"
 *   - stdout byte-identical to the new script for the same args
 *   - exit code passthrough
 * The shims exec the sibling jarate-* resolved via readlink -f, so they
 * must keep working from any link path (install.sh links them into
 * ~/.local/bin and ~/scripts).
 */
import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  rmSync,
  statSync,
  symlinkSync,
} from "node:fs";
import { join } from "node:path";

const D = import.meta.dir;
// [shim, real, args for the stdout-identity check]
const PAIRS: [string, string, string[]][] = [
  ["pi-bg", "jarate-bg", ["--help"]],
  ["pi-wait", "jarate-wait", ["--help"]],
  ["pi-bg-kill", "jarate-bg-kill", ["--help"]],
  ["pi-bg-tail", "jarate-bg-tail", ["--help"]],
  ["pi-bg-watchdog", "jarate-bg-watchdog", ["--help"]],
];
// rc-passthrough probes (no args unless noted): all must exit 2
const RC2: [string, string[]][] = [
  ["pi-bg", []],
  ["pi-wait", []],
  ["pi-bg-kill", []],
  ["pi-bg-tail", []],
];

describe("pi-* shims (jarate #151): deprecation line + passthrough", () => {
  for (const [shim, real, args] of PAIRS) {
    test(`${shim}: executable, forwards to ${real}, identical stdout`, async () => {
      const p = join(D, shim);
      const st = statSync(p);
      expect(st.mode & 0o111).toBe(0o111); // +x for someone

      const rOld = Bun.spawn([p, ...args], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const [outOld, errOld, rcOld] = await Promise.all([
        new Response(rOld.stdout).text(),
        new Response(rOld.stderr).text(),
        rOld.exited,
      ]);
      expect(rcOld).toBe(0);

      const rNew = Bun.spawn([join(D, real), ...args], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const [outNew, , rcNew] = await Promise.all([
        new Response(rNew.stdout).text(),
        new Response(rNew.stderr).text(),
        rNew.exited,
      ]);
      expect(rcNew).toBe(0);

      // stdout byte-identical to the real script
      expect(outOld).toBe(outNew);
      // exactly one stderr line, the deprecation notice
      const errLines = errOld.trim().split("\n");
      expect(errLines).toHaveLength(1);
      expect(errLines[0]).toBe(
        `${shim}: deprecated, use ${real} (jarate #151)`,
      );
      // the help body advertises the NEW name
      expect(outOld.split("\n")[0]).toContain(real);
    });
  }

  for (const [shim, args] of RC2) {
    test(`${shim}: exit code passthrough (rc 2 usage error)`, async () => {
      const r = Bun.spawn([join(D, shim), ...args], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const rc = await r.exited;
      expect(rc).toBe(2);
    });
  }

  test("pi-bg-watchdog: rc 0 with --dry-run --quiet (sweep is the pass-through)", async () => {
    const tmp = `/tmp/jarate-shim-wd-${Date.now()}`;
    mkdirSync(join(tmp, "art"), { recursive: true });
    try {
      const r = Bun.spawn([join(D, "pi-bg-watchdog"), "--dry-run", "--quiet"], {
        stdout: "pipe",
        stderr: "pipe",
        env: {
          HOME: tmp,
          PI_BG_TMPDIR: join(tmp, "art"),
          PI_BG_CG_ROOT: join(tmp, "cg"),
          PI_BG_WT_DIR: join(tmp, "wt"),
          // the OOM section (issue #191 M1) reads $PI_BG_OOM_ROOT for
          // the in-scope slices: keep it on the fake (slice-less) root or
          // the first-sight line lands on stdout and the one-line
          // contract below breaks (failing control for this env)
          PI_BG_OOM_ROOT: join(tmp, "oom"),
          PATH: process.env.PATH ?? "",
        },
      });
      const [out, err, rc] = await Promise.all([
        new Response(r.stdout).text(),
        new Response(r.stderr).text(),
        r.exited,
      ]);
      expect(rc).toBe(0);
      expect(err).toBe(
        "pi-bg-watchdog: deprecated, use jarate-bg-watchdog (jarate #151)\n",
      );
      // quiet + dry-run: no posts, just the one-line sweep summary on stdout
      const outLines = out.trim().split("\n");
      expect(outLines).toHaveLength(1);
      expect(outLines[0]).toContain("[pi-bg-watchdog] sweep done");
      expect(outLines[0]).toContain("quiet=1 dry=1");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("shim resolves the real script through a symlink (install.sh form)", async () => {
    const tmp = `/tmp/jarate-shim-link-${Date.now()}`;
    mkdirSync(join(tmp, "bin"), { recursive: true });
    try {
      // mimic install.sh: link into a bin dir, exec from there
      for (const [shim, real] of PAIRS) {
        symlinkSync(join(D, shim), join(tmp, "bin", shim));
        symlinkSync(join(D, real), join(tmp, "bin", real));
      }
      const r = Bun.spawn([join(tmp, "bin", "pi-bg"), "--help"], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const [out, err, rc] = await Promise.all([
        new Response(r.stdout).text(),
        new Response(r.stderr).text(),
        r.exited,
      ]);
      expect(rc).toBe(0);
      expect(out.length).toBeGreaterThan(0);
      expect(out.split("\n")[0]).toContain("jarate-bg");
      expect(err.trim()).toBe("pi-bg: deprecated, use jarate-bg (jarate #151)");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("shim does not shadow the real script when both names are linked", async () => {
    // the shim execs the SIBLING jarate-bg in the same dir; even if the
    // caller's PATH prefers the shim, one exec hop lands on the real body
    const tmp = `/tmp/jarate-shim-sib-${Date.now()}`;
    mkdirSync(tmp, { recursive: true });
    try {
      cpSync(join(D, "pi-bg"), join(tmp, "pi-bg"));
      cpSync(join(D, "jarate-bg"), join(tmp, "jarate-bg"));
      chmodSync(join(tmp, "pi-bg"), 0o755);
      chmodSync(join(tmp, "jarate-bg"), 0o755);
      const r = Bun.spawn([join(tmp, "pi-bg"), "--help"], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const [out, rc] = await Promise.all([
        new Response(r.stdout).text(),
        r.exited,
      ]);
      expect(rc).toBe(0);
      expect(out.split("\n")[0]).toContain("jarate-bg");
      expect(existsSync(join(tmp, "jarate-bg"))).toBe(true);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
