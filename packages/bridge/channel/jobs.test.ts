import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  formatJobsView,
  type InflightJob,
  type JobHistoryEntry,
  parseJobsFromPs,
  scanJobHistory,
  ticketIdFromPid,
} from "./jobs";

const REPO = path.resolve(import.meta.dir, "../../..");
const TAIL = path.join(REPO, "dispatch/pi-bg-tail");
const KILL = path.join(REPO, "dispatch/pi-bg-kill");

// run a dispatch script; returns {code, out, err} instead of throwing
function run(
  script: string,
  args: string[],
  env: Record<string, string>,
): { code: number; out: string; err: string } {
  try {
    const out = execFileSync("bash", [script, ...args], {
      encoding: "utf8",
      env: { ...process.env, ...env },
      timeout: 30_000,
    });
    return { code: 0, out, err: "" };
  } catch (e: any) {
    return {
      code: e.status ?? 1,
      out: String(e.stdout ?? ""),
      err: String(e.stderr ?? ""),
    };
  }
}

// ─── parseJobsFromPs (moved from index.test.ts) ──────────────────────────

describe("parseJobsFromPs (/jobs)", () => {
  test("parses wrapper lines: pid, age, profile, task; dead pid => id null", () => {
    const ps = [
      "4194001 00:42 /usr/bin/bash /home/monky/scripts/pi-bg worker Resume the jarate migration stuff",
      "4194002 01:05:03 /usr/bin/bash /home/monky/scripts/pi-bg reviewer Check PR #15 for regressions",
      "",
    ].join("\n");
    expect(parseJobsFromPs(ps)).toEqual([
      {
        id: null,
        age: "00:42",
        profile: "worker",
        task: "Resume the jarate migration stuff",
      },
      {
        id: null,
        age: "01:05:03",
        profile: "reviewer",
        task: "Check PR #15 for regressions",
      },
    ]);
  });

  test("ignores non-wrapper lines (pi child mentioning the script path)", () => {
    const ps = [
      "4194010 pi -p --no-extensions the task mentions ~/scripts/pi-bg inside its text",
      "4194011 /usr/bin/bash -c ls scripts",
      "",
    ].join("\n");
    expect(parseJobsFromPs(ps)).toEqual([]);
  });

  test("empty input is empty", () => {
    expect(parseJobsFromPs("")).toEqual([]);
  });
});

// ─── ticketIdFromPid (cgroup escape path -> run_id) ──────────────────────

describe("ticketIdFromPid", () => {
  let procRoot: string;
  beforeEach(() => {
    procRoot = fs.mkdtempSync(path.join(os.tmpdir(), "proc-fake-"));
  });
  afterEach(() => {
    fs.rmSync(procRoot, { recursive: true, force: true });
  });
  const fakeCgroup = (pid: number, content: string): void => {
    const d = path.join(procRoot, String(pid));
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, "cgroup"), content);
  };

  test("cgroup v2 escape path resolves the ticket id", () => {
    fakeCgroup(
      4242,
      "0::/user.slice/user-1000.slice/user@1000.service/pi-bg/20260910-120000-7\n",
    );
    expect(ticketIdFromPid(4242, procRoot)).toBe("20260910-120000-7");
  });

  test("cgroup v1 line shape resolves the ticket id", () => {
    fakeCgroup(
      4242,
      "12:memory:/user.slice/user-1000.slice/user@1000.service/pi-bg/20260910-120000-8\n",
    );
    expect(ticketIdFromPid(4242, procRoot)).toBe("20260910-120000-8");
  });

  test("non-escape cgroup -> null (run in caller cgroup, no escape)", () => {
    fakeCgroup(4242, "0::/user.slice/user-1000.slice/user@1000.service\n");
    expect(ticketIdFromPid(4242, procRoot)).toBeNull();
  });

  test("missing /proc/<pid>/cgroup -> null, no throw", () => {
    expect(ticketIdFromPid(99999999, procRoot)).toBeNull();
    expect(ticketIdFromPid(99999999, path.join(procRoot, "nope"))).toBeNull();
  });
});

// ─── scanJobHistory (synthetic /tmp fixtures) ─────────────────────────────

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jobs-test-"));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function touch(name: string, mtimeSec: number, content = "x\n"): void {
  const p = path.join(tmp, name);
  fs.writeFileSync(p, content);
  const t = new Date(mtimeSec * 1000);
  fs.utimesSync(p, t, t);
}

describe("scanJobHistory", () => {
  test("assembles state + webhook from artifacts, newest first", () => {
    const now = 1_790_000_000;
    // A: completed, webhook delivered (2xx code recorded)
    touch("pi-bg-20260910-100000-1-raw.out", now - 300);
    touch("pi-bg-20260910-100000-1-out.md", now - 290, "done work\n");
    touch(
      "pi-bg-20260910-100000-1-wb-status",
      now - 280,
      "200 2026-09-10T10:00Z\n",
    );
    // B: completed but callback dead-lettered (http 502)
    touch("pi-bg-20260910-101000-2-raw.out", now - 250);
    touch("pi-bg-20260910-101000-2-out.md", now - 240, "work\n");
    touch(
      "pi-bg-20260910-101000-2-webhook-failed",
      now - 200,
      "ticket   : 20260910-101000-2\nhttp     : 502 (3 attempts)\n",
    );
    // C: killed on purpose
    touch("pi-bg-20260910-102000-3-raw.out", now - 150);
    touch(
      "pi-bg-20260910-102000-3-killed",
      now - 100,
      "2026-09-10T10:05:00Z 20260910-102000-3 killed by monky after 0s; pids: 42\n",
    );
    // D: started, no report (raw.out only)
    touch("pi-bg-20260910-103000-4-raw.out", now - 10);
    // non-ticket files: ignored
    touch("pi-bg-notaticket-raw.out", now - 5);
    touch("unrelated.txt", now - 5);

    const h = scanJobHistory(tmp);
    expect(h.map((e) => e.id)).toEqual([
      "20260910-103000-4",
      "20260910-102000-3",
      "20260910-101000-2",
      "20260910-100000-1",
    ]);
    expect(h).toEqual([
      {
        id: "20260910-103000-4",
        state: "lost",
        mtime: now - 10,
        webhook: null,
      },
      {
        id: "20260910-102000-3",
        state: "killed",
        mtime: now - 100,
        webhook: null,
      },
      {
        id: "20260910-101000-2",
        state: "webhook-failed",
        mtime: now - 200,
        webhook: "502",
      },
      {
        id: "20260910-100000-1",
        state: "done",
        mtime: now - 280,
        webhook: "200",
      },
    ]);
  });

  test("empty dir -> empty history; missing dir -> empty (no throw)", () => {
    expect(scanJobHistory(tmp)).toEqual([]);
    expect(scanJobHistory(path.join(tmp, "nope"))).toEqual([]);
  });

  test("ticket with only a non-empty out.md counts as done", () => {
    touch("pi-bg-20260910-110000-9-out.md", 1_790_000_000, "result\n");
    const h = scanJobHistory(tmp);
    expect(h).toEqual([
      {
        id: "20260910-110000-9",
        state: "done",
        mtime: 1_790_000_000,
        webhook: null,
      },
    ]);
  });
});

// ─── formatJobsView ───────────────────────────────────────────────────────

describe("formatJobsView", () => {
  const inflight: InflightJob[] = [
    {
      id: "20260910-120000-7",
      profile: "worker",
      age: "00:42",
      task: "bulk refactor",
    },
    { id: null, profile: "reviewer", age: "01:00", task: "no cgroup id" },
  ];
  const history: JobHistoryEntry[] = [
    {
      id: "20260910-103000-4",
      state: "lost",
      mtime: 1_790_000_000,
      webhook: null,
    },
    {
      id: "20260910-100000-1",
      state: "done",
      mtime: 1_789_999_700,
      webhook: "200",
    },
    {
      id: "20260910-090000-7",
      state: "webhook-failed",
      mtime: 1_789_996_400,
      webhook: "502",
    },
  ];

  test("text: in-flight lines + recent history with ages", () => {
    const out = formatJobsView(inflight, history, "text", 1_790_000_000);
    expect(out).toContain("[jobs] 2 jobs in flight:");
    expect(out).toContain("- 20260910-120000-7 worker · 00:42 · bulk refactor");
    expect(out).toContain("- reviewer · 01:00 · no cgroup id (id: none)");
    expect(out).toContain("recent (newest first):");
    expect(out).toContain(
      "- 20260910-103000-4 lost · 0s ago".replace("0s", "0s"),
    );
    expect(out).toContain("- 20260910-100000-1 done · webhook 200 · 5m ago");
    expect(out).toContain(
      "- 20260910-090000-7 webhook-failed · webhook 502 · 1h0m ago",
    );
  });

  test("text: no in-flight and no history is a single line", () => {
    expect(formatJobsView([], [], "text")).toBe("[jobs] No jobs in flight.");
  });

  test("json: machine-readable object", () => {
    const parsed = JSON.parse(formatJobsView(inflight, history, "json"));
    expect(parsed.inflight).toEqual(inflight);
    expect(parsed.history).toEqual(history);
  });

  test("json caps history at 10 entries", () => {
    const big: JobHistoryEntry[] = Array.from({ length: 15 }, (_, i) => ({
      id: `20260910-00000${i % 10}-${i}`,
      state: "lost" as const,
      mtime: 1_790_000_000 - i * 100,
      webhook: null,
    }));
    const parsed = JSON.parse(formatJobsView([], big, "json"));
    expect(parsed.history).toHaveLength(10);
    expect(parsed.history[0].id).toBe(big[0].id);
  });
});

// ─── pi-bg-tail (issue #16) ───────────────────────────────────────────────

describe("pi-bg-tail", () => {
  const tid = "20260910-120000-1";
  const env = (home: string) => ({
    HOME: home,
    PI_BG_TMPDIR: tmp,
    PI_DISPATCH_WEBHOOK: "",
  });
  let home: string;
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "jobs-tail-home-"));
    const lines = Array.from(
      { length: 10 },
      (_, i) => `line${String(i + 1).padStart(2, "0")}`,
    );
    fs.writeFileSync(
      path.join(tmp, `pi-bg-${tid}-raw.out`),
      `${lines.join("\n")}\n`,
    );
  });
  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  test("default 40 lines -> whole short file", () => {
    const r = run(TAIL, [tid], env(home));
    expect(r.code).toBe(0);
    expect(r.out.trim().split("\n")).toHaveLength(10);
    expect(r.out).toContain("line01");
    expect(r.out).toContain("line10");
  });

  test("custom line count -> last N only", () => {
    const r = run(TAIL, [tid, "3"], env(home));
    expect(r.code).toBe(0);
    expect(r.out.trim().split("\n")).toEqual(["line08", "line09", "line10"]);
  });

  test("unknown id -> exit 2 + clear error", () => {
    const r = run(TAIL, ["20260910-120000-999"], env(home));
    expect(r.code).toBe(2);
    expect(r.err).toContain("no live output");
    expect(r.err).toContain("20260910-120000-999");
  });

  test("malformed id -> exit 2", () => {
    const r = run(TAIL, ["not-a-ticket"], env(home));
    expect(r.code).toBe(2);
    expect(r.err).toContain("not a ticket id");
  });

  test("no args -> exit 2 + usage", () => {
    const r = run(TAIL, [], env(home));
    expect(r.code).toBe(2);
    expect(r.err).toContain("usage: pi-bg-tail");
  });

  test("-f follows: emits current content, stays alive until killed", async () => {
    const p: ChildProcess = spawn("bash", [TAIL, tid, "-f"], {
      env: { ...process.env, ...env(home) },
    });
    let out = "";
    p.stdout?.on("data", (d) => (out += d));
    await new Promise<void>((res) => {
      const iv = setInterval(() => {
        if (out.includes("line10")) {
          clearInterval(iv);
          res();
        }
      }, 20);
      setTimeout(() => {
        clearInterval(iv);
        res();
      }, 5000);
    });
    expect(out).toContain("line10");
    expect(out).toContain("line09");
    p.kill("SIGKILL");
    await new Promise<void>((res) => p.once("close", () => res()));
  });
});

// ─── pi-bg-kill (issue #15) ───────────────────────────────────────────────

describe("pi-bg-kill", () => {
  const tid = "20260910-120000-2";
  // fake cgroup root: the "processes" are dummies (99999999x) that do not
  // exist, so no real process is ever signalled
  let home: string;
  let cgRoot: string;
  let cg: string;
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "jobs-kill-home-"));
    cgRoot = path.join(tmp, "cg");
    cg = path.join(cgRoot, "pi-bg", tid);
    fs.mkdirSync(cg, { recursive: true });
    fs.writeFileSync(path.join(cg, "cgroup.procs"), "999999999\n999999998\n");
    fs.writeFileSync(path.join(cg, "cgroup.kill"), "");
  });
  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });
  const env = (extra: Record<string, string> = {}) => ({
    HOME: home,
    PI_BG_TMPDIR: tmp,
    PI_BG_CG_ROOT: cgRoot,
    PI_BG_KILL_WAIT: "1",
    PI_BG_WB_BACKOFF: "0",
    PI_DISPATCH_WEBHOOK: "",
    ...extra,
  });

  // 30s timeout on the script-spawning tests: on a loaded machine the
  // script's wall time can exceed bun's 5s default test timeout (the
  // execFileSync budget below is already 30s).
  test(
    "--dry-run lists the tree, changes nothing",
    () => {
      const r = run(KILL, [tid, "--dry-run"], env());
      expect(r.code).toBe(0);
      expect(r.out).toContain("dry-run: no signal sent");
      expect(r.out).toContain("999999999");
      expect(r.out).toContain("(gone)"); // dummy pids are not real processes
      expect(fs.readFileSync(path.join(cg, "cgroup.procs"), "utf8")).toBe(
        "999999999\n999999998\n",
      );
      expect(fs.existsSync(path.join(tmp, `pi-bg-${tid}-killed`))).toBe(false);
    },
    { timeout: 30_000 },
  );

  test(
    "real kill: exits 0, writes killed marker, posts nothing without webhook",
    () => {
      const r = run(KILL, [tid], env());
      expect(r.code).toBe(0);
      expect(r.out).toContain(`killed ${tid}`);
      const marker = fs.readFileSync(
        path.join(tmp, `pi-bg-${tid}-killed`),
        "utf8",
      );
      expect(marker).toContain(tid);
      expect(marker).toContain("killed");
      // no webhook configured -> no body/dead-letter files
      expect(fs.existsSync(path.join(tmp, `pi-bg-${tid}-kill-body.json`))).toBe(
        false,
      );
      expect(
        fs.existsSync(path.join(tmp, `pi-bg-${tid}-kill-webhook-failed`)),
      ).toBe(false);
    },
    { timeout: 30_000 },
  );

  test(
    "webhook post failure -> dead letter, kill still exit 0",
    () => {
      // port 9 = discard: connection refused on every attempt, backoff 0
      const r = run(
        KILL,
        [tid],
        env({ PI_DISPATCH_WEBHOOK: "http://127.0.0.1:9/" }),
      );
      expect(r.code).toBe(0);
      const dl = fs.readFileSync(
        path.join(tmp, `pi-bg-${tid}-kill-webhook-failed`),
        "utf8",
      );
      expect(dl).toContain(tid);
      expect(dl).toContain("event    : kill");
      expect(fs.existsSync(path.join(tmp, `pi-bg-${tid}-kill-body.json`))).toBe(
        false,
      );
    },
    { timeout: 30_000 },
  );

  test("cgroup dir is reaped after it drains (no leaked empty dirs)", () => {
    // empty fake cgroup dir: no member files at all, so the drain check
    // passes immediately and the post-drain rmdir can actually succeed
    // (a real drained cgroup v2 dir is empty too)
    fs.rmSync(path.join(cg, "cgroup.procs"), { force: true });
    fs.rmSync(path.join(cg, "cgroup.kill"), { force: true });
    const r = run(KILL, [tid], env());
    expect(r.code).toBe(0);
    expect(r.out).toContain(`killed ${tid}`);
    expect(fs.existsSync(path.join(tmp, `pi-bg-${tid}-killed`))).toBe(true);
    expect(fs.existsSync(cg)).toBe(false); // dir reaped
  });

  test("unknown ticket (no cgroup dir) -> exit 2 + clear error", () => {
    const r = run(KILL, ["20260910-120000-999"], env());
    expect(r.code).toBe(2);
    expect(r.err).toContain("no cgroup");
    expect(r.err).toContain("20260910-120000-999");
  });

  test("malformed id -> exit 2", () => {
    const r = run(KILL, ["nope"], env());
    expect(r.code).toBe(2);
    expect(r.err).toContain("not a ticket id");
  });

  test("no args -> exit 2 + usage", () => {
    const r = run(KILL, [], env());
    expect(r.code).toBe(2);
    expect(r.err).toContain("usage: pi-bg-kill");
  });
});
