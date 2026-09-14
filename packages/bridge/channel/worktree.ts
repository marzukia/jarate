// #12 — interactive session worktrees: /new-worktree + /merge-worktree.
//
// The in-session version of `pi-bg --worktree`: the command creates a git
// worktree of the live repo (branch pi-bg/<id>, path
// $PI_BG_WT_DIR/<repo>/<id>, default ~/.pi-bg-wt/<repo>/<id>), announces
// path + branch as ONE fenced machine line, and records the active
// worktree in <cwd>/.tmp/worktree.json (the same per-cwd state store the
// bridge uses for its other flags). The agent then works in the worktree
// by absolute path; /merge-worktree merges the branch back into the live
// checkout's CURRENT branch (keep = plain merge — fast-forward when
// possible, merge commit otherwise; squash = one squash commit) and
// removes the worktree + branch.
//
// Conflict policy (wave 2c: the agent-driven in-thread resolution is
// skipped): a conflicted merge leaves the repo in merge state; the
// notice says resolve + retry, and the retry finalizes the in-flight
// merge (git commit) instead of starting a new one.
//
// Owner-only at the command layer (index.ts). Every git failure is a
// [!] line, never a throw.

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

export interface WorktreeState {
  /** ticket id, YYYYMMDD-HHMMSS-NNNN (same shape as pi-bg run ids) */
  id: string;
  /** top-level path of the live repo */
  repo: string;
  /** worktree path */
  path: string;
  /** worktree branch: pi-bg/<id> */
  branch: string;
  createdAt: string;
}

export const WORKTREE_STATE_REL = path.join(".tmp", "worktree.json");

const GIT_TIMEOUT_MS = 30_000;

function stateFile(cwd: string): string {
  return path.join(cwd, WORKTREE_STATE_REL);
}

/** Read the active-worktree state; null when absent, stale, or the
 *  worktree dir was deleted out from under us. */
export function loadWorktreeState(cwd: string): WorktreeState | null {
  try {
    const o = JSON.parse(
      fs.readFileSync(stateFile(cwd), "utf8"),
    ) as WorktreeState | null;
    if (
      !o ||
      typeof o.id !== "string" ||
      typeof o.repo !== "string" ||
      typeof o.path !== "string" ||
      typeof o.branch !== "string" ||
      !fs.existsSync(o.path)
    )
      return null;
    return o;
  } catch {
    return null;
  }
}

function saveWorktreeState(cwd: string, st: WorktreeState): void {
  fs.mkdirSync(path.dirname(stateFile(cwd)), { recursive: true });
  fs.writeFileSync(stateFile(cwd), `${JSON.stringify(st, null, 2)}\n`);
}

export function clearWorktreeState(cwd: string): void {
  try {
    fs.unlinkSync(stateFile(cwd));
  } catch {
    // already gone
  }
}

function git(cwd: string, args: string[]): { code: number; out: string } {
  try {
    const out = execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      timeout: GIT_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, out: String(out).trimEnd() };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return {
      code: err.status ?? 1,
      out: `${String(err.stdout ?? "").trimEnd()}\n${String(
        err.stderr ?? "",
      ).trimEnd()}`.trim(),
    };
  }
}

function firstLine(s: string): string {
  return s.split("\n").find((l) => l.trim() !== "") ?? "";
}

/** Ticket id, same shape as pi-bg run ids: YYYYMMDD-HHMMSS-NNNN (UTC). */
export function worktreeId(d: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  const rand = String(Math.floor(Math.random() * 10_000)).padStart(4, "0");
  return (
    `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}` +
    `-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}` +
    `-${rand}`
  );
}

function wtBaseDir(env: NodeJS.ProcessEnv): string {
  return env.PI_BG_WT_DIR || path.join(env.HOME ?? "", ".pi-bg-wt");
}

/**
 * /new-worktree [ref]: create the interactive worktree from ref (default
 * HEAD) and record it as the active worktree. Returns the channel line
 * (the caller fences it).
 */
export function newWorktree(
  cwd: string,
  ref: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const top = git(cwd, ["rev-parse", "--show-toplevel"]);
  if (top.code !== 0)
    return `[!] not a git repo (cwd ${cwd} - /new-worktree needs one)`;
  const repo = top.out;
  const active = loadWorktreeState(cwd);
  if (active)
    return `[!] worktree already active (${active.path}) - /merge-worktree first`;
  const from = ref && ref.trim() !== "" ? ref.trim() : "HEAD";
  const id = worktreeId();
  const wtPath = path.join(wtBaseDir(env), path.basename(repo), id);
  const branch = `pi-bg/${id}`;
  const add = git(repo, ["worktree", "add", "-b", branch, wtPath, from]);
  if (add.code !== 0)
    return `[!] worktree add failed: ${firstLine(add.out) || `ref ${from}`}`;
  saveWorktreeState(cwd, {
    id,
    repo,
    path: wtPath,
    branch,
    createdAt: new Date().toISOString(),
  });
  return `[ok] worktree ${wtPath} (branch ${branch}, from ${from})`;
}

/** Finish a merged worktree: remove the dir (guards uncommitted changes),
 *  delete the branch, clear state. Returns the channel line. */
function finishMerge(
  cwd: string,
  st: WorktreeState,
  mode: "keep" | "squash",
  how: string,
): string {
  const rm = git(st.repo, ["worktree", "remove", st.path]);
  if (rm.code !== 0)
    return `[!] merged ${st.branch} but the worktree has uncommitted changes - commit in ${st.path}, then /merge-worktree again`;
  const del =
    mode === "squash"
      ? git(st.repo, ["branch", "-D", st.branch])
      : git(st.repo, ["branch", "-d", st.branch]);
  clearWorktreeState(cwd);
  if (del.code !== 0)
    return `[ok] merged ${st.branch} (${how}) - leftover branch: git branch -D ${st.branch}`;
  return `[ok] merged ${st.branch} into ${currentBranch(st.repo)} (${how})`;
}

function currentBranch(repo: string): string {
  const r = git(repo, ["branch", "--show-current"]);
  return r.code === 0 && r.out !== "" ? r.out : "(detached)";
}

/**
 * /merge-worktree [squash]: merge the active worktree's branch back into
 * the live checkout's current branch, then remove worktree + branch.
 * A retry after a conflicted merge finalizes the in-flight merge.
 */
export function mergeWorktree(
  cwd: string,
  mode: "keep" | "squash" = "keep",
): string {
  const st = loadWorktreeState(cwd);
  if (!st) return "[!] no active worktree (/new-worktree first)";
  const repo = st.repo;

  // A conflicted merge from a previous attempt is in flight: the user (or
  // the agent) resolved the files — finalize it, then clean up.
  if (git(repo, ["rev-parse", "--verify", "MERGE_HEAD"]).code === 0) {
    const commit = git(repo, ["commit", "--no-edit"]);
    if (commit.code !== 0)
      return `[!] merge commit failed: ${firstLine(commit.out) || commit.code}`;
    return finishMerge(cwd, st, mode, "conflicts resolved");
  }

  const merge =
    mode === "squash"
      ? git(repo, ["merge", "--squash", st.branch])
      : git(repo, ["merge", st.branch]);
  if (merge.code !== 0) {
    const un = git(repo, ["diff", "--name-only", "--diff-filter=U"]);
    const n =
      un.code === 0 && un.out !== "" ? String(un.out.split("\n").length) : null;
    return n !== null
      ? `[!] merge conflict (${n} file${n === "1" ? "" : "s"}) - resolve in ${repo}, git add, then /merge-worktree again`
      : `[!] merge failed: ${firstLine(merge.out) || merge.code}`;
  }

  if (mode === "squash") {
    // git merge --squash stages the changes; commit them as ONE squash.
    const diff = git(repo, ["diff", "--cached", "--quiet"]);
    if (diff.code === 0)
      // nothing staged: the branch had no new commits over current HEAD
      return `[ok] merged ${st.branch} (squash, nothing new) - ${cleanSquash(cwd, st)}`;
    const commit = git(repo, ["commit", "-m", `squash-merge ${st.branch}`]);
    if (commit.code !== 0)
      return `[!] squash commit failed: ${firstLine(commit.out) || commit.code}`;
  }
  return finishMerge(cwd, st, mode, mode === "squash" ? "squash" : "merge");
}

/** Worktree remove + branch -D + state clear for the empty-squash path
 *  (no commit was made, but the worktree still holds only its branch). */
function cleanSquash(cwd: string, st: WorktreeState): string {
  const rm = git(st.repo, ["worktree", "remove", st.path]);
  if (rm.code !== 0) return "worktree kept (uncommitted changes)";
  git(st.repo, ["branch", "-D", st.branch]);
  clearWorktreeState(cwd);
  return "worktree removed";
}
