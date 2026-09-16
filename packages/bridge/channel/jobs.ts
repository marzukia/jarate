// /jobs: in-flight pi-bg dispatches + recent-completed history (issue #14)
//
// In-flight: the pi-bg wrapper's command line carries profile + task, and the
// wrapper process exists only while the run is live, so `ps` is the reliable
// in-flight marker (the prompt/out artifacts are written at run end). The
// ticket id is NOT in the ps line; it is resolved per-pid from
// /proc/<pid>/cgroup (the escape cgroup path ends in the run_id pi-bg
// prints as the escape path). Unresolvable pid => id:null, never a crash.
//
// History: assembled from the pi-bg-<ticket>-* artifacts pi-bg leaves
// per run (in ~/.pi-bg-art, or $PI_BG_TMPDIR; legacy runs in /tmp are
// still scanned) — raw.out (run started), out.md (run completed,
// non-empty), webhook-failed (callback dead letter), killed (pi-bg-kill
// marker), wb-status (success-path webhook HTTP code, recorded at post
// time).
import { execSync, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { wrapFenceLine } from "./format";
import { FRAME_COL_MAX } from "./frame";

export interface InflightJob {
  /** ticket id (run_id) via /proc/<pid>/cgroup, or null when unresolved */
  id: string | null;
  profile: string;
  age: string;
  task: string;
}

// Resolve the pi-bg ticket id for a pid: /proc/<pid>/cgroup carries the
// cgroup path, which ends in .../pi-bg/<run_id>. procRoot is overridable
// for tests. Any read/parse failure -> null (caller keeps rendering).
export function ticketIdFromPid(
  pid: number,
  procRoot = "/proc",
): string | null {
  try {
    const raw = fs.readFileSync(
      path.join(procRoot, String(pid), "cgroup"),
      "utf8",
    );
    for (const line of raw.split("\n")) {
      // cgroup v2: "0::/path"; v1: "N:controllers:/path"
      const p = line.includes("::")
        ? (line.split("::").pop() ?? "")
        : (line.split(":").pop() ?? "");
      const m = p.match(/pi-bg\/([0-9]{8}-[0-9]{6}-[0-9]+)(?:\/|$)/);
      if (m) return m[1];
    }
  } catch {
    // process gone or /proc/<pid>/cgroup unreadable — id stays null
  }
  return null;
}

// ps etime: "MM:SS", "H:MM:SS", or "D-H:MM:SS" (procps). Raw seconds for
// the dedup comparison; unparseable -> 0.
function etimeToSecs(etime: string): number {
  const d = etime.match(/^(\d+)-(\d+):(\d{2}):(\d{2})$/);
  if (d) return +d[1] * 86400 + +d[2] * 3600 + +d[3] * 60 + +d[4];
  const h = etime.match(/^(\d+):(\d{2}):(\d{2})$/);
  if (h) return +h[1] * 3600 + +h[2] * 60 + +h[3];
  const mm = etime.match(/^(\d+):(\d{2})$/);
  if (mm) return +mm[1] * 60 + +mm[2];
  return 0;
}

// Match the wrapper line shape: <pid> <etime> <bash> <script-path> <profile> <task>
// The script path is EITHER the installed symlink (.../scripts/pi-bg)
// OR the per-run snapshot (.../.pi-bg-art/snap-<run_id>/pi-bg — the
// deploy-swap guard re-execs from a hard-linked copy, 2026-09-15).
// procRoot is overridable so the cgroup id resolution is testable with a
// fake /proc (ticketIdFromPid pattern).
export function parseJobsFromPs(
  psOut: string,
  procRoot: string = "/proc",
): InflightJob[] {
  const out: InflightJob[] = [];
  for (const line of psOut.split("\n")) {
    const m = line
      .trim()
      .match(
        /^(\d+)\s+(\S+)\s+\S*bash\s+\S*(?:scripts\/pi-bg|snap-\d{8}-\d{6}-\d+\/pi-bg)\s+(worker|reviewer)\s+(.+)$/,
      );
    if (!m) continue;
    const task = m[4]
      .trim()
      .replace(/^"+|"+$/g, "")
      .split("\n")[0]
      .slice(0, 70);
    out.push({
      id: ticketIdFromPid(Number(m[1]), procRoot),
      age: m[2],
      profile: m[3],
      task,
    });
  }
  // Dedup by resolved ticket id. pi-bg's heartbeat subshell is a forked
  // child that keeps the wrapper's argv AND cgroup (pi-bg hb loop), so a
  // live run yields TWO ps lines with the same resolved id. Keep the
  // longest etime per id — the wrapper always lives >= its forked
  // helpers — and drop the rest. Null ids pass through untouched (they
  // cannot be matched; degrades to pre-dedup behavior).
  const kept = new Map<string, number>(); // id -> index in result
  const result: InflightJob[] = [];
  for (const j of out) {
    if (j.id === null) {
      result.push(j);
      continue;
    }
    const i = kept.get(j.id);
    if (i === undefined) {
      kept.set(j.id, result.length);
      result.push(j);
    } else if (etimeToSecs(j.age) > etimeToSecs(result[i].age)) {
      result[i] = j;
    }
  }
  return result;
}

export function collectInflightJobs(procRoot: string = "/proc"): InflightJob[] {
  let raw = "";
  try {
    const uid = process.getuid?.();
    // [s]/(s) tricks keep grep itself out of its own match; the second
    // arm catches the per-run snapshot path (deploy-swap guard).
    raw = execSync(
      `ps ${uid !== undefined ? `-u ${uid}` : "-eo"} -o pid,etime,args | grep -E '(s)cripts/pi-bg|snap-[0-9]{8}-[0-9]{6}-[0-9]+/pi-bg'`,
      { encoding: "utf8", timeout: 5000 },
    );
  } catch {
    return [];
  }
  return parseJobsFromPs(raw, procRoot);
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
 * Render the /jobs view. format "json" = full machine-readable object
 * (inflight + last 10 history entries); "text" = channel-ready listing
 * (inflight + last 5 history entries).
 *
 * v3 frame layout (Andryo 2026-09-16: "make better use of the space"):
 * - in-flight: `┣ <id> <profile> · <age>` header row (fits 40), task on
 *   `│ `-gutter continuation lines, wrapped gutter-aware.
 * - recent: `├ <state> · <age> · <id>` - state first (the signal), id
 *   last (the lookup key), no webhook noise. State labels compressed
 *   (webhook-failed -> wb-fail) so the worst row stays under 40.
 * Exported for tests.
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
  const frames: string[] = [];
  if (inflight.length === 0) {
    frames.push("┌ jobs · none in flight\n└");
  } else {
    const lines = [`┌ jobs · ${inflight.length} in flight`];
    for (const j of inflight) {
      // id(19) + profile + age fits the 40-col budget on one row.
      lines.push(
        j.id
          ? `┣ ${j.id} ${j.profile} · ${j.age}`
          : `┣ ${j.profile} · ${j.age}`,
      );
      if (j.task) {
        for (const t of j.task.split("\n")) {
          if (!t.trim()) continue;
          const row = `│ ${t}`;
          lines.push(
            ...(row.length > FRAME_COL_MAX
              ? wrapFenceLine(row, FRAME_COL_MAX)
              : [row]),
          );
        }
      }
    }
    lines.push("└");
    frames.push(lines.join("\n"));
  }
  const recent = history.slice(0, 5);
  if (recent.length > 0) {
    const lines = [`┌ recent (newest first) · ${recent.length}`];
    for (const h of recent) {
      lines.push(
        `├ ${stateLabel(h.state)} · ${ageStr(now - h.mtime)} · ${h.id}`,
      );
    }
    lines.push("└");
    frames.push(lines.join("\n"));
  }
  return frames.join("\n\n");
}

/** Compressed state labels for the text view (json keeps raw states):
 *  worst case `├ wb-fail · 1h59m · <19-char id>` = 36 cols. */
export function stateLabel(state: JobState): string {
  switch (state) {
    case "done":
      return "ok";
    case "webhook-failed":
      return "wb-fail";
    case "killed":
      return "killed";
    case "lost":
      return "lost";
    default:
      // pass unknown states through (never render "undefined")
      return state;
  }
}

/** /jobs entry point: in-flight (ps) + history (/tmp artifacts).
 *  A live run already owns its artifact dir at dispatch time (no out.md
 *  yet), so scanJobHistory sees it as "lost" and it would render in
 *  recent right next to its own in-flight row. Exclude in-flight ids
 *  (non-null only) from the history before formatJobsView slices it —
 *  text and json paths alike. opts override the ps/history sources for
 *  tests. */
export function jobsView(
  format: "text" | "json" = "text",
  opts: {
    inflight?: InflightJob[];
    history?: JobHistoryEntry[];
    procRoot?: string;
  } = {},
): string {
  const inflight = opts.inflight ?? collectInflightJobs(opts.procRoot);
  const inflightIds = new Set(
    inflight.map((j) => j.id).filter((x): x is string => x !== null),
  );
  const history = (opts.history ?? scanJobHistory()).filter(
    (h) => !inflightIds.has(h.id),
  );
  return formatJobsView(inflight, history, format);
}

// ─── /jobs kill | tail (#44) ─────────────────────────────────────────────
// Thin wrappers over the dispatch scripts pi-bg-kill / pi-bg-tail
// (resolved under <scriptsDir>, default $HOME/scripts — the symlinks
// install.sh creates). Async spawn: a real kill can wait up to ~10s for
// the SIGTERM drain, so the event loop must not block. Output is capped
// the same way as runShellPassthrough (20k chars, hard timeout).

export const JOB_TICKET_ID_RE = /^\d{8}-\d{6}-\d+$/;

const JOB_SCRIPT_TIMEOUT_MS = 20_000;
const JOB_SCRIPT_OUT_CAP = 20_000;

export function piBgScriptPath(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
  scriptsDir?: string,
): string {
  const dir = scriptsDir ?? path.join(env.HOME ?? "", "scripts");
  return path.join(dir, name);
}

export function runPiBgScript(
  name: string,
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
  scriptsDir?: string,
): Promise<{ out: string; code: number; timedOut: boolean }> {
  const script = piBgScriptPath(name, env, scriptsDir);
  return new Promise((resolve) => {
    if (!fs.existsSync(script)) {
      resolve({
        out: `${name} not found at ${script} (install.sh link missing)`,
        code: 127,
        timedOut: false,
      });
      return;
    }
    let p: ReturnType<typeof spawn>;
    try {
      p = spawn(script, args, { env });
    } catch (e) {
      resolve({
        out: `spawn failed: ${e instanceof Error ? e.message : String(e)}`,
        code: 1,
        timedOut: false,
      });
      return;
    }
    let out = "";
    let timedOut = false;
    const cap = (s: string) => {
      if (out.length < JOB_SCRIPT_OUT_CAP)
        out += s.slice(0, JOB_SCRIPT_OUT_CAP - out.length);
    };
    const t = setTimeout(() => {
      timedOut = true;
      try {
        p.kill("SIGKILL");
      } catch {
        /* already dead */
      }
    }, JOB_SCRIPT_TIMEOUT_MS);
    p.stdout?.on("data", (d) => cap(String(d)));
    p.stderr?.on("data", (d) => cap(String(d)));
    p.on("error", (e) => {
      clearTimeout(t);
      resolve({ out: `spawn failed: ${e.message}`, code: 1, timedOut: false });
    });
    p.on("close", (code) => {
      clearTimeout(t);
      resolve({ out, code: code ?? 1, timedOut });
    });
  });
}

/** Fenced code block sized to the content's backtick runs (tail output
 *  regularly contains code fences of its own). */
function jobWrapFence(t: string): string {
  const n = (t.match(/`+/g) || ["`"]).reduce(
    (m, r) => Math.max(m, r.length),
    0,
  );
  const f = "`".repeat(Math.max(3, n + 1));
  return `${f}\n${t}\n${f}`;
}

const TAIL_MAX_LINES = 40;
const TAIL_LINE_MAX = FRAME_COL_MAX; // mobile budget, same as the run frames

/** Cap + hard-wrap tail output and fence it. Keeps the LAST TAIL_MAX_LINES
 *  lines (a tail is about the newest output) and splits overlong lines. */
export function formatTail(out: string): string {
  let lines = out.replace(/\n$/, "").split("\n");
  const dropped = Math.max(0, lines.length - TAIL_MAX_LINES);
  if (dropped > 0) lines = lines.slice(-TAIL_MAX_LINES);
  const wrapped: string[] = [];
  for (const l of lines) {
    if (l.length <= TAIL_LINE_MAX) {
      wrapped.push(l);
      continue;
    }
    for (let i = 0; i < l.length; i += TAIL_LINE_MAX)
      wrapped.push(l.slice(i, i + TAIL_LINE_MAX));
  }
  const head = dropped > 0 ? `[..] ${dropped} earlier lines\n` : "";
  return jobWrapFence(`${head}${wrapped.join("\n")}`);
}

/** /jobs kill <id>: cancel an in-flight run via its cgroup. Channel line
 *  comes back fenced and ready to post. */
export async function jobsKill(
  id: string,
  env: NodeJS.ProcessEnv = process.env,
  scriptsDir?: string,
): Promise<string> {
  if (!JOB_TICKET_ID_RE.test(id))
    return jobWrapFence(
      `[!] usage: /jobs kill <id> (ticket id, e.g. 20260910-135501-48211)`,
    );
  const r = await runPiBgScript("pi-bg-kill", [id], env, scriptsDir);
  if (r.timedOut) return jobWrapFence(`[!] pi-bg-kill timed out for ${id}`);
  if (r.code === 0) return jobWrapFence(`[ok] killed ${id}`);
  const detail =
    r.out.split("\n").find((l) => l.trim() !== "") ?? `exit ${r.code}`;
  return jobWrapFence(`[!] ${detail}`);
}

/** /jobs tail <id> [--n N]: a run's live output, capped to the last
 *  TAIL_MAX_LINES lines, wrapped at TAIL_LINE_MAX, fenced. */
export async function jobsTail(
  id: string,
  n: number,
  env: NodeJS.ProcessEnv = process.env,
  scriptsDir?: string,
): Promise<string> {
  if (!JOB_TICKET_ID_RE.test(id))
    return jobWrapFence(
      `[!] usage: /jobs tail <id> [--n N] (ticket id, e.g. 20260910-135501-48211)`,
    );
  const lines = Math.max(1, Math.min(200, Math.floor(n) || 40));
  const r = await runPiBgScript(
    "pi-bg-tail",
    [id, String(lines)],
    env,
    scriptsDir,
  );
  if (r.timedOut) return jobWrapFence(`[!] pi-bg-tail timed out for ${id}`);
  if (r.code !== 0) {
    const detail =
      r.out.split("\n").find((l) => l.trim() !== "") ?? `exit ${r.code}`;
    return jobWrapFence(`[!] ${detail}`);
  }
  if (r.out.trim() === "") return jobWrapFence(`[!] no output for ${id}`);
  return formatTail(r.out);
}
