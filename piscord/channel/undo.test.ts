import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import {
  encPath,
  findSessionFile,
  isGitRepo,
  latestRun,
  performRedo,
  performUndo,
  pruneRuns,
  reappendSession,
  stageFileTouch,
  startRun,
  finishRun,
  storeRoot,
  truncateSession,
} from "./undo";

let tmp: string;
let oldHome: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "piscord-undo-"));
  oldHome = process.env.HOME || "";
  process.env.HOME = path.join(tmp, "home");
  fs.mkdirSync(process.env.HOME, { recursive: true });
});

afterEach(() => {
  process.env.HOME = oldHome;
  fs.rmSync(tmp, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).replace(/\n$/, "");
}

function makeRepo(dir: string): string {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "undo@test");
  git(dir, "config", "user.name", "undo-test");
  return dir;
}

function commit(dir: string, msg: string): string {
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "--allow-empty", "-m", msg);
  return git(dir, "rev-parse", "HEAD");
}

function makeSession(dir: string, lines: object[]): string {
  const file = path.join(dir, "session.jsonl");
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return file;
}

// ─── encPath ───────────────────────────────────────────────────────────────

describe("encPath", () => {
  test("round-trips absolute paths with slashes and dots", () => {
    const abs = "/home/monky/a file/b.c";
    const enc = encPath(abs);
    expect(enc).not.toContain("/");
    expect(decodeURIComponent(enc)).toBe(abs);
  });
});

// ─── non-git dir: preimages via write/edit touch ───────────────────────────

describe("undo in a non-git dir (file preimages)", () => {
  test("undo restores modified + created files, redo reapplies", () => {
    const cwd = path.join(tmp, "plain");
    fs.mkdirSync(cwd, { recursive: true });
    expect(isGitRepo(cwd)).toBe(false);
    const existing = path.join(cwd, "existing.txt");
    fs.writeFileSync(existing, "before");
    const created = path.join(cwd, "created.txt");

    // run 1: agent edits existing.txt and creates created.txt
    const run = startRun(cwd)!;
    expect(run.git).toBe(false);
    stageFileTouch(run, cwd, existing);
    fs.writeFileSync(existing, "after-edit");
    stageFileTouch(run, cwd, created); // absent before the run
    fs.writeFileSync(created, "new-content");
    finishRun(run, cwd, null);

    const undo = performUndo(null);
    expect(undo.text).toBe("[ok] undone: 2 files");
    expect(undo.restarted).toBe(false);
    expect(fs.readFileSync(existing, "utf8")).toBe("before");
    expect(fs.existsSync(created)).toBe(false);

    const redo = performRedo();
    expect(redo.text).toBe("[ok] redone: 2 files");
    expect(fs.readFileSync(existing, "utf8")).toBe("after-edit");
    expect(fs.readFileSync(created, "utf8")).toBe("new-content");

    // one level deep
    expect(performRedo().text).toBe("[!] nothing to redo");
  });

  test("undo of a run that deleted a pre-existing file", () => {
    const cwd = path.join(tmp, "plain2");
    fs.mkdirSync(cwd, { recursive: true });
    const victim = path.join(cwd, "victim.txt");
    fs.writeFileSync(victim, "keep me");

    const run = startRun(cwd)!;
    stageFileTouch(run, cwd, victim);
    fs.rmSync(victim); // the run deleted it (e.g. via bash + tracked path)
    finishRun(run, cwd, null);

    const undo = performUndo(null);
    expect(undo.text).toBe("[ok] undone: 1 file");
    expect(fs.readFileSync(victim, "utf8")).toBe("keep me");

    // conversation-less undo parks no redo record
    expect(performRedo().text).toBe("[!] nothing to redo");
  });
});

// ─── git repo: HEAD + worktree + untracked ─────────────────────────────────

describe("undo in a git repo", () => {
  test("undo reverts worktree edits, untracked files AND commits; redo reapplies", () => {
    const cwd = makeRepo(path.join(tmp, "repo"));
    fs.writeFileSync(path.join(cwd, "a.txt"), "A");
    const c1 = commit(cwd, "base");

    // run: edit a.txt, create untracked b.txt, commit both
    const run = startRun(cwd)!;
    expect(run.git).toBe(true);
    fs.writeFileSync(path.join(cwd, "a.txt"), "A-modified");
    fs.writeFileSync(path.join(cwd, "b.txt"), "B");
    const c2 = commit(cwd, "run work");
    finishRun(run, cwd, null);

    const undo = performUndo(null);
    expect(undo.text).toMatch(/^\[ok\] undone: \d+ files$/);
    expect(fs.readFileSync(path.join(cwd, "a.txt"), "utf8")).toBe("A");
    expect(fs.existsSync(path.join(cwd, "b.txt"))).toBe(false);
    expect(git(cwd, "rev-parse", "HEAD")).toBe(c1);
    expect(c2 !== c1).toBe(true); // sanity: the run did commit

    const redo = performRedo();
    expect(redo.text).toMatch(/^\[ok\] redone: \d+ files$/);
    expect(fs.readFileSync(path.join(cwd, "a.txt"), "utf8")).toBe("A-modified");
    expect(fs.readFileSync(path.join(cwd, "b.txt"), "utf8")).toBe("B");
    expect(git(cwd, "rev-parse", "HEAD")).toBe(c2);

    expect(performRedo().text).toBe("[!] nothing to redo");
  });

  test("staged-only changes (no commit) are reverted", () => {
    const cwd = makeRepo(path.join(tmp, "repo2"));
    fs.writeFileSync(path.join(cwd, "s.txt"), "S");
    commit(cwd, "base");

    const run = startRun(cwd)!;
    fs.writeFileSync(path.join(cwd, "s.txt"), "S-modified");
    git(cwd, "add", "s.txt"); // staged, not committed
    finishRun(run, cwd, null);

    const undo = performUndo(null);
    expect(undo.text).toBe("[ok] undone: 1 file");
    expect(fs.readFileSync(path.join(cwd, "s.txt"), "utf8")).toBe("S");
    expect(git(cwd, "status", "--porcelain")).toBe("");
  });

  test("untracked cleanup removes run-created files but keeps pre-existing ones", () => {
    const cwd = makeRepo(path.join(tmp, "repo3"));
    commit(cwd, "base");
    const preUntracked = path.join(cwd, "pre-existing.tmp");
    fs.writeFileSync(preUntracked, "keep");

    const run = startRun(cwd)!;
    fs.writeFileSync(path.join(cwd, "run-made.tmp"), "drop");
    finishRun(run, cwd, null);

    performUndo(null);
    expect(fs.existsSync(preUntracked)).toBe(true);
    expect(fs.existsSync(path.join(cwd, "run-made.tmp"))).toBe(false);
  });
});

// ─── conversation truncation + redo re-append ──────────────────────────────

describe("session truncation", () => {
  const header = { type: "session", version: 3, id: "s1", timestamp: "t", cwd: "/x" };
  const triggerA = { type: "custom_message", id: "tA", parentId: null, customType: "channel-inbound", content: "do A" };
  const assistantA = { type: "message", id: "aA", parentId: "tA", message: { role: "assistant", content: [{ type: "text", text: "did A" }] } };
  const toolResultA = { type: "message", id: "rA", parentId: "aA", message: { role: "toolResult", toolName: "bash", content: [], isError: false } };
  const triggerB = { type: "custom_message", id: "tB", parentId: "rA", customType: "channel-inbound", content: "do B" };
  const assistantB = { type: "message", id: "aB", parentId: "tB", message: { role: "assistant", content: [{ type: "text", text: "did B" }] } };

  test("truncates at the trigger of the last assistant turn; redo re-appends", () => {
    const file = makeSession(tmp, [header, triggerA, assistantA, toolResultA, triggerB, assistantB]);
    const removed = truncateSession(file)!;
    expect(removed.map((l) => JSON.parse(l).id)).toEqual(["aB"]);

    const kept = fs.readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(kept[kept.length - 1].id).toBe("tB"); // leaf is now the trigger
    expect(kept.map((e: any) => e.id)).toEqual(["s1", "tA", "aA", "rA", "tB"]);

    reappendSession(file, removed);
    const full = fs.readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(full.map((e: any) => e.id)).toEqual(["s1", "tA", "aA", "rA", "tB", "aB"]);
  });

  test("an in-flight trailing trigger is removed with the aborted turn", () => {
    const triggerC = { type: "custom_message", id: "tC", parentId: "aB", customType: "channel-inbound", content: "do C" };
    const file = makeSession(tmp, [header, triggerA, assistantA, triggerB, assistantB, triggerC]);
    const removed = truncateSession(file)!;
    expect(removed.map((l) => JSON.parse(l).id)).toEqual(["aB", "tC"]);
  });

  test("no assistant on the path -> nothing to truncate", () => {
    const file = makeSession(tmp, [header, triggerA, triggerB]);
    // triggerB.parentId dangles (triggerA's id) — keep it valid:
    const fixed = fs.readFileSync(file, "utf8").trim().split("\n").map((l, i) => {
      const e = JSON.parse(l);
      if (e.id === "tB") e.parentId = "tA";
      return JSON.stringify(e);
    }).join("\n") + "\n";
    fs.writeFileSync(file, fixed);
    expect(truncateSession(file)).toBeNull();
    expect(fs.readFileSync(file, "utf8")).toBe(fixed);
  });

  test("user-role messages count as triggers too", () => {
    const userMsg = { type: "message", id: "u1", parentId: null, message: { role: "user", content: "hello" } };
    const asst = { type: "message", id: "u2", parentId: "u1", message: { role: "assistant", content: [{ type: "text", text: "hi" }] } };
    const file = makeSession(tmp, [header, userMsg, asst]);
    const removed = truncateSession(file)!;
    expect(removed.map((l) => JSON.parse(l).id)).toEqual(["u2"]);
  });
});

// ─── run store: session alignment + pruning ────────────────────────────────

describe("run store", () => {
  test("latestRun prefers runs matching the session file", () => {
    const cwd = path.join(tmp, "aligned");
    fs.mkdirSync(cwd, { recursive: true });
    const sOld = path.join(cwd, "old.jsonl");
    const sNew = path.join(cwd, "new.jsonl");
    fs.writeFileSync(sOld, "{}\n");
    fs.writeFileSync(sNew, "{}\n");
    const r1 = startRun(cwd)!;
    finishRun(r1, cwd, sOld);
    const r2 = startRun(cwd)!;
    finishRun(r2, cwd, sNew);
    expect(latestRun(sNew)?.meta.sessionFile).toBe(sNew);
    expect(latestRun(sOld)?.meta.sessionFile).toBe(sOld);
    expect(latestRun(null)?.meta.sessionFile).toBe(sNew); // no filter -> newest
  });

  test("prunes to the last 10 runs", () => {
    const cwd = path.join(tmp, "prune");
    fs.mkdirSync(cwd, { recursive: true });
    for (let i = 0; i < 12; i++) {
      const r = startRun(cwd)!;
      finishRun(r, cwd, null);
    }
    const runs = path.join(storeRoot(), "runs");
    expect(fs.readdirSync(runs).filter((d) => /^\d+_\d+$/.test(d))).toHaveLength(10);
    pruneRuns(); // idempotent
    expect(fs.readdirSync(runs).filter((d) => /^\d+_\d+$/.test(d))).toHaveLength(10);
  });
});

// ─── end-to-end: files + conversation together ─────────────────────────────

describe("performUndo + performRedo end to end", () => {
  test("nothing to undo on a fresh store and assistant-less session", () => {
    const cwd = path.join(tmp, "fresh");
    fs.mkdirSync(cwd, { recursive: true });
    const header = { type: "session", version: 3, id: "s1", timestamp: "t", cwd };
    const trigger = { type: "custom_message", id: "t1", parentId: null, customType: "channel-inbound", content: "hi" };
    const file = makeSession(cwd, [header, trigger]);
    const r = performUndo(file);
    expect(r.text).toBe("[!] nothing to undo");
    expect(r.restarted).toBe(false);
    expect(performRedo().text).toBe("[!] nothing to redo");
  });

  test("conversation-only undo when the store has no matching run", () => {
    const cwd = path.join(tmp, "conv");
    fs.mkdirSync(cwd, { recursive: true });
    const header = { type: "session", version: 3, id: "s1", timestamp: "t", cwd };
    const t1 = { type: "custom_message", id: "t1", parentId: null, customType: "channel-inbound", content: "q1" };
    const a1 = { type: "message", id: "a1", parentId: "t1", message: { role: "assistant", content: [{ type: "text", text: "r1" }] } };
    const t2 = { type: "custom_message", id: "t2", parentId: "a1", customType: "channel-inbound", content: "q2" };
    const a2 = { type: "message", id: "a2", parentId: "t2", message: { role: "assistant", content: [{ type: "text", text: "r2" }] } };
    const file = makeSession(cwd, [header, t1, a1, t2, a2]);

    // no runs recorded (store empty) -> conversation-only revert
    const undo = performUndo(file);
    expect(undo.text).toBe("[ok] undone: conversation");
    expect(undo.restarted).toBe(true);
    const kept = fs.readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l).id);
    expect(kept).toEqual(["s1", "t1", "a1", "t2"]);

    const redo = performRedo();
    expect(redo.text).toBe("[ok] redone: conversation");
    expect(redo.restarted).toBe(true);
    const full = fs.readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l).id);
    expect(full).toEqual(["s1", "t1", "a1", "t2", "a2"]);
  });

  test("findSessionFile falls back to the newest .jsonl under the cwd dir", () => {
    const cwd = path.join(tmp, "sess");
    fs.mkdirSync(cwd, { recursive: true });
    const encDir = path.join(process.env.HOME!, ".pi", "agent", "sessions", "-" + cwd.replace(/\//g, "-") + "-");
    fs.mkdirSync(encDir, { recursive: true });
    const f1 = path.join(encDir, "a.jsonl");
    const f2 = path.join(encDir, "b.jsonl");
    fs.writeFileSync(f1, "{}\n");
    fs.writeFileSync(f2, "{}\n");
    const past = Date.now() - 60_000;
    fs.utimesSync(f1, past / 1000, past / 1000);
    expect(findSessionFile(cwd)).toBe(f2);
    expect(findSessionFile(path.join(tmp, "nowhere"))).toBe(f2); // base-wide fallback
  });
});
