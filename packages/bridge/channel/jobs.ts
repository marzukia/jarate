// /jobs: in-flight pi-bg dispatches + recent-completed history (issue #14)
//
// In-flight: the pi-bg wrapper's command line carries profile + task, and the
// wrapper process exists only while the run is live, so `ps` is the reliable
// in-flight marker (the prompt/out artifacts are written at run end).
//
// History: assembled from the /tmp/pi-bg-<ticket>-* artifacts pi-bg leaves
// per run — raw.out (run started), out.md (run completed, non-empty),
// webhook-failed (callback dead letter), killed (pi-bg-kill marker),
// wb-status (success-path webhook HTTP code, recorded at post time).
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

export interface InflightJob {
  profile: string;
  age: string;
  task: string;
}

// Match the wrapper line shape: <etime> <bash> <...>scripts/pi-bg <profile> <task>
export function parseJobsFromPs(
  psOut: string,
): { profile: string; age: string; task: string }[] {
  const out: { profile: string; age: string; task: string }[] = [];
  for (const line of psOut.split("\n")) {
    const m = line
      .trim()
      .match(
        /^(\S+)\s+\S*bash\s+\S*scripts\/pi-bg\s+(worker|reviewer)\s+(.+)$/,
      );
    if (!m) continue;
    const task = m[3]
      .trim()
      .replace(/^"+|"+$/g, "")
      .split("\n")[0]
      .slice(0, 70);
    out.push({ age: m[1], profile: m[2], task });
  }
  return out;
}

export function collectInflightJobs(): InflightJob[] {
  let raw = "";
  try {
    const uid = process.getuid?.();
    raw = execSync(
      `ps ${uid !== undefined ? `-u ${uid}` : "-eo"} -o etime,args | grep '[s]cripts/pi-bg'`,
      { encoding: "utf8", timeout: 5000 },
    );
  } catch {
    return [];
  }
  return parseJobsFromPs(raw);
}

export type JobState = "done" | "webhook-failed" | "killed" | "lost";

export interface JobHistoryEntry {
  id: string;
  state: JobState;
  /** newest artifact mtime, epoch seconds */
  mtime: number;
  /** success-path webhook HTTP code ("200"), or the dead-letter code */
  webhook: string | null;
}

const TICKET_RE = /^pi-bg-(\d{8}-\d{6}-\d+)-/;

export function jobTmpDir(): string {
  return process.env.PI_BG_TMPDIR || "/tmp";
}

export function scanJobHistory(tmpDir = jobTmpDir()): JobHistoryEntry[] {
  let names: string[] = [];
  try {
    names = fs.readdirSync(tmpDir);
  } catch {
    return [];
  }
  const mtimes = new Map<string, number>(); // ticket id -> newest mtime (s)
  for (const n of names) {
    const m = n.match(TICKET_RE);
    if (!m) continue;
    try {
      const st = fs.statSync(path.join(tmpDir, n));
      const t = Math.floor(st.mtimeMs / 1000);
      mtimes.set(m[1], Math.max(mtimes.get(m[1]) ?? 0, t));
    } catch {
      // vanished mid-scan; skip
    }
  }
  const out: JobHistoryEntry[] = [];
  for (const [id, mtime] of mtimes) {
    const f = (s: string) => path.join(tmpDir, `pi-bg-${id}-${s}`);
    const outMd = (() => {
      try {
        return fs.statSync(f("out.md")).size > 0;
      } catch {
        return false;
      }
    })();
    const hasDeadLetter = (() => {
      try {
        return fs.existsSync(f("webhook-failed"));
      } catch {
        return false;
      }
    })();
    const killed = (() => {
      try {
        return fs.existsSync(f("killed"));
      } catch {
        return false;
      }
    })();
    let webhook: string | null = null;
    try {
      webhook =
        fs.readFileSync(f("wb-status"), "utf8").trim().split(/\s+/)[0] || null;
    } catch {
      // no success-path record
    }
    if (!webhook && hasDeadLetter) {
      // surface the failed code from the dead letter ("http     : 502 ...")
      try {
        const m = fs
          .readFileSync(f("webhook-failed"), "utf8")
          .match(/http\s*:\s*(\d{3})/);
        webhook = m ? m[1] : null;
      } catch {
        // unreadable dead letter
      }
    }
    let state: JobState;
    if (killed) state = "killed";
    else if (hasDeadLetter) state = "webhook-failed";
    else if (outMd) state = "done";
    else state = "lost";
    out.push({ id, state, mtime, webhook });
  }
  out.sort((a, b) => b.mtime - a.mtime);
  return out;
}

function ageStr(sec: number): string {
  if (sec < 60) return `${Math.max(0, sec)}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m`;
  if (sec < 86400)
    return `${Math.floor(sec / 3600)}h${Math.floor((sec % 3600) / 60)}m`;
  return `${Math.floor(sec / 86400)}d`;
}

/**
 * Render the /jobs view. format "json" = full machine-readable object
 * (inflight + last 10 history entries); "text" = channel-ready listing
 * (inflight + last 5 history entries). Exported for tests.
 */
export function formatJobsView(
  inflight: InflightJob[],
  history: JobHistoryEntry[],
  format: "text" | "json" = "text",
  now: number = Math.floor(Date.now() / 1000),
): string {
  if (format === "json") {
    return JSON.stringify({ inflight, history: history.slice(0, 10) }, null, 2);
  }
  const lines: string[] = [];
  if (inflight.length === 0) {
    lines.push("[jobs] No jobs in flight.");
  } else {
    lines.push(
      `[jobs] ${inflight.length} job${inflight.length > 1 ? "s" : ""} in flight:`,
    );
    for (const j of inflight) {
      lines.push(`- ${j.profile} · ${j.age} · ${j.task}`);
    }
  }
  if (history.length > 0) {
    lines.push("");
    lines.push("recent (newest first):");
    for (const h of history.slice(0, 5)) {
      const age = ageStr(now - h.mtime);
      const wb = h.webhook ? ` · webhook ${h.webhook}` : "";
      lines.push(`- ${h.id} ${h.state}${wb} · ${age} ago`);
    }
  }
  return lines.join("\n");
}

/** /jobs entry point: in-flight (ps) + history (/tmp artifacts). */
export function jobsView(format: "text" | "json" = "text"): string {
  return formatJobsView(collectInflightJobs(), scanJobHistory(), format);
}
