/**
 * dispatch artifact-lookup tests — the ~/.pi-bg-art convention that
 * survives the launcher retirement (hall-monitor #35, 2026-10-20).
 *
 * Moved here from jarate-bg.test.ts with the gut: these pin the
 * COMPLETION-SIDE readers of the artifact dir, which stay alive until
 * the last in-flight ticket drains —
 *   - jarate-bg-watchdog rule 3 (dual lookup: persistent dir + legacy /tmp)
 *   - jarate-bg-watchdog STALLED classification (issue #52)
 *   - jarate-bg-tail (artifact lookup)
 * The launcher's own artifact tests (bg_post shape, run records, hb)
 * went with the launch path; the artifacts the in-flight runs leave
 * behind are what these pin.
 */
import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "bun";

// Leak guard (issue: /tmp inode exhaustion, 2026-09-14): every fixture
// mkdtemp dir is tracked and force-removed in a file-level afterEach.
const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

type RunResult = { code: number; out: string; err: string };

function runScript(
  script: string,
  args: string[],
  env: Record<string, string>,
  cwd: string,
): Promise<RunResult> {
  const p = spawn(["bash", script, ...args], {
    env,
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  return (async () => {
    const [out, err] = await Promise.all([
      new Response(p.stdout).text(),
      new Response(p.stderr).text(),
    ]);
    const code = await p.exited;
    return { code, out, err };
  })();
}

const WD = path.join(import.meta.dir, "jarate-bg-watchdog");
const TAIL = path.join(import.meta.dir, "jarate-bg-tail");

// Fake ids in year 2099: never collide with real tickets (real run ids
// carry the real date - jarate-bg run_id). The id encodes user+process,
// all digits to stay valid for the ticket validators
// (^[0-9]{8}-[0-9]{6}-[0-9]+$ in the jarate-bg-watchdog sweep and in
// jarate-bg-kill/-tail):
//   group 2 = uid (4 digits, zero-padded) + n (2 digits, zero-padded)
//   group 3 = this process's pid (zero-padded to >= 6; unbounded -
//             pid_max is 4194304 on these boxes, pids run 6-7 digits)
// Why structural: a fixture path under sticky /tmp is only shared by the
// SAME owner. A same-path collision needs an identical uid group, i.e.
// the same user, who may unlink (sticky-bit owner rule) and rewrite
// 0644 files. Cross-user leftovers - jimmy-owned /tmp/pi-bg-...-out.md
// EACCES-ing monky's+frank's deploy tests, incident 2026-10-17 - are
// impossible. Two concurrent runs of one user differ in the pid group;
// same user + recycled pid later is the same owner, so the rmLegacy
// (force) cleanup and writeFileSync still work.
// Length budget: "jarate/<t>" must fit the STALLED embed row clip
// (LINE_W=30, watchdog) -> TID <= 23 chars; met with a <=9999 uid
// (guarded) and the unbounded pid group. n is capped at 99 (2 digits);
// the jarate-bg-tail fixture family takes n 31-33, the watchdog
// fixtures n 1-24 - the same family separation the old minute tag
// (235958 vs 235959) gave.
const TID_UID = os.userInfo().uid;
if (TID_UID > 9999)
  throw new Error(`TID encoding needs a <=9999 uid, got ${TID_UID}`);
const TID = (n: number) => {
  if (n > 99) throw new Error(`TID n must fit 2 digits, got ${n}`);
  return `20991231-${String(TID_UID).padStart(4, "0")}${String(n).padStart(2, "0")}-${String(process.pid).padStart(6, "0")}`;
};

/**
 * Watchdog fixture (artifact-lookup shape): a worktree ticket dir aged
 * past the 20-min sweep threshold + a fake artifact dir + the legacy
 * /tmp twin (rmLegacy cleans it).
 */
function wdFixture(n: number) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pibg-wd-"));
  tmpDirs.push(tmp);
  const home = path.join(tmp, "home");
  const wtDir = path.join(tmp, "wt", "jarate", TID(n));
  const art = path.join(tmp, "art");
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(wtDir, { recursive: true });
  fs.mkdirSync(art, { recursive: true });
  // age the ticket dir past the 20-min sweep threshold
  const old = new Date(Date.now() - 30 * 60 * 1000);
  fs.utimesSync(wtDir, old, old);
  const env = { ...process.env } as Record<string, string>;
  env.HOME = home;
  env.PI_BG_WT_DIR = path.join(tmp, "wt");
  env.PI_BG_TMPDIR = art;
  // keep the sweep (incl. the empty-cgroup reaper) off the real cgroup fs
  env.PI_BG_CG_ROOT = path.join(tmp, "cg");
  delete env.PI_DISPATCH_WEBHOOK;
  const legacy = (suf: string) => `/tmp/pi-bg-${TID(n)}${suf}`;
  const rmLegacy = () => {
    for (const suf of ["-out.md", "-killed", "-webhook-failed"]) {
      fs.rmSync(legacy(suf), { force: true });
    }
  };
  const run = (args: string[] = ["--dry-run"]) => runScript(WD, args, env, tmp);
  return { tmp, art, legacy, rmLegacy, run };
}

/**
 * Watchdog fixture for the STALLED tests (issues #51, #52): same shape
 * as the wdFixture above + an env-overrides map for run() (webhook
 * capture, PI_DISPATCH_RECORD_DIR, PI_BG_STALL_MIN, ...).
 */
function wdFixtureX(n: number) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pibg-wd-"));
  tmpDirs.push(tmp);
  const home = path.join(tmp, "home");
  const wtDir = path.join(tmp, "wt", "jarate", TID(n));
  const art = path.join(tmp, "art");
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(wtDir, { recursive: true });
  fs.mkdirSync(art, { recursive: true });
  // age the ticket dir past the 20-min sweep threshold (dead-ticket cases)
  const old = new Date(Date.now() - 30 * 60 * 1000);
  fs.utimesSync(wtDir, old, old);
  const env = { ...process.env } as Record<string, string>;
  env.HOME = home;
  env.PI_BG_WT_DIR = path.join(tmp, "wt");
  env.PI_BG_TMPDIR = art;
  // keep the sweep (incl. the empty-cgroup reaper) off the real cgroup fs
  env.PI_BG_CG_ROOT = path.join(tmp, "cg");
  // keep the M2 liveness section off the real /var/tmp/jarate-live
  // (issue #199 review: a stale real marker adds an extra SILENT post
  // to the exact-count assertions; absent dir -> the section no-ops)
  env.PI_BG_LIVE_ROOT = path.join(tmp, "live");
  delete env.PI_DISPATCH_WEBHOOK;
  delete env.PI_BG_SETSID;
  // same hermeticity as the old launcher fixture: a ticket run leaks
  // SNAP + RUN_ID
  delete env.PI_BG_RUN_ID;
  delete env.PI_BG_SNAP;
  const run = (
    args: string[] = ["--dry-run"],
    overrides?: Record<string, string>,
  ) => runScript(WD, args, { ...env, ...overrides }, tmp);
  return { tmp, art, run };
}

describe("watchdog rule 3: dual lookup (persistent dir + legacy /tmp)", () => {
  test("out.md in legacy /tmp only -> ticket skipped (pre-upgrade run)", async () => {
    const fx = wdFixture(1);
    fs.writeFileSync(fx.legacy("-out.md"), "done\n");
    try {
      const r = await fx.run();
      expect(r.code).toBe(0);
      expect(r.out).toContain("0 dead ticket(s) found");
    } finally {
      fx.rmLegacy();
    }
  }, 60_000);

  test("out.md in persistent dir only -> ticket skipped", async () => {
    const fx = wdFixture(2);
    fs.writeFileSync(path.join(fx.art, `pi-bg-${TID(2)}-out.md`), "done\n");
    const r = await fx.run();
    expect(r.code).toBe(0);
    expect(r.out).toContain("0 dead ticket(s) found");
  }, 60_000);

  test("killed marker in legacy /tmp only -> ticket skipped", async () => {
    const fx = wdFixture(4);
    fs.writeFileSync(fx.legacy("-killed"), "x\n");
    try {
      const r = await fx.run();
      expect(r.code).toBe(0);
      expect(r.out).toContain("0 dead ticket(s) found");
    } finally {
      fx.rmLegacy();
    }
  }, 60_000);

  test("no artifacts anywhere -> flagged dead", async () => {
    const fx = wdFixture(3);
    const r = await fx.run();
    expect(r.code).toBe(0);
    expect(r.out).toContain("1 dead ticket(s) found");
    expect(r.out).toContain(`DEAD jarate/${TID(3)}`);
    expect(r.out).toContain("no callback on record");
  }, 60_000);

  test("empty (0-byte) out.md is NOT a completion -> flagged dead", async () => {
    const fx = wdFixture(5);
    fs.writeFileSync(path.join(fx.art, `pi-bg-${TID(5)}-out.md`), "");
    const r = await fx.run();
    expect(r.code).toBe(0);
    expect(r.out).toContain("1 dead ticket(s) found");
    expect(r.out).toContain(`DEAD jarate/${TID(5)}`);
  }, 60_000);

  test("run record state=done (no out.md) -> NOT flagged dead (deploy-swap DIED, 2026-09-15)", async () => {
    // ticket 3740387: the wrapper completed the review but died to a
    // mid-run script swap BEFORE writing out.md; the exit trap posted the
    // DIED callback and marked the record done. The sweep must not
    // re-flag a ticket whose wrapper ran its exit trap.
    const fx = wdFixture(6);
    const recDir = path.join(fx.tmp, "home", ".pi-dispatch", "runs");
    fs.mkdirSync(recDir, { recursive: true });
    fs.writeFileSync(
      path.join(recDir, `pi-bg-${TID(6)}.json`),
      JSON.stringify({ run: TID(6), state: "done" }, null, 2),
    );
    const r = await fx.run();
    expect(r.code).toBe(0);
    expect(r.out).toContain("0 dead ticket(s) found");
  }, 60_000);

  test("run record state=killed (no out.md, no marker) -> NOT flagged dead", async () => {
    const fx = wdFixture(7);
    const recDir = path.join(fx.tmp, "home", ".pi-dispatch", "runs");
    fs.mkdirSync(recDir, { recursive: true });
    fs.writeFileSync(
      path.join(recDir, `pi-bg-${TID(7)}.json`),
      JSON.stringify({ run: TID(7), state: "killed" }, null, 2),
    );
    const r = await fx.run();
    expect(r.code).toBe(0);
    expect(r.out).toContain("0 dead ticket(s) found");
  }, 60_000);
});

describe("jarate-bg-tail: artifact lookup (persistent dir + legacy /tmp)", () => {
  test("raw.out in PI_BG_TMPDIR -> shown", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pibg-tail-"));
    tmpDirs.push(tmp);
    const art = path.join(tmp, "art");
    fs.mkdirSync(art, { recursive: true });
    const id = TID(31);
    fs.writeFileSync(path.join(art, `pi-bg-${id}-raw.out`), "fresh line\n");
    const env = { ...process.env } as Record<string, string>;
    env.HOME = tmp;
    env.PI_BG_TMPDIR = art;
    const r = await runScript(TAIL, [id], env, tmp);
    expect(r.code).toBe(0);
    expect(r.out).toContain("fresh line");
  });

  test("raw.out in legacy /tmp only -> fallback finds it", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pibg-tail-"));
    tmpDirs.push(tmp);
    const art = path.join(tmp, "art");
    fs.mkdirSync(art, { recursive: true });
    const id = TID(32);
    const legacy = `/tmp/pi-bg-${id}-raw.out`;
    fs.writeFileSync(legacy, "legacy line\n");
    try {
      const env = { ...process.env } as Record<string, string>;
      env.HOME = tmp;
      env.PI_BG_TMPDIR = art;
      const r = await runScript(TAIL, [id], env, tmp);
      expect(r.code).toBe(0);
      expect(r.out).toContain("legacy line");
    } finally {
      fs.rmSync(legacy, { force: true });
    }
  });

  test("no raw.out anywhere -> exit 2", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pibg-tail-"));
    tmpDirs.push(tmp);
    const env = { ...process.env } as Record<string, string>;
    env.HOME = tmp;
    env.PI_BG_TMPDIR = path.join(tmp, "art");
    const r = await runScript(TAIL, [TID(33)], env, tmp);
    expect(r.code).toBe(2);
    expect(r.err).toContain("no live output");
  });
});

describe("#52: watchdog STALLED classification (live + stale heartbeat)", () => {
  const capturePosts = () => {
    const posts: any[] = [];
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: async (req) => {
        if (req.method === "POST") posts.push((await req.json()) as any);
        return new Response("ok", { status: 200 });
      },
    });
    return {
      url: `http://127.0.0.1:${server.port}/hook`,
      posts,
      close: () => server.stop(true),
    };
  };

  // fake liveness: put this test process into the ticket's (fake) cgroup
  const makeLive = (fx: ReturnType<typeof wdFixtureX>, t: string) => {
    const cg = path.join(fx.tmp, "cg", "pi-bg", t);
    fs.mkdirSync(cg, { recursive: true });
    fs.writeFileSync(path.join(cg, "cgroup.procs"), `${process.pid}\n`);
  };

  const plantHb = (
    fx: ReturnType<typeof wdFixtureX>,
    t: string,
    minsAgo: number,
  ) => {
    const hb = path.join(fx.art, `pi-bg-${t}-hb`);
    fs.writeFileSync(hb, "");
    const old = new Date(Date.now() - minsAgo * 60 * 1000);
    fs.utimesSync(hb, old, old);
  };

  test("live + stale hb: STALLED line + embed post, deduped on the next sweep", async () => {
    const fx = wdFixtureX(10);
    const t = TID(10);
    makeLive(fx, t);
    plantHb(fx, t, 11); // past the default 10-min threshold
    const hook = capturePosts();
    try {
      const r1 = await fx.run([], { PI_DISPATCH_WEBHOOK: hook.url });
      expect(r1.code).toBe(0);
      expect(r1.out).toContain(`STALLED jarate/${t}`);
      expect(r1.out).not.toContain(`DEAD jarate/${t}`);
      expect(hook.posts.length).toBe(1);
      const em = hook.posts[0].embeds[0];
      // title is width-bounded (40): the full ticket lives in the
      // description, not the title (PR #64 review P3)
      expect(em.title).toBe("1 stalled \u00b7 watchdog sweep");
      expect(em.title).not.toContain("dead");
      expect(em.description).toContain(`jarate/${t}`);
      expect(em.color).toBe(15158332);
      // the ticket is NOT marked dead: no cgroup reap, no deadlog DEAD entry
      expect(fs.existsSync(path.join(fx.tmp, "cg", "pi-bg", t))).toBe(true);
      // second sweep: same ticket already in today's dead log -> no re-post
      const r2 = await fx.run([], { PI_DISPATCH_WEBHOOK: hook.url });
      expect(r2.out).not.toContain(`STALLED jarate/${t}`);
      expect(hook.posts.length).toBe(1);
    } finally {
      hook.close();
      fs.rmSync(path.join(fx.tmp, "home", ".pi-bg-deadlog"), { force: true });
    }
  }, 60_000);

  test("live + fresh hb: healthy run stays silent", async () => {
    const fx = wdFixtureX(11);
    const t = TID(11);
    makeLive(fx, t);
    plantHb(fx, t, 0);
    const hook = capturePosts();
    try {
      const r = await fx.run([], { PI_DISPATCH_WEBHOOK: hook.url });
      expect(r.code).toBe(0);
      expect(r.out).not.toContain("STALLED");
      expect(hook.posts.length).toBe(0);
    } finally {
      hook.close();
    }
  }, 60_000);

  test("live + no hb file (pre-upgrade run): no behavior change, silent", async () => {
    const fx = wdFixtureX(12);
    const t = TID(12);
    makeLive(fx, t);
    const hook = capturePosts();
    try {
      const r = await fx.run([], { PI_DISPATCH_WEBHOOK: hook.url });
      expect(r.code).toBe(0);
      expect(r.out).not.toContain("STALLED");
      expect(hook.posts.length).toBe(0);
    } finally {
      hook.close();
    }
  }, 60_000);

  test("dead ticket with stale hb: DEAD wins (process gone, not stalled)", async () => {
    const fx = wdFixtureX(13);
    const t = TID(13);
    plantHb(fx, t, 11);
    const hook = capturePosts();
    try {
      const r = await fx.run([], { PI_DISPATCH_WEBHOOK: hook.url });
      expect(r.code).toBe(0);
      expect(r.out).toContain(`DEAD jarate/${t}`);
      expect(r.out).not.toContain("STALLED");
      expect(hook.posts[0].embeds[0].title).toContain("DEAD");
    } finally {
      hook.close();
    }
  }, 60_000);

  test("PI_BG_STALL_MIN override: 11-min-old hb is fresh at 20 min", async () => {
    const fx = wdFixtureX(14);
    const t = TID(14);
    makeLive(fx, t);
    plantHb(fx, t, 11);
    const hook = capturePosts();
    try {
      const r = await fx.run([], {
        PI_DISPATCH_WEBHOOK: hook.url,
        PI_BG_STALL_MIN: "20",
      });
      expect(r.code).toBe(0);
      expect(r.out).not.toContain("STALLED");
      expect(hook.posts.length).toBe(0);
    } finally {
      hook.close();
    }
  }, 60_000);
});
