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
    expect(
      fs.existsSync(path.join(fx.env.PI_BG_CG_ROOT, "pi-bg", runId)),
    ).toBe(false);
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
