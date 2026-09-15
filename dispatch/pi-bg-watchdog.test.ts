/**
 * dispatch/pi-bg-watchdog — AGENTS.md drift tripwire (2026-09-14).
 *
 * Runs the real bash watchdog against a fake HOME with the REAL bin/jarate
 * symlinked in ($HOME/bin/jarate is what the watchdog calls). Asserts the
 * alert-only contract: one warning per drifted hash, state file gates
 * re-posting, re-bless clears drift, jarate missing -> silent skip, and the
 * sweep always exits 0.
 */
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "bun";

const WD = path.join(import.meta.dir, "pi-bg-watchdog");
const JARATE = path.join(import.meta.dir, "..", "bin", "jarate");

type Post = { embeds: Array<{ title: string; description: string }> };

/** Code lines of an embed's ```bash description block (the frame body). */
function codeLines(em: { description: string }): string[] {
  const m = em.description.match(/```bash\n([\s\S]*?)\n?```/);
  return m ? m[1].split("\n") : [];
}

function fixture() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pibgwd-drift-"));
  const home = path.join(tmp, "home");
  const agentDir = path.join(home, ".pi", "agent");
  const bin = path.join(home, "bin");
  fs.mkdirSync(agentDir, { recursive: true });
  fs.mkdirSync(bin, { recursive: true });
  fs.mkdirSync(path.join(tmp, "wt"), { recursive: true });
  fs.mkdirSync(path.join(tmp, "art"), { recursive: true });
  fs.writeFileSync(path.join(agentDir, "AGENTS.md"), "# law v1\n");
  // the watchdog calls $HOME/bin/jarate: use the real entrypoint
  fs.symlinkSync(JARATE, path.join(bin, "jarate"));

  const posts: Post[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: async (req) => {
      if (req.method === "POST") posts.push((await req.json()) as Post);
      return new Response("ok", { status: 200 });
    },
  });

  const env = { ...process.env } as Record<string, string>;
  env.HOME = home;
  env.PI_BG_WT_DIR = path.join(tmp, "wt"); // keep the sweep off real worktrees
  env.PI_BG_TMPDIR = path.join(tmp, "art");
  // keep the sweep (incl. the empty-cgroup reaper) off the real cgroup fs
  env.PI_BG_CG_ROOT = path.join(tmp, "cg");
  env.PI_DISPATCH_WEBHOOK = `http://127.0.0.1:${server.port}/hook`;
  delete env.PI_SERVICE;
  delete env.JARATE_AGENTS_MD;

  const run = async (
    args: string[] = [],
    overrides?: Record<string, string>,
  ) => {
    const p = spawn(["bash", WD, ...args], {
      env: { ...env, ...overrides },
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

  return {
    tmp,
    home,
    agentDir,
    art: path.join(tmp, "art"),
    agentsMd: () => path.join(agentDir, "AGENTS.md"),
    manifest: () => path.join(agentDir, ".agents-md-hash"),
    state: () => path.join(agentDir, ".agents-md-drift-warned"),
    posts,
    sha: (s: string) => createHash("sha256").update(s).digest("hex"),
    run,
    close: () => {
      server.stop(true);
      fs.rmSync(tmp, { recursive: true, force: true });
    },
  };
}

/** Write a manifest blessed for a DIFFERENT file content -> drift. */
const blessFor = (f: { manifest: () => string }) =>
  fs.writeFileSync(f.manifest(), `b0 2026-09-14T00:00:00Z  old-bless\n`);

describe("watchdog AGENTS.md drift tripwire (alert-only, one warn per hash)", () => {
  test("drift -> one warning with the spec message; state file written", async () => {
    const f = fixture();
    blessFor(f); // manifest hash b0 != current file hash
    try {
      const r = await f.run();
      expect(r.code).toBe(0);
      const h8 = f.sha("# law v1\n").slice(0, 8);
      expect(r.out).toContain(
        `AGENTS.md drift: ${h8} since 2026-09-14T00:00:00Z`,
      );
      expect(f.posts).toHaveLength(1);
      const em = f.posts[0].embeds[0];
      expect(em.title).toBe("AGENTS.md drift");
      expect(em.description).toBe(
        `AGENTS.md drift: ${h8} since 2026-09-14T00:00:00Z \u2014 review + re-bless: jarate agents-bless "note"`,
      );
      // state = full drifted hash (dedupe key)
      expect(fs.readFileSync(f.state(), "utf8").trim()).toBe(
        f.sha("# law v1\n"),
      );
    } finally {
      f.close();
    }
  });

  test("second sweep with the same drifted hash -> no re-post", async () => {
    const f = fixture();
    blessFor(f);
    try {
      await f.run();
      expect(f.posts).toHaveLength(1);
      const r = await f.run();
      expect(r.code).toBe(0);
      expect(f.posts).toHaveLength(1); // still one
      expect(r.out).not.toContain("AGENTS.md drift:");
    } finally {
      f.close();
    }
  });

  test("re-bless clears drift: sweep posts nothing", async () => {
    const f = fixture();
    blessFor(f);
    try {
      await f.run();
      expect(f.posts).toHaveLength(1);
      // approved change: re-bless the manifest to the current hash
      const p = spawn(["bash", JARATE, "agents-bless", "andryo approved"], {
        env: { ...process.env, HOME: f.home },
        cwd: f.tmp,
        stdout: "pipe",
        stderr: "pipe",
      });
      const out = await new Response(p.stdout).text();
      await p.exited;
      const d = JSON.parse(out);
      expect(d.ok).toBe(true);
      expect(d.hash).toBe(f.sha("# law v1\n"));
      const r = await f.run();
      expect(r.code).toBe(0);
      expect(f.posts).toHaveLength(1); // no new warning
      expect(r.out).not.toContain("AGENTS.md drift:");
    } finally {
      f.close();
    }
  });

  test("a NEW drifted hash (file changed again) -> one more warning", async () => {
    const f = fixture();
    blessFor(f);
    try {
      await f.run();
      expect(f.posts).toHaveLength(1);
      fs.appendFileSync(f.agentsMd(), "amendment\n");
      const r = await f.run();
      expect(r.code).toBe(0);
      expect(f.posts).toHaveLength(2);
      const h8 = f.sha("# law v1\namendment\n").slice(0, 8);
      expect(f.posts[1].embeds[0].description).toContain(h8);
      expect(fs.readFileSync(f.state(), "utf8").trim()).toBe(
        f.sha("# law v1\namendment\n"),
      );
      expect(r.out).toContain(`AGENTS.md drift: ${h8}`);
    } finally {
      f.close();
    }
  });

  test("never blessed (no manifest) -> ts falls back to AGENTS.md mtime", async () => {
    const f = fixture();
    try {
      const r = await f.run();
      expect(r.code).toBe(0);
      expect(f.posts).toHaveLength(1);
      const mtime = Math.floor(fs.statSync(f.agentsMd()).mtimeMs / 1000) * 1000;
      const ts = new Date(mtime).toISOString().replace(".000Z", "Z");
      expect(f.posts[0].embeds[0].description).toContain(`since ${ts}`);
      expect(fs.readFileSync(f.state(), "utf8").trim()).toBe(
        f.sha("# law v1\n"),
      );
    } finally {
      f.close();
    }
  });

  test("fallback layout: law file in ~/AGENTS.md, watchdog still warns once", async () => {
    const f = fixture();
    try {
      fs.rmSync(f.agentsMd());
      fs.writeFileSync(path.join(f.home, "AGENTS.md"), "# home law\n");
      const r = await f.run();
      expect(r.code).toBe(0);
      expect(f.posts).toHaveLength(1);
      const h8 = f.sha("# home law\n").slice(0, 8);
      expect(f.posts[0].embeds[0].description).toContain(h8);
      expect(fs.readFileSync(f.state(), "utf8").trim()).toBe(
        f.sha("# home law\n"),
      );
      await f.run();
      expect(f.posts).toHaveLength(1);
    } finally {
      f.close();
    }
  });

  test("jarate missing -> sweep exits 0, silent, no state file", async () => {
    const f = fixture();
    blessFor(f);
    fs.rmSync(path.join(f.home, "bin", "jarate"));
    try {
      const r = await f.run();
      expect(r.code).toBe(0);
      expect(f.posts).toHaveLength(0);
      expect(fs.existsSync(f.state())).toBe(false);
      expect(r.out).not.toContain("AGENTS.md drift:");
    } finally {
      f.close();
    }
  });

  test("no webhook -> drift detected, no post, no state (retry next sweep)", async () => {
    const f = fixture();
    blessFor(f);
    try {
      const r = await f.run([], { PI_DISPATCH_WEBHOOK: "" });
      expect(r.code).toBe(0);
      expect(r.out).toContain("AGENTS.md drift:");
      expect(f.posts).toHaveLength(0);
      expect(fs.existsSync(f.state())).toBe(false);
    } finally {
      f.close();
    }
  });

  test("--quiet -> no post, no state; --dry-run -> would-post line, no state", async () => {
    const f = fixture();
    blessFor(f);
    try {
      const rq = await f.run(["--quiet"]);
      expect(rq.code).toBe(0);
      expect(f.posts).toHaveLength(0);
      expect(fs.existsSync(f.state())).toBe(false);
      const rd = await f.run(["--dry-run"]);
      expect(rd.code).toBe(0);
      expect(f.posts).toHaveLength(0);
      expect(fs.existsSync(f.state())).toBe(false);
      expect(rd.out).toContain("dry-run: would post AGENTS.md drift warning");
    } finally {
      f.close();
    }
  });

  test("check fails (AGENTS.md deleted) -> sweep exits 0, silent", async () => {
    const f = fixture();
    blessFor(f);
    fs.rmSync(f.agentsMd());
    try {
      const r = await f.run();
      expect(r.code).toBe(0);
      expect(f.posts).toHaveLength(0);
      expect(fs.existsSync(f.state())).toBe(false);
    } finally {
      f.close();
    }
  });
});

/**
 * Empty-cgroup reaper (2026-09-14, pi-bg cgroup-dir leak): the sweep rmdirs
 * ticket dirs under $PI_BG_CG_ROOT/pi-bg that hold no process (no pids in
 * cgroup.procs AND no count in cgroup.threads). Non-empty dirs - live run,
 * or a plain-file test root with a leftover fake procs file - are untouched.
 */
describe("watchdog empty-cgroup reaper (leak belt+braces)", () => {
  const TID = (n: number) => `20991231-235959-${900 + n}`;
  const plant = (f: { tmp: string }, n: number): string => {
    const d = path.join(f.tmp, "cg", "pi-bg", TID(n));
    fs.mkdirSync(d, { recursive: true });
    return d; // mkdirSync(recursive) returns a created ANCESTOR, not the target
  };

  test("empty dirs reaped; dirs with members (procs or threads) untouched", async () => {
    const f = fixture();
    try {
      // bless the manifest for the current content: this test asserts on
      // posts, and an unblessed fixture would add one drift warning
      fs.writeFileSync(
        f.manifest(),
        `${f.sha("# law v1\n")} 2026-09-14T00:00:00Z  reaper test\n`,
      );
      const e1 = plant(f, 1);
      const e2 = plant(f, 2);
      const e3 = plant(f, 3);
      // non-empty: live pid in cgroup.procs (fake root: plain file)
      const live = plant(f, 4);
      fs.writeFileSync(path.join(live, "cgroup.procs"), `${process.pid}\n`);
      // non-empty: threaded mode (count in cgroup.threads only)
      const threaded = plant(f, 5);
      fs.writeFileSync(
        path.join(threaded, "cgroup.threads"),
        `${process.pid}\n`,
      );

      const r = await f.run();
      expect(r.code).toBe(0);
      for (const d of [e1, e2, e3]) {
        expect(r.out).toContain(`reaped empty cgroup ${d}`);
        expect(fs.existsSync(d)).toBe(false);
      }
      expect(r.out).toContain("reaped 3 empty cgroup dir(s)");
      expect(fs.existsSync(live)).toBe(true); // members -> untouched
      expect(fs.existsSync(threaded)).toBe(true); // members -> untouched
      // reaping is fs cleanup, not webhook alerting
      expect(f.posts).toHaveLength(0);
    } finally {
      f.close();
    }
  });

  test("--dry-run: would-reap lines, dirs stay", async () => {
    const f = fixture();
    try {
      const e1 = plant(f, 6);
      const e2 = plant(f, 7);
      const r = await f.run(["--dry-run"]);
      expect(r.code).toBe(0);
      expect(r.out).toContain(`dry-run: would reap empty cgroup ${e1}`);
      expect(r.out).toContain(`dry-run: would reap empty cgroup ${e2}`);
      expect(fs.existsSync(e1)).toBe(true);
      expect(fs.existsSync(e2)).toBe(true);
    } finally {
      f.close();
    }
  });

  test("no pi-bg dirs at all -> sweep exits 0, reaps nothing", async () => {
    const f = fixture();
    try {
      const r = await f.run();
      expect(r.code).toBe(0);
      expect(r.out).toContain(
        "sweep done: 0 dead ticket(s) found, 0 cgroup dir(s) reaped",
      );
    } finally {
      f.close();
    }
  });
});

/**
 * #57: SILENT classification. The pi-bg wrapper records its final exit
 * code (-rc, EXIT trap) and its one silent-death relaunch (-retry1, kept
 * when the retry did not recover). rc=1 + no out.md + unconsumed retry1
 * = the #57 idle-timeout failure mode, reported distinctly from generic
 * DEAD (SIGKILL/OOM) in the sweep line, the embed, and the digest.
 */
describe("watchdog #57: SILENT classification (rc=1, no output, retry1)", () => {
  const TID = (n: number) => `20991231-235959-${700 + n}`;

  /** Plant a dead ticket (no out.md, 30-min-old dir) + wrapper artifacts. */
  const plantDead = (
    f: { tmp: string; art: string },
    n: number,
    files: Record<string, string>,
  ): string => {
    const t = TID(n);
    const d = path.join(f.tmp, "wt", "jarate", t);
    fs.mkdirSync(d, { recursive: true });
    const old = new Date(Date.now() - 30 * 60 * 1000);
    fs.utimesSync(d, old, old);
    for (const [name, content] of Object.entries(files)) {
      fs.writeFileSync(path.join(f.art, name), content);
    }
    return t;
  };

  const bless = (f: { manifest: () => string; sha: (s: string) => string }) =>
    fs.writeFileSync(
      f.manifest(),
      `${f.sha("# law v1\n")} 2026-09-14T00:00:00Z  silent test\n`,
    );

  test("rc=1 + retry1 + no out.md -> SILENT (distinct embed, deduped, deadlogged)", async () => {
    const f = fixture();
    try {
      bless(f); // keep the drift warning out of posts
      const t = TID(1);
      plantDead(f, 1, {
        [`pi-bg-${t}-rc`]: "1\n",
        [`pi-bg-${t}-retry1`]: "",
        [`pi-bg-${t}-started`]: "",
      });
      const r = await f.run();
      expect(r.code).toBe(0);
      expect(r.out).toContain(`SILENT jarate/${t}`);
      expect(r.out).toContain(
        "silent death: rc=1, no output, retry1 did not recover",
      );
      expect(f.posts).toHaveLength(1);
      const em = f.posts[0].embeds[0];
      // title drops the rid (24 chars cannot fit in 32 with the kind);
      // the full ticket stays in the author name (pi-bg convention)
      expect(em.title).toBe("SILENT \u00b7 watchdog sweep");
      // note tail-clips to the 23-col value budget (head kept)
      expect(em.description).toContain("note   : silent death (issue");
      // 32-col law: every code line of the embed fits the mobile budget
      for (const line of codeLines(em)) {
        expect(line.length).toBeLessThanOrEqual(32);
      }
      // closing fence on its own line: the last content line is exactly
      // the 32-col line measured above (not content + "```")
      expect(em.description.endsWith("\n```")).toBe(true);
      // deadlog carries the SILENT reason
      const deadlog = path.join(f.home, ".pi-bg-deadlog");
      expect(fs.readFileSync(deadlog, "utf8")).toContain(`jarate`); // repo
      expect(fs.readFileSync(deadlog, "utf8")).toContain(
        `silent death: rc=1, no output, retry1 did not recover (issue #57)`,
      );
      // second sweep: deduped, no re-post
      const r2 = await f.run();
      expect(f.posts).toHaveLength(1);
      expect(r2.out).not.toContain(`SILENT jarate/${t}`);
    } finally {
      f.close();
    }
  }, 30_000);

  test("controls: rc=1 without retry1 -> DEAD; retry1 with rc=143 -> DEAD", async () => {
    const f = fixture();
    try {
      bless(f);
      const t1 = TID(2);
      plantDead(f, 2, { [`pi-bg-${t1}-rc`]: "1\n" });
      const t2 = TID(3);
      plantDead(f, 3, {
        [`pi-bg-${t2}-rc`]: "143\n",
        [`pi-bg-${t2}-retry1`]: "",
      });
      const r = await f.run();
      expect(r.code).toBe(0);
      expect(r.out).toContain(`DEAD jarate/${t1}`);
      expect(r.out).toContain(`DEAD jarate/${t2}`);
      expect(r.out).not.toContain("SILENT jarate/");
      expect(f.posts).toHaveLength(2);
      for (const em of f.posts.map((p) => p.embeds[0])) {
        expect(em.title).toBe("DEAD \u00b7 watchdog sweep");
        // note tail-clips; the head (classification) survives
        expect(em.description).toContain("no live pi-bg process");
        for (const line of codeLines(em)) {
          expect(line.length).toBeLessThanOrEqual(32);
        }
        expect(em.description.endsWith("\n```")).toBe(true);
      }
    } finally {
      f.close();
    }
  }, 30_000);

  test("4+ SILENT tickets -> one digest embed, kind visible per line", async () => {
    const f = fixture();
    try {
      bless(f);
      for (const n of [4, 5, 6, 7]) {
        const t = TID(n);
        plantDead(f, n, {
          [`pi-bg-${t}-rc`]: "1\n",
          [`pi-bg-${t}-retry1`]: "",
        });
      }
      const r = await f.run();
      expect(r.code).toBe(0);
      expect(f.posts).toHaveLength(1);
      const em = f.posts[0].embeds[0];
      expect(em.title).toBe("pi-bg \u00b7 4 dead tickets swept");
      for (const n of [4, 5, 6, 7]) {
        // two lines per ticket: full ticket (head-clipped to 32) + kind
        expect(em.description).toContain(`${TID(n)}`);
      }
      expect(em.description).toContain("  SILENT \u00b7 last ");
      for (const line of codeLines(em)) {
        expect(line.length).toBeLessThanOrEqual(32);
      }
      expect(em.description.endsWith("\n```")).toBe(true);
    } finally {
      f.close();
    }
  }, 30_000);
});
