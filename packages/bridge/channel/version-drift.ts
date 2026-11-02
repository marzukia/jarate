// version-drift.ts — fleet-wide version parity, startup drift check (#314, G4 of P1 #322): at pi start, compare the git HEAD of the checkout the bridge loads from against the pinned tag SHA the fleet rollout wrote at /var/tmp/jarate-pinned/<uid>. SHA compare only — no LLM in the enforcement path (the page is a plain fetch).
//
// Config (same env pattern as the inbox leg, channel/inbox.ts): JARATE_INBOX_URL = the hall-monitor API base (…/api), operator-set in the pi.service env file; JARATE_INBOX_KEY = the per-agent key (X-Agent-Key), falling back to the agent-key file resolved from the fleet path chain (~/.config/hall-monitor/agent-key -> ~/.config/hall-monitor/key -> ~/hall-monitor.key, first existing; lanes onboarded at different times carry different paths on the same host) and extracted by shape priority (an X_AGENT_KEY= line wins — onboarding files carry BASE_URL= before it — then an hm_agent_ line, else the first non-comment line). Neither set = the drift line is logged locally and the page is skipped. JARATE_PINNED_DIR overrides the pointer dir (tests).
//
// States: missing pointer file = feature dormant (silent no-op — the rollout has not pinned this host yet); match = in-parity; mismatch = one page to warden via POST <base>/fleet/say (2xx = delivered; a page failure is logged, never thrown — the check must never break startup).
//
// Once per process: the session_start handler fires on /new and /reload too, so the check runs at most once per pi process (the flag resets with the process; resetDriftStateForTests re-arms in unit tests).

import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// Injectable HTTP leg (unit tests replace fetch with a mock; the API leg is injected so no test touches the live hall-monitor API — same pattern as inbox.ts).
type DriftHttpFn = (
  url: string,
  init: RequestInit,
) => Promise<{ ok: boolean; status: number }>;

let httpImpl: DriftHttpFn | null = null;

// Swap the HTTP leg (tests); null restores the real fetch.
export function setDriftHttp(fn: DriftHttpFn | null): void {
  httpImpl = fn;
}

const HTTP_TIMEOUT_MS = 10_000;

// The agent-key file candidates, in resolution order — lanes onboarded at different times carry different paths on the same host: ~/.config/hall-monitor/agent-key (onboarding shape: comment lines, then BASE_URL=, then X_AGENT_KEY=), ~/.config/hall-monitor/key (bare key after comment lines), ~/hall-monitor.key (bare key). JARATE_INBOX_KEY_FILE overrides (the seam tests use; os.homedir() does not follow $HOME — it reads the passwd entry).
export function keyFileCandidates(): string[] {
  if (process.env.JARATE_INBOX_KEY_FILE)
    return [process.env.JARATE_INBOX_KEY_FILE];
  const home = os.homedir();
  return [
    path.join(home, ".config", "hall-monitor", "agent-key"),
    path.join(home, ".config", "hall-monitor", "key"),
    path.join(home, "hall-monitor.key"),
  ];
}

// The agent-key file: the first EXISTING candidate of keyFileCandidates() (the first path when none exist — readKeyFile returns "" for a missing file, so the failure path still names it).
function keyFile(): string {
  if (process.env.JARATE_INBOX_KEY_FILE)
    return process.env.JARATE_INBOX_KEY_FILE;
  for (const cand of keyFileCandidates()) {
    try {
      if (fs.existsSync(cand)) return cand;
    } catch {
      // unreadable stat = next candidate
    }
  }
  return keyFileCandidates()[0];
}

// The agent key from its file, by shape priority (same shape as the rollout's first_key_line): an X_AGENT_KEY= line wins (the value after the =, trimmed — onboarding files carry BASE_URL= before it, so the first non-comment line alone is the wrong line), then an hm_agent_ line, else the first non-comment, non-blank line (legacy bare-key files). Exported for the fallback test; local to keep this module free of the inbox -> index import cycle.
export function readKeyFile(file: string): string {
  let lines: string[] = [];
  try {
    lines = fs
      .readFileSync(file, "utf8")
      .split("\n")
      .map((l) => l.trim());
  } catch {
    // missing/unreadable key file = no key
  }
  const keyLines = lines.filter((t) => t && !t.startsWith("#"));
  let legacy = "";
  for (const t of keyLines) {
    if (t.startsWith("X_AGENT_KEY=")) {
      const v = t.slice("X_AGENT_KEY=".length).trim();
      if (v) return v;
    }
    if (t.startsWith("hm_agent_")) return t;
    if (!legacy) legacy = t;
  }
  return legacy;
}

// Resolve the page target (base + key); null = no page leg (local log only).
export function resolveDriftTarget(): { base: string; key: string } | null {
  const base = (process.env.JARATE_INBOX_URL ?? "").trim().replace(/\/+$/, "");
  let key = (process.env.JARATE_INBOX_KEY ?? "").trim();
  if (!key) key = readKeyFile(keyFile());
  return base && key ? { base, key } : null;
}

// The pinned-SHA pointer dir (env override for tests; the rollout writes /var/tmp/jarate-pinned/<uid> = the tag's SHA).
export function pinnedDir(): string {
  return process.env.JARATE_PINNED_DIR ?? "/var/tmp/jarate-pinned";
}

// The pointer file for this uid; "" when there is no uid (windows).
export function pinnedPointerFile(dir: string = pinnedDir()): string {
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  return uid === null ? "" : path.join(dir, String(uid));
}

// The git HEAD of the checkout the bridge loads from: this module lives at <root>/packages/bridge/channel/, so three levels up is the repo root; realpath so a symlinked machine path (the symlinks-into-checkout layout) resolves to the real checkout. "" when the checkout is not a git repo (the check no-ops).
export function localHead(): string {
  let repo = path.join(import.meta.dirname, "..", "..", "..");
  try {
    repo = fs.realpathSync(repo);
  } catch {
    // realpath failed — use the resolved path as-is
  }
  try {
    return execSync(`git -C "${repo}" rev-parse HEAD`, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}

export type DriftStatus =
  | "dormant" // pointer file missing (or empty) — feature not pinned on this host yet
  | "in-parity" // local HEAD == pinned SHA
  | "drift-local" // mismatch, no page leg (URL/key unset): logged locally
  | "drift-paged" // mismatch, page to warden delivered (2xx)
  | "drift-page-failed"; // mismatch, page not delivered (logged)

export interface DriftResult {
  status: DriftStatus;
  head: string;
  pinned: string;
  detail: string;
}

let checkedOnce = false;

// Test hook: re-arm the once-per-process flag (env changes between tests).
export function resetDriftStateForTests(): void {
  checkedOnce = false;
}

// The startup drift check: at most one run per process; never throws (the caller is fire-and-forget, but the guard is defense in depth).
export async function checkVersionDrift(): Promise<DriftResult | null> {
  if (checkedOnce) return null;
  checkedOnce = true;
  try {
    return await runCheck();
  } catch (e) {
    console.error(
      "[drift] check failed (ignored):",
      e instanceof Error ? e.message : String(e),
    );
    return {
      status: "dormant",
      head: "",
      pinned: "",
      detail: `check failed: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

async function runCheck(): Promise<DriftResult> {
  const f = pinnedPointerFile();
  if (!f || !fs.existsSync(f)) {
    return {
      status: "dormant",
      head: "",
      pinned: "",
      detail: "no pointer file",
    };
  }
  let pinned = "";
  try {
    pinned = fs.readFileSync(f, "utf8").trim().split("\n")[0] ?? "";
  } catch {
    pinned = "";
  }
  if (!pinned) {
    return {
      status: "dormant",
      head: "",
      pinned: "",
      detail: "empty pointer file",
    };
  }
  const head = localHead();
  if (!head) {
    // The checkout is not a usable git repo (or git is missing): the check cannot compare — dormant, logged so it is observable.
    console.log("[drift] no git HEAD available; drift check skipped");
    return { status: "dormant", head: "", pinned, detail: "no git HEAD" };
  }
  if (head.toLowerCase() === pinned.toLowerCase()) {
    return { status: "in-parity", head, pinned, detail: "" };
  }
  // Mismatch: ONE page to warden (no retry loop — one page per start; the once-per-process flag dedups /new and /reload re-sessions).
  const target = resolveDriftTarget();
  if (!target) {
    const line = `version drift: local HEAD ${head.slice(0, 7)} != pinned ${pinned.slice(0, 7)} (no page leg: JARATE_INBOX_URL/JARATE_INBOX_KEY unset)`;
    console.log(`[drift] ${line}`);
    return { status: "drift-local", head, pinned, detail: line };
  }
  try {
    const host = os.hostname();
    const url = `${target.base}/fleet/say`;
    const body = JSON.stringify({
      to: "warden",
      message: `version drift: checkout HEAD ${head.slice(0, 7)} != pinned ${pinned.slice(0, 7)} on ${host}`,
    });
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), HTTP_TIMEOUT_MS);
    let res: { ok: boolean; status: number };
    try {
      res = httpImpl
        ? await httpImpl(url, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-Agent-Key": target.key,
            },
            body,
          })
        : await fetchWithAbort(url, target.key, body, ctrl);
    } finally {
      clearTimeout(t);
    }
    if (res.ok) {
      console.log(
        `[drift] paged warden: HEAD ${head.slice(0, 7)} != pinned ${pinned.slice(0, 7)}`,
      );
      return { status: "drift-paged", head, pinned, detail: "" };
    }
    console.error(
      `[drift] page to warden failed (http ${res.status}); drift: HEAD ${head.slice(0, 7)} != pinned ${pinned.slice(0, 7)}`,
    );
    return {
      status: "drift-page-failed",
      head,
      pinned,
      detail: `http ${res.status}`,
    };
  } catch (e) {
    console.error(
      `[drift] page to warden failed: ${e instanceof Error ? e.message : String(e)}`,
    );
    return {
      status: "drift-page-failed",
      head,
      pinned,
      detail: e instanceof Error ? e.message : String(e),
    };
  }
}

// The real HTTP leg (the injected mock stands in for tests).
async function fetchWithAbort(
  url: string,
  key: string,
  body: string,
  ctrl: AbortController,
): Promise<{ ok: boolean; status: number }> {
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Agent-Key": key },
    body,
    signal: ctrl.signal,
  });
  return { ok: r.ok, status: r.status };
}
