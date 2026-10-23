/**
 * dispatch/pi-* shims (jarate #151): the old name stays resolvable as an
 * executable deprecation shim. Contract per shim:
 *   - exactly one stderr line: "<old>: deprecated, use <new> (jarate #151)"
 *   - stdout byte-identical to the new script for the same args
 *   - exit code passthrough
 * The shims exec the sibling jarate-* resolved via readlink -f, so they
 * must keep working from any link path (install.sh links them into
 * ~/.local/bin and ~/scripts).
 *
 * The pi-bg* shims were retired 2026-10-23 (operator order: "pi-bg should
 * be gone" - the dispatch path was gutted in #272); only pi-wait remains.
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
  ["pi-wait", "jarate-wait", ["--help"]],
];
// rc-passthrough probes (no args): the completion-side shim exits 2 (usage).
const RC: [string, string[], number][] = [["pi-wait", [], 2]];

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

  for (const [shim, args, wantRc] of RC) {
    test(`${shim}: exit code passthrough (rc ${wantRc})`, async () => {
      const r = Bun.spawn([join(D, shim), ...args], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const [, rc] = await Promise.all([
        new Response(r.stdout).text(),
        r.exited,
      ]);
      expect(rc).toBe(wantRc);
    });
  }

  test("shim resolves the real script through a symlink (install.sh form)", async () => {
    const tmp = `/tmp/jarate-shim-link-${Date.now()}`;
    mkdirSync(join(tmp, "bin"), { recursive: true });
    try {
      // mimic install.sh: link into a bin dir, exec from there
      for (const [shim, real] of PAIRS) {
        symlinkSync(join(D, shim), join(tmp, "bin", shim));
        symlinkSync(join(D, real), join(tmp, "bin", real));
      }
      const r = Bun.spawn([join(tmp, "bin", "pi-wait"), "--help"], {
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
      expect(out.split("\n")[0]).toContain("jarate-wait");
      expect(err.trim()).toBe(
        "pi-wait: deprecated, use jarate-wait (jarate #151)",
      );
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("shim does not shadow the real script when both names are linked", async () => {
    // the shim execs the SIBLING jarate-wait in the same dir; even if the
    // caller's PATH prefers the shim, one exec hop lands on the real body
    const tmp = `/tmp/jarate-shim-sib-${Date.now()}`;
    mkdirSync(tmp, { recursive: true });
    try {
      cpSync(join(D, "pi-wait"), join(tmp, "pi-wait"));
      cpSync(join(D, "jarate-wait"), join(tmp, "jarate-wait"));
      chmodSync(join(tmp, "pi-wait"), 0o755);
      chmodSync(join(tmp, "jarate-wait"), 0o755);
      const r = Bun.spawn([join(tmp, "pi-wait"), "--help"], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const [out, rc] = await Promise.all([
        new Response(r.stdout).text(),
        r.exited,
      ]);
      expect(rc).toBe(0);
      expect(out.split("\n")[0]).toContain("jarate-wait");
      expect(existsSync(join(tmp, "jarate-wait"))).toBe(true);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
