/**
 * dispatch/pi-bg — fresh-machine doctor tests (issues #29, #30).
 *
 * Runs the real bash script against a fake HOME + a fake `pi` on PATH and
 * asserts on loud failure / warning text and the run record.
 */
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "bun";

const PI_BG = path.join(import.meta.dir, "pi-bg");

type RunResult = { code: number; out: string; err: string };

function fixture() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pibg-test-"));
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

  const env = { ...process.env } as Record<string, string>;
  env.HOME = home;
  env.PATH = `${bin}:${env.PATH ?? ""}`;
  env.PI_DISPATCH_RECORD_DIR = path.join(tmp, "records");
  delete env.PI_DISPATCH_WEBHOOK;
  delete env.PI_SERVICE;
  delete env.PI_BG_TMPDIR; // default-path tests must not inherit an override

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

    // on exit the wrapper moved itself back into the parent cgroup (drain)
    const parentProcs = fs
      .readFileSync(path.join(cgParent, "cgroup.procs"), "utf8")
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
    // prompt + output + raw + err all in the persistent dir
    for (const name of [
      `pi-bg-${id}-prompt.md`,
      `pi-bg-${id}-out.md`,
      `pi-bg-${id}-raw.out`,
      `pi-bg-${id}-err.log`,
    ]) {
      expect(fs.existsSync(path.join(art, name))).toBe(true);
    }
    // ...and not in /tmp
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
    const env = { ...process.env } as Record<string, string>;
    env.HOME = tmp;
    env.PI_BG_TMPDIR = path.join(tmp, "art");
    const r = await runScript(TAIL, ["20991231-235958-3"], env, tmp);
    expect(r.code).toBe(2);
    expect(r.err).toContain("no live output");
  });
});
