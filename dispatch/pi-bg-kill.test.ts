/**
 * dispatch/pi-bg-kill — v3 embed style (mockup3).
 *
 * Runs the real bash script against a fake cgroup (PI_BG_CG_ROOT override)
 * with a real sleeping victim, captures the webhook payload, and asserts
 * the framed description stays inside the 40-col mobile budget.
 */
import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "bun";

const KILL = path.join(import.meta.dir, "pi-bg-kill");

// Leak guard (issue: /tmp inode exhaustion, 2026-09-14): safety net for the
// pibgkill-* fixture dir (the test's try/finally already removes it; this
// covers a throw before the try block enters).
const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

describe("pi-bg-kill v3 embed: framed payload, 40-col budget", () => {
  test("kill posts a framed embed (no dingbat), pids + wait lines, <= 40 cols", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pibgkill-"));
    tmpDirs.push(tmp);
    const home = path.join(tmp, "home");
    fs.mkdirSync(home, { recursive: true });
    const cgRoot = path.join(tmp, "cg");
    const id = "20260913-120000-00001";
    const cg = path.join(cgRoot, "pi-bg", id);
    fs.mkdirSync(cg, { recursive: true });

    let body: { embeds: any[] } | null = null;
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: async (req) => {
        if (req.method === "POST") body = (await req.json()) as any;
        return new Response("ok", { status: 200 });
      },
    });

    // victim: a real sleeping process "inside" the fake cgroup
    const victim = spawn(["sleep", "300"], {
      stdout: "ignore",
      stderr: "ignore",
    });
    fs.writeFileSync(path.join(cg, "cgroup.procs"), `${victim.pid}\n`);

    const env = {
      ...process.env,
      HOME: home,
      PI_BG_CG_ROOT: cgRoot,
      PI_BG_TMPDIR: path.join(tmp, "art"),
      PI_DISPATCH_WEBHOOK: `http://127.0.0.1:${server.port}/hook`,
      PI_BG_WB_BACKOFF: "0",
      PI_BG_KILL_WAIT: "1",
    } as Record<string, string>;
    delete env.PI_SERVICE;

    const p = spawn(["bash", KILL, id], {
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

    try {
      expect(code).toBe(0);
      expect(out).toContain(`killed ${id}`);
      // victim is dead (SIGTERM or SIGKILL)
      expect(victim.exitCode ?? victim.killed).toBeTruthy();

      if (!body) throw new Error(`webhook not captured (stderr: ${err})`);
      const em = body.embeds[0];
      expect(em.title).toBe(`pi-bg ${id} · KILLED`);
      for (const ch of ["⛔", "✓", "✗", "⚠", "→", "—"]) {
        expect(em.title + em.description).not.toContain(ch);
      }
      const lines = em.description.split("\n");
      expect(lines[0]).toBe("```bash");
      expect(lines[1]).toBe(`┌ killed · ${id}`);
      // the "$ pi-bg-kill <rid>" line is 36 cols for this id: the rid head
      // clips (tail kept - the pid end is the discriminator)
      // at the 40-col budget the full rid fits the command line (34 cols)
      expect(lines[2]).toBe(`├ $ pi-bg-kill ${id}`);
      expect(lines.at(-2)).toBe("└");
      expect(lines.at(-1)).toBe("```");
      for (const l of lines) expect(l.length).toBeLessThanOrEqual(40);
      expect(em.description).toContain("├ pids  : ");
      // wait seconds include list_tree's /proc scan time -> match shape only
      expect(em.description).toMatch(/├ wait {2}: \d+s \(TERM->KILL\)/);
      expect(em.description).toContain("├ state : killed on request");
    } finally {
      victim.kill("SIGKILL");
      server.stop(true);
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }, 30_000);
});

/**
 * #56: whole-session kill. pi-bg runs under setsid: the wrapper is the
 * session + process-group leader and the pi child shares its PGID.
 * pi-bg-kill must signal the session's process group, not just the per-pid
 * cgroup walk - otherwise a group member that escaped the cgroup walk
 * (e.g. a child reparented away from the tree) would be orphaned.
 */
describe("pi-bg-kill #56: session process-group kill", () => {
  test("a group member outside the cgroup walk dies with the ticket", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pibgkill56-"));
    const home = path.join(tmp, "home");
    fs.mkdirSync(home, { recursive: true });
    const cgRoot = path.join(tmp, "cg");
    const id = "20260914-095600-00002";
    const cg = path.join(cgRoot, "pi-bg", id);
    fs.mkdirSync(cg, { recursive: true });

    // victim group leader: detached bash (pgid == sid == its own pid) that
    // execs sleep, plus a child that gets REPAIRED to init once its
    // subshell parent exits: same PGID, but listed in no cgroup file and
    // a no-descendant in the ppid walk - only the group signal can reach it.
    const cpidFile = path.join(tmp, "child.pid");
    const g = spawn(
      ["bash", "-c", `( sleep 300 & echo $! > ${cpidFile} ); exec sleep 300`],
      {
        detached: true,
        stdout: "ignore",
        stderr: "ignore",
        stdin: "ignore",
      },
    );
    await Bun.sleep(300); // subshell exits, child reparents
    fs.writeFileSync(path.join(cg, "cgroup.procs"), `${g.pid}\n`);

    const env = {
      ...process.env,
      HOME: home,
      PI_BG_CG_ROOT: cgRoot,
      PI_BG_TMPDIR: path.join(tmp, "art"),
      PI_BG_KILL_WAIT: "1",
    } as Record<string, string>;
    delete env.PI_DISPATCH_WEBHOOK;
    delete env.PI_SERVICE;

    const p = spawn(["bash", KILL, id], {
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

    try {
      expect(code).toBe(0);
      expect(out).toContain(`killed ${id}`);
      // the group leader died
      expect(g.exitCode ?? g.killed).toBeTruthy();
      // the group-only-reachable child died too (no orphan pi)
      const c = Number(fs.readFileSync(cpidFile, "utf8").trim());
      let gone = false;
      const t0 = Date.now();
      while (!gone && Date.now() - t0 < 5000) {
        gone = !fs.existsSync(`/proc/${c}`);
        if (!gone) await Bun.sleep(100);
      }
      if (!gone) throw new Error(`child ${c} survived the kill (err: ${err})`);
    } finally {
      try {
        g.kill("SIGKILL");
      } catch {
        /* already dead */
      }
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }, 30_000);
});

/**
 * #86: short-id resolution. The strict full-id regex made the natural
 * cleanup call `pi-bg-kill 2332046` a silent exit-2 no-op (the incident
 * loop had stderr on /dev/null and four live workers died un-killled).
 * A 7+ digit numeric arg must resolve against the run records: exactly
 * one match -> kill that ticket; 0 or 2+ matches -> exit 2 with a clear
 * error on stderr. Non-numeric junk -> exit 2 (the incident's literal
 * glob `20260925-*2332046*` was passed as a single arg).
 */
describe("pi-bg-kill #86: short-id resolution (run records)", () => {
  const FULL = "20260925-201500-2332046";
  const SUFFIX = "2332046";

  type Env = Record<string, string>;

  const setup = (withCgroup: boolean) => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pibgkill86-"));
    tmpDirs.push(tmp);
    const home = path.join(tmp, "home");
    const recDir = path.join(tmp, "records");
    const cgRoot = path.join(tmp, "cg");
    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(recDir, { recursive: true });
    const cg = path.join(cgRoot, "pi-bg", FULL);
    if (withCgroup) fs.mkdirSync(cg, { recursive: true });
    const env: Env = {
      ...process.env,
      HOME: home,
      PI_BG_CG_ROOT: cgRoot,
      PI_BG_TMPDIR: path.join(tmp, "art"),
      PI_DISPATCH_RECORD_DIR: recDir,
      PI_DISPATCH_WEBHOOK: "",
      PI_BG_KILL_WAIT: "1",
    };
    delete env.PI_SERVICE;
    const writeRec = (run: string) =>
      fs.writeFileSync(
        path.join(recDir, `pi-bg-${run}.json`),
        JSON.stringify({
          run,
          profile: "worker",
          project: null,
          cwd: path.join(tmp, "workdir"),
          started: "2026-09-25T20:15:00Z",
          delivery: "webhook",
          state: "running",
        }),
      );
    const runKill = async (arg: string) => {
      const p = spawn(["bash", KILL, arg], {
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
    const close = () => fs.rmSync(tmp, { recursive: true, force: true });
    return { tmp, cg, env, writeRec, runKill, close };
  };

  test("unique short id resolves via run record and kills the ticket", async () => {
    const s = setup(true);
    s.writeRec(FULL);
    const victim = spawn(["sleep", "300"], {
      stdout: "ignore",
      stderr: "ignore",
    });
    fs.writeFileSync(path.join(s.cg, "cgroup.procs"), `${victim.pid}\n`);

    let posted = 0;
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: async () => {
        posted += 1;
        return new Response("ok", { status: 200 });
      },
    });
    s.env.PI_DISPATCH_WEBHOOK = `http://127.0.0.1:${server.port}/hook`;
    s.env.PI_BG_WB_BACKOFF = "0";

    const r = await s.runKill(SUFFIX);
    try {
      expect(r.code).toBe(0);
      // resolved to the FULL id, not the suffix
      expect(r.out).toContain(`killed ${FULL}`);
      expect(r.err).toContain(`short id ${SUFFIX} -> ${FULL}`);
      expect(victim.exitCode ?? victim.killed).toBeTruthy();
      expect(posted).toBe(1);
    } finally {
      victim.kill("SIGKILL");
      server.stop(true);
      s.close();
    }
  }, 30_000);

  test("no run record match -> exit 2, clear error naming the arg", async () => {
    const s = setup(false);
    s.writeRec("20260925-201500-9999999"); // different suffix
    const r = await s.runKill("1234567");
    expect(r.code).toBe(2);
    expect(r.err).toContain("no run record");
    expect(r.err).toContain("1234567");
    s.close();
  });

  test("ambiguous short id (two records) -> exit 2 naming both", async () => {
    const s = setup(false);
    s.writeRec(FULL);
    s.writeRec("20260924-090000-2332046");
    const r = await s.runKill(SUFFIX);
    expect(r.code).toBe(2);
    expect(r.err).toContain("ambiguous");
    expect(r.err).toContain(FULL);
    expect(r.err).toContain("20260924-090000-2332046");
    s.close();
  });

  test("non-numeric arg -> exit 2 (the incident's literal glob)", async () => {
    const s = setup(false);
    s.writeRec(FULL);
    const r = await s.runKill("20260925-*2332046*");
    expect(r.code).toBe(2);
    expect(r.err).toContain("not a ticket id");
    s.close();
  });

  test("resolved short id without cgroup dir -> exit 2 (existing path)", async () => {
    const s = setup(false); // record exists, cgroup dir does not
    s.writeRec(FULL);
    const r = await s.runKill(SUFFIX);
    expect(r.code).toBe(2);
    // resolution succeeded first, then the standard unknown-ticket error
    expect(r.err).toContain(`short id ${SUFFIX} -> ${FULL}`);
    expect(r.err).toContain(`no cgroup for ticket '${FULL}'`);
    s.close();
  });

  test("full id still accepted unchanged (no record dir needed)", async () => {
    const s = setup(false);
    fs.rmSync(s.env.PI_DISPATCH_RECORD_DIR, { recursive: true, force: true });
    // full id + no cgroup -> exit 2 at the cgroup check, proving the full
    // id never went through the record-resolution branch
    const r = await s.runKill(FULL);
    expect(r.code).toBe(2);
    expect(r.err).toContain(`no cgroup for ticket '${FULL}'`);
    expect(r.err).not.toContain("short id");
    s.close();
  });
});
