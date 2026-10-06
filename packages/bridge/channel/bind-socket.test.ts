// issue #128 (fix 2 + test 3): bindSocket probes before it unlinks.
//
// Incident (2026-10-01): a second startVault on a path owned by the live
// pi process unlinked the live socket file entry. The server inode kept
// LISTENing but became unreachable by path, and every jarate vault-*/pat-*
// CLI dispatch failed with "no socket" until the next pi restart.
//
// bindSocket now connect-probes any pre-existing entry:
//   probe connected (live peer) -> NO unlink. The listen fails EADDRINUSE
//   and surfaces a clear "owned by a live server" audit error (the vault
//   keeps working request-only).
//   probe failed (ECONNREFUSED / ENOENT / EACCES / timeout) -> crash
//   leftover: unlink + listen, as before.
//
// Socket dirs come from the JARATE_VAULT_SOCKET_DIR / JARATE_PAT_DIR env
// hooks (fix 1) + temp dirs, so this test never touches the live runtime
// dir.
import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import {
  __patDetachForTest,
  __patVaultResetForTest,
  startPatVault,
  stopPatVault,
} from "./pat-vault";
import {
  __vaultDetachForTest,
  __vaultResetForTest,
  startVault,
  stopVault,
} from "./vault";

const savedEnv: Record<string, string | undefined> = {};

function setEnv(k: string, v: string): void {
  if (!(k in savedEnv)) savedEnv[k] = process.env[k];
  process.env[k] = v;
}

function restoreEnv(): void {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  for (const k of Object.keys(savedEnv)) delete savedEnv[k];
}

afterEach(() => {
  restoreEnv();
});

const CH = {
  id: "ch128b",
  name: "ch128b",
  type: "discord",
  channel: "999",
  botToken: "tok-128b",
  ownerUserId: "u1",
  ownerUserIds: ["u1"],
} as any;

/** Minimal line-protocol client against a vault/pat socket. */
class LineClient {
  private sock: net.Socket;
  private buf = "";
  private queued: string[] = [];

  constructor(p: string) {
    this.sock = net.connect(p);
    this.sock.on("data", (d: Buffer) => {
      this.buf += d.toString("utf-8");
      let idx = this.buf.indexOf("\n");
      while (idx >= 0) {
        this.queued.push(this.buf.slice(0, idx));
        this.buf = this.buf.slice(idx + 1);
        idx = this.buf.indexOf("\n");
      }
    });
  }

  connect(timeoutMs = 5000): Promise<void> {
    return new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error("connect timeout")), timeoutMs);
      this.sock.once("connect", () => {
        clearTimeout(t);
        res();
      });
      this.sock.once("error", (e) => {
        clearTimeout(t);
        rej(e);
      });
    });
  }

  send(obj: Record<string, unknown>): void {
    this.sock.write(`${JSON.stringify({ v: 1, ...obj })}\n`);
  }

  nextLine(timeoutMs = 5000): Promise<string> {
    const q = this.queued.shift();
    if (q !== undefined) return Promise.resolve(q);
    return new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error("nextLine timeout")), timeoutMs);
      const waiter = () => {
        const line = this.queued.shift();
        if (line !== undefined) {
          clearTimeout(t);
          this.sock.off("data", waiter);
          res(line);
        }
      };
      this.sock.on("data", waiter);
    });
  }

  close(): void {
    this.sock.destroy();
  }
}

async function roundtrip(
  p: string,
  obj: Record<string, unknown>,
): Promise<Record<string, any>> {
  const c = new LineClient(p);
  try {
    await c.connect();
    c.send(obj);
    return JSON.parse(await c.nextLine());
  } finally {
    c.close();
  }
}

/** Create a crash-leftover socket file at p: entry exists, no listener.
 *  A plain empty file — a process that dies mid-serve leaves its socket
 *  entry behind, and a connect to it fails (what the probe keys off).
 *  NB: not server.close() — bun unlinks the path on clean close. */
function makeStaleSocket(p: string): number {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, "");
  return fs.lstatSync(p).ino;
}

describe("issue #128 fix 2: bindSocket probes before unlink", () => {
  test("second startVault does not stomp a live vault.sock", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bind128-"));
    const socketDir = path.join(tmp, "sock");
    setEnv("JARATE_VAULT_SOCKET_DIR", socketDir);
    const opts = (s: string) => ({
      ch: CH,
      botToken: CH.botToken,
      stateDir: path.join(tmp, s, "state"),
      xdgDir: path.join(tmp, "xdg"),
      vaultDir: path.join(tmp, s, "vault"),
      knownDir: path.join(tmp, s, "vault", "known"),
      secretsDir: path.join(tmp, s, "vault", "secrets"),
      stateFile: path.join(tmp, s, "vault", "state.json"),
      auditFile: path.join(tmp, s, "audit.log"),
      fileDir: path.join(tmp, s, "files"),
      transport: "socket" as const,
    });

    const h1 = startVault(opts("a"));
    await h1.ready;
    const P = path.join(socketDir, "vault.sock");
    expect(h1.vault.server, "first vault must be listening").not.toBeNull();
    expect(fs.existsSync(P), "first socket entry missing").toBe(true);
    const inoBefore = fs.lstatSync(P).ino;
    const r1 = await roundtrip(P, { op: "vstatus", agent: "monky" });
    expect(r1.ok, "baseline roundtrip via live path").toBe(true);

    // Drop h1 from the module registry WITHOUT stopping its server, so
    // the second startVault performs a real bind on the same path.
    __vaultDetachForTest(P);
    const h2 = startVault(opts("b"));
    await h2.ready;

    try {
      // No stomp: the live file entry survived the failed second bind,
      // same inode...
      expect(fs.existsSync(P), "live socket entry was unlinked").toBe(true);
      expect(fs.lstatSync(P).ino, "socket entry was replaced").toBe(inoBefore);
      // ...and the ORIGINAL server still answers by path.
      const r2 = await roundtrip(P, { op: "vstatus", agent: "monky" });
      expect(r2.ok, "original server unreachable by path").toBe(true);
      // The second bind surfaced the live owner instead of EADDRINUSE.
      const auditB = fs.readFileSync(opts("b").auditFile, "utf-8");
      expect(auditB).toContain("owned by a live server (probe connected)");
      expect(auditB).toContain("not unlinking");
      expect(h2.vault.server, "second vault must be request-only").toBeNull();
    } finally {
      stopVault(h2);
      h1.vault.server?.close();
      __vaultResetForTest();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("second startPatVault does not stomp a live pat.sock", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bind128p-"));
    const socketDir = path.join(tmp, "sock");
    setEnv("JARATE_PAT_DIR", socketDir);
    const opts = (s: string) => ({
      ch: CH,
      botToken: CH.botToken,
      stateDir: path.join(tmp, s, "state"),
      xdgDir: path.join(tmp, "xdg"),
      fileDir: path.join(tmp, s, "files"),
      patsDir: path.join(tmp, s, "pats"),
      defaultPatFile: path.join(tmp, s, "marzukia-pat"),
      auditFile: path.join(tmp, s, "audit.log"),
      transport: "socket" as const,
    });

    const h1 = startPatVault(opts("a"));
    await h1.ready;
    const P = path.join(socketDir, "pat.sock");
    expect(h1.vault.server, "first pat vault must be listening").not.toBeNull();
    expect(fs.existsSync(P), "first socket entry missing").toBe(true);
    const inoBefore = fs.lstatSync(P).ino;
    const r1 = await roundtrip(P, { op: "status", agent: "monky" });
    expect(r1.ok, "baseline roundtrip via live path").toBe(true);

    __patDetachForTest(P);
    const h2 = startPatVault(opts("b"));
    await h2.ready;

    try {
      expect(fs.existsSync(P), "live socket entry was unlinked").toBe(true);
      expect(fs.lstatSync(P).ino, "socket entry was replaced").toBe(inoBefore);
      const r2 = await roundtrip(P, { op: "status", agent: "monky" });
      expect(r2.ok, "original server unreachable by path").toBe(true);
      const auditB = fs.readFileSync(opts("b").auditFile, "utf-8");
      expect(auditB).toContain("owned by a live server (probe connected)");
      expect(auditB).toContain("not unlinking");
      expect(
        h2.vault.server,
        "second pat vault must be request-only",
      ).toBeNull();
    } finally {
      stopPatVault(h2);
      h1.vault.server?.close();
      __patVaultResetForTest();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("vault crash leftover (file, no listener) is unlinked and rebound", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bind128c-"));
    const socketDir = path.join(tmp, "sock");
    setEnv("JARATE_VAULT_SOCKET_DIR", socketDir);
    const P = path.join(socketDir, "vault.sock");
    const inoStale = makeStaleSocket(P);
    expect(fs.existsSync(P), "stale entry must survive").toBe(true);

    const h = startVault({
      ch: CH,
      botToken: CH.botToken,
      stateDir: path.join(tmp, "state"),
      xdgDir: path.join(tmp, "xdg"),
      vaultDir: path.join(tmp, "vault"),
      knownDir: path.join(tmp, "vault", "known"),
      secretsDir: path.join(tmp, "vault", "secrets"),
      stateFile: path.join(tmp, "vault", "state.json"),
      auditFile: path.join(tmp, "audit.log"),
      fileDir: path.join(tmp, "files"),
      transport: "socket",
    });
    await h.ready;

    try {
      expect(
        h.vault.server,
        "bind over the leftover must succeed",
      ).not.toBeNull();
      expect(fs.lstatSync(P).ino, "leftover entry was not replaced").not.toBe(
        inoStale,
      );
      const r = await roundtrip(P, { op: "vstatus", agent: "monky" });
      expect(r.ok, "rebound socket must serve").toBe(true);
    } finally {
      stopVault(h);
      __vaultResetForTest();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("pat crash leftover (file, no listener) is unlinked and rebound", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bind128pc-"));
    const socketDir = path.join(tmp, "sock");
    setEnv("JARATE_PAT_DIR", socketDir);
    const P = path.join(socketDir, "pat.sock");
    const inoStale = makeStaleSocket(P);
    expect(fs.existsSync(P), "stale entry must survive").toBe(true);

    const h = startPatVault({
      ch: CH,
      botToken: CH.botToken,
      stateDir: path.join(tmp, "state"),
      xdgDir: path.join(tmp, "xdg"),
      fileDir: path.join(tmp, "files"),
      patsDir: path.join(tmp, "pats"),
      defaultPatFile: path.join(tmp, "marzukia-pat"),
      auditFile: path.join(tmp, "audit.log"),
      transport: "socket",
    });
    await h.ready;

    try {
      expect(
        h.vault.server,
        "bind over the leftover must succeed",
      ).not.toBeNull();
      expect(fs.lstatSync(P).ino, "leftover entry was not replaced").not.toBe(
        inoStale,
      );
      const r = await roundtrip(P, { op: "status", agent: "monky" });
      expect(r.ok, "rebound socket must serve").toBe(true);
    } finally {
      stopPatVault(h);
      __patVaultResetForTest();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
