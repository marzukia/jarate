/**
 * dispatch/jarate-bg — launch-path RETIREMENT tests (hall-monitor #35,
 * 2026-10-20) + the retained `signal` subcommand (issue #143, in-flight
 * intervention).
 *
 * The launch path is a stub: one stdout line (the ticket-line slot) +
 * the fleet notice on stderr + exit 10, with NO side effects (no pi exec,
 * no run record, no artifact-dir touch - in-flight runs own that space).
 * The `signal` subcommand kept its body verbatim; its contract is pinned
 * here (in-flight tickets need the mid-run intervention receipt).
 */
import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "bun";
import { isBgWebhook } from "../packages/bridge/channel/discord";

const PI_BG = path.join(import.meta.dir, "jarate-bg");

// Leak guard (issue: /tmp inode exhaustion, 2026-09-14): every fixture
// mkdtemp dir is tracked and force-removed in a file-level afterEach.
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

  // fake pi: proves a launch form reached the agent (the stub must not)
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
  // signal path: cgroup base in the fixture, not the real user slice
  env.PI_BG_CG_ROOT = path.join(tmp, "cg");
  delete env.PI_DISPATCH_WEBHOOK;
  // hermeticize the launcher-era env leaks (a suite running inside a
  // dispatched ticket inherits them; the stub ignores them, but the
  // signal path must see a clean HOME)
  delete env.PI_BG_TMPDIR;
  delete env.PI_BG_WT_DIR;
  delete env.PI_BG_SIGNAL_WAIT;

  const run = async (args: string[], stdin?: string): Promise<RunResult> => {
    const p = spawn(["bash", PI_BG, ...args], {
      env,
      cwd: tmp,
      stdout: "pipe",
      stderr: "pipe",
      stdin: stdin !== undefined ? "pipe" : "ignore",
    });
    if (stdin !== undefined) p.stdin?.write(stdin);
    if (stdin !== undefined) p.stdin?.end();
    const [out, err] = await Promise.all([
      new Response(p.stdout).text(),
      new Response(p.stderr).text(),
    ]);
    const code = await p.exited;
    return { code, out, err };
  };

  const records = () => {
    const dir = env.PI_DISPATCH_RECORD_DIR;
    if (!fs.existsSync(dir)) return []; // the stub never creates the dir
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")));
  };

  return { tmp, home, mainAgent, env, run, records };
}

const RETIRE_LINE =
  "jarate-bg: RETIRED (hall-monitor #35, 2026-10-20) - use the fleet: " +
  "POST http://100.95.144.25:8001/api/fleet/dispatch (X-Agent-Key header)";

// ─── launch path retired (hall-monitor #35) ──────────────────────────────

describe("launch path retired (hall-monitor #35): stub contract", () => {
  test("worker form: rc 10 + fleet notice, zero side effects", async () => {
    const fx = fixture();
    const r = await fx.run(["worker", "do the thing"]);
    expect(r.code).toBe(10);
    // the ticket-line slot: the FIRST stdout line is the retirement +
    // the fleet endpoint (dispatchers read it with `head -1 log`)
    expect(r.out.trim().split("\n")[0]).toBe(RETIRE_LINE);
    // the full notice rides stderr (the nohup 2>&1 log carries both)
    expect(r.err).toContain(
      "POST http://100.95.144.25:8001/api/fleet/dispatch",
    );
    expect(r.err).toContain("/srv/fleetwork/work/<ticket>");
    expect(r.err).toContain("/srv/fleetwork/<repo>.git");
    expect(r.err).toContain("pi-bg fleetwork");
    // zero side effects: pi never exec'd, no run record, the artifact
    // dir the in-flight runs own is untouched
    expect(fs.existsSync(path.join(fx.tmp, "pi-ran"))).toBe(false);
    expect(fx.records()).toEqual([]);
    expect(fs.existsSync(path.join(fx.home, ".pi-bg-art"))).toBe(false);
  });

  test("reviewer + stdin forms: same retirement, pi still never runs", async () => {
    const fx = fixture();
    const r1 = await fx.run(["reviewer", "review the PR"]);
    expect(r1.code).toBe(10);
    expect(r1.out.trim().split("\n")[0]).toBe(RETIRE_LINE);
    const r2 = await fx.run(["worker", "-"], "task via stdin");
    expect(r2.code).toBe(10);
    expect(r2.out.trim().split("\n")[0]).toBe(RETIRE_LINE);
    expect(fs.existsSync(path.join(fx.tmp, "pi-ran"))).toBe(false);
    expect(fx.records()).toEqual([]);
  });

  test("--help: rc 0, header carries the retirement + fleet endpoint", async () => {
    const fx = fixture();
    const r = await fx.run(["--help"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("RETIRED");
    expect(r.out).toContain(
      "POST http://100.95.144.25:8001/api/fleet/dispatch",
    );
    expect(r.out).toContain("jarate-bg signal");
  });

  test("stubbed launch does not create the records dir (no record written)", async () => {
    const fx = fixture();
    const r = await fx.run(["worker", "t"]);
    expect(r.code).toBe(10);
    // the stub never mkdir's the record dir (the launcher did)
    expect(fs.existsSync(fx.env.PI_DISPATCH_RECORD_DIR)).toBe(false);
  });
});

// ─── signal subcommand (issue #143): kept for in-flight tickets ──────────

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
      // #231 P1 terminal side effects: the drain confirmed the cgroup is
      // empty, so the record is finalized cancelled (parity with
      // jarate-bg-kill) and the -killed marker is written pre-signal
      // (it suppresses the wrapper's own no-output DIED)
      const rec = fx.records().find((r) => r.run === t);
      expect(rec.state).toBe("cancelled");
      expect(rec.finished).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
      expect(
        fs.existsSync(path.join(fx.home, ".pi-bg-art", `pi-bg-${t}-killed`)),
      ).toBe(true);
    } finally {
      parent?.kill("SIGKILL");
      await parent?.exited;
      srv.close();
    }
  }, 30_000);

  // #231 P1: a dead webhook must not make the kill silent. A failed
  // receipt post dead-letters the EXACT attempted body (the bg_post
  // shape, issue #53); the watchdog's dead-letter consumer re-posts it
  // next sweep.
  test("receipt post failure -> dead letter in the bg_post shape", async () => {
    const fx = fixture();
    const art = path.join(fx.tmp, "art");
    fx.env.PI_BG_TMPDIR = art;
    fs.mkdirSync(art, { recursive: true });
    let n = 0;
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: async () => {
        n++;
        return new Response("boom", { status: 500 });
      },
    });
    fx.env.PI_DISPATCH_WEBHOOK = `http://127.0.0.1:${server.port}/hook`;
    fx.env.PI_BG_WB_BACKOFF = "0";
    let w: ReturnType<typeof Bun.spawn> | null = null;
    try {
      const t = ST(7);
      w = Bun.spawn(["sleep", "300"], { stdout: "ignore", stderr: "ignore" });
      plant(fx, t, [String(w.pid)]);
      const r = await fx.run(["signal", t, "TERM"]);
      // the signal itself succeeded (member gone); only the receipt died
      expect(r.code).toBe(0);
      expect(r.out).toContain("all signaled members gone");
      expect(r.err).toContain(`dead letter: ${art}/pi-bg-${t}-webhook-failed`);
      expect(n).toBe(3); // 3 attempts, then the letter
      const lf = path.join(art, `pi-bg-${t}-webhook-failed`);
      expect(fs.existsSync(lf)).toBe(true);
      const letter = fs.readFileSync(lf, "utf8");
      // the EXACT bg_post shape (the watchdog 4f consumer parses it)
      expect(letter).toContain(`ticket   : ${t}`);
      expect(letter).toContain("http     : 500 (3 attempts)");
      expect(letter).toContain("response : boom");
      const marker = "--- body json ---";
      expect(letter).toContain(marker);
      const bodyJson = letter.split(marker).slice(1).join(marker).trim();
      const parsed = JSON.parse(bodyJson) as any;
      expect(parsed.embeds[0].title).toBe(`SIGNAL \u00b7 ${t}`);
      // the re-posted body must wake the channel (bridge exemption)
      expect(isBgWebhook({ ...parsed, webhook_id: "123" })).toBe(true);
      w.kill("SIGKILL");
      await w.exited;
      w = null;
    } finally {
      w?.kill("SIGKILL");
      await w?.exited;
      server.stop(true);
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
    const r1 = await fx.run(["signal", ST(6)]);
    expect(r1.code).toBe(2);
    expect(r1.err).toContain("usage:");
    const r2 = await fx.run(["signal", ST(6), "BANG"]);
    expect(r2.code).toBe(2);
    expect(r2.err).toContain("unknown signal");
    expect(deadlog(fx)).toBe("");
  }, 30_000);
});
