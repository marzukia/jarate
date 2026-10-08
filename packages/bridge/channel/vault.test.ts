/**
 * Generic vault tests — docs/vault-design.md §12.
 *
 * Harness mirrors pat-vault.test.ts:
 *  - FakeDiscord: fetch stub enforcing Discord's one-callback rule.
 *  - Real clocks with env-shortened constants (TTL 1.2s, claim 0.8s,
 *    censor grace 0.2s, hour 0.6s); windows driven by manipulating
 *    state timestamps where waiting is impractical.
 *  - Sockets bind under a mkdtemp XDG dir — no box state touched.
 *
 * Covers: request validation, owner-approval gate, single-use (one-shot),
 * time-boxed window + expiry, permanent + revoke, deny, stored (BYO)
 * values, legacy PAT fallback, permissions, never-echo (state/audit/wire),
 * audit completeness, max-pending, restart recovery, budget, file
 * transport.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import {
  clearRegistryCache,
  clearRuntimeSecrets,
  getRuntimeSecrets,
} from "./censor";
import { parseGatewayPayload } from "./discord";
import {
  __vaultResetForTest,
  knownNames,
  readKnownValue,
  startVault,
  stopVault,
  type VaultHandle,
  type VaultState,
  validateRequestLine,
  validateValueShape,
  vaultRequest,
  vaultSlash,
} from "./vault";

// ─── fake Discord REST ─────────────────────────────────────────────────────

function resp(status: number, data: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => data,
    text: async () =>
      data == null
        ? ""
        : typeof data === "string"
          ? data
          : JSON.stringify(data),
  };
}

class FakeDiscord {
  calls: Array<{ url: string; method: string; body: any }> = [];
  callbackSpent = new Set<string>();
  private msgSeq = 0;

  install(): void {
    globalThis.fetch = (async (input: any, init?: any) => {
      const url = String(input);
      const method: string = init?.method ?? "GET";
      let body: any;
      if (typeof init?.body === "string") {
        try {
          body = JSON.parse(init.body);
        } catch {
          body = init.body;
        }
      }
      this.calls.push({ url, method, body });
      const cb = url.match(/\/interactions\/([^/]+)\/[^/]+\/callback$/);
      if (cb) {
        if (this.callbackSpent.has(cb[1])) {
          return resp(400, { message: "unknown interaction" });
        }
        this.callbackSpent.add(cb[1]);
        return resp(204, null);
      }
      if (method === "POST" && /\/channels\/[^/]+\/messages$/.test(url)) {
        return resp(200, { id: `msg-${++this.msgSeq}` });
      }
      if (
        method === "POST" &&
        url.includes("/webhooks/") &&
        url.includes("messages?wait=true")
      ) {
        return resp(200, { id: "followup" });
      }
      // Interaction webhook (RCA 2026-10-08): POST /webhooks/{app}/{token}
      // is Create Followup (webhook ROOT — wait is implicit); the
      // /messages/@original subroute edits/deletes the deferred ack.
      const wh = url.match(/\/webhooks\/[^/]+\/[^/]+(\/.*)?$/);
      if (wh) {
        const rest = wh[1] ?? "";
        if (method === "POST" && rest === "")
          return resp(200, { id: "followup" });
        if (rest.startsWith("/messages/")) return resp(204, null);
        return resp(404, { message: "Unknown Webhook Message" });
      }
      if (method === "PATCH" && url.includes("/messages/"))
        return resp(204, null);
      if (method === "DELETE") return resp(204, null);
      return resp(200, {});
    }) as any;
  }

  followups(): Array<{ url: string; body: any }> {
    return this.calls
      .filter(
        (c) => c.method === "POST" && /\/webhooks\/[^/]+\/[^/]+$/.test(c.url),
      )
      .map((c) => ({ url: c.url, body: c.body }));
  }

  /** Visible tap replies: PATCH @original on the interaction webhook. */
  replies(id?: string): Array<{ url: string; body: any }> {
    return this.calls
      .filter(
        (c) =>
          c.method === "PATCH" &&
          c.url.includes("/webhooks/") &&
          c.url.endsWith("/messages/@original") &&
          (id ? c.url.includes(`intok-${id}`) : true),
      )
      .map((c) => ({ url: c.url, body: c.body }));
  }

  callbacksFor(id: string): number {
    return this.calls.filter(
      (c) =>
        c.method === "POST" &&
        c.url.includes(`/interactions/${id}/`) &&
        c.url.endsWith("/callback"),
    ).length;
  }

  channelPosts(): any[] {
    return this.calls.filter(
      (c) => c.method === "POST" && /\/channels\/[^/]+\/messages$/.test(c.url),
    );
  }

  messageEdits(): any[] {
    // Channel message edits only (the tap reply PATCHes the interaction
    // webhook's @original — a different /messages/ route, excluded here).
    return this.calls.filter(
      (c) =>
        c.method === "PATCH" &&
        c.url.includes("/channels/") &&
        c.url.includes("/messages/"),
    );
  }
}

// ─── fixtures ──────────────────────────────────────────────────────────────

const OWNER = "108801968763305984";
const OTHER = "215356028869541889";
const FINE_TOKEN = `github_pat_${"f".repeat(30)}`;
const CLASSIC_TOKEN = `ghp_${"c".repeat(36)}`;
const BYO_VALUE = `sk-vault-byo-${"x".repeat(24)}`;

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface VaultFix {
  h: VaultHandle;
  st: VaultState;
  fd: FakeDiscord;
  tmp: string;
  ch: any;
  xdg: string;
  vaultDir: string;
  knownDir: string;
  secretsDir: string;
  stateFile: string;
  auditPath: string;
  legacyPatsDir: string;
  legacyDefaultPatFile: string;
  auditLines: () => string[];
  auditEvents: () => Array<Record<string, unknown>>;
  cleanup: () => void;
}

const realFetch = globalThis.fetch;
const savedEnv: Record<string, string | undefined> = {};

function setEnv(k: string, v: string): void {
  savedEnv[k] = process.env[k];
  process.env[k] = v;
}

function restoreEnv(): void {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  for (const k of Object.keys(savedEnv)) delete process.env[k];
}

function mkVault(
  over: {
    transport?: "socket" | "file";
    ch?: any;
    budgetPerHour?: number;
    xdgDir?: string;
  } = {},
): VaultFix {
  const tmp = over.xdgDir
    ? path.join(over.xdgDir, "..")
    : fs.mkdtempSync(path.join(os.tmpdir(), "vault-"));
  const xdg = over.xdgDir ?? path.join(tmp, "xdg");
  const vaultDir = path.join(tmp, "vault");
  const knownDir = path.join(vaultDir, "known");
  const secretsDir = path.join(vaultDir, "secrets");
  const stateFile = path.join(vaultDir, "state.json");
  const auditPath = path.join(vaultDir, "audit.log");

  // Known values: github-pat scope in the vault known/ dir; legacy
  // fallback files for the legacy-fallback test.
  fs.mkdirSync(path.join(knownDir, "github-pat", "marzukia"), {
    recursive: true,
  });
  fs.writeFileSync(
    path.join(knownDir, "github-pat", "marzukia", "jarate:write"),
    FINE_TOKEN,
    {
      mode: 0o600,
    },
  );
  fs.mkdirSync(path.join(knownDir, "api-key"), { recursive: true });
  for (const n of ["window-key", "other-key", "bk-0", "bk-1", "bk-3"]) {
    fs.writeFileSync(path.join(knownDir, "api-key", n), `key-${n}-value`, {
      mode: 0o600,
    });
  }
  const legacyPatsDir = path.join(tmp, "legacy-pats");
  fs.mkdirSync(path.join(legacyPatsDir, "legacyorg"), { recursive: true });
  fs.writeFileSync(
    path.join(legacyPatsDir, "legacyorg", "legacorepo:read"),
    `${FINE_TOKEN}\n`,
    { mode: 0o600 },
  );
  const legacyDefaultPatFile = path.join(tmp, "marzukia-pat");
  fs.writeFileSync(legacyDefaultPatFile, `${CLASSIC_TOKEN}\n`, { mode: 0o600 });

  const ch =
    over.ch ??
    ({
      id: "ch1",
      name: "ch1",
      type: "discord",
      channel: "999",
      botToken: "tok-ch1",
      ownerUserId: OWNER,
      ownerUserIds: [OWNER],
    } as any);

  // Shortened clocks (env read at startVault).
  setEnv("JARATE_VAULT_TTL_MS", "1200");
  setEnv("JARATE_VAULT_CLAIM_MS", "800");
  setEnv("JARATE_VAULT_CENSOR_GRACE_MS", "200");
  setEnv("JARATE_VAULT_HOUR_MS", "600");
  setEnv("JARATE_VAULT_MAX_PENDING", "1");
  setEnv("JARATE_VAULT_BUDGET_PER_HOUR", String(over.budgetPerHour ?? 5));

  const h = startVault({
    ch,
    botToken: ch.botToken,
    stateDir: path.join(tmp, "state"),
    xdgDir: xdg,
    vaultDir,
    knownDir,
    secretsDir,
    stateFile,
    auditFile: auditPath,
    legacyPatsDir,
    legacyDefaultPatFile,
    transport: over.transport ?? "socket",
  });

  return {
    h,
    st: h.vault,
    fd: (() => {
      const fd = new FakeDiscord();
      fd.install();
      return fd;
    })(),
    tmp,
    ch,
    xdg,
    vaultDir,
    knownDir,
    secretsDir,
    stateFile,
    auditPath,
    legacyPatsDir,
    legacyDefaultPatFile,
    auditLines: () => readAudit(auditPath),
    auditEvents: () => readAudit(auditPath).map((l) => JSON.parse(l)),
    cleanup: () => {
      stopVault(h);
      globalThis.fetch = realFetch;
      clearRegistryCache();
      clearRuntimeSecrets();
      __vaultResetForTest();
      restoreEnv();
      fs.rmSync(tmp, { recursive: true, force: true });
    },
  };
}

function readAudit(p: string): string[] {
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, "utf-8").trim().split("\n");
}

function mkD(
  id: string,
  customId: string,
  over: Record<string, any> = {},
): any {
  return {
    type: 3, // MESSAGE_COMPONENT (current Discord spec)
    id,
    token: `intok-${id}`,
    application_id: "app1",
    channel_id: "999",
    // Real payload shape (RCA 2026-10-08): the component's message is the
    // `message` field on the interaction itself; d.message_id does not
    // exist in Discord's spec and used to be what the handler compared.
    message: { id: "" },
    data: { custom_id: customId },
    user: { id: OWNER, username: "Owner" },
    ...over,
  };
}

/** Create a pending request the way the socket `vrequest` op would. */
async function makePending(
  f: VaultFix,
  line: Record<string, unknown> = {
    agent: "monky",
    kind: "github-pat",
    name: "marzukia/jarate:write",
    level: "one-shot",
    reason: "open PR for #41",
  },
): Promise<string> {
  const r = await vaultRequest(f.st, line as any);
  if (!r.ok) throw new Error(`vaultRequest failed: ${r.error}`);
  return r.id as string;
}

/** Owner-approves the credential, awaiting the followup post. */
async function approve(f: VaultFix, id: string): Promise<void> {
  await f.h.ready;
  const cred = f.st.credentials.get(id);
  await f.h.handleVaultComponent(
    mkD(`i-${id}`, `vault:approve:${id}`, {
      message: { id: cred?.messageId ?? "" },
    }),
  );
}

/** Owner-deny / owner-revoke taps (message.id matched). */
async function tap(
  f: VaultFix,
  id: string,
  verb: "deny" | "revoke",
): Promise<void> {
  await f.h.ready;
  const cred = f.st.credentials.get(id);
  await f.h.handleVaultComponent(
    mkD(`i-${verb}-${id}`, `vault:${verb}:${id}`, {
      message: { id: cred?.messageId ?? "" },
    }),
  );
}

/** Socket client against the fixture's vault.sock. */
class VaultClient {
  sock: net.Socket;
  /** Everything received, verbatim (wire audit). */
  raw = "";
  private buf = "";
  private lineResolvers: Array<(line: string) => void> = [];
  private queued: string[] = [];

  constructor(xdg: string) {
    this.sock = net.connect(path.join(xdg, "jarate", "vault.sock"));
    this.sock.on("data", (d: Buffer) => this.onData(d));
  }

  connect(): Promise<void> {
    return new Promise((res, rej) => {
      this.sock.once("connect", () => res());
      this.sock.once("error", (e) => rej(e));
    });
  }

  private onData(d: Buffer): void {
    this.raw += d.toString("utf-8");
    this.buf += d.toString("utf-8");
    let idx = this.buf.indexOf("\n");
    while (idx >= 0) {
      const line = this.buf.slice(0, idx);
      this.buf = this.buf.slice(idx + 1);
      idx = this.buf.indexOf("\n");
      const r = this.lineResolvers.shift();
      if (r) r(line);
      else this.queued.push(line);
    }
  }

  send(obj: Record<string, unknown>): void {
    this.sock.write(`${JSON.stringify({ v: 1, ...obj })}\n`);
  }

  nextLine(timeoutMs = 5000): Promise<string> {
    return new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error("client timeout")), timeoutMs);
      this.lineResolvers.push((line) => {
        clearTimeout(t);
        res(line);
      });
      const q = this.queued.shift();
      if (q !== undefined) {
        clearTimeout(t);
        res(q);
      }
    });
  }

  close(): void {
    this.sock.destroy();
  }
}

async function vrun(
  f: VaultFix,
  id: string,
  cmd: string[] = ["true"],
  agent = "monky",
): Promise<any> {
  const c = new VaultClient(f.xdg);
  try {
    await c.connect();
    c.send({ op: "vrun", id, agent, cmd, timeout_s: 60 });
    return JSON.parse(await c.nextLine());
  } finally {
    c.close();
  }
}

async function vstatus(
  f: VaultFix,
  id?: string,
  agent = "monky",
): Promise<any> {
  const c = new VaultClient(f.xdg);
  try {
    await c.connect();
    c.send({ op: "vstatus", agent, ...(id ? { id } : {}) });
    return JSON.parse(await c.nextLine());
  } finally {
    c.close();
  }
}

async function vrevoke(f: VaultFix, id: string, agent = "monky"): Promise<any> {
  const c = new VaultClient(f.xdg);
  try {
    await c.connect();
    c.send({ op: "vrevoke", agent, id });
    return JSON.parse(await c.nextLine());
  } finally {
    c.close();
  }
}

function modeOf(p: string): number {
  return (fs.statSync(p).mode & 0o777) as number;
}

beforeEach(() => {
  restoreEnv();
});

afterEach(() => {
  clearRegistryCache();
});

// ─── pure helpers ──────────────────────────────────────────────────────────

describe("validateRequestLine", () => {
  test("rejects bad kind", () => {
    const r = validateRequestLine({
      kind: "ssh-key" as any,
      name: "x",
      level: "one-shot",
      reason: "abc",
    } as any);
    expect(r.ok).toBe(false);
  });

  test("github-pat name must be default or owner/repo:perm", () => {
    expect(
      validateRequestLine({
        kind: "github-pat",
        name: "bad/scope!",
        level: "one-shot",
        reason: "abc",
      } as any).ok,
    ).toBe(false);
    expect(
      validateRequestLine({
        kind: "github-pat",
        name: "default",
        level: "one-shot",
        reason: "abc",
      } as any).ok,
    ).toBe(true);
  });

  test("time-boxed needs hours 1..72", () => {
    const base = {
      kind: "api-key" as const,
      name: "k",
      envvar: "K",
      reason: "abc",
    };
    expect(
      validateRequestLine({ ...base, level: "time-boxed" } as any).ok,
    ).toBe(false);
    expect(
      validateRequestLine({
        ...base,
        level: "time-boxed",
        hours: 0,
      } as any).ok,
    ).toBe(false);
    expect(
      validateRequestLine({
        ...base,
        level: "time-boxed",
        hours: 73,
      } as any).ok,
    ).toBe(false);
    expect(
      validateRequestLine({
        ...base,
        level: "time-boxed",
        hours: 2,
      } as any).ok,
    ).toBe(true);
    // --hours on non-time-boxed is a usage error
    expect(
      validateRequestLine({
        kind: "api-key",
        name: "k",
        level: "one-shot",
        hours: 2,
        reason: "abc",
      } as any).ok,
    ).toBe(false);
  });

  test("envvar: required for non-github-pat, defaults to GH_TOKEN for github-pat", () => {
    expect(
      validateRequestLine({
        kind: "api-key",
        name: "k",
        level: "one-shot",
        reason: "abc",
      } as any).ok,
    ).toBe(false);
    expect(
      validateRequestLine({
        kind: "api-key",
        name: "k",
        level: "one-shot",
        envvar: "MY_KEY",
        reason: "abc",
      } as any).ok,
    ).toBe(true);
    const r = validateRequestLine({
      kind: "github-pat",
      name: "default",
      level: "one-shot",
      reason: "abc",
    } as any);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.envvar).toBe("GH_TOKEN");
  });

  test("reason 3..200", () => {
    expect(
      validateRequestLine({
        kind: "api-key",
        name: "k",
        level: "one-shot",
        envvar: "K",
        reason: "ab",
      } as any).ok,
    ).toBe(false);
  });
});

describe("validateValueShape", () => {
  test("github-pat: token regex", () => {
    expect(validateValueShape("github-pat", FINE_TOKEN)).toBe(true);
    expect(validateValueShape("github-pat", CLASSIC_TOKEN)).toBe(true);
    expect(validateValueShape("github-pat", "not-a-token")).toBe(false);
  });

  test("api-key: no whitespace, 1..4096", () => {
    expect(validateValueShape("api-key", "abc.def/ghi")).toBe(true);
    expect(validateValueShape("api-key", "has space")).toBe(false);
    expect(validateValueShape("api-key", "")).toBe(false);
    expect(validateValueShape("api-key", "a".repeat(4097))).toBe(false);
  });

  test("password: no newlines, 1..4096", () => {
    expect(validateValueShape("password", "p w s s\nword")).toBe(false);
    expect(validateValueShape("password", "p w s s word")).toBe(true);
  });
});

// ─── state machine ─────────────────────────────────────────────────────────

describe("one-shot (single-use)", () => {
  test("request -> owner approve -> run once -> consumed; second run rejected", async () => {
    const f = mkVault();
    try {
      await f.h.ready;
      const id = await makePending(f);
      expect(f.st.credentials.get(id)?.state).toBe("pending");

      // Run before approval is rejected.
      let r = await vrun(f, id);
      expect(r.ok).toBe(false);
      expect(String(r.error)).toMatch(/pending/i);

      await approve(f, id);
      const cred = f.st.credentials.get(id)!;
      expect(cred.state).toBe("active");

      r = await vrun(f, id);
      expect(r.ok).toBe(true);
      expect(r.token).toBe(FINE_TOKEN);
      expect(r.envvar).toBe("GH_TOKEN");
      expect(r.git_header).toBe(true);

      // Second run: consumed.
      r = await vrun(f, id);
      expect(r.ok).toBe(false);
      expect(String(r.error)).toMatch(/already used/i);
      expect(f.st.credentials.get(id)?.state).toBe("consumed");

      const events = f.auditEvents().map((e) => e.event);
      expect(events).toContain("request");
      expect(events).toContain("approve");
      expect(events).toContain("use");
    } finally {
      f.cleanup();
    }
  }, 15000);

  test("non-owner button tap is ignored; state stays pending", async () => {
    const f = mkVault();
    try {
      await f.h.ready;
      const id = await makePending(f);
      await f.h.handleVaultComponent(
        mkD(`i-n1`, `vault:approve:${id}`, {
          user: { id: OTHER, username: "Other" },
          message: { id: f.st.credentials.get(id)?.messageId ?? "" },
        }),
      );
      expect(f.st.credentials.get(id)?.state).toBe("pending");
      const events = f.auditEvents().map((e) => e.event);
      expect(events).toContain("non-owner-tap");
    } finally {
      f.cleanup();
    }
  }, 15000);

  test("deny -> denied, terminal; run rejected", async () => {
    const f = mkVault();
    try {
      await f.h.ready;
      const id = await makePending(f);
      await tap(f, id, "deny");
      expect(f.st.credentials.get(id)?.state).toBe("denied");
      const r = await vrun(f, id);
      expect(r.ok).toBe(false);
      const events = f.auditEvents().map((e) => e.event);
      expect(events).toContain("deny");
    } finally {
      f.cleanup();
    }
  }, 15000);

  test("max-pending: second request while one is pending is rejected", async () => {
    const f = mkVault();
    try {
      await f.h.ready;
      await makePending(f);
      const res = await vaultRequest(f.st, {
        agent: "monky",
        kind: "api-key",
        name: "other-key",
        level: "one-shot",
        envvar: "OTHER",
        reason: "second request",
      } as any);
      expect(res.ok).toBe(false);
      expect(String(res.error)).toMatch(/pending/i);
    } finally {
      f.cleanup();
    }
  }, 15000);
});

describe("time-boxed", () => {
  test("reusable within window; expires after hours; use-after-expiry rejected", async () => {
    // HOUR_MS shortened to 600ms in the fixture; hours=1 -> 600ms window.
    const f = mkVault();
    try {
      await f.h.ready;
      const id = await makePending(f, {
        agent: "monky",
        kind: "api-key",
        name: "window-key",
        level: "time-boxed",
        hours: 1,
        envvar: "WIN_KEY",
        reason: "short window",
      });
      await approve(f, id);
      const cred = f.st.credentials.get(id)!;
      expect(cred.state).toBe("active");
      expect(cred.expiresAt).toBeGreaterThan(0);

      // Two runs inside the window.
      let r = await vrun(f, id);
      expect(r.ok).toBe(true);
      expect(r.envvar).toBe("WIN_KEY");
      expect(r.git_header).toBe(false);
      r = await vrun(f, id);
      expect(r.ok).toBe(true);
      expect(f.st.credentials.get(id)?.useCount).toBe(2);

      // Expire the window (timer or lazy settle).
      await tick(700);
      const events = f.auditEvents().map((e) => e.event);
      expect(events).toContain("expire");
      expect(f.st.credentials.get(id)?.state).toBe("expired");

      r = await vrun(f, id);
      expect(r.ok).toBe(false);
      expect(String(r.error)).toMatch(/expired/i);
    } finally {
      f.cleanup();
    }
  }, 15000);

  test("concurrent runs: both hand off, each done counted, counter drains", async () => {
    const f = mkVault();
    try {
      await f.h.ready;
      const id = await makePending(f, {
        agent: "monky",
        kind: "api-key",
        name: "window-key",
        level: "time-boxed",
        hours: 2,
        envvar: "KC",
        reason: "concurrent runs",
      });
      await approve(f, id);

      const c1 = new VaultClient(f.xdg);
      const c2 = new VaultClient(f.xdg);
      await Promise.all([c1.connect(), c2.connect()]);
      c1.send({ op: "vrun", id, agent: "monky", cmd: ["true"], timeout_s: 60 });
      c2.send({ op: "vrun", id, agent: "monky", cmd: ["true"], timeout_s: 60 });
      const r1 = JSON.parse(await c1.nextLine());
      const r2 = JSON.parse(await c2.nextLine());
      expect(r1.ok).toBe(true);
      expect(r2.ok).toBe(true);
      expect(r1.token).toBe(r2.token);

      c1.send({ op: "vdone", id, rc: 0 });
      expect(JSON.parse(await c1.nextLine()).ok).toBe(true);
      c2.send({ op: "vdone", id, rc: 3 });
      const d2 = JSON.parse(await c2.nextLine());
      expect(d2.ok, JSON.stringify(d2)).toBe(true);
      c1.close();
      c2.close();

      const st = await vstatus(f, id);
      expect(st.ok).toBe(true);
      expect(st.use_count).toBe(2);
      expect(st.last_rc).toBe(3);
      expect(f.st.credentials.get(id)!.runsInFlight).toBe(0);
    } finally {
      f.cleanup();
    }
  }, 20000);
});

describe("permanent", () => {
  test("stays active until revoked; use-after-revoke rejected", async () => {
    const f = mkVault();
    try {
      await f.h.ready;
      // known mode needs a known value file for password kind
      fs.mkdirSync(path.join(f.knownDir, "password"), { recursive: true });
      fs.writeFileSync(
        path.join(f.knownDir, "password", "db-pass"),
        "correct horse battery staple",
        { mode: 0o600 },
      );
      const id = await makePending(f, {
        agent: "monky",
        kind: "password",
        name: "db-pass",
        level: "permanent",
        envvar: "DB_PASSWORD",
        reason: "db access",
      });
      const r0 = await vrun(f, id);
      expect(r0.ok).toBe(false); // pending
      await approve(f, id);
      expect(f.st.credentials.get(id)?.state).toBe("active");
      const r = await vrun(f, id);
      expect(r.ok).toBe(true);
      expect(r.envvar).toBe("DB_PASSWORD");

      // No expiry scheduled.
      expect(f.st.credentials.get(id)?.expiresAt).toBeUndefined();

      // Agent self-revoke.
      const rv = await vrevoke(f, id);
      expect(rv.ok).toBe(true);
      expect(f.st.credentials.get(id)?.state).toBe("revoked");
      const r2 = await vrun(f, id);
      expect(r2.ok).toBe(false);
      expect(String(r2.error)).toMatch(/revoked/i);
      const events = f.auditEvents().map((e) => e.event);
      expect(events).toContain("revoke");
    } finally {
      f.cleanup();
    }
  }, 15000);
});

describe("stored values (BYO --from-env)", () => {
  test("value file 0600 with exact bytes; never in state/audit; deleted at terminal", async () => {
    const f = mkVault();
    try {
      await f.h.ready;
      const res = await vaultRequest(f.st, {
        agent: "monky",
        kind: "api-key",
        name: "byo-key",
        level: "one-shot",
        envvar: "BYO_KEY",
        from_env: "MY_SECRET",
        value: BYO_VALUE,
        reason: "bring your own key",
      } as any);
      expect(res.ok).toBe(true);
      const id = res.id as string;

      // Value file: exact bytes, 0600.
      const vp = path.join(f.secretsDir, `${id}.secret`);
      expect(fs.readFileSync(vp, "utf-8")).toBe(BYO_VALUE);
      expect(modeOf(vp)).toBe(0o600);

      // No literal in state.json or audit.
      expect(fs.readFileSync(f.stateFile, "utf-8")).not.toContain(BYO_VALUE);
      expect(f.auditLines().join("\n")).not.toContain(BYO_VALUE);

      await approve(f, id);
      const run = await vrun(f, id);
      expect(run.ok).toBe(true);
      expect(run.token).toBe(BYO_VALUE);

      // Wire: the value crossed the socket exactly once (this run).
      // (Audit the wire below via a fresh client is racy — instead assert
      // the state/audit invariants and file deletion.)
      const st = fs.readFileSync(f.stateFile, "utf-8");
      expect(st).not.toContain(BYO_VALUE);
      expect(f.auditLines().join("\n")).not.toContain(BYO_VALUE);
      // Terminal: value file deleted.
      expect(fs.existsSync(vp)).toBe(false);
      expect(f.st.credentials.get(id)?.state).toBe("consumed");
    } finally {
      f.cleanup();
    }
  }, 15000);

  test("reject on request failure keeps no value file", async () => {
    const f = mkVault();
    try {
      await f.h.ready;
      const res = await vaultRequest(f.st, {
        agent: "monky",
        kind: "api-key",
        name: "byo-bad",
        level: "one-shot",
        envvar: "BYO",
        from_env: "MY_SECRET",
        value: "has space inside",
        reason: "bad shape",
      } as any);
      expect(res.ok).toBe(false);
      const files = fs.readdirSync(f.secretsDir);
      expect(files.filter((x) => x.endsWith(".secret")).length).toBe(0);
    } finally {
      f.cleanup();
    }
  }, 15000);

  test("deny deletes the stored value file", async () => {
    const f = mkVault();
    try {
      await f.h.ready;
      const res = await vaultRequest(f.st, {
        agent: "monky",
        kind: "password",
        name: "byo-pw",
        level: "permanent",
        envvar: "PW",
        from_env: "MY_SECRET",
        value: BYO_VALUE,
        reason: "stored pw",
      } as any);
      expect(res.ok).toBe(true);
      const id = res.id as string;
      const vp = path.join(f.secretsDir, `${id}.secret`);
      expect(fs.existsSync(vp)).toBe(true);
      await tap(f, id, "deny");
      expect(f.st.credentials.get(id)?.state).toBe("denied");
      expect(fs.existsSync(vp)).toBe(false);
      expect(fs.readFileSync(f.stateFile, "utf-8")).not.toContain(BYO_VALUE);
    } finally {
      f.cleanup();
    }
  }, 15000);
});

describe("legacy github-pat fallback", () => {
  test("vault known/ wins; then legacy pats dir; then default file", async () => {
    const f = mkVault();
    try {
      expect(knownNames(f.st, "github-pat")).toContain("marzukia/jarate:write");
      expect(knownNames(f.st, "github-pat")).toContain(
        "legacyorg/legacorepo:read",
      );
      expect(knownNames(f.st, "github-pat")).toContain("default");

      // Vault known/ file (no trailing newline handling differences):
      expect(readKnownValue(f.st, "github-pat", "marzukia/jarate:write")).toBe(
        FINE_TOKEN,
      );
      // Legacy scoped file (with trailing newline, trimmed on read):
      expect(
        readKnownValue(f.st, "github-pat", "legacyorg/legacorepo:read"),
      ).toBe(FINE_TOKEN);
      // Legacy default file:
      expect(readKnownValue(f.st, "github-pat", "default")).toBe(CLASSIC_TOKEN);
    } finally {
      f.cleanup();
    }
  });
});

describe("permissions", () => {
  test("dirs 0700, state/audit/value 0600", async () => {
    const f = mkVault();
    try {
      await f.h.ready;
      // A request persists state.json.
      const id = await makePending(f, {
        agent: "monky",
        kind: "api-key",
        name: "bk-perm",
        level: "one-shot",
        envvar: "BP",
        from_env: "MY_SECRET",
        value: "perm-test-value",
        reason: "perms check",
      });
      expect(modeOf(f.vaultDir)).toBe(0o700);
      expect(modeOf(f.knownDir)).toBe(0o700);
      expect(modeOf(f.secretsDir)).toBe(0o700);
      expect(modeOf(f.stateFile)).toBe(0o600);
      expect(modeOf(f.auditPath)).toBe(0o600);
      expect(modeOf(path.join(f.secretsDir, `${id}.secret`))).toBe(0o600);
      const socketDir = path.join(f.xdg, "jarate");
      expect(modeOf(socketDir)).toBe(0o700);
      expect(modeOf(path.join(socketDir, "vault.sock"))).toBe(0o600);
    } finally {
      f.cleanup();
    }
  }, 15000);
});

describe("never-echo (wire audit)", () => {
  test("one-shot: token crosses the socket exactly once", async () => {
    const f = mkVault();
    try {
      await f.h.ready;
      const id = await makePending(f);
      await approve(f, id);
      const c = new VaultClient(f.xdg);
      await c.connect();
      c.send({ op: "vrun", id, agent: "monky", cmd: ["true"], timeout_s: 60 });
      const line1 = await c.nextLine();
      c.send({ op: "vrun", id, agent: "monky", cmd: ["true"], timeout_s: 60 });
      const line2 = await c.nextLine();
      c.close();
      expect(JSON.parse(line1).token).toBe(FINE_TOKEN);
      expect(JSON.parse(line2).ok).toBe(false);
      expect(c.raw.split(FINE_TOKEN).length - 1).toBe(1);
    } finally {
      f.cleanup();
    }
  }, 15000);

  test("status output never contains a value", async () => {
    const f = mkVault();
    try {
      await f.h.ready;
      const id = await makePending(f, {
        agent: "monky",
        kind: "api-key",
        name: "byo-status",
        level: "one-shot",
        envvar: "BS",
        from_env: "MY_SECRET",
        value: BYO_VALUE,
        reason: "status check",
      });
      await approve(f, id);
      const s = await vstatus(f, id);
      expect(s.ok).toBe(true);
      expect(JSON.stringify(s)).not.toContain(BYO_VALUE);
      const s2 = await vstatus(f);
      expect(JSON.stringify(s2)).not.toContain(BYO_VALUE);
    } finally {
      f.cleanup();
    }
  }, 15000);
});

describe("audit completeness", () => {
  test("full one-shot lifecycle events in order, with actor", async () => {
    const f = mkVault();
    try {
      await f.h.ready;
      const id = await makePending(f);
      await approve(f, id);
      await vrun(f, id);
      const ev = f.auditEvents();
      const seq = ev.map((e) => e.event);
      const iReq = seq.indexOf("request");
      const iApp = seq.indexOf("approve");
      const iUse = seq.indexOf("use");
      expect(iReq).toBeGreaterThanOrEqual(0);
      expect(iApp).toBeGreaterThan(iReq);
      expect(iUse).toBeGreaterThan(iApp);
      const req = ev[iReq];
      expect(req.agent).toBe("monky");
      expect(req.kind).toBe("github-pat");
      expect(req.name).toBe("marzukia/jarate:write");
      expect(req.ts).toBeTruthy();
      const app = ev[iApp];
      expect(app.user).toBe(OWNER);
      expect(app.id).toBe(id);
      expect(seq).toContain("use");
    } finally {
      f.cleanup();
    }
  }, 15000);

  test("budget: cap 2 approvals/hour; third rejected with next slot", async () => {
    const f = mkVault({ budgetPerHour: 2 });
    try {
      await f.h.ready;
      for (let i = 0; i < 2; i++) {
        const res = await vaultRequest(f.st, {
          agent: "monky",
          kind: "api-key",
          name: `bk-${i}`,
          level: "one-shot",
          envvar: "BK",
          reason: `budget test ${i}`,
        } as any);
        expect(res.ok).toBe(true);
        await approve(f, res.id as string);
      }
      const res = await vaultRequest(f.st, {
        agent: "monky",
        kind: "api-key",
        name: "bk-3",
        level: "one-shot",
        envvar: "BK",
        reason: "budget test 3",
      } as any);
      expect(res.ok).toBe(false);
      expect(String(res.error)).toMatch(/budget/i);
      expect(String(res.error)).toMatch(/next slot/i);
    } finally {
      f.cleanup();
    }
  }, 15000);
});

describe("tap rejection feedback (RCA 2026-10-08)", () => {
  // Live repro: every tap hit the audit-silent message-mismatch path
  // (handler compared d.message_id — absent from Discord's payload — so
  // "undefined" !== cred.messageId always), and the ephemeral followup
  // reply 400'd on the wrong webhook URL. Both fixed: real field +
  // audit on every tap outcome + visible in-channel reply.

  test("string match (real payload shape): approve + audit", async () => {
    const f = mkVault();
    try {
      await f.h.ready;
      const id = await makePending(f);
      const cred = f.st.credentials.get(id);
      await f.h.handleVaultComponent(
        mkD(`i-str-${id}`, `vault:approve:${id}`, {
          message: { id: cred!.messageId },
        }),
      );
      expect(f.st.credentials.get(id)?.state).toBe("active");
      const app = f.auditEvents().find((e) => e.event === "approve");
      expect(app).toBeTruthy();
      expect(app!.user).toBe(OWNER);
      expect(app!.id).toBe(id);
    } finally {
      f.cleanup();
    }
  }, 15000);

  test("guild payload (live capture 2026-10-08): user under member.user, NO top-level user — owner tap approves", async () => {
    const f = mkVault();
    try {
      await f.h.ready;
      const id = await makePending(f);
      const cred = f.st.credentials.get(id);
      const d = mkD(`i-guild-${id}`, `vault:approve:${id}`, {
        message: { id: cred!.messageId },
        member: { user: { id: OWNER, username: "Owner" } },
      });
      delete d.user; // live shape: guild INTERACTION_CREATE omits top-level user
      await f.h.handleVaultComponent(d);
      expect(f.st.credentials.get(id)?.state).toBe("active");
      const app = f.auditEvents().find((e) => e.event === "approve");
      expect(app).toBeTruthy();
      expect(app!.user).toBe(OWNER);
    } finally {
      f.cleanup();
    }
  }, 15000);

  test("guild payload: non-owner via member.user audits the REAL uid (not empty string)", async () => {
    const f = mkVault();
    try {
      await f.h.ready;
      const id = await makePending(f);
      const cred = f.st.credentials.get(id);
      const d = mkD(`i-guild-nn-${id}`, `vault:approve:${id}`, {
        message: { id: cred!.messageId },
        member: { user: { id: OTHER, username: "Other" } },
      });
      delete d.user;
      await f.h.handleVaultComponent(d);
      expect(f.st.credentials.get(id)?.state).toBe("pending");
      const ev = f.auditEvents().find((e) => e.event === "non-owner-tap");
      expect(ev).toBeTruthy();
      expect(ev!.user).toBe(OTHER);
    } finally {
      f.cleanup();
    }
  }, 15000);

  test("wrong message: rejected + audited mismatch + visible reply", async () => {
    const f = mkVault();
    try {
      await f.h.ready;
      const id = await makePending(f);
      const cred = f.st.credentials.get(id);
      await f.h.handleVaultComponent(
        mkD("i-wm", `vault:approve:${id}`, {
          message: { id: "other-message" },
        }),
      );
      expect(f.st.credentials.get(id)?.state).toBe("pending");
      const ev = f.auditEvents().find((e) => e.event === "tap-rejected");
      expect(ev).toBeTruthy();
      expect(ev!.reason).toBe("mismatch");
      expect(ev!.expected_message).toBe(cred!.messageId);
      expect(ev!.got_message).toBe("other-message");
      // Visible, non-ephemeral, in-channel: PATCH @original, no flags.
      const r = f.fd.replies("i-wm");
      expect(r.length).toBe(1);
      expect(r[0].body.content).toMatch(/tap rejected/);
      expect(r[0].body.flags).toBeUndefined();
    } finally {
      f.cleanup();
    }
  }, 15000);

  test("stale custom id: audited not-found + visible reply", async () => {
    const f = mkVault();
    try {
      await f.h.ready;
      await f.h.handleVaultComponent(
        mkD("i-nf", "vault:approve:vault_00000000-0000-0000-0000-000000000000"),
      );
      const ev = f.auditEvents().find((e) => e.event === "tap-rejected");
      expect(ev).toBeTruthy();
      expect(ev!.reason).toBe("not-found");
      const r = f.fd.replies("i-nf");
      expect(r.length).toBe(1);
      expect(r[0].body.content).toMatch(/not found/);
    } finally {
      f.cleanup();
    }
  }, 15000);

  test("already handled: audited + visible reply (deny then approve)", async () => {
    const f = mkVault();
    try {
      await f.h.ready;
      const id = await makePending(f);
      await tap(f, id, "deny");
      expect(f.st.credentials.get(id)?.state).toBe("denied");
      await f.h.handleVaultComponent(
        mkD(`i-ag-${id}`, `vault:approve:${id}`, {
          message: { id: f.st.credentials.get(id)?.messageId ?? "" },
        }),
      );
      expect(f.st.credentials.get(id)?.state).toBe("denied");
      const ev = f
        .auditEvents()
        .find(
          (e) => e.event === "tap-rejected" && e.reason === "already-handled",
        );
      expect(ev).toBeTruthy();
      const r = f.fd.replies(`i-ag-${id}`);
      expect(r.length).toBe(1);
      expect(r[0].body.content).toMatch(/already handled/);
    } finally {
      f.cleanup();
    }
  }, 15000);

  test("gateway redelivery: audited duplicate, no second reply", async () => {
    const f = mkVault();
    try {
      await f.h.ready;
      const id = await makePending(f);
      const d = mkD(`i-dup-${id}`, `vault:approve:${id}`, {
        message: { id: "other-message" },
      });
      await f.h.handleVaultComponent(d);
      await f.h.handleVaultComponent(d);
      // exactly one visible reply for two deliveries
      expect(f.fd.replies(`i-dup-${id}`).length).toBe(1);
      const ev = f
        .auditEvents()
        .find((e) => e.event === "tap-rejected" && e.reason === "duplicate");
      expect(ev).toBeTruthy();
      expect(f.st.credentials.get(id)?.state).toBe("pending");
    } finally {
      f.cleanup();
    }
  }, 15000);

  test("bare 19-digit message id > 2^53 survives gateway parse (pipeline)", async () => {
    // Discord serializes snowflakes as strings today; this is the
    // string-safety net: a bare integer in the raw payload must NOT be
    // rounded before the tap match. 1557766848009994272 > 2^53.
    const f = mkVault();
    try {
      await f.h.ready;
      const id = await makePending(f);
      f.st.credentials.get(id)!.messageId = "1557766848009994272";
      const raw = JSON.stringify({
        op: 0,
        t: "INTERACTION_CREATE",
        s: 7,
        d: {
          type: 3,
          id: "i-big",
          token: "intok-i-big",
          application_id: "app1",
          channel_id: "999",
          message: { id: null }, // replaced below with a BARE integer
          data: { custom_id: `vault:approve:${id}` },
          user: { id: OWNER, username: "Owner" },
        },
      }).replace(
        '"message":{"id":null}',
        '"message":{"id":1557766848009994272}',
      );
      const d = parseGatewayPayload(raw).d;
      expect(d.message.id).toBe("1557766848009994272"); // string, exact
      await f.h.handleVaultComponent(d);
      expect(f.st.credentials.get(id)?.state).toBe("active");
      expect(
        f.auditEvents().some((e) => e.event === "approve" && e.user === OWNER),
      ).toBe(true);
    } finally {
      f.cleanup();
    }
  }, 15000);

  test("pre-rounded number id: rejected + audited (documents the limit)", async () => {
    // If a >2^53 id was already parsed to a double ELSEWHERE (not via
    // parseGatewayPayload), the precision is gone: 1557766848009994272
    // -> 1557766848009994200. The tap is rejected loudly, with audit
    // and a visible reply — never silently.
    const f = mkVault();
    try {
      await f.h.ready;
      const id = await makePending(f);
      f.st.credentials.get(id)!.messageId = "1557766848009994272";
      await f.h.handleVaultComponent(
        mkD("i-big2", `vault:approve:${id}`, {
          // biome-ignore lint/correctness/noPrecisionLoss: deliberate — the rounded double (…200) IS the test case
          message: { id: 1557766848009994272 },
        }),
      );
      expect(f.st.credentials.get(id)?.state).toBe("pending");
      const ev = f
        .auditEvents()
        .find((e) => e.event === "tap-rejected" && e.reason === "mismatch");
      expect(ev).toBeTruthy();
      expect(ev!.got_message).toBe("1557766848009994200"); // rounded
      const r = f.fd.replies("i-big2");
      expect(r.length).toBe(1);
    } finally {
      f.cleanup();
    }
  }, 15000);
});

describe("restart recovery", () => {
  test("pending stored credential survives stop/start; value file intact", async () => {
    const f = mkVault();
    try {
      await f.h.ready;
      f.st.ttlMs = 10_000; // keep the pending record alive across restart
      const res = await vaultRequest(f.st, {
        agent: "monky",
        kind: "api-key",
        name: "persist-key",
        level: "one-shot",
        envvar: "PK",
        from_env: "MY_SECRET",
        value: BYO_VALUE,
        reason: "restart test",
      } as any);
      expect(res.ok).toBe(true);
      const id = res.id as string;
      const vp = path.join(f.secretsDir, `${id}.secret`);
      expect(fs.existsSync(vp)).toBe(true);

      // Stop and restart the vault on the same dirs (no rm — the second
      // fixture must see the state + value file). Clear the process-global
      // censor registry to model a fresh process: a restart must re-arm it.
      stopVault(f.h);
      __vaultResetForTest();
      clearRegistryCache();
      clearRuntimeSecrets();
      const f2 = mkVault({ xdgDir: path.join(f.tmp, "xdg") });
      try {
        await f2.h.ready;
        const cred = f2.st.credentials.get(id);
        expect(cred).toBeDefined();
        expect(cred?.state).toBe("pending");
        expect(fs.readFileSync(vp, "utf-8")).toBe(BYO_VALUE);
        // F1: a still-live pending BYO value must be re-registered for the
        // censor across the restart (the registry has no TTL).
        expect(getRuntimeSecrets()).toContain(BYO_VALUE);
        // And it can still be approved + used after restart.
        await approve(f2, id);
        const run = await vrun(f2, id);
        expect(run.ok).toBe(true);
        expect(run.token).toBe(BYO_VALUE);
        // ...and the registration is dropped after run + censor grace.
        await new Promise((r) => setTimeout(r, 300));
        expect(getRuntimeSecrets()).not.toContain(BYO_VALUE);
      } finally {
        f2.cleanup();
      }
    } finally {
      fs.rmSync(f.tmp, { recursive: true, force: true });
    }
  }, 20000);

  test("orphan secrets/<id>.secret (crash before persist) is swept at boot", async () => {
    const f = mkVault();
    try {
      await f.h.ready;
      // Simulate a crash between writeValueFile and persist: stop the
      // vault, then leave a value file with no state.json record.
      stopVault(f.h);
      __vaultResetForTest();
      const orphanId = `vault-${"o".repeat(8)}-orphan`;
      fs.writeFileSync(
        path.join(f.secretsDir, `${orphanId}.secret`),
        "orphan-value",
        { mode: 0o600 },
      );
      const f2 = mkVault({ xdgDir: path.join(f.tmp, "xdg") });
      try {
        await f2.h.ready;
        expect(
          fs.existsSync(path.join(f2.secretsDir, `${orphanId}.secret`)),
        ).toBe(false);
        // The sweep is audited.
        expect(
          f2
            .auditEvents()
            .some(
              (e) => e.event === "sweep" && e.orphan === `${orphanId}.secret`,
            ),
        ).toBe(true);
      } finally {
        f2.cleanup();
      }
    } finally {
      fs.rmSync(f.tmp, { recursive: true, force: true });
    }
  }, 15000);
});

describe("file transport", () => {
  test("vrun publishes a 0600 value doc; bridge deletes it at terminal", async () => {
    const f = mkVault({ transport: "file" });
    try {
      await f.h.ready;
      const id = await makePending(f);
      await approve(f, id);
      const c = new VaultClient(f.xdg);
      await c.connect();
      c.send({ op: "vrun", id, agent: "monky", cmd: ["true"], timeout_s: 60 });
      const line = await c.nextLine();
      c.close();
      const r = JSON.parse(line);
      expect(r.ok).toBe(true);
      expect(r.file).toBe(true);
      const fp = path.join(f.xdg, "jarate-vault", `vault-${id}`);
      expect(modeOf(fp)).toBe(0o600);
      const doc = JSON.parse(fs.readFileSync(fp, "utf-8"));
      expect(doc.value).toBe(FINE_TOKEN);
      expect(doc.kind).toBe("github-pat");
      expect(doc.envvar).toBe("GH_TOKEN");
      expect(doc.git_header).toBe(true);

      // Done -> terminal for one-shot: file deleted.
      const c2 = new VaultClient(f.xdg);
      await c2.connect();
      c2.send({ op: "vrun", id, agent: "monky", cmd: ["true"], timeout_s: 60 });
      // (second run rejected — consumed)
      const line2 = await c2.nextLine();
      c2.close();
      expect(JSON.parse(line2).ok).toBe(false);
      // The vdone from the first run was never sent by this fake client;
      // simulate it:
      const c3 = new VaultClient(f.xdg);
      await c3.connect();
      c3.send({ op: "vdone", id, rc: 0 });
      await c3.nextLine();
      c3.close();
      await tick(50);
      expect(fs.existsSync(fp)).toBe(false);
    } finally {
      f.cleanup();
    }
  }, 15000);
});

describe("request edge cases", () => {
  test("unknown id on run/status/revoke", async () => {
    const f = mkVault();
    try {
      await f.h.ready;
      const r1 = await vrun(f, "vault_nope");
      expect(r1.ok).toBe(false);
      const r2 = await vstatus(f, "vault_nope");
      expect(r2.ok).toBe(false);
      const r3 = await vrevoke(f, "vault_nope");
      expect(r3.ok).toBe(false);
    } finally {
      f.cleanup();
    }
  }, 15000);

  test("known: no value file for name is a request error listing known names", async () => {
    const f = mkVault();
    try {
      await f.h.ready;
      const res = await vaultRequest(f.st, {
        agent: "monky",
        kind: "api-key",
        name: "does-not-exist",
        level: "one-shot",
        envvar: "X",
        reason: "no known file",
      } as any);
      expect(res.ok).toBe(false);
      expect(String(res.error)).toMatch(/no value file/i);
    } finally {
      f.cleanup();
    }
  }, 15000);
});

// ─── Tap-outcome observability (#204: every outcome visible + audited) ──────
//
// Appended block. Existing fixtures/tests untouched (two other workers own
// these shared files concurrently).
describe("tap observability (#204: every outcome visible + audited)", () => {
  test("non-owner tap, real payload shape (no message field): audited non-owner-tap, not mismatch", async () => {
    const f = mkVault();
    try {
      await f.h.ready;
      const id = await makePending(f);
      // Real shape: no top-level d.message_id; message absent entirely
      // (a stale/forwarded copy). Under the old order the mismatch check
      // preempted the owner gate and swallowed this as `mismatch`.
      await f.h.handleVaultComponent(
        mkD("obs-no1", `vault:approve:${id}`, {
          message: undefined,
          user: { id: OTHER, username: "Other" },
        }),
      );
      // Wrong-message variant: same expectation.
      await f.h.handleVaultComponent(
        mkD("obs-no2", `vault:approve:${id}`, {
          message: { id: "other-message" },
          user: { id: OTHER, username: "Other" },
        }),
      );
      expect(f.st.credentials.get(id)?.state).toBe("pending");
      const evs = f.auditEvents();
      expect(
        evs.filter((e) => e.event === "non-owner-tap" && e.user === OTHER)
          .length,
      ).toBe(2);
      expect(
        evs.some((e) => e.event === "tap-rejected" && e.reason === "mismatch"),
      ).toBe(false);
      for (const i of ["obs-no1", "obs-no2"]) {
        const r = f.fd.replies(i);
        expect(r.length).toBe(1);
        expect(r[0].body.content).toMatch(/only the owner/);
        expect(r[0].body.flags).toBeUndefined(); // visible, not ephemeral
      }
    } finally {
      f.cleanup();
    }
  }, 15000);

  test("feedback transport failure is audited tap-feedback-failed (#204)", async () => {
    const f = mkVault();
    try {
      await f.h.ready;
      const id = await makePending(f);
      // Kill every interaction-webhook call (PATCH @original + fallback
      // POST root). The defer callback + card posts are not webhooks.
      const whCalls: Array<{ url: string; method: string }> = [];
      const base = globalThis.fetch;
      globalThis.fetch = (async (input: any, init?: any) => {
        const url = String(input);
        if (url.includes("/webhooks/")) {
          whCalls.push({ url, method: init?.method ?? "GET" });
          return resp(503, { message: "stubbed outage" });
        }
        return base(input, init);
      }) as any;
      try {
        await f.h.handleVaultComponent(
          mkD("obs-ff", `vault:approve:${id}`, {
            message: { id: "other-message" },
          }),
        );
      } finally {
        globalThis.fetch = base;
      }

      // Decision audited, delivery failure audited with the same context.
      const evs = f.auditEvents();
      const rej = evs.find(
        (e) => e.event === "tap-rejected" && e.reason === "mismatch",
      );
      expect(rej).toBeTruthy();
      const ff = evs.find((e) => e.event === "tap-feedback-failed");
      expect(ff).toBeTruthy();
      expect(ff!.reason).toBe("mismatch");
      expect(ff!.user).toBe(OWNER);
      expect(ff!.verb).toBe("approve");
      expect(ff!.interaction).toBe("obs-ff");
      expect(String(ff!.text)).toContain("tap rejected");
      // Both routes were attempted, neither delivered.
      expect(
        whCalls.some(
          (c) => c.method === "PATCH" && c.url.endsWith("/messages/@original"),
        ),
      ).toBe(true);
      expect(
        whCalls.some(
          (c) => c.method === "POST" && c.url.endsWith("intok-obs-ff"),
        ),
      ).toBe(true);
      // State untouched.
      expect(f.st.credentials.get(id)?.state).toBe("pending");
    } finally {
      f.cleanup();
    }
  }, 15000);

  test("every rejection branch replies visible in-channel (no flags 64) (#204)", async () => {
    const f = mkVault();
    try {
      await f.h.ready;
      const id = await makePending(f);
      const cred = f.st.credentials.get(id)!;
      // not-found
      await f.h.handleVaultComponent(
        mkD(
          "obs-nf",
          "vault:approve:vault_00000000-0000-0000-0000-000000000000",
        ),
      );
      // mismatch
      await f.h.handleVaultComponent(
        mkD("obs-mm", `vault:approve:${id}`, {
          message: { id: "other-message" },
        }),
      );
      // non-owner (on the correct message — gate vs mismatch ordering)
      await f.h.handleVaultComponent(
        mkD("obs-no", `vault:approve:${id}`, {
          message: { id: cred.messageId },
          user: { id: OTHER, username: "Other" },
        }),
      );
      // stale: deny first, then approve again
      await tap(f, id, "deny");
      await f.h.handleVaultComponent(
        mkD("obs-st", `vault:approve:${id}`, {
          message: { id: cred.messageId },
        }),
      );

      for (const i of ["obs-nf", "obs-mm", "obs-no", "obs-st"]) {
        const r = f.fd.replies(i);
        expect(r.length, `reply for ${i}`).toBe(1);
        expect(r[0].body.flags, `flags for ${i}`).toBeUndefined();
        expect(r[0].body.content, `content for ${i}`).toMatch(/tap rejected/);
      }
      const evs = f.auditEvents();
      expect(
        evs.some((e) => e.event === "tap-rejected" && e.reason === "not-found"),
      ).toBe(true);
      expect(
        evs.some((e) => e.event === "tap-rejected" && e.reason === "mismatch"),
      ).toBe(true);
      expect(evs.some((e) => e.event === "non-owner-tap")).toBe(true);
      expect(
        evs.some(
          (e) => e.event === "tap-rejected" && e.reason === "already-handled",
        ),
      ).toBe(true);
    } finally {
      f.cleanup();
    }
  }, 15000);

  test("silent-branch audits carry the interaction id + fields (#204)", async () => {
    const f = mkVault();
    try {
      await f.h.ready;
      const id = await makePending(f);
      const cred = f.st.credentials.get(id)!;
      await f.h.handleVaultComponent(
        mkD(
          "obs-id1",
          "vault:approve:vault_00000000-0000-0000-0000-000000000000",
        ),
      );
      await f.h.handleVaultComponent(
        mkD("obs-id2", `vault:approve:${id}`, {
          message: { id: "other-message" },
        }),
      );
      await tap(f, id, "deny");
      await f.h.handleVaultComponent(
        mkD("obs-id3", `vault:approve:${id}`, {
          message: { id: cred.messageId },
        }),
      );

      const evs = f.auditEvents();
      const nf = evs.find(
        (e) => e.event === "tap-rejected" && e.reason === "not-found",
      );
      expect(nf!.interaction).toBe("obs-id1");
      const mm = evs.find(
        (e) => e.event === "tap-rejected" && e.reason === "mismatch",
      );
      expect(mm!.interaction).toBe("obs-id2");
      expect(mm!.user).toBe(OWNER);
      expect(mm!.got_message).toBe("other-message");
      expect(mm!.expected_message).toBe(cred.messageId);
      expect(mm!.got_channel).toBe("999");
      const sh = evs.find(
        (e) => e.event === "tap-rejected" && e.reason === "already-handled",
      );
      expect(sh!.interaction).toBe("obs-id3");
      expect(sh!.state).toBe("denied");
    } finally {
      f.cleanup();
    }
  }, 15000);
});

// ─── #203: no default TTL (pending = BLOCKING) ─────────────────────────────
//
// The fixture env always sets JARATE_VAULT_TTL_MS=1200 (shortened clock);
// no-TTL config (the new default) is modeled by st.ttlMs = 0 after start.

describe("#203 pending without TTL is blocking", () => {
  test("default (ttlMs 0): survives past the old 5m deadline, no expire, buttons intact, revoke kill switch", async () => {
    const f = mkVault();
    try {
      await f.h.ready;
      f.st.ttlMs = 0; // default config
      const res = await vaultRequest(f.st, {
        agent: "monky",
        kind: "api-key",
        name: "bk-0",
        level: "one-shot",
        envvar: "BK",
        reason: "no default ttl",
      } as any);
      expect(res.ok).toBe(true);
      expect(res.ttl).toBeNull(); // reply: no expiry
      const id = res.id as string;
      expect(f.st.credentials.get(id)!.ttlDeadline).toBe(0); // sentinel
      // Card: no-TTL footer + Revoke kill switch + content line.
      const posted = f.fd.channelPosts()[0].body;
      expect(posted.content).toBe("tap Approve, Deny, or Revoke");
      expect(posted.embeds[0].footer.text).toBe(
        `pending until tap or revoke · ${id}`,
      );
      const labels = posted.components[0].components.map((b: any) => b.label);
      expect(labels).toEqual(["Approve", "Deny", "Revoke"]);
      // Clock jumps past the old 5-minute deadline; real time also passes
      // the fixture's 1200ms TTL in case a timer was wrongly armed.
      const base = f.st.now();
      f.st.now = () => base + 6 * 60_000;
      await tick(1500);
      expect(f.st.credentials.get(id)!.state).toBe("pending");
      expect(f.auditEvents().map((e) => e.event)).not.toContain("expire");
      expect(f.fd.messageEdits().length).toBe(0); // card untouched
      // Pending-reject names the no-expiry state.
      const r2 = await vaultRequest(f.st, {
        agent: "monky",
        kind: "api-key",
        name: "bk-1",
        level: "one-shot",
        envvar: "BK",
        reason: "second request",
      } as any);
      expect(r2.ok).toBe(false);
      expect(String(r2.error)).toMatch(/no expiry/);
      // Kill switch: owner revoke tap on the pending card.
      await tap(f, id, "revoke");
      expect(f.st.credentials.get(id)!.state).toBe("revoked");
      const rev = f.auditEvents().find((e) => e.event === "revoke");
      expect(rev).toBeDefined();
      expect(rev!.from_state).toBe("pending");
      const edits = f.fd.messageEdits();
      expect(edits.length).toBe(1);
      expect(edits[0].body.components).toEqual([]); // buttons removed
      expect(edits[0].body.embeds[0].title).toBe("VAULT revoked");
      // The slot frees: a new request is accepted after the kill switch.
      const r3 = await vaultRequest(f.st, {
        agent: "monky",
        kind: "api-key",
        name: "bk-1",
        level: "one-shot",
        envvar: "BK",
        reason: "third request",
      } as any);
      expect(r3.ok).toBe(true);
    } finally {
      f.cleanup();
    }
  }, 15000);

  test("explicit JARATE_VAULT_TTL_MS still expires at the deadline", async () => {
    const f = mkVault(); // fixture env: JARATE_VAULT_TTL_MS=1200
    try {
      await f.h.ready;
      expect(f.st.ttlMs).toBe(1200);
      const res = await vaultRequest(f.st, {
        agent: "monky",
        kind: "api-key",
        name: "bk-3",
        level: "one-shot",
        envvar: "BK",
        reason: "explicit ttl",
      } as any);
      expect(res.ok).toBe(true);
      expect(typeof res.ttl).toBe("string"); // deadline in the reply
      const id = res.id as string;
      const posted = f.fd.channelPosts()[0].body;
      expect(posted.embeds[0].footer.text).toMatch(
        new RegExp(`^expires \\d{2}:\\d{2}:\\d{2}Z \\(1200ms\\) · ${id}$`),
      );
      await tick(1500);
      expect(f.st.credentials.get(id)!.state).toBe("expired");
      expect(
        f.auditEvents().some((e) => e.event === "expire" && e.reason === "ttl"),
      ).toBe(true);
      const edits = f.fd.messageEdits();
      expect(edits.length).toBe(1);
      expect(edits[0].body.components).toEqual([]);
    } finally {
      f.cleanup();
    }
  }, 15000);

  test("restart: no-TTL pending survives (no recovered-expired); still approvable", async () => {
    const f = mkVault();
    try {
      await f.h.ready;
      f.st.ttlMs = 0; // default config
      const res = await vaultRequest(f.st, {
        agent: "monky",
        kind: "api-key",
        name: "bk-3",
        level: "one-shot",
        envvar: "BK",
        from_env: "MY_SECRET",
        value: BYO_VALUE,
        reason: "restart no ttl",
      } as any);
      expect(res.ok).toBe(true);
      const id = res.id as string;
      const vp = path.join(f.secretsDir, `${id}.secret`);
      expect(fs.existsSync(vp)).toBe(true);
      // Long uptime, then restart on the same dirs.
      const base = f.st.now();
      f.st.now = () => base + 30 * 60_000;
      stopVault(f.h);
      __vaultResetForTest();
      clearRegistryCache();
      clearRuntimeSecrets();
      const f2 = mkVault({ xdgDir: path.join(f.tmp, "xdg") });
      try {
        await f2.h.ready;
        // f2's env TTL is 1200 (fixture) — the persisted no-TTL sentinel
        // must win: no recovered-expired, no timer re-armed against 0.
        const cred = f2.st.credentials.get(id)!;
        expect(cred.state).toBe("pending");
        expect(cred.ttlDeadline).toBe(0);
        expect(fs.readFileSync(vp, "utf-8")).toBe(BYO_VALUE);
        expect(
          f2.auditEvents().some((e) => e.event === "recovered-expired"),
        ).toBe(false);
        await tick(1500); // past f2's 1200ms env TTL: still pending
        expect(f2.st.credentials.get(id)!.state).toBe("pending");
        await approve(f2, id);
        const run = await vrun(f2, id);
        expect(run.ok).toBe(true);
        expect(run.token).toBe(BYO_VALUE);
      } finally {
        f2.cleanup();
      }
    } finally {
      fs.rmSync(f.tmp, { recursive: true, force: true });
    }
  }, 20000);

  test("revoke on pending: audited from_state pending, stored value deleted at settle", async () => {
    const f = mkVault();
    try {
      await f.h.ready;
      f.st.ttlMs = 0;
      const res = await vaultRequest(f.st, {
        agent: "monky",
        kind: "api-key",
        name: "bk-0",
        level: "time-boxed",
        hours: 2,
        envvar: "BK",
        from_env: "MY_SECRET",
        value: BYO_VALUE,
        reason: "revoke pending test",
      } as any);
      const id = res.id as string;
      const vp = path.join(f.secretsDir, `${id}.secret`);
      expect(fs.existsSync(vp)).toBe(true);
      await tap(f, id, "revoke");
      expect(f.st.credentials.get(id)!.state).toBe("revoked");
      expect(fs.existsSync(vp)).toBe(false); // deleted at settle
      const rev = f.auditEvents().find((e) => e.event === "revoke");
      expect(rev).toBeDefined();
      expect(rev!.from_state).toBe("pending");
      // active-revoke audit still records from_state active (no regression)
      const id2 = await makePending(f, {
        agent: "monky",
        kind: "api-key",
        name: "bk-1",
        level: "time-boxed",
        hours: 2,
        envvar: "BK",
        reason: "active revoke",
      });
      await approve(f, id2);
      expect(f.st.credentials.get(id2)!.state).toBe("active");
      await tap(f, id2, "revoke");
      const rev2 = f.auditEvents().filter((e) => e.event === "revoke");
      expect(rev2[rev2.length - 1].from_state).toBe("active");
    } finally {
      f.cleanup();
    }
  }, 15000);
});

// ─── #205: default grant = 30-minute time-box ───────────────────────────────

describe("#205 default grant is a 30-minute time-box", () => {
  test("request without level → time-boxed 30m; card shows the grant; window lapses", async () => {
    const f = mkVault();
    try {
      await f.h.ready;
      const res = await vaultRequest(f.st, {
        agent: "monky",
        kind: "api-key",
        name: "bk-0",
        envvar: "BK",
        reason: "default grant",
      } as any);
      expect(res.ok).toBe(true);
      const id = res.id as string;
      const cred = f.st.credentials.get(id)!;
      expect(cred.level).toBe("time-boxed");
      expect(cred.hours).toBe(0.5);
      // Pending card shows the grant window before the tap.
      const posted = f.fd.channelPosts()[0].body;
      const lf = posted.embeds[0].fields.find((x: any) => x.name === "level");
      expect(String(lf.value)).toBe(
        "time-boxed — grant: 30m from approval (reusable)",
      );
      // Approve arms the window (fixture HOUR_MS=600ms → 300ms window).
      await approve(f, id);
      const c2 = f.st.credentials.get(id)!;
      expect(c2.state).toBe("active");
      expect(c2.expiresAt).toBeGreaterThan(0);
      await tick(450);
      expect(f.st.credentials.get(id)!.state).toBe("expired");
      expect(f.st.credentials.get(id)!.expiredKind).toBe("window");
      expect(
        f
          .auditEvents()
          .some((e) => e.event === "expire" && e.reason === "window"),
      ).toBe(true);
    } finally {
      f.cleanup();
    }
  }, 15000);

  test("explicit permanent → card says permanent; no window armed", async () => {
    const f = mkVault();
    try {
      await f.h.ready;
      const id = await makePending(f, {
        agent: "monky",
        kind: "api-key",
        name: "bk-1",
        level: "permanent",
        envvar: "BK",
        reason: "explicit permanent",
      });
      const posted = f.fd.channelPosts()[0].body;
      const lf = posted.embeds[0].fields.find((x: any) => x.name === "level");
      expect(String(lf.value)).toBe(
        "permanent — grant: permanent (until revoked)",
      );
      await approve(f, id);
      const cred = f.st.credentials.get(id)!;
      expect(cred.state).toBe("active");
      expect(cred.expiresAt).toBeUndefined(); // no window
      const base = f.st.now();
      f.st.now = () => base + 6 * 60_000; // far past any 30m window
      expect(f.st.credentials.get(id)!.state).toBe("active");
    } finally {
      f.cleanup();
    }
  }, 15000);

  test("validateRequestLine: level optional, whole-minute granularity", () => {
    const base = { kind: "api-key", name: "k", envvar: "K", reason: "abc" };
    const dflt = validateRequestLine({ ...base } as any);
    expect(dflt.ok).toBe(true);
    if (dflt.ok) {
      expect(dflt.level).toBe("time-boxed");
      expect(dflt.hours).toBe(0.5);
    }
    const h30 = validateRequestLine({
      ...base,
      level: "time-boxed",
      hours: 0.5,
    } as any);
    expect(h30.ok).toBe(true);
    if (h30.ok) expect(h30.hours).toBe(0.5);
    const h90 = validateRequestLine({
      ...base,
      level: "time-boxed",
      hours: 1.5,
    } as any);
    expect(h90.ok).toBe(true);
    if (h90.ok) expect(h90.hours).toBe(1.5);
    // whole minutes: 1/240 h = 0.25m → rounds to 0 → rejected
    expect(
      validateRequestLine({
        ...base,
        level: "time-boxed",
        hours: 1 / 240,
      } as any).ok,
    ).toBe(false);
    // 72h still the cap; above it rejected
    expect(
      validateRequestLine({
        ...base,
        level: "time-boxed",
        hours: 72,
      } as any).ok,
    ).toBe(true);
    expect(
      validateRequestLine({
        ...base,
        level: "time-boxed",
        hours: 72.02,
      } as any).ok,
    ).toBe(false);
    // omitted level + explicit hours: the hours win
    const oh = validateRequestLine({ ...base, hours: 2 } as any);
    expect(oh.ok).toBe(true);
    if (oh.ok) {
      expect(oh.level).toBe("time-boxed");
      expect(oh.hours).toBe(2);
    }
  });
});

// ─── startup sweep (#208) ─────────────────────────────────────────────────

describe("startup sweep (#208): audit only when something was pruned", () => {
  test("clean boot: no sweep audit line", () => {
    const f = mkVault();
    try {
      expect(f.auditEvents().filter((e) => e.event === "sweep")).toEqual([]);
    } finally {
      f.cleanup();
    }
  });

  test("boot with crash-leftover files: exactly one sweep line (n = count), files pruned", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vault-sweep-"));
    const xdg = path.join(tmp, "xdg");
    const fileDir = path.join(xdg, "jarate-vault");
    fs.mkdirSync(fileDir, { recursive: true });
    fs.writeFileSync(path.join(fileDir, "stale-a"), "x");
    fs.writeFileSync(path.join(fileDir, "stale-b"), "y");
    const f = mkVault({ xdgDir: xdg });
    try {
      const sweeps = f.auditEvents().filter((e) => e.event === "sweep");
      expect(sweeps).toHaveLength(1);
      expect(sweeps[0].n).toBe(2);
      expect(sweeps[0].actor).toBe("system");
      // the leftovers are gone
      expect(fs.readdirSync(fileDir)).toEqual([]);
    } finally {
      f.cleanup();
    }
  });
});

// ─── /vault slash commands (#206, D5) ─────────────────────────────────────

describe("vaultSlash (#206): owner-gated text path", () => {
  test("status: empty vault lists nothing", async () => {
    const f = mkVault();
    try {
      const s = await vaultSlash(f.st, "status", undefined, OWNER, "Owner");
      expect(s.ok).toBe(true);
      expect(s.text).toBe("vault: no pending or active credentials");
    } finally {
      f.cleanup();
    }
  });

  test("status: lists pending + active with id/kind/name/state/created/grant/link", async () => {
    const f = mkVault();
    try {
      const id1 = await makePending(f, {
        agent: "monky",
        kind: "github-pat",
        name: "marzukia/jarate:write",
        level: "one-shot",
        reason: "test status listing",
      });
      const a = await vaultSlash(f.st, "approve", id1, OWNER, "Owner");
      expect(a.ok).toBe(true);
      const id2 = await makePending(f, {
        agent: "monky",
        kind: "api-key",
        name: "window-key",
        level: "time-boxed",
        hours: 2,
        envvar: "TEST_KEY",
        reason: "test status listing",
      });
      const s = await vaultSlash(
        f.st,
        "status",
        undefined,
        OWNER,
        "Owner",
        "guild-1",
      );
      expect(s.ok).toBe(true);
      expect(s.text).toContain("[vault: 1 pending, 1 active]");
      // id (truncated display), kind/name, state
      expect(s.text).toContain(id1.slice(0, 10));
      expect(s.text).toContain(id2.slice(0, 10));
      expect(s.text).toContain("github-pat/marzukia/jarate:write");
      expect(s.text).toContain("api-key/window-key");
      expect(s.text).toMatch(/ {2}active$/m);
      expect(s.text).toMatch(/ {2}pending$/m);
      // created timestamp
      expect(s.text).toMatch(
        /created \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z/,
      );
      // grant window: active one-shot -> claim by; pending time-boxed -> 2h
      expect(s.text).toMatch(/claim by \d{4}-/);
      expect(s.text).toContain("  grant 2h");
      // message link (guild id from the interaction)
      expect(s.text).toContain("https://discord.com/channels/guild-1/999/");
      expect(s.text).toContain(`/${f.st.credentials.get(id1)!.messageId}`);
    } finally {
      f.cleanup();
    }
  });

  test("approve: card edit is byte-identical to a button tap (shared transition)", async () => {
    // Fixture A: owner approves via /vault.
    const fa = mkVault();
    const ida = await makePending(fa);
    const ra = await vaultSlash(fa.st, "approve", ida, OWNER, "Owner");
    expect(ra.ok).toBe(true);
    expect(ra.text).toBe(`[ok] approved ${ida}`);
    expect(fa.st.credentials.get(ida)!.state).toBe("active");
    const evA = fa.auditEvents().find((e) => e.event === "approve");
    expect(evA).toBeDefined();
    expect(evA!.actor).toBe(`slash:${OWNER}`);
    expect(evA!.user).toBe(OWNER);

    // Fixture B: owner approves the same request via the button tap.
    const fb = mkVault();
    const idb = await makePending(fb);
    await approve(fb, idb);
    const evB = fb.auditEvents().find((e) => e.event === "approve");
    expect(evB!.actor).toBe(`discord:${OWNER}`);

    // The card edit payloads match once the per-fixture ids/times are
    // normalized — same embed, same buttons, same content.
    const norm = (body: any, id: string) =>
      JSON.stringify(body)
        .replaceAll(id, "ID")
        .replaceAll(/\d{2}:\d{2}/g, "HHMM");
    const editA = fa.fd.messageEdits().at(-1)!;
    const editB = fb.fd.messageEdits().at(-1)!;
    expect(norm(editA.body, ida)).toBe(norm(editB.body, idb));

    fa.cleanup();
    fb.cleanup();
  });

  test("deny: denied state + audit + card edit", async () => {
    const f = mkVault();
    try {
      const id = await makePending(f);
      const r = await vaultSlash(f.st, "deny", id, OWNER, "Owner");
      expect(r.ok).toBe(true);
      expect(r.text).toBe(`[ok] denied ${id}`);
      const cred = f.st.credentials.get(id)!;
      expect(cred.state).toBe("denied");
      expect(cred.deniedBy).toBe(OWNER);
      const ev = f.auditEvents().find((e) => e.event === "deny");
      expect(ev?.actor).toBe(`slash:${OWNER}`);
      const edits = f.fd.messageEdits();
      expect(edits).toHaveLength(1);
      expect(edits[0].body.content).toBe("denied by Owner");
      expect(JSON.stringify(edits[0].body)).toContain("VAULT denied");
    } finally {
      f.cleanup();
    }
  });

  test("non-owner: visible error + audited, state unchanged", async () => {
    const f = mkVault();
    try {
      const id = await makePending(f);
      const r = await vaultSlash(f.st, "approve", id, OTHER, "Other");
      expect(r.ok).toBe(false);
      expect(r.text).toContain("[!] only the owner can use /vault");
      expect(f.st.credentials.get(id)!.state).toBe("pending");
      const ev = f
        .auditEvents()
        .find((e) => e.event === "slash-rejected" && e.reason === "not-owner");
      expect(ev).toBeDefined();
      expect(ev?.actor).toBe(`slash:${OTHER}`);
    } finally {
      f.cleanup();
    }
  });

  test("unknown id: visible error + audited (not-found)", async () => {
    const f = mkVault();
    try {
      await makePending(f);
      const r = await vaultSlash(
        f.st,
        "approve",
        "vault_deadbeef",
        OWNER,
        "Owner",
      );
      expect(r.ok).toBe(false);
      expect(r.text).toMatch(/no such credential/);
      const ev = f
        .auditEvents()
        .find((e) => e.event === "slash-rejected" && e.reason === "not-found");
      expect(ev).toBeDefined();
    } finally {
      f.cleanup();
    }
  });

  test("ambiguous prefix: error, no state change", async () => {
    const f = mkVault();
    try {
      // Two credentials (one denied, one pending) so the shortest
      // prefix "vault_" matches both — ids are unique per credential.
      const id1 = await makePending(f);
      await vaultSlash(f.st, "deny", id1, OWNER, "Owner");
      const id2 = await makePending(f);
      const r = await vaultSlash(f.st, "approve", "vault_", OWNER, "Owner");
      expect(r.ok).toBe(false);
      expect(r.text).toMatch(/ambiguous/);
      expect(f.st.credentials.get(id2)!.state).toBe("pending");
      const ev = f
        .auditEvents()
        .find(
          (e) => e.event === "slash-rejected" && e.reason === "ambiguous-id",
        );
      expect(ev).toBeDefined();
    } finally {
      f.cleanup();
    }
  });

  test("unique prefix resolves; exact id still works", async () => {
    const f = mkVault();
    try {
      const id = await makePending(f);
      // uuid tail is unique among (the only) credential
      const r = await vaultSlash(f.st, "deny", id.slice(0, 14), OWNER, "Owner");
      expect(r.ok).toBe(true);
      expect(f.st.credentials.get(id)!.state).toBe("denied");
    } finally {
      f.cleanup();
    }
  });

  test("already handled: slash approve on a denied cred is rejected + audited", async () => {
    const f = mkVault();
    try {
      const id = await makePending(f);
      await vaultSlash(f.st, "deny", id, OWNER, "Owner");
      const r = await vaultSlash(f.st, "approve", id, OWNER, "Owner");
      expect(r.ok).toBe(false);
      expect(r.text).toMatch(/already handled/);
      expect(f.st.credentials.get(id)!.state).toBe("denied");
      const ev = f
        .auditEvents()
        .find(
          (e) => e.event === "slash-rejected" && e.reason === "already-handled",
        );
      expect(ev).toBeDefined();
      expect(ev?.state).toBe("denied");
    } finally {
      f.cleanup();
    }
  });

  test("ping: re-announces in the channel, referencing the card", async () => {
    const f = mkVault();
    try {
      const id = await makePending(f);
      const cred = f.st.credentials.get(id)!;
      const r = await vaultSlash(f.st, "ping", id, OWNER, "Owner");
      expect(r.ok).toBe(true);
      expect(r.text).toMatch(/\[ok\] pinged/);
      const posts = f.fd.channelPosts();
      const ping = posts.find((p) =>
        String(p.body?.content ?? "").includes(id),
      );
      expect(ping).toBeDefined();
      expect(ping!.body.message_reference.message_id).toBe(cred.messageId);
      expect(ping!.body.content).toContain(`/vault approve ${id}`);
      const ev = f.auditEvents().find((e) => e.event === "slash-ping");
      expect(ev).toBeDefined();
      expect(ev?.actor).toBe(`slash:${OWNER}`);
    } finally {
      f.cleanup();
    }
  });

  test("usage: unknown action gets a usage line", async () => {
    const f = mkVault();
    try {
      const s = await vaultSlash(f.st, "bogus", undefined, OWNER, "Owner");
      expect(s.ok).toBe(false);
      expect(s.text).toMatch(/usage: \/vault/);
    } finally {
      f.cleanup();
    }
  });
});
