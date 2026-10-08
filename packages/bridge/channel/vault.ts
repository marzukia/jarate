/**
 * Vault — generic credential vault with approval levels (design:
 * docs/vault-design.md). Generalizes the PAT vault (pat-vault.ts) to
 * multiple credential kinds (github-pat, api-key, password) and three
 * approval levels (one-shot, time-boxed, permanent).
 *
 * Security invariants (design §2.8 — preserved from the PAT flow):
 *   1. Never-echo: the value is in at most 3 places at once (bridge
 *      memory, wrapper, one child's env). Never argv, never status,
 *      never state.json, never the audit log, never the LLM context.
 *   2. One-shot single-use by construction: state flip to `consumed`
 *      happens BEFORE the value line is flushed.
 *   3. Owner-approval gate: only owner taps approve/deny/revoke;
 *      non-owner taps are ephemeral-replied + audit-logged, state
 *      untouched. Agent self-revoke via the `vrevoke` op (actor must be
 *      the requesting agent).
 *   4. Every value lifetime is timer-owned by the bridge (TTL 5m, claim
 *      60s, window N hours, censor grace 10s, startup sweep) with lazy
 *      expiry checks on every run — restart-safe.
 *   5. Budget + pending caps enforced here (bridge), not in the CLI.
 *   6. Egress censor: values are registered as runtime secrets for
 *      their whole lifetime.
 *   7. Storage: 0700 dirs, 0600 files, atomic writes (mkstemp + rename),
 *      no secret in any filename.
 *
 * Additive: the PAT vault (pat-*) is untouched.
 *
 * Runbook: docs/VAULT.md.
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
  replyInteraction,
  sendDiscordMessage,
} from "./discord";
import { hasOwnerConfigured, isOwnerUser } from "./index";
import type { ChannelConfig } from "./types";

// ─── Constants (env-overridable for tests) ───────────────────────────────

export type VaultKind = "github-pat" | "api-key" | "password";
export type VaultLevel = "one-shot" | "time-boxed" | "permanent";
export type VaultCredentialState =
  | "pending"
  | "active"
  | "consumed"
  | "expired"
  | "denied"
  | "revoked";

const KINDS: VaultKind[] = ["github-pat", "api-key", "password"];
const LEVELS: VaultLevel[] = ["one-shot", "time-boxed", "permanent"];
const SCOPE_RE =
  /^(default|[A-Za-z0-9_.-]{1,39}\/[A-Za-z0-9_.-]{1,100}:(read|write))$/;
const NAME_RE = /^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/;
const ENVVAR_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const TOKEN_RE =
  /^(gh[pousr]_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{22,255})$/;
const COMPONENT_RE = /^vault:(approve|deny|revoke):vault_([0-9a-f-]{36})$/;
const HOUR_MS = 3_600_000;
const MAX_LINE_BYTES = 1_000_000;
const MAX_LINES_PER_CONN = 4;
const BASE_READ_TIMEOUT_MS = 5_000;
const DONE_WAIT_EXTRA_MS = 30_000;
const SEEN_FRESH_MS = 10 * 60_000;
const TERMINAL_KEEP = 50;
const APPROVALS_KEEP = 50;
const LABEL_MAX = 80;
const VALUE_MAX = 4096;

function envNum(name: string, def: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : def;
}

// ─── Types ────────────────────────────────────────────────────────────────

export interface VaultCredential {
  id: string; // "vault_" + crypto.randomUUID() (no secret in the id)
  agent: string; // self-attested from the request line
  kind: VaultKind;
  name: string;
  label: string;
  level: VaultLevel;
  hours: number; // time-boxed only
  envvar: string; // child env var (default GH_TOKEN for github-pat)
  fromEnv?: string; // BYO source var name (not the value)
  valueSource: "known" | "stored";
  reason: string;
  channelId: string;
  messageId: string; // the button message, for match checks
  state: VaultCredentialState;
  created: number; // epoch ms
  ttlDeadline: number; // created + ttlMs
  claimDeadline?: number; // one-shot: approvedAt + claimMs
  approvedAt?: number;
  expiresAt?: number; // time-boxed: approvedAt + hours
  consumedAt?: number;
  revokedBy?: string;
  deniedBy?: string;
  lastRc?: number;
  useCount: number;
  runsInFlight: number; // concurrent runs (time-boxed/permanent)
  expiredKind?: "ttl" | "claim" | "window";
}

export interface VaultState {
  ch: ChannelConfig;
  botToken: string;
  transport: "socket" | "file";
  now: () => number;
  secrets: { register: (l: string[]) => void; drop: (l: string[]) => void };
  ttlMs: number;
  claimMs: number;
  hourMs: number;
  maxPending: number;
  budgetPerHour: number;
  censorGraceMs: number;
  seenCap: number;
  vaultDir: string;
  stateFile: string;
  auditFile: string;
  auditDir: string;
  knownDir: string;
  secretsDir: string;
  socketDir: string;
  socketPath: string;
  fileDir: string;
  legacyPatsDir: string;
  legacyDefaultPatFile: string;
  credentials: Map<string, VaultCredential>;
  approvals: Record<string, number[]>;
  seen: Map<string, number>;
  timers: Map<string, ReturnType<typeof setTimeout>[]>;
  server: net.Server | null;
  stopped: boolean;
}

export interface StartVaultOpts {
  pi?: unknown;
  ctx?: unknown;
  ch: ChannelConfig;
  botToken: string;
  stateDir: string;
  xdgDir?: string;
  vaultDir?: string;
  knownDir?: string;
  secretsDir?: string;
  stateFile?: string;
  auditFile?: string;
  socketDir?: string;
  fileDir?: string;
  legacyPatsDir?: string;
  legacyDefaultPatFile?: string;
  transport?: "socket" | "file";
  now?: () => number;
  secrets?: { register?: (l: string[]) => void; drop?: (l: string[]) => void };
}

export interface VaultHandle {
  vault: VaultState;
  ready: Promise<void>;
  handleVaultComponent: (d: any) => Promise<void>;
}

// ─── Module-level instance registry (once per process per socket) ────────

const vaultEntries = new Map<string, { vault: VaultState; refs: number }>();

/** Test hook: stop every live vault and clear the module registry. */
export function __vaultResetForTest(): void {
  for (const entry of [...vaultEntries.values()]) {
    stopVaultCore(entry.vault);
  }
  vaultEntries.clear();
}

/** Test hook: drop the registry entry for a path WITHOUT stopping the
 *  server, so a later startVault on the same path performs a real bind
 *  against a live listener (issue #128 fix 2). */
export function __vaultDetachForTest(socketPath: string): void {
  vaultEntries.delete(socketPath);
}

// ─── Small helpers ────────────────────────────────────────────────────────

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function timeOfDay(ms: number): string {
  return new Date(ms).toISOString().slice(11, 19);
}

function actorAgent(agent: string): string {
  return `agent:${agent}`;
}
function actorDiscord(uid: string): string {
  return `discord:${uid}`;
}

/** Append-only audit line: one JSON object per line, ts + actor always.
 *  The value never appears here (kind/name/envvar only). Never breaks
 *  the flow. */
function audit(
  st: VaultState,
  event: string,
  pre: Record<string, unknown>,
  extra?: Record<string, unknown>,
): void {
  try {
    if (!fs.existsSync(st.auditDir)) {
      fs.mkdirSync(st.auditDir, { recursive: true, mode: 0o700 });
      fs.chmodSync(st.auditDir, 0o700);
    }
    const doc: Record<string, unknown> = { ts: iso(st.now()), event };
    for (const [k, v] of Object.entries(pre)) {
      if (v !== undefined && v !== null) doc[k] = v;
    }
    for (const [k, v] of Object.entries(extra ?? {})) {
      if (v !== undefined && v !== null) doc[k] = v;
    }
    fs.appendFileSync(st.auditFile, `${JSON.stringify(doc)}\n`, {
      encoding: "utf-8",
    });
    fs.chmodSync(st.auditFile, 0o600);
  } catch {
    // audit never breaks the flow
  }
}

/** Base audit fields for a credential. */
function credFields(c: VaultCredential): Record<string, unknown> {
  return {
    id: c.id,
    agent: c.agent,
    kind: c.kind,
    name: c.name,
    level: c.level,
  };
}

function persist(st: VaultState): void {
  try {
    fs.mkdirSync(path.dirname(st.stateFile), { recursive: true, mode: 0o700 });
    // Terminal records pruned to the last 50 (oldest dropped first).
    const all = [...st.credentials.values()];
    const terminal = all
      .filter((c) =>
        ["consumed", "expired", "denied", "revoked"].includes(c.state),
      )
      .sort((a, b) => a.created - b.created);
    const dropIds = new Set(
      terminal
        .slice(0, Math.max(0, terminal.length - TERMINAL_KEEP))
        .map((c) => c.id),
    );
    for (const id of dropIds) st.credentials.delete(id);
    const freshSeen = [...st.seen.entries()]
      .filter(([, ts]) => st.now() - ts < SEEN_FRESH_MS)
      .slice(-st.seenCap);
    const approvalsKeep = Math.max(APPROVALS_KEEP, st.budgetPerHour);
    for (const [agent, arr] of Object.entries(st.approvals)) {
      if (Array.isArray(arr) && arr.length > approvalsKeep) {
        st.approvals[agent] = arr.slice(-approvalsKeep);
      }
    }
    const doc = {
      v: 1,
      credentials: Object.fromEntries(st.credentials),
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
    console.error("[vault] persist failed:", e);
  }
}

// ─── Known store (design §2.4) ────────────────────────────────────────────

function walkFiles(dir: string, out: string[]): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walkFiles(p, out);
    else if (e.isFile()) out.push(p);
  }
}

/** Relative (slash-joined) names of all files under dir. */
function relNames(dir: string): string[] {
  const abs: string[] = [];
  walkFiles(dir, abs);
  return abs.map((p) => path.relative(dir, p).split(path.sep).join("/"));
}

/** Known names for a kind (for reject messages). github-pat includes the
 *  legacy PAT store (default + pats dir) so existing boxes keep working. */
export function knownNames(st: VaultState, kind: VaultKind): string[] {
  const out: string[] = [];
  const kindDir = path.join(st.knownDir, kind);
  if (kind === "github-pat") {
    if (
      fs.existsSync(st.legacyDefaultPatFile) ||
      fs.existsSync(path.join(kindDir, "default"))
    ) {
      out.push("default");
    }
    for (const n of relNames(kindDir)) {
      if (SCOPE_RE.test(n) && !out.includes(n)) out.push(n);
    }
    for (const n of relNames(st.legacyPatsDir)) {
      if (SCOPE_RE.test(n) && !out.includes(n)) out.push(n);
    }
  } else {
    for (const n of relNames(kindDir)) {
      if (NAME_RE.test(n) && n.length <= 128 && !out.includes(n)) out.push(n);
    }
  }
  return out;
}

/** Candidate value files for a known credential, in precedence order. */
function knownPaths(st: VaultState, kind: VaultKind, name: string): string[] {
  const paths = [path.join(st.knownDir, kind, name)];
  if (kind === "github-pat") {
    if (name === "default") paths.push(st.legacyDefaultPatFile);
    else paths.push(path.join(st.legacyPatsDir, name));
  }
  return paths;
}

/** Read the known value file: first line, trimmed, non-empty. Throws when
 *  no candidate exists (rotation-aware: read fresh at every handoff). */
export function readKnownValue(
  st: VaultState,
  kind: VaultKind,
  name: string,
): string {
  for (const p of knownPaths(st, kind, name)) {
    if (!fs.existsSync(p)) continue;
    const raw = fs.readFileSync(p, "utf-8");
    const value = raw.split("\n")[0].trim();
    if (!value) throw new Error(`empty value file: ${p}`);
    return value;
  }
  throw new Error(`no value file for ${kind}/${name}`);
}

export function validateValueShape(kind: VaultKind, value: string): boolean {
  if (value.length === 0 || value.length > VALUE_MAX) return false;
  if (value.includes("\n") || value.includes("\r")) return false;
  if (kind === "github-pat") return TOKEN_RE.test(value);
  if (kind === "api-key") return !/[ \t]/.test(value);
  return true; // password
}

// ─── Stored (BYO) value files ─────────────────────────────────────────────

function valuePath(st: VaultState, id: string): string {
  return path.join(st.secretsDir, `${id}.secret`);
}

/** mkstemp-in-dir → write → close → rename(2): atomic, same fs, 0600. */
export function writeValueFile(
  st: VaultState,
  id: string,
  value: string,
): string {
  fs.mkdirSync(st.secretsDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(st.secretsDir, 0o700);
  const finalPath = valuePath(st, id);
  const tmp = path.join(
    st.secretsDir,
    `.${id}.tmp-${process.pid}-${crypto.randomBytes(4).toString("hex")}`,
  );
  const fd = fs.openSync(tmp, "w", 0o600);
  try {
    // Exact bytes — no newline (values may carry edge spaces;
    // readValueFile must round-trip them).
    fs.writeSync(fd, value);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, finalPath);
  return finalPath;
}

export function readValueFile(st: VaultState, id: string): string {
  const raw = fs.readFileSync(valuePath(st, id), "utf-8");
  if (raw.length === 0)
    throw new Error(`empty value file: ${valuePath(st, id)}`);
  return raw;
}

function deleteValueFile(st: VaultState, id: string): void {
  try {
    fs.unlinkSync(valuePath(st, id));
  } catch {
    // already gone
  }
}

// ─── File-mode publish (transport fallback) ───────────────────────────────

function publishedPath(st: VaultState, id: string): string {
  return path.join(st.fileDir, `vault-${id}`);
}

/** Publish a JSON doc {value, kind, envvar, git_header} — the metadata is
 *  not secret, the value is the only sensitive field. Atomic, 0600. The
 *  BRIDGE owns deletion (multi-use levels re-read it). */
function publishDoc(
  st: VaultState,
  id: string,
  value: string,
  kind: VaultKind,
  envvar: string,
): string {
  fs.mkdirSync(st.fileDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(st.fileDir, 0o700);
  const finalPath = publishedPath(st, id);
  const tmp = path.join(
    st.fileDir,
    `.vault-${id}.tmp-${process.pid}-${crypto.randomBytes(4).toString("hex")}`,
  );
  const fd = fs.openSync(tmp, "w", 0o600);
  try {
    fs.writeSync(
      fd,
      JSON.stringify({
        value,
        kind,
        envvar,
        git_header: kind === "github-pat",
      }),
    );
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, finalPath);
  return finalPath;
}

function unlinkPublished(st: VaultState, id: string): void {
  try {
    fs.unlinkSync(publishedPath(st, id));
  } catch {
    // already gone (sweep / terminal settle raced)
  }
}

function startupSweep(st: VaultState): void {
  let n = 0;
  try {
    if (fs.existsSync(st.fileDir)) {
      n = fs.readdirSync(st.fileDir).length;
      fs.rmSync(st.fileDir, { recursive: true, force: true });
    }
  } catch (e) {
    audit(
      st,
      "vault-error",
      { actor: "system" },
      { err: `sweep: ${String(e)}` },
    );
  }
  try {
    fs.mkdirSync(st.fileDir, { recursive: true, mode: 0o700 });
    fs.chmodSync(st.fileDir, 0o700);
  } catch (e) {
    audit(
      st,
      "vault-error",
      { actor: "system" },
      { err: `filedir: ${String(e)}` },
    );
  }
  audit(st, "sweep", { actor: "system" }, { n });
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

function bindSocket(st: VaultState): Promise<void> {
  return (async () => {
    try {
      fs.mkdirSync(st.socketDir, { recursive: true, mode: 0o700 });
      fs.chmodSync(st.socketDir, 0o700);
    } catch (e) {
      audit(
        st,
        "vault-error",
        { actor: "system" },
        { err: `socket dir: ${String(e)}` },
      );
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
          audit(
            st,
            "vault-error",
            { actor: "system" },
            { err: `server: ${e.message}` },
          );
        });
        st.server = srv;
        return;
      } catch (e: any) {
        if (livePeer) {
          // The listen failed (EADDRINUSE) because the path is owned by
          // a live server we did not unlink. Do not stomp it: surface
          // clearly, run request-only (posts + taps + edits still work).
          audit(
            st,
            "vault-error",
            { actor: "system" },
            {
              err: `socket ${st.socketPath} owned by a live server (probe connected); not unlinking — is another pi/daemon running?`,
            },
          );
          return;
        }
        if (e?.code !== "EADDRINUSE" || attempt === 2) {
          // Request-only (socket down): posts + taps + edits still work.
          audit(
            st,
            "vault-error",
            { actor: "system" },
            {
              err: `bind: ${e?.code ?? String(e)}`,
            },
          );
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
  st: VaultState,
  id: string,
  t: ReturnType<typeof setTimeout>,
): void {
  const arr = st.timers.get(id) ?? [];
  arr.push(t);
  st.timers.set(id, arr);
  t.unref?.();
}

function clearTimersFor(st: VaultState, id: string): void {
  const arr = st.timers.get(id);
  if (arr) {
    for (const t of arr) clearTimeout(t);
    st.timers.delete(id);
  }
}

function scheduleCensorDrop(
  st: VaultState,
  id: string,
  value: string,
  delayMs: number,
): void {
  track(
    st,
    id,
    setTimeout(
      () => {
        try {
          st.secrets.drop([value]);
        } catch {
          // drop is best-effort
        }
      },
      Math.max(0, delayMs),
    ),
  );
}

/** Terminal settle for stored values: read the literal off disk, delete
 *  the value file, schedule the censor drop after the grace window. */
function settleStoredValueFromDisk(st: VaultState, c: VaultCredential): void {
  if (c.valueSource !== "stored") return;
  let value: string | null = null;
  try {
    value = fs.readFileSync(valuePath(st, c.id), "utf-8").split("\n")[0].trim();
  } catch {
    // missing: nothing to delete or drop
  }
  deleteValueFile(st, c.id);
  if (value) scheduleCensorDrop(st, c.id, value, st.censorGraceMs);
}

function settleTtl(st: VaultState, id: string): void {
  const c = st.credentials.get(id);
  if (c?.state !== "pending") return;
  c.state = "expired";
  c.expiredKind = "ttl";
  clearTimersFor(st, id);
  settleStoredValueFromDisk(st, c);
  audit(st, "expire", credFields(c), {
    actor: "system",
    reason: "ttl",
  });
  persist(st);
  void editCredentialMessage(
    st,
    c,
    `unanswered (${ttlText(st, c)})`,
    [],
    "expired",
  ).catch(() => {});
}

function settleClaim(st: VaultState, id: string): void {
  const c = st.credentials.get(id);
  if (c?.state !== "active") return;
  c.state = "expired";
  c.expiredKind = "claim";
  clearTimersFor(st, id);
  settleStoredValueFromDisk(st, c);
  audit(st, "expire", credFields(c), { actor: "system", reason: "claim" });
  persist(st);
  void editCredentialMessage(st, c, "claim window missed", [], "expired").catch(
    () => {},
  );
}

function settleWindow(st: VaultState, id: string): void {
  const c = st.credentials.get(id);
  if (c?.state !== "active") return;
  c.state = "expired";
  c.expiredKind = "window";
  clearTimersFor(st, id);
  settleStoredValueFromDisk(st, c);
  audit(st, "expire", credFields(c), { actor: "system", reason: "window" });
  persist(st);
  void editCredentialMessage(st, c, "window ended", [], "expired").catch(
    () => {},
  );
}

function armTtl(st: VaultState, c: VaultCredential): void {
  track(
    st,
    c.id,
    setTimeout(
      () => settleTtl(st, c.id),
      Math.max(0, c.ttlDeadline - st.now()),
    ),
  );
}

function armClaim(st: VaultState, c: VaultCredential): void {
  track(
    st,
    c.id,
    setTimeout(
      () => settleClaim(st, c.id),
      Math.max(0, (c.claimDeadline ?? 0) - st.now()),
    ),
  );
}

function armWindow(st: VaultState, c: VaultCredential): void {
  track(
    st,
    c.id,
    setTimeout(
      () => settleWindow(st, c.id),
      Math.max(0, (c.expiresAt ?? 0) - st.now()),
    ),
  );
}

// ─── Discord message text ─────────────────────────────────────────────────

function ttlText(st: VaultState, _c: VaultCredential): string {
  const m = Math.round(st.ttlMs / 60_000);
  return m > 0 ? `${m}m` : `${st.ttlMs}ms`;
}

function pendingButtons(id: string): Array<Record<string, unknown>> {
  return [
    {
      type: 1,
      components: [
        {
          type: 2,
          style: 1,
          label: "Approve",
          custom_id: `vault:approve:${id}`,
        },
        { type: 2, style: 4, label: "Deny", custom_id: `vault:deny:${id}` },
      ],
    },
  ];
}

function revokeButtons(id: string): Array<Record<string, unknown>> {
  return [
    {
      type: 1,
      components: [
        { type: 2, style: 4, label: "Revoke", custom_id: `vault:revoke:${id}` },
      ],
    },
  ];
}

// ─── Discord message (embed) ───────────────────────────────────────────────
// 2026-10-01 (Andryo): request/status messages ship as a Discord embed
// ("proper chat container"), not a wall of plain text. Content line stays
// short + copyable; all detail lives in the embed.

const EMBED_COLOR: Record<string, number> = {
  pending: 0xf1c40f,
  approved: 0x2ecc71,
  used: 0x2ecc71,
  denied: 0xe74c3c,
  expired: 0x95a5a6,
  revoked: 0x95a5a6,
};

function levelText(st: VaultState, c: VaultCredential): string {
  if (c.level === "one-shot")
    return `one-shot (single use) — claim by ${timeOfDay(
      c.claimDeadline ?? c.ttlDeadline,
    )}Z (${Math.round(st.claimMs / 1000)}s)`;
  if (c.level === "time-boxed")
    return `time-boxed (${c.hours}h, reusable) — active until ${timeOfDay(
      c.expiresAt ?? 0,
    )}Z`;
  return "permanent (until revoked)";
}

/** Embed for the request/status message. `status` selects title + color. */
function credEmbed(
  st: VaultState,
  c: VaultCredential,
  status: string,
): Record<string, unknown> {
  const fields: Array<Record<string, unknown>> = [
    { name: "kind", value: String(c.kind), inline: true },
    { name: "name", value: String(c.name), inline: true },
    { name: "level", value: levelText(st, c), inline: false },
  ];
  if (c.label)
    fields.push({ name: "label", value: String(c.label), inline: false });
  if (status === "pending") {
    fields.push({ name: "envvar", value: String(c.envvar), inline: true });
    fields.push({
      name: "reason",
      value: String(c.reason || "—"),
      inline: false,
    });
  }
  const titles: Record<string, string> = {
    pending: `VAULT request — ${c.agent}`,
    approved: `VAULT approved — ${c.agent}`,
    denied: `VAULT denied — ${c.agent}`,
    expired: `VAULT expired — ${c.agent}`,
    revoked: `VAULT revoked`,
    used: `VAULT used`,
  };
  let footer = c.id;
  if (status === "pending")
    footer = `expires ${timeOfDay(c.ttlDeadline)}Z (${ttlText(st, c)}) · ${c.id}`;
  return {
    title: titles[status] ?? titles.pending,
    color: EMBED_COLOR[status] ?? EMBED_COLOR.pending,
    fields,
    footer: { text: footer },
  };
}

function approvedText(c: VaultCredential): string {
  return `jarate vault-run ${c.id} -- <cmd>`;
}

function deniedText(_c: VaultCredential, username: string): string {
  return `denied by ${username}`;
}

function revokedText(_c: VaultCredential, who: string): string {
  return `revoked by ${who}`;
}

function usedText(c: VaultCredential): string {
  return `used (rc ${c.lastRc ?? -1})`;
}

/** Edit the request's button message; components: [] kills the buttons;
 *  the embed is replaced in place so the color tracks the status. */
async function editCredentialMessage(
  st: VaultState,
  c: VaultCredential,
  text: string,
  components: Array<Record<string, unknown>> = [],
  status: string = "pending",
): Promise<void> {
  if (!c.messageId) return;
  const res = await editDiscordMessage(st.ch, c.messageId, text, {
    components,
    embeds: [credEmbed(st, c, status)],
  });
  if (!res.success) {
    console.error(`[vault] edit failed for ${c.id}:`, res.error);
  }
}

// ─── Request-time validation (design §2.5) ────────────────────────────────

export interface VaultRequestLine {
  agent?: string;
  kind?: string;
  name?: string;
  level?: string;
  label?: string;
  hours?: number;
  envvar?: string;
  from_env?: string;
  value?: string;
  reason?: string;
}

/** Validate a request line. Returns the normalized field set or a usage
 *  error string. The value is NOT part of the return (it is never kept in
 *  state). */
export function validateRequestLine(line: VaultRequestLine):
  | {
      ok: true;
      kind: VaultKind;
      name: string;
      level: VaultLevel;
      label: string;
      hours: number;
      envvar: string;
      fromEnv?: string;
      reason: string;
    }
  | { ok: false; error: string } {
  const kind = line.kind;
  const name = line.name;
  const level = line.level;
  if (!kind || !KINDS.includes(kind as VaultKind)) {
    return {
      ok: false,
      error: `usage: kind must be one of ${KINDS.join(", ")}`,
    };
  }
  if (
    !name ||
    (kind === "github-pat"
      ? !SCOPE_RE.test(name)
      : !NAME_RE.test(name) || name.length > 128)
  ) {
    return {
      ok: false,
      error:
        kind === "github-pat"
          ? "usage: name must be 'default' or <owner>/<repo>:read|write"
          : "usage: name: 1-128 of [A-Za-z0-9_.-/]",
    };
  }
  if (!level || !LEVELS.includes(level as VaultLevel)) {
    return {
      ok: false,
      error: `usage: level must be one of ${LEVELS.join(", ")}`,
    };
  }
  let hours = 0;
  if (level === "time-boxed") {
    hours = line.hours ?? 0;
    if (!Number.isInteger(hours) || hours < 1 || hours > 72) {
      return { ok: false, error: "usage: time-boxed needs --hours 1..72" };
    }
  } else if (line.hours !== undefined) {
    return { ok: false, error: "usage: --hours only applies to time-boxed" };
  }
  let envvar = line.envvar ?? "";
  if (kind === "github-pat" && !envvar) envvar = "GH_TOKEN";
  if (!envvar || !ENVVAR_RE.test(envvar)) {
    return {
      ok: false,
      error: `usage: envvar ${
        kind === "github-pat" ? "must be a valid identifier" : "is required"
      }`,
    };
  }
  const label = line.label ?? "";
  if (label.length > 0 && (label.length > LABEL_MAX || /[\n\r]/.test(label))) {
    return { ok: false, error: "usage: label: 1-80 chars, no newlines" };
  }
  const fromEnv = line.from_env;
  if (fromEnv !== undefined && (fromEnv === "" || !ENVVAR_RE.test(fromEnv))) {
    return { ok: false, error: "usage: from_env must be a valid identifier" };
  }
  const reason = line.reason ?? "";
  if (reason.length < 3 || reason.length > 200) {
    return { ok: false, error: "usage: reason must be 3-200 chars" };
  }
  return {
    ok: true,
    kind: kind as VaultKind,
    name,
    level: level as VaultLevel,
    label,
    hours,
    envvar,
    fromEnv,
    reason,
  };
}

// ─── State machine: request / run / status / revoke ───────────────────────

export interface VaultRunBeginResult {
  ok: boolean;
  error?: string;
  file?: boolean;
  token?: string;
  kind?: VaultKind;
  envvar?: string;
  git_header?: boolean;
  cred?: VaultCredential;
  timeoutS?: number;
}

/** `vrequest` op. Registers the record + BYO value file BEFORE the
 *  Discord POST; a failed POST cleans up (retry is safe — nothing posted). */
export async function vaultRequest(
  st: VaultState,
  line: VaultRequestLine,
): Promise<Record<string, unknown>> {
  const agent =
    typeof line?.agent === "string" && line.agent ? line.agent : "unknown";
  const v = validateRequestLine(line ?? {});
  if (!v.ok) return { ok: false, error: v.error };

  // Value source resolution (known: file must exist; stored: value arrives
  // on the request line).
  let storedValue: string | null = null;
  let valueSource: "known" | "stored";
  if (v.fromEnv) {
    const raw = line.value;
    if (typeof raw !== "string" || raw === "") {
      return {
        ok: false,
        error: `usage: value for --from-env ${v.fromEnv} missing or empty`,
      };
    }
    if (!validateValueShape(v.kind, raw)) {
      return {
        ok: false,
        error: `value: shape invalid for ${v.kind} (length 1-${VALUE_MAX})`,
      };
    }
    storedValue = raw;
    valueSource = "stored";
  } else {
    valueSource = "known";
    try {
      readKnownValue(st, v.kind, v.name);
    } catch {
      audit(st, "scope-reject", {
        agent,
        kind: v.kind,
        name: v.name,
        actor: actorAgent(agent),
      });
      return {
        ok: false,
        error: `known: no value file for ${v.kind}/${v.name} (known: ${
          knownNames(st, v.kind)
            .map((n) => `${v.kind}/${n}`)
            .join(", ") || "none"
        })`,
      };
    }
  }

  const pendingCount = [...st.credentials.values()].filter(
    (c) => c.agent === agent && c.state === "pending",
  ).length;
  if (pendingCount >= st.maxPending) {
    const pending = [...st.credentials.values()].find(
      (c) => c.agent === agent && c.state === "pending",
    )!;
    audit(st, "pending-reject", {
      agent,
      kind: v.kind,
      name: v.name,
      id: pending.id,
      actor: actorAgent(agent),
    });
    return {
      ok: false,
      error: `pending: ${pending.id} expires ${iso(pending.ttlDeadline)}`,
    };
  }
  const now = st.now();
  const recent = (st.approvals[agent] ?? []).filter(
    (ts) => ts > now - st.hourMs,
  );
  if (recent.length >= st.budgetPerHour) {
    const nextSlot = Math.min(...recent) + st.hourMs;
    audit(st, "budget-reject", {
      agent,
      kind: v.kind,
      name: v.name,
      next_slot: nextSlot,
      actor: actorAgent(agent),
    });
    return {
      ok: false,
      error: `budget: ${st.budgetPerHour} approvals in last hour; next slot ${iso(nextSlot)}`,
    };
  }
  if (!hasOwnerConfigured(st.ch)) {
    console.warn(
      `[vault] request from ${agent}: no owner configured on channel ${st.ch.id} (vault is effectively disabled)`,
    );
    audit(st, "no-owner", { agent, kind: v.kind, name: v.name });
  }

  const id = `vault_${crypto.randomUUID()}`;
  const cred: VaultCredential = {
    id,
    agent,
    kind: v.kind,
    name: v.name,
    label: v.label,
    level: v.level,
    hours: v.hours,
    envvar: v.envvar,
    ...(v.fromEnv ? { fromEnv: v.fromEnv } : {}),
    valueSource,
    reason: v.reason,
    channelId: String(getDiscordChannelId(st.ch.id) || st.ch.channel),
    messageId: "",
    state: "pending",
    created: now,
    ttlDeadline: now + st.ttlMs,
    useCount: 0,
    runsInFlight: 0,
  };
  st.credentials.set(id, cred);

  if (storedValue !== null) {
    writeValueFile(st, id, storedValue);
    st.secrets.register([storedValue]);
  }

  const res = await sendDiscordMessage(st.ch, "tap Approve or Deny", {
    components: pendingButtons(id),
    embeds: [credEmbed(st, cred, "pending")],
  });
  if (!res.success) {
    st.credentials.delete(id);
    if (storedValue !== null) {
      deleteValueFile(st, id);
      scheduleCensorDrop(st, id, storedValue, 0);
    }
    audit(st, "post-fail", credFields(cred), {
      actor: actorAgent(agent),
      reason: res.error ?? "unknown",
    });
    return { ok: false, error: `post failed: ${res.error ?? "unknown"}` };
  }
  cred.messageId = String(res.messageId ?? "");
  armTtl(st, cred);
  audit(st, "request", credFields(cred), {
    actor: actorAgent(agent),
    reason: v.reason,
    label: v.label,
    envvar: v.envvar,
    ...(v.fromEnv ? { from_env: v.fromEnv } : {}),
  });
  persist(st);
  return { ok: true, id, state: "pending", ttl: iso(cred.ttlDeadline) };
}

/** `vrun` op (begin). The socket server keeps the connection open for the
 *  done-wait after a successful handoff. Single-use (one-shot) is by
 *  construction: the state flip to `consumed` happens before the value
 *  line is flushed. */
export function vaultRunBegin(st: VaultState, line: any): VaultRunBeginResult {
  const id = typeof line?.id === "string" ? line.id : "";
  const cred = st.credentials.get(id);
  if (!cred) return { ok: false, error: "unknown id" };

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

  // Lazy expiry (restart-safe: timers may not have fired).
  if (cred.state === "active") {
    if (cred.level === "one-shot" && cred.claimDeadline !== undefined) {
      if (st.now() >= cred.claimDeadline) {
        settleClaim(st, id);
      }
    } else if (cred.level === "time-boxed" && cred.expiresAt !== undefined) {
      if (st.now() >= cred.expiresAt) {
        settleWindow(st, id);
      }
    }
  }

  const state = st.credentials.get(id)?.state;
  if (state === "pending") {
    return { ok: false, error: "state: pending (awaiting approval)" };
  }
  if (state === "expired") {
    const deadline =
      cred.expiredKind === "claim"
        ? (cred.claimDeadline ?? cred.ttlDeadline)
        : cred.expiredKind === "window"
          ? (cred.expiresAt ?? cred.ttlDeadline)
          : cred.ttlDeadline;
    return { ok: false, error: `state: expired at ${iso(deadline)}` };
  }
  if (state === "denied") return { ok: false, error: "state: denied" };
  if (state === "revoked") return { ok: false, error: "state: revoked" };
  if (state === "consumed") return { ok: false, error: "state: already used" };
  if (state !== "active") return { ok: false, error: `state: ${state}` };

  // active → handoff
  const gitHeader = cred.kind === "github-pat";
  let value: string;
  try {
    value =
      cred.valueSource === "stored"
        ? readValueFile(st, id)
        : readKnownValue(st, cred.kind, cred.name);
  } catch {
    audit(st, "handoff-error", credFields(cred), {
      actor: actorAgent(cred.agent),
      err:
        cred.valueSource === "stored"
          ? "value file missing"
          : `value file missing for ${cred.kind}/${cred.name}`,
    });
    return {
      ok: false,
      error:
        cred.valueSource === "stored"
          ? "value: file missing (bridge restarted?)"
          : `known: value file missing for ${cred.kind}/${cred.name}`,
    };
  }
  if (!validateValueShape(cred.kind, value)) {
    audit(st, "handoff-error", credFields(cred), {
      actor: actorAgent(cred.agent),
      err: "value shape invalid",
    });
    return { ok: false, error: "value: shape invalid (store changed?)" };
  }
  // A use = a handoff: the value left the bridge. Record + count now,
  // before the flush. (vdone/abandon only log the child rc.)
  cred.useCount += 1;
  audit(st, "use", credFields(cred), {
    actor: actorAgent(cred.agent),
    source: cred.valueSource,
    envvar: cred.envvar,
    use: cred.useCount,
  });

  if (cred.valueSource === "known") {
    st.secrets.register([value]);
  }

  // Single-use by construction (one-shot): flip BEFORE the flush.
  if (cred.level === "one-shot") {
    cred.state = "consumed";
    cred.consumedAt = st.now();
    clearTimersFor(st, id);
    // Terminal settle at handoff: the value is on the wire, the file has
    // served. Delete + censor-drop + mark the button message used.
    settleStoredValueFromDisk(st, cred);
    if (st.transport === "socket") unlinkPublished(st, id);
    if (cred.valueSource === "known") {
      scheduleCensorDrop(st, id, value, st.censorGraceMs);
    }
    void editCredentialMessage(st, cred, usedText(cred), [], "used").catch(
      () => {},
    );
  } else {
    cred.runsInFlight += 1;
  }
  persist(st);

  if (st.transport === "file") {
    publishDoc(st, id, value, cred.kind, cred.envvar);
    return {
      ok: true,
      file: true,
      kind: cred.kind,
      envvar: cred.envvar,
      git_header: gitHeader,
      cred,
      timeoutS,
    };
  }
  return {
    ok: true,
    token: value,
    kind: cred.kind,
    envvar: cred.envvar,
    git_header: gitHeader,
    cred,
    timeoutS,
  };
}

/** `vdone` line handling. `use` audit carries the rc (actor = agent). */
export function vaultRunDone(st: VaultState, id: string, rc: number): boolean {
  const cred = st.credentials.get(id);
  if (!cred) return false;
  if (cred.level === "one-shot") {
    if (cred.state !== "consumed" || cred.lastRc !== undefined) return false;
  } else {
    if (cred.state !== "active" || cred.runsInFlight === 0) return false;
  }
  cred.lastRc = rc;
  if (cred.level !== "one-shot") cred.runsInFlight -= 1;
  audit(st, "done", credFields(cred), {
    actor: actorAgent(cred.agent),
    rc,
  });
  if (cred.level === "one-shot" && st.transport === "file") {
    unlinkPublished(st, id);
  }
  persist(st);
  return true;
}

/** Connection closed / read-timed-out before done: the run never reported. */
export function vaultRunAbandon(
  st: VaultState,
  id: string,
  handoffValue: string | undefined,
): boolean {
  const cred = st.credentials.get(id);
  if (!cred) return false;
  if (cred.level === "one-shot") {
    if (cred.state !== "consumed" || cred.lastRc !== undefined) return false;
  } else {
    if (cred.state !== "active" || cred.runsInFlight === 0) return false;
  }
  cred.lastRc = -1;
  if (cred.level !== "one-shot") cred.runsInFlight -= 1;
  audit(st, "abandon", credFields(cred), {
    actor: actorAgent(cred.agent),
    rc: -1,
  });
  if (cred.level === "one-shot" && st.transport === "file") {
    unlinkPublished(st, id);
  }
  persist(st);
  // Child is gone: drop the censored value now (no grace needed).
  if (handoffValue) {
    try {
      st.secrets.drop([handoffValue]);
    } catch {
      // backstop
    }
  }
  return true;
}

/** `vstatus` op. The value is never in the output. */
export function vaultStatus(
  st: VaultState,
  line: any,
): Record<string, unknown> {
  const id = typeof line?.id === "string" ? line.id : "";
  if (id) {
    const cred = st.credentials.get(id);
    if (!cred) return { ok: false, error: "unknown id" };
    const out: Record<string, unknown> = {
      ok: true,
      id: cred.id,
      state: cred.state,
      kind: cred.kind,
      name: cred.name,
      level: cred.level,
      envvar: cred.envvar,
      created: iso(cred.created),
    };
    if (cred.label) out.label = cred.label;
    if (cred.valueSource === "stored") out.source = "stored";
    else out.source = "known";
    if (cred.approvedAt) out.approved = iso(cred.approvedAt);
    if (cred.claimDeadline) out.claim_deadline = iso(cred.claimDeadline);
    if (cred.expiresAt) out.expires = iso(cred.expiresAt);
    if (cred.consumedAt) out.consumed_at = iso(cred.consumedAt);
    if (cred.revokedBy) out.revoked_by = cred.revokedBy;
    if (cred.deniedBy) out.denied_by = cred.deniedBy;
    if (cred.useCount > 0) {
      out.use_count = cred.useCount;
      out.last_rc = cred.lastRc;
    }
    return out;
  }
  const agent =
    typeof line?.agent === "string" && line.agent ? line.agent : "unknown";
  const recent = (st.approvals[agent] ?? []).filter(
    (ts) => ts > st.now() - st.hourMs,
  );
  return {
    ok: true,
    pending: [...st.credentials.values()]
      .filter(
        (c) =>
          c.agent === agent && (c.state === "pending" || c.state === "active"),
      )
      .map((c) => {
        const o: Record<string, unknown> = {
          id: c.id,
          state: c.state,
          kind: c.kind,
          name: c.name,
          level: c.level,
          envvar: c.envvar,
        };
        if (c.claimDeadline) o.claim_deadline = iso(c.claimDeadline);
        if (c.expiresAt) o.expires = iso(c.expiresAt);
        return o;
      }),
    budget: { approvals_last_hour: recent.length, cap: st.budgetPerHour },
  };
}

/** `vrevoke` op — agent self-revoke: the calling agent must be the
 *  requesting agent. Owner revoke is the button tap (component handler). */
export function vaultRevoke(
  st: VaultState,
  line: any,
): Record<string, unknown> {
  const id = typeof line?.id === "string" ? line.id : "";
  const agent =
    typeof line?.agent === "string" && line.agent ? line.agent : "unknown";
  const cred = st.credentials.get(id);
  if (!cred) return { ok: false, error: "unknown id" };
  if (cred.agent !== agent) {
    audit(st, "revoke-reject", credFields(cred), {
      actor: actorAgent(agent),
      reason: "not your request",
    });
    return { ok: false, error: "actor: not your request" };
  }
  if (cred.state === "pending" || cred.state === "active") {
    const was = cred.state;
    cred.state = "revoked";
    cred.revokedBy = actorAgent(agent);
    clearTimersFor(st, id);
    settleStoredValueFromDisk(st, cred);
    if (st.transport === "file") unlinkPublished(st, id);
    audit(st, "revoke", credFields(cred), {
      actor: actorAgent(agent),
      from_state: was,
    });
    persist(st);
    void editCredentialMessage(
      st,
      cred,
      revokedText(cred, agent),
      [],
      "revoked",
    ).catch(() => {});
    return { ok: true, id, state: "revoked" };
  }
  return { ok: false, error: `state: ${cred.state} (terminal)` };
}

// ─── Socket server ────────────────────────────────────────────────────────

function handleConnection(st: VaultState, sock: net.Socket): void {
  let buf = "";
  let lineCount = 0;
  let settled = false;
  let runCtx: {
    cred: VaultCredential;
    value: string | null;
    timeoutS: number;
    runDone: boolean;
  } | null = null;

  const send = (obj: Record<string, unknown>): void => {
    if (!settled && !sock.destroyed) {
      sock.write(`${JSON.stringify({ v: 1, ...obj })}\n`);
    }
  };

  const finish = (): void => {
    if (settled) return;
    settled = true;
    if (
      runCtx &&
      !runCtx.runDone &&
      ((runCtx.cred.level === "one-shot" &&
        runCtx.cred.state === "consumed" &&
        runCtx.cred.lastRc === undefined) ||
        (runCtx.cred.level !== "one-shot" &&
          runCtx.cred.state === "active" &&
          runCtx.cred.runsInFlight > 0))
    ) {
      vaultRunAbandon(st, runCtx.cred.id, runCtx.value ?? undefined);
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
      !runCtx.runDone &&
      ((runCtx.cred.level === "one-shot" &&
        runCtx.cred.state === "consumed" &&
        runCtx.cred.lastRc === undefined) ||
        (runCtx.cred.level !== "one-shot" &&
          runCtx.cred.state === "active" &&
          runCtx.cred.runsInFlight > 0))
    ) {
      vaultRunAbandon(st, runCtx.cred.id, runCtx.value ?? undefined);
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
        if (parsed?.op === "vrequest") {
          void vaultRequest(st, parsed).then((r) => {
            send(r);
            finish();
          });
          continue;
        }
        if (parsed?.op === "vstatus") {
          send(vaultStatus(st, parsed));
          return finish();
        }
        if (parsed?.op === "vrevoke") {
          send(vaultRevoke(st, parsed));
          return finish();
        }
        if (parsed?.op === "vrun") {
          const r = vaultRunBegin(st, parsed);
          if (!r.ok || !r.cred || !r.timeoutS) {
            send({ ok: false, error: r.error });
            return finish();
          }
          runCtx = {
            cred: r.cred,
            value: r.token ?? null,
            timeoutS: r.timeoutS,
            runDone: false,
          };
          send(
            r.file
              ? {
                  ok: true,
                  file: true,
                  kind: r.kind,
                  envvar: r.envvar,
                  git_header: r.git_header,
                }
              : {
                  ok: true,
                  token: r.token,
                  kind: r.kind,
                  envvar: r.envvar,
                  git_header: r.git_header,
                },
          );
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
        if (parsed?.op !== "vdone") {
          send({ ok: false, error: "usage: expected vdone" });
          return finish();
        }
        const rc = typeof parsed.rc === "number" ? Math.trunc(parsed.rc) : -1;
        runCtx.runDone = true;
        const done = vaultRunDone(st, runCtx.cred.id, rc);
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

// ─── Component handler (owner taps: approve / deny / revoke) ──────────────

function markSeen(st: VaultState, id: string): boolean {
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

function makeHandler(st: VaultState): (d: any) => Promise<void> {
  return async (d: any): Promise<void> => {
    let parsedId: string | undefined;
    try {
      const m = COMPONENT_RE.exec(String(d?.data?.custom_id ?? ""));
      // MESSAGE_COMPONENT is type 3 (current Discord spec; it was 4 in the
      // old numbering — the type-4 gate is why every tap fell through to
      // the slash-command path, RCA 2026-10-01).
      if (d?.type !== 3 || !m) return;
      const verb = m[1] as "approve" | "deny" | "revoke";
      parsedId = `vault_${m[2]}`;

      await deferInteraction(st.botToken, d);

      const uid = String(d.user?.id ?? "");

      // Dedupe (gateway redelivery) — no second reply (the first tap
      // already showed feedback), but audit it: a tap with no audit line
      // is how the 2026-10-08 mismatch bug stayed invisible.
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

      const cred = st.credentials.get(parsedId);
      if (!cred) {
        audit(
          st,
          "tap-rejected",
          { id: parsedId },
          {
            reason: "not-found",
            user: uid,
            verb,
          },
        );
        await replyInteraction(
          st.botToken,
          d,
          "[!] tap rejected: request not found or already handled",
        );
        return;
      }

      // Message + channel match (stale copy / forwarded button).
      // The live payload has NO d.message_id — per the Discord spec the
      // component's message is the `message` field on the INTERACTION
      // object itself (older payloads nested it in data). Reading
      // d.message_id compared "undefined" against the cred id, so every
      // tap was rejected (RCA 2026-10-08). d.message_id is kept only as
      // a defensive last resort for synthetic payloads.
      const srcMsgId = d?.message?.id ?? d?.data?.message?.id ?? d?.message_id;
      if (
        srcMsgId == null ||
        String(srcMsgId) !== String(cred.messageId) ||
        String(d.channel_id) !== String(cred.channelId)
      ) {
        audit(st, "tap-rejected", credFields(cred), {
          reason: "mismatch",
          user: uid,
          verb,
          expected_message: cred.messageId,
          expected_channel: cred.channelId,
          got_message: srcMsgId == null ? null : String(srcMsgId),
          got_channel: d.channel_id == null ? null : String(d.channel_id),
        });
        await replyInteraction(
          st.botToken,
          d,
          "[!] tap rejected: button not on the request message",
        );
        return;
      }

      if (!isOwnerUser(st.ch, uid)) {
        audit(st, "non-owner-tap", credFields(cred), {
          user: uid,
          actor: actorDiscord(uid),
          verb,
        });
        await replyInteraction(
          st.botToken,
          d,
          "[!] tap rejected: only the owner can approve vault requests",
        );
        return;
      }

      // State gate per verb.
      if (verb === "revoke") {
        if (cred.state !== "active") {
          audit(st, "tap-rejected", credFields(cred), {
            reason: "already-handled",
            user: uid,
            verb,
            state: cred.state,
          });
          await replyInteraction(
            st.botToken,
            d,
            "[!] tap rejected: already handled",
          );
          return;
        }
        cred.state = "revoked";
        cred.revokedBy = actorDiscord(uid);
        clearTimersFor(st, cred.id);
        settleStoredValueFromDisk(st, cred);
        if (st.transport === "file") unlinkPublished(st, cred.id);
        audit(st, "revoke", credFields(cred), {
          user: uid,
          actor: actorDiscord(uid),
          from_state: "active",
        });
        persist(st);
        await editCredentialMessage(
          st,
          cred,
          revokedText(cred, String(d.user?.username ?? uid)),
        );
        await deleteDeferredAck(st.botToken, d);
        return;
      }

      if (cred.state !== "pending") {
        audit(st, "tap-rejected", credFields(cred), {
          reason: "already-handled",
          user: uid,
          verb,
          state: cred.state,
        });
        await replyInteraction(
          st.botToken,
          d,
          "[!] tap rejected: already handled",
        );
        return;
      }

      // Transition (the only place tap-verbs mutate state).
      const now = st.now();
      if (verb === "approve") {
        if (cred.valueSource === "stored") {
          // Value file already written at request; verify it survived
          // (restart between request and approve).
          try {
            readValueFile(st, cred.id);
          } catch {
            audit(st, "vault-error", credFields(cred), {
              actor: actorDiscord(uid),
              err: "stored value file missing",
            });
            await replyInteraction(
              st.botToken,
              d,
              "[!] value lost (bridge restarted) — re-request",
            );
            return;
          }
        } else {
          // Known mode: named pre-check at approve (specific message),
          // then read fresh at handoff anyway.
          try {
            const t = readKnownValue(st, cred.kind, cred.name);
            if (!validateValueShape(cred.kind, t))
              throw new Error(
                `value shape invalid for ${cred.kind}/${cred.name}`,
              );
          } catch {
            audit(st, "vault-error", credFields(cred), {
              actor: actorDiscord(uid),
              err: "value file missing",
            });
            await replyInteraction(st.botToken, d, "[!] value file missing");
            return;
          }
        }
        cred.state = "active";
        cred.approvedAt = now;
        if (cred.level === "one-shot") {
          cred.claimDeadline = now + st.claimMs;
          armClaim(st, cred);
        } else if (cred.level === "time-boxed") {
          cred.expiresAt = now + cred.hours * st.hourMs;
          armWindow(st, cred);
        }
        const approvals = st.approvals[cred.agent] ?? [];
        approvals.push(now);
        st.approvals[cred.agent] = approvals;
        audit(st, "approve", credFields(cred), {
          user: uid,
          actor: actorDiscord(uid),
        });
        persist(st);
        await editCredentialMessage(
          st,
          cred,
          approvedText(cred),
          revokeButtons(cred.id),
          "approved",
        );
      } else {
        cred.state = "denied";
        cred.deniedBy = uid;
        clearTimersFor(st, cred.id);
        settleStoredValueFromDisk(st, cred);
        audit(st, "deny", credFields(cred), {
          user: uid,
          actor: actorDiscord(uid),
        });
        persist(st);
        await editCredentialMessage(
          st,
          cred,
          deniedText(cred, String(d.user?.username ?? uid)),
          [],
          "denied",
        );
      }
      await deleteDeferredAck(st.botToken, d);
    } catch (e) {
      // Never reject (M1 parity): log + audit + best-effort feedback.
      console.error("[interactions] vault handler failed:", e);
      audit(st, "vault-error", { id: parsedId }, { err: String(e) });
      await replyInteraction(st.botToken, d, "[!] vault error");
    }
  };
}

// ─── Persistence load / recovery ──────────────────────────────────────────

function load(st: VaultState): void {
  let doc: any;
  try {
    doc = JSON.parse(fs.readFileSync(st.stateFile, "utf-8"));
  } catch {
    return; // first start
  }
  const now = st.now();
  for (const [id, raw] of Object.entries<any>(doc.credentials ?? {})) {
    const c: VaultCredential = { ...raw, id };
    st.credentials.set(id, c);
    if (c.state === "pending") {
      if (c.ttlDeadline <= now) {
        c.state = "expired";
        c.expiredKind = "ttl";
        settleStoredValueFromDisk(st, c);
        audit(st, "recovered-expired", credFields(c), {
          actor: "system",
          reason: "ttl",
        });
        void editCredentialMessage(
          st,
          c,
          `[expired] VAULT request ${c.id} unanswered (${ttlText(st, c)})`,
        ).catch(() => {});
      } else {
        armTtl(st, c);
      }
    } else if (c.state === "active") {
      if (
        c.level === "one-shot" &&
        c.claimDeadline !== undefined &&
        c.claimDeadline <= now
      ) {
        c.state = "expired";
        c.expiredKind = "claim";
        settleStoredValueFromDisk(st, c);
        audit(st, "recovered-expired", credFields(c), {
          actor: "system",
          reason: "claim",
        });
        void editCredentialMessage(
          st,
          c,
          `[expired] VAULT ${c.id} claim window missed`,
        ).catch(() => {});
      } else if (
        c.level === "time-boxed" &&
        c.expiresAt !== undefined &&
        c.expiresAt <= now
      ) {
        c.state = "expired";
        c.expiredKind = "window";
        settleStoredValueFromDisk(st, c);
        audit(st, "recovered-expired", credFields(c), {
          actor: "system",
          reason: "window",
        });
        void editCredentialMessage(
          st,
          c,
          `[expired] VAULT ${c.id} window ended`,
        ).catch(() => {});
      } else if (c.level === "one-shot") {
        armClaim(st, c);
      } else if (c.level === "time-boxed") {
        armWindow(st, c);
      }
      // permanent: nothing to arm
    } else {
      // Terminal: the run was in flight; the wrapper's done line can no
      // longer arrive (connection died with the process).
      c.runsInFlight = 0;
    }
    if (
      (c.state === "pending" || c.state === "active") &&
      c.valueSource === "stored"
    ) {
      // Re-register the stored value for the censor across restarts. A
      // live pending BYO must stay censored if the bridge restarts inside
      // the <=5min window (the registry has no TTL — a missed registration
      // is missed forever). Dead pendings were settled to expired above,
      // so only still-live ones reach this line.
      try {
        st.secrets.register([readValueFile(st, c.id)]);
      } catch {
        // missing: the handoff will error cleanly
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

/** A crash between the value-file write and persist leaves a 0600 secret
 *  file with no credential record. Sweep it at boot, after load (needs
 *  the credential map). */
function sweepOrphanValueFiles(st: VaultState): void {
  try {
    for (const name of fs.readdirSync(st.secretsDir)) {
      if (!name.endsWith(".secret")) continue;
      const id = name.slice(0, -".secret".length);
      if (st.credentials.has(id)) continue;
      fs.unlinkSync(path.join(st.secretsDir, name));
      audit(st, "sweep", { actor: "system" }, { orphan: name });
    }
  } catch (e) {
    console.error("[vault] orphan value sweep failed:", e);
  }
}

// ─── start / stop ─────────────────────────────────────────────────────────

function stopVaultCore(st: VaultState): void {
  st.stopped = true;
  persist(st);
  for (const arr of st.timers.values()) {
    for (const t of arr) clearTimeout(t);
  }
  st.timers.clear();
  st.server?.close();
  st.server = null;
}

/** Start (or reuse) the vault for this channel. The first instance per
 *  socket path performs the startup sweep + socket bind; later instances
 *  in the same process share state and server. Refcounted. */
export function startVault(opts: StartVaultOpts): VaultHandle {
  const home = process.env.HOME || os.homedir();
  const xdg =
    opts.xdgDir ??
    process.env.XDG_RUNTIME_DIR ??
    path.join("/run/user", String(process.getuid ? process.getuid() : 0));
  const vaultDir =
    opts.vaultDir ??
    process.env.JARATE_VAULT_DIR ??
    path.join(home, ".jarate", "vault");
  void opts.stateDir; // accepted for wiring symmetry; state lives in vaultDir
  const knownDir = opts.knownDir ?? path.join(vaultDir, "known");
  const secretsDir = opts.secretsDir ?? path.join(vaultDir, "secrets");
  const stateFile = opts.stateFile ?? path.join(vaultDir, "state.json");
  const auditFile = opts.auditFile ?? path.join(vaultDir, "audit.log");
  const socketDir =
    opts.socketDir ??
    process.env.JARATE_VAULT_SOCKET_DIR ??
    path.join(xdg, "jarate");
  const socketPath = path.join(socketDir, "vault.sock");
  const existing = vaultEntries.get(socketPath);
  if (existing) {
    existing.refs += 1;
    return makeHandle(existing.vault);
  }

  const st: VaultState = {
    ch: opts.ch,
    botToken: opts.botToken,
    transport:
      opts.transport ??
      (process.env.JARATE_VAULT_TRANSPORT === "file" ? "file" : "socket"),
    now: opts.now ?? (() => Date.now()),
    secrets: {
      register: opts.secrets?.register ?? registerRuntimeSecrets,
      drop: opts.secrets?.drop ?? dropRuntimeSecrets,
    },
    ttlMs: envNum("JARATE_VAULT_TTL_MS", 300_000),
    claimMs: envNum("JARATE_VAULT_CLAIM_MS", 60_000),
    hourMs: envNum("JARATE_VAULT_HOUR_MS", HOUR_MS),
    maxPending: envNum("JARATE_VAULT_MAX_PENDING", 1),
    budgetPerHour: envNum("JARATE_VAULT_BUDGET_PER_HOUR", 5),
    censorGraceMs: envNum("JARATE_VAULT_CENSOR_GRACE_MS", 10_000),
    seenCap: envNum("JARATE_VAULT_SEEN_CAP", 500),
    vaultDir,
    stateFile,
    auditFile,
    auditDir: path.dirname(auditFile),
    knownDir,
    secretsDir,
    socketDir,
    socketPath,
    fileDir:
      opts.fileDir ??
      process.env.JARATE_VAULT_FILE_DIR ??
      path.join(xdg, "jarate-vault"),
    legacyPatsDir:
      opts.legacyPatsDir ??
      process.env.JARATE_VAULT_LEGACY_PATS_DIR ??
      path.join(home, ".config", "marzukia-pats"),
    legacyDefaultPatFile:
      opts.legacyDefaultPatFile ??
      process.env.JARATE_VAULT_LEGACY_PAT_FILE ??
      path.join(home, ".config", "marzukia-pat"),
    credentials: new Map(),
    approvals: {},
    seen: new Map(),
    timers: new Map(),
    server: null,
    stopped: false,
  };

  // Data dirs: 0700 (create if missing, enforce).
  try {
    fs.mkdirSync(st.vaultDir, { recursive: true, mode: 0o700 });
    fs.chmodSync(st.vaultDir, 0o700);
    fs.mkdirSync(st.knownDir, { recursive: true, mode: 0o700 });
    fs.chmodSync(st.knownDir, 0o700);
    fs.mkdirSync(st.secretsDir, { recursive: true, mode: 0o700 });
    fs.chmodSync(st.secretsDir, 0o700);
  } catch (e) {
    console.error("[vault] data dir setup failed:", e);
  }

  startupSweep(st);
  load(st);
  sweepOrphanValueFiles(st);
  const ready = bindSocket(st);
  vaultEntries.set(socketPath, { vault: st, refs: 1 });
  return makeHandle(st, ready);
}

function makeHandle(st: VaultState, ready?: Promise<void>): VaultHandle {
  return {
    vault: st,
    ready: ready ?? Promise.resolve(),
    handleVaultComponent: makeHandler(st),
  };
}

/** Stop one channel's vault handle (refcounted). */
export function stopVault(h: VaultHandle): void {
  const entry = vaultEntries.get(h.vault.socketPath);
  if (!entry) return;
  entry.refs -= 1;
  if (entry.refs > 0) return;
  vaultEntries.delete(h.vault.socketPath);
  stopVaultCore(h.vault);
}
