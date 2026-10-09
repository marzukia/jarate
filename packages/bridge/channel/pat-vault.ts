/**
 * PAT vault — one GitHub token, handed from the bridge to an agent for
 * exactly one command, after exactly one human button tap.
 *
 * Security invariants (design v4 §11):
 *   1. Only the bridge reads a PAT file — at approve (both transports:
 *      dead-file gate; file mode also publishes) and at handoff (socket
 *      mode, rotation-aware).
 *   2. Only an owner's tap mutates a request; every other tap gets a
 *      VISIBLE reply (PATCH @original) and an audit line, state
 *      untouched. The owner gate runs BEFORE the message-mismatch check
 *      (#204): a stranger's stale tap audits as non-owner-tap, not
 *      mismatch.
 *   3. One tap = one token = one command. `handed-off` is terminal.
 *   4. The token is in at most 3 places at once: bridge memory, the bun
 *      wrapper, one child's env. Never in argv, never in a file (socket
 *      mode), never in the LLM context.
 *   5. Every secret lifetime is timer-owned by the bridge (TTL 5m, claim
 *      60s, censor grace 10s, startup sweep).
 *   6. The budget is enforced here (bridge), not in the CLI.
 *   7. Restart-safe: state + approvals persist; the published-file dir is
 *      bridge-owned (anything in it at boot is stale).
 *   8. Deliverable feedback: the defer consumes the one-shot interaction
 *      callback, so every post-defer reply goes through
 *      replyInteraction (PATCH @original — visible in channel) and the
 *      success path clears the "Thinking" ack with deleteDeferredAck.
 *   9. handlePatComponent NEVER REJECTS (top-level try/catch; M1) — an
 *      escaped rejection would be an unhandled promise rejection and kill
 *      the whole bridge under Node 22's unhandled-rejections=throw.
 *
 * Runbook: docs/PAT-VAULT.md.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { dropRuntimeSecrets, registerRuntimeSecrets } from "./censor";
import {
  deferInteraction,
  deleteDeferredAck,
  editDiscordMessage,
  getDiscordChannelId,
  interactionUserId,
  interactionUserName,
  replyInteraction,
  sendDiscordMessage,
} from "./discord";
import { hasOwnerConfigured, isOwnerUser } from "./index";
import type { ChannelConfig } from "./types";

// ─── Constants (all env-overridable for tests) ───────────────────────────

const SCOPE_RE =
  /^(default|[A-Za-z0-9_.-]{1,39}\/[A-Za-z0-9_.-]{1,100}:(read|write))$/;
const TOKEN_RE =
  /^(gh[pousr]_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{22,255})$/;
const COMPONENT_RE = /^pat:(approve|deny):pat_([0-9a-f-]{36})$/;
const HOUR_MS = 3_600_000;
const MAX_LINE_BYTES = 1_000_000; // N6: conforming run line ≈ 850 KB
const MAX_LINES_PER_CONN = 4;
const BASE_READ_TIMEOUT_MS = 5_000;
const DONE_WAIT_EXTRA_MS = 30_000;
const SEEN_FRESH_MS = 10 * 60_000;
const TERMINAL_KEEP = 50;
const APPROVALS_KEEP = 50;

function envNum(name: string, def: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : def;
}

// ─── Types ────────────────────────────────────────────────────────────────

export type PatRequestState =
  | "pending"
  | "approved"
  | "handed-off"
  | "expired"
  | "denied";

export interface PatRequest {
  id: string; // "pat_" + crypto.randomUUID() (no secret in the id)
  agent: string; // self-attested from the request line
  scope: string;
  reason: string;
  channelId: string;
  messageId: string; // the button message, for match checks
  state: PatRequestState;
  created: number; // epoch ms
  approvedAt?: number;
  handedOffAt?: number;
  ttlDeadline: number; // created + ttlMs; 0 = no TTL (#203, pending blocks)
  claimDeadline?: number; // approvedAt + claimMs
  deniedBy?: string;
  runRc?: number;
  expiredKind?: "ttl" | "claim";
}

export interface PatVaultState {
  ch: ChannelConfig;
  botToken: string;
  transport: "socket" | "file";
  now: () => number;
  secrets: { register: (l: string[]) => void; drop: (l: string[]) => void };
  ttlMs: number;
  claimMs: number;
  maxPending: number;
  budgetPerHour: number;
  censorGraceMs: number;
  seenCap: number;
  stateDir: string;
  stateFile: string;
  socketDir: string;
  socketPath: string;
  fileDir: string;
  patsDir: string;
  defaultPatFile: string;
  auditFile: string;
  auditDir: string;
  requests: Map<string, PatRequest>;
  approvals: Record<string, number[]>;
  seen: Map<string, number>;
  timers: Map<string, ReturnType<typeof setTimeout>[]>;
  server: net.Server | null;
  stopped: boolean;
}

export interface StartPatVaultOpts {
  pi?: unknown;
  ctx?: unknown;
  ch: ChannelConfig;
  botToken: string;
  stateDir: string;
  xdgDir?: string;
  socketDir?: string;
  fileDir?: string;
  patsDir?: string;
  defaultPatFile?: string;
  auditFile?: string;
  transport?: "socket" | "file";
  now?: () => number;
  secrets?: { register?: (l: string[]) => void; drop?: (l: string[]) => void };
}

export interface PatVaultHandle {
  vault: PatVaultState;
  /** Resolves once the socket bind attempt finished (or the vault runs
   *  request-only without a socket). Socket tests await this. */
  ready: Promise<void>;
  handlePatComponent: (d: any) => Promise<void>;
}

// ─── Module-level instance registry (L4: once per process per socket) ────

const vaultEntries = new Map<string, { vault: PatVaultState; refs: number }>();

/** Test hook: stop every live vault and clear the module registry. */
export function __patVaultResetForTest(): void {
  for (const entry of [...vaultEntries.values()]) {
    stopVaultCore(entry.vault);
  }
  vaultEntries.clear();
}

/** Test hook: drop the registry entry for a path WITHOUT stopping the
 *  server, so a later startPatVault on the same path performs a real bind
 *  against a live listener (issue #128 fix 2). */
export function __patDetachForTest(socketPath: string): void {
  vaultEntries.delete(socketPath);
}

// ─── Small helpers ────────────────────────────────────────────────────────

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function timeOfDay(ms: number): string {
  return new Date(ms).toISOString().slice(11, 19);
}

function kv(pairs: Record<string, unknown>): string {
  return Object.entries(pairs)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${k}=${v}`)
    .join(" ");
}

function base(r: PatRequest): Record<string, unknown> {
  return { agent: r.agent, scope: r.scope, id: r.id };
}

/** Append-only audit line (design §8). Never breaks the flow. */
function audit(
  st: PatVaultState,
  event: string,
  pre?: Record<string, unknown>,
  extra?: Record<string, unknown>,
): void {
  try {
    if (!fs.existsSync(st.auditDir)) {
      fs.mkdirSync(st.auditDir, { recursive: true, mode: 0o700 });
      fs.chmodSync(st.auditDir, 0o700);
    }
    const parts = [
      iso(st.now()),
      kv(pre ?? {}),
      `event=${event}`,
      kv(extra ?? {}),
    ]
      .filter(Boolean)
      .join(" ");
    fs.appendFileSync(st.auditFile, `${parts}\n`, { encoding: "utf-8" });
    fs.chmodSync(st.auditFile, 0o600);
  } catch {
    // audit never breaks the flow
  }
}

function persist(st: PatVaultState): void {
  try {
    fs.mkdirSync(st.stateDir, { recursive: true });
    // Terminal records (expired, denied, handed-off) pruned to the last
    // 50 (oldest dropped first). handed-off is terminal per the state
    // machine; without it, used-up records accumulate forever.
    const all = [...st.requests.values()];
    const terminal = all
      .filter(
        (r) =>
          r.state === "expired" ||
          r.state === "denied" ||
          r.state === "handed-off",
      )
      .sort((a, b) => a.created - b.created);
    const dropIds = new Set(
      terminal
        .slice(0, Math.max(0, terminal.length - TERMINAL_KEEP))
        .map((r) => r.id),
    );
    for (const id of dropIds) st.requests.delete(id);
    const freshSeen = [...st.seen.entries()]
      .filter(([, ts]) => st.now() - ts < SEEN_FRESH_MS)
      .slice(-st.seenCap);
    // Approval stamps: keep the last APPROVALS_KEEP per agent (memory +
    // file). The budget gate only reads the rolling hour, and it blocks
    // at budgetPerHour, so max(50, budgetPerHour) always covers every
    // stamp the gate can still see.
    const approvalsKeep = Math.max(APPROVALS_KEEP, st.budgetPerHour);
    for (const [agent, arr] of Object.entries(st.approvals)) {
      if (Array.isArray(arr) && arr.length > approvalsKeep) {
        st.approvals[agent] = arr.slice(-approvalsKeep);
      }
    }
    const doc = {
      v: 1,
      requests: Object.fromEntries(st.requests),
      approvals: st.approvals,
      seen: Object.fromEntries(freshSeen),
    };
    const tmp = `${st.stateFile}.tmp-${process.pid}`;
    const fd = fs.openSync(tmp, "w", 0o600);
    try {
      fs.writeSync(fd, JSON.stringify(doc));
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, st.stateFile);
  } catch (e) {
    console.error("[pat-vault] persist failed:", e);
  }
}

// ─── Token store (design §3) ──────────────────────────────────────────────

function listPats(st: PatVaultState, dir: string, out: string[]): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      listPats(st, p, out);
    } else if (e.isFile()) {
      const rel = path.relative(st.patsDir, p).split(path.sep).join("/");
      // Sanitized names only: keep exactly the scope-grammar shapes.
      if (SCOPE_RE.test(rel) && !out.includes(rel)) {
        out.push(rel);
      }
    }
  }
}

/** Known scopes = `default` + recursive listing of the pats dir. */
export function knownScopes(st: PatVaultState): string[] {
  const scopes = ["default"];
  listPats(st, st.patsDir, scopes);
  return scopes;
}

function tokenFileFor(st: PatVaultState, scope: string): string {
  if (scope === "default") return st.defaultPatFile;
  return path.join(st.patsDir, scope);
}

/** Kinded token-file failure: the message ALWAYS names the path.
 *  `code` distinguishes missing vs empty vs unreadable (design §3). */
export class TokenFileError extends Error {
  readonly code: "missing" | "empty" | "unreadable";
  constructor(code: "missing" | "empty" | "unreadable", message: string) {
    super(message);
    this.name = "TokenFileError";
    this.code = code;
  }
}

/** Read the scope token file: one line, token only, trailing newline
 *  trimmed. Throws a TokenFileError naming the path — missing vs empty
 *  vs unreadable, never a raw fs message (design §3). */
export function readScopeToken(st: PatVaultState, scope: string): string {
  const p = tokenFileFor(st, scope);
  let raw: string;
  try {
    raw = fs.readFileSync(p, "utf-8");
  } catch (e: any) {
    if (e?.code === "ENOENT") {
      throw new TokenFileError("missing", `token file missing: ${p}`);
    }
    throw new TokenFileError(
      "unreadable",
      `token file unreadable (${e?.code ?? "read error"}): ${p}`,
    );
  }
  const token = raw.split("\n")[0].trim();
  if (!token) throw new TokenFileError("empty", `token file empty: ${p}`);
  return token;
}

export function validateTokenShape(token: string): boolean {
  return TOKEN_RE.test(token);
}

export type TokenFileIssue = "missing" | "empty" | "unreadable" | "shape";

/** Non-throwing pre-check: read + shape-validate the scope token file.
 *  The tap handler (both transports) and the socket run handoff use this
 *  to build their visible, executable errors — the reader copies the
 *  next command, does not think (one doc out, executable errors). */
export function checkScopeToken(
  st: PatVaultState,
  scope: string,
):
  | { ok: true; token: string }
  | { ok: false; kind: TokenFileIssue; error: string } {
  const p = tokenFileFor(st, scope);
  let token: string;
  try {
    token = readScopeToken(st, scope);
  } catch (e: any) {
    if (e instanceof TokenFileError) {
      return { ok: false, kind: e.code, error: e.message };
    }
    return {
      ok: false,
      kind: "unreadable",
      error: `token file unreadable: ${p} (${String(e?.message ?? e)})`,
    };
  }
  if (!validateTokenShape(token)) {
    return { ok: false, kind: "shape", error: `token shape invalid: ${p}` };
  }
  return { ok: true, token };
}

function tokenKind(token: string): "classic" | "fine" {
  return token.startsWith("github_pat_") ? "fine" : "classic";
}

// ─── File-mode publish (design §10/N5) ────────────────────────────────────

function publishedPath(st: PatVaultState, id: string): string {
  return path.join(st.fileDir, `pat-${id}`);
}

/** mkstemp-in-dir → write → close → rename(2): atomic, same fs, 0600. */
function publishTokenFile(
  st: PatVaultState,
  id: string,
  token: string,
): string {
  const finalPath = publishedPath(st, id);
  const tmp = path.join(
    st.fileDir,
    `.pat-${id}.tmp-${process.pid}-${crypto.randomBytes(4).toString("hex")}`,
  );
  const fd = fs.openSync(tmp, "w", 0o600);
  try {
    fs.writeSync(fd, `${token}\n`);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, finalPath);
  return finalPath;
}

function unlinkPublished(st: PatVaultState, id: string): void {
  try {
    fs.unlinkSync(publishedPath(st, id));
  } catch {
    // already gone (sweep / claim settle raced)
  }
}

// ─── Startup sweep + bind (design §5, once per process — L4) ─────────────

function startupSweep(st: PatVaultState): void {
  let n = 0;
  try {
    if (fs.existsSync(st.fileDir)) {
      n = fs.readdirSync(st.fileDir).length;
      fs.rmSync(st.fileDir, { recursive: true, force: true });
    }
  } catch (e) {
    audit(st, "vault-error", undefined, { err: `sweep: ${String(e)}` });
  }
  try {
    fs.mkdirSync(st.fileDir, { recursive: true, mode: 0o700 });
    fs.chmodSync(st.fileDir, 0o700);
  } catch (e) {
    audit(st, "vault-error", undefined, { err: `filedir: ${String(e)}` });
  }
  // #208: a clean boot is not an event — audit only when something
  // was actually pruned.
  if (n > 0) audit(st, "sweep", undefined, { n });
}

/** Connect probe: true only if a live peer accepts on the socket path.
 *  Any failure (ECONNREFUSED, ENOENT, EACCES, ENOTSOCK, timeout) means
 *  no live peer — the entry is a crash leftover (issue #128). */
function probeSocket(p: string, timeoutMs = 500): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect(p);
    let settled = false;
    const done = (ok: boolean) => {
      if (settled) return;
      settled = true;
      s.destroy();
      resolve(ok);
    };
    s.once("connect", () => done(true));
    s.once("error", () => done(false));
    s.setTimeout(timeoutMs, () => done(false));
  });
}

function bindSocket(st: PatVaultState): Promise<void> {
  return (async () => {
    try {
      fs.mkdirSync(st.socketDir, { recursive: true, mode: 0o700 });
      fs.chmodSync(st.socketDir, 0o700);
    } catch (e) {
      audit(st, "vault-error", undefined, { err: `socket dir: ${String(e)}` });
      return;
    }
    for (let attempt = 1; attempt <= 2; attempt++) {
      let livePeer = false;
      if (fs.existsSync(st.socketPath)) {
        // Probe before unlink: the entry may belong to a live server.
        // A blind unlink makes that server unreachable by path
        // (issue #128). Only crash leftovers get unlinked.
        livePeer = await probeSocket(st.socketPath);
        if (!livePeer) {
          try {
            fs.unlinkSync(st.socketPath);
          } catch {
            // stale unlink failure: the listen below decides
          }
        }
      }
      try {
        const srv = await new Promise<net.Server>((resolve, reject) => {
          const s = net.createServer((sock) => handleConnection(st, sock));
          s.on("error", reject);
          s.listen(st.socketPath, () => resolve(s));
        });
        try {
          fs.chmodSync(st.socketPath, 0o600);
        } catch {
          // best effort
        }
        srv.on("error", (e) => {
          audit(st, "vault-error", undefined, { err: `server: ${String(e)}` });
        });
        st.server = srv;
        return;
      } catch (e: any) {
        if (livePeer) {
          // The listen failed (EADDRINUSE) because the path is owned by
          // a live server we did not unlink. Do not stomp it: surface
          // clearly, run request-only (posts + taps + edits still work).
          audit(st, "vault-error", undefined, {
            err: `socket ${st.socketPath} owned by a live server (probe connected); not unlinking — is another pi/daemon running?`,
          });
          return;
        }
        if (e?.code !== "EADDRINUSE" || attempt === 2) {
          // Request-only (socket down): posts + taps + edits still work.
          audit(st, "vault-error", undefined, {
            err: `bind: ${e?.code ?? String(e)}`,
          });
          return;
        }
        // EADDRINUSE: second probe + unlink + bind (crash leftover
        // reappearing)
      }
    }
  })();
}

// ─── Timers ───────────────────────────────────────────────────────────────

function track(
  st: PatVaultState,
  id: string,
  t: ReturnType<typeof setTimeout>,
): void {
  const arr = st.timers.get(id) ?? [];
  arr.push(t);
  st.timers.set(id, arr);
  t.unref?.();
}

function settleTtl(st: PatVaultState, id: string): void {
  const req = st.requests.get(id);
  if (req?.state !== "pending") return;
  req.state = "expired";
  req.expiredKind = "ttl";
  audit(st, "expire-ttl", base(req));
  persist(st);
  void editRequestMessage(st, req, ttlExpiredText(st), [], "expired");
}

function settleClaim(st: PatVaultState, id: string): void {
  const req = st.requests.get(id);
  if (req?.state !== "approved") return;
  req.state = "expired";
  req.expiredKind = "claim";
  if (st.transport === "file") unlinkPublished(st, id);
  audit(st, "expire-claim", base(req));
  persist(st);
  void editRequestMessage(st, req, claimExpiredText(), [], "expired");
}

function armTtl(st: PatVaultState, req: PatRequest): void {
  // #203: ttlMs 0 = no TTL. Pending is BLOCKING until tap or revoke;
  // the timer exists only when an explicit JARATE_PAT_TTL_MS is set.
  // Deadline 0 (persisted no-TTL sentinel) is never armed against, even
  // if an env TTL appears in a later restart.
  if (st.ttlMs === 0 || req.ttlDeadline <= 0) return;
  track(
    st,
    req.id,
    setTimeout(
      () => settleTtl(st, req.id),
      Math.max(0, req.ttlDeadline - st.now()),
    ),
  );
}

function armClaim(st: PatVaultState, req: PatRequest): void {
  track(
    st,
    req.id,
    setTimeout(
      () => settleClaim(st, req.id),
      Math.max(0, (req.claimDeadline ?? 0) - st.now()),
    ),
  );
}

/** Socket-mode censor drop: at max(commandDone, handoff) + grace. Scheduled
 *  when the done line arrives (commandDone known); connection close or
 *  read timeout drops immediately (the token is no longer in transit). */
function scheduleCensorDrop(
  st: PatVaultState,
  req: PatRequest,
  token: string,
  delayMs: number,
): void {
  track(
    st,
    req.id,
    setTimeout(
      () => {
        try {
          st.secrets.drop([token]);
        } catch {
          // drop is best-effort; the github pattern is the backstop
        }
      },
      Math.max(0, delayMs),
    ),
  );
}

// ─── Discord message text (design §6) ─────────────────────────────────────

function ttlMinutes(st: PatVaultState): string {
  const m = Math.round(st.ttlMs / 60_000);
  return m > 0 ? `${m}m` : `${st.ttlMs}ms`;
}

function buttonRow(id: string): Array<Record<string, unknown>> {
  return [
    {
      type: 1,
      components: [
        { type: 2, style: 1, label: "Approve", custom_id: `pat:approve:${id}` },
        { type: 2, style: 4, label: "Deny", custom_id: `pat:deny:${id}` },
      ],
    },
  ];
}

// ─── Discord message (embed) ───────────────────────────────────────────────
// Mirrors vault.ts (2026-10-01, Andryo): request/status messages ship as a
// Discord embed ("proper chat container"), not a wall of plain text. Content
// line stays short + copyable; all detail lives in the embed.

const EMBED_COLOR: Record<string, number> = {
  pending: 0xf1c40f,
  approved: 0x2ecc71,
  denied: 0xe74c3c,
  expired: 0x95a5a6,
};

/** Embed for the request/status message. `status` selects title + color.
 *  The free-text reason rides in an embed field (mirrors vault.ts), so it
 *  never sits bare in the content line. */
function patEmbed(
  st: PatVaultState,
  req: PatRequest,
  status: string,
): Record<string, unknown> {
  const fields: Array<Record<string, unknown>> = [
    { name: "scope", value: String(req.scope), inline: true },
  ];
  if (status === "pending") {
    // #205: the grant is visible BEFORE the tap. PAT grants are one-shot
    // by construction (claim window after approval).
    fields.push({
      name: "grant",
      value: `single use (claim within ${Math.round(
        st.claimMs / 1000,
      )}s of approval)`,
      inline: false,
    });
    fields.push({
      name: "reason",
      value: String(req.reason || "-"),
      inline: false,
    });
  }
  // claim deadline: approved (the run window) AND expired (vault's
  // always-present pattern: the deadline must stay visible after the
  // claim-expired edit replaces the approved embed - pr-b3 review LOW-1).
  // Value falls back to ttlDeadline when claimDeadline is unset (ttl-expired
  // was never approved).
  if (status === "approved" || status === "expired") {
    fields.push({
      name: "claim",
      value: `claim by ${timeOfDay(
        req.claimDeadline ?? req.ttlDeadline,
      )}Z (${Math.round(st.claimMs / 1000)}s, single use)`,
      inline: false,
    });
  }
  const titles: Record<string, string> = {
    pending: `PAT request - ${req.agent}`,
    approved: `PAT approved - ${req.agent}`,
    denied: `PAT denied - ${req.agent}`,
    expired: `PAT expired - ${req.agent}`,
  };
  let footer = req.id;
  if (status === "pending") {
    // #203: no TTL (default) → pending until tap; the expiry timestamp
    // line stays only when an explicit TTL is configured.
    footer =
      st.ttlMs > 0 && req.ttlDeadline > 0
        ? `expires ${timeOfDay(req.ttlDeadline)}Z (${ttlMinutes(st)}) · ${req.id}`
        : `pending until tap · ${req.id}`;
  }
  return {
    title: titles[status] ?? titles.pending,
    color: EMBED_COLOR[status] ?? EMBED_COLOR.pending,
    fields,
    footer: { text: footer },
  };
}

function approvedText(req: PatRequest): string {
  return `jarate pat-run ${req.id} -- <cmd>`;
}

function deniedText(username: string): string {
  return `denied by ${username}`;
}

function ttlExpiredText(st: PatVaultState): string {
  return `unanswered (${ttlMinutes(st)})`;
}

function claimExpiredText(): string {
  return "claim window missed";
}

/** Approve-tap followup for a dead scope token file: NON-ephemeral (the
 *  channel sees it even if the tapper misses it), names scope + file
 *  path + the exact next command. No state transition — the request
 *  stays pending for a re-tap after the fix (M1: an error followup is
 *  an outcome, not a rejection). */
function tapTokenFileText(
  st: PatVaultState,
  req: PatRequest,
  chk: { kind: TokenFileIssue; error: string },
): string {
  const p = tokenFileFor(st, req.scope);
  const label: Record<TokenFileIssue, string> = {
    missing: "token file missing",
    empty: "token file empty",
    unreadable: "token file unreadable",
    shape: "token shape invalid",
  };
  const fix: Record<TokenFileIssue, string> = {
    missing: "restore the file, then re-tap",
    empty: "write the token (one line, 0600), then re-tap",
    unreadable: `fix file perms (chmod 600 ${p}), then re-tap`,
    shape: "fix the token (one line, 0600), then re-tap",
  };
  return [
    `[!] approve blocked: ${label[chk.kind]} for ${req.scope}`,
    `path: ${p}`,
    `${fix[chk.kind]} - or re-request: ` +
      `\`jarate pat-request ${req.scope} <reason>\``,
  ].join("\n");
}

/** Run handoff error (socket mode): the one-doc error string carries
 *  scope + file path + the exact next command — fix + re-run this id,
 *  or re-request if the claim window has passed. */
function runTokenFileError(
  st: PatVaultState,
  req: PatRequest,
  chk: { kind: TokenFileIssue; error: string },
): string {
  const p = tokenFileFor(st, req.scope);
  const fix: Record<TokenFileIssue, string> = {
    missing: "restore the file, then re-run",
    empty: "write the token (one line, 0600), then re-run",
    unreadable: `fix file perms (chmod 600 ${p}), then re-run`,
    shape: "fix the token (one line, 0600), then re-run",
  };
  return (
    `scope: ${chk.error} - ${fix[chk.kind]}: ` +
    `\`jarate pat-run ${req.id} -- <cmd>\`; if the claim window has ` +
    `passed, re-request: \`jarate pat-request ${req.scope} <reason>\``
  );
}

/** Edit the request's button message; components: [] kills the buttons;
 *  the embed is replaced in place so the color tracks the status. */
async function editRequestMessage(
  st: PatVaultState,
  req: PatRequest,
  text: string,
  components: Array<Record<string, unknown>> = [],
  status: string = "pending",
): Promise<void> {
  if (!req.messageId) return;
  const res = await editDiscordMessage(st.ch, req.messageId, text, {
    components,
    embeds: [patEmbed(st, req, status)],
  });
  if (!res.success) {
    console.error(`[pat-vault] edit failed for ${req.id}:`, res.error);
  }
}

// ─── State machine: request / run / status (design §5) ────────────────────

export interface PatRunBeginResult {
  ok: boolean;
  error?: string;
  file?: boolean;
  token?: string;
  kind?: "classic" | "fine";
  req?: PatRequest;
  timeoutS?: number;
}

/** `request` op. Registers the record BEFORE the Discord POST (N6); a
 *  failed POST unregisters and errors (retry is safe — nothing posted). */
export async function patRequest(
  st: PatVaultState,
  line: any,
): Promise<Record<string, unknown>> {
  const agent =
    typeof line?.agent === "string" && line.agent ? line.agent : "unknown";
  const scope = typeof line?.scope === "string" ? line.scope : "";
  const reason = typeof line?.reason === "string" ? line.reason : "";

  const known = knownScopes(st);
  if (!known.includes(scope)) {
    audit(st, "scope-reject", { agent, scope });
    return {
      ok: false,
      error: `scope: unknown '${scope}' (known: ${known.join(", ")})`,
    };
  }
  if (reason.length < 3 || reason.length > 200) {
    return { ok: false, error: "usage: reason must be 3-200 chars" };
  }
  const pendingCount = [...st.requests.values()].filter(
    (r) => r.agent === agent && r.state === "pending",
  ).length;
  if (pendingCount >= st.maxPending) {
    const pending = [...st.requests.values()].find(
      (r) => r.agent === agent && r.state === "pending",
    )!;
    audit(st, "pending-reject", { agent, scope, id: pending.id });
    return {
      ok: false,
      error: `pending: ${pending.id} ${
        pending.ttlDeadline > 0
          ? `expires ${iso(pending.ttlDeadline)}`
          : "is still pending (no expiry — tap to clear)"
      }`,
    };
  }
  const now = st.now();
  const recent = (st.approvals[agent] ?? []).filter((ts) => ts > now - HOUR_MS);
  if (recent.length >= st.budgetPerHour) {
    const nextSlot = Math.min(...recent) + HOUR_MS;
    audit(st, "budget-reject", { agent, scope, next_slot: nextSlot });
    return {
      ok: false,
      error: `budget: ${st.budgetPerHour} approvals in last hour; next slot ${iso(nextSlot)}`,
    };
  }
  if (!hasOwnerConfigured(st.ch)) {
    console.warn(
      `[pat-vault] request from ${agent}: no owner configured on channel ${st.ch.id} (vault is effectively disabled)`,
    );
    audit(st, "no-owner", { agent, scope });
  }

  const id = `pat_${crypto.randomUUID()}`;
  const req: PatRequest = {
    id,
    agent,
    scope,
    reason,
    channelId: String(getDiscordChannelId(st.ch.id) || st.ch.channel),
    messageId: "",
    state: "pending",
    created: now,
    // #203: 0 = no TTL (the default). A real deadline only when an
    // explicit JARATE_PAT_TTL_MS is configured.
    ttlDeadline: st.ttlMs > 0 ? now + st.ttlMs : 0,
  };
  st.requests.set(id, req);

  const res = await sendDiscordMessage(st.ch, "tap Approve or Deny", {
    components: buttonRow(id),
    embeds: [patEmbed(st, req, "pending")],
  });
  if (!res.success) {
    st.requests.delete(id);
    audit(
      st,
      "post-fail",
      { agent, scope, id },
      { reason: res.error ?? "unknown" },
    );
    return { ok: false, error: `post failed: ${res.error ?? "unknown"}` };
  }
  req.messageId = String(res.messageId ?? "");
  armTtl(st, req);
  audit(st, "request", { agent, scope, id });
  persist(st);
  // #203: null ttl = no expiry (pending is blocking until tap).
  return {
    ok: true,
    id,
    state: "pending",
    ttl: req.ttlDeadline > 0 ? iso(req.ttlDeadline) : null,
  };
}

/** `run` op (begin). The socket server keeps the connection open for the
 *  done-wait after a successful handoff. */
export function patRunBegin(st: PatVaultState, line: any): PatRunBeginResult {
  const id = typeof line?.id === "string" ? line.id : "";
  const req = st.requests.get(id);
  if (!req) return { ok: false, error: "unknown id" };

  const cmd = line?.cmd;
  if (
    !Array.isArray(cmd) ||
    cmd.length < 1 ||
    cmd.length > 200 ||
    !cmd.every(
      (c: unknown) => typeof c === "string" && c.length > 0 && c.length <= 4096,
    )
  ) {
    return {
      ok: false,
      error: "usage: cmd must be 1-200 strings (each <=4096 chars)",
    };
  }
  const timeoutS = line?.timeout_s;
  if (!Number.isInteger(timeoutS) || timeoutS < 1 || timeoutS > 3600) {
    return { ok: false, error: "usage: timeout_s must be 1-3600" };
  }

  if (req.state === "pending") {
    return { ok: false, error: "state: pending (awaiting approval)" };
  }
  if (req.state === "expired") {
    const deadline =
      req.expiredKind === "claim"
        ? (req.claimDeadline ?? req.ttlDeadline)
        : req.ttlDeadline;
    return { ok: false, error: `state: expired at ${iso(deadline)}` };
  }
  if (req.state === "denied" || req.state === "handed-off") {
    return { ok: false, error: "state: already used" };
  }

  // approved → handoff
  if (st.transport === "file") {
    // The file was published at approve; kind for the audit is re-derived
    // from the published file when it still exists (it may have been
    // swept by a restart — the wrapper will report file missing then).
    let kind: "classic" | "fine" | "unknown" = "unknown";
    try {
      const t = fs
        .readFileSync(publishedPath(st, id), "utf-8")
        .split("\n")[0]
        .trim();
      if (t) kind = tokenKind(t);
    } catch {
      // swept or missing: wrapper will error cleanly
    }
    req.state = "handed-off";
    req.handedOffAt = st.now();
    audit(st, "handoff", base(req), { kind });
    persist(st);
    return { ok: true, file: true, req, timeoutS };
  }

  // socket mode: fresh-read the token at handoff (rotation-aware).
  const chk = checkScopeToken(st, req.scope);
  if (!chk.ok) {
    audit(st, "handoff-error", base(req), { err: chk.error });
    return { ok: false, error: runTokenFileError(st, req, chk) };
  }
  const token = chk.token;
  const kind = tokenKind(token);
  // Single use by construction: the state flip happens before the token
  // line is flushed — a second run on the same id gets `already used`.
  req.state = "handed-off";
  req.handedOffAt = st.now();
  st.secrets.register([token]);
  audit(st, "handoff", base(req), { kind });
  persist(st);
  return { ok: true, token, kind, req, timeoutS };
}

/** `done` line handling (second line of a run connection). */
export function patRunDone(
  st: PatVaultState,
  id: string,
  rc: number,
  socketModeToken: string | undefined,
): boolean {
  const req = st.requests.get(id);
  if (req?.state !== "handed-off" || req?.runRc !== undefined) return false;
  req.runRc = rc;
  audit(st, "done", base(req), { rc });
  persist(st);
  if (socketModeToken) {
    // max(commandDone, handoff) + grace — commandDone is now.
    scheduleCensorDrop(st, req, socketModeToken, st.censorGraceMs);
  }
  return true;
}

/** Connection closed / read-timed-out before done: the run never reported. */
export function patRunAbandon(
  st: PatVaultState,
  id: string,
  token: string | undefined,
): boolean {
  const req = st.requests.get(id);
  if (req?.state !== "handed-off" || req?.runRc !== undefined) return false;
  req.runRc = -1;
  audit(st, "done", base(req), { rc: -1 });
  persist(st);
  if (token) {
    try {
      st.secrets.drop([token]);
    } catch {
      // backstop: github pattern
    }
  }
  return true;
}

/** `status` op. The token is never in the output. */
export function patStatus(
  st: PatVaultState,
  line: any,
): Record<string, unknown> {
  const id = typeof line?.id === "string" ? line.id : "";
  if (id) {
    const req = st.requests.get(id);
    if (!req) return { ok: false, error: "unknown id" };
    const out: Record<string, unknown> = {
      ok: true,
      id: req.id,
      state: req.state,
      scope: req.scope,
      created: iso(req.created),
    };
    if (req.approvedAt) out.approved = iso(req.approvedAt);
    if (req.handedOffAt) out.handed_off = iso(req.handedOffAt);
    if (req.runRc !== undefined) out.run_rc = req.runRc;
    return out;
  }
  const agent =
    typeof line?.agent === "string" && line.agent ? line.agent : "unknown";
  const recent = (st.approvals[agent] ?? []).filter(
    (ts) => ts > st.now() - HOUR_MS,
  );
  return {
    ok: true,
    pending: [...st.requests.values()]
      .filter(
        (r) =>
          r.agent === agent &&
          (r.state === "pending" || r.state === "approved"),
      )
      .map((r) => {
        const o: Record<string, unknown> = {
          id: r.id,
          state: r.state,
          scope: r.scope,
        };
        if (r.claimDeadline) o.claim_deadline = iso(r.claimDeadline);
        return o;
      }),
    budget: { approvals_last_hour: recent.length, cap: st.budgetPerHour },
  };
}

// ─── Socket server (design §5: ~40 lines of line-buffering + dispatch) ────

function handleConnection(st: PatVaultState, sock: net.Socket): void {
  let buf = "";
  let lineCount = 0;
  let settled = false;
  let runCtx: {
    req: PatRequest;
    token: string | null;
    timeoutS: number;
  } | null = null;

  const send = (obj: Record<string, unknown>): void => {
    if (!settled && !sock.destroyed) {
      sock.write(`${JSON.stringify({ v: 1, ...obj })}\n`);
    }
  };

  const finish = (): void => {
    if (settled) return;
    settled = true;
    // done never arrived: settle the run as -1 and drop the censor secret.
    if (
      runCtx &&
      runCtx.req.state === "handed-off" &&
      runCtx.req.runRc === undefined
    ) {
      patRunAbandon(st, runCtx.req.id, runCtx.token ?? undefined);
    }
    try {
      sock.end();
    } catch {
      // already gone
    }
  };

  const onReadTimeout = (): void => {
    if (
      runCtx &&
      runCtx.req.state === "handed-off" &&
      runCtx.req.runRc === undefined
    ) {
      // done-wait expired (timeout_s + 30s): the child is dead or dying;
      // record -1 now so the connection close doesn't double-settle.
      patRunAbandon(st, runCtx.req.id, runCtx.token ?? undefined);
    }
    finish();
  };

  sock.setTimeout(BASE_READ_TIMEOUT_MS, onReadTimeout);
  sock.on("error", finish);
  sock.on("close", finish);

  sock.on("data", (d: Buffer) => {
    if (settled) return;
    buf += d.toString("utf-8");
    let idx = buf.indexOf("\n");
    while (idx >= 0) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      idx = buf.indexOf("\n");
      if (line.length > MAX_LINE_BYTES) {
        send({ ok: false, error: "usage: line too long (1 MB cap)" });
        return finish();
      }
      let parsed: any;
      try {
        parsed = JSON.parse(line);
      } catch {
        send({ ok: false, error: "usage: bad json" });
        return finish();
      }
      lineCount++;
      if (lineCount === 1) {
        if (parsed?.op === "request") {
          // Async reply: the connection is held until the POST resolves.
          // `continue` (not return) so any further line in the same chunk
          // still hits the too-many-lines guard below.
          void patRequest(st, parsed).then((r) => {
            send(r);
            finish();
          });
          continue;
        }
        if (parsed?.op === "status") {
          send(patStatus(st, parsed));
          return finish();
        }
        if (parsed?.op === "run") {
          const r = patRunBegin(st, parsed);
          if (!r.ok || !r.req || !r.timeoutS) {
            send({ ok: false, error: r.error });
            return finish();
          }
          runCtx = {
            req: r.req,
            token: r.token ?? null,
            timeoutS: r.timeoutS,
          };
          send(
            r.file
              ? { ok: true, file: true }
              : { ok: true, token: r.token, kind: r.kind },
          );
          // done-wait: the clamped timeout_s + 30s (N6). A coalesced
          // done line in the same chunk is handled on the next iteration.
          sock.setTimeout(
            r.timeoutS * 1000 + DONE_WAIT_EXTRA_MS,
            onReadTimeout,
          );
          continue;
        }
        send({ ok: false, error: "usage: unknown op" });
        return finish();
      }
      if (lineCount === 2 && runCtx) {
        if (parsed?.op !== "done") {
          send({ ok: false, error: "usage: expected done" });
          return finish();
        }
        const rc = typeof parsed.rc === "number" ? Math.trunc(parsed.rc) : -1;
        const done = patRunDone(
          st,
          runCtx.req.id,
          rc,
          st.transport === "socket" ? (runCtx.token ?? undefined) : undefined,
        );
        if (done) send({ ok: true });
        else send({ ok: false, error: "usage: run not active" });
        return finish();
      }
      send({
        ok: false,
        error: `usage: too many lines (max ${MAX_LINES_PER_CONN})`,
      });
      return finish();
    }
    if (buf.length > MAX_LINE_BYTES) {
      send({ ok: false, error: "usage: line too long (1 MB cap)" });
      return finish();
    }
  });
}

// ─── Component handler (design §5 — the F1 gate) ──────────────────────────

function markSeen(st: PatVaultState, id: string): boolean {
  if (st.seen.has(id)) return false;
  st.seen.set(id, st.now());
  if (st.seen.size > st.seenCap) {
    for (const k of st.seen.keys()) {
      if (st.seen.size <= st.seenCap) break;
      st.seen.delete(k);
    }
  }
  return true;
}

/** Deliver tap feedback via replyInteraction (visible in channel);
 *  when the transport fails, audit tap-feedback-failed (#204: a tap
 *  outcome whose feedback never reached the channel must be observable
 *  in audit.log, not only in the journal). pre/extra mirror the branch's
 *  own audit line so the failure reads as its decision. Never throws. */
async function tapReply(
  st: PatVaultState,
  d: any,
  text: string,
  pre: Record<string, unknown>,
  extra: Record<string, unknown>,
): Promise<boolean> {
  const ok = await replyInteraction(st.botToken, d, text);
  if (!ok)
    audit(st, "tap-feedback-failed", pre, {
      ...extra,
      interaction: String(d.id),
      text,
    });
  return ok;
}

function makeHandler(st: PatVaultState): (d: any) => Promise<void> {
  return async (d: any): Promise<void> => {
    let parsedId: string | undefined;
    try {
      // 1. Cheap stateless match FIRST (no defer, no callback for other
      //    buttons — the "Thinking" toast must not fire for non-vault
      //    components). Non-matching type-4 event → ignore entirely.
      const m = COMPONENT_RE.exec(String(d?.data?.custom_id ?? ""));
      // MESSAGE_COMPONENT is type 3 (current Discord spec; see vault.ts).
      if (d?.type !== 3 || !m) return;
      const verb = m[1];
      parsedId = `pat_${m[2]}`;

      // 2. Defer — the first network op; from here the callback is SPENT.
      await deferInteraction(st.botToken, d);

      // 3. Dedupe (gateway redelivery; tokens are single-use anyway).
      //    No second reply (the first tap already showed feedback), but
      //    audit it: a tap with no audit line is how the 2026-10-08
      //    mismatch bug stayed invisible.
      const uid = interactionUserId(d);
      if (!markSeen(st, String(d.id))) {
        audit(
          st,
          "tap-rejected",
          { id: parsedId },
          {
            reason: "duplicate",
            user: uid,
            verb,
          },
        );
        return;
      }

      // 4. Lookup. Miss → stale id / settled elsewhere.
      const req = st.requests.get(parsedId);
      if (!req) {
        const nf = {
          reason: "not-found",
          user: uid,
          verb,
          interaction: String(d.id),
        };
        audit(st, "tap-rejected", { id: parsedId }, nf);
        await tapReply(
          st,
          d,
          "[!] tap rejected: request not found or already handled",
          { id: parsedId },
          nf,
        );
        return;
      }

      // 5. Owner gate BEFORE the mismatch check (#204): a non-owner tap
      //    on a stale/forwarded button copy must audit as non-owner-tap,
      //    not be swallowed by mismatch. ownerUserIds preferred /
      //    ownerUserId legacy.
      if (!isOwnerUser(st.ch, uid)) {
        audit(st, "non-owner-tap", base(req), {
          user: uid,
          verb,
          interaction: String(d.id),
        });
        await tapReply(
          st,
          d,
          "[!] tap rejected: only the owner can approve PAT requests",
          base(req),
          { user: uid, verb, interaction: String(d.id) },
        );
        return;
      }

      // 6. Message + channel match (stale-copy / forwarded button).
      //    The live payload has NO d.message_id — per the Discord spec
      //    the component's message is the `message` field on the
      //    INTERACTION object itself (older payloads nested it in data).
      //    Reading d.message_id compared "undefined" against the req id,
      //    so every tap was rejected (RCA 2026-10-08). d.message_id is
      //    kept only as a defensive last resort.
      const srcMsgId = d?.message?.id ?? d?.data?.message?.id ?? d?.message_id;
      if (
        srcMsgId == null ||
        String(srcMsgId) !== String(req.messageId) ||
        String(d.channel_id) !== String(req.channelId)
      ) {
        const mm = {
          reason: "mismatch",
          user: uid,
          verb,
          expected_message: req.messageId,
          expected_channel: req.channelId,
          got_message: srcMsgId == null ? null : String(srcMsgId),
          got_channel: d.channel_id == null ? null : String(d.channel_id),
          interaction: String(d.id),
        };
        audit(st, "tap-rejected", base(req), mm);
        await tapReply(
          st,
          d,
          "[!] tap rejected: button not on the request message",
          base(req),
          mm,
        );
        return;
      }

      // 7. State gate.
      if (req.state !== "pending") {
        const sh = {
          reason: "already-handled",
          user: uid,
          verb,
          state: req.state,
          interaction: String(d.id),
        };
        audit(st, "tap-rejected", base(req), sh);
        await tapReply(
          st,
          d,
          "[!] tap rejected: already handled",
          base(req),
          sh,
        );
        return;
      }

      // 8. Transition (the only place state mutates).
      const now = st.now();
      if (verb === "approve") {
        // Pre-check the scope token file (BOTH transports). A dead file
        // is a visible outcome: a NON-ephemeral followup naming scope +
        // path + the exact next command. No state transition — the
        // request stays pending for a re-tap after the fix (M1: an
        // error followup is an outcome, not a rejection). Socket mode
        // still fresh-reads at handoff (rotation-aware); this gate only
        // makes a dead file visible at tap time.
        const chk = checkScopeToken(st, req.scope);
        if (!chk.ok) {
          audit(st, "vault-error", base(req), { user: uid, err: chk.error });
          await tapReply(st, d, tapTokenFileText(st, req, chk), base(req), {
            user: uid,
            verb,
            err: chk.error,
            interaction: String(d.id),
          });
          return;
        }
        if (st.transport === "file") {
          // No run-time handoff in file mode: the censor window opens at
          // approve (N5) and drops at claimDeadline + grace.
          st.secrets.register([chk.token]);
          publishTokenFile(st, req.id, chk.token);
          track(
            st,
            req.id,
            setTimeout(
              () => {
                try {
                  st.secrets.drop([chk.token]);
                } catch {
                  // github pattern backstop
                }
              },
              Math.max(0, st.claimMs + st.censorGraceMs),
            ),
          );
        }
        req.state = "approved";
        req.approvedAt = now;
        req.claimDeadline = now + st.claimMs;
        const approvals = st.approvals[req.agent] ?? [];
        approvals.push(now);
        st.approvals[req.agent] = approvals;
        armClaim(st, req);
        audit(st, "approve", base(req), { user: uid });
        persist(st);
        await editRequestMessage(st, req, approvedText(req), [], "approved");
      } else {
        req.state = "denied";
        req.deniedBy = uid;
        audit(st, "deny", base(req), { user: uid });
        persist(st);
        await editRequestMessage(
          st,
          req,
          deniedText(interactionUserName(d) ?? uid),
          [],
          "denied",
        );
      }
      await deleteDeferredAck(st.botToken, d);
    } catch (e) {
      // M1: never reject. Log + audit + best-effort deliverable feedback.
      console.error("[interactions] vault handler failed:", e);
      const err = String(e);
      audit(
        st,
        "vault-error",
        { id: parsedId },
        {
          err,
          user: interactionUserId(d),
          interaction: String(d.id),
        },
      );
      await tapReply(
        st,
        d,
        "[!] vault error",
        { id: parsedId },
        { err, user: interactionUserId(d), interaction: String(d.id) },
      );
    }
  };
}

// ─── Persistence load / recovery ──────────────────────────────────────────

function load(st: PatVaultState): void {
  let doc: any;
  try {
    doc = JSON.parse(fs.readFileSync(st.stateFile, "utf-8"));
  } catch {
    return; // first start
  }
  const now = st.now();
  for (const [id, raw] of Object.entries<any>(doc.requests ?? {})) {
    const r: PatRequest = { ...raw, id };
    st.requests.set(id, r);
    if (r.state === "pending") {
      // #203: ttlDeadline 0 = no TTL → never expired. A past deadline
      // only settles when a TTL is configured (explicit env override).
      if (st.ttlMs > 0 && r.ttlDeadline > 0 && r.ttlDeadline <= now) {
        r.state = "expired";
        r.expiredKind = "ttl";
        audit(st, "recovered-expired", base(r));
        void editRequestMessage(st, r, ttlExpiredText(st), [], "expired");
      } else {
        armTtl(st, r); // no-op when ttlMs === 0
      }
    } else if (r.state === "approved") {
      if (r.claimDeadline && r.claimDeadline <= now) {
        r.state = "expired";
        r.expiredKind = "claim";
        if (st.transport === "file") unlinkPublished(st, id);
        audit(st, "recovered-expired", base(r));
        void editRequestMessage(st, r, claimExpiredText(), [], "expired");
      } else {
        armClaim(st, r);
      }
    }
  }
  if (doc.approvals && typeof doc.approvals === "object") {
    st.approvals = doc.approvals;
  }
  if (doc.seen && typeof doc.seen === "object") {
    for (const [k, ts] of Object.entries<any>(doc.seen)) {
      if (typeof ts === "number" && now - ts < SEEN_FRESH_MS)
        st.seen.set(k, ts);
    }
  }
  persist(st);
}

// ─── start / stop (design §9) ─────────────────────────────────────────────

function stopVaultCore(st: PatVaultState): void {
  st.stopped = true;
  persist(st);
  for (const arr of st.timers.values()) {
    for (const t of arr) clearTimeout(t);
  }
  st.timers.clear();
  st.server?.close();
  st.server = null;
}

/** Start (or reuse, L4) the vault for this channel. The first instance
 *  per socket path performs the startup sweep + socket bind; later
 *  instances in the same process share state and server. Refcounted: the
 *  server closes, timers clear, and state persists only when the LAST
 *  instance stops. */
export function startPatVault(opts: StartPatVaultOpts): PatVaultHandle {
  const home = process.env.HOME || os.homedir();
  const xdg =
    opts.xdgDir ??
    process.env.XDG_RUNTIME_DIR ??
    path.join("/run/user", String(process.getuid ? process.getuid() : 0));
  const socketDir =
    opts.socketDir ?? process.env.JARATE_PAT_DIR ?? path.join(xdg, "jarate");
  const socketPath = path.join(socketDir, "pat.sock");
  const existing = vaultEntries.get(socketPath);
  if (existing) {
    existing.refs += 1;
    return makeHandle(existing.vault);
  }

  const st: PatVaultState = {
    ch: opts.ch,
    botToken: opts.botToken,
    transport:
      opts.transport ??
      (process.env.JARATE_PAT_TRANSPORT === "file" ? "file" : "socket"),
    now: opts.now ?? (() => Date.now()),
    secrets: {
      register: opts.secrets?.register ?? registerRuntimeSecrets,
      drop: opts.secrets?.drop ?? dropRuntimeSecrets,
    },
    // #203: 0 = no TTL (pending is BLOCKING until tap).
    // Explicit JARATE_PAT_TTL_MS override still works exactly as before.
    ttlMs: envNum("JARATE_PAT_TTL_MS", 0),
    claimMs: envNum("JARATE_PAT_CLAIM_MS", 60_000),
    maxPending: envNum("JARATE_PAT_MAX_PENDING", 1),
    budgetPerHour: envNum("JARATE_PAT_BUDGET_PER_HOUR", 5),
    censorGraceMs: envNum("JARATE_PAT_CENSOR_GRACE_MS", 10_000),
    seenCap: envNum("JARATE_PAT_SEEN_CAP", 500),
    stateDir: opts.stateDir,
    stateFile: path.join(opts.stateDir, "pat-vault.json"),
    socketDir,
    socketPath,
    fileDir:
      opts.fileDir ??
      process.env.JARATE_PAT_FILE_DIR ??
      path.join(xdg, "jarate-pat"),
    patsDir:
      opts.patsDir ??
      process.env.JARATE_PAT_PATS_DIR ??
      path.join(home, ".config", "marzukia-pats"),
    defaultPatFile:
      opts.defaultPatFile ??
      path.join(
        path.dirname(
          opts.patsDir ?? path.join(home, ".config", "marzukia-pats"),
        ),
        "marzukia-pat",
      ),
    auditFile:
      opts.auditFile ??
      process.env.JARATE_PAT_AUDIT_FILE ??
      path.join(home, ".jarate", "pat-audit.log"),
    auditDir: path.dirname(
      opts.auditFile ??
        process.env.JARATE_PAT_AUDIT_FILE ??
        path.join(home, ".jarate", "pat-audit.log"),
    ),
    requests: new Map(),
    approvals: {},
    seen: new Map(),
    timers: new Map(),
    server: null,
    stopped: false,
  };

  startupSweep(st);
  load(st);
  const ready = bindSocket(st);
  vaultEntries.set(socketPath, { vault: st, refs: 1 });
  return makeHandle(st, ready);
}

function makeHandle(st: PatVaultState, ready?: Promise<void>): PatVaultHandle {
  return {
    vault: st,
    ready: ready ?? Promise.resolve(),
    handlePatComponent: makeHandler(st),
  };
}

/** Stop one channel's vault handle (refcounted; L4). */
export function stopPatVault(h: PatVaultHandle): void {
  const entry = vaultEntries.get(h.vault.socketPath);
  if (!entry) return;
  entry.refs -= 1;
  if (entry.refs > 0) return;
  vaultEntries.delete(h.vault.socketPath);
  stopVaultCore(h.vault);
}
