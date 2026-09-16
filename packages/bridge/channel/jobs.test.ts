import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  formatJobsView,
  type InflightJob,
  type JobHistoryEntry,
  jobsKill,
  jobsTail,
  jobsView,
  parseJobsFromPs,
  scanJobHistory,
  stateLabel,
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

  test("parses snapshot-path wrapper lines (deploy-swap guard re-exec)", () => {
    // the wrapper execs a per-run copy under ~/.pi-bg-art/snap-<rid>/pi-bg;
    // the old scripts/pi-bg-only regex missed every post-swap run
    const ps = [
      "12345 02:03 /bin/bash /home/monky/.pi-bg-art/snap-20260915-104204-1233380/pi-bg worker echo done",
      "",
    ].join("\n");
    expect(parseJobsFromPs(ps)).toEqual([
      { id: null, age: "02:03", profile: "worker", task: "echo done" },
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

// ─── parseJobsFromPs dedup (hb subshell alias, RCA 2026-09-16 §1) ────────
// pi-bg's heartbeat loop is a forked subshell that keeps the wrapper's
// argv AND cgroup, so one live run shows up as two ps lines resolving to
// the same ticket id. parseJobsFromPs must collapse them to one entry,
// keeping the longest etime (the wrapper).

describe("parseJobsFromPs dedup (wrapper + hb subshell)", () => {
  const RUN = "20260916-043323-3148427";
  const ARGV = `/bin/bash /home/monky/.pi-bg-art/snap-${RUN}/pi-bg worker PERFORMANCE AUDIT of the ppgrid pipeline`;
  const TASK = "PERFORMANCE AUDIT of the ppgrid pipeline";
  let procRoot: string;
  beforeEach(() => {
    procRoot = fs.mkdtempSync(path.join(os.tmpdir(), "proc-dedup-"));
  });
  afterEach(() => {
    fs.rmSync(procRoot, { recursive: true, force: true });
  });
  const fakeCgroup = (pid: number, runId: string): void => {
    const d = path.join(procRoot, String(pid));
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(
      path.join(d, "cgroup"),
      `0::/user.slice/user-1003.slice/user@1003.service/pi-bg/${runId}\n`,
    );
  };

  test("two lines, same resolved id -> one job, LONGEST etime kept", () => {
    fakeCgroup(3148427, RUN); // wrapper (forked first, oldest)
    fakeCgroup(3148986, RUN); // hb subshell (same cgroup, +54s)
    const ps = [`3148427 51:33 ${ARGV}`, `3148986 50:39 ${ARGV}`, ""].join(
      "\n",
    );
    expect(parseJobsFromPs(ps, procRoot)).toEqual([
      { id: RUN, age: "51:33", profile: "worker", task: TASK },
    ]);
  });

  test("hb line first in ps order -> still one job, wrapper etime kept", () => {
    fakeCgroup(3148427, RUN);
    fakeCgroup(3148986, RUN);
    const ps = [`3148986 50:39 ${ARGV}`, `3148427 51:33 ${ARGV}`, ""].join(
      "\n",
    );
    expect(parseJobsFromPs(ps, procRoot)).toEqual([
      { id: RUN, age: "51:33", profile: "worker", task: TASK },
    ]);
  });

  test("D-H:MM:SS beats H:MM:SS (day-format etime compares in seconds)", () => {
    fakeCgroup(111, RUN);
    fakeCgroup(222, RUN);
    const ps = [`111 1-02:00:00 ${ARGV}`, `222 23:59:59 ${ARGV}`, ""].join(
      "\n",
    );
    expect(parseJobsFromPs(ps, procRoot)).toEqual([
      { id: RUN, age: "1-02:00:00", profile: "worker", task: TASK },
    ]);
  });

  test("two DISTINCT resolved ids -> both kept", () => {
    fakeCgroup(111, RUN);
    fakeCgroup(222, "20260916-044537-3530347");
    const ps = [
      `111 51:33 ${ARGV}`,
      `222 10:00 /bin/bash /home/monky/.pi-bg-art/snap-20260916-044537-3530347/pi-bg worker other job`,
      "",
    ].join("\n");
    expect(parseJobsFromPs(ps, procRoot)).toEqual([
      { id: RUN, age: "51:33", profile: "worker", task: TASK },
      {
        id: "20260916-044537-3530347",
        age: "10:00",
        profile: "worker",
        task: "other job",
      },
    ]);
  });

  test("unresolvable ids (no cgroup match) -> both kept, no false dedup", () => {
    // procRoot is empty: ticketIdFromPid -> null for both pids
    const ps = [`3148427 51:33 ${ARGV}`, `3148986 50:39 ${ARGV}`, ""].join(
      "\n",
    );
    expect(parseJobsFromPs(ps, procRoot)).toEqual([
      { id: null, age: "51:33", profile: "worker", task: TASK },
      { id: null, age: "50:39", profile: "worker", task: TASK },
    ]);
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

  test("text: v3 frames - in-flight header row + │-gutter task, recent state-first", () => {
    const out = formatJobsView(inflight, history, "text", 1_790_000_000);
    expect(out).toBe(
      [
        "┌ jobs · 2 in flight",
        "┣ 20260910-120000-7 worker · 00:42",
        "│ bulk refactor",
        "┣ reviewer · 01:00",
        "│ no cgroup id",
        "└",
        "",
        "┌ recent (newest first) · 3",
        "├ lost · 0s · 20260910-103000-4",
        "├ ok · 5m · 20260910-100000-1",
        "├ wb-fail · 1h0m · 20260910-090000-7",
        "└",
      ].join("\n"),
    );
  });

  test("text: long task wraps on │ gutter, all rows stay under 40 cols", () => {
    const long: InflightJob[] = [
      {
        id: "20260910-120000-7",
        profile: "worker",
        age: "12m",
        task: "lib.sh dedup + contract test + pi-restart into repo and wire the webhook",
      },
    ];
    const out = formatJobsView(long, [], "text", 1_790_000_000);
    for (const line of out.split("\n")) {
      expect(line.length).toBeLessThanOrEqual(40);
    }
    expect(out).toContain("┣ 20260910-120000-7 worker · 12m");
    expect(out).toContain("│ lib.sh dedup + contract test +");
    expect(out).toContain("│ pi-restart into repo and wire the");
    expect(out).toContain("│ webhook");
  });

  test("text: worst-case recent row stays under 40 cols (wb-fail + 1h59m)", () => {
    const worst: JobHistoryEntry[] = [
      {
        id: "20260910-103000-4",
        state: "webhook-failed",
        mtime: 1_789_992_850,
        webhook: "502",
      },
    ];
    const out = formatJobsView([], worst, "text", 1_790_000_000);
    for (const line of out.split("\n")) {
      expect(line.length).toBeLessThanOrEqual(40);
    }
    expect(out).toContain("├ wb-fail · 1h59m · 20260910-103000-4");
  });

  test("stateLabel compresses for the text view, json keeps raw states", () => {
    expect(stateLabel("done")).toBe("ok");
    expect(stateLabel("webhook-failed")).toBe("wb-fail");
    expect(stateLabel("killed")).toBe("killed");
    expect(stateLabel("lost")).toBe("lost");
  });

  test("text: no in-flight and no history is a closed empty frame", () => {
    expect(formatJobsView([], [], "text")).toBe("┌ jobs · none in flight\n└");
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

// ─── jobsView recent exclusion (RCA 2026-09-16 §2) ──────────────────────
// A live run already owns its artifact dir at dispatch time (no out.md
// yet), so scanJobHistory sees it as "lost" and it would render in
// recent right next to its own in-flight row. jobsView must exclude the
// non-null in-flight ids from the history (text + json).

describe("jobsView (recent excludes in-flight ids)", () => {
  const LIVE = "20260916-043323-3148427";
  const DONE = "20260916-044537-3530347";
  const inflight: InflightJob[] = [
    { id: LIVE, profile: "worker", age: "51:33", task: "audit" },
    { id: null, profile: "reviewer", age: "10:00", task: "no cgroup id" },
  ];
  const history: JobHistoryEntry[] = [
    // live run's own artifact dir, scanned as "lost" (no out.md yet)
    { id: LIVE, state: "lost", mtime: 1_790_000_000, webhook: null },
    { id: DONE, state: "done", mtime: 1_789_999_700, webhook: "200" },
  ];

  // the ids on the rendered recent frame's `├` rows only
  function recentIds(out: string): string[] {
    const lines = out.split("\n");
    const i = lines.findIndex((l) => l.startsWith("┌ recent"));
    if (i === -1) return [];
    const ids: string[] = [];
    for (let k = i + 1; k < lines.length; k++) {
      if (lines[k] === "└") break;
      const m = lines[k].match(/^├ \S+ · \S+ · (\S+)$/);
      if (m) ids.push(m[1]);
    }
    return ids;
  }

  test("text: live id hidden from recent, completed id shown", () => {
    const out = jobsView("text", { inflight, history });
    const ids = recentIds(out);
    expect(ids).not.toContain(LIVE);
    expect(ids).toContain(DONE);
    // the in-flight frame is unchanged — the live job still renders there
    expect(out).toContain(`┣ ${LIVE} worker · 51:33`);
  });

  test("json: history excludes the live id, keeps the completed id", () => {
    const parsed = JSON.parse(jobsView("json", { inflight, history }));
    expect(parsed.history.map((h: JobHistoryEntry) => h.id)).toEqual([DONE]);
    expect(parsed.inflight.map((j: InflightJob) => j.id)).toEqual([LIVE, null]);
  });

  test("null in-flight id never excludes history (non-null only)", () => {
    const out = jobsView("text", {
      inflight: [{ id: null, profile: "worker", age: "10:00", task: "x" }],
      history,
    });
    const ids = recentIds(out);
    expect(ids).toContain(LIVE); // no non-null inflight id matches LIVE
    expect(ids).toContain(DONE);
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

// ─── /jobs kill | tail wrappers (#44) ────────────────────────────────────

describe("jobsKill / jobsTail wrappers (#44)", () => {
  let tmp: string;
  let scriptsDir: string;
  const env: Record<string, string> = {};

  function stub(name: string, body: string): void {
    const p = path.join(scriptsDir, name);
    fs.writeFileSync(p, body);
    fs.chmodSync(p, 0o755);
  }

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jobs-44-"));
    scriptsDir = path.join(tmp, "scripts");
    fs.mkdirSync(scriptsDir, { recursive: true });
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  const ID = "20260914-091714-3097";

  test("bad id -> usage line, script never spawned", async () => {
    stub("pi-bg-kill", "#!/bin/sh\necho should-not-run\n");
    expect(await jobsKill("nope", env, scriptsDir)).toContain(
      "[!] usage: /jobs kill <id>",
    );
    expect(await jobsTail("nope", 40, env, scriptsDir)).toContain(
      "[!] usage: /jobs tail <id>",
    );
  });

  test("kill: script exit 0 -> [ok] killed <id>, fenced", async () => {
    stub("pi-bg-kill", "#!/bin/sh\nexit 0\n");
    const r = await jobsKill(ID, env, scriptsDir);
    expect(r).toContain(`[ok] killed ${ID}`);
    expect(r.startsWith("```")).toBe(true);
  });

  test("kill: script exit 2 (unknown ticket) -> [!] with the script's reason", async () => {
    stub(
      "pi-bg-kill",
      "#!/bin/sh\necho \"pi-bg-kill: no cgroup for ticket 'X'\" >&2\nexit 2\n",
    );
    const r = await jobsKill("20260910-120000-999", env, scriptsDir);
    expect(r).toContain("[!] pi-bg-kill: no cgroup");
  });

  test("kill: missing script -> not-found line, no throw", async () => {
    const r = await jobsKill(ID, env, scriptsDir);
    expect(r).toContain("pi-bg-kill not found at");
    expect(r).toContain(scriptsDir);
  });

  test("tail: output is fenced, capped to the last 40 lines, dropped count noted", async () => {
    let body = "#!/bin/sh\n";
    for (let i = 1; i <= 100; i++) body += `echo "line ${i}"\n`;
    stub("pi-bg-tail", body);
    const r = await jobsTail(ID, 100, env, scriptsDir);
    const inner = r.slice(4, -4).split("\n");
    expect(inner[0]).toBe("[..] 60 earlier lines");
    expect(inner[1]).toBe("line 61");
    expect(inner.at(-1)).toBe("line 100");
    expect(inner.length).toBe(1 + 40);
  });

  test("tail: overlong lines are hard-wrapped at 40 cols (mobile budget)", async () => {
    const long = "x".repeat(120);
    stub("pi-bg-tail", `#!/bin/sh\necho "${long}"\necho "ok"\n`);
    const r = await jobsTail(ID, 40, env, scriptsDir);
    const lines = r.split("\n");
    // fence + 3 wrapped (40*3) + "ok" + fence
    expect(lines.length).toBe(6);
    for (const l of lines) expect(l.length).toBeLessThanOrEqual(40);
    expect(lines[1] + lines[2] + lines[3]).toBe(long);
  });

  test("tail: --n is clamped to [1, 200] and passed to the script", async () => {
    stub("pi-bg-tail", '#!/bin/sh\necho "n=$2"\n');
    expect(await jobsTail(ID, 500, env, scriptsDir)).toContain("n=200");
    expect(await jobsTail(ID, 12, env, scriptsDir)).toContain("n=12");
    expect(await jobsTail(ID, 0, env, scriptsDir)).toContain("n=40");
  });

  test("tail: empty output -> [!] no output", async () => {
    stub("pi-bg-tail", "#!/bin/sh\nexit 0\n");
    const r = await jobsTail(ID, 40, env, scriptsDir);
    expect(r).toContain(`[!] no output for ${ID}`);
  });
});
