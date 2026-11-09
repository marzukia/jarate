// liveness-event.ts — hall-monitor#757 leg B: the bridge stops self-posting the
// session-start / back-online channel lines. The channel-level liveness signal
// now arrives via the hall-monitor webhook leg (the liveness sweep or this
// endpoint, posted by hall-monitor under a non-agent identity); the bridge's
// role is ONE fire-and-forget event POST per trigger:
//
//   POST <base>/fleet/liveness/event   header X-Agent-Key
//   body {agent, event, detail}   event in session_start | back_online | online
//
// The trigger conditions stay bridge-side (deterministic, no inference) — only
// the post moves. Failure is LOG-ONLY: the bridge must never block or fail the
// channel line on hall-monitor (a dead hall-monitor degrades to the sweep +
// the 30s live marker, which remain the independent signal — leg B never
// waits on leg A).
//
// Config: the bridge's existing hall-monitor setting (the inbox leg pattern,
// channel/inbox.ts + channel/version-drift.ts): JARATE_INBOX_URL = the
// hall-monitor API base (…/api), JARATE_INBOX_KEY = the per-agent key
// (X-Agent-Key, falling back to the agent-key file chain — version-drift's
// resolution, including the JARATE_INBOX_KEY_FILE test seam), JARATE_INBOX_AGENT
// = this agent's name (falling back to the key file's hm_agent_ line, then the
// process's unix user — the lanes run under per-agent users and the
// hall-monitor roster names match them). Unset URL or key = the event is not
// sent (one local log line; the feature is off, not a failure).

import * as fs from "node:fs";
import * as os from "node:os";
import { keyFileCandidates, readKeyFile } from "./version-drift";

export type LivenessEvent = "session_start" | "back_online" | "online";

export interface LivenessTarget {
  base: string;
  key: string;
  agent: string;
}

// Injectable HTTP leg (unit tests replace fetch with a mock so no test
// touches the live hall-monitor API — same pattern as inbox.ts /
// version-drift.ts).
type LivenessHttpFn = (
  url: string,
  init: RequestInit,
) => Promise<{ ok: boolean; status: number }>;

let httpImpl: LivenessHttpFn | null = null;

// Swap the HTTP leg (tests); null restores the real fetch.
export function setLivenessHttp(fn: LivenessHttpFn | null): void {
  httpImpl = fn;
}

const HTTP_TIMEOUT_MS = 10_000;

// The agent-key file: the first EXISTING candidate of the fleet path chain
// (version-drift's resolution; JARATE_INBOX_KEY_FILE overrides for tests).
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

// This agent's name, by resolution priority: JARATE_INBOX_AGENT (the inbox
// leg's name, operator-set in the pi.service env file), then the key file's
// hm_agent_ line (the onboarding files carry one: `hm_agent_<name>`), then
// the process's unix user ("" when unresolvable — the server 400s the
// event and the log-only path documents it).
export function resolveAgentName(): string {
  const env = (process.env.JARATE_INBOX_AGENT ?? "").trim();
  if (env) return env;
  const files = process.env.JARATE_INBOX_KEY_FILE
    ? [process.env.JARATE_INBOX_KEY_FILE]
    : keyFileCandidates();
  for (const cand of files) {
    let lines: string[] = [];
    try {
      lines = fs
        .readFileSync(cand, "utf8")
        .split("\n")
        .map((l) => l.trim());
    } catch {
      continue;
    }
    const named = lines.find(
      (t) => t && !t.startsWith("#") && t.startsWith("hm_agent_"),
    );
    if (named) {
      const n = named.slice("hm_agent_".length).trim();
      if (n) return n;
    }
  }
  try {
    return os.userInfo().username;
  } catch {
    return "";
  }
}

// Resolve the event target (base + key + agent); null = the feature is off
// (URL or key unset: no send, one local log line).
export function resolveLivenessTarget(): LivenessTarget | null {
  const base = (process.env.JARATE_INBOX_URL ?? "").trim().replace(/\/+$/, "");
  let key = (process.env.JARATE_INBOX_KEY ?? "").trim();
  if (!key) key = readKeyFile(keyFile());
  if (!base || !key) return null;
  return { base, key, agent: resolveAgentName() };
}

// One fire-and-forget event POST. NEVER THROWS: a dead hall-monitor is a
// log line, never a startup failure. Returns true on 2xx.
export async function sendLivenessEvent(
  event: LivenessEvent,
  detail: string,
): Promise<boolean> {
  const target = resolveLivenessTarget();
  if (!target) {
    console.log(
      `[liveness] event ${event} not sent: hall-monitor config unset (JARATE_INBOX_URL/JARATE_INBOX_KEY); the sweep + live marker remain the independent signal`,
    );
    return false;
  }
  const url = `${target.base}/fleet/liveness/event`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-Agent-Key": target.key,
  };
  const body = JSON.stringify({ agent: target.agent, event, detail });
  try {
    const res = httpImpl
      ? await httpImpl(url, { method: "POST", headers, body })
      : await fetch(url, {
          method: "POST",
          headers,
          body,
          signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
        });
    if (res.ok) {
      console.log(
        `[liveness] event ${event} posted (agent=${target.agent || "unresolved"})`,
      );
      return true;
    }
    console.error(
      `[liveness] event ${event} post failed (http ${res.status}); log-only — the sweep + live marker remain the independent signal`,
    );
    return false;
  } catch (e) {
    console.error(
      `[liveness] event ${event} post failed: ${e instanceof Error ? e.message : String(e)}; log-only — the sweep + live marker remain the independent signal`,
    );
    return false;
  }
}
