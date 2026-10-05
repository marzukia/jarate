// issue #128: test sockets must not clobber the live bridge sockets.
//
// The vault + pat daemons bind $XDG_RUNTIME_DIR/jarate/{vault,pat}.sock
// and bindSocket() unlinks a pre-existing entry before listen. Run under
// a real login XDG, the suite unlinks the socket file entries the live
// pi process holds and owns the live path for the duration of the run —
// every jarate CLI dispatch on that path hits the test's server.
//
// The bunfig.toml preload (test/xdg-isolation.ts) redirects
// XDG_RUNTIME_DIR to a per-run tmpdir before any bridge module loads.
// These tests prove the redirect is active and that a socket-creating
// start via the env fallback (the path index.ts uses at bridge startup)
// leaves the live entries byte-identical (inode + mtime).
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  __patVaultResetForTest,
  startPatVault,
  stopPatVault,
} from "./pat-vault";
import { __vaultResetForTest, startVault, stopVault } from "./vault";

// Live directory: the preload records it; if the preload is missing the
// fallback is the bridge's own (vault.ts: xdg default), so the test still
// knows where the live entries would be.
const LIVE_XDG =
  process.env.JARETE_TEST_LIVE_XDG ??
  process.env.XDG_RUNTIME_DIR ??
  path.join("/run/user", String(process.getuid?.() ?? 0));

interface EntryState {
  exists: boolean;
  dev: number;
  ino: number;
  mtimeMs: number;
}

function snapshotEntry(p: string): EntryState {
  try {
    const st = fs.lstatSync(p);
    return { exists: true, dev: st.dev, ino: st.ino, mtimeMs: st.mtimeMs };
  } catch {
    return { exists: false, dev: 0, ino: 0, mtimeMs: 0 };
  }
}

function expectUnchanged(label: string, before: EntryState): void {
  const after = snapshotEntry(label);
  if (!before.exists) {
    expect(after.exists, `${label} appeared in the live XDG`).toBe(false);
    return;
  }
  expect(after.exists, `${label} disappeared from the live XDG`).toBe(true);
  expect(after.dev, `${label} dev changed`).toBe(before.dev);
  expect(after.ino, `${label} inode changed`).toBe(before.ino);
  expect(after.mtimeMs, `${label} mtime changed`).toBe(before.mtimeMs);
}

describe("issue #128: test sockets stay out of the live XDG_RUNTIME_DIR", () => {
  test("preload isolates the test XDG from the live one", () => {
    expect(
      process.env.JARETE_TEST_LIVE_XDG,
      "JARETE_TEST_LIVE_XDG unset: the bunfig.toml preload did not run",
    ).toBeDefined();
    expect(
      process.env.XDG_RUNTIME_DIR,
      "XDG_RUNTIME_DIR still points at the live dir",
    ).not.toBe(LIVE_XDG);
  });

  test("socket-creating start leaves live vault.sock/pat.sock unchanged", async () => {
    const liveVault = path.join(LIVE_XDG, "jarate", "vault.sock");
    const livePat = path.join(LIVE_XDG, "jarate", "pat.sock");
    const beforeVault = snapshotEntry(liveVault);
    const beforePat = snapshotEntry(livePat);
    const liveDir = path.join(LIVE_XDG, "jarate");
    const dirBefore = fs.existsSync(liveDir)
      ? fs.readdirSync(liveDir).sort()
      : null;

    // Hermetic data dirs: only the socket is under test here.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "issue128-"));
    for (const d of ["vstate", "pstate", "pats"]) {
      fs.mkdirSync(path.join(tmp, d), { recursive: true });
    }
    const ch = {
      id: "ch128",
      name: "ch128",
      type: "discord",
      channel: "999",
      botToken: "tok-128",
      ownerUserId: "u1",
      ownerUserIds: ["u1"],
    } as any;

    // No xdgDir/socketDir override: the env fallback, i.e. exactly what
    // index.ts does at bridge startup.
    const vh = startVault({
      ch,
      botToken: ch.botToken,
      stateDir: path.join(tmp, "vstate"),
      vaultDir: path.join(tmp, "vstate", "vault"),
      knownDir: path.join(tmp, "vstate", "vault", "known"),
      secretsDir: path.join(tmp, "vstate", "vault", "secrets"),
      stateFile: path.join(tmp, "vstate", "state.json"),
      auditFile: path.join(tmp, "vstate", "audit.log"),
    });
    const ph = startPatVault({
      ch,
      botToken: ch.botToken,
      stateDir: path.join(tmp, "pstate"),
      patsDir: path.join(tmp, "pats"),
      defaultPatFile: path.join(tmp, "marzukia-pat"),
      auditFile: path.join(tmp, "pstate", "audit.log"),
    });
    await vh.ready;
    await ph.ready;

    try {
      const testXdg = process.env.XDG_RUNTIME_DIR ?? LIVE_XDG;
      // The test's sockets bind under the isolated XDG...
      expect(vh.vault.socketPath).toBe(
        path.join(testXdg, "jarate", "vault.sock"),
      );
      expect(ph.vault.socketPath).toBe(
        path.join(testXdg, "jarate", "pat.sock"),
      );
      expect(
        fs.existsSync(vh.vault.socketPath),
        "test vault socket was not created",
      ).toBe(true);
      expect(
        fs.existsSync(ph.vault.socketPath),
        "test pat socket was not created",
      ).toBe(true);
      // ...and the live entries are untouched (inode + mtime).
      expectUnchanged(liveVault, beforeVault);
      expectUnchanged(livePat, beforePat);
      if (dirBefore !== null) {
        expect(fs.readdirSync(liveDir).sort()).toEqual(dirBefore);
      }
    } finally {
      stopVault(vh);
      stopPatVault(ph);
      __vaultResetForTest();
      __patVaultResetForTest();
      fs.rmSync(tmp, { recursive: true, force: true });
    }

    // Stop must not leave (or remove) live entries either.
    expectUnchanged(liveVault, beforeVault);
    expectUnchanged(livePat, beforePat);
  });
});
