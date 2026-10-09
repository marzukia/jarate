/**
 * dispatch/jarate-bg-kill — v3 embed style (mockup3) + #51 CANCELLED class.
 *
 * Runs the real bash script against a fake cgroup (PI_BG_CG_ROOT override)
 * with a real sleeping victim, captures the webhook payload, and asserts
 * the framed description stays inside the 40-col mobile budget. A manual
 * kill is the CANCELLED terminal state (issue #51): the embed says
 * CANCELLED and the run record ends state=cancelled (distinct from
 * state=killed, the watchdog/launch-fail audit path).
 */
import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "bun";

const KILL = path.join(import.meta.dir, "jarate-bg-kill");

// Leak guard (issue: /tmp inode exhaustion, 2026-09-14): safety net for the
// pibgkill-* fixture dir (the test's try/finally already removes it; this
// covers a throw before the try block enters).
const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

describe("jarate-bg-kill v3 embed: framed payload, 40-col budget", () => {
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

    // run record: the kill must end it state=cancelled (#51 CANCELLED
    // class, distinct from state=killed). Seeded state=done: the wrapper's
    // exit trap writes "done" during the drain poll, the kill finalizes.
    const recDir = path.join(tmp, "records");
    fs.mkdirSync(recDir, { recursive: true });
    const recFile = path.join(recDir, `pi-bg-${id}.json`);
    fs.writeFileSync(
      recFile,
      JSON.stringify({
        run: id,
        profile: "worker",
        project: null,
        cwd: tmp,
        started: "2026-09-13T12:00:00Z",
        delivery: "webhook",
        state: "done",
      }),
    );

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
      PI_DISPATCH_RECORD_DIR: recDir,
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
      expect(em.title).toBe(`pi-bg ${id} · CANCELLED`);
      for (const ch of ["⛔", "✓", "✗", "⚠", "→", "—"]) {
        expect(em.title + em.description).not.toContain(ch);
      }
      const lines = em.description.split("\n");
      expect(lines[0]).toBe("```bash");
      expect(lines[1]).toBe(`┌ cancelled · ${id}`);
      // the "$ jarate-bg-kill <rid>" line is 36 cols for this id: the rid head
      // clips (tail kept - the pid end is the discriminator)
      // at the 40-col budget the full rid fits the command line (34 cols)
      expect(lines[2]).toBe(`├ $ jarate-bg-kill ${id}`);
      expect(lines.at(-2)).toBe("└");
      expect(lines.at(-1)).toBe("```");
      for (const l of lines) expect(l.length).toBeLessThanOrEqual(40);
      expect(em.description).toContain("├ pids   : ");
      // wait seconds include list_tree's /proc scan time -> match shape only
      expect(em.description).toMatch(/├ wait {3}: \d+s \(TERM->KILL\)/);
      expect(em.description).toContain("├ state  : cancelled on request");
      // #51: the run record ends state=cancelled ("cancelled" is the
      // final state for a manual kill, over the wrapper's "done")
      expect(JSON.parse(fs.readFileSync(recFile, "utf8")).state).toBe(
        "cancelled",
      );
    } finally {
      victim.kill("SIGKILL");
      server.stop(true);
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }, 30_000);
});

/**
 * #53: self-contained kill dead letter. When the CANCELLED post fails all
 * 3 attempts the kill writes a dead letter; it now embeds the JSON body
 * after the `--- body json ---` marker (the body file is rm -f'd right
 * after), so the watchdog can re-post the CANCELLED on a later sweep.
 */
describe("jarate-bg-kill #53: self-contained dead letter", () => {
  test("post failure: the kill letter embeds the CANCELLED body", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pibgkill53-"));
    tmpDirs.push(tmp);
    const home = path.join(tmp, "home");
    fs.mkdirSync(home, { recursive: true });
    const cgRoot = path.join(tmp, "cg");
    const id = "20260913-120000-00009";
    const cg = path.join(cgRoot, "pi-bg", id);
    fs.mkdirSync(cg, { recursive: true });

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
      // port 9 (discard): conn refused -> all 3 attempts 000
      PI_DISPATCH_WEBHOOK: "http://127.0.0.1:9/dl",
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
      expect(err).toContain("webhook FAILED");
      const letterPath = path.join(
        tmp,
        "art",
        `pi-bg-${id}-kill-webhook-failed`,
      );
      expect(fs.existsSync(letterPath)).toBe(true);
      const letter = fs.readFileSync(letterPath, "utf8");
      expect(letter).toContain(`ticket   : ${id}`);
      expect(letter).toContain("event    : kill");
      expect(letter).toContain("http     : 000 (3 attempts)");
      const marker = "--- body json ---";
      expect(letter).toContain(marker);
      // the embedded body is the CANCELLED embed, valid JSON
      const bodyJson = letter.split(marker).slice(1).join(marker).trim();
      const parsed = JSON.parse(bodyJson) as { embeds: { title: string }[] };
      expect(parsed.embeds[0].title).toBe(`pi-bg ${id} \u00b7 CANCELLED`);
    } finally {
      victim.kill("SIGKILL");
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }, 30_000);
});

/**
 * #56: whole-session kill. jarate-bg runs under setsid: the wrapper is the
 * session + process-group leader and the pi child shares its PGID.
 * jarate-bg-kill must signal the session's process group, not just the per-pid
 * cgroup walk - otherwise a group member that escaped the cgroup walk
 * (e.g. a child reparented away from the tree) would be orphaned.
 */
describe("jarate-bg-kill #56: session process-group kill", () => {
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
 * cleanup call `jarate-bg-kill 2332046` a silent exit-2 no-op (the incident
 * loop had stderr on /dev/null and four live workers died un-killled).
 * A 7+ digit numeric arg must resolve against the run records: exactly
 * one match -> kill that ticket; 0 or 2+ matches -> exit 2 with a clear
 * error on stderr. Non-numeric junk -> exit 2 (the incident's literal
 * glob `20260925-*2332046*` was passed as a single arg).
 */
describe("jarate-bg-kill #86: short-id resolution (run records)", () => {
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

/**
 * review #183 F5: an operator interrupt during the drain (INT/TERM to
 * jarate-bg-kill) used to leave the PROVISIONAL (kill-in-progress) marker
 * in place: the wrapper's exit trap - running concurrently with the drain
 * poll - suppressed its DIED post on sight of it, and the kill exited
 * before the CANCELLED post + record finalize, so the ticket ended with
 * ZERO terminal embeds. The INT/TERM path now drops the provisional
 * marker (the wrapper posts DIED - pre-interrupt behavior); a second full
 * run of jarate-bg-kill posts CANCELLED (empty cgroup, instant drain).
 */
describe("jarate-bg-kill interrupt: provisional marker dropped (review F5)", () => {
  test("SIGINT mid-drain: exit 130, marker gone, no CANCELLED post", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pibgkillint-"));
    tmpDirs.push(tmp);
    const home = path.join(tmp, "home");
    fs.mkdirSync(home, { recursive: true });
    const cgRoot = path.join(tmp, "cg");
    const id = "20260913-120000-00015";
    const cg = path.join(cgRoot, "pi-bg", id);
    fs.mkdirSync(cg, { recursive: true });

    let posted = false;
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: async (req) => {
        if (req.method === "POST") posted = true;
        return new Response("ok", { status: 200 });
      },
    });

    // victim that ignores TERM: holds the drain open (the interrupt
    // lands mid-poll, long before KILL_WAIT)
    const victim = spawn(
      ["bash", "-c", 'trap "" TERM; while :; do sleep 0.2; done'],
      { stdout: "ignore", stderr: "ignore", stdin: "ignore" },
    );
    fs.writeFileSync(path.join(cg, "cgroup.procs"), `${victim.pid}\n`);

    const marker = path.join(tmp, "art", `pi-bg-${id}-killed`);
    const env = {
      ...process.env,
      HOME: home,
      PI_BG_CG_ROOT: cgRoot,
      PI_BG_TMPDIR: path.join(tmp, "art"),
      PI_DISPATCH_WEBHOOK: `http://127.0.0.1:${server.port}/hook`,
      PI_BG_WB_BACKOFF: "0",
      PI_BG_KILL_WAIT: "10", // the drain window the interrupt lands in
    } as Record<string, string>;
    delete env.PI_SERVICE;

    const p = spawn(["bash", KILL, id], {
      env,
      cwd: tmp,
      stdout: "pipe",
      stderr: "pipe",
    });
    try {
      // wait for the provisional marker (written BEFORE the TERM)
      const t0 = Date.now();
      while (!fs.existsSync(marker)) {
        if (Date.now() - t0 > 10_000) {
          throw new Error(`provisional marker never appeared: ${marker}`);
        }
        await Bun.sleep(50);
      }
      expect(fs.readFileSync(marker, "utf8")).toContain("kill-in-progress");
      // interrupt mid-drain (the victim ignores TERM: still polling)
      p.kill("SIGINT");
      const [out, err] = await Promise.all([
        new Response(p.stdout).text(),
        new Response(p.stderr).text(),
      ]);
      const code = await p.exited;
      if (code !== 130) {
        throw new Error(`expected 130, got ${code}\nOUT: ${out}\nERR: ${err}`);
      }
      // the provisional marker is dropped: the wrapper (still draining in
      // parallel) no longer sees it and posts DIED - the ticket never
      // ends with zero terminal embeds
      expect(fs.existsSync(marker)).toBe(false);
      // the kill exited before the CANCELLED post + record finalize
      expect(posted).toBe(false);
    } finally {
      try {
        victim.kill("SIGKILL");
      } catch {
        /* already dead */
      }
      server.stop(true);
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }, 40_000);
});

/**
 * audit dispatch-core P12: SIGKILL escalation. A TERM-immune victim holds
 * the drain open for the full PI_BG_KILL_WAIT window; the kill must then
 * escalate to per-pid SIGKILL (with the cgroup.kill guard firing, since
 * the cgroup is still non-empty). Pre-fix coverage: every kill test used
 * a plain `sleep` victim that dies on TERM, so the escalation branch
 * (gone=0 path) never ran.
 */
describe("jarate-bg-kill P12: SIGKILL escalation on TERM-immune victim", () => {
  test("TERM-immune victim: survives the grace window, dies of SIGKILL (137)", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pibgkillp12-"));
    tmpDirs.push(tmp);
    const home = path.join(tmp, "home");
    fs.mkdirSync(home, { recursive: true });
    const cgRoot = path.join(tmp, "cg");
    const id = "20260913-120000-00017";
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

    // run record: the escalation path still finalizes state=cancelled
    const recDir = path.join(tmp, "records");
    fs.mkdirSync(recDir, { recursive: true });
    const recFile = path.join(recDir, `pi-bg-${id}.json`);
    fs.writeFileSync(
      recFile,
      JSON.stringify({
        run: id,
        profile: "worker",
        project: null,
        cwd: tmp,
        started: "2026-09-13T12:00:00Z",
        delivery: "webhook",
        state: "done",
      }),
    );

    // TERM-immune victim that RECORDS the TERM (handler runs, loop keeps
    // going): proves the TERM was delivered and survived - the death that
    // follows must therefore be the KILL escalation.
    const termRcvd = path.join(tmp, "term-rcvd");
    const victim = spawn(
      [
        "bash",
        "-c",
        `trap 'touch ${termRcvd}' TERM; while :; do sleep 0.2; done`,
      ],
      { stdout: "ignore", stderr: "ignore", stdin: "ignore" },
    );
    fs.writeFileSync(path.join(cg, "cgroup.procs"), `${victim.pid}\n`);

    const env = {
      ...process.env,
      HOME: home,
      PI_BG_CG_ROOT: cgRoot,
      PI_BG_TMPDIR: path.join(tmp, "art"),
      PI_DISPATCH_RECORD_DIR: recDir,
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
    const vcode = await victim.exited;

    try {
      expect(code).toBe(0);
      expect(out).toContain(`killed ${id}`);
      // the TERM was delivered (handler ran) and ignored
      expect(fs.existsSync(termRcvd)).toBe(true);
      // the victim died of SIGKILL, not TERM: 137 = 128+9. A TERM death
      // would be 143 and would mean the escalation never fired.
      expect(vcode).toBe(137);
      // cgroup.kill guard: the cgroup was still non-empty at escalation,
      // so the blind kill switch was skipped in favor of per-pid SIGKILL
      expect(err).toContain("skipping cgroup.kill");
      expect(err).toContain("not empty (live PIDs)");
      // the kill-marker final line: real duration >= the 1s grace window,
      // victim pid in the pids list
      const marker = fs.readFileSync(
        path.join(tmp, "art", `pi-bg-${id}-killed`),
        "utf8",
      );
      const finalLine = marker.trim().split("\n").at(-1) as string;
      const dur = Number(finalLine.match(/after (\d+)s/)?.[1]);
      expect(dur).toBeGreaterThanOrEqual(1);
      expect(finalLine).toContain(`pids: ${victim.pid} `);
      // embed wait line reflects the escalation window
      expect(body?.embeds[0].description).toMatch(
        /\u251c wait {3}: \d+s \(TERM->KILL\)/,
      );
      // record finalized cancelled after the escalation path
      expect(JSON.parse(fs.readFileSync(recFile, "utf8")).state).toBe(
        "cancelled",
      );
    } finally {
      try {
        victim.kill("SIGKILL");
      } catch {
        /* already dead */
      }
      server.stop(true);
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }, 30_000);
});

/**
 * audit dispatch-core P13 (kill side): webhook URL precedence when BOTH
 * the env var and the file are set. jarate-bg-kill resolves PI_DISPATCH_
 * WEBHOOK first, the file only fills an EMPTY env (same rule as
 * jarate-bg). The file is parked on a dead port: if the file ever won,
 * the CANCELLED post would die there and dead-letter.
 */
describe("jarate-bg-kill P13: kill webhook env-vs-file precedence", () => {
  test("both set: env PI_DISPATCH_WEBHOOK wins over the file", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pibgkillp13-"));
    tmpDirs.push(tmp);
    const home = path.join(tmp, "home");
    fs.mkdirSync(home, { recursive: true });
    const cgRoot = path.join(tmp, "cg");
    const id = "20260913-120000-00018";
    const cg = path.join(cgRoot, "pi-bg", id);
    fs.mkdirSync(cg, { recursive: true });

    const posts: any[] = [];
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: async (req) => {
        if (req.method === "POST") posts.push((await req.json()) as any);
        return new Response("ok", { status: 200 });
      },
    });
    const cfg = path.join(home, ".config", "pi-dispatch");
    fs.mkdirSync(cfg, { recursive: true });
    // dead port: if the file URL ever won, the terminal post dies here
    fs.writeFileSync(path.join(cfg, "webhook"), "http://127.0.0.1:9/dead\n");

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
      // env won: the CANCELLED post landed on the live server
      expect(posts).toHaveLength(1);
      expect(posts[0].embeds[0].title).toBe(`pi-bg ${id} \u00b7 CANCELLED`);
      // the dead file URL was never hit: no dead letter, no failure text
      const art = path.join(tmp, "art");
      const deadLetters = fs
        .readdirSync(art)
        .filter((f) => f.includes("webhook-failed"));
      expect(deadLetters).toHaveLength(0);
      expect(err).not.toContain("webhook FAILED");
    } finally {
      victim.kill("SIGKILL");
      server.stop(true);
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }, 30_000);
});
