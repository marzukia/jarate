import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  consumeRerun,
  encPath,
  findSessionFile,
  finishRun,
  isGitRepo,
  latestRun,
  performRedo,
  performUndo,
  pruneRuns,
  RERUN_TTL_MS,
  reappendSession,
  stageFileTouch,
  startRun,
  storeRoot,
  triggerText,
  truncateSession,
  writeRerun,
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
  return execFileSync("git", args, { cwd, encoding: "utf8" }).replace(
    /\n$/,
    "",
  );
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
  fs.writeFileSync(file, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
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

  test("binary file changes survive undo + redo (F2: --binary capture)", () => {
    const cwd = makeRepo(path.join(tmp, "binrepo"));
    const bin = Buffer.from([0x00, 0x01, 0xff, 0x00, 0x80, 0x7f]);
    fs.writeFileSync(path.join(cwd, "img.bin"), bin);
    fs.writeFileSync(path.join(cwd, "a.txt"), "A");
    commit(cwd, "base");

    const run = startRun(cwd)!;
    fs.writeFileSync(
      path.join(cwd, "img.bin"),
      Buffer.from([0x02, 0x03, 0x04]),
    );
    fs.writeFileSync(path.join(cwd, "a.txt"), "A-modified");
    finishRun(run, cwd, null);

    const undo = performUndo(null);
    expect(undo.text).toMatch(/^\[ok\] undone: \d+ files$/);
    expect(fs.readFileSync(path.join(cwd, "a.txt"), "utf8")).toBe("A");
    // the text file must NOT be lost when a binary file is in the same patch
    expect(fs.readFileSync(path.join(cwd, "img.bin"))).toEqual(bin);

    const redo = performRedo();
    expect(redo.text).toMatch(/^\[ok\] redone: \d+ files$/);
    expect(fs.readFileSync(path.join(cwd, "a.txt"), "utf8")).toBe("A-modified");
    expect(fs.readFileSync(path.join(cwd, "img.bin"))).toEqual(
      Buffer.from([0x02, 0x03, 0x04]),
    );
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
  const header = {
    type: "session",
    version: 3,
    id: "s1",
    timestamp: "t",
    cwd: "/x",
  };
  const triggerA = {
    type: "custom_message",
    id: "tA",
    parentId: null,
    customType: "channel-inbound",
    content: "do A",
  };
  const assistantA = {
    type: "message",
    id: "aA",
    parentId: "tA",
    message: { role: "assistant", content: [{ type: "text", text: "did A" }] },
  };
  const toolResultA = {
    type: "message",
    id: "rA",
    parentId: "aA",
    message: {
      role: "toolResult",
      toolName: "bash",
      content: [],
      isError: false,
    },
  };
  const triggerB = {
    type: "custom_message",
    id: "tB",
    parentId: "rA",
    customType: "channel-inbound",
    content: "do B",
  };
  const assistantB = {
    type: "message",
    id: "aB",
    parentId: "tB",
    message: { role: "assistant", content: [{ type: "text", text: "did B" }] },
  };

  test("truncates at the trigger of the last assistant turn; redo re-appends", () => {
    const file = makeSession(tmp, [
      header,
      triggerA,
      assistantA,
      toolResultA,
      triggerB,
      assistantB,
    ]);
    const removed = truncateSession(file)!;
    expect(removed.map((l) => JSON.parse(l).id)).toEqual(["aB"]);

    const kept = fs
      .readFileSync(file, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(kept[kept.length - 1].id).toBe("tB"); // leaf is now the trigger
    expect(kept.map((e: any) => e.id)).toEqual(["s1", "tA", "aA", "rA", "tB"]);

    reappendSession(file, removed);
    const full = fs
      .readFileSync(file, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(full.map((e: any) => e.id)).toEqual([
      "s1",
      "tA",
      "aA",
      "rA",
      "tB",
      "aB",
    ]);
  });

  test("an in-flight trailing trigger is removed with the aborted turn", () => {
    const triggerC = {
      type: "custom_message",
      id: "tC",
      parentId: "aB",
      customType: "channel-inbound",
      content: "do C",
    };
    const file = makeSession(tmp, [
      header,
      triggerA,
      assistantA,
      triggerB,
      assistantB,
      triggerC,
    ]);
    const removed = truncateSession(file)!;
    expect(removed.map((l) => JSON.parse(l).id)).toEqual(["aB", "tC"]);
  });

  test("no assistant on the path -> nothing to truncate", () => {
    const file = makeSession(tmp, [header, triggerA, triggerB]);
    // triggerB.parentId dangles (triggerA's id) — keep it valid:
    const fixed = `${fs
      .readFileSync(file, "utf8")
      .trim()
      .split("\n")
      .map((l, _i) => {
        const e = JSON.parse(l);
        if (e.id === "tB") e.parentId = "tA";
        return JSON.stringify(e);
      })
      .join("\n")}\n`;
    fs.writeFileSync(file, fixed);
    expect(truncateSession(file)).toBeNull();
    expect(fs.readFileSync(file, "utf8")).toBe(fixed);
  });

  test("user-role messages count as triggers too", () => {
    const userMsg = {
      type: "message",
      id: "u1",
      parentId: null,
      message: { role: "user", content: "hello" },
    };
    const asst = {
      type: "message",
      id: "u2",
      parentId: "u1",
      message: { role: "assistant", content: [{ type: "text", text: "hi" }] },
    };
    const file = makeSession(tmp, [header, userMsg, asst]);
    const removed = truncateSession(file)!;
    expect(removed.map((l) => JSON.parse(l).id)).toEqual(["u2"]);
  });

  test("truncate backs up the full session before the rewrite (F8)", () => {
    const file = makeSession(tmp, [
      header,
      triggerA,
      assistantA,
      toolResultA,
      triggerB,
      assistantB,
    ]);
    const before = fs.readFileSync(file, "utf8");
    truncateSession(file)!;
    const dir = path.dirname(file);
    const base = path.basename(file);
    const backups = fs
      .readdirSync(dir)
      .filter((f) => f.startsWith(`${base}.undo-`));
    expect(backups.length).toBe(1);
    expect(fs.readFileSync(path.join(dir, backups[0]), "utf8")).toBe(before);
  });

  test("no trigger root-ward of the last assistant -> abort, file unchanged (F8)", () => {
    const asst = {
      type: "message",
      id: "a",
      parentId: null,
      message: { role: "assistant", content: [{ type: "text", text: "x" }] },
    };
    const file = makeSession(tmp, [header, asst]);
    const before = fs.readFileSync(file, "utf8");
    expect(truncateSession(file)).toBeNull();
    expect(fs.readFileSync(file, "utf8")).toBe(before);
  });
});

// ─── re-run trigger (F1) ──────────────────────────────────────────────────

describe("re-run trigger (F1)", () => {
  const header = {
    type: "session",
    version: 3,
    id: "s1",
    timestamp: "t",
    cwd: "/x",
  };

  test("performUndo parks the kept trigger; consumeRerun fires once for the matching session", () => {
    const cwd = path.join(tmp, "rerun");
    fs.mkdirSync(cwd, { recursive: true });
    const t1 = {
      type: "custom_message",
      id: "t1",
      parentId: null,
      customType: "channel-inbound",
      content: "<channel-ctx>ch: monky</channel-ctx>\n\nfix the bug",
      details: { title: "monky", body: "fix the bug" },
    };
    const a1 = {
      type: "message",
      id: "a1",
      parentId: "t1",
      message: { role: "assistant", content: [{ type: "text", text: "done" }] },
    };
    const file = makeSession(cwd, [header, t1, a1]);

    const undo = performUndo(file);
    expect(undo.reRun).toBe(true);
    expect(undo.text).toBe("[ok] undone: conversation (re-running)");

    // post-restart: the bridge consumes the trigger for this session
    expect(consumeRerun(file)).toBe("fix the bug");
    // consumed: a later unrelated restart must not re-fire it
    expect(consumeRerun(file)).toBeNull();
  });

  test("triggerText prefers the raw body; user messages fall back to content", () => {
    expect(
      triggerText({
        type: "custom_message",
        content: "ctx\n\nraw",
        details: { body: "raw" },
      }),
    ).toBe("raw");
    expect(triggerText({ type: "custom_message", content: "plain" })).toBe(
      "plain",
    );
    expect(
      triggerText({
        type: "message",
        message: { role: "user", content: "hello" },
      }),
    ).toBe("hello");
    expect(
      triggerText({
        type: "message",
        message: {
          role: "user",
          content: [
            { type: "text", text: "a" },
            { type: "text", text: "b" },
          ],
        },
      }),
    ).toBe("a\nb");
    expect(
      triggerText({
        type: "message",
        message: { role: "assistant", content: [] },
      }),
    ).toBeNull();
  });

  test("stale or mismatched rerun records are dropped (and consumed)", () => {
    const other = "/x/s.jsonl";
    writeRerun({
      sessionFile: other,
      text: "old",
      ts: new Date(Date.now() - (RERUN_TTL_MS + 60_000)).toISOString(),
    });
    expect(consumeRerun(other)).toBeNull();

    writeRerun({
      sessionFile: "/x/other.jsonl",
      text: "not this session",
      ts: new Date().toISOString(),
    });
    expect(consumeRerun(other)).toBeNull();

    // no record left for a later restart
    expect(consumeRerun(other)).toBeNull();
  });
});

// ─── run targeting guards (F3, F4, F5) ────────────────────────────────────

describe("run targeting (F3/F4/F5)", () => {
  test("empty run (no assistant output) is skipped by latestRun (F3)", () => {
    const cwd = path.join(tmp, "f3");
    fs.mkdirSync(cwd, { recursive: true });
    const sess = path.join(cwd, "sess.jsonl");
    fs.writeFileSync(sess, "{}\n");
    const a = path.join(cwd, "a.txt");
    fs.writeFileSync(a, "pre");

    const r1 = startRun(cwd)!;
    stageFileTouch(r1, cwd, a);
    fs.writeFileSync(a, "run1 work");
    finishRun(r1, cwd, sess, true);

    const r2 = startRun(cwd)!; // aborted before any answer
    finishRun(r2, cwd, sess, false);

    expect(latestRun(sess)?.meta.assistantOutput).toBe(true); // r1, not r2
    expect(latestRun(null)?.meta.assistantOutput).toBe(true);

    const undo = performUndo(sess);
    expect(undo.text).toBe("[ok] undone: 1 file");
    expect(fs.readFileSync(a, "utf8")).toBe("pre"); // run1's files reverted
  });

  test("redo refuses when a newer run completed after the undo (F4)", () => {
    const cwd = path.join(tmp, "f4");
    fs.mkdirSync(cwd, { recursive: true });
    const header = {
      type: "session",
      version: 3,
      id: "s1",
      timestamp: "t",
      cwd,
    };
    const t1 = {
      type: "custom_message",
      id: "t1",
      parentId: null,
      customType: "channel-inbound",
      content: "q1",
    };
    const a1 = {
      type: "message",
      id: "a1",
      parentId: "t1",
      message: { role: "assistant", content: [{ type: "text", text: "r1" }] },
    };
    const sess = makeSession(cwd, [header, t1, a1]);

    const r1 = startRun(cwd)!;
    finishRun(r1, cwd, sess, true);
    performUndo(sess);

    // a new turn runs and completes (newer seq)
    const r2 = startRun(cwd)!;
    finishRun(r2, cwd, sess, true);

    const redo = performRedo();
    expect(redo.text).toBe("[!] redo stale: newer run completed");
    // record kept: the state is still restorable once the new turn is dealt with
    expect(fs.existsSync(path.join(storeRoot(), "redo.json"))).toBe(true);
  });

  test("prune keeps the run referenced by redo.json (F5)", () => {
    const cwd = path.join(tmp, "f5");
    fs.mkdirSync(cwd, { recursive: true });
    const sess = path.join(cwd, "sess.jsonl");
    fs.writeFileSync(sess, "{}\n");
    const dirs: string[] = [];
    for (let i = 0; i < 12; i++) {
      const r = startRun(cwd)!;
      finishRun(r, cwd, sess, true);
      dirs.push(path.basename(r.dir));
    }
    // after the first prune, survivors are dirs[2..11]; pin the oldest
    const victim = dirs[2];
    fs.writeFileSync(
      path.join(storeRoot(), "redo.json"),
      JSON.stringify({ run: victim, sessionFile: null, removed: [] }),
    );
    for (let i = 0; i < 2; i++) {
      const r = startRun(cwd)!;
      finishRun(r, cwd, sess, true); // each finishRun prunes
    }
    expect(fs.existsSync(path.join(storeRoot(), "runs", victim))).toBe(true);
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
    expect(
      fs.readdirSync(runs).filter((d) => /^\d+_\d+$/.test(d)),
    ).toHaveLength(10);
    pruneRuns(); // idempotent
    expect(
      fs.readdirSync(runs).filter((d) => /^\d+_\d+$/.test(d)),
    ).toHaveLength(10);
  });
});

// ─── end-to-end: files + conversation together ─────────────────────────────

describe("performUndo + performRedo end to end", () => {
  test("nothing to undo on a fresh store and assistant-less session", () => {
    const cwd = path.join(tmp, "fresh");
    fs.mkdirSync(cwd, { recursive: true });
    const header = {
      type: "session",
      version: 3,
      id: "s1",
      timestamp: "t",
      cwd,
    };
    const trigger = {
      type: "custom_message",
      id: "t1",
      parentId: null,
      customType: "channel-inbound",
      content: "hi",
    };
    const file = makeSession(cwd, [header, trigger]);
    const r = performUndo(file);
    expect(r.text).toBe("[!] nothing to undo");
    expect(r.restarted).toBe(false);
    expect(performRedo().text).toBe("[!] nothing to redo");
  });

  test("conversation-only undo when the store has no matching run", () => {
    const cwd = path.join(tmp, "conv");
    fs.mkdirSync(cwd, { recursive: true });
    const header = {
      type: "session",
      version: 3,
      id: "s1",
      timestamp: "t",
      cwd,
    };
    const t1 = {
      type: "custom_message",
      id: "t1",
      parentId: null,
      customType: "channel-inbound",
      content: "q1",
    };
    const a1 = {
      type: "message",
      id: "a1",
      parentId: "t1",
      message: { role: "assistant", content: [{ type: "text", text: "r1" }] },
    };
    const t2 = {
      type: "custom_message",
      id: "t2",
      parentId: "a1",
      customType: "channel-inbound",
      content: "q2",
    };
    const a2 = {
      type: "message",
      id: "a2",
      parentId: "t2",
      message: { role: "assistant", content: [{ type: "text", text: "r2" }] },
    };
    const file = makeSession(cwd, [header, t1, a1, t2, a2]);

    // no runs recorded (store empty) -> conversation-only revert
    const undo = performUndo(file);
    expect(undo.text).toBe("[ok] undone: conversation (re-running)");
    expect(undo.restarted).toBe(true);
    const kept = fs
      .readFileSync(file, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l).id);
    expect(kept).toEqual(["s1", "t1", "a1", "t2"]);

    // F1: the kept trigger is parked for the post-restart re-send
    expect(consumeRerun(file)).toBe("q2");

    const redo = performRedo();
    expect(redo.text).toBe("[ok] redone: conversation");
    expect(redo.restarted).toBe(true);
    const full = fs
      .readFileSync(file, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l).id);
    expect(full).toEqual(["s1", "t1", "a1", "t2", "a2"]);
  });

  test("findSessionFile falls back to the newest .jsonl under the cwd dir", () => {
    const cwd = path.join(tmp, "sess");
    fs.mkdirSync(cwd, { recursive: true });
    const encDir = path.join(
      process.env.HOME!,
      ".pi",
      "agent",
      "sessions",
      `-${cwd.replace(/\//g, "-")}-`,
    );
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

// ─── F7 + F10 hardening ───────────────────────────────────────────────────

describe("cap and exclusion hardening (F7/F10)", () => {
  test("pre-existing >20MB file is kept, not deleted (F7)", () => {
    const cwd = path.join(tmp, "f7");
    fs.mkdirSync(cwd, { recursive: true });
    const big = path.join(cwd, "big.bin");
    fs.writeFileSync(big, Buffer.alloc(21 * 1024 * 1024, 7));
    const small = path.join(cwd, "small.txt");
    fs.writeFileSync(small, "pre");

    const run = startRun(cwd)!;
    stageFileTouch(run, cwd, big); // exceeds the cap -> pre = "cap"
    stageFileTouch(run, cwd, small);
    fs.writeFileSync(big, "now small (edited)");
    fs.writeFileSync(small, "edited");
    finishRun(run, cwd, null);

    const undo = performUndo(null);
    expect(undo.text).toBe(
      "[ok] undone: 1 file (kept 1 >20MB file, not restored)",
    );
    expect(fs.readFileSync(small, "utf8")).toBe("pre"); // normal file restored
    expect(fs.existsSync(big)).toBe(true); // NOT deleted
    expect(fs.readFileSync(big, "utf8")).toBe("now small (edited)"); // content not restorable
  });

  test("session file inside the git cwd is excluded from untracked copy-back (F10)", () => {
    const cwd = makeRepo(path.join(tmp, "f10"));
    commit(cwd, "base");
    const header = {
      type: "session",
      version: 3,
      id: "s1",
      timestamp: "t",
      cwd,
    };
    const tA = {
      type: "custom_message",
      id: "tA",
      parentId: null,
      customType: "channel-inbound",
      content: "do A",
    };
    const aA = {
      type: "message",
      id: "aA",
      parentId: "tA",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "did A" }],
      },
    };
    const tB = {
      type: "custom_message",
      id: "tB",
      parentId: "aA",
      customType: "channel-inbound",
      content: "do B",
    };
    const sess = path.join(cwd, "sess.jsonl"); // untracked, inside the repo
    fs.writeFileSync(
      sess,
      `${[header, tA, aA, tB].map((l) => JSON.stringify(l)).join("\n")}\n`,
    );

    const run = startRun(cwd)!; // pre-snapshot captures sess.jsonl (4 lines, incl. tB)
    finishRun(run, cwd, sess, false); // aborted run: tB is in-flight

    performUndo(sess); // truncate keeps through tA (the run's trigger)

    // without the F10 fix the pre-run copy of sess.jsonl would be copied
    // back over the truncated file, resurrecting the removed tail (aA, tB)
    const kept = fs
      .readFileSync(sess, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l).id);
    expect(kept).toEqual(["s1", "tA"]);
  });
});
