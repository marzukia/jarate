/**
 * /undo + /redo — revert the last completed assistant run, including the
 * file changes it made (and reapply on /redo, one level deep).
 *
 * Conversation: a pi session is JSONL; on resume the leaf is the LAST line
 * of the file. /undo truncates the file at the trigger message of the last
 * assistant turn (keeping the trigger) and parks the removed lines for /redo,
 * then the caller restarts pi (same mechanism as /reset) so the new leaf
 * takes effect.
 *
 * Files: one store entry per run under ~/.pi/agent/undo/runs/ (pruned to
 * the last 10):
 *  - git repo cwd: pre/post snapshots = HEAD + worktree patch + untracked
 *    file copies. Restore = reset --hard + git apply + untracked copy-back,
 *    so commits made during the run are undone too.
 *  - non-git cwd: preimages of every file the run touched via write/edit
 *    (captured before the first write; files the run created restore as
 *    absent). bash-modified files are not tracked (best-effort, like the
 *    kimaki reference).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";

const MAX_STORED_BYTES = 20 * 1024 * 1024; // per-file cap for stored copies
const GIT_TIMEOUT_MS = 15_000;
const MAX_RUNS = 10;

// ─── Store layout ─────────────────────────────────────────────────────────
//   ~/.pi/agent/undo/runs/<seq>_<ts>/
//     meta.json              { cwd, mode, sessionFile, ts, seq }
//     pre.git.json           git mode: { head, files }
//     pre.patch              git mode: git diff HEAD at run start
//     pre/untracked/<rel>    git mode: untracked file copies at run start
//     pre.files.json         files mode: [{ abs, pre: <enc> | null }]
//     pre/files/<enc(abs)>   files mode: preimages
//     post.*                 same shape, captured at run end
//   ~/.pi/agent/undo/redo.json   { run, sessionFile, removed: string[] }

export function storeRoot(): string {
  const home = process.env.HOME || "/root";
  return path.join(home, ".pi", "agent", "undo");
}
function runsDir(): string {
  return path.join(storeRoot(), "runs");
}
function redoPath(): string {
  return path.join(storeRoot(), "redo.json");
}

/** Encode an absolute path as a flat, disk-safe file name. */
export function encPath(abs: string): string {
  return encodeURIComponent(abs);
}

// ─── Git snapshots ────────────────────────────────────────────────────────

interface GitSnap {
  head: string | null;
  /** diff HEAD at capture time (worktree incl. staged vs commit) */
  patch: string | null;
  /** tracked files changed vs head (for the ack count) */
  files: string[];
  /** untracked files (relative to cwd) */
  untracked: string[];
}

function git(cwd: string, args: string[], input?: string): string {
  return execFileSync("git", args, {
    cwd,
    timeout: GIT_TIMEOUT_MS,
    encoding: "utf8",
    input,
    stdio: ["pipe", "pipe", "pipe"],
  });
}

export function isGitRepo(cwd: string): boolean {
  try {
    git(cwd, ["rev-parse", "--is-inside-work-tree"]);
    return true;
  } catch {
    return false;
  }
}

/** Capture the repo state (HEAD, worktree diff, untracked copies) into <dir>/<prefix>/. */
function captureGitSnap(cwd: string, dir: string, prefix: "pre" | "post"): void {
  let head: string | null = null;
  try {
    head = git(cwd, ["rev-parse", "HEAD"]).trim();
  } catch {
    head = null; // empty repo (no commits yet)
  }
  let patch: string | null = null;
  let files: string[] = [];
  if (head) {
    try {
      const raw = git(cwd, ["diff", "HEAD"]);
      if (raw.trim().length > 0) patch = raw;
      files = git(cwd, ["diff", "HEAD", "--name-only"]).trim().split("\n").filter(Boolean);
    } catch {}
  }
  let untracked: string[] = [];
  try {
    untracked = git(cwd, ["ls-files", "--others", "--exclude-standard"])
      .trim()
      .split("\n")
      .filter(Boolean);
  } catch {}

  const snap: GitSnap = { head, patch, files, untracked };
  const snapDir = path.join(dir, prefix);
  fs.mkdirSync(path.join(snapDir, "untracked"), { recursive: true });
  fs.writeFileSync(path.join(snapDir, `${prefix}.git.json`), JSON.stringify(snap, null, 1));
  if (patch !== null) fs.writeFileSync(path.join(snapDir, `${prefix}.patch`), patch);
  for (const rel of untracked) {
    const src = path.join(cwd, rel);
    try {
      if (fs.statSync(src).size > MAX_STORED_BYTES) continue;
      fs.copyFileSync(src, path.join(snapDir, "untracked", rel));
    } catch {}
  }
}

/** Read back a stored git snapshot (null if missing/corrupt). */
function readGitSnap(dir: string, prefix: "pre" | "post"): GitSnap | null {
  const p = path.join(dir, prefix, `${prefix}.git.json`);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, "utf8")) as GitSnap;
  } catch {
    return null;
  }
}

/** Restore a stored git snapshot into cwd. Returns the number of files touched. */
function applyGitSnap(cwd: string, dir: string, prefix: "pre" | "post"): number {
  const snap = readGitSnap(dir, prefix);
  if (!snap) return 0;
  const snapDir = path.join(dir, prefix);
  let count = 0;
  let currentHead: string | null = null;
  try {
    currentHead = git(cwd, ["rev-parse", "HEAD"]).trim();
  } catch {}
  if (snap.head) {
    // count the files whose state will change: worktree/index diff vs the
    // snapshot head, plus any commits made after it
    const touched = new Set<string>();
    try {
      for (const f of git(cwd, ["diff", "--name-only", snap.head]).trim().split("\n")) {
        if (f) touched.add(f);
      }
    } catch {}
    if (currentHead !== null && currentHead !== snap.head) {
      try {
        for (const f of git(cwd, ["diff", "--name-only", snap.head, currentHead]).trim().split("\n")) {
          if (f) touched.add(f);
        }
      } catch {}
    }
    count += touched.size;
    try {
      git(cwd, ["reset", "--hard", snap.head]);
    } catch (e) {
      console.error(`[undo] git reset failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  const patchFile = path.join(snapDir, `${prefix}.patch`);
  if (snap.patch !== null && fs.existsSync(patchFile)) {
    try {
      git(cwd, ["apply", "--whitespace=nowarn", patchFile]);
    } catch (e) {
      console.error(`[undo] git apply failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  // Restore untracked files from the snapshot.
  for (const rel of snap.untracked) {
    const src = path.join(snapDir, "untracked", rel);
    const dst = path.join(cwd, rel);
    try {
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(src, dst);
      count += 1;
    } catch {}
  }
  // Delete untracked files/dirs that exist now but not in the snapshot
  // (created after it — i.e. by the undone run, best-effort).
  try {
    const current = git(cwd, ["ls-files", "--others", "--exclude-standard"])
      .trim()
      .split("\n")
      .filter(Boolean);
    const keep = new Set(snap.untracked);
    for (const rel of current) {
      if (keep.has(rel)) continue;
      fs.rmSync(path.join(cwd, rel), { force: true });
      count += 1;
    }
  } catch (e) {
    console.error(`[undo] untracked cleanup failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  return count;
}

// ─── File snapshots (non-git dirs) ─────────────────────────────────────────

interface FileSnapEntry {
  abs: string;
  /** stored preimage name under pre/files/, or null = absent before the run */
  pre: string | null;
}

function writeFileSnap(dir: string, prefix: "pre" | "post", entries: FileSnapEntry[]): void {
  fs.mkdirSync(path.join(dir, prefix, "files"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, prefix, `${prefix}.files.json`),
    JSON.stringify({ files: entries }, null, 1),
  );
}

function readFileSnap(dir: string, prefix: "pre" | "post"): FileSnapEntry[] {
  const p = path.join(dir, prefix, `${prefix}.files.json`);
  if (!fs.existsSync(p)) return [];
  try {
    return (JSON.parse(fs.readFileSync(p, "utf8")) as { files: FileSnapEntry[] }).files;
  } catch {
    return [];
  }
}

function copyIfFits(src: string, dst: string): boolean {
  try {
    if (fs.statSync(src).size > MAX_STORED_BYTES) return false;
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
    return true;
  } catch {
    return false;
  }
}

/** Restore a stored file snapshot. Returns the number of files touched. */
function applyFileSnap(dir: string, prefix: "pre" | "post"): number {
  const entries = readFileSnap(dir, prefix);
  let count = 0;
  for (const e of entries) {
    if (prefix === "pre") {
      if (e.pre === null) {
        try {
          if (fs.existsSync(e.abs)) {
            fs.rmSync(e.abs, { force: true });
            count += 1;
          }
        } catch {}
      } else {
        const src = path.join(dir, "pre", "files", e.pre);
        if (copyIfFits(src, e.abs)) count += 1;
      }
    } else {
      const src = path.join(dir, "post", "files", encPath(e.abs));
      if (copyIfFits(src, e.abs)) count += 1;
    }
  }
  return count;
}

// ─── Run store ─────────────────────────────────────────────────────────────

export interface UndoRun {
  /** run dir under runs/ */
  dir: string;
  cwd: string;
  git: boolean;
  /** non-git: abs path -> stored preimage name (null = absent before run) */
  preFiles: Map<string, string | null>;
}

/** Start a run entry: capture the pre-run state. Called once per run. */
export function startRun(cwd: string): UndoRun | null {
  try {
    const rd = runsDir();
    fs.mkdirSync(rd, { recursive: true });
    // monotonic seq so dir names sort in creation order
    let seq = 0;
    for (const d of fs.readdirSync(rd)) {
      const m = d.match(/^(\d+)_/);
      if (m) seq = Math.max(seq, Number(m[1]));
    }
    const name = `${String(seq + 1).padStart(5, "0")}_${Date.now()}`;
    const dir = path.join(rd, name);
    fs.mkdirSync(dir, { recursive: true });
    const gitRepo = isGitRepo(cwd);
    const run: UndoRun = { dir, cwd, git: gitRepo, preFiles: new Map() };
    if (gitRepo) {
      try {
        captureGitSnap(cwd, dir, "pre");
      } catch (e) {
        console.error(`[undo] pre snapshot failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    return run;
  } catch (e) {
    console.error(`[undo] startRun failed: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

/**
 * Non-git preimage capture: called BEFORE a write/edit executes, on the
 * run's first touch of a path. Keeps the true pre-run content (or an
 * absent marker) so /undo can restore it.
 */
export function stageFileTouch(run: UndoRun, cwd: string, absPath: string): void {
  if (run.git) return;
  if (run.preFiles.has(absPath)) return; // first touch only
  const p = path.resolve(cwd, absPath);
  let pre: string | null = null;
  try {
    if (fs.existsSync(p)) {
      const dst = path.join(run.dir, "pre", "files", encPath(p));
      if (copyIfFits(p, dst)) pre = encPath(p);
    }
  } catch {}
  run.preFiles.set(p, pre);
}

/** Finish a run entry: capture the post-run state, write meta, prune. */
export function finishRun(run: UndoRun, cwd: string, sessionFile: string | null): void {
  try {
    if (run.git) {
      captureGitSnap(cwd, run.dir, "post");
    } else {
      const entries: FileSnapEntry[] = [];
      for (const [abs, pre] of run.preFiles) {
        entries.push({ abs, pre });
        // postimage of every touched file that still exists at run end
        // (includes files the run CREATED — needed for /redo)
        const dst = path.join(run.dir, "post", "files", encPath(abs));
        try {
          if (fs.existsSync(abs)) copyIfFits(abs, dst);
        } catch {}
      }
      writeFileSnap(run.dir, "pre", entries);
      writeFileSnap(run.dir, "post", entries);
    }
    const meta = {
      cwd: run.cwd,
      mode: run.git ? "git" : "files",
      sessionFile,
      ts: new Date().toISOString(),
      seq: path.basename(run.dir).match(/^(\d+)_/)?.[1] ?? "0",
    };
    fs.writeFileSync(path.join(run.dir, "meta.json"), JSON.stringify(meta, null, 1));
    pruneRuns();
  } catch (e) {
    console.error(`[undo] finishRun failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** Keep only the last MAX_RUNS run dirs. */
export function pruneRuns(): void {
  try {
    const rd = runsDir();
    if (!fs.existsSync(rd)) return;
    const dirs = fs.readdirSync(rd).filter((d) => /^\d+_\d+$/.test(d));
    dirs.sort();
    for (const d of dirs.slice(0, -MAX_RUNS)) {
      fs.rmSync(path.join(rd, d), { recursive: true, force: true });
    }
  } catch (e) {
    console.error(`[undo] prune failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

interface RunMeta {
  cwd: string;
  mode: "git" | "files";
  sessionFile: string | null;
  ts: string;
  seq: string;
}

function readRunMeta(dir: string): RunMeta | null {
  const p = path.join(dir, "meta.json");
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, "utf8")) as RunMeta;
  } catch {
    return null;
  }
}

/** Newest completed run for this session file (newest run if none known). */
export function latestRun(sessionFile: string | null): { dir: string; meta: RunMeta } | null {
  const rd = runsDir();
  if (!fs.existsSync(rd)) return null;
  const dirs = fs.readdirSync(rd).filter((d) => /^\d+_\d+$/.test(d)).sort().reverse();
  for (const d of dirs) {
    const meta = readRunMeta(path.join(rd, d));
    if (!meta) continue;
    if (sessionFile && meta.sessionFile && meta.sessionFile !== sessionFile) continue;
    return { dir: path.join(rd, d), meta };
  }
  return null;
}

/** Apply a run's stored snapshot ("pre" = revert, "post" = reapply). Returns file count. */
function applyRunSnapshot(runDir: string, meta: RunMeta, which: "pre" | "post"): number {
  if (meta.mode === "git") return applyGitSnap(meta.cwd, runDir, which);
  return applyFileSnap(runDir, which);
}

// ─── Session file ──────────────────────────────────────────────────────────

/** Fallback session discovery: newest .jsonl under cwd's session dir (same scan as /reset). */
export function findSessionFile(cwd: string): string | null {
  const home = process.env.HOME || "/root";
  const sessionsBase = path.join(home, ".pi", "agent", "sessions");
  const encDir = path.join(sessionsBase, "-" + cwd.replace(/\//g, "-") + "-");
  const candidates: Array<[string, number]> = [];
  const scan = (dir: string) => {
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith(".jsonl")) continue; // skips *.jsonl.reset-* / *.undo-tmp
      const p = path.join(dir, f);
      try {
        candidates.push([p, fs.statSync(p).mtimeMs]);
      } catch {}
    }
  };
  try {
    if (fs.existsSync(encDir)) scan(encDir);
    else if (fs.existsSync(sessionsBase)) {
      for (const d of fs.readdirSync(sessionsBase)) {
        const sub = path.join(sessionsBase, d);
        try {
          if (fs.statSync(sub).isDirectory()) scan(sub);
        } catch {}
      }
    }
  } catch {
    return null;
  }
  candidates.sort((a, b) => b[1] - a[1]);
  return candidates[0]?.[0] ?? null;
}

function isTrigger(entry: any): boolean {
  return (
    (entry.type === "message" && entry.message?.role === "user") ||
    entry.type === "custom_message"
  );
}

/**
 * Truncate the session to the state before the last assistant turn:
 * find the last assistant message on the active path (leaf = last line,
 * walk parentId to root), find the closest trigger (user message or
 * channel custom message) before it, keep the file through that trigger.
 * Returns the removed lines (for /redo) or null when there is nothing to
 * revert. The file is rewritten atomically.
 */
export function truncateSession(sessionFile: string): string[] | null {
  const raw = fs.readFileSync(sessionFile, "utf8");
  const lines = raw.split("\n").filter((l) => l.trim().length > 0);
  if (lines.length < 2) return null;

  const byId = new Map<string, number>();
  for (let i = 1; i < lines.length; i++) {
    try {
      const e = JSON.parse(lines[i]);
      if (e?.id) byId.set(e.id, i);
    } catch {}
  }
  // active path: last line (leaf) up to the root entry
  const pathIdx: number[] = [];
  let leafId: string | null = null;
  try {
    leafId = JSON.parse(lines[lines.length - 1])?.id ?? null;
  } catch {
    return null;
  }
  let cur: string | null = leafId;
  while (cur !== null && byId.has(cur)) {
    pathIdx.push(byId.get(cur)!);
    cur = (JSON.parse(lines[byId.get(cur)!]) as any)?.parentId ?? null;
  }
  // last assistant on the path (closest to the leaf)
  let assistantPos = -1;
  for (let i = 0; i < pathIdx.length; i++) {
    try {
      const e = JSON.parse(lines[pathIdx[i]]);
      if (e?.type === "message" && e.message?.role === "assistant") {
        assistantPos = i;
        break;
      }
    } catch {}
  }
  if (assistantPos === -1) return null;
  // closest trigger strictly before the assistant = root-ward of it in
  // pathIdx (which runs leaf -> root)
  let keepIdx = 0; // default: keep header only
  for (let i = assistantPos + 1; i < pathIdx.length; i++) {
    try {
      if (isTrigger(JSON.parse(lines[pathIdx[i]]))) {
        keepIdx = pathIdx[i];
        break;
      }
    } catch {}
  }
  const kept = lines.slice(0, keepIdx + 1);
  const removed = lines.slice(keepIdx + 1);
  if (removed.length === 0) return null;
  const tmp = `${sessionFile}.undo-tmp`;
  fs.writeFileSync(tmp, kept.join("\n") + "\n");
  fs.renameSync(tmp, sessionFile);
  return removed;
}

/** Re-append lines removed by truncateSession (for /redo). */
export function reappendSession(sessionFile: string, removed: string[]): void {
  fs.appendFileSync(sessionFile, removed.join("\n") + "\n");
}

// ─── Redo record ───────────────────────────────────────────────────────────

interface RedoRecord {
  run: string | null;
  sessionFile: string | null;
  removed: string[];
}

function readRedo(): RedoRecord | null {
  const p = redoPath();
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, "utf8")) as RedoRecord;
  } catch {
    return null;
  }
}

// ─── Commands ──────────────────────────────────────────────────────────────

export interface UndoResult {
  text: string;
  /** true when the session file changed and pi must restart to pick up the new leaf */
  restarted: boolean;
}

function undoAck(files: number, conversation: boolean): string {
  const parts: string[] = [];
  if (files > 0) parts.push(`${files} file${files === 1 ? "" : "s"}`);
  if (conversation) parts.push("conversation");
  if (parts.length === 0) return "[!] nothing to undo";
  return `[ok] undone: ${parts.join(" + ")}`;
}

/**
 * /undo: revert the last completed run for this session.
 * Restores the run's pre-run file state (applied to the snapshot's own cwd)
 * and truncates the session at the run's trigger. Parks a redo record for
 * /redo.
 */
export function performUndo(sessionFile: string | null): UndoResult {
  const run = latestRun(sessionFile);
  let removed: string[] | null = null;
  if (sessionFile && fs.existsSync(sessionFile)) {
    try {
      removed = truncateSession(sessionFile);
    } catch (e) {
      console.error(`[undo] truncate failed: ${e instanceof Error ? e.message : String(e)}`);
      removed = null;
    }
  }
  let files = 0;
  if (run) {
    try {
      files = applyRunSnapshot(run.dir, run.meta, "pre");
    } catch (e) {
      console.error(`[undo] restore failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  if (files === 0 && (!removed || removed.length === 0)) {
    return { text: "[!] nothing to undo", restarted: false };
  }
  const rec: RedoRecord = {
    run: run ? path.basename(run.dir) : null,
    sessionFile,
    removed: removed ?? [],
  };
  try {
    fs.mkdirSync(storeRoot(), { recursive: true });
    fs.writeFileSync(redoPath(), JSON.stringify(rec, null, 1));
  } catch (e) {
    console.error(`[undo] redo record write failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  return { text: undoAck(files, (removed?.length ?? 0) > 0), restarted: (removed?.length ?? 0) > 0 };
}

/** /redo: reapply the undone run (one level deep). */
export function performRedo(): UndoResult {
  const rec = readRedo();
  if (!rec) return { text: "[!] nothing to redo", restarted: false };
  let files = 0;
  if (rec.run) {
    const runDir = path.join(runsDir(), rec.run);
    const meta = readRunMeta(runDir);
    if (meta) {
      try {
        files = applyRunSnapshot(runDir, meta, "post");
      } catch (e) {
        console.error(`[undo] redo restore failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }
  let conversation = false;
  if (rec.sessionFile && rec.removed.length > 0 && fs.existsSync(rec.sessionFile)) {
    try {
      reappendSession(rec.sessionFile, rec.removed);
      conversation = true;
    } catch (e) {
      console.error(`[undo] redo reappend failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  try {
    fs.rmSync(redoPath(), { force: true });
  } catch {}
  if (files === 0 && !conversation) return { text: "[!] nothing to redo", restarted: false };
  const parts: string[] = [];
  if (files > 0) parts.push(`${files} file${files === 1 ? "" : "s"}`);
  if (conversation) parts.push("conversation");
  return { text: `[ok] redone: ${parts.join(" + ")}`, restarted: conversation };
}
