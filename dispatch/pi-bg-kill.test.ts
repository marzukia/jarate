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
