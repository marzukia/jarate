/**
 * dispatch/pi-bg — fresh-machine doctor tests (issues #29, #30).
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

const PI_BG = path.join(import.meta.dir, "pi-bg");

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
  // skip the setsid re-exec under test - hermeticize
  delete env.PI_BG_SETSID;
  delete env.PI_BG_TMPDIR; // default-path tests must not inherit an override
  // cap off by default: ambient fleet traffic (real pi-bg runs of this
  // user) must not make non-#41 tests hit "at cap"; #41 tests set
  // PI_BG_MAX_CONCURRENT explicitly per spawn.
  env.PI_BG_MAX_CONCURRENT = "0";
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
      JSON.stringify({ hydrogen: { type: "api_key", key: "sk-test" } }),
    );
    fs.writeFileSync(
      path.join(mainAgent, "models.json"),
      JSON.stringify({ hydrogen: { models: [{ id: "qwen-test" }] } }),
    );
    fs.writeFileSync(
      path.join(mainAgent, "settings.json"),
      JSON.stringify({
        defaultProvider: "hydrogen",
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

  const records = () =>
    fs
      .readdirSync(env.PI_DISPATCH_RECORD_DIR)
      .filter((f) => f.endsWith(".json"))
      .map((f) =>
        JSON.parse(
          fs.readFileSync(path.join(env.PI_DISPATCH_RECORD_DIR, f), "utf-8"),
        ),
      );

  return { tmp, home, mainAgent, env, run, seedMainCreds, records };
}

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
    expect(settings.defaultProvider).toBe("hydrogen"); // from main settings
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
    expect(auth.hydrogen.key).toBe("sk-test"); // main creds landed
    const models = JSON.parse(
      fs.readFileSync(path.join(prof, "models.json"), "utf-8"),
    );
    expect(models.hydrogen.models[0].id).toBe("qwen-test"); // main models landed
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

describe("#37: JB_ROOT resolves symlinks (normal launch is ~/scripts/pi-bg)", () => {
  test("pi-bg launched via a symlink still seeds settings.json from the repo template", async () => {
    const fx = fixture();
    fx.seedMainCreds();
    // mimic install.sh: a bin dir under the fake HOME holding a symlink
    // to the real script. BASH_SOURCE is the link path, so without
    // readlink -f, JB_ROOT would be the fake HOME and the template lookup
    // would silently miss.
    const linkDir = path.join(fx.home, "scripts");
    fs.mkdirSync(linkDir, { recursive: true });
    const link = path.join(linkDir, "pi-bg");
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
    expect(settings.defaultProvider).toBe("hydrogen"); // merged from main settings
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
        if (
          fs.existsSync(f) &&
          fs.readFileSync(f, "utf8").trim() === String(p.pid)
        ) {
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

describe("#30: no webhook => loud warning at dispatch + run record delivery=none", () => {
  test("missing webhook: stderr warning + record marked delivery=none", async () => {
    const fx = fixture();
    fx.seedMainCreds();
    const r = await fx.run(["worker", "test task"]);
    expect(r.code).toBe(0);
    expect(r.err).toContain("no completion callback; poll with pi-wait");
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

const WD = path.join(import.meta.dir, "pi-bg-watchdog");

describe("watchdog rule 3: dual lookup (persistent dir + legacy /tmp)", () => {
  // fake ids in year 2099: never collide with real tickets in /tmp
  const TID = (n: number) => `20991231-235959-${n}`;

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
});

const TAIL = path.join(import.meta.dir, "pi-bg-tail");

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
      expect(em.description).toContain("├ $ pi-bg worker --worktree");
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
      assertFrame(em, `┌ fail · ${runId} (rc=3)`);
      expect(em.description).toContain("├ $ pi-bg worker");
      expect(em.description).toContain("├ cwd    : ");
    } finally {
      delete fx.env.PI_DISPATCH_WEBHOOK;
      delete fx.env.PI_BG_WB_BACKOFF;
      hook.close();
    }
  });
});

/**
 * #41: concurrency cap (PI_BG_MAX_CONCURRENT, default 3).
 *
 * pi-bg counts this uid's live "pi-bg worker|reviewer" processes before
 * exec'ing the agent and refuses with a [!] line + exit 5 at the cap.
 * Real traffic on the same uid (e.g. the dispatch running this suite)
 * is counted too, so every assertion is made relative to a baseline
 * captured immediately before spawning stubs.
 */
describe("#41: concurrency cap (PI_BG_MAX_CONCURRENT)", () => {
  // Mirror of the script's count: this uid's processes whose /proc cmdline
  // carries an argv element whose basename is pi-bg immediately followed by
  // a worker|reviewer element (the script's review F1 rule), excluding the
  // test process itself. A match whose parent has an identical cmdline is a
  // fork-window phantom (a forked helper that has not exec'd yet keeps the
  // parent's argv) and is skipped, same rule as the script. The element
  // match matters: a launcher "bash -c" carries "pi-bg worker" inside one
  // -c string, so a substring test over the ps line double-counted it while
  // the script's element scan did not (deterministic at-cap fail while any
  // fleet launcher is alive, 2026-09-14 baseline).
  const countLivePiBg = (): number => {
    const out = execSync(`ps -U ${process.getuid()} -o pid=,ppid=,args=`, {
      encoding: "utf8",
    });
    let n = 0;
    for (const line of out.split("\n")) {
      const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
      if (!m) continue;
      const pid = Number(m[1]);
      if (pid === process.pid) continue;
      let argv: string[];
      try {
        argv = fs
          .readFileSync(`/proc/${pid}/cmdline`, "utf8")
          .split("\0")
          .filter(Boolean);
      } catch {
        continue; // unreadable (other user / zombie) - the script skips too
      }
      let match = false;
      for (let i = 0; i < argv.length; i++) {
        if (
          argv[i].split("/").pop() === "pi-bg" &&
          i + 1 < argv.length &&
          (argv[i + 1] === "worker" || argv[i + 1] === "reviewer")
        ) {
          match = true;
          break;
        }
      }
      if (!match) continue;
      let identical = false;
      try {
        const p = fs
          .readFileSync(`/proc/${m[2]}/cmdline`, "utf8")
          .split("\0")
          .filter(Boolean)
          .join(" ");
        identical = argv.join(" ") === p;
      } catch {
        identical = false;
      }
      if (!identical) n++;
    }
    return n;
  };

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
    sleepStubPi(fx, 3);
    const base = countLivePiBg();
    const max = base + 3;
    const stubs = [1, 2, 3].map((i) =>
      spawnStub(fx, `cap t1 stub ${i}`, { PI_BG_MAX_CONCURRENT: String(max) }),
    );
    try {
      // all three wrappers in flight at once
      expect(await waitFor(() => countLivePiBg() - base >= 3)).toBe(true);
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
    const base = countLivePiBg();
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
      expect(await waitFor(() => countLivePiBg() - base >= 2)).toBe(true);
      c = spawnStub(fx, "cap t2 stub c", {
        PI_BG_MAX_CONCURRENT: String(max),
      });
      const r = await collect(c);
      expect(r.code).toBe(5);
      expect(r.err).toMatch(
        /\[!\] at cap \(\d+\/\d+\), try again later or pi-bg-kill a ticket/,
      );
      // a + b recorded their dispatch; the refused c left no record
      expect(
        await waitFor(() => {
          try {
            return fx.records().length === 2;
          } catch {
            return false; // record dir not created yet
          }
        }),
      ).toBe(true);
      expect(fx.records()).toHaveLength(2);
    } finally {
      killStubs([a, b, ...(c ? [c] : [])], fx.tmp);
    }
  }, 30_000);

  test("self-exclusion: the counting wrapper is not counted against the cap", async () => {
    const fx = fixture();
    fx.seedMainCreds();
    // immediate stub pi: the wrapper is short-lived, so a self-count would
    // refuse exactly this case (live = base + 1(self) >= max = base + 1)
    const base = countLivePiBg();
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
    sleepStubPi(fx, 3);
    const base = countLivePiBg();
    const stubs = [1, 2, 3, 4].map((i) =>
      spawnStub(fx, `cap t4 stub ${i}`, { PI_BG_MAX_CONCURRENT: "0" }),
    );
    try {
      // 4 concurrent > the default cap of 3: only max=0 lets all start
      expect(await waitFor(() => countLivePiBg() - base >= 4)).toBe(true);
      const results = await Promise.all(stubs.map(collect));
      for (const r of results) {
        expect(r.code).toBe(0);
        expect(r.err).not.toContain("at cap");
      }
    } finally {
      killStubs(stubs, fx.tmp);
    }
  }, 30_000);

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
        const base = countLivePiBg(); // root-uid view: nobody excluded here too
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

  // Mirror of the script's cap count (see #41 tests): this uid's live
  // "pi-bg worker|reviewer" wrappers, fork-phantoms excluded.
  const countLivePiBg = (): number => {
    const out = execSync(`ps -U ${process.getuid()} -o pid=,ppid=,args=`, {
      encoding: "utf8",
    });
    let n = 0;
    for (const line of out.split("\n")) {
      const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
      if (!m) continue;
      const pid = Number(m[1]);
      if (pid === process.pid) continue;
      let argv: string[];
      try {
        argv = fs
          .readFileSync(`/proc/${pid}/cmdline`, "utf8")
          .split("\0")
          .filter(Boolean);
      } catch {
        continue;
      }
      let match = false;
      for (let i = 0; i < argv.length; i++) {
        if (
          argv[i].split("/").pop() === "pi-bg" &&
          i + 1 < argv.length &&
          (argv[i + 1] === "worker" || argv[i + 1] === "reviewer")
        ) {
          match = true;
          break;
        }
      }
      if (!match) continue;
      let identical = false;
      try {
        const p = fs
          .readFileSync(`/proc/${m[2]}/cmdline`, "utf8")
          .split("\0")
          .filter(Boolean)
          .join(" ");
        identical = argv.join(" ") === p;
      } catch {
        identical = false;
      }
      if (!identical) n++;
    }
    return n;
  };

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
    expect(cfg.defaultProvider).toBe("hydrogen"); // main merge intact
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
      JSON.stringify({ hydrogen: { type: "api_key", key: "sk-test" } }),
    );
    fs.writeFileSync(
      path.join(rp, "models.json"),
      JSON.stringify({ hydrogen: { models: [{ id: "qwen-test" }] } }),
    );
    fs.writeFileSync(
      path.join(rp, "settings.json"),
      JSON.stringify({
        defaultProvider: "hydrogen",
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
    const base = countLivePiBg();
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
      expect(await waitFor(() => countLivePiBg() - base >= 1)).toBe(true);
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
});
