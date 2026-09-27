/**
 * PAT vault tests — design v4 §12 (packages/bridge/channel).
 *
 * Harness:
 *  - FakeDiscord: a fetch stub that ENFORCES Discord's one-callback rule —
 *    a second POST to /interactions/{id}/{token}/callback for the same
 *    d.id is a 400 "unknown interaction" (asserted, not ignored).
 *  - All vault timers use REAL clocks with env-shortened constants
 *    (TTL 1.2s, claim 0.8s, censor grace 0.2s); impractical windows
 *    (budget hour) are driven by manipulating approvals timestamps.
 *  - Sockets bind under a mkdtemp XDG dir — no box state touched.
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
import { egressText } from "./discord";
import { buildInteractionHandler } from "./index";
import {
  __patVaultResetForTest,
  knownScopes,
  type PatVaultHandle,
  type PatVaultState,
  patRequest,
  patRunBegin,
  patStatus,
  startPatVault,
  stopPatVault,
} from "./pat-vault";

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
  postStatus = 200; // status for POST /channels/.../messages
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
        if (this.postStatus !== 200)
          return resp(this.postStatus, { message: "stubbed" });
        return resp(200, { id: `msg-${++this.msgSeq}` });
      }
      if (
        method === "POST" &&
        url.includes("/webhooks/") &&
        url.includes("messages?wait=true")
      ) {
        return resp(200, { id: "followup" });
      }
      if (method === "PATCH" && url.includes("/messages/"))
        return resp(204, null);
      if (method === "DELETE") return resp(204, null);
      return resp(200, {});
    }) as any;
  }

  /** Followups posted on the interaction webhook (post-defer replies). */
  followups(): Array<{ url: string; body: any }> {
    return this.calls
      .filter(
        (c) =>
          c.method === "POST" &&
          c.url.includes("/webhooks/") &&
          c.url.includes("messages?wait=true"),
      )
      .map((c) => ({ url: c.url, body: c.body }));
  }

  ackDeletes(): number {
    return this.calls.filter(
      (c) => c.method === "DELETE" && c.url.endsWith("/messages/@original"),
    ).length;
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
    return this.calls.filter(
      (c) => c.method === "PATCH" && c.url.includes("/messages/"),
    );
  }
}

// ─── fixtures ──────────────────────────────────────────────────────────────

const OWNER = "108801968763305984";
const OTHER = "215356028869541889";
const FINE_TOKEN = `github_pat_${"f".repeat(30)}`;
const CLASSIC_TOKEN = `ghp_${"c".repeat(36)}`;

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface VaultFix {
  h: PatVaultHandle;
  st: PatVaultState;
  fd: FakeDiscord;
  tmp: string;
  ch: any;
  xdg: string;
  patsDir: string;
  defaultPatFile: string;
  auditLines: () => string[];
  cleanup: () => void;
}

function mkVault(
  over: {
    transport?: "socket" | "file";
    ch?: any;
    secrets?: {
      register?: (l: string[]) => void;
      drop?: (l: string[]) => void;
    };
    stateDir?: string;
    xdgDir?: string;
  } = {},
): VaultFix {
  const tmp = over.xdgDir
    ? path.join(over.xdgDir, "..")
    : fs.mkdtempSync(path.join(os.tmpdir(), "pat-vault-"));
  const xdg = over.xdgDir ?? path.join(tmp, "xdg");
  const patsDir = path.join(tmp, "pats");
  fs.mkdirSync(path.join(patsDir, "marzukia"), { recursive: true });
  fs.writeFileSync(
    path.join(patsDir, "marzukia", "jarate:write"),
    `${FINE_TOKEN}\n`,
    {
      mode: 0o600,
    },
  );
  const defaultPatFile = path.join(tmp, "marzukia-pat");
  fs.writeFileSync(defaultPatFile, `${CLASSIC_TOKEN}\n`, { mode: 0o600 });

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

  const h = startPatVault({
    ch,
    botToken: ch.botToken,
    stateDir: over.stateDir ?? path.join(tmp, "state"),
    xdgDir: xdg,
    patsDir,
    defaultPatFile,
    auditFile: path.join(tmp, "audit", "pat-audit.log"),
    transport: over.transport ?? "socket",
    secrets: over.secrets as any,
  });
  const auditPath = path.join(tmp, "audit", "pat-audit.log");
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
    patsDir,
    defaultPatFile,
    auditLines: () =>
      fs.existsSync(auditPath)
        ? fs.readFileSync(auditPath, "utf-8").trim().split("\n")
        : [],
    cleanup: () => {
      stopPatVault(h);
      globalThis.fetch = realFetch;
      clearRegistryCache();
      __patVaultResetForTest();
      fs.rmSync(tmp, { recursive: true, force: true });
    },
  };
}

const realFetch = globalThis.fetch;

function mkD(
  id: string,
  customId: string,
  over: Record<string, any> = {},
): any {
  return {
    type: 4,
    id,
    token: `intok-${id}`,
    application_id: "app1",
    channel_id: "999",
    message_id: "",
    data: { custom_id: customId },
    user: { id: OWNER, username: "Owner" },
    ...over,
  };
}

/** Create a pending request (as the socket `request` op would). */
async function makePending(
  f: VaultFix,
  scope = "marzukia/jarate:write",
  agent = "monky",
  reason = "open PR for #41",
): Promise<any> {
  const r = await patRequest(f.st, { agent, scope, reason });
  if (!r.ok) throw new Error(`patRequest failed: ${r.error}`);
  return f.st.requests.get(r.id as string)!;
}

/** Socket client against the fixture's pat.sock. */
class VaultClient {
  sock: net.Socket;
  /** Everything received, verbatim (wire audit — the token must appear
   *  here at most once). */
  raw = "";
  private buf = "";
  private lineResolvers: Array<(line: string) => void> = [];
  /** Lines that arrived before a nextLine() call (no requeue in buf —
   *  that would spin the data handler forever and starve the loop). */
  private queued: string[] = [];
  private closed = false;

  constructor(xdg: string) {
    this.sock = net.connect(path.join(xdg, "jarate", "pat.sock"));
    this.sock.on("data", (d: Buffer) => this.onData(d));
    this.sock.on("close", () => {
      this.closed = true;
      for (const r of this.lineResolvers.splice(0)) r("");
    });
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
      const q = this.queued.shift();
      if (q !== undefined) return res(q);
      const t = setTimeout(() => rej(new Error("client: timeout")), timeoutMs);
      this.lineResolvers.push((line) => {
        clearTimeout(t);
        res(line);
      });
      if (this.closed) rej(new Error("client: closed"));
    });
  }

  close(): void {
    this.sock.end();
  }

  destroy(): void {
    this.sock.destroy();
  }
}

const fileDirOf = (f: VaultFix) => path.join(f.xdg, "jarate-pat");

/** One-op-per-connection socket RPC (the wrapper convention). */
async function rpc(f: VaultFix, obj: Record<string, unknown>): Promise<any> {
  const c = new VaultClient(f.xdg);
  await c.connect();
  c.send(obj);
  const line = await c.nextLine();
  c.close();
  return JSON.parse(line);
}

let savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  savedEnv = {};
  for (const k of [
    "JARATE_PAT_TTL_MS",
    "JARATE_PAT_CLAIM_MS",
    "JARATE_PAT_CENSOR_GRACE_MS",
    "JARATE_PAT_BUDGET_PER_HOUR",
    "JARATE_PAT_MAX_PENDING",
    "JARATE_PAT_SEEN_CAP",
    "JARATE_SECRETS_FILE",
  ]) {
    savedEnv[k] = process.env[k];
  }
  process.env.JARATE_PAT_TTL_MS = "1200";
  process.env.JARATE_PAT_CLAIM_MS = "800";
  process.env.JARATE_PAT_CENSOR_GRACE_MS = "200";
  process.env.JARATE_PAT_BUDGET_PER_HOUR = "5";
  process.env.JARATE_PAT_MAX_PENDING = "1";
  process.env.JARATE_PAT_SEEN_CAP = "500";
  // Isolate the censor registry from the box's real secrets file.
  process.env.JARATE_SECRETS_FILE = path.join(
    os.tmpdir(),
    `pv-secrets-${Date.now()}`,
  );
  clearRegistryCache();
  clearRuntimeSecrets();
});

afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  __patVaultResetForTest();
  clearRegistryCache();
});

// ─── interaction semantics (N1) ─────────────────────────────────────────────

describe("one-callback discipline", () => {
  test("approve: exactly one callback POST, reply on webhook, ack cleared", async () => {
    const f = mkVault();
    try {
      const req = await makePending(f);
      await f.h.handlePatComponent(
        mkD("i-app", `pat:approve:${req.id}`, { message_id: req.messageId }),
      );
      // Exactly one callback POST for this interaction (the defer).
      const cb = f.fd.callbacksFor("i-app");
      expect(cb).toBe(1);
      expect(f.fd.callbackSpent.has("i-app")).toBe(true);
      // The approved edit carries components: [] and the approved text.
      const edits = f.fd.messageEdits();
      expect(edits.length).toBe(1);
      expect(edits[0].body.components).toEqual([]);
      expect(edits[0].body.content).toContain("[ok] PAT approved");
      expect(edits[0].body.content).toContain(req.id);
      // No followup needed on success, but the Thinking ack must be gone.
      expect(f.fd.followups().length).toBe(0);
      expect(f.fd.ackDeletes()).toBe(1);
      // State.
      expect(f.st.requests.get(req.id)!.state).toBe("approved");
      expect(f.st.requests.get(req.id)!.claimDeadline).toBeGreaterThan(
        Date.now(),
      );
    } finally {
      f.cleanup();
    }
  });

  test("not-found: ephemeral followup on webhook URL, ack cleared, no state", async () => {
    const f = mkVault();
    try {
      await f.h.handlePatComponent(
        mkD("i-nf", "pat:approve:pat_00000000-0000-0000-0000-000000000000", {
          message_id: "x",
        }),
      );
      expect(f.fd.callbacksFor("i-nf")).toBe(1);
      const fu = f.fd.followups();
      expect(fu.length).toBe(1);
      expect(fu[0].url).toBe(
        "https://discord.com/api/v10/webhooks/app1/intok-i-nf/messages?wait=true",
      );
      expect(fu[0].body.content).toBe(
        "[!] request not found or already handled",
      );
      expect(fu[0].body.flags).toBe(64);
      expect(f.fd.ackDeletes()).toBe(1);
      expect(f.fd.messageEdits().length).toBe(0);
    } finally {
      f.cleanup();
    }
  });

  test("non-owner tap: ephemeral refusal, state untouched, audit", async () => {
    const f = mkVault();
    try {
      const req = await makePending(f);
      await f.h.handlePatComponent(
        mkD("i-no", `pat:approve:${req.id}`, {
          message_id: req.messageId,
          user: { id: OTHER, username: "Other" },
        }),
      );
      const fu = f.fd.followups();
      expect(fu.length).toBe(1);
      expect(fu[0].body.content).toBe(
        "[!] only the owner can approve PAT requests",
      );
      expect(fu[0].body.flags).toBe(64);
      expect(f.fd.ackDeletes()).toBe(1);
      expect(f.st.requests.get(req.id)!.state).toBe("pending");
      expect(
        f.auditLines().some((l) => l.includes("event=non-owner-tap")),
      ).toBe(true);
    } finally {
      f.cleanup();
    }
  });

  test("stale copy: message_id mismatch -> no transition", async () => {
    const f = mkVault();
    try {
      const req = await makePending(f);
      await f.h.handlePatComponent(
        mkD("i-sc", `pat:approve:${req.id}`, { message_id: "other-message" }),
      );
      const fu = f.fd.followups();
      expect(fu.length).toBe(1);
      expect(fu[0].body.content).toBe(
        "[!] request not found or already handled",
      );
      expect(f.st.requests.get(req.id)!.state).toBe("pending");
    } finally {
      f.cleanup();
    }
  });

  test("channel mismatch: channel_id mismatch -> no transition", async () => {
    const f = mkVault();
    try {
      const req = await makePending(f);
      await f.h.handlePatComponent(
        mkD("i-cm", `pat:approve:${req.id}`, {
          message_id: req.messageId,
          channel_id: "888",
        }),
      );
      expect(f.st.requests.get(req.id)!.state).toBe("pending");
      expect(f.fd.followups()[0].body.content).toBe(
        "[!] request not found or already handled",
      );
    } finally {
      f.cleanup();
    }
  });

  test("deny: edit + components off, ack cleared, audit", async () => {
    const f = mkVault();
    try {
      const req = await makePending(f);
      await f.h.handlePatComponent(
        mkD("i-dn", `pat:deny:${req.id}`, { message_id: req.messageId }),
      );
      const edits = f.fd.messageEdits();
      expect(edits.length).toBe(1);
      expect(edits[0].body.components).toEqual([]);
      expect(edits[0].body.content).toContain("[denied] PAT request");
      expect(edits[0].body.content).toContain("Owner");
      expect(f.st.requests.get(req.id)!.state).toBe("denied");
      expect(f.st.requests.get(req.id)!.deniedBy).toBe(OWNER);
      expect(f.fd.ackDeletes()).toBe(1);
      expect(f.auditLines().some((l) => l.includes("event=deny"))).toBe(true);
    } finally {
      f.cleanup();
    }
  });

  test("tap after deny -> already handled, no double edit", async () => {
    const f = mkVault();
    try {
      const req = await makePending(f);
      await f.h.handlePatComponent(
        mkD("i-d1", `pat:deny:${req.id}`, { message_id: req.messageId }),
      );
      const editsAfterDeny = f.fd.messageEdits().length;
      await f.h.handlePatComponent(
        mkD("i-d2", `pat:approve:${req.id}`, { message_id: req.messageId }),
      );
      const fu = f.fd.followups();
      expect(fu.length).toBe(1);
      expect(fu[0].body.content).toBe("[!] already handled");
      expect(f.fd.messageEdits().length).toBe(editsAfterDeny);
      expect(f.st.requests.get(req.id)!.state).toBe("denied");
    } finally {
      f.cleanup();
    }
  });

  test("dedupe: same d.id twice -> second ignored", async () => {
    const f = mkVault();
    try {
      const req = await makePending(f);
      const d = mkD("i-dd", `pat:deny:${req.id}`, {
        message_id: req.messageId,
      });
      await f.h.handlePatComponent(d);
      const denies1 = f
        .auditLines()
        .filter((l) => l.includes("event=deny")).length;
      await f.h.handlePatComponent(d); // redelivery
      const denies2 = f
        .auditLines()
        .filter((l) => l.includes("event=deny")).length;
      expect(denies2).toBe(denies1);
      // The second defer POST 400s (callback spent) — swallowed, no crash.
      expect(f.fd.callbacksFor("i-dd")).toBe(2);
    } finally {
      f.cleanup();
    }
  });

  test("non-matching custom_id: no defer, no callback, nothing touched", async () => {
    const f = mkVault();
    try {
      const req = await makePending(f);
      const callsBefore = f.fd.calls.length;
      await f.h.handlePatComponent(
        mkD("i-nm", `other:button:${req.id}`, { message_id: req.messageId }),
      );
      expect(f.fd.calls.length).toBe(callsBefore);
      expect(f.st.requests.get(req.id)!.state).toBe("pending");
      // Also: a matching id but non-vault prefix.
      await f.h.handlePatComponent(
        mkD("i-nm2", `pat:approve:wrong_format`, { message_id: req.messageId }),
      );
      expect(f.fd.calls.length).toBe(callsBefore);
    } finally {
      f.cleanup();
    }
  });
});

// ─── state machine & gates (F1, F4, F5) ─────────────────────────────────────

describe("state machine", () => {
  test("full happy path: request -> approve -> run -> done -> censor drop", async () => {
    const f = mkVault();
    try {
      await f.h.ready;
      // Request post shape.
      const req = await makePending(f, "marzukia/jarate:write");
      const posts = f.fd.channelPosts();
      expect(posts.length).toBe(1);
      const posted = posts[0].body;
      expect(posted.content).toContain("[pending] PAT request — monky");
      expect(posted.content).toContain("scope: marzukia/jarate:write");
      expect(posted.content).toContain("reason: open PR for #41");
      expect(posted.content).toContain("[ Approve ] [ Deny ]");
      const btns = posted.components[0].components;
      expect(btns).toHaveLength(2);
      expect(btns[0]).toEqual({
        type: 2,
        style: 1,
        label: "Approve",
        custom_id: `pat:approve:${req.id}`,
      });
      expect(btns[1].custom_id).toBe(`pat:deny:${req.id}`);
      expect(btns[1].style).toBe(4);

      // Approve.
      await f.h.handlePatComponent(
        mkD("i-h", `pat:approve:${req.id}`, { message_id: req.messageId }),
      );
      expect(f.st.requests.get(req.id)!.state).toBe("approved");

      // Run over the socket: token line, child rc, done.
      const c = new VaultClient(f.xdg);
      await c.connect();
      c.send({
        op: "run",
        id: req.id,
        agent: "monky",
        cmd: ["gh", "pr", "create", "--fill"],
        timeout_s: 900,
      });
      const reply = JSON.parse(await c.nextLine());
      expect(reply.v).toBe(1);
      expect(reply.ok).toBe(true);
      expect(reply.token).toBe(FINE_TOKEN);
      expect(reply.kind).toBe("fine");
      // Single use by construction (fresh connection — one op per conn).
      const reuse = await rpc(f, {
        op: "run",
        id: req.id,
        cmd: ["true"],
        timeout_s: 10,
      });
      expect(reuse.ok).toBe(false);
      expect(reuse.error).toBe("state: already used");
      // Censor: the token is registered now.
      expect(getRuntimeSecrets()).toContain(FINE_TOKEN);
      expect(egressText(`use ${FINE_TOKEN} now`)).toContain("[REDACTED");
      // done.
      c.send({ op: "done", id: req.id, rc: 0 });
      const doneReply = JSON.parse(await c.nextLine());
      expect(doneReply.ok).toBe(true);
      c.close();
      expect(f.st.requests.get(req.id)!.state).toBe("handed-off");
      expect(f.st.requests.get(req.id)!.runRc).toBe(0);
      expect(f.auditLines().some((l) => l.includes("event=done rc=0"))).toBe(
        true,
      );
      expect(
        f.auditLines().some((l) => l.includes("event=handoff kind=fine")),
      ).toBe(true);
      // Token line was the only place the token crossed the wire.
      const onWire = c.raw.split("\n").filter((l) => l.includes(FINE_TOKEN));
      expect(onWire).toHaveLength(1);
      // Censor drop after the grace (200ms).
      await tick(350);
      expect(getRuntimeSecrets()).not.toContain(FINE_TOKEN);
      // Backstop: the github pattern still redacts after the drop.
      expect(egressText(`use ${FINE_TOKEN} now`)).toBe(
        "use [REDACTED:github] now",
      );
    } finally {
      f.cleanup();
    }
  });

  test("classic token (default scope) handoff", async () => {
    const f = mkVault();
    try {
      await f.h.ready;
      const req = await makePending(f, "default");
      await f.h.handlePatComponent(
        mkD("i-cl", `pat:approve:${req.id}`, { message_id: req.messageId }),
      );
      const c = new VaultClient(f.xdg);
      await c.connect();
      c.send({
        op: "run",
        id: req.id,
        agent: "monky",
        cmd: ["gh", "api", "user"],
        timeout_s: 10,
      });
      const reply = JSON.parse(await c.nextLine());
      expect(reply.ok).toBe(true);
      expect(reply.token).toBe(CLASSIC_TOKEN);
      expect(reply.kind).toBe("classic");
      c.close();
    } finally {
      f.cleanup();
    }
  });

  test("TTL: pending -> expired(ttl) with edit + components off + audit", async () => {
    const f = mkVault();
    try {
      const req = await makePending(f);
      await tick(1400); // TTL 1200ms
      expect(f.st.requests.get(req.id)!.state).toBe("expired");
      expect(f.st.requests.get(req.id)!.expiredKind).toBe("ttl");
      const edits = f.fd.messageEdits();
      expect(edits.length).toBe(1);
      expect(edits[0].body.components).toEqual([]);
      expect(edits[0].body.content).toContain("[expired] PAT request");
      expect(f.auditLines().some((l) => l.includes("event=expire-ttl"))).toBe(
        true,
      );
    } finally {
      f.cleanup();
    }
  });

  test("claim: approved with no run -> expired(claim), file unlinked (file mode)", async () => {
    const f = mkVault({ transport: "file" });
    try {
      const req = await makePending(f);
      await f.h.handlePatComponent(
        mkD("i-cc", `pat:approve:${req.id}`, { message_id: req.messageId }),
      );
      const pub = path.join(fileDirOf(f), `pat-${req.id}`);
      expect(fs.existsSync(pub)).toBe(true);
      await tick(1000); // claim 800ms
      expect(f.st.requests.get(req.id)!.state).toBe("expired");
      expect(f.st.requests.get(req.id)!.expiredKind).toBe("claim");
      expect(fs.existsSync(pub)).toBe(false);
      expect(f.auditLines().some((l) => l.includes("event=expire-claim"))).toBe(
        true,
      );
    } finally {
      f.cleanup();
    }
  });

  test("budget: 5 approvals in the rolling hour -> reject with next slot", async () => {
    const f = mkVault();
    try {
      const now = f.st.now();
      f.st.approvals.monky = [
        now - 1000,
        now - 2000,
        now - 3000,
        now - 4000,
        now - 5000,
      ];
      const r = await patRequest(f.st, {
        agent: "monky",
        scope: "default",
        reason: "over budget",
      });
      expect(r.ok).toBe(false);
      expect(r.error).toContain("budget: 5 approvals in last hour; next slot");
      expect(
        f.auditLines().some((l) => l.includes("event=budget-reject")),
      ).toBe(true);
      // Nothing posted.
      expect(f.fd.channelPosts().length).toBe(0);
      // Timestamps older than 1h stop counting.
      f.st.approvals.monky = Array.from(
        { length: 5 },
        (_, i) => now - 3_700_000 - i * 1000,
      );
      const r2 = await patRequest(f.st, {
        agent: "monky",
        scope: "default",
        reason: "hour rolled",
      });
      expect(r2.ok).toBe(true);
      f.st.requests.delete(String(r2.id)); // keep the pending slot clean
    } finally {
      f.cleanup();
    }
  });

  test("budget never blocks an existing pending approve tap", async () => {
    const f = mkVault();
    try {
      const req = await makePending(f);
      const now = f.st.now();
      f.st.approvals.monky = Array.from(
        { length: 5 },
        (_, i) => now - 1000 - i * 1000,
      );
      // A pending request can still be approved (the deliberate tap wins).
      await f.h.handlePatComponent(
        mkD("i-bt", `pat:approve:${req.id}`, { message_id: req.messageId }),
      );
      expect(f.st.requests.get(req.id)!.state).toBe("approved");
    } finally {
      f.cleanup();
    }
  });

  test("1-pending: second request while one is pending -> pending error", async () => {
    const f = mkVault();
    try {
      const req = await makePending(f);
      const r = await patRequest(f.st, {
        agent: "monky",
        scope: "default",
        reason: "second one",
      });
      expect(r.ok).toBe(false);
      expect(r.error).toContain(`pending: ${req.id}`);
      expect(
        f.auditLines().some((l) => l.includes("event=pending-reject")),
      ).toBe(true);
      // A different agent is unaffected.
      const r2 = await patRequest(f.st, {
        agent: "frank",
        scope: "default",
        reason: "other agent",
      });
      expect(r2.ok).toBe(true);
      f.st.requests.delete(String(r2.id));
    } finally {
      f.cleanup();
    }
  });

  test("unknown scope + grammar: rejected before any post, traversal kept out", async () => {
    const f = mkVault();
    try {
      const bad = ["x/y:zap", "a//b:read", "a/b:zap", "../x:read", "a:b:read"];
      for (const scope of bad) {
        const r = await patRequest(f.st, {
          agent: "monky",
          scope,
          reason: "scope test",
        });
        expect(r.ok, scope).toBe(false);
        expect(r.error, scope).toContain("scope: unknown");
      }
      expect(
        f.auditLines().filter((l) => l.includes("event=scope-reject")).length,
      ).toBe(bad.length);
      expect(f.fd.channelPosts().length).toBe(0);
      // The known list matches the pats dir listing.
      expect(knownScopes(f.st).sort()).toEqual(
        ["default", "marzukia/jarate:write"].sort(),
      );
      // A nested pats dir file shows up as a scope.
      fs.mkdirSync(path.join(f.patsDir, "org2"), { recursive: true });
      fs.writeFileSync(
        path.join(f.patsDir, "org2", "repo2:read"),
        `${FINE_TOKEN}\n`,
      );
      expect(knownScopes(f.st)).toContain("org2/repo2:read");
    } finally {
      f.cleanup();
    }
  });

  test("POST fails after registration: unregistered, post-fail audit, retry ok (N6)", async () => {
    const f = mkVault();
    try {
      f.fd.postStatus = 429; // discordFetch retries 3x with tiny waits
      const r = await patRequest(f.st, {
        agent: "monky",
        scope: "default",
        reason: "rate limited",
      });
      expect(r.ok).toBe(false);
      expect(r.error).toContain("post failed:");
      expect(f.st.requests.size).toBe(0);
      expect(f.auditLines().some((l) => l.includes("event=post-fail"))).toBe(
        true,
      );
      // Retry is safe: nothing was posted, budget/pending not consumed.
      f.fd.postStatus = 200;
      const r2 = await patRequest(f.st, {
        agent: "monky",
        scope: "default",
        reason: "retry works",
      });
      expect(r2.ok).toBe(true);
    } finally {
      f.cleanup();
    }
  });

  test("no-owner channel: warn + audit + still posts; tap is non-owner (N6)", async () => {
    const ch = {
      id: "ch-no",
      name: "ch-no",
      type: "discord",
      channel: "777",
      botToken: "tok-no",
    } as any;
    const f = mkVault({ ch });
    try {
      const r = await patRequest(f.st, {
        agent: "monky",
        scope: "default",
        reason: "no owner here",
      });
      expect(r.ok).toBe(true);
      expect(f.fd.channelPosts().length).toBe(1);
      expect(f.auditLines().some((l) => l.includes("event=no-owner"))).toBe(
        true,
      );
      const req = f.st.requests.get(r.id as string)!;
      await f.h.handlePatComponent(
        mkD("i-wn", `pat:approve:${req.id}`, {
          message_id: req.messageId,
          channel_id: "777",
        }),
      );
      const fu = f.fd.followups();
      expect(fu.length).toBe(1);
      expect(fu[0].body.content).toBe(
        "[!] only the owner can approve PAT requests",
      );
      expect(f.st.requests.get(req.id)!.state).toBe("pending");
    } finally {
      f.cleanup();
    }
  });
});

// ─── robustness (M1, L4) ────────────────────────────────────────────────────

describe("robustness", () => {
  test("handlePatComponent never rejects: internal throw (M1)", async () => {
    const rejections: unknown[] = [];
    const sink = (e: unknown) => rejections.push(e);
    process.on("unhandledRejection", sink);
    try {
      const f = mkVault({
        transport: "file",
        secrets: {
          register: () => {
            throw new Error("censor boom");
          },
          drop: () => {},
        },
      });
      try {
        const req = await makePending(f);
        // Must RESOLVE, not reject.
        await f.h.handlePatComponent(
          mkD("i-m1", `pat:approve:${req.id}`, { message_id: req.messageId }),
        );
        // Named case: the throw happened AFTER the read (token file present),
        // so the generic catch path ran: [!] vault error, state stays pending.
        const fu = f.fd.followups();
        expect(fu.length).toBe(1);
        expect(fu[0].body.content).toBe("[!] vault error");
        expect(fu[0].body.flags).toBe(64);
        expect(f.fd.ackDeletes()).toBe(1);
        expect(f.st.requests.get(req.id)!.state).toBe("pending");
        expect(
          f.auditLines().some((l) => l.includes("event=vault-error")),
        ).toBe(true);
        // No published file, no censor registration.
        expect(fs.existsSync(path.join(fileDirOf(f), `pat-${req.id}`))).toBe(
          false,
        );
        expect(getRuntimeSecrets()).not.toContain(FINE_TOKEN);
      } finally {
        f.cleanup();
      }
      await tick(50);
      expect(rejections).toHaveLength(0);
    } finally {
      process.off("unhandledRejection", sink);
    }
  });

  test("file-mode approve with missing token file (M1): stays pending, specific message", async () => {
    const f = mkVault({ transport: "file" });
    try {
      const req = await makePending(f, "marzukia/jarate:write");
      fs.unlinkSync(path.join(f.patsDir, "marzukia", "jarate:write"));
      await f.h.handlePatComponent(
        mkD("i-mf", `pat:approve:${req.id}`, { message_id: req.messageId }),
      );
      const fu = f.fd.followups();
      expect(fu.length).toBe(1);
      expect(fu[0].body.content).toBe("[!] token file missing");
      expect(fu[0].body.flags).toBe(64);
      // No transition, no publish, no censor registration.
      expect(f.st.requests.get(req.id)!.state).toBe("pending");
      expect(f.st.requests.get(req.id)!.approvedAt).toBeUndefined();
      expect(fs.existsSync(path.join(fileDirOf(f), `pat-${req.id}`))).toBe(
        false,
      );
      expect(getRuntimeSecrets()).not.toContain(FINE_TOKEN);
      expect(
        f
          .auditLines()
          .some(
            (l) =>
              l.includes("event=vault-error") &&
              l.includes("err=token file missing"),
          ),
      ).toBe(true);
      expect(f.fd.ackDeletes()).toBe(1);
      // Restore the file, re-tap within the TTL -> normal approve.
      fs.writeFileSync(
        path.join(f.patsDir, "marzukia", "jarate:write"),
        `${FINE_TOKEN}\n`,
        {
          mode: 0o600,
        },
      );
      await f.h.handlePatComponent(
        mkD("i-mf2", `pat:approve:${req.id}`, { message_id: req.messageId }),
      );
      expect(f.st.requests.get(req.id)!.state).toBe("approved");
      expect(fs.existsSync(path.join(fileDirOf(f), `pat-${req.id}`))).toBe(
        true,
      );
    } finally {
      f.cleanup();
    }
  });

  test("dispatch-line .catch backstop: a rejecting vaultRef is logged, not fatal (M1)", async () => {
    const rejections: unknown[] = [];
    const sink = (e: unknown) => rejections.push(e);
    process.on("unhandledRejection", sink);
    try {
      const badRef = {
        handlePatComponent: async () => {
          throw new Error("vault handler exploded");
        },
      };
      const ch = {
        id: "ch-d",
        name: "ch-d",
        type: "discord",
        channel: "999",
        botToken: "tok-d",
        ownerUserId: OWNER,
      } as any;
      const handler = buildInteractionHandler(
        {} as any,
        {} as any,
        ch,
        "tok-d",
        badRef,
      );
      await handler(
        mkD("i-dc", "pat:approve:pat_11111111-2222-3333-4444-555555555555"),
      );
      await tick(50);
      expect(rejections).toHaveLength(0);
    } finally {
      process.off("unhandledRejection", sink);
    }
  });

  test("once-per-process: second instance shares state + server, no re-sweep (L4)", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pat-l4-"));
    const xdg = path.join(tmp, "xdg");
    const patsDir = path.join(tmp, "pats");
    fs.mkdirSync(patsDir, { recursive: true });
    const defaultPatFile = path.join(tmp, "marzukia-pat");
    fs.writeFileSync(defaultPatFile, `${CLASSIC_TOKEN}\n`, { mode: 0o600 });
    const opts = {
      stateDir: path.join(tmp, "state"),
      xdgDir: xdg,
      patsDir,
      defaultPatFile,
      auditFile: path.join(tmp, "audit", "pat-audit.log"),
      transport: "socket" as const,
    };
    const ch1 = {
      id: "ch1",
      name: "ch1",
      type: "discord",
      channel: "999",
      botToken: "tok-1",
      ownerUserId: OWNER,
    } as any;
    const ch2 = { ...ch1, id: "ch2", channel: "888", botToken: "tok-2" } as any;
    const fd = new FakeDiscord();
    fd.install();
    try {
      const h1 = startPatVault({ ...opts, ch: ch1, botToken: ch1.botToken });
      await h1.ready;
      // Plant a stale file AFTER the first sweep.
      const fileDir = path.join(xdg, "jarate-pat");
      fs.mkdirSync(fileDir, { recursive: true });
      fs.writeFileSync(path.join(fileDir, "pat-stale"), `${CLASSIC_TOKEN}\n`, {
        mode: 0o600,
      });
      const server1 = h1.vault.server;
      const h2 = startPatVault({ ...opts, ch: ch2, botToken: ch2.botToken });
      await h2.ready;
      // Shared state + server; no re-sweep.
      expect(h2.vault).toBe(h1.vault);
      expect(h2.vault.server).toBe(server1);
      expect(fs.existsSync(path.join(fileDir, "pat-stale"))).toBe(true);
      // Stop instance 1: the server stays up (refs 1).
      stopPatVault(h1);
      expect(h1.vault.server).toBe(server1);
      expect(h1.vault.stopped).toBe(false);
      // Stop instance 2: the last stop closes + persists.
      stopPatVault(h2);
      expect(h1.vault.server).toBeNull();
      expect(fs.existsSync(path.join(opts.stateDir, "pat-vault.json"))).toBe(
        true,
      );
    } finally {
      __patVaultResetForTest();
      globalThis.fetch = realFetch;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// ─── transport (F2, F3, N4, N5, N6) ─────────────────────────────────────────

describe("socket protocol", () => {
  test("every documented error line", async () => {
    const f = mkVault();
    try {
      await f.h.ready;

      // unknown op
      let r = await rpc(f, { op: "bogus" });
      expect(r.error).toBe("usage: unknown op");

      // status: unknown id
      r = await rpc(f, { op: "status", id: "pat_nope" });
      expect(r.ok).toBe(false);
      expect(r.error).toBe("unknown id");

      // run: unknown id
      r = await rpc(f, {
        op: "run",
        id: "pat_nope",
        cmd: ["true"],
        timeout_s: 10,
      });
      expect(r.error).toBe("unknown id");

      // status by agent: budget view, no tokens anywhere
      r = await rpc(f, { op: "status", agent: "monky" });
      expect(r.ok).toBe(true);
      expect(r.pending).toEqual([]);
      expect(r.budget).toEqual({ approvals_last_hour: 0, cap: 5 });
    } finally {
      f.cleanup();
    }
  });

  test("cmd + timeout_s validation (N6 clamp)", async () => {
    const f = mkVault();
    try {
      await f.h.ready;
      const req = await makePending(f);
      const run = (over: Record<string, unknown>) =>
        rpc(f, {
          op: "run",
          id: req.id,
          agent: "monky",
          cmd: ["true"],
          timeout_s: 10,
          ...over,
        });
      let r = await run({ cmd: [] });
      expect(r.error).toBe(
        "usage: cmd must be 1-200 strings (each <=4096 chars)",
      );
      r = await run({ cmd: new Array(201).fill("a") });
      expect(r.error).toBe(
        "usage: cmd must be 1-200 strings (each <=4096 chars)",
      );
      r = await run({ cmd: ["x".repeat(5000)] });
      expect(r.error).toBe(
        "usage: cmd must be 1-200 strings (each <=4096 chars)",
      );
      r = await run({ timeout_s: 0 });
      expect(r.error).toBe("usage: timeout_s must be 1-3600");
      r = await run({ timeout_s: 3601 });
      expect(r.error).toBe("usage: timeout_s must be 1-3600");
      // 3600 accepted: pending state errors, but validation passed.
      r = await run({ timeout_s: 3600 });
      expect(r.error).toBe("state: pending (awaiting approval)");
      // 4096-char arg accepted.
      r = await run({ cmd: ["x".repeat(4096)] });
      expect(r.error).toBe("state: pending (awaiting approval)");
    } finally {
      f.cleanup();
    }
  });

  test("1 MB line cap: conforming max run line accepted, >1 MB rejected (N6)", async () => {
    const f = mkVault();
    try {
      await f.h.ready;
      const req = await makePending(f);
      // Conforming max: 200 args × 4096 chars ≈ 850 KB JSON line.
      const big = new Array(200).fill("a".repeat(4096));
      const c = new VaultClient(f.xdg);
      await c.connect();
      c.send({
        op: "run",
        id: req.id,
        agent: "monky",
        cmd: big,
        timeout_s: 10,
      });
      const r = JSON.parse(await c.nextLine());
      expect(r.error).toBe("state: pending (awaiting approval)");
      // Over the cap.
      const c2 = new VaultClient(f.xdg);
      await c2.connect();
      c2.send({
        op: "run",
        id: req.id,
        agent: "monky",
        cmd: ["b".repeat(4096 * 250)],
        timeout_s: 10,
      });
      const r2 = JSON.parse(await c2.nextLine());
      expect(r2.error).toBe("usage: line too long (1 MB cap)");
    } finally {
      f.cleanup();
    }
  });

  test("bad json + line-count guards", async () => {
    const f = mkVault();
    try {
      await f.h.ready;
      // bad json
      const c = new VaultClient(f.xdg);
      await c.connect();
      c.sock.write("not-json\n");
      const r = JSON.parse(await c.nextLine());
      expect(r.error).toBe("usage: bad json");
      c.close();

      // too many lines: two request lines in ONE atomic write (a single
      // unix-socket write arrives as one data event).
      const c2 = new VaultClient(f.xdg);
      await c2.connect();
      const l1 = JSON.stringify({
        v: 1,
        op: "request",
        agent: "frank",
        scope: "default",
        reason: "line 1",
      });
      const l2 = JSON.stringify({
        v: 1,
        op: "request",
        agent: "frank",
        scope: "default",
        reason: "line 2",
      });
      c2.sock.write(`${l1}\n${l2}\n`);
      const r2 = JSON.parse(await c2.nextLine());
      expect(r2.error).toBe("usage: too many lines (max 4)");
      c2.close();

      // expected done: a run handoff, then a non-done second line (same
      // atomic write: handoff reply first, then the usage error).
      const req = await makePending(f);
      await f.h.handlePatComponent(
        mkD("i-ed", `pat:approve:${req.id}`, { message_id: req.messageId }),
      );
      const c3 = new VaultClient(f.xdg);
      await c3.connect();
      const h1 = JSON.stringify({
        v: 1,
        op: "run",
        id: req.id,
        agent: "monky",
        cmd: ["true"],
        timeout_s: 5,
      });
      const h2 = JSON.stringify({ v: 1, op: "status", agent: "monky" });
      c3.sock.write(`${h1}\n${h2}\n`);
      const hr = JSON.parse(await c3.nextLine());
      expect(hr.ok).toBe(true);
      expect(hr.token).toBe(FINE_TOKEN);
      const hd = JSON.parse(await c3.nextLine());
      expect(hd.error).toBe("usage: expected done");
      c3.close();

      // status: one-line connection, reply then close.
      const s = await rpc(f, { op: "status", agent: "monky" });
      expect(s.ok).toBe(true);
    } finally {
      f.cleanup();
    }
  });

  test("run on pending -> state error; done-wait abandon sets runRc=-1 + drops censor", async () => {
    const f = mkVault();
    try {
      await f.h.ready;
      const req = await makePending(f);
      const c = new VaultClient(f.xdg);
      await c.connect();
      c.send({
        op: "run",
        id: req.id,
        agent: "monky",
        cmd: ["true"],
        timeout_s: 5,
      });
      const r = JSON.parse(await c.nextLine());
      expect(r.ok).toBe(false);
      expect(r.error).toBe("state: pending (awaiting approval)");

      // Approve, hand off, then KILL the wrapper (close before done).
      await f.h.handlePatComponent(
        mkD("i-ab", `pat:approve:${req.id}`, { message_id: req.messageId }),
      );
      const c2 = new VaultClient(f.xdg);
      await c2.connect();
      c2.send({
        op: "run",
        id: req.id,
        agent: "monky",
        cmd: ["true"],
        timeout_s: 5,
      });
      const r2 = JSON.parse(await c2.nextLine());
      expect(r2.ok).toBe(true);
      expect(getRuntimeSecrets()).toContain(FINE_TOKEN);
      c2.destroy(); // wrapper dies before done
      await tick(100);
      expect(f.st.requests.get(req.id)!.runRc).toBe(-1);
      expect(f.auditLines().some((l) => l.includes("event=done rc=-1"))).toBe(
        true,
      );
      expect(getRuntimeSecrets()).not.toContain(FINE_TOKEN);
    } finally {
      f.cleanup();
    }
  });

  test("expired request: run -> state: expired at <deadline>", async () => {
    const f = mkVault();
    try {
      await f.h.ready;
      const req = await makePending(f);
      await tick(1400); // TTL
      const c = new VaultClient(f.xdg);
      await c.connect();
      c.send({
        op: "run",
        id: req.id,
        agent: "monky",
        cmd: ["true"],
        timeout_s: 5,
      });
      const r = JSON.parse(await c.nextLine());
      expect(r.ok).toBe(false);
      expect(r.error).toContain("state: expired at");
    } finally {
      f.cleanup();
    }
  });
});

// ─── file mode (N5) ─────────────────────────────────────────────────────────

describe("file mode", () => {
  test("approve publishes atomically 0600 in 0700 dir; run reply has no token", async () => {
    const f = mkVault({ transport: "file" });
    try {
      await f.h.ready;
      const req = await makePending(f, "marzukia/jarate:write");
      await f.h.handlePatComponent(
        mkD("i-fm", `pat:approve:${req.id}`, { message_id: req.messageId }),
      );
      const fileDir = fileDirOf(f);
      expect(fs.statSync(fileDir).mode & 0o777).toBe(0o700);
      const pub = path.join(fileDir, `pat-${req.id}`);
      expect(fs.statSync(pub).mode & 0o777).toBe(0o600);
      expect(fs.readFileSync(pub, "utf-8").trim()).toBe(FINE_TOKEN);
      // No temp litter.
      expect(
        fs.readdirSync(fileDir).filter((n) => n.startsWith(".pat-")),
      ).toHaveLength(0);
      // Censor registered at approve (N5).
      expect(getRuntimeSecrets()).toContain(FINE_TOKEN);

      // Run: the reply is {"ok":true,"file":true} — no token field.
      const c = new VaultClient(f.xdg);
      await c.connect();
      c.send({
        op: "run",
        id: req.id,
        agent: "monky",
        cmd: ["gh", "api", "user"],
        timeout_s: 10,
      });
      const r = JSON.parse(await c.nextLine());
      expect(r.ok).toBe(true);
      expect(r.file).toBe(true);
      expect(r.token).toBeUndefined();
      // The token never crossed the wire in file mode.
      c.close();
      expect(
        c.raw.split("\n").filter((l) => l.includes(FINE_TOKEN)),
      ).toHaveLength(0);
      expect(f.st.requests.get(req.id)!.state).toBe("handed-off");

      // Censor drop at claimDeadline + grace (800 + 200ms).
      await tick(1100);
      expect(getRuntimeSecrets()).not.toContain(FINE_TOKEN);
    } finally {
      f.cleanup();
    }
  });

  test("startup sweep deletes planted files; audit sweep n=", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pat-sweep-"));
    const xdg = path.join(tmp, "xdg");
    fs.mkdirSync(path.join(xdg, "jarate-pat"), { recursive: true });
    fs.writeFileSync(path.join(xdg, "jarate-pat", "pat-old1"), "x\n", {
      mode: 0o600,
    });
    fs.writeFileSync(path.join(xdg, "jarate-pat", "pat-old2"), "y\n", {
      mode: 0o600,
    });
    const patsDir = path.join(tmp, "pats");
    fs.mkdirSync(patsDir, { recursive: true });
    const defaultPatFile = path.join(tmp, "marzukia-pat");
    fs.writeFileSync(defaultPatFile, `${CLASSIC_TOKEN}\n`, { mode: 0o600 });
    const fd = new FakeDiscord();
    fd.install();
    const ch = {
      id: "ch-sw",
      name: "ch-sw",
      type: "discord",
      channel: "999",
      botToken: "tok-sw",
      ownerUserId: OWNER,
    } as any;
    let h: PatVaultHandle | undefined;
    try {
      h = startPatVault({
        ch,
        botToken: ch.botToken,
        stateDir: path.join(tmp, "state"),
        xdgDir: xdg,
        patsDir,
        defaultPatFile,
        auditFile: path.join(tmp, "audit", "pat-audit.log"),
        transport: "file",
      });
      await h.ready;
      expect(fs.existsSync(path.join(xdg, "jarate-pat", "pat-old1"))).toBe(
        false,
      );
      expect(fs.existsSync(path.join(xdg, "jarate-pat", "pat-old2"))).toBe(
        false,
      );
      const lines = fs.readFileSync(
        path.join(tmp, "audit", "pat-audit.log"),
        "utf-8",
      );
      expect(lines).toContain("event=sweep n=2");
    } finally {
      if (h) stopPatVault(h);
      __patVaultResetForTest();
      globalThis.fetch = realFetch;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("stale socket rebound: leftover pat.sock unlinked + bound", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pat-sock-"));
    const xdg = path.join(tmp, "xdg");
    fs.mkdirSync(path.join(xdg, "jarate"), { recursive: true });
    fs.writeFileSync(path.join(xdg, "jarate", "pat.sock"), "stale", {
      mode: 0o600,
    });
    const patsDir = path.join(tmp, "pats");
    fs.mkdirSync(patsDir, { recursive: true });
    const defaultPatFile = path.join(tmp, "marzukia-pat");
    fs.writeFileSync(defaultPatFile, `${CLASSIC_TOKEN}\n`, { mode: 0o600 });
    const fd = new FakeDiscord();
    fd.install();
    const ch = {
      id: "ch-sk",
      name: "ch-sk",
      type: "discord",
      channel: "999",
      botToken: "tok-sk",
      ownerUserId: OWNER,
    } as any;
    let h: PatVaultHandle | undefined;
    try {
      h = startPatVault({
        ch,
        botToken: ch.botToken,
        stateDir: path.join(tmp, "state"),
        xdgDir: xdg,
        patsDir,
        defaultPatFile,
        auditFile: path.join(tmp, "audit", "pat-audit.log"),
        transport: "socket",
      });
      await h.ready;
      // A live socket now (a file write would have left plain text).
      const c = new VaultClient(xdg);
      await c.connect();
      c.send({ op: "status", agent: "monky" });
      const r = JSON.parse(await c.nextLine());
      expect(r.ok).toBe(true);
      c.close();
    } finally {
      if (h) stopPatVault(h);
      __patVaultResetForTest();
      globalThis.fetch = realFetch;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// ─── persistence (restart survival) ─────────────────────────────────────────

describe("persistence", () => {
  test("state + approvals survive restart; timers re-arm; past deadline settles", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pat-pers-"));
    const xdg = path.join(tmp, "xdg");
    const patsDir = path.join(tmp, "pats");
    fs.mkdirSync(patsDir, { recursive: true });
    const defaultPatFile = path.join(tmp, "marzukia-pat");
    fs.writeFileSync(defaultPatFile, `${CLASSIC_TOKEN}\n`, { mode: 0o600 });
    const stateDir = path.join(tmp, "state");
    const auditFile = path.join(tmp, "audit", "pat-audit.log");
    const ch = {
      id: "ch-p",
      name: "ch-p",
      type: "discord",
      channel: "999",
      botToken: "tok-p",
      ownerUserId: OWNER,
    } as any;
    const base = {
      ch,
      botToken: ch.botToken,
      stateDir,
      xdgDir: xdg,
      patsDir,
      defaultPatFile,
      auditFile,
      transport: "socket" as const,
    };
    const fd = new FakeDiscord();
    fd.install();
    try {
      // Lifetime 1: create a pending request + one approval stamp.
      const h1 = startPatVault(base);
      await h1.ready;
      const r = await patRequest(h1.vault, {
        agent: "monky",
        scope: "default",
        reason: "persist me",
      });
      expect(r.ok).toBe(true);
      const id = r.id as string;
      // Backdate an approval so the budget survives the restart.
      h1.vault.approvals.monky = [Date.now() - 60_000];
      stopPatVault(h1);

      // Lifetime 2: still pending (TTL 1200ms, ~ms elapsed).
      const h2 = startPatVault(base);
      await h2.ready;
      const loaded = h2.vault.requests.get(id)!;
      expect(loaded.state).toBe("pending");
      expect(h2.vault.approvals.monky).toEqual([expect.any(Number)]);
      // Re-armed: it expires on its own.
      await tick(1400);
      expect(h2.vault.requests.get(id)!.state).toBe("expired");
      stopPatVault(h2);

      // Lifetime 3: a record already past deadline at load settles with
      // audit recovered-expired.
      const doc = JSON.parse(
        fs.readFileSync(path.join(stateDir, "pat-vault.json"), "utf-8"),
      );
      const staleId = "pat_99999999-8888-7777-6666-555555555555";
      doc.requests = {
        [staleId]: {
          id: "pat_99999999-8888-7777-6666-555555555555",
          agent: "monky",
          scope: "default",
          reason: "stale pending",
          channelId: "999",
          messageId: "msg-stale",
          state: "pending",
          created: Date.now() - 10_000,
          ttlDeadline: Date.now() - 5_000,
        },
      };
      fs.writeFileSync(
        path.join(stateDir, "pat-vault.json"),
        JSON.stringify(doc),
      );
      const h3 = startPatVault(base);
      await h3.ready;
      const stale = h3.vault.requests.get(staleId)!;
      expect(stale.state).toBe("expired");
      expect(stale.expiredKind).toBe("ttl");
      const lines = fs.readFileSync(auditFile, "utf-8");
      expect(lines).toContain("event=recovered-expired");
      // The stale request's button message was edited (components off).
      const staleEdits = fd
        .messageEdits()
        .filter((c) => c.url.includes("msg-stale"));
      expect(staleEdits.length).toBe(1);
      expect(staleEdits[0].body.components).toEqual([]);
      stopPatVault(h3);
    } finally {
      __patVaultResetForTest();
      globalThis.fetch = realFetch;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("terminal records (incl. handed-off) pruned to last 50; approvals capped", async () => {
    const f = mkVault({});
    try {
      const now = Date.now();
      const HOUR = 3_600_000;
      // Seed 60 handed-off records, 1h apart, oldest first (terminal,
      // no timers). They must NOT accumulate past TERMINAL_KEEP.
      for (let i = 0; i < 60; i++) {
        const id = `pat_seed-${String(i).padStart(2, "0")}`;
        f.st.requests.set(id, {
          id,
          agent: "monky",
          scope: "default",
          reason: `seed ${i}`,
          channelId: "999",
          messageId: `msg-${i}`,
          state: "handed-off",
          created: now - (60 - i) * HOUR,
          handedOffAt: now - (60 - i) * HOUR,
          ttlDeadline: now - (60 - i) * HOUR,
          runRc: 0,
        } as any);
      }
      // 200 approval stamps, all >1h old (budget gate untouched).
      f.st.approvals.monky = Array.from(
        { length: 200 },
        (_, i) => now - (200 - i + 1) * HOUR,
      );
      // One state change triggers persist.
      const r = await patRequest(f.st, {
        agent: "monky",
        scope: "default",
        reason: "prune check",
      });
      expect(r.ok).toBe(true);
      const p = path.join(f.tmp, "state", "pat-vault.json");
      const doc = JSON.parse(fs.readFileSync(p, "utf-8"));
      const reqs = Object.values(doc.requests) as any[];
      const handedOff = reqs.filter((x) => x.state === "handed-off");
      // Keep-last-50: oldest 10 (seed-00..09) dropped, rest kept, + the
      // fresh pending.
      expect(handedOff.length).toBe(50);
      expect(reqs.length).toBe(51);
      expect(reqs.some((x) => x.id === "pat_seed-00")).toBe(false);
      expect(reqs.some((x) => x.id === "pat_seed-09")).toBe(false);
      expect(reqs.some((x) => x.id === "pat_seed-10")).toBe(true);
      expect(reqs.some((x) => x.id === "pat_seed-59")).toBe(true);
      // In-memory map pruned too (issue #99: accumulation in memory).
      expect(f.st.requests.has("pat_seed-00")).toBe(false);
      expect(f.st.requests.has("pat_seed-10")).toBe(true);
      expect(f.st.requests.has("pat_seed-59")).toBe(true);
      // Approvals capped to the last 50 (newest kept, oldest dropped).
      expect(doc.approvals.monky.length).toBe(50);
      expect(f.st.approvals.monky.length).toBe(50);
      expect(doc.approvals.monky[0]).toBe(now - 51 * HOUR);
      expect(doc.approvals.monky[49]).toBe(now - 2 * HOUR);
    } finally {
      f.cleanup();
    }
  });

  test("state file is 0600 once written", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pat-mode-"));
    try {
      const f = mkVault({
        stateDir: path.join(tmp, "state"),
        xdgDir: path.join(tmp, "xdg"),
      });
      try {
        const p = path.join(tmp, "state", "pat-vault.json");
        // A fresh vault persists on its first state change (a request).
        const r = await patRequest(f.st, {
          agent: "monky",
          scope: "default",
          reason: "persist mode",
        });
        expect(r.ok).toBe(true);
        expect(fs.existsSync(p)).toBe(true);
        expect(fs.statSync(p).mode & 0o777).toBe(0o600);
      } finally {
        f.cleanup();
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// ─── direct state-machine drives (unit-level) ───────────────────────────────

describe("patRunBegin / patStatus unit", () => {
  test("patStatus: by id and by agent; no token in output", async () => {
    const f = mkVault();
    try {
      const req = await makePending(f);
      const byId = patStatus(f.st, { id: req.id });
      expect(byId.ok).toBe(true);
      expect(byId.state).toBe("pending");
      const docStr = JSON.stringify(byId);
      expect(docStr).not.toContain(FINE_TOKEN);
      expect(docStr).not.toContain(CLASSIC_TOKEN);
      const byAgent = patStatus(f.st, { agent: "monky" });
      expect(byAgent.ok).toBe(true);
      expect((byAgent.pending as any[]).length).toBe(1);
      expect((byAgent.pending as any[])[0].id).toBe(req.id);
    } finally {
      f.cleanup();
    }
  });

  test("run on denied -> already used", async () => {
    const f = mkVault();
    try {
      const req = await makePending(f);
      const r = patRunBegin(f.st, {
        id: req.id,
        agent: "monky",
        cmd: ["true"],
        timeout_s: 10,
      });
      expect(r.ok).toBe(false);
      expect(r.error).toBe("state: pending (awaiting approval)");
      f.st.requests.get(req.id)!.state = "denied";
      const r2 = patRunBegin(f.st, {
        id: req.id,
        agent: "monky",
        cmd: ["true"],
        timeout_s: 10,
      });
      expect(r2.error).toBe("state: already used");
    } finally {
      f.cleanup();
    }
  });

  test("socket-mode run with missing token file: handoff-error, state stays approved", async () => {
    const f = mkVault();
    try {
      const req = await makePending(f, "marzukia/jarate:write");
      await f.h.handlePatComponent(
        mkD("i-hf", `pat:approve:${req.id}`, { message_id: req.messageId }),
      );
      fs.unlinkSync(path.join(f.patsDir, "marzukia", "jarate:write"));
      const r = patRunBegin(f.st, {
        id: req.id,
        agent: "monky",
        cmd: ["true"],
        timeout_s: 10,
      });
      expect(r.ok).toBe(false);
      expect(r.error).toBe(
        "scope: token file missing for marzukia/jarate:write",
      );
      expect(f.st.requests.get(req.id)!.state).toBe("approved");
      expect(
        f.auditLines().some((l) => l.includes("event=handoff-error")),
      ).toBe(true);
    } finally {
      f.cleanup();
    }
  });
});
