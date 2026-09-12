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

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

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
  /** true when <prefix>.patch was written (diff HEAD --binary) */
  hasPatch: boolean;
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

/** Raw-buffer git: `diff --binary` output must not pass through utf8. */
function gitBuf(cwd: string, args: string[], input?: string): Buffer {
  return execFileSync("git", args, {
    cwd,
    timeout: GIT_TIMEOUT_MS,
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
function captureGitSnap(
  cwd: string,
  dir: string,
  prefix: "pre" | "post",
): void {
  let head: string | null = null;
  try {
    head = git(cwd, ["rev-parse", "HEAD"]).trim();
  } catch {
    head = null; // empty repo (no commits yet)
  }
  let hasPatch = false;
  let files: string[] = [];
  const snapDir = path.join(dir, prefix);
  fs.mkdirSync(path.join(snapDir, "untracked"), { recursive: true });
  if (head) {
    try {
      // --binary + raw buffer: a text-only diff cannot carry binary file
      // changes, so one binary file used to fail `git apply` and drop the
      // ENTIRE patch (reviewer F2).
      const raw = gitBuf(cwd, ["diff", "HEAD", "--binary"]);
      if (raw.length > 0) {
        fs.writeFileSync(path.join(snapDir, `${prefix}.patch`), raw);
        hasPatch = true;
      }
      files = git(cwd, ["diff", "HEAD", "--name-only"])
        .trim()
        .split("\n")
        .filter(Boolean);
    } catch {}
  }
  let untracked: string[] = [];
  try {
    untracked = git(cwd, ["ls-files", "--others", "--exclude-standard"])
      .trim()
      .split("\n")
      .filter(Boolean);
  } catch {}

  const snap: GitSnap = { head, hasPatch, files, untracked };
  fs.writeFileSync(
    path.join(snapDir, `${prefix}.git.json`),
    JSON.stringify(snap, null, 1),
  );
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

/** Paths the untracked copy-back/cleanup must never touch (F10): the
 * session file itself and anything under the pi sessions dir, when they
 * live inside a git repo. */
function isUndoExcludedPath(abs: string, sessionFile: string | null): boolean {
  if (sessionFile) {
    if (abs === sessionFile) return true;
    if (abs.startsWith(`${sessionFile}.undo-`)) return true; // F8 backup
  }
  return abs.includes("/.pi/agent/sessions/");
}

/** File names a patch touches (works for text and binary sections: the
 * `diff --git` header lines are always ASCII). */
function patchPatchNames(patchFile: string): Set<string> {
  const names = new Set<string>();
  try {
    const raw = fs.readFileSync(patchFile, "utf8");
    // quoted (paths with spaces) or bare path forms; must not cross lines,
    // because binary patch bodies contain " characters
    const re =
      /^diff --git (?:"a\/([^"]+)"|a\/(\S+)) ?(?:"b\/([^"]+)"|b\/(\S+))/gm;
    for (const m of raw.matchAll(re)) {
      const name = m[3] ?? m[4] ?? m[1] ?? m[2];
      if (name) names.add(name);
    }
  } catch {}
  return names;
}

/** Restore a stored git snapshot into cwd. Returns the number of files touched. */
function applyGitSnap(
  cwd: string,
  dir: string,
  prefix: "pre" | "post",
  sessionFile: string | null,
): number {
  const snap = readGitSnap(dir, prefix);
  if (!snap) return 0;
  const snapDir = path.join(dir, prefix);
  // set-based count: files the reset reverts + files the patch re-applies
  // + untracked copies/deletes. (Patch-only changes on a clean worktree
  // used to count as 0, so /redo said "nothing to redo".)
  const touched = new Set<string>();
  let currentHead: string | null = null;
  try {
    currentHead = git(cwd, ["rev-parse", "HEAD"]).trim();
  } catch {}
  if (snap.head) {
    // count the files whose state will change: worktree/index diff vs the
    // snapshot head, plus any commits made after it
    try {
      for (const f of git(cwd, ["diff", "--name-only", snap.head])
        .trim()
        .split("\n")) {
        if (f) touched.add(f);
      }
    } catch {}
    if (currentHead !== null && currentHead !== snap.head) {
      try {
        for (const f of git(cwd, [
          "diff",
          "--name-only",
          snap.head,
          currentHead,
        ])
          .trim()
          .split("\n")) {
          if (f) touched.add(f);
        }
      } catch {}
    }
    try {
      git(cwd, ["reset", "--hard", snap.head]);
    } catch (e) {
      console.error(
        `[undo] git reset failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
  const patchFile = path.join(snapDir, `${prefix}.patch`);
  if (snap.hasPatch && fs.existsSync(patchFile)) {
    try {
      git(cwd, ["apply", "--binary", "--whitespace=nowarn", patchFile]);
      for (const f of patchPatchNames(patchFile)) touched.add(f);
    } catch (e) {
      console.error(
        `[undo] git apply failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
  // Restore untracked files from the snapshot.
  for (const rel of snap.untracked) {
    const dst = path.join(cwd, rel);
    if (isUndoExcludedPath(dst, sessionFile)) continue; // F10
    const src = path.join(snapDir, "untracked", rel);
    try {
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(src, dst);
      touched.add(rel);
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
      const dst = path.join(cwd, rel);
      if (isUndoExcludedPath(dst, sessionFile)) continue; // F10 (e.g. the .undo-<ts> backup)
      fs.rmSync(dst, { force: true });
      touched.add(rel);
    }
  } catch (e) {
    console.error(
      `[undo] untracked cleanup failed: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  return touched.size;
}

// ─── File snapshots (non-git dirs) ─────────────────────────────────────────

interface FileSnapEntry {
  abs: string;
  /** stored preimage name under pre/files/, null = absent before the run,
   *  or PRE_CAP_SKIPPED = existed before but was over the size cap (F7) */
  pre: string | null;
}

/** Sentinel: pre-existing file existed at run start but was too big to
 * store. /undo must NOT delete it (that would destroy un-restorable data). */
const PRE_CAP_SKIPPED = "cap";

function writeFileSnap(
  dir: string,
  prefix: "pre" | "post",
  entries: FileSnapEntry[],
): void {
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
    return (
      JSON.parse(fs.readFileSync(p, "utf8")) as { files: FileSnapEntry[] }
    ).files;
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

/** Restore a stored file snapshot. Returns touched + cap-skipped counts. */
function applyFileSnap(
  dir: string,
  prefix: "pre" | "post",
): { count: number; skipped: number } {
  const entries = readFileSnap(dir, prefix);
  let count = 0;
  let skipped = 0;
  for (const e of entries) {
    if (prefix === "pre") {
      if (e.pre === null) {
        try {
          if (fs.existsSync(e.abs)) {
            fs.rmSync(e.abs, { force: true });
            count += 1;
          }
        } catch {}
      } else if (e.pre === PRE_CAP_SKIPPED) {
        // F7: pre-existing >20MB file: keep it, do not delete it.
        skipped += 1;
      } else {
        const src = path.join(dir, "pre", "files", e.pre);
        if (copyIfFits(src, e.abs)) count += 1;
      }
    } else {
      const src = path.join(dir, "post", "files", encPath(e.abs));
      if (copyIfFits(src, e.abs)) count += 1;
    }
  }
  return { count, skipped };
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
        console.error(
          `[undo] pre snapshot failed: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
    return run;
  } catch (e) {
    console.error(
      `[undo] startRun failed: ${e instanceof Error ? e.message : String(e)}`,
    );
    return null;
  }
}

/**
 * Non-git preimage capture: called BEFORE a write/edit executes, on the
 * run's first touch of a path. Keeps the true pre-run content (or an
 * absent marker) so /undo can restore it.
 */
export function stageFileTouch(
  run: UndoRun,
  cwd: string,
  absPath: string,
): void {
  if (run.git) return;
  if (run.preFiles.has(absPath)) return; // first touch only
  const p = path.resolve(cwd, absPath);
  let pre: string | null = null;
  try {
    if (fs.existsSync(p)) {
      const dst = path.join(run.dir, "pre", "files", encPath(p));
      if (copyIfFits(p, dst)) pre = encPath(p);
      else pre = PRE_CAP_SKIPPED; // F7: existed, but too big to store
    }
  } catch {}
  run.preFiles.set(p, pre);
}

/** Finish a run entry: capture the post-run state, write meta, prune.
 * `assistantOutput` (F3): whether the run produced an assistant answer.
 * Runs that answered nothing (e.g. /stop before the first step) must not
 * become /undo's target — otherwise the file revert and the conversation
 * cut point at different turns. */
export function finishRun(
  run: UndoRun,
  cwd: string,
  sessionFile: string | null,
  assistantOutput = true,
): void {
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
      assistantOutput,
    };
    fs.writeFileSync(
      path.join(run.dir, "meta.json"),
      JSON.stringify(meta, null, 1),
    );
    pruneRuns();
  } catch (e) {
    console.error(
      `[undo] finishRun failed: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

/** Keep only the last MAX_RUNS run dirs — except the one a live redo.json
 * references (F5): pruning it would make /redo silently lose the files. */
export function pruneRuns(): void {
  try {
    const rd = runsDir();
    if (!fs.existsSync(rd)) return;
    const dirs = fs.readdirSync(rd).filter((d) => /^\d+_\d+$/.test(d));
    dirs.sort();
    const pin = readRedo()?.run ?? null;
    for (const d of dirs.slice(0, -MAX_RUNS)) {
      if (d === pin) continue;
      fs.rmSync(path.join(rd, d), { recursive: true, force: true });
    }
  } catch (e) {
    console.error(
      `[undo] prune failed: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

interface RunMeta {
  cwd: string;
  mode: "git" | "files";
  sessionFile: string | null;
  ts: string;
  seq: string;
  /** F3: false = run produced no assistant answer (e.g. aborted early) */
  assistantOutput?: boolean;
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

/** Newest completed run for this session file (newest run if none known).
 * Skips runs that produced no assistant output (F3) so /undo does not
 * cut the PREVIOUS run's conversation while keeping the empty run's files;
 * falls back to empty runs only when there is nothing else. */
export function latestRun(
  sessionFile: string | null,
): { dir: string; meta: RunMeta } | null {
  const rd = runsDir();
  if (!fs.existsSync(rd)) return null;
  const dirs = fs
    .readdirSync(rd)
    .filter((d) => /^\d+_\d+$/.test(d))
    .sort()
    .reverse();
  const pass = (withOutput: boolean) => {
    for (const d of dirs) {
      const meta = readRunMeta(path.join(rd, d));
      if (!meta) continue;
      if (sessionFile && meta.sessionFile && meta.sessionFile !== sessionFile)
        continue;
      const has = meta.assistantOutput !== false;
      if (withOutput ? !has : has) continue;
      return { dir: path.join(rd, d), meta };
    }
    return null;
  };
  return pass(true) ?? pass(false);
}

/** Apply a run's stored snapshot ("pre" = revert, "post" = reapply). */
function applyRunSnapshot(
  runDir: string,
  meta: RunMeta,
  which: "pre" | "post",
): { files: number; skipped: number } {
  if (meta.mode === "git")
    return {
      files: applyGitSnap(meta.cwd, runDir, which, meta.sessionFile),
      skipped: 0,
    };
  const r = applyFileSnap(runDir, which);
  return { files: r.count, skipped: which === "pre" ? r.skipped : 0 };
}

// ─── Session file ──────────────────────────────────────────────────────────

/** Base dir for this agent's pi session store (shared discovery root). */
export function sessionsBaseDir(): string {
  const home = process.env.HOME || "/root";
  return path.join(home, ".pi", "agent", "sessions");
}

/** Fallback session discovery: newest .jsonl under cwd's session dir (same scan as /reset). */
export function findSessionFile(cwd: string): string | null {
  const sessionsBase = sessionsBaseDir();
  const encDir = path.join(sessionsBase, `-${cwd.replace(/\//g, "-")}-`);
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

/** Keep at most N pre-truncation backups per session file (F8). */
const MAX_UNDO_BACKUPS = 5;

function pruneUndoBackups(sessionFile: string): void {
  const dir = path.dirname(sessionFile);
  const base = path.basename(sessionFile);
  try {
    const backups = fs
      .readdirSync(dir)
      .filter((f) => f.startsWith(`${base}.undo-`))
      .sort();
    for (const f of backups.slice(0, -MAX_UNDO_BACKUPS)) {
      fs.rmSync(path.join(dir, f), { force: true });
    }
  } catch {}
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
  let keepIdx = -1;
  for (let i = assistantPos + 1; i < pathIdx.length; i++) {
    try {
      if (isTrigger(JSON.parse(lines[pathIdx[i]]))) {
        keepIdx = pathIdx[i];
        break;
      }
    } catch {}
  }
  if (keepIdx === -1) {
    // F8: no trigger root-ward of the last assistant — cutting to the
    // header would drop the whole conversation for no reason. Abort.
    return null;
  }
  const kept = lines.slice(0, keepIdx + 1);
  const removed = lines.slice(keepIdx + 1);
  if (removed.length === 0) return null;
  // F8: back up the full session before the rewrite — the removed lines'
  // other home (redo.json) is written only after the rename, so a crash in
  // between used to lose them outright.
  try {
    fs.copyFileSync(sessionFile, `${sessionFile}.undo-${Date.now()}`);
    pruneUndoBackups(sessionFile);
  } catch {}
  const tmp = `${sessionFile}.undo-tmp`;
  fs.writeFileSync(tmp, `${kept.join("\n")}\n`);
  fs.renameSync(tmp, sessionFile);
  return removed;
}

/** Re-append lines removed by truncateSession (for /redo). */
export function reappendSession(sessionFile: string, removed: string[]): void {
  fs.appendFileSync(sessionFile, `${removed.join("\n")}\n`);
}

// ─── Redo record ───────────────────────────────────────────────────────────

// ─── Re-run trigger (F1) ────────────────────────────────────────────────
// The deployment runs `pi` in RPC mode, which never auto-prompts at
// startup — so "keep the trigger in the file" alone does NOT re-run the
// prompt. performUndo therefore parks a durable re-run record; the bridge
// re-sends the trigger text on session_start after the undo-restart.

export interface RerunRecord {
  sessionFile: string | null;
  /** the kept trigger's user-visible text */
  text: string;
  ts: string;
}

/** How long a parked re-run stays valid (guards against an unrelated
 * restart re-firing a stale trigger). */
export const RERUN_TTL_MS = 10 * 60 * 1000;

export function rerunPath(): string {
  return path.join(storeRoot(), "rerun.json");
}

export function writeRerun(rec: RerunRecord): void {
  fs.mkdirSync(storeRoot(), { recursive: true });
  fs.writeFileSync(rerunPath(), JSON.stringify(rec, null, 1));
}

/** Extract the user-visible text of a trigger entry (custom_message from
 * the channel, or a user-role message). */
export function triggerText(entry: any): string | null {
  if (entry?.type === "custom_message") {
    // details.body is the raw user text; content is the full LLM context
    const b = entry.details?.body;
    const t =
      typeof b === "string" && b.trim()
        ? b
        : typeof entry.content === "string"
          ? entry.content
          : null;
    return t?.trim() ? t : null;
  }
  if (entry?.type === "message" && entry.message?.role === "user") {
    const c = entry.message.content;
    if (typeof c === "string") return c.trim() ? c : null;
    if (Array.isArray(c)) {
      const t = c
        .filter((b: any) => b?.type === "text" && typeof b.text === "string")
        .map((b: any) => b.text)
        .join("\n")
        .trim();
      return t ? t : null;
    }
  }
  return null;
}

/** Read + consume the parked re-run. Returns the text to re-send, or null
 * (no record, stale, or written for a different session file). The file
 * is consumed either way. */
export function consumeRerun(
  currentSessionFile: string | null,
  now = Date.now(),
): string | null {
  let rec: RerunRecord | null = null;
  try {
    const p = rerunPath();
    if (fs.existsSync(p))
      rec = JSON.parse(fs.readFileSync(p, "utf8")) as RerunRecord;
  } catch {
    rec = null;
  } finally {
    try {
      fs.rmSync(rerunPath(), { force: true });
    } catch {}
  }
  if (!rec?.text) return null;
  if (now - Date.parse(rec.ts) > RERUN_TTL_MS) return null; // stale restart
  if (
    rec.sessionFile &&
    currentSessionFile &&
    rec.sessionFile !== currentSessionFile
  )
    return null;
  return rec.text;
}

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
  /** true when a re-run trigger was parked for session_start (F1) */
  reRun: boolean;
}

function undoAck(
  files: number,
  conversation: boolean,
  skipped: number,
): string {
  const parts: string[] = [];
  if (files > 0) parts.push(`${files} file${files === 1 ? "" : "s"}`);
  if (conversation) parts.push("conversation");
  const suffix =
    skipped > 0 ? ` (kept ${skipped} >20MB file, not restored)` : "";
  if (parts.length === 0) {
    if (skipped > 0)
      return `[ok] undone: kept ${skipped} >20MB file (not restored)`;
    return "[!] nothing to undo";
  }
  return `[ok] undone: ${parts.join(" + ")}${suffix}`;
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
      console.error(
        `[undo] truncate failed: ${e instanceof Error ? e.message : String(e)}`,
      );
      removed = null;
    }
  }
  let files = 0;
  let skipped = 0;
  if (run) {
    try {
      const r = applyRunSnapshot(run.dir, run.meta, "pre");
      files = r.files;
      skipped = r.skipped;
    } catch (e) {
      console.error(
        `[undo] restore failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
  if (files === 0 && skipped === 0 && (!removed || removed.length === 0)) {
    return { text: "[!] nothing to undo", restarted: false, reRun: false };
  }
  // F1: park the re-run trigger. The kept trigger is now the last line.
  let reRun = false;
  if (removed && removed.length > 0 && sessionFile) {
    const keptText = (() => {
      try {
        const kept = fs
          .readFileSync(sessionFile, "utf8")
          .trim()
          .split("\n")
          .filter((l) => l.trim() !== "");
        return kept.length > 0
          ? triggerText(JSON.parse(kept[kept.length - 1]))
          : null;
      } catch {
        return null;
      }
    })();
    if (keptText) {
      try {
        writeRerun({
          sessionFile,
          text: keptText,
          ts: new Date().toISOString(),
        });
        reRun = true;
      } catch (e) {
        console.error(
          `[undo] rerun record write failed: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
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
    console.error(
      `[undo] redo record write failed: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  const text =
    undoAck(files, (removed?.length ?? 0) > 0, skipped) +
    (reRun ? " (re-running)" : "");
  return { text, restarted: (removed?.length ?? 0) > 0, reRun };
}

/** /redo: reapply the undone run (one level deep). */
export function performRedo(): UndoResult {
  const rec = readRedo();
  if (!rec)
    return { text: "[!] nothing to redo", restarted: false, reRun: false };
  // F4: if a NEWER run completed after this undo, the session has lines
  // appended past our cut point; re-appending the removed tail would strand
  // the new turn off-path. Refuse instead (record is kept).
  {
    const undoSeq = Number(rec.run?.match(/^(\d+)_/)?.[1] ?? 0);
    const newer = latestRun(rec.sessionFile);
    if (newer && Number(newer.meta.seq ?? 0) > undoSeq) {
      return {
        text: "[!] redo stale: newer run completed",
        restarted: false,
        reRun: false,
      };
    }
  }
  let files = 0;
  if (rec.run) {
    const runDir = path.join(runsDir(), rec.run);
    const meta = readRunMeta(runDir);
    if (meta) {
      try {
        files = applyRunSnapshot(runDir, meta, "post").files;
      } catch (e) {
        console.error(
          `[undo] redo restore failed: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
  }
  let conversation = false;
  if (
    rec.sessionFile &&
    rec.removed.length > 0 &&
    fs.existsSync(rec.sessionFile)
  ) {
    try {
      reappendSession(rec.sessionFile, rec.removed);
      conversation = true;
    } catch (e) {
      console.error(
        `[undo] redo reappend failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
  try {
    fs.rmSync(redoPath(), { force: true });
  } catch {}
  if (files === 0 && !conversation)
    return { text: "[!] nothing to redo", restarted: false, reRun: false };
  const parts: string[] = [];
  if (files > 0) parts.push(`${files} file${files === 1 ? "" : "s"}`);
  if (conversation) parts.push("conversation");
  return {
    text: `[ok] redone: ${parts.join(" + ")}`,
    restarted: conversation,
    reRun: false,
  };
}
