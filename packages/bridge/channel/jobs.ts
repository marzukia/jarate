// /jobs: recent-completed pi-bg run history (history-only since the drain,
// #279).
//
// The dispatch lane is retired (hall-monitor #35, 2026-10-20) and the drain
// is declared (issue #279: zero state=running records fleet-wide, t180-
// verified). The in-flight view (ps scan of the jarate-bg wrapper) and the
// kill/tail wrappers (spawn jarate-bg-kill/-tail) are removed with the
// completion side — there is no in-flight run left to list, tail, or kill.
//
// History: assembled from the pi-bg-<ticket>-* artifacts pi-bg leaves
// per run (in ~/.pi-bg-art, or $PI_BG_TMPDIR; legacy runs in /tmp are
// still scanned) — raw.out (run started), out.md (run completed,
// non-empty), webhook-failed (callback dead letter), killed (kill marker),
// wb-status (success-path webhook HTTP code, recorded at post time).
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

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

/** pi-bg artifact dir: $PI_BG_TMPDIR or ~/.pi-bg-art (pi-bg's own
 *  BG_TMP default). Runs dispatched before the 2026-09-15 default flip
 *  left artifacts in /tmp — the legacy fallback keeps them visible. */
export const JOB_TMP_LEGACY = "/tmp";

export function jobTmpDir(): string {
  return process.env.PI_BG_TMPDIR || path.join(os.homedir(), ".pi-bg-art");
}

/** Default scan set: the current pi-bg tmp dir, then the legacy /tmp. */
export function jobTmpDirs(): string[] {
  return [jobTmpDir(), JOB_TMP_LEGACY];
}

export function scanJobHistory(
  tmpDir: string | string[] = jobTmpDirs(),
): JobHistoryEntry[] {
  const dirs = Array.isArray(tmpDir) ? tmpDir : [tmpDir];
  // merge across dirs (a ticket lives in exactly one of them; the
  // newer entry wins if an old copy lingers in the legacy dir)
  const byId = new Map<string, JobHistoryEntry>();
  for (const d of dirs)
    for (const e of scanJobHistoryDir(d)) {
      const prev = byId.get(e.id);
      if (!prev || e.mtime > prev.mtime) byId.set(e.id, e);
    }
  const out = [...byId.values()];
  out.sort((a, b) => b.mtime - a.mtime);
  return out;
}

function scanJobHistoryDir(tmpDir: string): JobHistoryEntry[] {
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
 * Render the /jobs view (history only). format "json" = full
 * machine-readable object (last 10 history entries); "text" = channel-
 * ready listing (last 5 history entries).
 *
 * Markdown layout (Andryo 2026-10-18: summaries are normal markdown
 * lists, no frame, no width budget - text wraps natively):
 * - recent: `- <state> · <age> · <id>` - state first (the signal), id
 *   last (the lookup key), no webhook noise. Raw state names (no
 *   compression - the 40-col budget that motivated wb-fail is gone).
 * Exported for tests.
 */
export function formatJobsView(
  history: JobHistoryEntry[],
  format: "text" | "json" = "text",
  now: number = Math.floor(Date.now() / 1000),
): string {
  if (format === "json") {
    return JSON.stringify({ history: history.slice(0, 10) }, null, 2);
  }
  const recent = history.slice(0, 5);
  if (recent.length === 0) return "**jobs · none**";
  const lines = [`**recent (newest first) · ${recent.length}**`, ""];
  for (const h of recent) {
    lines.push(`- ${h.state} · ${ageStr(now - h.mtime)} · ${h.id}`);
  }
  return lines.join("\n");
}

/** /jobs entry point: recent history from the ~/.pi-bg-art artifacts
 *  (the drain is declared - there is no in-flight view to merge). opts
 *  override the history source for tests. */
export function jobsView(
  format: "text" | "json" = "text",
  opts: {
    history?: JobHistoryEntry[];
  } = {},
): string {
  return formatJobsView(opts.history ?? scanJobHistory(), format);
}
