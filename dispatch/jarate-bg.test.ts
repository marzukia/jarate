/**
 * dispatch/jarate-bg — fresh-machine doctor tests (issues #29, #30).
 *
 * Runs the real bash script against a fake HOME + a fake `pi` on PATH and
 * asserts on loud failure / warning text and the run record.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "bun";
import { isBgWebhook } from "../packages/bridge/channel/discord";

const PI_BG = path.join(import.meta.dir, "jarate-bg");

// Leak guard (issue: /tmp inode exhaustion, 2026-09-14): every fixture
// mkdtemp dir is tracked and force-removed in a file-level afterEach, so a
// failed or aborted test can no longer leave pibg-* dirs behind in /tmp.
const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

type RunResult = { code: number; out: string; err: string };

function fixture() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pibg-test-"));
  tmpDirs.push(tmp);
  const home = path.join(tmp, "home");
  const bin = path.join(tmp, "bin");
  const mainAgent = path.join(home, ".pi", "agent");
  fs.mkdirSync(mainAgent, { recursive: true });
  fs.mkdirSync(bin, { recursive: true });

  const piPath = path.join(bin, "pi");
  fs.writeFileSync(
    piPath,
    `#!/bin/sh\necho ran > "${path.join(tmp, "pi-ran")}"\necho pi-run-ok\n`,
  );
  fs.chmodSync(piPath, 0o755);
  // stub webdrop: keep the run offline + deterministic (pi-bg uploads the
  // full prompt/output when webdrop is on PATH)
  const wdPath = path.join(bin, "webdrop");
  fs.writeFileSync(
    wdPath,
    '#!/bin/sh\necho https://drop.test/$(basename "$1")\n',
  );
  fs.chmodSync(wdPath, 0o755);

  const env = { ...process.env } as Record<string, string>;
  env.HOME = home;
  env.PATH = `${bin}:${env.PATH ?? ""}`;
  env.PI_DISPATCH_RECORD_DIR = path.join(tmp, "records");
  delete env.PI_DISPATCH_WEBHOOK;
  delete env.PI_SERVICE;
  // running inside a pi-bg ticket (the #56 tests run there all the time
  // when a worker dispatches the suite) leaks PI_BG_SETSID=1 and would
  // skip the setsid re-exec under test - hermeticize. The snapshot re-exec
  // (deploy-swap guard) additionally exports PI_BG_SNAP=1 + PI_BG_RUN_ID,
  // which leak the same way and make children look like snapshot runs.
  delete env.PI_BG_SETSID;
  delete env.PI_BG_TMPDIR; // default-path tests must not inherit an override
  delete env.PI_BG_HB_INTERVAL; // cap window must stay at the 30s default
  delete env.PI_BG_RUN_ID;
  delete env.PI_BG_SNAP;
  // #52 hb-from-birth adoption: a suite running inside a pi-bg ticket
  // leaks PI_BG_HB_PID (the parent's hb child). Left in, a spawned test
  // wrapper would ADOPT that child (kill -0 succeeds) instead of forking
  // its own, and kill the parent's hb child on exit - a false STALLED on
  // the outer ticket. Hermeticize like the other PI_BG_* leaks.
  delete env.PI_BG_HB_PID;
  // issue #118 vars: a suite running inside a pi-bg ticket inherits the
  // parent's PI_BG_TASK_FILE (its prompt file) + SNAP_DIR; left in, a
  // spawned test wrapper under the snapshot branch would re-read the
  // PARENT's task. Hermeticize like the other PI_BG_* leaks.
  delete env.PI_BG_TASK_FILE;
  delete env.SNAP_DIR;
  // launcher's cwd (issue #66) is the same leak class: when the suite runs
  // inside a pi-bg ticket, PI_BG_LANCHED_CWD points at the launcher's dir
  // and pi-bg cd's back to it. Left in, a "non-git cwd" launch-fail test
  // lands in a git repo and worktree tests hit the wrong repo.
  delete env.PI_BG_LANCHED_CWD;
  // session-prune vars (2026-09-23) must not leak from the ambient env
  delete env.PI_BG_PRUNE_AGE_H;
  delete env.PI_BG_KEEP_SESSION;
  delete env.PI_BG_PRUNE_SESSIONS;
  delete env.PI_BG_RUN_START_EPOCH;
  // cap off by default: ambient fleet traffic (real pi-bg runs of this
  // user) must not make non-#41 tests hit "at cap"; #41 tests set
  // PI_BG_MAX_CONCURRENT explicitly per spawn.
  env.PI_BG_MAX_CONCURRENT = "0";
  // issue #144 foreground-launch guard: the suite launches pi-bg ATTACHED
  // (ambient SIGHUP disposition, not nohup's SIG_IGN). The internal
  // caller bypass keeps every existing test on the nohup-path behavior;
  // the #144 guard tests build their own env without it.
  env.PI_BG_ALLOW_FOREGROUND = "1";
  // issue #145: daemonize is off for the whole suite too - the tests
  // await the launcher's exit and assert on its inline output, so they
  // pin the legacy inline topology (the #145 describe builds its own
  // env with daemonize on).
  env.PI_BG_DAEMONIZE = "0";
  // cgroup escape into a per-run temp dir, not the REAL user cgroup root
  // (issue: pi-bg cgroup-dir leak, 2026-09-14): every fixture spawn escaped
  // into /sys/fs/cgroup/.../user@N.service/pi-bg/, and an interrupted bun
  // run (SIGKILL, timeout, pi.service restart) left one empty ticket dir
  // per spawn - 33k of them in 2 days on Monky's box, periodically tripping
  // the concurrency cap. Pointing ALL spawns at this tmp dir bounds any
  // leak to the fixture dir. The "cgroup escape" test below still sets its
  // own PI_BG_CG_ROOT to inspect the escape mid-run.
  env.PI_BG_CG_ROOT = path.join(tmp, "cg");

  const seedMainCreds = () => {
    fs.writeFileSync(
      path.join(mainAgent, "auth.json"),
      JSON.stringify({ vllm: { type: "api_key", key: "sk-test" } }),
    );
    fs.writeFileSync(
      path.join(mainAgent, "models.json"),
      JSON.stringify({ vllm: { models: [{ id: "qwen-test" }] } }),
    );
    fs.writeFileSync(
      path.join(mainAgent, "settings.json"),
      JSON.stringify({
        defaultProvider: "vllm",
        defaultModel: "qwen-test",
      }),
    );
  };

  const run = async (args: string[]): Promise<RunResult> => {
    const p = spawn(["bash", PI_BG, ...args], {
      env,
      cwd: tmp,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, err] = await Promise.all([
      new Response(p.stdout).text(),
      new Response(p.stderr).text(),
    ]);
    const code = await p.exited;
    return { code, out, err };
  };

  // issue #118 stdin-launch helper: writes `stdin` to the wrapper's stdin
  // (and closes it unless keepOpen), for the `pi-bg worker -` form.
  const runStdin = async (
    args: string[],
    stdin?: string,
    keepOpen = false,
  ): Promise<RunResult> => {
    const p = spawn(["bash", PI_BG, ...args], {
      env,
      cwd: tmp,
      stdout: "pipe",
      stderr: "pipe",
      stdin: "pipe",
    });
    if (stdin !== undefined) p.stdin?.write(stdin);
    if (!keepOpen) p.stdin?.end();
    const [out, err] = await Promise.all([
      new Response(p.stdout).text(),
      new Response(p.stderr).text(),
    ]);
    const code = await p.exited;
    return { code, out, err };
  };

  const records = () =>
    fs
      .readdirSync(env.PI_DISPATCH_RECORD_DIR)
      .filter((f) => f.endsWith(".json"))
      .map((f) =>
        JSON.parse(
          fs.readFileSync(path.join(env.PI_DISPATCH_RECORD_DIR, f), "utf-8"),
        ),
      );

  return { tmp, home, mainAgent, env, run, runStdin, seedMainCreds, records };
}

/**
 * Mirror of the script's cap count (issue #123): fresh heartbeat files in
 * the fixture's artifact dir. The script counts pi-bg-<run_id>-hb files
 * under its artifact dir (default $HOME/.pi-bg-art; the fixture deletes
 * PI_BG_TMPDIR, so <fx>/home/.pi-bg-art) touched within 3 x
 * PI_BG_HB_INTERVAL - one live ticket = exactly one fresh file, whatever
 * processes it spawned. A missing dir (pre-ticket-creation) counts 0,
 * the same fail-open as the script's find.
 */
const countFreshHb = (fx: { tmp: string }, intervalSec = 30): number => {
  const art = path.join(fx.tmp, "home", ".pi-bg-art");
  let entries: string[];
  try {
    entries = fs.readdirSync(art);
  } catch {
    return 0;
  }
  const cutoff = Date.now() - intervalSec * 3 * 1000;
  let n = 0;
  for (const e of entries) {
    if (!/^pi-bg-.+-hb$/.test(e)) continue;
    try {
      if (fs.statSync(path.join(art, e)).mtimeMs >= cutoff) n++;
    } catch {
      /* raced the unlink at exit - gone */
    }
  }
  return n;
};

describe("#29: missing role profile is seeded, then fail loud if no provider", () => {
  test("auto-seeds a missing profile from main agent creds + repo template", async () => {
    const fx = fixture();
    fx.seedMainCreds(); // main agent has creds; no agent-worker at all
    const r = await fx.run(["worker", "test task"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("pi-run-ok");
    const prof = path.join(fx.home, ".pi", "agent-worker");
    expect(fs.existsSync(path.join(prof, "auth.json"))).toBe(true);
    expect(fs.existsSync(path.join(prof, "models.json"))).toBe(true);
    const settings = JSON.parse(
      fs.readFileSync(path.join(prof, "settings.json"), "utf-8"),
    );
    expect(settings.defaultProvider).toBe("vllm"); // from main settings
    expect(settings.defaultThinkingLevel).toBe("medium"); // from repo template
  });

  test("reviewer template carries xhigh thinking", async () => {
    const fx = fixture();
    fx.seedMainCreds();
    const r = await fx.run(["reviewer", "test task"]);
    expect(r.code).toBe(0);
    const settings = JSON.parse(
      fs.readFileSync(
        path.join(fx.home, ".pi", "agent-reviewer", "settings.json"),
        "utf-8",
      ),
    );
    expect(settings.defaultThinkingLevel).toBe("xhigh");
  });

  test("fails loud (exit 4) when no provider creds resolve anywhere; pi never runs", async () => {
    const fx = fixture();
    // profile dir exists but is empty of creds; main agent has none either
    const prof = path.join(fx.home, ".pi", "agent-worker");
    fs.mkdirSync(prof, { recursive: true });
    fs.writeFileSync(path.join(prof, "auth.json"), "{}");
    const r = await fx.run(["worker", "test task"]);
    expect(r.code).toBe(4);
    expect(r.err).toContain("profile 'worker' has no provider");
    expect(r.err).toContain("auth.json");
    expect(fs.existsSync(path.join(fx.tmp, "pi-ran"))).toBe(false);
  });

  test("both auth.json={} and models.json={} present: seeded from main agent, run succeeds", async () => {
    const fx = fixture();
    fx.seedMainCreds();
    const prof = path.join(fx.home, ".pi", "agent-worker");
    fs.mkdirSync(prof, { recursive: true });
    fs.writeFileSync(path.join(prof, "auth.json"), "{}");
    fs.writeFileSync(path.join(prof, "models.json"), "{}");
    const r = await fx.run(["worker", "test task"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("pi-run-ok");
    const auth = JSON.parse(
      fs.readFileSync(path.join(prof, "auth.json"), "utf-8"),
    );
    expect(auth.vllm.key).toBe("sk-test"); // main creds landed
    const models = JSON.parse(
      fs.readFileSync(path.join(prof, "models.json"), "utf-8"),
    );
    expect(models.vllm.models[0].id).toBe("qwen-test"); // main models landed
  });

  test("seeding is idempotent: a customized profile survives a second seed", async () => {
    const fx = fixture();
    fx.seedMainCreds();
    const prof = path.join(fx.home, ".pi", "agent-worker");
    // first dispatch: seeds the profile
    const r1 = await fx.run(["worker", "first task"]);
    expect(r1.code).toBe(0);
    // operator customizes between runs
    const authPath = path.join(prof, "auth.json");
    const auth = JSON.parse(fs.readFileSync(authPath, "utf-8"));
    auth.custom = { type: "api_key", key: "sk-custom" };
    fs.writeFileSync(authPath, JSON.stringify(auth));
    const settingsPath = path.join(prof, "settings.json");
    const settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
    settings.defaultModel = "custom-model";
    fs.writeFileSync(settingsPath, JSON.stringify(settings));
    // second dispatch: profile already seeded -> nothing re-copied
    const r2 = await fx.run(["worker", "second task"]);
    expect(r2.code).toBe(0);
    const auth2 = JSON.parse(fs.readFileSync(authPath, "utf-8"));
    expect(auth2.custom.key).toBe("sk-custom"); // customization survives
    const settings2 = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
    expect(settings2.defaultModel).toBe("custom-model"); // customization survives
  });
});

describe("#37: JB_ROOT resolves symlinks (normal launch is ~/scripts/jarate-bg)", () => {
  test("jarate-bg launched via a symlink still seeds settings.json from the repo template", async () => {
    const fx = fixture();
    fx.seedMainCreds();
    // mimic install.sh: a bin dir under the fake HOME holding a symlink
    // to the real script. BASH_SOURCE is the link path, so without
    // readlink -f, JB_ROOT would be the fake HOME and the template lookup
    // would silently miss.
    const linkDir = path.join(fx.home, "scripts");
    fs.mkdirSync(linkDir, { recursive: true });
    const link = path.join(linkDir, "jarate-bg");
    fs.symlinkSync(PI_BG, link);
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    const r = await runScript(
      link,
      ["worker", "symlink launch task"],
      fx.env,
      fx.tmp,
    );
    expect(r.code).toBe(0);
    expect(r.out).toContain("pi-run-ok");
    const prof = path.join(fx.home, ".pi", "agent-worker");
    // the seed lookup must have found the template through the real path
    expect(fs.existsSync(path.join(prof, "settings.json"))).toBe(true);
    const settings = JSON.parse(
      fs.readFileSync(path.join(prof, "settings.json"), "utf-8"),
    );
    expect(settings.defaultThinkingLevel).toBe("medium"); // repo template
    expect(settings.defaultProvider).toBe("vllm"); // merged from main settings
    expect(settings.defaultModel).toBe("qwen-test"); // merged from main settings
  });
});

describe("cgroup escape: self-drain + rmdir on exit; PI_BG_TMPDIR plumbing", () => {
  test("wrapper escapes into the test cgroup, drains itself, reaps the dir, writes artifacts to PI_BG_TMPDIR", async () => {
    const fx = fixture();
    fx.seedMainCreds();
    const cgParent = path.join(fx.tmp, "cg", "user@1.service");
    fs.mkdirSync(cgParent, { recursive: true });
    fs.writeFileSync(path.join(cgParent, "cgroup.procs"), "");
    const tmpdir = path.join(fx.tmp, "artifacts");
    fx.env.PI_BG_CG_ROOT = cgParent;
    fx.env.PI_BG_TMPDIR = tmpdir;

    // pi sleeps so the escape cgroup can be inspected mid-run (write before
    // spawn: pi-bg launches it a couple of ms in)
    const piBin = path.join(fx.tmp, "bin", "pi");
    fs.writeFileSync(piBin, "#!/bin/sh\nsleep 3\necho pi-run-ok\n");
    const p = spawn(["bash", PI_BG, "worker", "cgroup drain task"], {
      env: fx.env,
      cwd: fx.tmp,
      stdout: "pipe",
      stderr: "pipe",
    });
    let sawEscapePid = false;
    let runId = "";
    const t0 = Date.now();
    while (Date.now() - t0 < 8000) {
      await Bun.sleep(100);
      const escDir = path.join(cgParent, "pi-bg");
      if (!fs.existsSync(escDir)) continue;
      const ids = fs.readdirSync(escDir);
      for (const id of ids) {
        const f = path.join(escDir, id, "cgroup.procs");
        // #52 hb-from-birth: the file holds the wrapper AND the hb child
        // (the join appends on the fake root) - "contains", not "equals"
        const content = fs
          .readFileSync(f, "utf8")
          .split("\n")
          .map((l) => l.trim())
          .filter(Boolean);
        if (content.includes(String(p.pid))) {
          runId = id;
          sawEscapePid = true;
          break;
        }
      }
      if (sawEscapePid) break;
    }
    const [out, err] = await Promise.all([
      new Response(p.stdout).text(),
      new Response(p.stderr).text(),
    ]);
    const code = await p.exited;
    if (code !== 0) {
      throw new Error(`pi-bg exited ${code}\nOUT: ${out}\nERR: ${err}`);
    }
    expect(code).toBe(0);
    expect(out).toContain("cgroup escape active");

    // the wrapper's pid was moved into the escape cgroup at dispatch
    expect(sawEscapePid).toBe(true);

    // on exit the wrapper moved itself out of the ticket cgroup (drain);
    // the drain target is the pi-bg level (a plain file on a fake root),
    // not cgParent itself (the slice root is EBUSY for that write on real
    // cgroupfs - see the drain comment in pi-bg)
    const parentProcs = fs
      .readFileSync(path.join(cgParent, "pi-bg", "cgroup.procs"), "utf8")
      .split("\n");
    expect(parentProcs.filter((l) => l.trim() === String(p.pid))).toHaveLength(
      1,
    );

    // and the (now empty) ticket cgroup dir was reaped - no leak
    expect(fs.existsSync(path.join(cgParent, "pi-bg", runId))).toBe(false);

    // PI_BG_TMPDIR is honored: per-run artifacts live there (issue #F4)
    const files = fs.readdirSync(tmpdir);
    expect(files).toContain(`pi-bg-${runId}-out.md`);
    expect(files).toContain(`pi-bg-${runId}-raw.out`);
  }, 30_000);
});

describe("cgroup-dir leak (2026-09-14): fixture spawns stay out of the real cgroup root", () => {
  // The real root this uid would escape into without the PI_BG_CG_ROOT
  // override. The regression: before the fix, EVERY fixture spawn created a
  // ticket dir here, and an interrupted run (bun SIGKILL/timeout, pi.service
  // restart) left the empty dir behind - 33k dirs in 2 days on Monky's box.
  const realCgRoot = `/sys/fs/cgroup/user.slice/user-${process.getuid()}.slice/user@${process.getuid()}.service/pi-bg`;

  test("fixture root is a per-run tmp dir; the ticket dir never lands in the real root", async () => {
    const fx = fixture();
    fx.seedMainCreds();
    // the override points inside this fixture's tmp dir (all spawns use it)
    expect(fx.env.PI_BG_CG_ROOT).toContain(fx.tmp);
    const r = await fx.run(["worker", "cgroup leak regression task"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("cgroup escape active"); // escape ran, in the fake root
    const runId = fx.records()[0].run;
    // the ticket dir lived under the fixture root and was reaped on exit
    expect(fs.existsSync(path.join(fx.env.PI_BG_CG_ROOT, "pi-bg", runId))).toBe(
      false,
    );
    // ...and NOT under the real user cgroup root
    expect(fs.existsSync(path.join(realCgRoot, runId))).toBe(false);
  });
});

/**
 * audit dispatch-core P11: the cgroup-escape DEFAULT path (no PI_BG_CG_ROOT
 * override) is unpinned - every fixture spawn overrides it, so the default
 * parent computation (line: CG_PARENT="/sys/fs/cgroup/user.slice/user-$(id
 * -u).slice/user@$(id -u).service") only runs in production. This test runs
 * one real spawn WITHOUT the override and pins the default: the escape
 * stderr names the real user cgroup root, the ticket dir is created there
 * mid-run, and drained + reaped on exit (no leak).
 */
const uid = process.getuid();
const realUserSvc = `/sys/fs/cgroup/user.slice/user-${uid}.slice/user@${uid}.service`;
// Requires the test process itself to run inside the real user-session
// cgroup: cgroup v2 only allows joining descendants of one's own subtree.
// The GH runner has a user@uid.service, but job steps run under
// system.slice — the escape into user@uid.service is unobservable there,
// so skip rather than fail. (Same env-gate class as root-only concurrency
// test #41.) The fake-root suites already pin the escape mechanism itself.
const inRealUserSvc =
  fs
    .readFileSync("/proc/self/cgroup", "utf8")
    .split("\n")
    .find((l) => l.startsWith("0::/"))
    ?.startsWith(`0::/user.slice/user-${uid}.slice/user@${uid}.service`) ??
  false;
const describeDefaultCg = inRealUserSvc ? describe : describe.skip;

describeDefaultCg(
  "cgroup escape default path (no PI_BG_CG_ROOT): real user cgroup root",
  () => {
    const realTicketRoot = `${realUserSvc}/pi-bg`;

    test("default escape: stderr names the real root, ticket dir created mid-run + reaped on exit", async () => {
      const fx = fixture();
      fx.seedMainCreds();
      delete fx.env.PI_BG_CG_ROOT;
      expect(inRealUserSvc).toBe(true); // we are inside the user session
      // sleep long enough to observe the ticket cgroup dir mid-run
      fs.writeFileSync(
        path.join(fx.tmp, "bin", "pi"),
        "#!/bin/sh\nsleep 5\necho pi-run-ok\n",
      );
      let runId = "";
      const p = spawn(["bash", PI_BG, "worker", "default cg path task"], {
        env: fx.env,
        cwd: fx.tmp,
        stdout: "pipe",
        stderr: "pipe",
      });
      try {
        const recDir = fx.env.PI_DISPATCH_RECORD_DIR as string;
        const t0 = Date.now();
        while (!runId && Date.now() - t0 < 15000) {
          try {
            const c = fs.readdirSync(recDir).filter((f) => f.endsWith(".json"));
            if (c.length === 1)
              runId = JSON.parse(
                fs.readFileSync(path.join(recDir, c[0]), "utf8"),
              ).run;
          } catch {
            /* the record dir is created by pi-bg after spawn */
          }
          if (!runId) await Bun.sleep(100);
        }
        expect(runId).toMatch(/^\d{8}-\d{6}-\d+$/);
        const ticketCg = `${realTicketRoot}/${runId}`;
        // the ticket cgroup must exist on the REAL root mid-run
        const t1 = Date.now();
        while (!fs.existsSync(ticketCg) && Date.now() - t1 < 10000) {
          await Bun.sleep(100);
        }
        expect(fs.existsSync(ticketCg)).toBe(true);
        const [out] = await Promise.all([
          new Response(p.stdout).text(),
          new Response(p.stderr).text(),
        ]);
        const code = await p.exited;
        expect(code).toBe(0);
        // the default parent is the real user service cgroup (the banner
        // prints on stdout; the webhook warnings are the stderr class)
        expect(out).toContain(`[pi-bg] cgroup escape active: ${ticketCg}`);
        // drained + reaped on exit: no leak on the real root
        expect(fs.existsSync(ticketCg)).toBe(false);
      } finally {
        // an interrupted run (bun timeout/SIGKILL) would leave the dir
        if (runId) {
          fs.rmSync(`${realTicketRoot}/${runId}`, {
            recursive: true,
            force: true,
          });
        }
      }
    }, 40_000);
  },
);

describe("#30: no webhook => loud warning at dispatch + run record delivery=none", () => {
  test("missing webhook: stderr warning + record marked delivery=none", async () => {
    const fx = fixture();
    fx.seedMainCreds();
    const r = await fx.run(["worker", "test task"]);
    expect(r.code).toBe(0);
    expect(r.err).toContain("no completion callback; poll with jarate-wait");
    expect(r.err).toContain(".config/pi-dispatch/webhook");
    const recs = fx.records();
    expect(recs.length).toBe(1);
    expect(recs[0].delivery).toBe("none");
    expect(recs[0].profile).toBe("worker");
  });

  test("webhook file present: no warning, record marked delivery=webhook", async () => {
    const fx = fixture();
    fx.seedMainCreds();
    const cfg = path.join(fx.home, ".config", "pi-dispatch");
    fs.mkdirSync(cfg, { recursive: true });
    // closed port: the final callback post fails fast (connection refused)
    fs.writeFileSync(path.join(cfg, "webhook"), "http://127.0.0.1:9/hook\n");
    const r = await fx.run(["worker", "test task"]);
    expect(r.code).toBe(0);
    expect(r.err).not.toContain("no completion callback");
    const recs = fx.records();
    expect(recs.length).toBe(1);
    expect(recs[0].delivery).toBe("webhook");
  }, 30_000);

  // audit dispatch-core P13: webhook URL precedence when BOTH the env var
  // and the file are set. jarate-bg line 778: PI_DISPATCH_WEBHOOK first,
  // the file only fills an EMPTY env. The test parks the FILE on a dead
  // port: if the file ever won, the terminal callback would die there.
  test("both set: env PI_DISPATCH_WEBHOOK wins over the file", async () => {
    const fx = fixture();
    fx.seedMainCreds();
    const posts: any[] = [];
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: async (req) => {
        if (req.method === "POST") posts.push((await req.json()) as any);
        return new Response("ok", { status: 200 });
      },
    });
    try {
      const cfg = path.join(fx.home, ".config", "pi-dispatch");
      fs.mkdirSync(cfg, { recursive: true });
      // dead port: if the file URL ever won, the terminal post dies here
      fs.writeFileSync(path.join(cfg, "webhook"), "http://127.0.0.1:9/dead\n");
      fx.env.PI_DISPATCH_WEBHOOK = `http://127.0.0.1:${server.port}/hook`;
      const r = await fx.run(["worker", "precedence task"]);
      expect(r.code).toBe(0);
      expect(r.err).not.toContain("no completion callback");
      expect(fx.records()[0].delivery).toBe("webhook");
      // env won: the terminal callback landed on the live server
      expect(posts).toHaveLength(1);
      const e = posts[0].embeds[0];
      expect(e.title).toMatch(/^worker \u00b7 OK \u00b7 /);
      const task = (e.fields ?? []).find((f: any) => f.name === "task");
      expect(task?.value).toContain("precedence task");
      // the dead file URL was never hit: no dead letter in the artifact dir
      const art = path.join(fx.home, ".pi-bg-art");
      const deadLetters = fs.existsSync(art)
        ? fs.readdirSync(art).filter((f) => f.includes("webhook-failed"))
        : [];
      expect(deadLetters).toHaveLength(0);
    } finally {
      server.stop(true);
    }
  }, 30_000);
});

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

describe("persistent artifact dir: ~/.pi-bg-art default (2026-09-13 reboot fix)", () => {
  test("default BG_TMP is $HOME/.pi-bg-art (not /tmp); dir auto-created", async () => {
    const fx = fixture();
    fx.seedMainCreds();
    const art = path.join(fx.home, ".pi-bg-art");
    expect(fs.existsSync(art)).toBe(false); // not pre-created
    const r = await fx.run(["worker", "tmpdir default task"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("pi-run-ok");
    expect(fs.existsSync(art)).toBe(true); // pi-bg created it
    const outFiles = fs.readdirSync(art).filter((f) => f.endsWith("-out.md"));
    expect(outFiles).toHaveLength(1);
    const id = outFiles[0].replace(/^pi-bg-/, "").replace(/-out\.md$/, "");
    expect(id).toMatch(/^\d{8}-\d{6}-\d+$/);
    // kept artifacts: the output report + the tail spool (the watchdog,
    // /jobs and pi-bg-tail read them after the run)
    for (const name of [`pi-bg-${id}-out.md`, `pi-bg-${id}-raw.out`]) {
      expect(fs.existsSync(path.join(art, name))).toBe(true);
    }
    // temp scratch is unlinked on exit (issue: /tmp inode leak, 2026-09-14)
    for (const name of [
      `pi-bg-${id}-prompt.md`,
      `pi-bg-${id}-err.log`,
      `pi-bg-${id}-body.json`,
      `pi-bg-${id}-wb-resp.txt`,
      `pi-bg-${id}-started`,
    ]) {
      expect(fs.existsSync(path.join(art, name))).toBe(false);
    }
    // ...and nothing in /tmp
    expect(fs.existsSync(`/tmp/pi-bg-${id}-out.md`)).toBe(false);
    expect(fs.existsSync(`/tmp/pi-bg-${id}-prompt.md`)).toBe(false);
  });
});

const WD = path.join(import.meta.dir, "jarate-bg-watchdog");

const KILL = path.join(import.meta.dir, "jarate-bg-kill");

// fake ids in year 2099: never collide with real tickets in /tmp
const TID = (n: number) => `20991231-235959-${n}`;

/** True when any live process's cmdline contains needle (orphan probe). */
function liveProcWith(needle: string): boolean {
  for (const d of fs.readdirSync("/proc").filter((x) => /^\d+$/.test(x))) {
    try {
      if (fs.readFileSync(`/proc/${d}/cmdline`, "utf8").includes(needle))
        return true;
    } catch {
      /* vanished */
    }
  }
  return false;
}

/**
 * Watchdog fixture for the STALLED / run-state-prune tests (issues #51, #52):
 * same shape as the rule-3 wdFixture below + an env-overrides map for run()
 * (webhook capture, PI_DISPATCH_RECORD_DIR, PI_BG_STALL_MIN, ...).
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
  // same hermeticity as fixture() above: a ticket run leaks SNAP + RUN_ID
  delete env.PI_BG_RUN_ID;
  delete env.PI_BG_SNAP;
  const run = (
    args: string[] = ["--dry-run"],
    overrides?: Record<string, string>,
  ) => runScript(WD, args, { ...env, ...overrides }, tmp);
  return { tmp, art, run };
}

describe("watchdog rule 3: dual lookup (persistent dir + legacy /tmp)", () => {
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
    const run = (args: string[] = ["--dry-run"]) =>
      runScript(WD, args, env, tmp);
    return { tmp, art, legacy, rmLegacy, run };
  }

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

const TAIL = path.join(import.meta.dir, "jarate-bg-tail");

describe("pi-bg-tail: artifact lookup (persistent dir + legacy /tmp)", () => {
  test("raw.out in PI_BG_TMPDIR -> shown", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pibg-tail-"));
    tmpDirs.push(tmp);
    const art = path.join(tmp, "art");
    fs.mkdirSync(art, { recursive: true });
    const id = "20991231-235958-1";
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
    const id = "20991231-235958-2";
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
    const r = await runScript(TAIL, ["20991231-235958-3"], env, tmp);
    expect(r.code).toBe(2);
    expect(r.err).toContain("no live output");
  });
});

describe("v3 embed style (mockup3): webhook payload shape", () => {
  const capture = () => {
    let body: { embeds: any[] } | null = null;
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: async (req) => {
        if (req.method === "POST") body = (await req.json()) as any;
        return new Response("ok", { status: 200 });
      },
    });
    return {
      url: `http://127.0.0.1:${server.port}/hook`,
      getBody: () => body,
      close: () => server.stop(true),
    };
  };

  const assertFrame = (em: any, header: string) => {
    // v3 charset: no dingbats, no arrows, no em dash
    for (const ch of ["✓", "✗", "⚠", "⛔", "▤", "→", "—"]) {
      expect(em.title + em.description).not.toContain(ch);
    }
    const lines = em.description.split("\n");
    expect(lines[0]).toBe("```bash");
    expect(lines[1]).toBe(header);
    expect(lines.at(-2)).toBe("└");
    expect(lines.at(-1)).toBe("```");
    for (const l of lines) expect(l.length).toBeLessThanOrEqual(40);
  };

  test("worker OK + --worktree: framed description, 40-col budget", async () => {
    const fx = fixture();
    fx.seedMainCreds();
    const hook = capture();
    fx.env.PI_DISPATCH_WEBHOOK = hook.url;
    fx.env.PI_BG_WB_BACKOFF = "0";
    // git repo in the run cwd so --worktree works
    const sh = (cmd: string) =>
      execSync(cmd, { cwd: fx.tmp, env: { ...fx.env }, stdio: "pipe" });
    sh("git init -b main");
    sh("git config user.email t@t");
    sh("git config user.name t");
    fs.writeFileSync(path.join(fx.tmp, "a.txt"), "a\n");
    sh("git add a.txt");
    sh("git commit -m init");
    try {
      const r = await fx.run(["worker", "--worktree", "v3 style check"]);
      expect(r.code).toBe(0);
      const runId = fx.records()[0].run;
      const cap = hook.getBody();
      if (!cap) throw new Error("webhook not captured");
      const em = cap.embeds[0];
      expect(em.title).toMatch(/^worker · OK · \d+m\d{2}s$/);
      assertFrame(em, `┌ ok · ${runId}`);
      expect(em.description).toContain("├ $ jarate-bg worker --worktree");
      // branch = "pi-bg/<rid>" is 25 cols; at the 40-col budget the kv
      // vbudget (29) fits it whole - no clip
      expect(em.description).toContain(`├ branch : pi-bg/${runId}`);
      expect(em.description).toContain("├ wt     : ");
      // fields intact: task + result + webdrop links (stubbed on PATH)
      const names = em.fields.map((f: { name: string }) => f.name);
      expect(names).toEqual(
        expect.arrayContaining(["task", "result", "prompt", "full output"]),
      );
      expect(
        em.fields.find((f: { name: string }) => f.name === "task").value,
      ).toContain("v3 style check");
      expect(
        em.fields.find((f: { name: string }) => f.name === "result").value,
      ).toContain("pi-run-ok");
    } finally {
      delete fx.env.PI_DISPATCH_WEBHOOK;
      delete fx.env.PI_BG_WB_BACKOFF;
      hook.close();
    }
  });

  test("worker FAIL: rc in title + frame header, 40-col budget", async () => {
    const fx = fixture();
    fx.seedMainCreds();
    fs.writeFileSync(
      path.join(fx.tmp, "bin", "pi"),
      "#!/bin/sh\necho boom\nexit 3\n",
    );
    const hook = capture();
    fx.env.PI_DISPATCH_WEBHOOK = hook.url;
    fx.env.PI_BG_WB_BACKOFF = "0";
    try {
      const r = await fx.run(["worker", "failing task"]);
      expect(r.code).toBe(3); // pi-bg propagates pi's rc; status is in the embed
      const runId = fx.records()[0].run;
      const cap = hook.getBody();
      if (!cap) throw new Error("webhook not captured");
      const em = cap.embeds[0];
      expect(em.title).toMatch(/^worker · FAIL \(rc=3\) · \d+m\d{2}s$/);
      // at 40 the rc DOES fit the header (9 + 19 + 7 = 35): it ships
      // in the header AND the title
      assertFrame(em, `┌ fail · ${runId} (rc=3)`);
      expect(em.description).toContain("├ $ jarate-bg worker");
      expect(em.description).toContain("├ cwd    : ");
    } finally {
      delete fx.env.PI_DISPATCH_WEBHOOK;
      delete fx.env.PI_BG_WB_BACKOFF;
      hook.close();
    }
  });
});

describe("#101 follow-up: launch-fail marks the run record killed", () => {
  // --worktree launch-fails (non-git cwd / bad ref) exit BEFORE the cgroup
  // escape -> no ticket cgroup dir for the watchdog's cwd sweep to judge.
  // The record (written state=running at ticket creation, #101) must be
  // marked killed by the launch-fail path itself, else it stays "running"
  // forever (only the 7-day record prune clears it).

  test("non-git cwd: exit 3, record state=killed (not running)", async () => {
    const fx = fixture();
    fx.seedMainCreds();
    // fx.tmp is not a git repo (and nothing above it under /tmp is)
    const r = await fx.run(["worker", "--worktree", "launch fail task"]);
    expect(r.code).toBe(3);
    expect(r.err).toContain("LAUNCH-FAIL: --worktree needs a git repo");
    expect(fs.existsSync(path.join(fx.tmp, "pi-ran"))).toBe(false);
    const recs = fx.records();
    expect(recs).toHaveLength(1);
    expect(recs[0].state).toBe("killed");
    expect(recs[0].reason).toBe("launch-fail: not a git repo");
    expect(recs[0].finished).toBeTruthy();
  });

  test("bad worktree ref: exit 3, record state=killed (not running)", async () => {
    const fx = fixture();
    fx.seedMainCreds();
    // git repo in the run cwd so launch reaches the worktree-add step
    const sh = (cmd: string) =>
      execSync(cmd, { cwd: fx.tmp, env: { ...fx.env }, stdio: "pipe" });
    sh("git init -b main");
    sh("git config user.email t@t");
    sh("git config user.name t");
    fs.writeFileSync(path.join(fx.tmp, "a.txt"), "a\n");
    sh("git add a.txt");
    sh("git commit -m init");
    const r = await fx.run([
      "worker",
      "--worktree",
      "nosuchref",
      "bad ref task",
    ]);
    expect(r.code).toBe(3);
    expect(r.err).toContain("LAUNCH-FAIL: worktree add failed");
    const recs = fx.records();
    expect(recs).toHaveLength(1);
    expect(recs[0].state).toBe("killed");
    expect(recs[0].reason).toContain(
      "launch-fail: worktree add failed ref=nosuchref",
    );
    expect(recs[0].finished).toBeTruthy();
  });
});

/**
 * #110 launcher side: --wt-reuse (the watchdog's DEAD-retry re-dispatch
 * lands in the dead ticket's existing worktree dir, no new dir/branch),
 * the retryOf record tag (PI_BG_RETRY_OF env), and the wt/wtBranch record
 * fields (audit + the retry section's worktree resolution).
 */
describe("#110 launcher: --wt-reuse + retryOf record tag", () => {
  const gitRepo = (fx: { tmp: string; env: Record<string, string> }) => {
    const sh = (cmd: string) =>
      execSync(cmd, { cwd: fx.tmp, env: { ...fx.env }, stdio: "pipe" });
    sh("git init -b main");
    sh("git config user.email t@t");
    sh("git config user.name t");
    fs.writeFileSync(path.join(fx.tmp, "a.txt"), "a\n");
    sh("git add a.txt");
    sh("git commit -m init");
  };

  test("--wt-reuse: run lands in the EXISTING dir, no new worktree added", async () => {
    const fx = fixture();
    fx.seedMainCreds();
    gitRepo(fx);
    const reuse = path.join(fx.tmp, "wt-orig");
    execSync(`git worktree add -b pi-bg/orig ${reuse}`, {
      cwd: fx.tmp,
      env: { ...fx.env },
      stdio: "pipe",
    });
    const r = await fx.run(["worker", "--wt-reuse", reuse, "retry task"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("worktree reused");
    expect(r.out).toContain(`(branch pi-bg/orig`);
    // no second worktree dir appeared: still main + orig only
    const wtlist = execSync("git worktree list", {
      cwd: fx.tmp,
      env: { ...fx.env },
      stdio: "pipe",
    })
      .toString()
      .trim()
      .split("\n").length;
    expect(wtlist).toBe(2);
    // record: wt + wtBranch point at the reused checkout
    const recs = fx.records();
    expect(recs).toHaveLength(1);
    const wtReal = fs.realpathSync(reuse);
    expect(recs[0].wt).toBe(wtReal);
    expect(recs[0].wtBranch).toBe("pi-bg/orig");
    expect(recs[0].state).toBe("done");
  });

  test("--wt-reuse of a non-worktree dir: launch-fail rc 3, record killed", async () => {
    const fx = fixture();
    fx.seedMainCreds();
    const notwt = path.join(fx.tmp, "notwt");
    fs.mkdirSync(notwt);
    const r = await fx.run(["worker", "--wt-reuse", notwt, "t"]);
    expect(r.code).toBe(3);
    expect(r.err).toContain(
      "LAUNCH-FAIL: --wt-reuse dir is not a git worktree",
    );
    const recs = fx.records();
    expect(recs).toHaveLength(1);
    expect(recs[0].state).toBe("killed");
    expect(recs[0].reason).toContain(
      "launch-fail: wt-reuse not a git worktree",
    );
  });

  test("--wt-reuse with no value: usage error rc 2, no record", async () => {
    const fx = fixture();
    fx.seedMainCreds();
    const r = await fx.run(["worker", "--wt-reuse"]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("--wt-reuse needs a value");
    // usage error exits before any side effect: not even the records dir
    const recs = fs.existsSync(fx.env.PI_DISPATCH_RECORD_DIR)
      ? fx.records()
      : [];
    expect(recs).toHaveLength(0);
  });

  test("PI_BG_RETRY_OF tags the run record (retryOf); its death is a second death", async () => {
    const fx = fixture();
    fx.seedMainCreds();
    fx.env.PI_BG_RETRY_OF = "20261006-040758-111111";
    try {
      const r = await fx.run(["worker", "retry task"]);
      expect(r.code).toBe(0);
      const recs = fx.records();
      expect(recs).toHaveLength(1);
      expect(recs[0].retryOf).toBe("20261006-040758-111111");
      expect(recs[0].state).toBe("done");
    } finally {
      delete fx.env.PI_BG_RETRY_OF;
    }
  });

  test("normal --worktree run: record also carries wt + wtBranch", async () => {
    const fx = fixture();
    fx.seedMainCreds();
    gitRepo(fx);
    const r = await fx.run(["worker", "--worktree", "wt task"]);
    expect(r.code).toBe(0);
    const recs = fx.records();
    expect(recs).toHaveLength(1);
    expect(recs[0].wt).toContain(`.pi-bg-wt/${path.basename(fx.tmp)}/`);
    expect(recs[0].wtBranch).toBe(`pi-bg/${recs[0].run}`);
  });
});

/**
 * #86 + A1 (polish sweep): launch-fail webhook. A --worktree launch-fail
 * (not a git repo / worktree add failed) exits 3 BEFORE the run record +
 * bg_on_exit register, so bg_launch_fail posts the standard bg_build DIED
 * embed itself - the payload's embed author ("pi-bg ticket · <rid>") is
 * what isBgWebhook accepts on the bridge side, so the callback wakes the
 * orchestrator. The capture hook's req.json() 500s on a non-JSON body
 * (body stays null), so a captured body is proof the payload is valid JSON
 * - the Discord 400/50109 shape check.
 */
describe("#86: launch-fail webhook", () => {
  const capture = () => {
    let body: any = null;
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: async (req) => {
        if (req.method === "POST") body = (await req.json()) as any;
        return new Response("ok", { status: 200 });
      },
    });
    return {
      url: `http://127.0.0.1:${server.port}/hook`,
      getBody: () => body,
      close: () => server.stop(true),
    };
  };

  test("not a git repo: rc 3 + DIED embed payload passes isBgWebhook", async () => {
    const fx = fixture();
    const hook = capture();
    fx.env.PI_DISPATCH_WEBHOOK = hook.url;
    fx.env.PI_BG_WB_BACKOFF = "0";
    try {
      // fixture cwd (os.tmpdir) is not inside a git repo
      const r = await fx.run(["worker", "--worktree", "t"]);
      expect(r.code).toBe(3);
      expect(r.err).toContain("LAUNCH-FAIL: --worktree needs a git repo");
      const cap = hook.getBody();
      if (!cap) throw new Error("webhook not captured (or body was not JSON)");
      // ticket id: printed on the first stdout line, shape ^\d{8}-\d{6}-\d+$
      const m = r.out.match(/^\[pi-bg\] ticket (\S+)/);
      if (!m) throw new Error("no ticket line on stdout");
      const rid = m[1] ?? "";
      expect(rid).toMatch(/^\d{8}-\d{6}-\d+$/);
      // A1: embed payload, not raw text - the embed author is the
      // isBgWebhook discriminator (webhook_id is added by Discord on
      // inbound, so the test supplies it).
      const emb = cap.embeds?.[0];
      expect(
        emb,
        `payload must be an embed: ${JSON.stringify(cap).slice(0, 200)}`,
      ).toBeDefined();
      expect(emb.author.name).toBe(`pi-bg ticket \u00b7 ${rid}`);
      expect(emb.description).toContain(`\u250c died \u00b7 ${rid}`);
      expect(emb.description).toContain("$ jarate-bg worker --worktree");
      const result = emb.fields?.find((f: any) => f.name === "result");
      expect(result?.value).toContain(
        "launch-fail: --worktree needs a git repo",
      );
      expect(isBgWebhook({ ...cap, webhook_id: "123" })).toBe(true);
    } finally {
      delete fx.env.PI_DISPATCH_WEBHOOK;
      delete fx.env.PI_BG_WB_BACKOFF;
      hook.close();
    }
  });

  test("git repo + bad ref: rc 3 + embed result field has worktree add failed + ref name", async () => {
    const fx = fixture();
    const sh = (cmd: string) =>
      execSync(cmd, { cwd: fx.tmp, env: { ...fx.env }, stdio: "pipe" });
    sh("git init -b main");
    sh("git config user.email t@t");
    sh("git config user.name t");
    fs.writeFileSync(path.join(fx.tmp, "a.txt"), "a\n");
    sh("git add a.txt");
    sh("git commit -m init");
    const hook = capture();
    fx.env.PI_DISPATCH_WEBHOOK = hook.url;
    fx.env.PI_BG_WB_BACKOFF = "0";
    try {
      const ref = `no-such-ref-${Date.now()}`;
      const r = await fx.run(["worker", "--worktree", ref, "t"]);
      expect(r.code).toBe(3);
      expect(r.err).toContain("LAUNCH-FAIL: worktree add failed");
      const cap = hook.getBody();
      if (!cap) throw new Error("webhook not captured (or body was not JSON)");
      const emb = cap.embeds?.[0];
      expect(emb).toBeDefined();
      const result = emb.fields?.find((f: any) => f.name === "result");
      expect(result?.value).toContain(
        `launch-fail: worktree add failed ref=${ref}`,
      );
      expect(emb.author.name).toMatch(/^pi-bg ticket \u00b7 \d{8}-\d{6}-\d+$/);
      expect(isBgWebhook({ ...cap, webhook_id: "123" })).toBe(true);
    } finally {
      delete fx.env.PI_DISPATCH_WEBHOOK;
      delete fx.env.PI_BG_WB_BACKOFF;
      hook.close();
    }
  });

  test("no-webhook corner (#30): rc 3, LAUNCH-FAIL printed, no unbound variable, no webhook attempt", async () => {
    const fx = fixture();
    // documented no-webhook mode: fixture fake HOME has no
    // ~/.config/pi-dispatch/webhook and PI_DISPATCH_WEBHOOK is deleted,
    // so the early read leaves `webhook` unset (set -u corner)
    expect(
      fs.existsSync(path.join(fx.home, ".config", "pi-dispatch", "webhook")),
    ).toBe(false);
    expect(fx.env.PI_DISPATCH_WEBHOOK).toBeUndefined();
    // fixture cwd (os.tmpdir) is not inside a git repo
    const r = await fx.run(["worker", "--worktree", "t"]);
    expect(r.code).toBe(3);
    expect(r.err).toContain("LAUNCH-FAIL: --worktree needs a git repo");
    // pre-fix: `line 381: webhook: unbound variable` + rc 1 (MINOR-1)
    expect(r.err).not.toContain("unbound variable");
    // no webhook attempt: a post would need a URL (none exists); if a
    // broken guard ever fired one, curl would fail and leave the
    // -webhook-failed dead letter in BG_TMP ($HOME/.pi-bg-art)
    const m = r.out.match(/^\[pi-bg\] ticket (\S+)/);
    if (!m) throw new Error("no ticket line on stdout");
    expect(m[1]).toMatch(/^\d{8}-\d{6}-\d+$/);
    const artDir = path.join(fx.home, ".pi-bg-art");
    const files = fs.existsSync(artDir) ? fs.readdirSync(artDir) : [];
    expect(files.filter((f) => f.endsWith("-webhook-failed"))).toEqual([]);
  });
});

/**
 * #53: self-contained dead letters. When the webhook is down the launcher
 * used to dead-letter a header pointing at the body file - which its own
 * exit-trap tmp cleanup deletes, leaving the letter unrecoverable and the
 * DIED lost forever (the orchestrator never wakes). The letter now embeds
 * the JSON body after the `--- body json ---` marker; the watchdog
 * re-posts it on the next sweep.
 */
describe("#53: self-contained dead letters (launcher side)", () => {
  test("launch-fail post failure: the letter embeds the JSON body", async () => {
    const fx = fixture();
    const art = path.join(fx.tmp, "art");
    fx.env.PI_BG_TMPDIR = art;
    fs.mkdirSync(art, { recursive: true });
    // port 9 (discard): conn refused -> all 3 attempts 000
    fx.env.PI_DISPATCH_WEBHOOK = "http://127.0.0.1:9/dl";
    fx.env.PI_BG_WB_BACKOFF = "0";
    const r = await fx.run(["worker", "--worktree", "dl letter task"]);
    expect(r.code).toBe(3);
    const letters = fs
      .readdirSync(art)
      .filter((f) => f.endsWith("-webhook-failed"));
    expect(letters).toHaveLength(1);
    const letter = fs.readFileSync(path.join(art, letters[0] ?? ""), "utf8");
    expect(letter).toContain("http     : 000 (3 attempts)");
    const marker = "--- body json ---";
    expect(letter).toContain(marker);
    // everything after the marker is the embedded body: valid JSON, the
    // DIED embed the bridge would have delivered
    const bodyJson = letter.split(marker).slice(1).join(marker).trim();
    const parsed = JSON.parse(bodyJson) as {
      embeds: { author: { name: string } }[];
    };
    expect(parsed.embeds[0].author.name).toMatch(
      /^pi-bg ticket \u00b7 \d{8}-\d{6}-\d+$/,
    );
  }, 30_000);
});

/**
 * #41: concurrency cap (PI_BG_MAX_CONCURRENT, default 3).
 *
 * pi-bg counts live tickets by fresh heartbeat files (issue #123: the
 * old /proc argv scan matched 2+ processes per ticket - wrapper, hb
 * child, lingering launcher - plus same-uid test stubs, so the pinned
 * cap admitted far fewer real tickets than configured). Each ticket
 * creates pi-bg-<run_id>-hb at ticket creation and its hb child touches
 * it every PI_BG_HB_INTERVAL while the ticket is alive; the script
 * counts files fresh within 3 intervals. Each fixture's artifact dir is
 * isolated (the fixture deletes PI_BG_TMPDIR -> <fx>/home/.pi-bg-art),
 * so live host traffic is invisible and the count starts at 0; the
 * baseline capture stays for the relative asserts.
 */
describe("#41: concurrency cap (PI_BG_MAX_CONCURRENT)", () => {
  const sleepStubPi = (fx: { tmp: string }, seconds: number) => {
    const piBin = path.join(fx.tmp, "bin", "pi");
    fs.writeFileSync(piBin, `#!/bin/sh\nsleep ${seconds}\necho pi-run-ok\n`);
  };

  const spawnStub = (
    fx: {
      tmp: string;
      env: Record<string, string>;
    },
    task: string,
    extraEnv: Record<string, string> = {},
  ) =>
    spawn(["bash", PI_BG, "worker", task], {
      env: { ...fx.env, ...extraEnv },
      cwd: fx.tmp,
      stdout: "pipe",
      stderr: "pipe",
    });

  const waitFor = async (fn: () => boolean, ms = 15_000): Promise<boolean> => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      if (fn()) return true;
      await Bun.sleep(100);
    }
    return fn();
  };

  const collected = new WeakMap<
    ReturnType<typeof spawn>,
    { code: number | null; out: string; err: string }
  >();
  const collect = async (p: ReturnType<typeof spawn>) => {
    const prev = collected.get(p);
    if (prev) {
      const code = await p.exited;
      return { code, out: prev.out, err: prev.err };
    }
    const [out, err] = await Promise.all([
      new Response(p.stdout).text(),
      new Response(p.stderr).text(),
    ]);
    const code = await p.exited;
    collected.set(p, { out, err });
    return { code, out, err };
  };

  // Kill wrapper stubs + their orphaned sleeping pi children. The wrappers
  // are killed by pid; the stub pi's are reaped by pkill on the UNIQUE
  // mkdtemp dir, anchored on the shebang interpreter.
  const killStubs = (stubs: ReturnType<typeof spawn>[], tmp: string) => {
    for (const s of stubs) {
      try {
        s.kill("TERM");
      } catch {
        /* already dead */
      }
    }
    try {
      execSync(`pkill -f '^/bin/sh ${tmp}/bin/pi ' || true`, {
        stdio: "ignore",
      });
    } catch {
      /* pkill missing or nothing matched */
    }
  };

  test("below cap: all stubs start and complete", async () => {
    const fx = fixture();
    fx.seedMainCreds();
    sleepStubPi(fx, 10); // hardening margin, not the flake fix
    const base = countFreshHb(fx);
    const max = base + 3;
    const stubs = [1, 2, 3].map((i) =>
      spawnStub(fx, `cap t1 stub ${i}`, { PI_BG_MAX_CONCURRENT: String(max) }),
    );
    try {
      // all three wrappers in flight at once
      expect(await waitFor(() => countFreshHb(fx) - base >= 3)).toBe(true);
      const results = await Promise.all(stubs.map(collect));
      for (const r of results) {
        expect(r.code).toBe(0);
        expect(r.out).toContain("pi-run-ok");
        expect(r.err).not.toContain("at cap");
      }
    } finally {
      killStubs(stubs, fx.tmp);
    }
  }, 30_000);

  test("at cap: next dispatch refused (exit 5, cap line, no run record)", async () => {
    const fx = fixture();
    fx.seedMainCreds();
    sleepStubPi(fx, 3);
    const base = countFreshHb(fx);
    const max = base + 2;
    const a = spawnStub(fx, "cap t2 stub a", {
      PI_BG_MAX_CONCURRENT: String(max),
    });
    const b = spawnStub(fx, "cap t2 stub b", {
      PI_BG_MAX_CONCURRENT: String(max),
    });
    let c: ReturnType<typeof spawn> | undefined;
    try {
      // two stubs in flight
      expect(await waitFor(() => countFreshHb(fx) - base >= 2)).toBe(true);
      c = spawnStub(fx, "cap t2 stub c", {
        PI_BG_MAX_CONCURRENT: String(max),
      });
      const r = await collect(c);
      expect(r.code).toBe(5);
      expect(r.err).toMatch(
        /\[!\] at cap \(\d+\/\d+\), try again later or jarate-bg-kill a ticket/,
      );
      // The run record is written at dispatch, before the stub pi launches.
      // Collect a + b (waits for their exit) so the assertion no longer
      // depends on a 15s poll deadline, and so a + b's exit traps complete
      // before bun teardown kills the children. The refused c left no record.
      await collect(a);
      await collect(b);
      expect(fx.records()).toHaveLength(2);
    } finally {
      killStubs([a, b, ...(c ? [c] : [])], fx.tmp);
    }
  }, 30_000);

  test("cap env unset + no cap file: fleet default 3, no warning line", async () => {
    // RCA #57 fix 2 added the ~/.config/pi-dispatch/max-concurrent file;
    // with env unset AND no file (fresh fixture HOME), the default must
    // apply silently - the validation warning is for NON-EMPTY invalid
    // values only (2026-09-15: every dispatch warned on the empty).
    const fx = fixture();
    fx.seedMainCreds();
    sleepStubPi(fx, 2);
    const envNoCap: Record<string, string> = { ...fx.env };
    delete envNoCap.PI_BG_MAX_CONCURRENT;
    // settle: no-op under per-fixture artifact isolation (kept as a guard
    // against a future shared PI_BG_TMPDIR regression). Wait until the
    // count stops changing (two equal samples 100ms apart).
    let prev = countFreshHb(fx);
    expect(
      await waitFor(() => {
        const cur = countFreshHb(fx);
        if (cur === prev) return true;
        prev = cur;
        return false;
      }, 10_000),
    ).toBe(true);
    const s = spawn(["bash", PI_BG, "worker", "cap t3b no-env stub"], {
      env: envNoCap,
      cwd: fx.tmp,
      stdout: "pipe",
      stderr: "pipe",
    });
    try {
      const r = await collect(s);
      // the no-warning line is the regression; the cap outcome depends on
      // fleet load (a live review or a deploy test suite holds slots).
      expect(r.err).not.toMatch(/not a non-negative integer/);
      if (r.code === 0) {
        expect(r.out).toContain("pi-run-ok");
        expect(r.err).not.toContain("at cap");
      } else {
        // rejected -> the message must show the DEFAULT cap (3), proving
        // the unset-env path fell through to the fleet default
        expect(r.code).toBe(5);
        expect(r.err).toMatch(/at cap \(\d+\/3\)/);
      }
    } finally {
      killStubs([s], fx.tmp);
    }
  }, 30_000);

  test("self-exclusion: the counting wrapper is not counted against the cap", async () => {
    const fx = fixture();
    fx.seedMainCreds();
    // immediate stub pi: the wrapper is short-lived, so a self-count would
    // refuse exactly this case (live = base + 1(self) >= max = base + 1)
    const base = countFreshHb(fx);
    const r = await collect(
      spawnStub(fx, "cap t3 self", {
        PI_BG_MAX_CONCURRENT: String(base + 1),
      }),
    );
    expect(r.code).toBe(0);
    expect(r.out).toContain("pi-run-ok");
    expect(r.err).not.toContain("at cap");
  }, 15_000);

  test("PI_BG_MAX_CONCURRENT=0: unlimited (4 in flight, above default 3)", async () => {
    const fx = fixture();
    fx.seedMainCreds();
    sleepStubPi(fx, 10); // hardening margin, not the flake fix
    const base = countFreshHb(fx);
    const stubs = [1, 2, 3, 4].map((i) =>
      spawnStub(fx, `cap t4 stub ${i}`, { PI_BG_MAX_CONCURRENT: "0" }),
    );
    try {
      // 4 concurrent > the default cap of 3: only max=0 lets all start
      expect(await waitFor(() => countFreshHb(fx) - base >= 4)).toBe(true);
      const results = await Promise.all(stubs.map(collect));
      for (const r of results) {
        expect(r.code).toBe(0);
        expect(r.err).not.toContain("at cap");
      }
    } finally {
      killStubs(stubs, fx.tmp);
    }
  }, 30_000);

  // --- issue #123 verification (cap counts TICKETS, not processes) ---
  // Each live stub ticket = 4 processes (wrapper bash, hb child, sh-pi,
  // sleep); 2 of them (wrapper + hb child, identical argv) match the
  // pre-fix /proc argv scan (basename pi-bg + worker). The old scan
  // counted those 2 (plus same-uid stubs), so a pinned cap 4 admitted
  // ~1 real ticket. The fix counts fresh hb files instead: one file per
  // ticket, windowed at 3 x PI_BG_HB_INTERVAL (90s default); the assert
  // below pins the hb-FILE count (exactly 2 for 2 tickets), not procs.

  test("2 live tickets count as 2 (hb files, not procs); cap admits up to max", async () => {
    const fx = fixture();
    fx.seedMainCreds();
    sleepStubPi(fx, 10);
    const base = countFreshHb(fx);
    const max = base + 2;
    const a = spawnStub(fx, "cap t123 a", {
      PI_BG_MAX_CONCURRENT: String(max),
    });
    const b = spawnStub(fx, "cap t123 b", {
      PI_BG_MAX_CONCURRENT: String(max),
    });
    let c: ReturnType<typeof spawn> | undefined;
    try {
      // both stubs in flight: EXACTLY 2 fresh hb files, not 4 (the wrapper
      // + sleeping pi of each ticket must collapse to one count)
      expect(await waitFor(() => countFreshHb(fx) - base === 2)).toBe(true);
      // at max: the 3rd dispatch is refused even though 4+ "pi-bg worker"
      // processes are live
      c = spawnStub(fx, "cap t123 c", {
        PI_BG_MAX_CONCURRENT: String(max),
      });
      const rc = await collect(c);
      expect(rc.code).toBe(5);
      expect(rc.err).toMatch(
        /\[!\] at cap \(\d+\/\d+\), try again later or jarate-bg-kill a ticket/,
      );
      // a + b were admitted: the cap admits up to max real tickets
      const results = await Promise.all([a, b].map(collect));
      for (const r of results) {
        expect(r.code).toBe(0);
        expect(r.out).toContain("pi-run-ok");
        expect(r.err).not.toContain("at cap");
      }
    } finally {
      killStubs([a, b, ...(c ? [c] : [])], fx.tmp);
    }
  }, 30_000);

  test("stale hb files (120s, outside the 3x30s window) never block a slot", async () => {
    const fx = fixture();
    fx.seedMainCreds();
    // two SIGKILLed tickets' hb files, 120s old (> 3 x 30s window): they
    // sit in the artifact dir but the mtime window must exclude them
    const art = path.join(fx.tmp, "home", ".pi-bg-art");
    fs.mkdirSync(art, { recursive: true });
    const old = new Date(Date.now() - 120_000);
    for (const id of ["20990101-000001-1", "20990101-000002-2"]) {
      const hb = path.join(art, `pi-bg-${id}-hb`);
      fs.writeFileSync(hb, "");
      fs.utimesSync(hb, old, old);
    }
    expect(countFreshHb(fx)).toBe(0); // mirror agrees: stale = 0
    // cap 1: only fresh files could refuse this dispatch
    fx.env.PI_BG_MAX_CONCURRENT = "1";
    const r = await fx.run(["worker", "cap t123 stale"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("pi-run-ok");
    expect(r.err).not.toContain("at cap");
  }, 15_000);

  test("fresh fake hb files count: 2 fresh + cap 2 -> refused, no record", async () => {
    const fx = fixture();
    fx.seedMainCreds();
    // window boundary, other direction: hb files touched just now DO count
    const art = path.join(fx.tmp, "home", ".pi-bg-art");
    fs.mkdirSync(art, { recursive: true });
    for (const id of ["20990101-000003-3", "20990101-000004-4"]) {
      fs.writeFileSync(path.join(art, `pi-bg-${id}-hb`), "");
    }
    expect(countFreshHb(fx)).toBe(2); // mirror agrees: fresh = 2
    fx.env.PI_BG_MAX_CONCURRENT = "2"; // == live count -> at cap
    const r = await fx.run(["worker", "cap t123 fresh"]);
    expect(r.code).toBe(5);
    expect(r.err).toMatch(/\[!\] at cap \(2\/2\)/);
    // the refused dispatch left no run record (no state=running zombie);
    // the record dir does not exist at all (the cap check runs before any
    // bookkeeping), which is the strongest form of "no record"
    const recDir = fx.env.PI_DISPATCH_RECORD_DIR;
    const recs = fs.existsSync(recDir)
      ? fs.readdirSync(recDir).filter((f) => f.endsWith(".json"))
      : [];
    expect(recs).toHaveLength(0);
  }, 15_000);

  test("stub ticket under another PI_BG_TMPDIR does not count", async () => {
    const fx = fixture();
    fx.seedMainCreds();
    sleepStubPi(fx, 8);
    // the issue's stub shape: a real jarate-bg run under a fake fixture
    // dir (/tmp/pibg-test-*), same uid - its hb file lands in its own
    // PI_BG_TMPDIR and must be invisible to this fixture's cap count
    const altArt = path.join(fx.tmp, "alt-art");
    const stub = spawn(["bash", PI_BG, "worker", "cap t123 alt stub"], {
      env: { ...fx.env, PI_BG_TMPDIR: altArt },
      cwd: fx.tmp,
      stdout: "pipe",
      stderr: "pipe",
    });
    try {
      // wait for the stub's hb file in ITS dir (the stub is live)
      const t0 = Date.now();
      let liveInAlt = false;
      while (!liveInAlt && Date.now() - t0 < 8000) {
        try {
          liveInAlt = fs
            .readdirSync(altArt)
            .some((f) => /^pi-bg-.+-hb$/.test(f));
        } catch {
          /* dir not created yet */
        }
        if (!liveInAlt) await Bun.sleep(100);
      }
      expect(liveInAlt).toBe(true);
      const base = countFreshHb(fx); // default-dir view: stub invisible
      // cap = base + 1: a stub-counting regression (2 procs) would refuse
      fx.env.PI_BG_MAX_CONCURRENT = String(base + 1);
      const r = await fx.run(["worker", "cap t123 main"]);
      expect(r.code).toBe(0);
      expect(r.out).toContain("pi-run-ok");
      expect(r.err).not.toContain("at cap");
    } finally {
      killStubs([stub], fx.tmp);
    }
  }, 30_000);

  test("bare same-uid 'pi-bg worker' argv stubs do not count (no /proc scan)", async () => {
    const fx = fixture();
    fx.seedMainCreds();
    // the pre-fix scan matched any same-uid process whose argv carried an
    // element basename 'pi-bg' followed by 'worker'|'reviewer' - spawn two
    // such stubs (no hb file at all) and prove a cap = base + 1 dispatch
    // still gets through
    const stubDir = path.join(fx.tmp, "stub");
    fs.mkdirSync(stubDir);
    const stubBg = path.join(stubDir, "pi-bg");
    fs.writeFileSync(stubBg, "#!/bin/sh\nsleep 8\n");
    fs.chmodSync(stubBg, 0o755);
    const s1 = spawn(["bash", stubBg, "worker", "stub a"], {
      stdout: "ignore",
      stderr: "ignore",
    });
    const s2 = spawn(["bash", stubBg, "worker", "stub b"], {
      stdout: "ignore",
      stderr: "ignore",
    });
    try {
      await Bun.sleep(400); // let the stubs appear in ps
      const base = countFreshHb(fx);
      fx.env.PI_BG_MAX_CONCURRENT = String(base + 1);
      const r = await fx.run(["worker", "cap t123 argv"]);
      expect(r.code).toBe(0);
      expect(r.out).toContain("pi-run-ok");
      expect(r.err).not.toContain("at cap");
    } finally {
      for (const s of [s1, s2]) {
        try {
          s.kill("TERM");
        } catch {
          /* already dead */
        }
      }
    }
  }, 15_000);

  // Other-user exclusion needs root (spawn a matching process as nobody).
  // Skipped - not root-testable - on unprivileged runners.
  const hasSetpriv = (() => {
    try {
      execSync("command -v setpriv", { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  })();
  const otherUserIt = process.getuid?.() === 0 && hasSetpriv ? test : test.skip;

  otherUserIt(
    "other users' matching processes are not counted (root only)",
    async () => {
      const fx = fixture();
      fx.seedMainCreds();
      // a "pi-bg worker" process owned by uid 65534 (nobody): matches the
      // fleet ps pattern but must not count against the root user's cap
      const otherDir = path.join(fx.tmp, "other");
      fs.mkdirSync(otherDir);
      fs.chmodSync(fx.tmp, 0o755); // mkdtemp is 0700; nobody must traverse
      const otherPiBg = path.join(otherDir, "pi-bg");
      fs.writeFileSync(otherPiBg, "#!/bin/sh\nsleep 10\n");
      fs.chmodSync(otherPiBg, 0o755);
      const other = spawn(
        [
          "setpriv",
          "--reuid=65534",
          "--regid=65534",
          "--clear-groups",
          "bash",
          otherPiBg,
          "worker",
        ],
        { stdout: "ignore", stderr: "ignore" },
      );
      try {
        await Bun.sleep(300); // let the nobody process appear in ps
        const base = countFreshHb(fx); // fixture view: nobody's files are in its own HOME
        const r = await collect(
          spawnStub(fx, "cap t5 other", {
            PI_BG_MAX_CONCURRENT: String(base + 1),
          }),
        );
        expect(r.code).toBe(0);
        expect(r.err).not.toContain("at cap");
      } finally {
        try {
          other.kill("TERM");
        } catch {
          /* already dead */
        }
      }
    },
    30_000,
  );
});

/**
 * #56: session isolation (setsid at launch). A nested dispatch's launcher
 * tool call can block in wait4() on the ticket; the harness bash-tool
 * timeout then signals the LAUNCHER's process group (kill to -pgid).
 * Pre-fix the ticket's pi child sat in that PG and died rc=143.
 */
describe("#56: session isolation (setsid at launch)", () => {
  // /proc/<pid>/stat -> [state, ppid, pgrp, session, ...] (fields 3-5 here)
  const statFields = (pid: number | string) => {
    const raw = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    return raw
      .slice(raw.lastIndexOf(")") + 2)
      .trim()
      .split(/\s+/);
  };

  test("wrapper is the session leader; pi shares the wrapper's session, not the launcher's", async () => {
    const fx = fixture();
    fx.seedMainCreds();
    // fake cgroup root: no real cgroup dirs leak from the suite
    const cgParent = path.join(fx.tmp, "cg", "user@1.service");
    fs.mkdirSync(cgParent, { recursive: true });
    fs.writeFileSync(path.join(cgParent, "cgroup.procs"), "");
    fx.env.PI_BG_CG_ROOT = cgParent;

    const report = path.join(fx.tmp, "sess-report");
    const piBin = path.join(fx.tmp, "bin", "pi");
    fs.writeFileSync(
      piBin,
      [
        "#!/bin/sh",
        `printf 'pi_pgrp=%s pi_sid=%s\\n' "$(ps -o pgid= -p $$ | tr -d ' ')" "$(ps -o sid= -p $$ | tr -d ' ')" > ${report}`,
        "sleep 2",
        "echo pi-run-ok",
        "",
      ].join("\n"),
    );
    fs.chmodSync(piBin, 0o755);

    const p = spawn(["bash", PI_BG, "worker", "session task"], {
      env: fx.env,
      cwd: fx.tmp,
      stdout: "pipe",
      stderr: "pipe",
    });
    try {
      // while pi runs: wrapper pid == spawned pid (setsid re-exec does not
      // fork: the spawned bash is not a group leader)
      const t0 = Date.now();
      while (!fs.existsSync(report) && Date.now() - t0 < 8000) {
        await Bun.sleep(50);
      }
      expect(fs.existsSync(report)).toBe(true);
      const wr = statFields(p.pid);
      const wrapperPid = String(p.pid);
      // the wrapper is a session + group leader
      expect(wr[2]).toBe(wrapperPid); // pgrp == pid
      expect(wr[3]).toBe(wrapperPid); // sid == pid
      // pi shares the wrapper's session, not the launcher's (bun) session
      const rep = Object.fromEntries(
        fs
          .readFileSync(report, "utf8")
          .trim()
          .split(" ")
          .map((kv) => kv.split("=")),
      );
      expect(rep.pi_pgrp).toBe(wrapperPid);
      expect(rep.pi_sid).toBe(wrapperPid);
      expect(rep.pi_sid).not.toBe(statFields(process.pid)[3]);

      const [out] = await Promise.all([
        new Response(p.stdout).text(),
        new Response(p.stderr).text(),
      ]);
      const code = await p.exited;
      expect(code).toBe(0);
      expect(out).toContain("pi-run-ok");
      expect(out).toContain(`[pi-bg] ticket `);
    } finally {
      try {
        process.kill(-p.pid, "SIGKILL");
      } catch {
        /* already dead */
      }
    }
  }, 30_000);

  test("TERM to the launcher's PG does not kill the ticket (nested repro)", async () => {
    const fx = fixture();
    fx.seedMainCreds();
    const cgParent = path.join(fx.tmp, "cg", "user@1.service");
    fs.mkdirSync(cgParent, { recursive: true });
    fs.writeFileSync(path.join(cgParent, "cgroup.procs"), "");
    fx.env.PI_BG_CG_ROOT = cgParent;
    const tmpdir = path.join(fx.tmp, "artifacts");
    fx.env.PI_BG_TMPDIR = tmpdir;
    // the ticket is still in flight when the launcher PG is TERMed
    fs.writeFileSync(
      path.join(fx.tmp, "bin", "pi"),
      "#!/bin/sh\nsleep 3\necho pi-run-ok\n",
    );

    const log = path.join(fx.tmp, "nested.log");
    // harness-shaped launcher: DETACHED bash (own session + PGID) that
    // backgrounds the ticket the bare way (blocking launch, no return
    // pattern) and stays alive in the launcher PG
    const launcher = spawn(
      [
        "bash",
        "-c",
        `bash ${PI_BG} worker "nested task" > ${log} 2>&1 & sleep 60`,
      ],
      {
        env: fx.env,
        cwd: fx.tmp,
        detached: true,
        stdout: "ignore",
        stderr: "ignore",
        stdin: "ignore",
      },
    );
    try {
      // wait for the ticket's belt line: it is up and past the re-exec
      const t0 = Date.now();
      while (Date.now() - t0 < 10_000) {
        const c = fs.existsSync(log) ? fs.readFileSync(log, "utf8") : "";
        if (c.includes("[pi-bg] ticket ")) break;
        await Bun.sleep(100);
      }
      expect(fs.readFileSync(log, "utf8")).toContain("[pi-bg] ticket ");
      const m = fs.readFileSync(log, "utf8").match(/\[pi-bg\] ticket (\S+)/);
      if (!m) throw new Error("ticket line vanished from launcher log");
      const runId = m[1];

      // sabotage: the harness timeout signals the launcher's process group
      process.kill(-launcher.pid, "SIGTERM");
      const lcode = await launcher.exited;
      expect(lcode).not.toBe(0); // the launcher itself died

      // the ticket must survive to completion (pre-fix: rc=143, no out.md)
      const outf = path.join(tmpdir, `pi-bg-${runId}-out.md`);
      const rawf = path.join(tmpdir, `pi-bg-${runId}-raw.out`);
      const t1 = Date.now();
      while (!fs.existsSync(outf) && Date.now() - t1 < 20_000) {
        await Bun.sleep(200);
      }
      expect(fs.existsSync(outf)).toBe(true);
      expect(fs.readFileSync(rawf, "utf8")).toContain("pi-run-ok");
      expect(fs.readFileSync(outf, "utf8")).not.toBe("");
      // the -started marker was cleared: clean exit, not a kill marker
      expect(fs.existsSync(path.join(tmpdir, `pi-bg-${runId}-killed`))).toBe(
        false,
      );
    } finally {
      try {
        process.kill(-launcher.pid, "SIGKILL");
      } catch {
        /* already dead */
      }
      // sweep any ticket leftover (unique tmp path; [p]i avoids pkill's
      // own command line self-matching)
      execSync(`pkill -f "${fx.tmp}/bin/[p]i" 2>/dev/null || true`);
    }
  }, 40_000);
});

/**
 * #57: silent deaths (RCA: pi's LLM HTTP idle timeout kills the run
 * mid-API-call under shared vLLM load -> exit 1, zero output). The wrapper
 * now relaunches the SAME ticket ONCE on that signature (marker gates it,
 * retry logged in the run record); a second silent death reports a normal
 * FAIL. RCA config fixes: httpIdleTimeoutMs 900000 in the role profile
 * (template + add-key doctor) and the per-box ~/.config/pi-dispatch/
 * max-concurrent cap file.
 */
describe("#57: silent-death retry + RCA config fixes", () => {
  const capture = () => {
    const posts: Array<{ embeds: any[] }> = [];
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

  const waitFor = async (fn: () => boolean, ms = 15_000): Promise<boolean> => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      if (fn()) return true;
      await Bun.sleep(100);
    }
    return fn();
  };

  // Mirror of the script's cap count is the shared countFreshHb above
  // (issue #123: heartbeat files, not processes).

  // fake pi: silent (rc=1, no output) for the first `die` launches, then
  // produces output. The state file doubles as a launch counter.
  const silentStubPi = (
    fx: { tmp: string },
    die: number,
    okOut = "silent-retry-ok",
  ) => {
    const state = path.join(fx.tmp, "pi-silent-state");
    const piBin = path.join(fx.tmp, "bin", "pi");
    fs.writeFileSync(
      piBin,
      `#!/bin/sh\nn=$(cat ${state} 2>/dev/null || echo 0)\nn=$((n+1))\necho $n > ${state}\nif [ "$n" -le "${die}" ]; then sleep 1; exit 1; fi\necho ${okOut}\n`,
    );
    fs.chmodSync(piBin, 0o755);
    return state;
  };

  const artDir = (fx: { home: string }) => path.join(fx.home, ".pi-bg-art");

  test("silent death once, then success -> OK callback, marker consumed, retry logged", async () => {
    const fx = fixture();
    fx.seedMainCreds();
    const state = silentStubPi(fx, 1);
    const hook = capture();
    fx.env.PI_DISPATCH_WEBHOOK = hook.url;
    fx.env.PI_BG_WB_BACKOFF = "0";
    try {
      const r = await fx.run(["worker", "silent once task"]);
      expect(r.code).toBe(0);
      expect(r.out).toContain("silent-retry-ok");
      // exactly two launches (original + one retry)
      expect(fs.readFileSync(state, "utf8").trim()).toBe("2");
      const runId = fx.records()[0].run;
      // retry1 marker written before the relaunch, consumed on recovery
      expect(
        fs.existsSync(path.join(artDir(fx), `pi-bg-${runId}-retry1`)),
      ).toBe(false);
      // rc artifact records the final (healthy) exit
      expect(
        fs
          .readFileSync(path.join(artDir(fx), `pi-bg-${runId}-rc`), "utf8")
          .trim(),
      ).toBe("0");
      // the retry is logged in the run record
      const rec = fx.records()[0];
      expect(rec.retries).toHaveLength(1);
      expect(rec.retries[0].reason).toBe("silent");
      // one OK callback, no DIED
      expect(hook.posts).toHaveLength(1);
      const em = hook.posts[0].embeds[0];
      expect(em.title).toMatch(/^worker · OK · \d+m\d{2}s$/);
      expect(
        em.fields.find((f: { name: string }) => f.name === "result").value,
      ).toContain("silent-retry-ok");
    } finally {
      delete fx.env.PI_DISPATCH_WEBHOOK;
      delete fx.env.PI_BG_WB_BACKOFF;
      hook.close();
    }
  }, 60_000);

  test("silent death twice -> normal FAIL after retry1, no third launch, marker kept", async () => {
    const fx = fixture();
    fx.seedMainCreds();
    const state = silentStubPi(fx, Number.MAX_SAFE_INTEGER);
    const hook = capture();
    fx.env.PI_DISPATCH_WEBHOOK = hook.url;
    fx.env.PI_BG_WB_BACKOFF = "0";
    try {
      const r = await fx.run(["worker", "silent twice task"]);
      expect(r.code).toBe(1); // pi's rc propagates; the status is in the embed
      // exactly two launches - the marker gates a third
      expect(fs.readFileSync(state, "utf8").trim()).toBe("2");
      const runId = fx.records()[0].run;
      // marker kept (unconsumed): the watchdog's SILENT signature
      expect(
        fs.existsSync(path.join(artDir(fx), `pi-bg-${runId}-retry1`)),
      ).toBe(true);
      expect(
        fs
          .readFileSync(path.join(artDir(fx), `pi-bg-${runId}-rc`), "utf8")
          .trim(),
      ).toBe("1");
      const rec = fx.records()[0];
      expect(rec.retries).toHaveLength(1);
      // one normal FAIL callback (not DIED), silent-x2 brief
      expect(hook.posts).toHaveLength(1);
      const em = hook.posts[0].embeds[0];
      expect(em.title).toMatch(/^worker · FAIL \(rc=1\) · \d+m\d{2}s$/);
      expect(
        em.fields.find((f: { name: string }) => f.name === "result").value,
      ).toContain("silent death x2");
    } finally {
      delete fx.env.PI_DISPATCH_WEBHOOK;
      delete fx.env.PI_BG_WB_BACKOFF;
      hook.close();
    }
  }, 60_000);

  test("loud exit 1 (has output) -> immediate FAIL, no retry, no marker", async () => {
    const fx = fixture();
    fx.seedMainCreds();
    const state = path.join(fx.tmp, "pi-loud-state");
    const piBin = path.join(fx.tmp, "bin", "pi");
    fs.writeFileSync(
      piBin,
      `#!/bin/sh\nn=$(cat ${state} 2>/dev/null || echo 0)\nn=$((n+1))\necho $n > ${state}\necho "error: boom"\nexit 1\n`,
    );
    fs.chmodSync(piBin, 0o755);
    const hook = capture();
    fx.env.PI_DISPATCH_WEBHOOK = hook.url;
    fx.env.PI_BG_WB_BACKOFF = "0";
    try {
      const r = await fx.run(["worker", "loud task"]);
      expect(r.code).toBe(1);
      expect(r.out).toContain("error: boom");
      // one launch only - output present is not the #57 signature
      expect(fs.readFileSync(state, "utf8").trim()).toBe("1");
      const runId = fx.records()[0].run;
      expect(
        fs.existsSync(path.join(artDir(fx), `pi-bg-${runId}-retry1`)),
      ).toBe(false);
      expect(fx.records()[0].retries ?? []).toHaveLength(0);
      expect(hook.posts).toHaveLength(1);
      const em = hook.posts[0].embeds[0];
      expect(em.title).toMatch(/^worker · FAIL \(rc=1\) · \d+m\d{2}s$/);
      expect(
        em.fields.find((f: { name: string }) => f.name === "result").value,
      ).toContain("error: boom");
    } finally {
      delete fx.env.PI_DISPATCH_WEBHOOK;
      delete fx.env.PI_BG_WB_BACKOFF;
      hook.close();
    }
  }, 30_000);

  test("RCA fix 1: profile settings carry httpIdleTimeoutMs 900000 (fresh seed + add-key merge; operator value kept)", async () => {
    const fx = fixture();
    fx.seedMainCreds();
    // fresh seed: the repo template now carries the knob
    const r1 = await fx.run(["worker", "idle 1"]);
    expect(r1.code).toBe(0);
    const ws = path.join(fx.home, ".pi", "agent-worker", "settings.json");
    let cfg = JSON.parse(fs.readFileSync(ws, "utf8"));
    expect(cfg.httpIdleTimeoutMs).toBe(900000);
    expect(cfg.defaultProvider).toBe("vllm"); // main merge intact
    // operator-set value: the doctor is add-key only, never overwrites
    cfg.httpIdleTimeoutMs = 123456;
    fs.writeFileSync(ws, JSON.stringify(cfg));
    const r2 = await fx.run(["worker", "idle 2"]);
    expect(r2.code).toBe(0);
    cfg = JSON.parse(fs.readFileSync(ws, "utf8"));
    expect(cfg.httpIdleTimeoutMs).toBe(123456);
    // pre-upgrade profile (existing settings WITHOUT the key): doctor adds it
    const rp = path.join(fx.home, ".pi", "agent-reviewer");
    fs.mkdirSync(rp, { recursive: true });
    fs.writeFileSync(
      path.join(rp, "auth.json"),
      JSON.stringify({ vllm: { type: "api_key", key: "sk-test" } }),
    );
    fs.writeFileSync(
      path.join(rp, "models.json"),
      JSON.stringify({ vllm: { models: [{ id: "qwen-test" }] } }),
    );
    fs.writeFileSync(
      path.join(rp, "settings.json"),
      JSON.stringify({
        defaultProvider: "vllm",
        defaultModel: "qwen-test",
        defaultThinkingLevel: "xhigh",
      }),
    );
    const r3 = await fx.run(["reviewer", "idle 3"]);
    expect(r3.code).toBe(0);
    cfg = JSON.parse(fs.readFileSync(path.join(rp, "settings.json"), "utf8"));
    expect(cfg.httpIdleTimeoutMs).toBe(900000);
    expect(cfg.defaultThinkingLevel).toBe("xhigh"); // untouched
  }, 30_000);

  test("RCA fix 2: per-box max-concurrent file applies when env var unset (env var still wins)", async () => {
    const fx = fixture();
    fx.seedMainCreds();
    const piBin = path.join(fx.tmp, "bin", "pi");
    fs.writeFileSync(piBin, "#!/bin/sh\nsleep 30\necho pi-run-ok\n");
    fs.chmodSync(piBin, 0o755);
    const capFile = path.join(
      fx.home,
      ".config",
      "pi-dispatch",
      "max-concurrent",
    );
    fs.mkdirSync(path.dirname(capFile), { recursive: true });
    const envNoVar = { ...fx.env };
    delete envNoVar.PI_BG_MAX_CONCURRENT;
    const base = countFreshHb(fx);
    fs.writeFileSync(capFile, `${base + 1}\n`);
    const a = spawn(["bash", PI_BG, "worker", "capfile a"], {
      env: envNoVar,
      cwd: fx.tmp,
      stdout: "pipe",
      stderr: "pipe",
    });
    const c = (p: ReturnType<typeof spawn>) =>
      Promise.all([
        new Response(p.stdout).text(),
        new Response(p.stderr).text(),
      ]).then(async ([out, err]) => ({ code: await p.exited, out, err }));
    try {
      expect(await waitFor(() => countFreshHb(fx) - base >= 1)).toBe(true);
      // b hits the file cap: refused with exit 5
      const b = spawn(["bash", PI_BG, "worker", "capfile b"], {
        env: envNoVar,
        cwd: fx.tmp,
        stdout: "pipe",
        stderr: "pipe",
      });
      const rb = await c(b);
      expect(rb.code).toBe(5);
      expect(rb.err).toMatch(/\[!\] at cap \(\d+\/\d+\)/);
      // env var still wins: unlimited starts fine while a is in flight
      const d = spawn(["bash", PI_BG, "worker", "capfile d"], {
        env: { ...envNoVar, PI_BG_MAX_CONCURRENT: "0" },
        cwd: fx.tmp,
        stdout: "pipe",
        stderr: "pipe",
      });
      await Bun.sleep(500); // let d clear the cap check into its sleep
      d.kill("SIGTERM");
      const rd = await c(d);
      expect(rd.err).not.toContain("at cap");
      expect(rd.code).toBe(143);
    } finally {
      a.kill("SIGTERM");
      await Bun.sleep(200);
      execSync(`pkill -f "${fx.tmp}/bin/[p]i" 2>/dev/null || true`, {
        stdio: "ignore",
      });
    }
  }, 30_000);
  // --- #57 class B: degenerate completion (rc=0, repetition loop) ---
  // 34 x 6 tokens = 204 tokens, 6 distinct: top15 = 1.0, distinct = 0.029
  const DEGEN = Array(34)
    .fill("handover unit testsuite pi-86 </div> loop")
    .join(" ");
  const degStub = (fx: { tmp: string }, variant: "once" | "always") => {
    const piBin = path.join(fx.tmp, "bin", "pi");
    const launches = path.join(fx.tmp, "pi-launches.log");
    const degFile = path.join(fx.tmp, "degen.txt");
    fs.writeFileSync(degFile, DEGEN);
    fs.writeFileSync(
      piBin,
      [
        "#!/bin/sh",
        `echo x >> ${launches}`,
        `n=$(wc -l < ${launches})`,
        variant === "once"
          ? `if [ "$n" -eq 1 ]; then cat ${degFile}; else seq 1 250 | paste -sd" " ; fi`
          : `cat ${degFile}`,
        "",
      ].join("\n"),
    );
    fs.chmodSync(piBin, 0o755);
    return launches;
  };
  const withHook = (fx: ReturnType<typeof fixture>, hook: { url: string }) => {
    fx.env.PI_DISPATCH_WEBHOOK = hook.url;
    fx.env.PI_BG_WB_BACKOFF = "0";
  };
  const withoutHook = (fx: ReturnType<typeof fixture>) => {
    delete fx.env.PI_DISPATCH_WEBHOOK;
    delete fx.env.PI_BG_WB_BACKOFF;
  };
  const runIdOf = (fx: ReturnType<typeof fixture>) =>
    fx.records()[0].run as string;
  const fieldsOf = (post: any) =>
    post.embeds[0].fields as Array<{ name: string; value: string }>;
  const fieldVal = (post: any, name: string) =>
    fieldsOf(post).find((f) => f.name === name)?.value;

  test("class B: degenerate rc=0 relaunched once, healthy retry -> OK", async () => {
    const fx = fixture();
    fx.seedMainCreds();
    const launches = degStub(fx, "once");
    const hook = capture();
    withHook(fx, hook);
    try {
      const r = await fx.run(["worker", "degen-once task"]);
      expect(r.code).toBe(0);
      const runId = runIdOf(fx);
      expect(hook.posts).toHaveLength(1);
      expect(hook.posts[0].embeds[0].title).toMatch(/^worker · OK · /);
      expect(fieldVal(hook.posts[0], "result")).toContain("1 2 3");
      // exactly two launches; degr1 marker consumed (recovered)
      expect(fs.readFileSync(launches, "utf8").trim().split("\n")).toHaveLength(
        2,
      );
      expect(fs.existsSync(path.join(artDir(fx), `pi-bg-${runId}-degr1`))).toBe(
        false,
      );
      // the relaunch is logged in the run record
      expect(fx.records()[0].retries).toHaveLength(1);
      expect(fx.records()[0].retries[0].reason).toBe("degenerate");
    } finally {
      withoutHook(fx);
      hook.close();
    }
  }, 60_000);

  test("class B: degenerate x2 -> FAIL with the actual signature (no 3rd launch)", async () => {
    const fx = fixture();
    fx.seedMainCreds();
    const launches = degStub(fx, "always");
    const hook = capture();
    withHook(fx, hook);
    try {
      const r = await fx.run(["worker", "degen-x2 task"]);
      expect(r.code).toBe(0);
      const runId = runIdOf(fx);
      expect(hook.posts).toHaveLength(1);
      expect(hook.posts[0].embeds[0].title).toMatch(
        /^worker · FAIL \(rc=0\) · /,
      );
      expect(fieldVal(hook.posts[0], "result")).toContain(
        "degenerate output x2",
      );
      // relaunched ONCE, then stopped; marker kept for forensics
      expect(fs.readFileSync(launches, "utf8").trim().split("\n")).toHaveLength(
        2,
      );
      expect(fs.existsSync(path.join(artDir(fx), `pi-bg-${runId}-degr1`))).toBe(
        true,
      );
    } finally {
      withoutHook(fx);
      hook.close();
    }
  }, 60_000);

  test("class B: reviewer rc=0 non-empty without VERDICT -> FAIL", async () => {
    const fx = fixture();
    fx.seedMainCreds();
    const piBin = path.join(fx.tmp, "bin", "pi");
    fs.writeFileSync(piBin, '#!/bin/sh\nseq 1 250 | paste -sd" "\n');
    fs.chmodSync(piBin, 0o755);
    const hook = capture();
    withHook(fx, hook);
    try {
      const r = await fx.run(["reviewer", "no-verdict task"]);
      expect(r.code).toBe(0);
      expect(hook.posts).toHaveLength(1);
      expect(hook.posts[0].embeds[0].title).toMatch(
        /^reviewer · FAIL \(rc=0\) · /,
      );
      expect(fieldVal(hook.posts[0], "result")).toContain("no VERDICT line");
    } finally {
      withoutHook(fx);
      hook.close();
    }
  }, 60_000);

  test("class B: reviewer rc=0 with trailing VERDICT: PASS -> PASS", async () => {
    const fx = fixture();
    fx.seedMainCreds();
    const piBin = path.join(fx.tmp, "bin", "pi");
    fs.writeFileSync(
      piBin,
      '#!/bin/sh\nseq 1 250 | paste -sd" "\necho "VERDICT: PASS"\n',
    );
    fs.chmodSync(piBin, 0o755);
    const hook = capture();
    withHook(fx, hook);
    try {
      const r = await fx.run(["reviewer", "pass-verdict task"]);
      expect(r.code).toBe(0);
      expect(hook.posts).toHaveLength(1);
      expect(hook.posts[0].embeds[0].title).toMatch(/^reviewer · PASS · /);
    } finally {
      withoutHook(fx);
      hook.close();
    }
  }, 60_000);

  test("class B: reviewer rc=0 with '**Verdict: PASS**' (markdown variant) -> PASS", async () => {
    // MAJOR-1 regression: the old case-sensitive tail-300 grep missed the
    // most common real variant '**Verdict: PASS**' and false-FAILed it.
    const fx = fixture();
    fx.seedMainCreds();
    const piBin = path.join(fx.tmp, "bin", "pi");
    fs.writeFileSync(
      piBin,
      '#!/bin/sh\nseq 1 250 | paste -sd" "\necho "**Verdict: PASS**"\n',
    );
    fs.chmodSync(piBin, 0o755);
    const hook = capture();
    withHook(fx, hook);
    try {
      const r = await fx.run(["reviewer", "md-verdict task"]);
      expect(r.code).toBe(0);
      expect(hook.posts).toHaveLength(1);
      expect(hook.posts[0].embeds[0].title).toMatch(/^reviewer · PASS · /);
    } finally {
      withoutHook(fx);
      hook.close();
    }
  }, 60_000);

  test("class B: reviewer rc=0 ending on a BARE 'PASS' line (no 'verdict:' prefix) -> PASS (#101d)", async () => {
    // Franky's PR #2210 reviewer ended on a bare 'PASS' line - the strict
    // 'verdict:' grep missed it and false-FAILed ('no VERDICT line') even
    // though the review pack was complete. The fallback accepts a bare
    // trailing PASS/FAIL as the verdict.
    const fx = fixture();
    fx.seedMainCreds();
    const piBin = path.join(fx.tmp, "bin", "pi");
    fs.writeFileSync(
      piBin,
      '#!/bin/sh\necho "re-ran the 6 contracts"\necho "sabotage both directions ok"\necho "PASS"\n',
    );
    fs.chmodSync(piBin, 0o755);
    const hook = capture();
    withHook(fx, hook);
    try {
      const r = await fx.run(["reviewer", "bare-pass task"]);
      expect(r.code).toBe(0);
      expect(hook.posts).toHaveLength(1);
      expect(hook.posts[0].embeds[0].title).toMatch(/^reviewer · PASS · /);
    } finally {
      withoutHook(fx);
      hook.close();
    }
  }, 60_000);

  test("class B: reviewer rc=0 with 'PASS' mid-output (not final) -> still FAIL (#101d)", async () => {
    // The bare-PASS fallback must only match a trailing line - a 'PASS'
    // mentioned mid-review with no final verdict is still incomplete.
    const fx = fixture();
    fx.seedMainCreds();
    const piBin = path.join(fx.tmp, "bin", "pi");
    fs.writeFileSync(
      piBin,
      '#!/bin/sh\necho "the result looks PASS-worthy"\necho "but I found an open bug"\necho "leaving it for a follow-up"\n',
    );
    fs.chmodSync(piBin, 0o755);
    const hook = capture();
    withHook(fx, hook);
    try {
      const r = await fx.run(["reviewer", "mid-pass task"]);
      expect(r.code).toBe(0);
      expect(hook.posts).toHaveLength(1);
      expect(hook.posts[0].embeds[0].title).toMatch(
        /^reviewer · FAIL \(rc=0\) · /,
      );
      expect(fieldVal(hook.posts[0], "result")).toContain("no VERDICT line");
    } finally {
      withoutHook(fx);
      hook.close();
    }
  }, 60_000);

  test("class B: reviewer rc=0 ending on '**PASS** - trailing text' (bold, not bare) -> PASS (#101e)", async () => {
    // Franky's PR #2216 reviewer ended on '**PASS** - merge conditions on the
    // reviewer side are met'. The #101d bare-line fallback is end-anchored so
    // the trailing text made it miss. A bolded **PASS**/**FAIL** token is a
    // deliberate verdict marker (distinct from prose like 'the test FAILED
    // badly'), so accept it even with trailing text.
    const fx = fixture();
    fx.seedMainCreds();
    const piBin = path.join(fx.tmp, "bin", "pi");
    fs.writeFileSync(
      piBin,
      '#!/bin/sh\necho "re-ran the contracts"\necho "sabotage both directions ok"\necho "**PASS** - merge conditions on the reviewer side are met"\n',
    );
    fs.chmodSync(piBin, 0o755);
    const hook = capture();
    withHook(fx, hook);
    try {
      const r = await fx.run(["reviewer", "bold-pass task"]);
      expect(r.code).toBe(0);
      expect(hook.posts).toHaveLength(1);
      expect(hook.posts[0].embeds[0].title).toMatch(/^reviewer · PASS · /);
    } finally {
      withoutHook(fx);
      hook.close();
    }
  }, 60_000);

  test("class B: reviewer rc=0 with '**FAIL**: N contracts broken' (bold + trailing) -> FAIL (#101e)", async () => {
    const fx = fixture();
    fx.seedMainCreds();
    const piBin = path.join(fx.tmp, "bin", "pi");
    fs.writeFileSync(
      piBin,
      '#!/bin/sh\necho "checked the diff"\necho "**FAIL**: 3 contracts broken"\n',
    );
    fs.chmodSync(piBin, 0o755);
    const hook = capture();
    withHook(fx, hook);
    try {
      const r = await fx.run(["reviewer", "bold-fail task"]);
      expect(r.code).toBe(0);
      expect(hook.posts).toHaveLength(1);
      // A found verdict (FAIL) titles as 'reviewer · FAIL · <dur>' (no rc=0
      // suffix - that's only for the 'no VERDICT line' false-FAIL case).
      expect(hook.posts[0].embeds[0].title).toMatch(/^reviewer · FAIL · /);
      expect(hook.posts[0].embeds[0].title).not.toContain("no VERDICT");
    } finally {
      withoutHook(fx);
      hook.close();
    }
  }, 60_000);

  test("class B: reviewer rc=0 with prose 'FAILED' (no bold) and no verdict -> still FAIL (#101e)", async () => {
    // The bold fallback must not match non-bold prose. 'the test FAILED badly'
    // has no ** markers, so with no other verdict the review is incomplete.
    const fx = fixture();
    fx.seedMainCreds();
    const piBin = path.join(fx.tmp, "bin", "pi");
    fs.writeFileSync(
      piBin,
      '#!/bin/sh\necho "ran the suite"\necho "the test FAILED badly"\necho "no conclusion reached"\n',
    );
    fs.chmodSync(piBin, 0o755);
    const hook = capture();
    withHook(fx, hook);
    try {
      const r = await fx.run(["reviewer", "prose-failed task"]);
      expect(r.code).toBe(0);
      expect(hook.posts).toHaveLength(1);
      expect(hook.posts[0].embeds[0].title).toMatch(
        /^reviewer · FAIL \(rc=0\) · /,
      );
      expect(fieldVal(hook.posts[0], "result")).toContain("no VERDICT line");
    } finally {
      withoutHook(fx);
      hook.close();
    }
  }, 60_000);

  test("class A: silent x2 brief carries the actual stderr reason; err.log kept", async () => {
    const fx = fixture();
    fx.seedMainCreds();
    const piBin = path.join(fx.tmp, "bin", "pi");
    fs.writeFileSync(
      piBin,
      '#!/bin/sh\nsleep 1\necho "Error: read ECONNRESET 127.0.0.1:8081" >&2\nexit 1\n',
    );
    fs.chmodSync(piBin, 0o755);
    const hook = capture();
    withHook(fx, hook);
    try {
      const r = await fx.run(["worker", "silent-reason task"]);
      expect(r.code).toBe(1);
      const runId = runIdOf(fx);
      expect(hook.posts).toHaveLength(1);
      expect(hook.posts[0].embeds[0].title).toMatch(
        /^worker · FAIL \(rc=1\) · /,
      );
      const brief = fieldVal(hook.posts[0], "result") as string;
      expect(brief).toContain("silent death x2");
      expect(brief).toContain("ECONNRESET");
      // err.log kept for forensics; out.md present but blank, rc recorded
      expect(
        fs.existsSync(path.join(artDir(fx), `pi-bg-${runId}-err.log`)),
      ).toBe(true);
      expect(
        fs
          .readFileSync(path.join(artDir(fx), `pi-bg-${runId}-out.md`), "utf8")
          .trim(),
      ).toBe("");
      expect(
        fs
          .readFileSync(path.join(artDir(fx), `pi-bg-${runId}-rc`), "utf8")
          .trim(),
      ).toBe("1");
    } finally {
      withoutHook(fx);
      hook.close();
    }
  }, 60_000);
});

describe("#52: heartbeat (hb artifact, created at dispatch, gone on exit)", () => {
  test("hb file exists mid-run, ticks, and is removed on exit; no orphan child", async () => {
    const fx = fixture();
    fx.seedMainCreds();
    const art = path.join(fx.tmp, "art");
    fx.env.PI_BG_TMPDIR = art;
    fx.env.PI_BG_HB_INTERVAL = "1"; // fast ticks for the test
    fs.mkdirSync(art, { recursive: true });
    fs.writeFileSync(
      path.join(fx.tmp, "bin", "pi"),
      "#!/bin/sh\nsleep 3\necho pi-run-ok\n",
    );
    const p = spawn(["bash", PI_BG, "worker", "heartbeat probe task"], {
      env: fx.env,
      cwd: fx.tmp,
      stdout: "pipe",
      stderr: "pipe",
    });
    try {
      // hb file appears while the run is in flight
      let hb = "";
      const t0 = Date.now();
      while (!hb && Date.now() - t0 < 8000) {
        const c = fs.readdirSync(art).filter((f) => f.endsWith("-hb"));
        if (c.length === 1) hb = path.join(art, c[0]);
        await Bun.sleep(100);
      }
      expect(hb).toMatch(/pi-bg-\d{8}-\d{6}-\d+-hb$/);
      // it ticks: mtime advances within two intervals
      const m1 = fs.statSync(hb).mtimeMs;
      await Bun.sleep(2300);
      const m2 = fs.statSync(hb).mtimeMs;
      expect(m2).toBeGreaterThan(m1);
      const [out, err] = await Promise.all([
        new Response(p.stdout).text(),
        new Response(p.stderr).text(),
      ]);
      const code = await p.exited;
      expect(code).toBe(0);
      expect(out).toContain("pi-run-ok");
      expect(err).not.toContain("traceback");
      // exit trap removed the hb file...
      expect(fs.existsSync(hb)).toBe(false);
      // ...and there is no orphan hb child left (a live child would re-touch
      // the file within its 1s interval and show up in /proc)
      await Bun.sleep(1500);
      expect(fs.existsSync(hb)).toBe(false);
      expect(liveProcWith("heartbeat probe task")).toBe(false);
    } finally {
      try {
        process.kill(-p.pid, "SIGKILL");
      } catch {
        /* already dead */
      }
    }
  }, 40_000);
});

describe("#52: hb-from-birth (launcher window is liveness-covered)", () => {
  // The touch child used to fork AFTER the cgroup escape, so the launcher
  // window (git worktree add on a big repo, escape, profile doctor) had no
  // periodic touches: a live ticket in that window > STALL_MIN looked
  // STALLED (worktree sweep: live cgroup + stale hb) or its stale hb hid
  // the DEAD verdict (cwd sweep judges on hb age). The child now forks at
  // ticket creation, is adopted across the snapshot re-exec via
  // PI_BG_HB_PID, and joins the ticket cgroup after the escape.

  const gitInit = (fx: { tmp: string; env: Record<string, string> }) => {
    const sh = (cmd: string) =>
      execSync(cmd, { cwd: fx.tmp, env: { ...fx.env }, stdio: "pipe" });
    sh("git init -b main");
    sh("git config user.email t@t");
    sh("git config user.name t");
    fs.writeFileSync(path.join(fx.tmp, "a.txt"), "a\n");
    sh("git add a.txt");
    sh("git commit -m init");
  };

  const pidAlive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };

  test("slow `git worktree add`: the hb ticks inside the launcher window", async () => {
    const fx = fixture();
    fx.seedMainCreds();
    const art = path.join(fx.tmp, "art");
    fx.env.PI_BG_TMPDIR = art;
    fx.env.PI_BG_HB_INTERVAL = "1";
    fx.env.PI_BG_NOSNAP = "1"; // skip the re-exec; this test is about the window
    fs.mkdirSync(art, { recursive: true });
    gitInit(fx);
    // fake git: `worktree add` sleeps 4s and stamps the window bounds
    const gitBin = path.join(fx.tmp, "bin", "git");
    fs.writeFileSync(
      gitBin,
      [
        "#!/bin/sh",
        'if [ "$1" = "worktree" ] && [ "$2" = "add" ]; then',
        `  date +%s%3N > ${path.join(fx.tmp, "git-start")}`,
        "  sleep 4",
        `  date +%s%3N > ${path.join(fx.tmp, "git-end")}`,
        "fi",
        'exec /usr/bin/git "$@"',
        "",
      ].join("\n"),
    );
    fs.chmodSync(gitBin, 0o755);
    const p = spawn(
      ["bash", PI_BG, "worker", "--worktree", "main", "slow add task"],
      { env: fx.env, cwd: fx.tmp, stdout: "pipe", stderr: "pipe" },
    );
    // record every observed hb touch (mtime change) until the file is
    // gone (the exit trap removes it - run finished)
    const ticks: number[] = [];
    let lastM = 0;
    const poll = (async () => {
      const t0 = Date.now();
      let goneSince = 0;
      while (Date.now() - t0 < 30000) {
        let present = false;
        try {
          const files = fs.readdirSync(art).filter((f) => f.endsWith("-hb"));
          if (files.length === 1) {
            present = true;
            const m = fs.statSync(path.join(art, files[0])).mtimeMs;
            if (m !== lastM) {
              ticks.push(Date.now());
              lastM = m;
            }
          }
        } catch {
          /* dir not there yet */
        }
        if (!present) {
          goneSince = goneSince || Date.now();
          if (Date.now() - goneSince > 2000) break; // gone 2s = child dead too
        } else {
          goneSince = 0;
        }
        await Bun.sleep(150);
      }
    })();
    try {
      const [out, err] = await Promise.all([
        new Response(p.stdout).text(),
        new Response(p.stderr).text(),
      ]);
      const code = await p.exited;
      if (code !== 0) {
        throw new Error(`pi-bg exited ${code}\nOUT: ${out}\nERR: ${err}`);
      }
      expect(out).toContain("pi-run-ok");
      await poll;
      const gs = Number(
        fs.readFileSync(path.join(fx.tmp, "git-start"), "utf8"),
      );
      const ge = Number(fs.readFileSync(path.join(fx.tmp, "git-end"), "utf8"));
      // at least one tick strictly inside the 4s git window (1s interval
      // -> 2+ expected); the birth touch predates the window, the pi
      // phase postdates it - neither can fake this
      const inWin = ticks.filter((t) => t > gs + 400 && t < ge - 400);
      expect(inWin.length).toBeGreaterThanOrEqual(2);
    } finally {
      try {
        process.kill(-p.pid, "SIGKILL");
      } catch {
        /* already dead */
      }
    }
  }, 60_000);

  test("snapshot re-exec: one hb child, joined to the ticket cgroup", async () => {
    const fx = fixture();
    fx.seedMainCreds();
    const art = path.join(fx.tmp, "art");
    fx.env.PI_BG_TMPDIR = art;
    fs.mkdirSync(art, { recursive: true });
    // pi stub: while alive (inside the ticket cgroup) it copies the
    // ticket's cgroup.procs (fake root: a plain file), liveness-checks
    // every pid in it (the hb child must be alive DURING the run; after
    // the run the wrapper's exit trap has reaped it), and records its
    // own PPID (the wrapper)
    const piBin = path.join(fx.tmp, "bin", "pi");
    fs.writeFileSync(
      piBin,
      [
        "#!/bin/sh",
        "sleep 1",
        'for f in "$PI_BG_CG_ROOT"/pi-bg/*/cgroup.procs; do',
        '  [ -f "$f" ] || continue',
        `  cp "$f" ${path.join(fx.tmp, "cg-copy")}`,
        `  : > ${path.join(fx.tmp, "cg-live")}`,
        '  for pid in $(cat "$f"); do',
        `    kill -0 "$pid" 2>/dev/null && echo "$pid" >> ${path.join(fx.tmp, "cg-live")}`,
        "  done",
        `  echo "$PPID" > ${path.join(fx.tmp, "cg-ppid")}`,
        "done",
        "echo pi-run-ok",
        "",
      ].join("\n"),
    );
    fs.chmodSync(piBin, 0o755);
    const r = await fx.run(["worker", "re-exec hb task"]);
    expect(r.code).toBe(0);
    // the snapshot re-exec happened (default: PI_BG_NOSNAP unset) and the
    // re-exec'd process adopted the child forked by its first incarnation
    expect(fs.existsSync(path.join(fx.tmp, "cg-copy"))).toBe(true);
    const copy = fs
      .readFileSync(path.join(fx.tmp, "cg-copy"), "utf8")
      .trim()
      .split("\n");
    // exactly wrapper + hb child: no double fork (adoption), no missing
    // join
    expect(copy).toHaveLength(2);
    const wrapper = Number(
      fs.readFileSync(path.join(fx.tmp, "cg-ppid"), "utf8").trim(),
    );
    expect(copy).toContain(String(wrapper));
    const child = Number(copy.find((x) => x !== String(wrapper)));
    // the child was alive during the run (it is the hb toucher) and reaped
    // by the wrapper's exit trap after it (no orphan re-touching a deleted
    // hb file)
    const live = fs
      .readFileSync(path.join(fx.tmp, "cg-live"), "utf8")
      .trim()
      .split("\n")
      .filter(Boolean);
    expect(live).toContain(String(child));
    await Bun.sleep(500);
    expect(pidAlive(child)).toBe(false);
  }, 40_000);

  test("nested dispatch: the child FORKS its own hb child (no adoption of the parent's)", async () => {
    const fx = fixture();
    fx.seedMainCreds();
    const art = path.join(fx.tmp, "art");
    fx.env.PI_BG_TMPDIR = art;
    fx.env.PI_BG_HB_INTERVAL = "1"; // fast ticks for the mtime asserts
    // parent WITHOUT the snapshot re-exec: the leak under test is
    // PI_BG_HB_PID in the pi env (the same leak the fixture
    // hermeticizes). The snapshot-shaped leak also carries
    // PI_BG_RUN_ID/PI_BG_SNAP into the child - a separate identity
    // issue, not this one (review #183 F2 repro shape).
    fx.env.PI_BG_NOSNAP = "1";
    fs.mkdirSync(art, { recursive: true });
    // nested launcher on the pi PATH
    fs.symlinkSync(PI_BG, path.join(fx.tmp, "bin", "jarate-bg"));
    const stage = path.join(fx.tmp, "stage");
    // pi stub: first invocation = parent (launches the child + asserts),
    // second = child (plain run)
    const piBin = path.join(fx.tmp, "bin", "pi");
    fs.writeFileSync(
      piBin,
      [
        "#!/bin/sh",
        `if [ ! -f ${stage} ]; then`,
        `  echo parent > ${stage}`,
        `  echo "\${PI_BG_HB_PID:-}" > ${fx.tmp}/hbpid-parent`,
        `  i=0`,
        `  while [ "$(ls ${art} | grep -c -- '-hb$')" -lt 1 ] && [ $i -lt 100 ]; do sleep 0.1; i=$((i+1)); done`,
        `  for f in ${art}/*-hb; do [ -f "$f" ] && basename "$f" > ${fx.tmp}/hbfile-parent; done`,
        `  jarate-bg worker "nested hb task" > ${fx.tmp}/child-out 2>&1 &`,
        `  cp=$!`,
        `  i=0`,
        `  while [ "$(ls ${art} | grep -c -- '-hb$')" -lt 2 ] && [ $i -lt 100 ]; do sleep 0.1; i=$((i+1)); done`,
        `  chf=`,
        `  for f in ${art}/*-hb; do [ "$(basename "$f")" != "$(cat ${fx.tmp}/hbfile-parent)" ] && chf="$f"; done`,
        `  m1=$(stat -c %Y "$chf" 2>/dev/null)`,
        `  sleep 2.5`,
        `  m2=$(stat -c %Y "$chf" 2>/dev/null)`,
        `  echo "$m1 $m2" > ${fx.tmp}/child-hb-mtimes`,
        `  wait $cp`,
        `  : > ${fx.tmp}/faults`,
        `  [ -f "$chf" ] && echo child-hb-file-left >> ${fx.tmp}/faults`,
        `  kill -0 "$(cat ${fx.tmp}/hbpid-parent)" 2>/dev/null || echo parent-hb-child-dead >> ${fx.tmp}/faults`,
        `else`,
        `  sleep 3`, // child run: outlive the parent's mtime sampling window
        `fi`,
        "echo pi-run-ok",
        "",
      ].join("\n"),
    );
    fs.chmodSync(piBin, 0o755);
    const r = await fx.run(["worker", "hb nested task"]);
    expect(r.code).toBe(0);
    // the leak is real: the parent's pi env carried PI_BG_HB_PID (an
    // empty value would make the fork trivial and the test vacuous)
    expect(
      fs.readFileSync(path.join(fx.tmp, "hbpid-parent"), "utf8").trim(),
    ).toMatch(/^\d+$/);
    // the child forked its own child: its hb file was re-touched during
    // the run (an adoption would leave it at the birth-touch mtime - the
    // adopted child touches the PARENT's file)
    const [m1, m2] = fs
      .readFileSync(path.join(fx.tmp, "child-hb-mtimes"), "utf8")
      .trim()
      .split(" ");
    expect(Number(m2)).toBeGreaterThan(Number(m1));
    // the parent's hb child survived the child's exit (an adopted child
    // would have been killed by the child's exit trap: false STALLED on
    // the healthy parent), and the child's own hb file was cleaned up
    expect(fs.readFileSync(path.join(fx.tmp, "faults"), "utf8").trim()).toBe(
      "",
    );
  }, 60_000);

  test("launch-fail: the hb child dies with the wrapper (no phantom ticket)", async () => {
    const fx = fixture();
    fx.seedMainCreds();
    const art = path.join(fx.tmp, "art");
    fx.env.PI_BG_TMPDIR = art;
    fx.env.PI_BG_HB_INTERVAL = "1";
    fs.mkdirSync(art, { recursive: true });
    gitInit(fx);
    const r = await fx.run(["worker", "--worktree", "nosuchref", "fail task"]);
    expect(r.code).toBe(3);
    // the launch-fail path removed the hb file AND its early trap killed
    // the child: a live child would re-touch the file within its 1s
    // interval (phantom live ticket in the concurrency cap)
    const hbFiles = () => fs.readdirSync(art).filter((f) => f.endsWith("-hb"));
    expect(hbFiles()).toHaveLength(0);
    await Bun.sleep(2500);
    expect(hbFiles()).toHaveLength(0);
  }, 40_000);
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

describe("#51: one-shot run-state lifecycle (record state + prune)", () => {
  test("completed run: record marked done with finished ts; initial fields intact", async () => {
    const fx = fixture();
    fx.seedMainCreds();
    const r = await fx.run(["worker", "record done task"]);
    expect(r.code).toBe(0);
    const recs = fx.records();
    expect(recs).toHaveLength(1);
    expect(recs[0].state).toBe("done");
    expect(recs[0].finished).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    expect(recs[0].started).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    expect(recs[0].profile).toBe("worker");
    expect(recs[0].delivery).toBe("none");
  });

  test("killed run: wrapper traps done, pi-bg-kill finalizes state=cancelled (one terminal embed)", async () => {
    const fx = fixture();
    fx.seedMainCreds();
    const art = path.join(fx.tmp, "art");
    fx.env.PI_BG_TMPDIR = art;
    fx.env.PI_BG_HB_INTERVAL = "1";
    // webhook on: a manual kill must produce EXACTLY ONE terminal embed
    // (the CANCELLED post) - pre-#51 a graceful TERM also fired the
    // wrapper-trap DIED post for the same cancellation
    const posts: any[] = [];
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: async (req) => {
        if (req.method === "POST") posts.push((await req.json()) as any);
        return new Response("ok", { status: 200 });
      },
    });
    fx.env.PI_DISPATCH_WEBHOOK = `http://127.0.0.1:${server.port}/hook`;
    fx.env.PI_BG_WB_BACKOFF = "0";
    fs.mkdirSync(art, { recursive: true });
    // audit dispatch-core P10: the fake pi writes a START marker as its
    // first act. The wrapper registers its EXIT/TERM traps BEFORE the pi
    // spawn loop, so the marker proving pi started also proves the traps
    // are armed - killing on the marker (not on the run record, which is
    // created earlier, before the traps) is what makes the DIED-suppression
    // assertion below non-vacuous. Pre-fix, a fast kill could land between
    // record creation and trap registration: the wrapper died untrapped,
    // no DIED post ever, and the test passed without exercising the
    // kill-marker branch.
    fs.writeFileSync(
      path.join(fx.tmp, "bin", "pi"),
      `#!/bin/sh\ntouch "$PI_BG_TEST_START" 2>/dev/null || true\nsleep 30\necho pi-run-ok\n`,
    );
    const startMarker = path.join(art, "test-start");
    fx.env.PI_BG_TEST_START = startMarker;
    const p = spawn(["bash", PI_BG, "worker", "kill record task"], {
      env: fx.env,
      cwd: fx.tmp,
      stdout: "pipe",
      stderr: "pipe",
    });
    try {
      const recDir = fx.env.PI_DISPATCH_RECORD_DIR as string;
      let rec: any = null;
      const t0 = Date.now();
      while (!rec && Date.now() - t0 < 15000) {
        let c: string[] = [];
        try {
          c = fs.readdirSync(recDir).filter((f) => f.endsWith(".json"));
        } catch {
          c = []; // the record dir is created by pi-bg after spawn
        }
        if (c.length === 1)
          rec = JSON.parse(fs.readFileSync(path.join(recDir, c[0]), "utf8"));
        await Bun.sleep(100);
      }
      expect(rec?.run).toMatch(/^\d{8}-\d{6}-\d+$/);
      // wait for the start marker (traps armed), then a short settle so
      // the kill lands while the wrapper sits in its wait loop
      const m0 = Date.now();
      while (!fs.existsSync(startMarker) && Date.now() - m0 < 15000) {
        await Bun.sleep(100);
      }
      expect(fs.existsSync(startMarker)).toBe(true);
      await Bun.sleep(300);
      const kenv = { ...fx.env, PI_BG_KILL_WAIT: "1" } as Record<
        string,
        string
      >;
      const k = await runScript(KILL, [rec.run], kenv, fx.tmp);
      expect(k.code).toBe(0);
      expect(k.out).toContain(`killed ${rec.run} after`);
      const code = await p.exited;
      expect(code).toBe(143);
      const rec2 = JSON.parse(
        fs.readFileSync(path.join(recDir, `pi-bg-${rec.run}.json`), "utf8"),
      );
      // #51 CANCELLED class: a manual kill ends the record cancelled
      // (distinct from state=killed, the watchdog/launch-fail audit path)
      expect(rec2.state).toBe("cancelled");
      expect(rec2.finished).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
      // kill marker present (the watchdog skips this ticket)
      expect(fs.existsSync(path.join(art, `pi-bg-${rec.run}-killed`))).toBe(
        true,
      );
      // exactly ONE terminal embed: the CANCELLED post, no DIED double
      expect(posts).toHaveLength(1);
      expect(posts[0].embeds[0].title).toBe(
        `pi-bg ${rec.run} \u00b7 CANCELLED`,
      );
      // hb child cleaned up by the wrapper trap (no orphan re-touching it)
      await Bun.sleep(1500);
      expect(fs.existsSync(path.join(art, `pi-bg-${rec.run}-hb`))).toBe(false);
      server.stop(true);
    } finally {
      try {
        process.kill(-p.pid, "SIGKILL");
      } catch {
        /* already dead */
      }
    }
  }, 40_000);

  // ── watchdog prune of aged run records ─────────────────────────────────────

  const plantRecord = (
    fx: ReturnType<typeof wdFixtureX>,
    t: string,
    daysAgo: number,
  ): string => {
    const recDir = path.join(fx.tmp, "rec");
    fs.mkdirSync(recDir, { recursive: true });
    const rf = path.join(recDir, `pi-bg-${t}.json`);
    fs.writeFileSync(
      rf,
      JSON.stringify({ run: t, profile: "worker", state: "done" }),
    );
    const old = new Date(Date.now() - daysAgo * 86400 * 1000);
    fs.utimesSync(rf, old, old);
    for (const suf of ["-raw.out", "-hb", "-killed"]) {
      fs.writeFileSync(path.join(fx.art, `pi-bg-${t}${suf}`), "x");
    }
    return recDir;
  };

  test("aged record (dead ticket): record + artifact files deleted", async () => {
    const fx = wdFixtureX(20);
    const t = TID(20);
    const recDir = plantRecord(fx, t, 8); // past the default 7 days
    const r = await fx.run([], { PI_DISPATCH_RECORD_DIR: recDir });
    expect(r.code).toBe(0);
    expect(r.out).toContain(`pruned run state ${t}`);
    expect(fs.existsSync(path.join(recDir, `pi-bg-${t}.json`))).toBe(false);
    for (const suf of ["-raw.out", "-hb", "-killed"]) {
      expect(fs.existsSync(path.join(fx.art, `pi-bg-${t}${suf}`))).toBe(false);
    }
  }, 60_000);

  test("aged record, LIVE ticket: kept (record + artifacts)", async () => {
    const fx = wdFixtureX(21);
    const t = TID(21);
    const recDir = plantRecord(fx, t, 8);
    const cg = path.join(fx.tmp, "cg", "pi-bg", t);
    fs.mkdirSync(cg, { recursive: true });
    fs.writeFileSync(path.join(cg, "cgroup.procs"), `${process.pid}\n`);
    const r = await fx.run([], { PI_DISPATCH_RECORD_DIR: recDir });
    expect(r.out).not.toContain(`pruned run state ${t}`);
    expect(fs.existsSync(path.join(recDir, `pi-bg-${t}.json`))).toBe(true);
    expect(fs.existsSync(path.join(fx.art, `pi-bg-${t}-raw.out`))).toBe(true);
  }, 60_000);

  test("fresh record (dead ticket): kept", async () => {
    const fx = wdFixtureX(22);
    const t = TID(22);
    const recDir = plantRecord(fx, t, 0.1); // ~2.4 h old
    const r = await fx.run([], { PI_DISPATCH_RECORD_DIR: recDir });
    expect(r.out).not.toContain(`pruned run state ${t}`);
    expect(fs.existsSync(path.join(recDir, `pi-bg-${t}.json`))).toBe(true);
  }, 60_000);

  test("PI_BG_PRUNE_DAYS=14: 8-day-old record kept", async () => {
    const fx = wdFixtureX(23);
    const t = TID(23);
    const recDir = plantRecord(fx, t, 8);
    const r = await fx.run([], {
      PI_DISPATCH_RECORD_DIR: recDir,
      PI_BG_PRUNE_DAYS: "14",
    });
    expect(r.out).not.toContain(`pruned run state ${t}`);
    expect(fs.existsSync(path.join(recDir, `pi-bg-${t}.json`))).toBe(true);
  }, 60_000);

  test("--dry-run: would-prune reported, files stay", async () => {
    const fx = wdFixtureX(24);
    const t = TID(24);
    const recDir = plantRecord(fx, t, 8);
    const r = await fx.run(["--dry-run"], { PI_DISPATCH_RECORD_DIR: recDir });
    expect(r.out).toContain(`would prune run state ${t}`);
    expect(fs.existsSync(path.join(recDir, `pi-bg-${t}.json`))).toBe(true);
    expect(fs.existsSync(path.join(fx.art, `pi-bg-${t}-raw.out`))).toBe(true);
  }, 60_000);
});

describe("deploy-swap guard (2026-09-15): wrapper survives a script swap mid-run", () => {
  // Ticket 20260915-011025-3740387 (and 266215): a jarate deploy (git pull
  // in the checkout that ~/scripts/pi-bg symlinks into) replaced
  // dispatch/pi-bg while a wrapper was parked in a long `wait`; bash
  // re-opens the script by name on its next read -> stale offset in the
  // new content -> syntax error at `done` (exit 2 = bash's own
  // syntax-error code). The review was complete (commit + report on disk)
  // but the wrapper never posted its callback and the watchdog re-flagged
  // the ticket DEAD. Fix: each run execs a per-run HARD LINK to the
  // startup inode (git replaces the checkout path; the link keeps the
  // original file alive and the name stable for the whole run).
  const collect1 = async (p: ReturnType<typeof spawn>) => {
    const [out, err] = await Promise.all([
      new Response(p.stdout).text(),
      new Response(p.stderr).text(),
    ]);
    const code = await p.exited;
    return { code, out, err };
  };

  const launchViaLink = (
    fx: { tmp: string; env: Record<string, string> },
    extraEnv: Record<string, string> = {},
  ) => {
    const real = path.join(fx.tmp, "pi-bg-real");
    fs.copyFileSync(PI_BG, real);
    const link = path.join(fx.tmp, "bin", "pi-bg");
    fs.symlinkSync(real, link);
    const s = spawn(["bash", link, "worker", "deploy swap test"], {
      env: { ...fx.env, ...extraEnv },
      cwd: fx.tmp,
      stdout: "pipe",
      stderr: "pipe",
    });
    return { real, s };
  };

  // git-style replacement with a 4-line mid-file insert (the bee0a333 cap
  // fix shifted the live script the same way during the incident)
  const swapScript = (real: string) => {
    const src = fs.readFileSync(real, "utf8").split("\n");
    src.splice(
      Math.floor(src.length / 2),
      0,
      "# shifted 1",
      "# shifted 2",
      "# shifted 3",
      "# shifted 4",
    );
    const tmpf = `${real}.new`;
    fs.writeFileSync(tmpf, src.join("\n"));
    fs.renameSync(tmpf, real);
  };

  const sleepPi = (fx: { tmp: string }, seconds: number) => {
    fs.writeFileSync(
      path.join(fx.tmp, "bin", "pi"),
      `#!/bin/sh\nsleep ${seconds}\necho pi-run-ok\n`,
    );
  };

  const kill1 = (s: ReturnType<typeof spawn>, tmp: string) => {
    try {
      s.kill("TERM");
    } catch {
      /* already dead */
    }
    try {
      execSync(`pkill -f '^/bin/sh ${tmp}/bin/pi ' || true`, {
        stdio: "ignore",
      });
    } catch {
      /* nothing matched */
    }
  };

  const scriptArg = (pid: number) => {
    try {
      return (
        fs
          .readFileSync(`/proc/${pid}/cmdline`, "utf8")
          .split("\0")
          .filter(Boolean)[1] ?? ""
      );
    } catch {
      return "";
    }
  };

  test("wrapper runs from its per-run snapshot; swap + run still complete", async () => {
    const fx = fixture();
    fx.seedMainCreds();
    sleepPi(fx, 3);
    const { real, s } = launchViaLink(fx);
    try {
      // the snap exec happens at startup; poll until argv shows it
      const t0 = Date.now();
      while (Date.now() - t0 < 8000) {
        if (scriptArg(s.pid).includes("/snap-")) break;
        await Bun.sleep(100);
      }
      expect(scriptArg(s.pid)).toMatch(/\/(snap-[^/]+\/pi-bg)$/);
      // deploy: replace the checkout-side target (git style, new inode)
      // AND rewrite it in place with a mid-file insert (editor style,
      // same inode - the 1769153 killer) while the wrapper is parked in
      // its `wait` (pi stub sleeping)
      await Bun.sleep(1000);
      swapScript(real);
      const c = fs.readFileSync(real, "utf8");
      const mid = Math.floor(c.length / 2);
      fs.writeFileSync(
        real,
        `${c.slice(0, mid)}\n# in-place shifted\n${c.slice(mid)}`,
      );
      const r = await collect1(s);
      expect(r.code).toBe(0);
      expect(r.out).toContain("pi-run-ok");
      expect(r.err).not.toMatch(/syntax error/);
      // snapshot cleaned by the exit trap
      expect(
        fs
          .readdirSync(`${fx.env.HOME}/.pi-bg-art`)
          .filter((f) => f.startsWith("snap-")),
      ).toHaveLength(0);
    } finally {
      kill1(s, fx.tmp);
    }
  }, 30_000);

  test("PI_BG_NOSNAP=1: wrapper stays on the original path (mechanism off)", async () => {
    const fx = fixture();
    fx.seedMainCreds();
    sleepPi(fx, 3);
    const { s } = launchViaLink(fx, { PI_BG_NOSNAP: "1" });
    try {
      const t0 = Date.now();
      while (Date.now() - t0 < 8000 && scriptArg(s.pid) === "")
        await Bun.sleep(100);
      expect(scriptArg(s.pid)).not.toContain("/snap-");
      expect(scriptArg(s.pid)).toContain("pi-bg");
      const r = await collect1(s);
      expect(r.code).toBe(0);
      expect(r.out).toContain("pi-run-ok");
    } finally {
      kill1(s, fx.tmp);
    }
  }, 30_000);
});

/**
 * --project (2026-09-18): project tag for invoice itemisation. The run
 * record carries "project": tag; at exit the run's session tokens +
 * OpenRouter-list cost (24h price cache, bounded curl) are attributed to
 * the record; the callback frame gets a `│ pj` line LAST (1.8k truncation
 * eats the tail, never the identity header; cost null -> "$-"). Never
 * blocks or fails the run.
 */
describe("--project: tag, cost capture, callback line (2026-09-18)", () => {
  // mirror of the script's session slug: --<path minus leading />-separated--
  const sessSlug = (p: string) =>
    `--${p.replace(/^\//, "").replaceAll("/", "-")}--`;

  // pi stub that writes an assistant-usage session file AT RUN TIME (after
  // the wrapper's run_start_epoch, so -newermt "@epoch" finds it)
  const sessionPi = (
    fx: { tmp: string; home: string },
    usage: Record<string, number>,
  ) => {
    const sess = path.join(
      fx.home,
      ".pi",
      "agent-worker",
      "sessions",
      sessSlug(fx.tmp),
    );
    const line = JSON.stringify({
      type: "message",
      message: { role: "assistant", usage },
    });
    const piBin = path.join(fx.tmp, "bin", "pi");
    fs.writeFileSync(
      piBin,
      [
        "#!/bin/sh",
        `mkdir -p ${JSON.stringify(sess)}`,
        `printf '%s\\n' ${JSON.stringify(line)} > ${JSON.stringify(
          path.join(sess, "s.jsonl"),
        )}`,
        "echo pi-run-ok",
        "",
      ].join("\n"),
    );
    fs.chmodSync(piBin, 0o755);
  };

  // curl stub: canned OpenRouter pricing for the price URL, real curl for
  // everything else (webhook capture keeps working). "malformed" =
  // well-formed fetch, malformed model list (non-dict entries, null ids)
  const curlStub = (
    fx: { tmp: string },
    mode: "canned" | "fail" | "malformed",
  ) => {
    const p = path.join(fx.tmp, "bin", "curl");
    const canned =
      '{"data":[{"id":"qwen/qwen3.8-27b","pricing":{"prompt":"0.000001","completion":"0.000002","input_cache_read":"0.0000001","input_cache_write":"0.0000002"}}]}';
    const malformed =
      '{"data":[null,42,{"id":null},"qwen/qwen3.8-27b",{"pricing":{"prompt":"1"}}]}';
    const body =
      mode === "fail"
        ? `#!/bin/sh
for a in "$@"; do
  case "$a" in
    http://prices.local/*) exit 7 ;;
  esac
done
exec /usr/bin/curl "$@"`
        : `#!/bin/sh
for a in "$@"; do
  case "$a" in
    http://prices.local/*)
      printf '%s' '${mode === "malformed" ? malformed : canned}'
      exit 0
      ;;
  esac
done
exec /usr/bin/curl "$@"`;
    fs.writeFileSync(p, `${body}\n`);
    fs.chmodSync(p, 0o755);
  };

  // 110*1e-6 + 54*2e-6 + 22*1e-7 + 6*2e-7 = 0.0002214
  const USAGE = { input: 110, output: 54, cacheRead: 22, cacheWrite: 6 };
  const PRICE_TS = (hAgo = 0) =>
    new Date(Date.now() - hAgo * 3600 * 1000)
      .toISOString()
      .replace(/\.\d{3}Z$/, "Z");

  const capture = () => {
    const posts: Array<{ embeds: any[] }> = [];
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

  test("record carries the tag; an untagged run gets project null", async () => {
    const fx = fixture();
    fx.seedMainCreds();
    const r = await fx.run(["worker", "--project", "myproj", "tagged task"]);
    expect(r.code).toBe(0);
    expect(fx.records()[0].project).toBe("myproj");
    const r2 = await fx.run(["worker", "untagged task"]);
    expect(r2.code).toBe(0);
    const untagged = fx.records().find((c) => c.project === null);
    expect(untagged).toBeDefined();
  });

  test("usage errors: rc 2, one stderr line, no record, pi never runs", async () => {
    const fx = fixture();
    fx.seedMainCreds();
    const cases: Array<[string[], string]> = [
      [["worker", "--project"], "needs a value"],
      [["worker", "--project", "Bad_Tag", "t"], "invalid --project tag"],
      [["worker", "--project", "a", "--project", "b", "t"], "given twice"],
    ];
    for (const [args, msg] of cases) {
      const r = await fx.run(args);
      expect(r.code).toBe(2);
      expect(r.err).toContain(msg);
    }
    expect(fs.existsSync(path.join(fx.tmp, "pi-ran"))).toBe(false);
    try {
      expect(fx.records()).toHaveLength(0);
    } catch {
      /* record dir never created: also fine */
    }
  });

  test("cost capture: session usage + stubbed price -> tokens/cost/model in record; price cached 24h", async () => {
    const fx = fixture();
    fx.seedMainCreds();
    sessionPi(fx, USAGE);
    const art = path.join(fx.tmp, "art");
    fs.mkdirSync(art, { recursive: true });
    fx.env.PI_BG_TMPDIR = art;
    fx.env.PI_BG_PRICING_URL = "http://prices.local/api/v1/models";
    curlStub(fx, "canned");
    const r = await fx.run(["worker", "--project", "myproj", "cost task"]);
    expect(r.code).toBe(0);
    const rec = fx.records()[0];
    expect(rec.tokens).toEqual({
      input: 110,
      output: 54,
      cacheRead: 22,
      cacheWrite: 6,
      total: 186, // input+output+cacheRead (cacheWrite excluded, pi-token-cost convention)
    });
    expect(rec.cost_usd).toBeCloseTo(0.00022, 5);
    expect(rec.model).toBe("qwen/qwen3.8-27b");
    expect(rec.price_ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    expect(rec.price_error ?? null).toBeNull();
    // session prune (default 24h floor) must NOT delete this fresh in-test
    // transcript: cost capture just read it and it is younger than the floor
    expect(
      fs.existsSync(
        path.join(
          fx.home,
          ".pi",
          "agent-worker",
          "sessions",
          sessSlug(fx.tmp),
          "s.jsonl",
        ),
      ),
    ).toBe(true);
    // the 24h price cache was written in the shared tmpdir root
    const cache = JSON.parse(
      fs.readFileSync(path.join(art, "pi-bg-price-cache.json"), "utf8"),
    );
    expect(cache.model).toBe("qwen/qwen3.8-27b");
    expect(cache.price.prompt).toBe(1e-6);
    expect(cache.ts).toBe(rec.price_ts);
  });

  test("webhook embed: `│ pj` line LAST with the real cost; frame still 40 cols", async () => {
    const fx = fixture();
    fx.seedMainCreds();
    sessionPi(fx, USAGE);
    fx.env.PI_BG_TMPDIR = path.join(fx.tmp, "art");
    fs.mkdirSync(fx.env.PI_BG_TMPDIR, { recursive: true });
    fx.env.PI_BG_PRICING_URL = "http://prices.local/api/v1/models";
    curlStub(fx, "canned");
    const hook = capture();
    fx.env.PI_DISPATCH_WEBHOOK = hook.url;
    fx.env.PI_BG_WB_BACKOFF = "0";
    try {
      const r = await fx.run(["worker", "--project", "myproj", "embed task"]);
      expect(r.code).toBe(0);
      expect(hook.posts).toHaveLength(1);
      const em = hook.posts[0].embeds[0];
      expect(em.title).toMatch(/^worker · OK · \d+m\d{2}s$/);
      const lines = em.description.split("\n");
      expect(lines[0]).toBe("```bash");
      expect(lines.at(-2)).toBe("└");
      // project line is the LAST frame row (truncation-safe position)
      expect(lines.at(-3)).toBe("│ pj myproj · $0.00"); // 0.0002214 -> 2dp
      for (const l of lines) expect(l.length).toBeLessThanOrEqual(40);
    } finally {
      delete fx.env.PI_DISPATCH_WEBHOOK;
      delete fx.env.PI_BG_WB_BACKOFF;
      hook.close();
    }
  });

  test("offline pricing: tokens kept, cost null, price_error offline; embed $-", async () => {
    const fx = fixture();
    fx.seedMainCreds();
    sessionPi(fx, USAGE);
    fx.env.JARATE_TOKEN_COST_PRICING_OFFLINE = "1";
    const hook = capture();
    fx.env.PI_DISPATCH_WEBHOOK = hook.url;
    fx.env.PI_BG_WB_BACKOFF = "0";
    try {
      const r = await fx.run(["worker", "--project", "myproj", "offline task"]);
      expect(r.code).toBe(0);
      const rec = fx.records()[0];
      expect(rec.tokens?.total).toBe(186);
      expect(rec.cost_usd).toBeNull();
      expect(rec.price_error).toBe("offline");
      expect(rec.model).toBeNull();
      expect(rec.price_ts).toBeNull();
      expect(hook.posts[0].embeds[0].description).toContain("│ pj myproj · $-");
    } finally {
      delete fx.env.PI_DISPATCH_WEBHOOK;
      delete fx.env.PI_BG_WB_BACKOFF;
      hook.close();
    }
  });

  test("no session file (stub pi): null cost fields, run OK, embed $-", async () => {
    const fx = fixture();
    fx.seedMainCreds();
    const hook = capture();
    fx.env.PI_DISPATCH_WEBHOOK = hook.url;
    fx.env.PI_BG_WB_BACKOFF = "0";
    try {
      const r = await fx.run(["worker", "--project", "myproj", "no session"]);
      expect(r.code).toBe(0);
      const rec = fx.records()[0];
      expect(rec.tokens).toBeNull();
      expect(rec.cost_usd).toBeNull();
      expect(rec.model).toBeNull();
      expect(rec.price_ts).toBeNull();
      expect(hook.posts[0].embeds[0].description).toContain("│ pj myproj · $-");
    } finally {
      delete fx.env.PI_DISPATCH_WEBHOOK;
      delete fx.env.PI_BG_WB_BACKOFF;
      hook.close();
    }
  });

  test("fresh price cache + failing curl: cost from the cache, no fetch", async () => {
    const fx = fixture();
    fx.seedMainCreds();
    sessionPi(fx, USAGE);
    const art = path.join(fx.tmp, "art");
    fs.mkdirSync(art, { recursive: true });
    fx.env.PI_BG_TMPDIR = art;
    fx.env.PI_BG_PRICING_URL = "http://prices.local/api/v1/models";
    curlStub(fx, "fail");
    const seededTs = PRICE_TS(1); // 1h old: within the 24h window
    fs.writeFileSync(
      path.join(art, "pi-bg-price-cache.json"),
      JSON.stringify({
        model: "qwen/qwen3.8-27b",
        price: {
          prompt: 1e-6,
          completion: 2e-6,
          input_cache_read: 1e-7,
          input_cache_write: 2e-7,
        },
        ts: seededTs,
      }),
    );
    const r = await fx.run(["worker", "--project", "myproj", "cache task"]);
    expect(r.code).toBe(0);
    const rec = fx.records()[0];
    expect(rec.cost_usd).toBeCloseTo(0.00022, 5);
    expect(rec.price_ts).toBe(seededTs); // the cache's ts, not a fetch ts
    expect(rec.price_error ?? null).toBeNull();
  });

  test("stale cache + failing curl: cost null, price_error fetch failed, tokens kept", async () => {
    const fx = fixture();
    fx.seedMainCreds();
    sessionPi(fx, USAGE);
    const art = path.join(fx.tmp, "art");
    fs.mkdirSync(art, { recursive: true });
    fx.env.PI_BG_TMPDIR = art;
    fx.env.PI_BG_PRICING_URL = "http://prices.local/api/v1/models";
    curlStub(fx, "fail");
    fs.writeFileSync(
      path.join(art, "pi-bg-price-cache.json"),
      JSON.stringify({
        model: "qwen/qwen3.8-27b",
        price: { prompt: 1e-6, completion: 2e-6 },
        ts: PRICE_TS(25), // past the 24h window
      }),
    );
    const r = await fx.run(["worker", "--project", "myproj", "stale task"]);
    expect(r.code).toBe(0);
    const rec = fx.records()[0];
    expect(rec.tokens?.total).toBe(186);
    expect(rec.cost_usd).toBeNull();
    expect(rec.price_error).toBe("fetch failed");
  });

  test("corrupt run record: capture skips, never overwrites with a cost-only dict (LOW-1)", async () => {
    const fx = fixture();
    fx.seedMainCreds();
    const recDir = fx.env.PI_DISPATCH_RECORD_DIR;
    // pi stub: write the session file, then truncate the run record
    // mid-run (simulates an interrupted non-atomic record write)
    const sess = path.join(
      fx.home,
      ".pi",
      "agent-worker",
      "sessions",
      sessSlug(fx.tmp),
    );
    const line = JSON.stringify({
      type: "message",
      message: { role: "assistant", usage: USAGE },
    });
    const piBin = path.join(fx.tmp, "bin", "pi");
    fs.writeFileSync(
      piBin,
      `#!/bin/sh
mkdir -p ${JSON.stringify(sess)}
printf '%s\\n' ${JSON.stringify(line)} > ${JSON.stringify(path.join(sess, "s.jsonl"))}
find ${JSON.stringify(recDir)} -name 'pi-bg-*.json' -exec sh -c 'printf "%s" "{\\"run\\": \\"20260918" > "$1"' _ {} \\;
echo pi-run-ok
`,
    );
    fs.chmodSync(piBin, 0o755);
    const r = await fx.run([
      "worker",
      "--project",
      "myproj",
      "corrupt record task",
    ]);
    expect(r.code).toBe(0);
    const files = fs.readdirSync(recDir).filter((f) => f.endsWith(".json"));
    expect(files).toHaveLength(1);
    const after = fs.readFileSync(path.join(recDir, files[0]), "utf8");
    // the truncated content is intact: no capture (main flow or terminal
    // trap) rewrote the corrupt record as a cost-only dict
    expect(after).toBe('{"run": "20260918');
    expect(after).not.toContain("cost_usd");
  });

  test("transient price failure then success: later capture clears price_error (LOW-2)", async () => {
    const fx = fixture();
    fx.seedMainCreds();
    sessionPi(fx, USAGE);
    const art = path.join(fx.tmp, "art");
    fs.mkdirSync(art, { recursive: true });
    fx.env.PI_BG_TMPDIR = art;
    fx.env.PI_BG_PRICING_URL = "http://prices.local/api/v1/models";
    // stateful curl stub: the FIRST pricing fetch fails, the rest succeed
    // (main-flow capture = call 1, terminal-trap capture = call 2)
    const marker = path.join(fx.tmp, "price-failed-once");
    const p = path.join(fx.tmp, "bin", "curl");
    fs.writeFileSync(
      p,
      `#!/bin/sh
for a in "$@"; do
  case "$a" in
    http://prices.local/*)
      if [ -f ${JSON.stringify(marker)} ]; then
        printf '%s' '{"data":[{"id":"qwen/qwen3.8-27b","pricing":{"prompt":"0.000001","completion":"0.000002","input_cache_read":"0.0000001","input_cache_write":"0.0000002"}}]}'
        exit 0
      fi
      touch ${JSON.stringify(marker)}
      exit 7
      ;;
  esac
done
exec /usr/bin/curl "$@"`,
    );
    fs.chmodSync(p, 0o755);
    const r = await fx.run([
      "worker",
      "--project",
      "myproj",
      "transient price task",
    ]);
    expect(r.code).toBe(0);
    expect(fs.existsSync(marker)).toBe(true); // call 1 really failed
    const rec = fx.records()[0];
    expect(rec.tokens?.total).toBe(186);
    // call 2 priced the run and cleared call 1's stale price_error
    expect(rec.cost_usd).toBeCloseTo(0.00022, 5);
    expect(rec.price_error ?? null).toBeNull();
    expect(rec.model).toBe("qwen/qwen3.8-27b");
  });

  test("malformed model list: label is model-not-found, not masked fetch/parse (LOW-3)", async () => {
    const fx = fixture();
    fx.seedMainCreds();
    sessionPi(fx, USAGE);
    const art = path.join(fx.tmp, "art");
    fs.mkdirSync(art, { recursive: true });
    fx.env.PI_BG_TMPDIR = art;
    fx.env.PI_BG_PRICING_URL = "http://prices.local/api/v1/models";
    curlStub(fx, "malformed");
    const r = await fx.run([
      "worker",
      "--project",
      "myproj",
      "malformed list task",
    ]);
    expect(r.code).toBe(0);
    const rec = fx.records()[0];
    // fetch + parse succeeded; the list is just malformed (non-dict
    // entries, null ids) -> the exact failure class, not "fetch failed"
    expect(rec.price_error).toBe("model not found");
    expect(rec.cost_usd).toBeNull();
    expect(rec.tokens?.total).toBe(186); // tokens still kept
  });
});

/**
 * session prune (2026-09-23): every pi-bg worker/reviewer run left its pi
 * session .jsonl under ~/.pi/agent-<profile>/sessions/<slug>/ forever
 * (monky's box: 349MB worker + 56MB reviewer of dead transcripts). The
 * EXIT trap now drops the run's OWN transcript once it is past the age
 * floor (PI_BG_PRUNE_AGE_H, default 24h; 0 = no floor) and reaps the slug
 * dir when it is empty. Pruning is an OPT-IN (PI_BG_PRUNE_SESSIONS=1);
 * the default is KEEP (2026-09-25 incident: the old destructive default
 * deleted live sessions with ~11B tokens of billing data). 2026-10-10
 * (Andryo, Cardinal Rule: NEVER delete session files): the prune ability
 * is removed at the code level - bg_prune_session is a permanent no-op
 * regardless of any env flag. These tests pin that contract: no session
 * file may ever be deleted by the exit trap.
 */
describe("session prune: exit trap drops the run's own transcript (2026-09-23)", () => {
  // mirror of the script's session slug: --<path minus leading />-separated--
  const sessSlug = (p: string) =>
    `--${p.replace(/^\//, "").replaceAll("/", "-")}--`;
  const sessDir = (fx: { home: string; tmp: string }) =>
    path.join(fx.home, ".pi", "agent-worker", "sessions", sessSlug(fx.tmp));
  const sessFile = (fx: { home: string; tmp: string }) =>
    path.join(sessDir(fx), "s.jsonl");

  // pi stub that writes an assistant-usage session file AT RUN TIME (after
  // the wrapper's run start, so bg_session_file discovers it). `touchArg`
  // backdates the mtime; discovery then also needs PI_BG_RUN_START_EPOCH
  // backdated FURTHER (the file must stay "newer than run start").
  const sessionPi = (
    fx: { tmp: string; home: string },
    usage: Record<string, number>,
    touchArg?: string,
  ) => {
    const line = JSON.stringify({
      type: "message",
      message: { role: "assistant", usage },
    });
    const lines = [
      "#!/bin/sh",
      `mkdir -p ${JSON.stringify(sessDir(fx))}`,
      `printf '%s\\n' ${JSON.stringify(line)} > ${JSON.stringify(
        sessFile(fx),
      )}`,
    ];
    if (touchArg)
      lines.push(`touch -d '${touchArg}' ${JSON.stringify(sessFile(fx))}`);
    lines.push("echo pi-run-ok", "");
    const piBin = path.join(fx.tmp, "bin", "pi");
    fs.writeFileSync(piBin, lines.join("\n"));
    fs.chmodSync(piBin, 0o755);
  };

  const hook = () => {
    const posts: Array<{ embeds: any[] }> = [];
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

  const USAGE = { input: 100, output: 40, cacheRead: 0, cacheWrite: 0 };

  test("opt-in + N=0 (no floor): session KEPT - prune is a permanent no-op (2026-10-10)", async () => {
    const fx = fixture();
    fx.seedMainCreds();
    sessionPi(fx, USAGE);
    fx.env.PI_BG_PRUNE_AGE_H = "0";
    fx.env.PI_BG_PRUNE_SESSIONS = "1"; // opt-in is inert now: nothing may delete
    fx.env.JARATE_TOKEN_COST_PRICING_OFFLINE = "1"; // tokens only, no curl
    const h = hook();
    fx.env.PI_DISPATCH_WEBHOOK = h.url;
    fx.env.PI_BG_WB_BACKOFF = "0";
    try {
      const r = await fx.run(["worker", "--project", "myproj", "prune task"]);
      expect(r.code).toBe(0);
      // cost capture read the transcript BEFORE the (now no-op) prune: tokens in record
      expect(fx.records()[0].tokens?.total).toBe(140);
      // transcript KEPT even with opt-in + no floor: no deletion, ever
      expect(fs.existsSync(sessFile(fx))).toBe(true);
      expect(fs.existsSync(sessDir(fx))).toBe(true);
      // the run still posted its normal OK callback
      expect(h.posts).toHaveLength(1);
      expect(h.posts[0].embeds[0].title).toMatch(/^worker · OK · \d+m\d{2}s$/);
    } finally {
      delete fx.env.PI_DISPATCH_WEBHOOK;
      delete fx.env.PI_BG_WB_BACKOFF;
      delete fx.env.PI_BG_PRUNE_AGE_H;
      delete fx.env.PI_BG_PRUNE_SESSIONS;
      delete fx.env.JARATE_TOKEN_COST_PRICING_OFFLINE;
      h.close();
    }
  });

  test("fresh session younger than a high floor is kept (dir too)", async () => {
    const fx = fixture();
    fx.seedMainCreds();
    sessionPi(fx, USAGE);
    fx.env.PI_BG_PRUNE_AGE_H = "999999"; // ~114y: a fresh file never matches
    fx.env.PI_BG_PRUNE_SESSIONS = "1"; // opt in: the floor is what keeps it
    const r = await fx.run(["worker", "keep task"]);
    expect(r.code).toBe(0);
    expect(fs.existsSync(sessFile(fx))).toBe(true);
    expect(fs.existsSync(sessDir(fx))).toBe(true);
    delete fx.env.PI_BG_PRUNE_AGE_H;
    delete fx.env.PI_BG_PRUNE_SESSIONS;
  });

  test("PI_BG_KEEP_SESSION=1: session kept even with opt-in + N=0 (no floor)", async () => {
    const fx = fixture();
    fx.seedMainCreds();
    sessionPi(fx, USAGE);
    fx.env.PI_BG_PRUNE_AGE_H = "0";
    fx.env.PI_BG_PRUNE_SESSIONS = "1";
    fx.env.PI_BG_KEEP_SESSION = "1"; // keep wins over the opt-in
    const r = await fx.run(["worker", "keep session task"]);
    expect(r.code).toBe(0);
    expect(fs.existsSync(sessFile(fx))).toBe(true);
    expect(fs.existsSync(sessDir(fx))).toBe(true);
    delete fx.env.PI_BG_PRUNE_AGE_H;
    delete fx.env.PI_BG_PRUNE_SESSIONS;
    delete fx.env.PI_BG_KEEP_SESSION;
  });

  test("default (no prune env): session KEPT even with N=0 (2026-09-25 flip)", async () => {
    const fx = fixture();
    fx.seedMainCreds();
    sessionPi(fx, USAGE);
    fx.env.PI_BG_PRUNE_AGE_H = "0"; // no floor: only an opt-in could prune
    const r = await fx.run(["worker", "default keep task"]);
    expect(r.code).toBe(0);
    expect(fs.existsSync(sessFile(fx))).toBe(true);
    expect(fs.existsSync(sessDir(fx))).toBe(true);
    delete fx.env.PI_BG_PRUNE_AGE_H;
  });

  test("opt-in + old transcript: session KEPT - prune is a permanent no-op (2026-10-10)", async () => {
    const fx = fixture();
    fx.seedMainCreds();
    sessionPi(fx, USAGE, "2 days ago");
    fx.env.PI_BG_PRUNE_SESSIONS = "1"; // opt in: the no-op keeps it anyway
    // backdate the run start FURTHER than the file mtime so bg_session_file
    // still discovers it (2d old > 3d run start) while the file is past the
    // default 24h floor - and the no-op still must not delete it
    fx.env.PI_BG_RUN_START_EPOCH = String(
      Math.floor(Date.now() / 1000) - 3 * 86400,
    );
    const r = await fx.run(["worker", "old transcript task"]);
    expect(r.code).toBe(0);
    expect(fs.existsSync(sessFile(fx))).toBe(true);
    expect(fs.existsSync(sessDir(fx))).toBe(true);
    delete fx.env.PI_BG_PRUNE_SESSIONS;
    delete fx.env.PI_BG_RUN_START_EPOCH;
  });

  test("no --project: run record still gets tokens (2026-09-25 ledger fix)", async () => {
    const fx = fixture();
    fx.seedMainCreds();
    sessionPi(fx, USAGE);
    fx.env.JARATE_TOKEN_COST_PRICING_OFFLINE = "1"; // tokens only, no curl
    const r = await fx.run(["worker", "untagged cost task"]);
    expect(r.code).toBe(0);
    const rec = fx.records()[0];
    expect(rec.project).toBeNull();
    expect(rec.tokens?.total).toBe(140); // input+output (no cache in USAGE)
    delete fx.env.JARATE_TOKEN_COST_PRICING_OFFLINE;
  });

  test("no session file (plain stub pi): nothing to prune, run OK", async () => {
    const fx = fixture();
    fx.seedMainCreds();
    fx.env.PI_BG_PRUNE_AGE_H = "0";
    const r = await fx.run(["worker", "no session task"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("pi-run-ok");
    delete fx.env.PI_BG_PRUNE_AGE_H;
  });
});

describe("SIGPIPE hardening (#101 follow-up, Franky BUG-2 RCA, 2026-09-29)", () => {
  // Franky's dispatch shape: nohup jarate-bg ... 2>&1 | head -2. head -2
  // consumes the ticket + worktree banners and EXITS; the launcher's 3rd
  // stdout write (the cgroup-escape line) then hits SIGPIPE. Default bash
  // dispo = die WITHOUT running the EXIT trap: no DIED webhook, no dead
  // letter, no terminal run record, no raw.out, pi never execs. 4 tickets
  // died this way on 2026-09-29 (3944433, 1878647, 1950594,
  // 4012647/4012640); the one piped through head -3 survived. The launcher
  // now ignores SIGPIPE (trap "" PIPE after set -uo pipefail): a mis-piped
  // dispatcher degrades to lost banners, not a lost ticket.
  test("head -2 pipe: pi still execs, callback lands, record reaches done", async () => {
    const fx = fixture();
    fx.seedMainCreds();
    // webhook server: the orchestrator wake is the strongest "not lost"
    // signal, and its presence removes the no-webhook stderr warning so
    // head -2 captures exactly the ticket + worktree banners (RCA shape)
    let body: { embeds: any[] } | null = null;
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: async (req) => {
        if (req.method === "POST") body = (await req.json()) as any;
        return new Response("ok", { status: 200 });
      },
    });
    fx.env.PI_DISPATCH_WEBHOOK = `http://127.0.0.1:${server.port}/hook`;
    fx.env.PI_BG_WB_BACKOFF = "0";
    try {
      // git repo in the run cwd so --worktree works (the RCA scenario)
      const sh = (cmd: string) =>
        execSync(cmd, { cwd: fx.tmp, env: { ...fx.env }, stdio: "pipe" });
      sh("git init -b main");
      sh("git config user.email t@t");
      sh("git config user.name t");
      fs.writeFileSync(path.join(fx.tmp, "a.txt"), "a\n");
      sh("git add a.txt");
      sh("git commit -m init");
      // fake pi writes a marker (proof it exec'd) + output
      const marker = path.join(fx.tmp, "pi-ran");
      fs.writeFileSync(
        path.join(fx.tmp, "bin", "pi"),
        `#!/bin/sh\ntouch "${marker}"\necho pi-run-ok\n`,
      );
      fs.chmodSync(path.join(fx.tmp, "bin", "pi"), 0o755);

      // the mis-piped dispatcher (Franky's exact shape; nohup elided -
      // stdin/stdout are the pipe either way, and the #144 guard is
      // bypassed via the fixture's PI_BG_ALLOW_FOREGROUND). bash -c
      // waits for the launcher (setsid re-exec does not fork: not a
      // group leader), so p.exited covers the whole run.
      const p = spawn(
        [
          "bash",
          "-c",
          `bash "${PI_BG}" worker --worktree "sigpipe task" 2>&1 | head -2`,
        ],
        { env: fx.env, cwd: fx.tmp, stdout: "pipe", stderr: "pipe" },
      );
      const [out] = await Promise.all([
        new Response(p.stdout).text(),
        new Response(p.stderr).text(),
      ]);
      const code = await p.exited;
      expect(code).toBe(0);

      // head -2 captured exactly the 2 banners, then closed the pipe
      const lines = out.trim().split("\n");
      expect(lines).toHaveLength(2);
      expect(lines[0]).toMatch(
        /^\[pi-bg\] ticket \d{8}-\d{6}-\d+ profile=worker$/,
      );
      expect(lines[1]).toContain("[pi-bg] worktree: ");

      // the ticket is NOT lost:
      // 1) pi still exec'd (the launcher survived its 3rd stdout write)
      expect(fs.existsSync(marker)).toBe(true);
      // 2) the callback landed (the run completed end-to-end)
      expect(body).not.toBeNull();
      expect(body!.embeds[0].title).toMatch(/^worker \u00b7 OK/);
      // 3) the run record reached a terminal state (the EXIT trap ran:
      //    bg_mark_record; pre-fix the record was stuck "running")
      const recs = fx.records();
      expect(recs).toHaveLength(1);
      expect(recs[0].state).toBe("done");
      expect(recs[0].finished).toMatch(
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/,
      );
    } finally {
      server.stop(true);
    }
  }, 30_000);
});

// ─── issue #118: the task rides stdin, never argv ───────────────────────
// The task text used to sit in the wrapper's argv (and the pi child's) for
// the whole run: `ps -eo args` leaked it. Now the launcher form is
// `printf '%s' "$task" | pi-bg worker -` (the agent-say `-` stdin marker):
// pi-bg cats stdin ONCE (before any child, before the snapshot re-exec),
// writes the per-run prompt file (0600), and spawns pi with a stable
// flag-only argv, task + constraints on pi's stdin.
//
// probePi swaps in a stub `pi` that records, from INSIDE the live run:
// its own argv, its parent (wrapper) cmdline, a whole-process-table grep
// for the task marker, and its full stdin.
describe("#118: task on stdin, not argv", () => {
  type ProbePaths = { log: string };
  const probePi = (fx: ReturnType<typeof fixture>): ProbePaths => {
    const log = path.join(fx.tmp, "pi118-probe.txt");
    const piPath = path.join(fx.tmp, "bin", "pi");
    fs.writeFileSync(
      piPath,
      `#!/bin/sh
{
  printf 'ARGV:'
  for a in "$@"; do printf ' [%s]' "$a"; done
  printf '\\nPPID-CMD:'
  tr '\\0' ' ' < "/proc/$PPID/cmdline" 2>/dev/null
  printf '\\nPS-HIT:'
  ps -eo args 2>/dev/null | grep 'PROSE-11[8]' || printf '(none)'
  printf '\\nPROMPT:'
  pf=$(ls "\${HOME}"/.pi-bg-art/pi-bg-*-prompt.md 2>/dev/null | head -1)
  if [ -n "$pf" ]; then
    printf ' MODE=%s BODY=%s' "$(stat -c %a "$pf")" "$(cat "$pf")"
  else
    printf ' (absent)'
  fi
  printf '\\nSTDIN:'
  cat
  printf '\\n'
} > "${log}"
echo pi-run-ok
`,
    );
    fs.chmodSync(piPath, 0o755);
    return { log };
  };

  test("dash form: pi argv flag-only, wrapper argv clean, ps table clean", async () => {
    const fx = fixture();
    fx.seedMainCreds();
    const paths = probePi(fx);
    const r = await fx.runStdin(
      ["worker", "-"],
      "SECRET PROSE-118 fix the thing",
    );
    expect(r.code).toBe(0);
    expect(r.out).toContain("pi-run-ok");
    const log = fs.readFileSync(paths.log, "utf8");
    const argvLine = log.split("\n").find((l) => l.startsWith("ARGV:"))!;
    expect(argvLine).toBe("ARGV: [-p] [--no-extensions]");
    const ppidLine = log.split("\n").find((l) => l.startsWith("PPID-CMD:"))!;
    expect(ppidLine).toContain("pi-bg worker -");
    expect(ppidLine).not.toContain("PROSE-118");
    expect(log).toContain("PS-HIT:(none)");
    // the task DID reach pi — on stdin, with the standard constraints
    const stdinSection = log.split("STDIN:")[1] ?? "";
    expect(stdinSection).toContain("SECRET PROSE-118 fix the thing");
    expect(stdinSection).toContain("STANDARD CONSTRAINTS");
  });

  test("prompt file: in-flight artifact, 0600, canonical shape; removed at run end", async () => {
    const fx = fixture();
    fx.seedMainCreds();
    const paths = probePi(fx);
    const task = "PROMPT-FILE-TASK-777";
    const r = await fx.runStdin(["worker", "-"], task);
    expect(r.code).toBe(0);
    // in-flight (recorded by the stub pi while the wrapper is live):
    // exactly the canonical prompt shape, mode 600. The BODY spans the
    // prompt file's lines, so read the section up to the next marker.
    const log = fs.readFileSync(paths.log, "utf8");
    const promptSection = log.split("PROMPT:")[1]?.split("\nSTDIN:")[0] ?? "";
    expect(promptSection).toContain("MODE=600");
    expect(promptSection).toContain(`BODY=# pi-bg worker task\n\n${task}`);
    // run end: the EXIT trap unlinks the prompt file (task text need not
    // outlive the run on disk; the run record + out.md remain)
    const art = path.join(fx.home, ".pi-bg-art");
    const left = fs
      .readdirSync(art)
      .filter((f) => f.startsWith("pi-bg-") && f.endsWith("-prompt.md"));
    expect(left).toHaveLength(0);
  });

  test("legacy argv form unchanged: task still reaches pi on stdin", async () => {
    const fx = fixture();
    fx.seedMainCreds();
    const paths = probePi(fx);
    const r = await fx.run(["worker", "LEGACY PROSE-42 in argv form"]);
    expect(r.code).toBe(0);
    const log = fs.readFileSync(paths.log, "utf8");
    const argvLine = log.split("\n").find((l) => l.startsWith("ARGV:"))!;
    expect(argvLine).toBe("ARGV: [-p] [--no-extensions]");
    const stdinSection = log.split("STDIN:")[1] ?? "";
    expect(stdinSection).toContain("LEGACY PROSE-42 in argv form");
    expect(stdinSection).toContain("STANDARD CONSTRAINTS");
  });

  test("no marker + no task: usage error, and a held-open stdin pipe does not wedge", async () => {
    const fx = fixture();
    fx.seedMainCreds();
    const done = fx.runStdin(["worker"], undefined, true);
    const r = await Promise.race([
      done,
      new Promise<null>((res) => setTimeout(() => res(null), 20_000)),
    ]);
    expect(r).not.toBeNull();
    expect(r!.code).toBe(2);
    expect(r!.err).toContain("missing task");
    expect(fs.existsSync(path.join(fx.tmp, "pi-ran"))).toBe(false);
  });

  test("dash form with empty stdin: usage error (no constraints-only runs)", async () => {
    const fx = fixture();
    fx.seedMainCreds();
    const r = await fx.runStdin(["worker", "-"], "");
    expect(r.code).toBe(2);
    expect(r.err).toContain("missing task");
    expect(fs.existsSync(path.join(fx.tmp, "pi-ran"))).toBe(false);
  });
});

/**
 * usage error: missing task (issue #115, incident 2026-10-03 ticket
 * 20261003-093837, found by jimmy). A bare `pi-bg`, `pi-bg worker` with
 * no task, or an all-whitespace task used to spawn an agent with an EMPTY
 * task: wasted run record + cgroup + ticket + cap slot (and on pre-#118
 * main it crashed at pi_args[-1] on the empty array). The guard exits 2
 * BEFORE the cap scan, run record, cgroup escape and snapshot re-exec, so
 * a probe leaves zero side effects (same contract as the --worktree /
 * --project usage errors: rc 2, one stderr line, no record).
 */
describe("usage error: missing task exits 2 with no side effects", () => {
  test("bare jarate-bg: rc 2, usage on stderr, no record, pi never runs", async () => {
    const fx = fixture();
    fx.seedMainCreds();
    const r = await fx.run([]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("missing task");
    expect(fs.existsSync(path.join(fx.tmp, "pi-ran"))).toBe(false);
    const recDir = path.join(fx.tmp, "records");
    expect(fs.existsSync(recDir) ? fx.records() : []).toHaveLength(0);
  });

  test("pi-bg worker (no task): rc 2, no record, pi never runs", async () => {
    const fx = fixture();
    fx.seedMainCreds();
    const r = await fx.run(["worker"]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("missing task");
    expect(fs.existsSync(path.join(fx.tmp, "pi-ran"))).toBe(false);
    const recDir = path.join(fx.tmp, "records");
    expect(fs.existsSync(recDir) ? fx.records() : []).toHaveLength(0);
  });

  test("whitespace-only task: rc 2, no record", async () => {
    const fx = fixture();
    fx.seedMainCreds();
    const r = await fx.run(["worker", "   "]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("missing task");
    expect(fs.existsSync(path.join(fx.tmp, "pi-ran"))).toBe(false);
    const recDir = path.join(fx.tmp, "records");
    expect(fs.existsSync(recDir) ? fx.records() : []).toHaveLength(0);
  });

  test("normal task still runs (guard does not over-fire)", async () => {
    const fx = fixture();
    fx.seedMainCreds();
    const r = await fx.run(["worker", "a real task"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("pi-run-ok");
    expect(fx.records()).toHaveLength(1);
  });
});

// ─── issue #144: foreground-launch guard (nohup is the required form) ──
// The launcher is the ticket's SUPERVISOR: it execs the pi child, waits
// for the WHOLE run, posts the callback, then exits. A foreground caller
// holds the launcher's pipes for the run's full duration (2026-10-05 RCA:
// dispatch turns wedged 1-4 min = run lengths). The guard makes
// foreground an explicit error: ticket line FIRST (#56 belt), stderr
// error naming the nohup form, exit 4, sub-second, zero side effects (no
// run record, no heartbeat). Detection = SIGHUP disposition: nohup(1)
// sets SIG_IGN (bash keeps an inherited ignore and cannot reset it in a
// non-interactive shell); a foreground shell has the default. Bypass:
// PI_BG_ALLOW_FOREGROUND=1 exactly (internal callers/tests only).
describe("#144: foreground-launch guard (nohup is the required form)", () => {
  // Hermetic SIGHUP control: the suite's own disposition leaks into the
  // child (the suite often runs under a nohup'd ticket, HUP already
  // ignored). nohup(1) sets SIG_IGN for real; python3 resets an
  // inherited ignore to SIG_DFL (non-interactive bash cannot) before
  // exec'ing the script.
  const PY_DFL_HUP =
    "import os, signal, sys; " +
    "signal.signal(signal.SIGHUP, signal.SIG_DFL); " +
    'os.execvp("bash", ["bash", sys.argv[1]] + sys.argv[2:])';

  const spawnGuard = (
    fx: ReturnType<typeof fixture>,
    hup: "default" | "ignore",
    env: Record<string, string>,
    args: string[],
    stdin?: string,
  ) => {
    const cmd =
      hup === "ignore"
        ? ["nohup", "bash", PI_BG, ...args]
        : ["python3", "-c", PY_DFL_HUP, PI_BG, ...args];
    const p = spawn(cmd, {
      env,
      cwd: fx.tmp,
      stdout: "pipe",
      stderr: "pipe",
      stdin: "pipe",
    });
    if (stdin !== undefined) p.stdin?.write(stdin);
    p.stdin?.end();
    return p;
  };

  const collect = async (p: ReturnType<typeof spawnGuard>) => {
    const [out, err] = await Promise.all([
      new Response(p.stdout).text(),
      new Response(p.stderr).text(),
    ]);
    const code = await p.exited;
    return { out, err, code };
  };

  // guard env: fixture env minus the internal-caller bypass, with an
  // explicit artifact dir so the "no side effects" assertions have a
  // known place to look (run records still land in the fixture records
  // dir, which the guard path never creates).
  const guardEnv = (fx: ReturnType<typeof fixture>) => {
    const env = { ...fx.env };
    delete env.PI_BG_ALLOW_FOREGROUND;
    env.PI_BG_TMPDIR = path.join(fx.tmp, "art");
    fs.mkdirSync(env.PI_BG_TMPDIR, { recursive: true });
    return env;
  };

  const recDirOf = (fx: ReturnType<typeof fixture>) =>
    path.join(fx.tmp, "records");

  test("foreground (HUP default, no bypass): rc 4, sub-second, ticket first, no record, no hb, pi never runs", async () => {
    const fx = fixture();
    fx.seedMainCreds();
    const env = guardEnv(fx);
    const t0 = Date.now();
    const p = spawnGuard(fx, "default", env, ["worker", "guard task"]);
    const { out, err, code } = await collect(p);
    const elapsed = Date.now() - t0;

    expect(code).toBe(4);
    expect(elapsed).toBeLessThan(1000);
    // #56 belt: the ticket line is the FIRST stdout line, so a dead
    // foreground launch is identifiable by its first line
    const first = out.trimStart().split("\n")[0];
    expect(first).toMatch(/^\[pi-bg\] ticket \d{8}-\d{6}-\d+ profile=worker$/);
    // the error names the nohup form with the real run id + dir
    expect(err).toContain("foreground launch detected (issue #144)");
    expect(err).toContain("nohup jarate-bg worker");
    const m = first.match(/\[pi-bg\] ticket (\S+)/);
    if (!m) throw new Error("ticket line vanished from guard output");
    const rid = m[1];
    expect(err).toContain(`pi-bg-${rid}-launch.log`);
    expect(err).toContain(env.PI_BG_TMPDIR);
    // zero side effects: no run record, no heartbeat, no prompt file
    expect(fs.existsSync(recDirOf(fx)) ? fx.records() : []).toHaveLength(0);
    expect(fs.readdirSync(env.PI_BG_TMPDIR)).not.toContain(`pi-bg-${rid}-hb`);
    expect(
      fs.existsSync(path.join(env.PI_BG_TMPDIR, `pi-bg-${rid}-prompt.md`)),
    ).toBe(false);
    expect(fs.existsSync(path.join(fx.tmp, "pi-ran"))).toBe(false);
  }, 15_000);

  test("nohup (HUP ignored, no bypass): full run passes end-to-end", async () => {
    const fx = fixture();
    fx.seedMainCreds();
    const p = spawnGuard(fx, "ignore", guardEnv(fx), ["worker", "nohup task"]);
    const { out, err, code } = await collect(p);
    expect(code).toBe(0);
    expect(err).not.toContain("foreground launch detected");
    expect(out).toContain("pi-run-ok");
    const recs = fx.records();
    expect(recs).toHaveLength(1);
    expect(recs[0].state).toBe("done");
  }, 30_000);

  test("nohup + stdin task form (the dispatch shape): passes", async () => {
    const fx = fixture();
    fx.seedMainCreds();
    const p = spawnGuard(
      fx,
      "ignore",
      guardEnv(fx),
      ["worker", "-"],
      "stdin nohup task",
    );
    const { out, code } = await collect(p);
    expect(code).toBe(0);
    expect(out).toContain("pi-run-ok");
    expect(fx.records()).toHaveLength(1);
  }, 30_000);

  test("bypass PI_BG_ALLOW_FOREGROUND=1: foreground passes (internal callers)", async () => {
    const fx = fixture();
    fx.seedMainCreds();
    // fx.env carries the bypass - the internal-caller form the rest of
    // the suite uses
    const p = spawnGuard(fx, "default", fx.env, ["worker", "bypass task"]);
    const { out, code } = await collect(p);
    expect(code).toBe(0);
    expect(out).toContain("pi-run-ok");
    expect(fx.records()).toHaveLength(1);
  }, 30_000);

  test("bypass value must be exactly 1 (other values = no bypass)", async () => {
    for (const v of ["0", "yes", "2"]) {
      const fx = fixture();
      fx.seedMainCreds();
      const env = { ...guardEnv(fx), PI_BG_ALLOW_FOREGROUND: v };
      const p = spawnGuard(fx, "default", env, ["worker", "bypass task"]);
      const { err, code } = await collect(p);
      expect(code, `value ${v}`).toBe(4);
      expect(err, `value ${v}`).toContain("foreground launch detected");
      expect(fs.existsSync(recDirOf(fx)) ? fx.records() : []).toHaveLength(0);
    }
  }, 30_000);
});

// ───────────────────────────────────────────────────────────────────────────
// #145: daemonize after registration (foreground launch returns in seconds)
//
// The #144 guard throws on the attached SIGHUP-default shape. #145 adds
// the other half: every HUP-default shape that PASSES the guard
// (bypass, warn, or unattached) daemonizes after ticket registration,
// so the launcher exits 0 within seconds and the run continues detached
// (own session, reparented to systemd). nohup (SIGHUP SIG_IGN) stays
// inline - unchanged topology. PI_BG_DAEMONIZE=0 pins the legacy inline
// topology (the fixture's knob; the rest of this suite awaits the
// launcher's exit on inline output).
describe("#145: daemonize after registration", () => {
  // Hermetic SIGHUP default (same leak as #144: the suite often runs
  // under a nohup'd ticket with HUP already ignored).
  const PY_DFL_HUP =
    "import os, signal, sys; " +
    "signal.signal(signal.SIGHUP, signal.SIG_DFL); " +
    'os.execvp("bash", ["bash", sys.argv[1]] + sys.argv[2:])';
  // Detached shape: own process group before exec (the cron / systemd /
  // job-control shape - SIGHUP default but NOT waiting on us).
  const PY_DFL_HUP_PG =
    "import os, signal, sys; " +
    "signal.signal(signal.SIGHUP, signal.SIG_DFL); " +
    "os.setpgrp(); " +
    'os.execvp("bash", ["bash", sys.argv[1]] + sys.argv[2:])';

  const spawnWith = (
    fx: ReturnType<typeof fixture>,
    cmd: string[],
    env: Record<string, string>,
  ) => {
    const p = spawn(cmd, {
      env,
      cwd: fx.tmp,
      stdout: "pipe",
      stderr: "pipe",
    });
    return p;
  };

  const collect = async (p: ReturnType<typeof spawnWith>) => {
    const [out, err] = await Promise.all([
      new Response(p.stdout).text(),
      new Response(p.stderr).text(),
    ]);
    const code = await p.exited;
    return { out, err, code };
  };

  const waitFor = async (fn: () => boolean, ms = 15_000): Promise<boolean> => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (fn()) return true;
      await new Promise((r) => setTimeout(r, 50));
    }
    return fn();
  };

  // slow stub pi: the run takes ~3s, so a launcher that still blocks on
  // the run takes >= 3s while the daemonized one returns in < 1.5s
  const slowPi = (fx: ReturnType<typeof fixture>) => {
    const p = path.join(fx.tmp, "bin", "pi");
    fs.writeFileSync(p, "#!/bin/sh\nsleep 3\necho pi-run-ok\n");
    fs.chmodSync(p, 0o755);
  };

  const artOf = (fx: ReturnType<typeof fixture>) =>
    path.join(fx.tmp, "home", ".pi-bg-art");

  const ticketId = (out: string) => out.match(/ticket (\S+) profile=/)?.[1];

  const runDone = (fx: ReturnType<typeof fixture>, id: string): boolean => {
    const rc = path.join(artOf(fx), `pi-bg-${id}-rc`);
    if (!fs.existsSync(rc) || fs.readFileSync(rc, "utf-8").trim() !== "0")
      return false;
    const rec = fx.records().find((r) => r.run === id);
    return rec?.state === "done";
  };

  test("attached + bypass: daemonizes after registration, returns in seconds, run completes detached", async () => {
    const fx = fixture();
    fx.seedMainCreds();
    slowPi(fx);
    const env = { ...fx.env }; // PI_BG_ALLOW_FOREGROUND=1, daemonize on
    delete env.PI_BG_DAEMONIZE;
    const t0 = Date.now();
    const p = spawnWith(
      fx,
      ["python3", "-c", PY_DFL_HUP, PI_BG, "worker", "daemon task"],
      env,
    );
    const { out, err, code } = await collect(p);
    const elapsed = Date.now() - t0;
    expect(code).toBe(0);
    expect(out).toMatch(/ticket \S+ profile=worker/);
    expect(out).toContain("daemonized");
    // the daemon child's stdout is off the caller's pipes (launcher log)
    expect(out).not.toContain("pi-run-ok");
    expect(err).not.toContain("foreground launch detected");
    // returned in seconds, NOT after the ~3s run
    expect(elapsed).toBeLessThan(1500);
    const id = ticketId(out) ?? "";
    expect(id).not.toBe("");
    // the detached run completes on its own, artifacts intact
    expect(await waitFor(() => runDone(fx, id))).toBe(true);
    expect(
      fs.readFileSync(
        path.join(artOf(fx), `pi-bg-${id}-launcher.log`),
        "utf-8",
      ),
    ).toContain("pi-run-ok");
  }, 30_000);

  test("attached + PI_BG_FOREGROUND_GUARD=warn: warning on stderr, run continues detached", async () => {
    const fx = fixture();
    fx.seedMainCreds();
    slowPi(fx);
    const env = { ...fx.env };
    delete env.PI_BG_ALLOW_FOREGROUND; // the guard must see the shape
    delete env.PI_BG_DAEMONIZE;
    env.PI_BG_FOREGROUND_GUARD = "warn";
    const t0 = Date.now();
    const p = spawnWith(
      fx,
      ["python3", "-c", PY_DFL_HUP, PI_BG, "worker", "warn task"],
      env,
    );
    const { out, err, code } = await collect(p);
    const elapsed = Date.now() - t0;
    expect(code).toBe(0); // warn does not throw
    expect(err).toContain("WARNING");
    expect(err).toContain("foreground launch detected");
    expect(out).toContain("daemonized");
    expect(elapsed).toBeLessThan(1500);
    const id = ticketId(out) ?? "";
    expect(id).not.toBe("");
    expect(await waitFor(() => runDone(fx, id))).toBe(true);
  }, 30_000);

  test("PI_BG_DAEMONIZE=0: legacy inline topology (launcher waits on the run)", async () => {
    const fx = fixture();
    fx.seedMainCreds();
    const env = { ...fx.env }; // PI_BG_ALLOW_FOREGROUND=1 + PI_BG_DAEMONIZE=0
    const p = spawnWith(
      fx,
      ["python3", "-c", PY_DFL_HUP, PI_BG, "worker", "inline task"],
      env,
    );
    const { out, code } = await collect(p);
    expect(code).toBe(0);
    expect(out).not.toContain("daemonized");
    // inline: the pi run's output IS on the caller's pipes
    expect(out).toContain("pi-run-ok");
  }, 30_000);

  test("detached non-nohup shape (own process group): no guard throw, daemonizes, completes", async () => {
    const fx = fixture();
    fx.seedMainCreds();
    slowPi(fx);
    const env = { ...fx.env };
    delete env.PI_BG_ALLOW_FOREGROUND; // no bypass: the guard must not fire
    delete env.PI_BG_DAEMONIZE;
    const t0 = Date.now();
    const p = spawnWith(
      fx,
      ["python3", "-c", PY_DFL_HUP_PG, PI_BG, "worker", "detached task"],
      env,
    );
    const { out, err, code } = await collect(p);
    const elapsed = Date.now() - t0;
    expect(code).toBe(0);
    expect(err).not.toContain("foreground launch detected");
    expect(elapsed).toBeLessThan(1500);
    const id = ticketId(out) ?? "";
    expect(id).not.toBe("");
    expect(await waitFor(() => runDone(fx, id))).toBe(true);
  }, 30_000);
});

// ───────────────────────────────────────────────────────────────────────────
// #142: per-command bash tool timeout
//
// This pi version has no bash-tool default timeout (tool schema: "optional,
// no default timeout"; no settings/env/profile hook), so the cap is wired
// through the task prompt: STD_CONSTRAINTS tells the model to pass the
// bash tool's `timeout` parameter (pi kills the whole command tree at the
// limit, returns a retryable error). PI_BG_CMD_TIMEOUT overrides per
// dispatch (env at launch); the resolved value is exported to the run's
// environment and stored in the run record (cmdTimeout) for audit.
describe("#142: per-command bash tool timeout", () => {
  // stub pi that records, from INSIDE the live run: PI_BG_CMD_TIMEOUT and
  // its own full stdin (task + constraints)
  const timeoutPi = (fx: ReturnType<typeof fixture>) => {
    const log = path.join(fx.tmp, "pi142-probe.txt");
    const piPath = path.join(fx.tmp, "bin", "pi");
    fs.writeFileSync(
      piPath,
      `#!/bin/sh
{
  printf 'ENV: '
  printf '%s' "\${PI_BG_CMD_TIMEOUT:-unset}"
  printf '\\nSTDIN:'
  cat
  printf '\\n'
} > "${log}"
echo pi-run-ok
`,
    );
    fs.chmodSync(piPath, 0o755);
    return { log };
  };

  test("default 900s: prompt constraint, exported env, run record", async () => {
    const fx = fixture();
    fx.seedMainCreds();
    const p = timeoutPi(fx);
    const r = await fx.runStdin(["worker", "-"], "TIMEOUT-DEFAULT task");
    expect(r.code).toBe(0);
    expect(r.out).toContain("pi-run-ok");
    const log = fs.readFileSync(p.log, "utf8");
    expect(log.split("\n")[0]).toBe("ENV: 900");
    const stdinSection = log.split("STDIN:")[1] ?? "";
    expect(stdinSection).toContain("Pass timeout: 900 (seconds)");
    expect(stdinSection).toContain("bash tool call");
    expect(fx.records()[0].cmdTimeout).toBe(900);
  }, 30_000);

  test("PI_BG_CMD_TIMEOUT override at launch", async () => {
    const fx = fixture();
    fx.seedMainCreds();
    const p = timeoutPi(fx);
    fx.env.PI_BG_CMD_TIMEOUT = "3600";
    const r = await fx.runStdin(["worker", "-"], "TIMEOUT-OVERRIDE task");
    expect(r.code).toBe(0);
    const log = fs.readFileSync(p.log, "utf8");
    expect(log.split("\n")[0]).toBe("ENV: 3600");
    expect(log.split("STDIN:")[1] ?? "").toContain(
      "Pass timeout: 3600 (seconds)",
    );
    expect(fx.records()[0].cmdTimeout).toBe(3600);
  }, 30_000);

  test("non-integer PI_BG_CMD_TIMEOUT: warn + fall back to 900", async () => {
    const fx = fixture();
    fx.seedMainCreds();
    const p = timeoutPi(fx);
    fx.env.PI_BG_CMD_TIMEOUT = "banana";
    const r = await fx.runStdin(["worker", "-"], "TIMEOUT-BADVAL task");
    expect(r.code).toBe(0);
    expect(r.err).toContain("PI_BG_CMD_TIMEOUT='banana'");
    const log = fs.readFileSync(p.log, "utf8");
    expect(log.split("\n")[0]).toBe("ENV: 900");
    expect(fx.records()[0].cmdTimeout).toBe(900);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// #143: jarate-bg signal — mid-run intervention + receipt. The incident:
// an operator killed a wedged grandchild by hand, then POLLED (sleep +
// tail of the session jsonl) to verify the run resumed. This subcommand
// signals the run's cgroup tree (per-pid, never the process group - that
// is jarate-bg-kill) and emits the receipt on the same event path as the
// watchdog's mid-run events: stdout line + dead-log line (class
// "signal") + webhook post (green embed, sweep author).
// ---------------------------------------------------------------------------
describe("#143: jarate-bg signal (mid-run intervention receipt)", () => {
  type F = ReturnType<typeof fixture>;

  const ST = (n: number): string => `2026100${n}-141516-95143${n}7`;

  // webhook capture (the fixture deletes PI_DISPATCH_WEBHOOK; the script
  // falls back to ~/.config/pi-dispatch/webhook)
  const server = () => {
    const posts: Array<{ embeds: Array<any> }> = [];
    const s = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: async (req) => {
        if (req.method === "POST") posts.push(await req.json());
        return new Response("ok", { status: 200 });
      },
    });
    return {
      posts,
      url: `http://127.0.0.1:${s.port}/hook`,
      close: () => s.stop(true),
    };
  };

  const plant = (fx: F, t: string, memberPids: string[]): string => {
    const recDir = fx.env.PI_DISPATCH_RECORD_DIR;
    fs.mkdirSync(recDir, { recursive: true });
    fs.writeFileSync(
      path.join(recDir, `pi-bg-${t}.json`),
      JSON.stringify({
        run: t,
        profile: "worker",
        project: null,
        cwd: fx.tmp,
        started: new Date(Date.now() - 2 * 60 * 60 * 1000)
          .toISOString()
          .replace(".000Z", "Z"),
        delivery: "webhook",
        state: "running",
      }),
    );
    const cg = path.join(fx.env.PI_BG_CG_ROOT, "pi-bg", t);
    fs.mkdirSync(cg, { recursive: true });
    fs.writeFileSync(
      path.join(cg, "cgroup.procs"),
      memberPids.length ? `${memberPids.join("\n")}\n` : "",
    );
    return cg;
  };

  const deadlog = (fx: F): string => {
    const p = path.join(fx.home, ".pi-bg-deadlog");
    return fs.existsSync(p) ? fs.readFileSync(p, "utf8") : "";
  };

  const frameLines = (s: string): string[] =>
    s
      .replace(/^```bash\n/, "")
      .replace(/\n```$/, "")
      .split("\n");

  // (f) TERM kills the cgroup tree - the /proc walk finds the descendant
  // (only the parent is a cgroup member in the fake root) - and emits
  // the receipt: stdout + dead log + webhook (the event format).
  test("TERM kills the tree + emits the receipt (rc 0)", async () => {
    const fx = fixture();
    const srv = server();
    let parent: ReturnType<typeof Bun.spawn> | null = null;
    try {
      const t = ST(1);
      const childPidFile = path.join(fx.tmp, "child-pid");
      parent = Bun.spawn(
        ["bash", "-c", `sleep 300 & echo $! > ${childPidFile}; wait`],
        { stdout: "ignore", stderr: "ignore" },
      );
      for (let i = 0; i < 50 && !fs.existsSync(childPidFile); i++) {
        await Bun.sleep(50);
      }
      const childPid = fs.readFileSync(childPidFile, "utf8").trim();
      plant(fx, t, [String(parent.pid)]);
      const cfg = path.join(fx.home, ".config", "pi-dispatch");
      fs.mkdirSync(cfg, { recursive: true });
      fs.writeFileSync(path.join(cfg, "webhook"), `${srv.url}\n`);

      const r = await fx.run(["signal", t, "TERM"]);
      expect(r.code).toBe(0);
      expect(r.out).toContain(`[pi-bg] signal TERM -> ${t}`);
      expect(r.out).toContain("all signaled members gone");
      // the whole tree died (parent from the cgroup file, child from the
      // /proc walk)
      expect(fs.existsSync(`/proc/${parent.pid}`)).toBe(false);
      expect(fs.existsSync(`/proc/${childPid}`)).toBe(false);
      // dead-log receipt (house line shape; class "signal" prefix)
      expect(deadlog(fx)).toMatch(
        new RegExp(
          `^\\d{4}-\\d{2}-\\d{2} ${t} cwd \\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}Z signal: TERM sent to pids ${parent.pid} ${childPid} by \\w+; all signaled members gone after \\d+s$`,
          "m",
        ),
      );
      // webhook receipt: the same event format as the watchdog's
      // mid-run events (green, sweep author, 40-col frame) and it must
      // pass the bridge's isBgWebhook exemption (wakes the channel)
      expect(srv.posts).toHaveLength(1);
      const e = srv.posts[0].embeds[0];
      expect(e.title).toBe(`SIGNAL \u00b7 ${t}`);
      expect(e.author?.name).toBe(`pi-bg ticket \u00b7 ${t}`);
      expect(e.color).toBe(3066993);
      for (const line of frameLines(e.description)) {
        expect(line.length).toBeLessThanOrEqual(40);
      }
      expect(e.description).toContain(childPid);
      expect(isBgWebhook({ ...srv.posts[0], webhook_id: "123" })).toBe(true);
      // no terminal-class side effects: the record is untouched
      const rec = fx.records().find((r) => r.run === t);
      expect(rec.state).toBe("running");
      expect(
        fs.existsSync(path.join(fx.home, ".pi-bg-art", `pi-bg-${t}-killed`)),
      ).toBe(false);
    } finally {
      parent?.kill("SIGKILL");
      await parent?.exited;
      srv.close();
    }
  }, 30_000);

  // a member that ignores TERM outlives the drain wait: rc 3 + the
  // receipt says so (the orchestrator reads the result - no re-look).
  test("signal-ignoring member -> rc 3 + still-alive receipt", async () => {
    const fx = fixture();
    const srv = server();
    let parent: ReturnType<typeof Bun.spawn> | null = null;
    try {
      const t = ST(2);
      const childPidFile = path.join(fx.tmp, "child-pid");
      parent = Bun.spawn(
        // the trap is set AFTER the fork: a background child inherits
        // the parent's ignored dispositions across fork (a trap-before-
        // fork parent would make the child ignore TERM too)
        [
          "bash",
          "-c",
          `sleep 300 & echo $! > ${childPidFile}; trap '' TERM; wait; sleep 300`,
        ],
        { stdout: "ignore", stderr: "ignore" },
      );
      for (let i = 0; i < 50 && !fs.existsSync(childPidFile); i++) {
        await Bun.sleep(50);
      }
      const childPid = fs.readFileSync(childPidFile, "utf8").trim();
      plant(fx, t, [String(parent.pid)]);
      const cfg = path.join(fx.home, ".config", "pi-dispatch");
      fs.mkdirSync(cfg, { recursive: true });
      fs.writeFileSync(path.join(cfg, "webhook"), `${srv.url}\n`);
      fx.env.PI_BG_SIGNAL_WAIT = "2";

      const r = await fx.run(["signal", t, "TERM"]);
      expect(r.code).toBe(3);
      expect(r.out).toContain(`[pi-bg] signal TERM -> ${t}`);
      expect(r.out).toContain("still alive after");
      // the plain child died, the ignoring parent survived
      expect(fs.existsSync(`/proc/${childPid}`)).toBe(false);
      expect(fs.existsSync(`/proc/${parent.pid}`)).toBe(true);
      expect(deadlog(fx)).toMatch(
        /signal: TERM sent to pids .* still alive after \d+s: /,
      );
      expect(srv.posts).toHaveLength(1);
      expect(srv.posts[0].embeds[0].description).toContain("still alive after");
      parent.kill("SIGKILL");
      await parent.exited;
      parent = null;
    } finally {
      parent?.kill("SIGKILL");
      await parent?.exited;
      srv.close();
    }
  }, 30_000);

  // short-id resolution (unique 7+ digit suffix in the record dir)
  test("short id resolves to the full ticket", async () => {
    const fx = fixture();
    let w: ReturnType<typeof Bun.spawn> | null = null;
    try {
      const t = ST(3);
      w = Bun.spawn(["sleep", "300"], {
        stdout: "ignore",
        stderr: "ignore",
      });
      plant(fx, t, [String(w.pid)]);
      const short = t.slice(-7);
      const r = await fx.run(["signal", short, "TERM"]);
      expect(r.code).toBe(0);
      expect(r.err).toContain(`short id ${short} -> ${t}`);
      expect(r.out).toContain(`[pi-bg] signal TERM -> ${t}`);
      expect(fs.existsSync(`/proc/${w.pid}`)).toBe(false);
      w = null;
    } finally {
      w?.kill("SIGKILL");
      await w?.exited;
    }
  }, 30_000);

  // --dry-run: lists the tree, signals nothing, no receipt side effects
  test("--dry-run -> tree listed, nothing signaled", async () => {
    const fx = fixture();
    const srv = server();
    let w: ReturnType<typeof Bun.spawn> | null = null;
    try {
      const t = ST(4);
      w = Bun.spawn(["sleep", "300"], {
        stdout: "ignore",
        stderr: "ignore",
      });
      plant(fx, t, [String(w.pid)]);
      const cfg = path.join(fx.home, ".config", "pi-dispatch");
      fs.mkdirSync(cfg, { recursive: true });
      fs.writeFileSync(path.join(cfg, "webhook"), `${srv.url}\n`);
      const r = await fx.run(["signal", t, "TERM", "--dry-run"]);
      expect(r.code).toBe(0);
      expect(r.out).toContain(
        `process tree for ${t} (would be signaled TERM):`,
      );
      expect(r.out).toContain(String(w.pid));
      expect(r.out).toContain("dry-run: no signal sent");
      expect(fs.existsSync(`/proc/${w.pid}`)).toBe(true);
      expect(srv.posts).toHaveLength(0);
      expect(deadlog(fx)).toBe("");
      w.kill("SIGKILL");
      await w.exited;
      w = null;
    } finally {
      w?.kill("SIGKILL");
      await w?.exited;
      srv.close();
    }
  }, 30_000);

  // unknown ticket: no cgroup dir -> rc 2, no side effects
  test("unknown ticket -> rc 2, no side effects", async () => {
    const fx = fixture();
    const srv = server();
    try {
      const t = ST(5);
      const cfg = path.join(fx.home, ".config", "pi-dispatch");
      fs.mkdirSync(cfg, { recursive: true });
      fs.writeFileSync(path.join(cfg, "webhook"), `${srv.url}\n`);
      const r = await fx.run(["signal", t, "TERM"]);
      expect(r.code).toBe(2);
      expect(r.err).toContain(`no cgroup for ticket '${t}'`);
      expect(srv.posts).toHaveLength(0);
      expect(deadlog(fx)).toBe("");
    } finally {
      srv.close();
    }
  }, 30_000);

  // usage errors: missing args / bad signal -> rc 2, no side effects
  test("usage errors -> rc 2", async () => {
    const fx = fixture();
    try {
      const r1 = await fx.run(["signal", ST(6)]);
      expect(r1.code).toBe(2);
      expect(r1.err).toContain("usage:");
      const r2 = await fx.run(["signal", ST(6), "BANG"]);
      expect(r2.code).toBe(2);
      expect(r2.err).toContain("unknown signal");
      expect(deadlog(fx)).toBe("");
    } finally {
      // fixture close is handled by the global afterEach
    }
  }, 30_000);
});
