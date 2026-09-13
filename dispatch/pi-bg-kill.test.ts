/**
 * dispatch/pi-bg-kill — v3 embed style (mockup3).
 *
 * Runs the real bash script against a fake cgroup (PI_BG_CG_ROOT override)
 * with a real sleeping victim, captures the webhook payload, and asserts
 * the framed description stays inside the 40-col mobile budget.
 */
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "bun";

const KILL = path.join(import.meta.dir, "pi-bg-kill");

describe("pi-bg-kill v3 embed: framed payload, 40-col budget", () => {
  test("kill posts a framed embed (no dingbat), pids + wait lines, <= 40 cols", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pibgkill-"));
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
      expect(lines[2]).toBe(`├ $ pi-bg-kill ${id}`);
      expect(lines.at(-2)).toBe("└");
      expect(lines.at(-1)).toBe("```");
      for (const l of lines) expect(l.length).toBeLessThanOrEqual(40);
      expect(em.description).toContain("├ pids  : ");
      // wait seconds include list_tree's /proc scan time -> match shape only
      expect(em.description).toMatch(/├ wait {2}: \d+s \(SIGTERM->SIGKILL\)/);
      expect(em.description).toContain("├ state : killed on request");
    } finally {
      victim.kill("SIGKILL");
      server.stop(true);
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }, 30_000);
});
