import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  clearWorktreeState,
  loadWorktreeState,
  mergeWorktree,
  newWorktree,
  WORKTREE_STATE_REL,
  worktreeId,
} from "./worktree";

// ─── fixture: a live git repo + fake HOME for the worktree dir ────────────

const GIT_ENV: Record<string, string> = {
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@t",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t",
};

let tmp = "";
let repo = "";
let home = "";
let wtDir = "";
let env: NodeJS.ProcessEnv;
const savedEnv: Record<string, string | undefined> = {};

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...GIT_ENV },
  }).trimEnd();
}

function commitIn(cwd: string, file: string, content: string): void {
  fs.writeFileSync(path.join(cwd, file), content);
  git(cwd, "add", file);
  git(cwd, "commit", "-m", `commit ${file}`);
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wt-test-"));
  repo = path.join(tmp, "live");
  home = path.join(tmp, "home");
  wtDir = path.join(tmp, "wt");
  fs.mkdirSync(repo, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(wtDir, { recursive: true });
  git(repo, "init", "-b", "main");
  commitIn(repo, "base.txt", "base\n");
  for (const k of ["HOME", "PI_BG_WT_DIR", ...Object.keys(GIT_ENV)])
    savedEnv[k] = process.env[k];
  env = { ...process.env, HOME: home, PI_BG_WT_DIR: wtDir, ...GIT_ENV };
  process.env.HOME = home;
  process.env.PI_BG_WT_DIR = wtDir;
  for (const [k, v] of Object.entries(GIT_ENV)) process.env[k] = v;
});

afterEach(() => {
  for (const k of Object.keys(savedEnv)) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k]!;
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});

// ─── id + state ───────────────────────────────────────────────────────────

describe("worktreeId (#12)", () => {
  test("ticket shape YYYYMMDD-HHMMSS-NNNN (pi-bg compatible)", () => {
    const id = worktreeId(new Date(Date.UTC(2026, 8, 14, 9, 17, 14)));
    expect(id).toBe(`20260914-091714-${id.slice(-4)}`);
    expect(id).toMatch(/^\d{8}-\d{6}-\d{4}$/);
    expect(worktreeId()).toMatch(/^\d{8}-\d{6}-\d{4}$/);
  });
});

describe("loadWorktreeState (#12)", () => {
  test("missing file -> null; corrupted file -> null; deleted worktree -> null", () => {
    expect(loadWorktreeState(repo)).toBeNull();
    fs.mkdirSync(path.join(repo, ".tmp"), { recursive: true });
    fs.writeFileSync(path.join(repo, WORKTREE_STATE_REL), "{not json");
    expect(loadWorktreeState(repo)).toBeNull();
    const st = {
      id: "x",
      repo,
      path: path.join(tmp, "gone"),
      branch: "b",
      createdAt: "",
    };
    fs.writeFileSync(path.join(repo, WORKTREE_STATE_REL), JSON.stringify(st));
    expect(loadWorktreeState(repo)).toBeNull();
  });
});

// ─── /new-worktree ────────────────────────────────────────────────────────

describe("newWorktree (#12)", () => {
  test("non-git cwd -> [!] line, no state written", () => {
    const noGit = path.join(tmp, "nongit");
    fs.mkdirSync(noGit, { recursive: true });
    const line = newWorktree(noGit, undefined, env);
    expect(line).toMatch(/^\[!\] not a git repo/);
    expect(loadWorktreeState(noGit)).toBeNull();
  });

  test("creates worktree at $PI_BG_WT_DIR/<repo>/<id>, branch pi-bg/<id>, records state", () => {
    const line = newWorktree(repo, undefined, env);
    expect(line).toMatch(/^\[ok\] worktree /);
    const st = loadWorktreeState(repo);
    expect(st).not.toBeNull();
    expect(st!.repo).toBe(repo);
    expect(st!.branch).toBe(`pi-bg/${st!.id}`);
    expect(st!.path).toBe(path.join(wtDir, "live", st!.id));
    expect(line).toContain(st!.path);
    expect(line).toContain(st!.branch);
    expect(fs.existsSync(path.join(st!.path, "base.txt"))).toBe(true);
    // the worktree branch exists and starts at the live HEAD
    git(st!.path, "branch", "--show-current");
    expect(git(st!.path, "rev-parse", "--abbrev-ref", "HEAD")).toBe(st!.branch);
    expect(git(st!.path, "rev-parse", st!.branch)).toBe(
      git(repo, "rev-parse", "HEAD"),
    );
  });

  test("a second /new-worktree while one is active is refused", () => {
    newWorktree(repo, undefined, env);
    const line = newWorktree(repo, undefined, env);
    expect(line).toMatch(/^\[!\] worktree already active/);
  });

  test("stale state (worktree dir deleted) allows a fresh /new-worktree", () => {
    newWorktree(repo, undefined, env);
    const active = loadWorktreeState(repo)!;
    fs.rmSync(active.path, { recursive: true, force: true });
    expect(loadWorktreeState(repo)).toBeNull();
    const line = newWorktree(repo, undefined, env);
    expect(line).toMatch(/^\[ok\] worktree /);
  });
});

// ─── /merge-worktree ──────────────────────────────────────────────────────

describe("mergeWorktree (#12)", () => {
  test("no active worktree -> [!] line", () => {
    expect(mergeWorktree(repo)).toMatch(/^\[!\] no active worktree/);
  });

  test("keep: commits from the worktree land in the live branch; worktree + branch removed", () => {
    const st = loadWorktree(repo);
    commitIn(st.path, "feature.txt", "feature\n");
    const line = mergeWorktree(repo, "keep");
    expect(line).toMatch(/^\[ok\] merged .* into main \(merge\)$/);
    // the commit is on the live branch
    expect(fs.existsSync(path.join(repo, "feature.txt"))).toBe(true);
    expect(git(repo, "log", "--oneline", "main")).toContain(
      "commit feature.txt",
    );
    // worktree + branch gone, state cleared
    expect(fs.existsSync(st.path)).toBe(false);
    expect(git(repo, "branch", "--list", st.branch)).toBe("");
    expect(loadWorktreeState(repo)).toBeNull();
  });

  test("squash: one squash commit on the live branch; branch force-deleted", () => {
    const st = loadWorktree(repo);
    commitIn(st.path, "a.txt", "a\n");
    commitIn(st.path, "b.txt", "b\n");
    const before = git(repo, "rev-parse", "HEAD");
    const line = mergeWorktree(repo, "squash");
    expect(line).toMatch(/^\[ok\] merged .* into main \(squash\)$/);
    const log = git(repo, "log", "--oneline", `${before}..main`);
    expect(log.split("\n").filter(Boolean).length).toBe(1);
    expect(log).toContain("squash-merge");
    expect(fs.existsSync(path.join(repo, "a.txt"))).toBe(true);
    expect(fs.existsSync(path.join(repo, "b.txt"))).toBe(true);
    expect(fs.existsSync(st.path)).toBe(false);
    expect(git(repo, "branch", "--list", st.branch)).toBe("");
    expect(loadWorktreeState(repo)).toBeNull();
  });

  test("uncommitted changes in the worktree block the removal (work is not lost)", () => {
    const st = loadWorktree(repo);
    commitIn(st.path, "c.txt", "c1\n");
    fs.writeFileSync(path.join(st.path, "c.txt"), "c2-uncommitted\n");
    const line = mergeWorktree(repo, "keep");
    expect(line).toMatch(
      /^\[!\] merged .* but the worktree has uncommitted changes/,
    );
    // the committed part IS merged; state survives for the retry
    expect(fs.existsSync(path.join(repo, "c.txt"))).toBe(true);
    expect(loadWorktreeState(repo)).not.toBeNull();
    expect(fs.existsSync(st.path)).toBe(true);
    // commit the remainder, retry, and it finishes clean
    commitIn(st.path, "c.txt", "c2");
    const retry = mergeWorktree(repo, "keep");
    expect(retry).toMatch(/^\[ok\] merged .* into main \(merge\)$/);
    expect(fs.existsSync(st.path)).toBe(false);
    expect(loadWorktreeState(repo)).toBeNull();
  });

  test("conflict: [!] line names the repo; resolve + retry finalizes the in-flight merge", () => {
    const st = loadWorktree(repo);
    // both sides change the same line after the worktree forks
    fs.writeFileSync(path.join(st.path, "base.txt"), "worktree side\n");
    git(st.path, "add", "base.txt");
    git(st.path, "commit", "-m", "wt base change");
    fs.writeFileSync(path.join(repo, "base.txt"), "live side\n");
    git(repo, "add", "base.txt");
    git(repo, "commit", "-m", "live base change");
    const line = mergeWorktree(repo, "keep");
    expect(line).toMatch(/^\[!\] merge conflict \(1 file\) - resolve in /);
    expect(line).toContain(repo);
    expect(loadWorktreeState(repo)).not.toBeNull(); // retryable
    // agent/user resolves
    fs.writeFileSync(path.join(repo, "base.txt"), "resolved\n");
    git(repo, "add", "base.txt");
    const retry = mergeWorktree(repo, "keep");
    expect(retry).toMatch(
      /^\[ok\] merged .* into main \(conflicts resolved\)$/,
    );
    expect(fs.readFileSync(path.join(repo, "base.txt"), "utf8")).toBe(
      "resolved\n",
    );
    expect(fs.existsSync(st.path)).toBe(false);
    expect(loadWorktreeState(repo)).toBeNull();
  });

  test("squash with nothing new: reports it and still cleans up", () => {
    const st = loadWorktree(repo);
    const line = mergeWorktree(repo, "squash");
    expect(line).toMatch(/^\[ok\] merged .* \(squash, nothing new\)/);
    expect(fs.existsSync(st.path)).toBe(false);
    expect(loadWorktreeState(repo)).toBeNull();
  });

  function loadWorktree(cwd: string) {
    let st = loadWorktreeState(cwd);
    if (!st) {
      newWorktree(cwd, undefined, env);
      st = loadWorktreeState(cwd);
    }
    expect(st).not.toBeNull();
    return st!;
  }
});

// keep the import used even if a test is filtered out
test("clearWorktreeState removes the file", () => {
  newWorktree(repo, undefined, env);
  expect(fs.existsSync(path.join(repo, WORKTREE_STATE_REL))).toBe(true);
  clearWorktreeState(repo);
  expect(fs.existsSync(path.join(repo, WORKTREE_STATE_REL))).toBe(false);
});
