/**
 * dispatch/jarate-bg-watchdog — AGENTS.md drift tripwire (2026-09-14).
 *
 * Runs the real bash watchdog against a fake HOME with the REAL bin/jarate
 * symlinked in ($HOME/bin/jarate is what the watchdog calls). Asserts the
 * alert-only contract: one warning per drifted hash, state file gates
 * re-posting, re-bless clears drift, jarate missing -> silent skip, and the
 * sweep always exits 0.
 */
import { describe, expect, test } from "bun:test";
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "bun";

const WD = path.join(import.meta.dir, "jarate-bg-watchdog");
const JB = path.join(import.meta.dir, "jarate-bg");
const JARATE = path.join(import.meta.dir, "..", "bin", "jarate");

type Post = {
  embeds: Array<{
    title: string;
    description: string;
    author?: { name: string };
  }>;
};

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
    wtDir: path.join(tmp, "wt"),
    art: path.join(tmp, "art"),
    env,
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
      // C9 (polish sweep): the raw drift line is fenced (not clipped to
      // the 160 cap) and word-wrapped to the 40-col budget; the em-dash
      // is an ASCII " - " (B3).
      expect(em.description).toBe(
        [
          "```",
          `AGENTS.md drift: ${h8} since`,
          `2026-09-14T00:00:00Z - review +`,
          're-bless: jarate agents-bless "note"',
          "```",
        ].join("\n"),
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
      const p = spawn(["bash", JARATE, "agents-bless", "operator approved"], {
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
      // wrapped fence: the ts leads its own line (C9)
      expect(f.posts[0].embeds[0].description).toContain(`${ts} - review +`);
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
      // #101: age the dirs past REAPER_MIN_AGE (fresh dirs are skipped-young)
      const age = (d: string) =>
        fs.utimesSync(
          d,
          new Date(Date.now() - 10 * 60 * 1000),
          new Date(Date.now() - 10 * 60 * 1000),
        );
      const e1 = plant(f, 1);
      const e2 = plant(f, 2);
      const e3 = plant(f, 3);
      for (const d of [e1, e2, e3]) age(d);
      // non-empty: live pid in cgroup.procs (fake root: plain file)
      const live = plant(f, 4);
      fs.writeFileSync(path.join(live, "cgroup.procs"), `${process.pid}\n`);
      age(live);
      // non-empty: threaded mode (count in cgroup.threads only)
      const threaded = plant(f, 5);
      fs.writeFileSync(
        path.join(threaded, "cgroup.threads"),
        `${process.pid}\n`,
      );
      age(threaded);

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
      const old = new Date(Date.now() - 10 * 60 * 1000);
      fs.utimesSync(e1, old, old);
      fs.utimesSync(e2, old, old);
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

  test("#101: young empty dir (age < REAPER_MIN_AGE) is skipped, not reaped", async () => {
    const f = fixture();
    try {
      const young = plant(f, 8); // fresh: mtime = now
      const aged = plant(f, 9);
      const old = new Date(Date.now() - 10 * 60 * 1000);
      fs.utimesSync(aged, old, old);
      const r = await f.run();
      expect(r.code).toBe(0);
      expect(fs.existsSync(young)).toBe(true); // skipped, NOT rmdir'd
      expect(r.out).toContain(
        "skipped 1 young cgroup dir(s) (age < 300s, issue #101)",
      );
      expect(fs.existsSync(aged)).toBe(false); // old empty dir still reaped
      expect(r.out).toContain(`reaped empty cgroup ${aged}`);
      // the override opens the window: with MIN_AGE=0 the fresh dir is reaped too
      const f2 = fixture();
      try {
        const y2 = plant(f2, 10);
        const r2 = await f2.run([], { PI_BG_REAPER_MIN_AGE: "0" });
        expect(r2.code).toBe(0);
        expect(fs.existsSync(y2)).toBe(false);
      } finally {
        f2.close();
      }
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
 * #57: SILENT classification. The jarate-bg wrapper records its final exit
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
      // note tail-clips to the 29-col value budget (head kept)
      expect(em.description).toContain("note   : silent death (issue");
      // 40-col law: every frame line of the embed fits the mobile budget
      for (const line of codeLines(em)) {
        expect(line.length).toBeLessThanOrEqual(40);
      }
      // closing fence on its own line: the last content line is exactly
      // the 40-col line measured above (not content + "```")
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
        expect(em.description).toContain("no live process");
        for (const line of codeLines(em)) {
          expect(line.length).toBeLessThanOrEqual(40);
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
        // two lines per ticket: full ticket (head-clipped to 30) + kind
        expect(em.description).toContain(`${TID(n)}`);
      }
      expect(em.description).toContain("  SILENT \u00b7 last ");
      for (const line of codeLines(em)) {
        expect(line.length).toBeLessThanOrEqual(40);
      }
      expect(em.description.endsWith("\n```")).toBe(true);
    } finally {
      f.close();
    }
  }, 30_000);
});

/**
 * #86: cwd-ticket sweep. Non-worktree dispatches leave no dir under
 * $PI_BG_WT_DIR, so the worktree sweep never saw them: 2026-09-25 four
 * SIGKILLed cwd workers kept state=running records + stale heartbeats and
 * the watchdog found "0 dead, 0 stalled". DEAD (cwd) = record
 * state=running AND ticket cgroup empty (no processes - "stale" means
 * no processes) OR cgroup dir already reaped/absent (#116) AND
 * heartbeat stale > STALL_MIN min.
 * On DEAD: dead webhook (same payload as the worktree sweep), dead log,
 * cgroup reaped via the guarded cgroup.kill, record marked state=killed.
 */
describe("watchdog #86: cwd-ticket sweep (non-worktree dispatches)", () => {
  const TID = (n: number) => `20991231-235958-${800 + n}`;
  const recFile = (f: { home: string }, t: string) =>
    path.join(f.home, ".pi-dispatch", "runs", `pi-bg-${t}.json`);
  const cgDir = (f: { tmp: string }, t: string) =>
    path.join(f.tmp, "cg", "pi-bg", t);

  const plant = (
    f: { home: string; tmp: string; art: string },
    n: number,
    opts: {
      state?: string;
      hbAgeMin?: number;
      cg?: "empty" | "live" | "missing";
      cwd?: string;
    } = {},
  ): string => {
    const t = TID(n);
    const recDir = path.join(f.home, ".pi-dispatch", "runs");
    fs.mkdirSync(recDir, { recursive: true });
    fs.writeFileSync(
      path.join(recDir, `pi-bg-${t}.json`),
      JSON.stringify(
        {
          run: t,
          profile: "worker",
          project: null,
          cwd: opts.cwd ?? path.join(f.tmp, "workdir"),
          started: "2026-09-25T10:00:00Z",
          delivery: "webhook",
          state: opts.state ?? "running",
        },
        null,
        2,
      ),
    );
    if (opts.cg !== "missing") {
      fs.mkdirSync(cgDir(f, t), { recursive: true });
      if (opts.cg === "live") {
        fs.writeFileSync(
          path.join(cgDir(f, t), "cgroup.procs"),
          `${process.pid}\n`,
        );
      }
    }
    if (opts.hbAgeMin !== undefined) {
      const hb = path.join(f.art, `pi-bg-${t}-hb`);
      fs.writeFileSync(hb, "");
      const old = new Date(Date.now() - opts.hbAgeMin * 60 * 1000);
      fs.utimesSync(hb, old, old);
    }
    return t;
  };

  // bless the manifest for the CURRENT content: keeps the drift warning
  // out of posts so the sweep's DEAD post is the only embed
  const bless = (f: { manifest: () => string; sha: (s: string) => string }) =>
    fs.writeFileSync(
      f.manifest(),
      `${f.sha("# law v1\n")} 2026-09-14T00:00:00Z  cwd sweep test\n`,
    );

  test("running + empty cgroup + stale hb -> DEAD post, record killed, cgroup reaped", async () => {
    const f = fixture();
    try {
      bless(f);
      const t = plant(f, 1, { hbAgeMin: 15, cg: "empty" });
      const r = await f.run();
      expect(r.code).toBe(0);
      expect(r.out).toContain(`DEAD cwd/${t}`);
      expect(r.out).toContain(
        "cwd run: cgroup empty, heartbeat stale > 10 min (issue #86)",
      );
      expect(r.out).toContain("1 cwd ticket(s) flagged");
      expect(f.posts).toHaveLength(1);
      const em = f.posts[0].embeds[0];
      // same payload shape as the worktree sweep's DEAD embed
      expect(em.title).toBe("DEAD \u00b7 watchdog sweep");
      expect(em.description).toContain("repo   : cwd");
      expect(em.description).toContain("cwd run: cgroup empty");
      for (const line of codeLines(em)) {
        expect(line.length).toBeLessThanOrEqual(40);
      }
      // record marked killed (stops lying "running")
      const rec = JSON.parse(fs.readFileSync(recFile(f, t), "utf8"));
      expect(rec.state).toBe("killed");
      expect(rec.finished).toBeDefined();
      // cgroup reaped (guarded cgroup.kill + rmdir)
      expect(fs.existsSync(cgDir(f, t))).toBe(false);
      // dead log line (dedupe key for the next sweep)
      const deadlog = path.join(f.home, ".pi-bg-deadlog");
      expect(fs.readFileSync(deadlog, "utf8")).toContain(` ${t} cwd `);
      // second sweep: record no longer running -> not re-flagged, no post
      const r2 = await f.run();
      expect(r2.code).toBe(0);
      expect(f.posts).toHaveLength(1);
      expect(r2.out).not.toContain(`DEAD cwd/${t}`);
    } finally {
      f.close();
    }
  }, 30_000);

  test("controls: fresh hb / live cgroup / done record / no hb -> not flagged; reaped dir -> flagged (#116)", async () => {
    const f = fixture();
    try {
      bless(f);
      const t1 = plant(f, 2, { hbAgeMin: 1 }); // fresh hb -> healthy
      const t2 = plant(f, 3, { hbAgeMin: 15, cg: "live" }); // live member
      const t3 = plant(f, 4, { state: "done", hbAgeMin: 15 }); // completed
      const t4 = plant(f, 5, { hbAgeMin: 15, cg: "missing" }); // reaped dir -> DEAD (#116)
      const t5 = plant(f, 6, { hbAgeMin: 15 }); // control: genuinely DEAD
      const t6 = plant(f, 7, { cg: "missing" }); // reaped dir, no hb -> not judgeable
      const r = await f.run();
      expect(r.code).toBe(0);
      expect(r.out).toContain(`DEAD cwd/${t5}`);
      expect(r.out).toContain(`DEAD cwd/${t4}`); // #116: missing dir is a reap
      for (const t of [t1, t2, t3, t6]) {
        expect(r.out).not.toContain(`DEAD cwd/${t}`);
      }
      expect(f.posts).toHaveLength(2);
      expect(JSON.parse(fs.readFileSync(recFile(f, t1), "utf8")).state).toBe(
        "running",
      );
      expect(JSON.parse(fs.readFileSync(recFile(f, t2), "utf8")).state).toBe(
        "running",
      );
      expect(JSON.parse(fs.readFileSync(recFile(f, t3), "utf8")).state).toBe(
        "done",
      );
      expect(JSON.parse(fs.readFileSync(recFile(f, t4), "utf8")).state).toBe(
        "killed",
      );
      expect(JSON.parse(fs.readFileSync(recFile(f, t5), "utf8")).state).toBe(
        "killed",
      );
      expect(JSON.parse(fs.readFileSync(recFile(f, t6), "utf8")).state).toBe(
        "running",
      );
      // live cgroup dir survives (sweep + reaper both skip members)
      expect(fs.existsSync(cgDir(f, t2))).toBe(true);
    } finally {
      f.close();
    }
  }, 30_000);

  test("--dry-run: no post, record untouched, cgroup kept", async () => {
    const f = fixture();
    try {
      bless(f);
      const t = plant(f, 7, { hbAgeMin: 15, cg: "empty" });
      const r = await f.run(["--dry-run"]);
      expect(r.code).toBe(0);
      expect(r.out).toContain(`dry-run: would flag cwd ticket DEAD ${t}`);
      expect(f.posts).toHaveLength(0);
      expect(JSON.parse(fs.readFileSync(recFile(f, t), "utf8")).state).toBe(
        "running",
      );
      expect(fs.existsSync(cgDir(f, t))).toBe(true);
    } finally {
      f.close();
    }
  }, 30_000);

  test("worktree ticket + running record -> worktree sweep owns it, no double flag", async () => {
    const f = fixture();
    try {
      bless(f);
      const t = plant(f, 8, { hbAgeMin: 15, cg: "empty" });
      // also give it a worktree dir (30 min old, no out.md) so the
      // worktree sweep can see it too: exactly ONE flag, from the
      // worktree path (its dead log write precedes the cwd sweep's read)
      const wt = path.join(f.tmp, "wt", "jarate", t);
      fs.mkdirSync(wt, { recursive: true });
      const old = new Date(Date.now() - 30 * 60 * 1000);
      fs.utimesSync(wt, old, old);
      const r = await f.run();
      expect(r.code).toBe(0);
      expect(r.out).toContain(`DEAD jarate/${t}`);
      expect(r.out).not.toContain(`DEAD cwd/${t}`);
      expect(f.posts).toHaveLength(1);
      // the worktree sweep owns the flag; it does not mark records
      // (existing behavior), so the record stays running until the
      // age prune - the point here is exactly ONE flag, no double post
      expect(JSON.parse(fs.readFileSync(recFile(f, t), "utf8")).state).toBe(
        "running",
      );
    } finally {
      f.close();
    }
  }, 30_000);
});

/**
 * #116: cwd-sweep vs cgroup-reaper race. A SIGKILLed long cwd run leaves an
 * EMPTY cgroup dir while the heartbeat is still fresh (< STALL_MIN). A
 * sweep landing in that window skips the ticket (hb fresh) and its
 * reaper rmdirs the empty aged dir. Pre-fix, the NEXT sweep saw no cgroup
 * dir (`[ -d "$cg" ] || continue`) and never flagged DEAD: the record sat
 * state=running until the 7-day prune, no webhook, no dead log, no wake
 * (~2/3 of qualifying deaths with the 15-min timer). Post-fix the missing
 * dir is a reap, not a fresh-start signal: DEAD still fires.
 */
describe("watchdog #116: cwd-sweep vs cgroup-reaper race", () => {
  const TID = (n: number) => `20991231-235956-${500 + n}`;
  const recFile = (f: { home: string }, t: string) =>
    path.join(f.home, ".pi-dispatch", "runs", `pi-bg-${t}.json`);
  const cgDir = (f: { tmp: string }, t: string) =>
    path.join(f.tmp, "cg", "pi-bg", t);
  const hbFile = (f: { art: string }, t: string) =>
    path.join(f.art, `pi-bg-${t}-hb`);
  const bless = (f: { manifest: () => string; sha: (s: string) => string }) =>
    fs.writeFileSync(
      f.manifest(),
      `${f.sha("# law v1\n")} 2026-09-14T00:00:00Z  reaper-race test\n`,
    );

  /** Plant a cwd ticket: running record + aged empty cgroup + aged hb. */
  const plant = (
    f: { home: string; tmp: string; art: string },
    t: string,
    hbAgeMin: number,
  ) => {
    const recDir = path.join(f.home, ".pi-dispatch", "runs");
    fs.mkdirSync(recDir, { recursive: true });
    fs.writeFileSync(
      path.join(recDir, `pi-bg-${t}.json`),
      JSON.stringify(
        {
          run: t,
          profile: "worker",
          project: null,
          cwd: path.join(f.tmp, "workdir"),
          started: "2026-09-25T10:00:00Z",
          delivery: "webhook",
          state: "running",
        },
        null,
        2,
      ),
    );
    fs.mkdirSync(cgDir(f, t), { recursive: true });
    const old = new Date(Date.now() - 10 * 60 * 1000); // > REAPER_MIN_AGE 300s
    fs.utimesSync(cgDir(f, t), old, old);
    fs.writeFileSync(hbFile(f, t), "");
    const hbOld = new Date(Date.now() - hbAgeMin * 60 * 1000);
    fs.utimesSync(hbFile(f, t), hbOld, hbOld);
  };

  test("reaper eats the dir in the fresh-hb window; next sweep still posts DEAD, kills record", async () => {
    const f = fixture();
    try {
      bless(f);
      const t = TID(1);
      // pass 1: died 1 min ago -> hb fresh (DEAD window closed), cgroup dir
      // empty + aged (reaper window open). This is the race pass.
      plant(f, t, 1);
      const r1 = await f.run();
      expect(r1.code).toBe(0);
      expect(r1.out).not.toContain(`DEAD cwd/${t}`); // hb fresh: not yet
      expect(f.posts).toHaveLength(0);
      expect(fs.existsSync(cgDir(f, t))).toBe(false); // reaper ate the dir
      // pre-#116, the sweep's evidence was gone here and the record sat
      // state=running until the 7-day prune with no alert ever
      expect(JSON.parse(fs.readFileSync(recFile(f, t), "utf8")).state).toBe(
        "running",
      );
      // pass 2: heartbeat crosses the STALL_MIN line -> DEAD fires
      // despite the missing cgroup dir
      const stale = new Date(Date.now() - 15 * 60 * 1000);
      fs.utimesSync(hbFile(f, t), stale, stale);
      const r2 = await f.run();
      expect(r2.code).toBe(0);
      expect(r2.out).toContain(`DEAD cwd/${t}`);
      expect(r2.out).toContain(
        "cgroup reaped (dir gone), heartbeat stale > 10 min (issue #116)",
      );
      expect(r2.out).toContain("1 cwd ticket(s) flagged");
      expect(f.posts).toHaveLength(1);
      const em = f.posts[0].embeds[0];
      expect(em.title).toBe("DEAD \u00b7 watchdog sweep");
      for (const line of codeLines(em)) {
        expect(line.length).toBeLessThanOrEqual(40);
      }
      // record marked killed (stops lying "running")
      const rec = JSON.parse(fs.readFileSync(recFile(f, t), "utf8"));
      expect(rec.state).toBe("killed");
      expect(rec.finished).toBeDefined();
      // dead log line (dedupe key for the next sweep)
      const deadlog = path.join(f.home, ".pi-bg-deadlog");
      expect(fs.readFileSync(deadlog, "utf8")).toContain(` ${t} cwd `);
      // pass 3: deduped, no re-post
      const r3 = await f.run();
      expect(r3.code).toBe(0);
      expect(f.posts).toHaveLength(1);
      expect(r3.out).not.toContain(`DEAD cwd/${t}`);
    } finally {
      f.close();
    }
  }, 30_000);

  test("control: fresh-hb window WITHOUT a reaped dir stays not-DEAD (no over-flag)", async () => {
    const f = fixture();
    try {
      bless(f);
      const t = TID(2);
      // same shape as the race pass 1, but the cgroup dir is YOUNG (<
      // REAPER_MIN_AGE): the reaper's #101 guard skips it, the sweep
      // skips it (fresh hb) -> no flag, dir kept
      plant(f, t, 1);
      fs.rmSync(cgDir(f, t), { recursive: true });
      fs.mkdirSync(cgDir(f, t)); // fresh mtime = now
      const r1 = await f.run();
      expect(r1.code).toBe(0);
      expect(r1.out).not.toContain(`DEAD cwd/${t}`);
      expect(f.posts).toHaveLength(0);
      expect(r1.out).toContain(
        "skipped 1 young cgroup dir(s) (age < 300s, issue #101)",
      );
      // then kill it: stale hb + live member is impossible after death,
      // so just age the dir too -> reaped -> DEAD on the next sweep
      const old = new Date(Date.now() - 10 * 60 * 1000);
      fs.utimesSync(cgDir(f, t), old, old);
      const r1b = await f.run();
      expect(r1b.out).toContain(`reaped empty cgroup ${cgDir(f, t)}`);
      expect(fs.existsSync(cgDir(f, t))).toBe(false);
      const stale = new Date(Date.now() - 15 * 60 * 1000);
      fs.utimesSync(hbFile(f, t), stale, stale);
      const r2 = await f.run();
      expect(r2.out).toContain(`DEAD cwd/${t}`);
      expect(JSON.parse(fs.readFileSync(recFile(f, t), "utf8")).state).toBe(
        "killed",
      );
    } finally {
      f.close();
    }
  }, 30_000);
});

/**
 * #52: STALLED classification (issue #52). A LIVE ticket (cgroup member)
 * whose heartbeat is stale > STALL_MIN min is hung, not dead: distinct
 * red embed (DEAD is orange), one alert per ticket per day (dead log
 * dedupe), no record state change (the run is alive).
 */
describe("watchdog #52: STALLED classification (live process, stale hb)", () => {
  const TID = (n: number) => `20991231-235957-${600 + n}`;

  const bless = (f: { manifest: () => string; sha: (s: string) => string }) =>
    fs.writeFileSync(
      f.manifest(),
      `${f.sha("# law v1\n")} 2026-09-14T00:00:00Z  stalled test\n`,
    );

  test("live cgroup + stale hb -> STALLED embed (red), deduped, no re-post", async () => {
    const f = fixture();
    try {
      bless(f);
      const t = TID(1);
      // worktree dir (fresh mtime is fine: liveness is checked first)
      const wt = path.join(f.tmp, "wt", "jarate", t);
      fs.mkdirSync(wt, { recursive: true });
      // live member in the ticket cgroup (fake root: plain file;
      // CG_DIR = $PI_BG_CG_ROOT/pi-bg, same layout as the reaper tests)
      const cg = path.join(f.tmp, "cg", "pi-bg", t);
      fs.mkdirSync(cg, { recursive: true });
      fs.writeFileSync(path.join(cg, "cgroup.procs"), `${process.pid}\n`);
      // stale heartbeat (15 min > STALL_MIN 10)
      const hb = path.join(f.art, `pi-bg-${t}-hb`);
      fs.writeFileSync(hb, "");
      const old = new Date(Date.now() - 15 * 60 * 1000);
      fs.utimesSync(hb, old, old);

      const r = await f.run();
      expect(r.code).toBe(0);
      expect(r.out).toContain(`STALLED jarate/${t}`);
      expect(r.out).toContain("> 10 min stale");
      expect(f.posts).toHaveLength(1);
      const em = f.posts[0].embeds[0];
      // distinct from DEAD: red (alive but stuck), count title
      expect(em.title).toBe("1 stalled \u00b7 watchdog sweep");
      expect(em.color).toBe(15158332);
      expect(em.author.name).toBe("pi-bg watchdog");
      // list row: ticket (head-clipped to ~30) + minuted hb ts + state
      expect(em.description).toContain(t);
      expect(em.description).toContain("  hb last ");
      expect(em.description).toContain("process alive; hb stale >10m");
      expect(em.description).toContain("jarate-bg-kill");
      for (const line of codeLines(em)) {
        expect(line.length).toBeLessThanOrEqual(40);
      }
      expect(em.description.endsWith("\n```")).toBe(true);
      // the live cgroup survives (this is not a DEAD reap)
      expect(fs.existsSync(cg)).toBe(true);
      // dead log line carries the stalled reason (dedupe key)
      const deadlog = path.join(f.home, ".pi-bg-deadlog");
      expect(fs.readFileSync(deadlog, "utf8")).toContain(
        "stalled: live process",
      );
      // second sweep: deduped, no re-post
      const r2 = await f.run();
      expect(r2.code).toBe(0);
      expect(f.posts).toHaveLength(1);
      expect(r2.out).not.toContain(`STALLED jarate/${t}`);
    } finally {
      f.close();
    }
  }, 30_000);

  test("controls: fresh hb / no hb -> not stalled", async () => {
    const f = fixture();
    try {
      bless(f);
      for (const n of [2, 3]) {
        const t = TID(n);
        const wt = path.join(f.tmp, "wt", "jarate", t);
        fs.mkdirSync(wt, { recursive: true });
        const cg = path.join(f.tmp, "cg", "pi-bg", t);
        fs.mkdirSync(cg, { recursive: true });
        fs.writeFileSync(path.join(cg, "cgroup.procs"), `${process.pid}\n`);
      }
      // t2: fresh heartbeat -> healthy
      const hb2 = path.join(f.art, `pi-bg-${TID(2)}-hb`);
      fs.writeFileSync(hb2, "");
      // t3: no heartbeat file at all -> pre-upgrade run, not judgeable
      const r = await f.run();
      expect(r.code).toBe(0);
      expect(r.out).not.toContain("STALLED jarate/");
      expect(f.posts).toHaveLength(0);
    } finally {
      f.close();
    }
  }, 30_000);
});

// ───────────────────────────────────────────────────────────────────────────
// #142: HUNG detection (alive tree, quiet session)
//
// The exit-only webhook makes a hung pi invisible: the hb child keeps
// touching while the wrapper lives, so DEAD (needs the process gone) and
// STALLED (needs the hb stale) both miss a session wedged in a bash tool
// call (incident 20261004-140606-286112: 5h51m, fresh hb, tree alive).
// HUNG = alive + profile session jsonl unwritten > PI_BG_HUNG_MIN (30).
// One HUNG per run (record flag, written only after a successful post),
// never kills (a later DIED must still fire).
describe("#142: HUNG detection (alive tree, quiet session)", () => {
  const HT = (n: number) => `2026010${n}-030405-999`;

  const bless = (f: { manifest: () => string; sha: (s: string) => string }) =>
    fs.writeFileSync(
      f.manifest(),
      `${f.sha("# law v1\n")} 2026-09-14T00:00:00Z  #142 hung test\n`,
    );

  // plant a cwd-run ticket: run record (started 2h ago, state=running),
  // ticket cgroup, profile session jsonl, heartbeat file
  const plant = (
    f: ReturnType<typeof fixture>,
    t: string,
    o: { jsonlAgeMin: number; hbAgeMin: number; livePid?: string | null },
  ): void => {
    const recDir = path.join(f.home, ".pi-dispatch", "runs");
    fs.mkdirSync(recDir, { recursive: true });
    fs.writeFileSync(
      path.join(recDir, `pi-bg-${t}.json`),
      JSON.stringify({
        run: t,
        profile: "worker",
        project: null,
        cwd: f.tmp, // cwd run: pi launched in the launcher cwd
        started: new Date(Date.now() - 2 * 60 * 60 * 1000)
          .toISOString()
          .replace(".000Z", "Z"),
        delivery: "webhook",
        state: "running",
      }),
    );
    const cg = path.join(f.tmp, "cg", "pi-bg", t);
    fs.mkdirSync(cg, { recursive: true });
    fs.writeFileSync(
      path.join(cg, "cgroup.procs"),
      o.livePid ? `${o.livePid}\n` : "",
    );
    // age the cgroup dir past the reaper's young guard (5m)
    const old = new Date(Date.now() - 30 * 60 * 1000);
    fs.utimesSync(cg, old, old);
    // profile session jsonl for the run's pi cwd (same slug as jarate-bg)
    const slug = `--${f.tmp.slice(1).replace(/\//g, "-")}--`;
    const sd = path.join(f.home, ".pi", "agent-worker", "sessions", slug);
    fs.mkdirSync(sd, { recursive: true });
    const jf = path.join(sd, "sess.jsonl");
    fs.writeFileSync(jf, "{}\n");
    const jm = new Date(Date.now() - o.jsonlAgeMin * 60 * 1000);
    fs.utimesSync(jf, jm, jm);
    // heartbeat file
    const hb = path.join(f.art, `pi-bg-${t}-hb`);
    fs.writeFileSync(hb, "");
    const hm = new Date(Date.now() - o.hbAgeMin * 60 * 1000);
    fs.utimesSync(hb, hm, hm);
  };

  const rec = (f: ReturnType<typeof fixture>, t: string) =>
    JSON.parse(
      fs.readFileSync(
        path.join(f.home, ".pi-dispatch", "runs", `pi-bg-${t}.json`),
        "utf8",
      ),
    ) as Record<string, unknown>;

  test("live process + 35m-quiet jsonl + fresh hb -> HUNG post, flag, no kill", async () => {
    const f = fixture();
    let sleep: ReturnType<typeof Bun.spawn> | null = null;
    try {
      bless(f);
      const t = HT(1);
      sleep = Bun.spawn(["sleep", "300"], {
        cwd: f.tmp,
        stdout: "ignore",
        stderr: "ignore",
      });
      plant(f, t, { jsonlAgeMin: 35, hbAgeMin: 0, livePid: String(sleep.pid) });
      const r = await f.run();
      expect(r.code).toBe(0);
      expect(r.out).toContain(`HUNG cwd/${t}`);
      expect(f.posts).toHaveLength(1);
      const e = f.posts[0].embeds[0];
      // title carries HUNG + run id; red = alive but stuck (as STALLED)
      expect(e.title).toBe(`HUNG · ${t}`);
      expect(e.color).toBe(15158332);
      expect(e.author.name).toBe(`pi-bg ticket · ${t}`);
      // evidence: run id, the sleep child (hang candidate), silence age
      expect(e.description).toContain(t);
      expect(e.description).toContain("sleep");
      expect(e.description).toContain("no session write");
      for (const line of e.description.split("\n")) {
        if (line.startsWith("```")) continue;
        expect(
          Array.from(line).length,
          `frame line too wide: ${line}`,
        ).toBeLessThanOrEqual(40);
      }
      // once-flag set in the run record; state untouched (no kill)
      expect(rec(f, t).hungNotified).toBe(true);
      expect(rec(f, t).state).toBe("running");
    } finally {
      if (sleep) sleep.kill("SIGKILL");
      f.close();
    }
  }, 30_000);

  test("fresh jsonl (1m) + live process -> not HUNG, no flag", async () => {
    const f = fixture();
    let sleep: ReturnType<typeof Bun.spawn> | null = null;
    try {
      bless(f);
      const t = HT(2);
      sleep = Bun.spawn(["sleep", "300"], {
        cwd: f.tmp,
        stdout: "ignore",
        stderr: "ignore",
      });
      plant(f, t, { jsonlAgeMin: 1, hbAgeMin: 0, livePid: String(sleep.pid) });
      const r = await f.run();
      expect(r.code).toBe(0);
      expect(r.out).not.toContain("HUNG cwd/");
      expect(f.posts).toHaveLength(0);
      expect(rec(f, t).hungNotified).toBeUndefined();
    } finally {
      if (sleep) sleep.kill("SIGKILL");
      f.close();
    }
  }, 30_000);

  test("dead process + quiet jsonl -> DIED path owns it, no HUNG", async () => {
    const f = fixture();
    try {
      bless(f);
      const t = HT(3);
      plant(f, t, { jsonlAgeMin: 35, hbAgeMin: 15, livePid: null });
      const r = await f.run();
      expect(r.code).toBe(0);
      // the dead cwd ticket is a DIED (cwd sweep), not a HUNG
      expect(r.out).toContain(`DEAD cwd/${t}`);
      expect(r.out).not.toContain("HUNG cwd/");
      expect(f.posts).toHaveLength(1);
      expect(f.posts[0].embeds[0].title).toBe("DEAD · watchdog sweep");
      // record marked killed by the cwd sweep; no hungNotified
      expect(rec(f, t).state).toBe("killed");
      expect(rec(f, t).hungNotified).toBeUndefined();
    } finally {
      f.close();
    }
  }, 30_000);

  test("no repost: second sweep sees the hungNotified flag", async () => {
    const f = fixture();
    let sleep: ReturnType<typeof Bun.spawn> | null = null;
    try {
      bless(f);
      const t = HT(4);
      sleep = Bun.spawn(["sleep", "300"], {
        cwd: f.tmp,
        stdout: "ignore",
        stderr: "ignore",
      });
      plant(f, t, { jsonlAgeMin: 35, hbAgeMin: 0, livePid: String(sleep.pid) });
      const r1 = await f.run();
      expect(r1.code).toBe(0);
      expect(r1.out).toContain(`HUNG cwd/${t}`);
      expect(f.posts).toHaveLength(1);
      // sweep again: same conditions, flag set -> detected, not reposted
      const r2 = await f.run();
      expect(r2.code).toBe(0);
      expect(r2.out).not.toContain(`HUNG cwd/${t}`);
      expect(f.posts).toHaveLength(1);
    } finally {
      if (sleep) sleep.kill("SIGKILL");
      f.close();
    }
  }, 30_000);
});

// ─────────────────────────────────────────────────────────────────────────
// #110: DEAD-class auto retry (watchdog state machine)
//
// A FIRST death (DEAD class: run record + stored task prompt, no retryOf,
// no deadRetry marker) is re-dispatched ONCE through the normal jarate-bg
// launcher: PI_BG_RUN_ID + PI_BG_RETRY_OF + --wt-reuse <same worktree>,
// so partial work survives. The retry's own death (its record has
// retryOf) = SECOND death = embed + human wake only, no third attempt.
// HUNG/STALLED are never auto-retried. All markers live in the run
// records, so a watchdog restart or a double sweep is idempotent.
describe("#110: DEAD-class auto retry (watchdog state machine)", () => {
  const RT = (n: number) => `2099121${n}-040506-110`;
  type F = ReturnType<typeof fixture>;

  // retry fixture: base fixture + fake pi (slow-mode flag), webdrop stub,
  // main-agent creds (profile-doctor seed), launcher env for the sweep
  const retryFixture = (): F => {
    const f = fixture();
    const bin = path.join(f.tmp, "fbin");
    fs.mkdirSync(bin);
    // per-RUN slow flag: $tmp/slow-<runid> (the wrapper exports
    // PI_BG_RUN_ID into pi's env). The retry's pi must not inherit the
    // original ticket's slowness.
    const slowBase = path.join(f.tmp, "slow");
    fs.writeFileSync(
      path.join(bin, "pi"),
      "#!/bin/sh\n" +
        `[ -n "${"$"}{PI_BG_RUN_ID:-}" ] && ` +
        `{ [ -f "${slowBase}-${"$"}{PI_BG_RUN_ID}" ] || ` +
        `[ -f "${slowBase}-ALL" ]; } && sleep 300\n` +
        "echo pi-run-ok\n",
    );
    fs.chmodSync(path.join(bin, "pi"), 0o755);
    fs.writeFileSync(
      path.join(bin, "webdrop"),
      '#!/bin/sh\necho https://drop.test/$(basename "$1")\n',
    );
    fs.chmodSync(path.join(bin, "webdrop"), 0o755);
    const mainAgent = path.join(f.home, ".pi", "agent");
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
      JSON.stringify({ defaultProvider: "vllm", defaultModel: "qwen-test" }),
    );
    const env = f.env;
    env.PATH = `${bin}:${env.PATH ?? ""}`;
    env.PI_BG_LAUNCHER = JB; // re-dispatch through the in-repo launcher
    env.PI_BG_RETRY_WAIT = "10";
    env.PI_BG_MAX_CONCURRENT = "0"; // cap off unless a test sets it
    env.PI_BG_ALLOW_FOREGROUND = "1";
    for (const k of [
      "PI_BG_SETSID",
      "PI_BG_SNAP",
      "PI_BG_RUN_ID",
      "PI_BG_TASK_FILE",
      "SNAP_DIR",
      "PI_BG_LANCHED_CWD",
      "PI_BG_HB_INTERVAL",
      "PI_BG_CMD_TIMEOUT",
      "PI_BG_PRUNE_AGE_H",
      "PI_BG_KEEP_SESSION",
      "PI_BG_PRUNE_SESSIONS",
      "PI_BG_RUN_START_EPOCH",
    ]) {
      delete env[k];
    }
    return f;
  };

  const shq = (s: string) => JSON.stringify(s);
  const recDirOf = (f: F) => path.join(f.home, ".pi-dispatch", "runs");
  const recFileOf = (f: F, t: string) =>
    path.join(recDirOf(f), `pi-bg-${t}.json`);
  const rec = (f: F, t: string) =>
    JSON.parse(fs.readFileSync(recFileOf(f, t), "utf8")) as Record<
      string,
      unknown
    >;
  const recIds = (f: F) =>
    fs.existsSync(recDirOf(f))
      ? fs
          .readdirSync(recDirOf(f))
          .filter((n) => /^pi-bg-\d{8}-\d{6}-\d+\.json$/.test(n))
          .map((n) => n.slice(6, -5))
      : [];
  const cgFile = (f: F, t: string) =>
    path.join(f.tmp, "cg", "pi-bg", t, "cgroup.procs");
  const cgLive = (f: F, t: string) => {
    try {
      return fs.readFileSync(cgFile(f, t), "utf8").trim().length > 0;
    } catch {
      return false;
    }
  };
  // SIGKILL the ticket's whole process group (untrapable -> DEAD class);
  // the fake cgroup.procs file is what the kernel drops on death
  const killTicket = (f: F, t: string) => {
    const p = cgFile(f, t);
    if (!fs.existsSync(p)) return;
    for (const line of fs.readFileSync(p, "utf8").split("\n")) {
      const pid = parseInt(line, 10);
      if (!pid) continue;
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        /* gone */
      }
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* gone */
      }
    }
    fs.writeFileSync(p, "");
  };
  const age = (p: string, min: number) => {
    const d = new Date(Date.now() - min * 60 * 1000);
    fs.utimesSync(p, d, d);
  };
  const waitFor = async (fn: () => boolean, ms: number) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (fn()) return true;
      await new Promise((r) => setTimeout(r, 250));
    }
    return fn();
  };
  const mkRepo = (f: F, name: string) => {
    const d = path.join(f.tmp, name);
    fs.mkdirSync(d);
    const sh = (cmd: string) =>
      execSync(cmd, { cwd: d, env: f.env, stdio: "pipe" });
    sh("git init -q -b main");
    sh("git config user.email t@t");
    sh("git config user.name t");
    fs.writeFileSync(path.join(d, "a.txt"), "a\n");
    sh("git add a.txt");
    sh("git commit -q -m init");
    return d;
  };
  // detached launcher run (the nohup form) + wait for the wrapper to be
  // fully up (cgroup escape + pid file)
  const launchBg = async (
    f: F,
    cwd: string,
    args: string[],
    task: string,
    t: string,
  ): Promise<string> => {
    const log = path.join(
      f.tmp,
      `launch-${Date.now()}-${Math.floor(Math.random() * 1e6)}.log`,
    );
    // non-blocking: bun's execSync waits for the WHOLE process group
    // (the wrapper + its pi) before returning. spawn + the waitFor
    // (cgLive) poll below is the readiness gate.
    const child = spawn(
      [
        "sh",
        "-c",
        `cd ${shq(cwd)} && printf '%s' ${shq(task)} | nohup bash ${shq(JB)} ${args.map(shq).join(" ")} - > ${shq(log)} 2>&1`,
      ],
      {
        env: { ...f.env, PI_BG_RUN_ID: t },
        stdio: ["ignore", "ignore", "ignore"],
      },
    );
    child.unref();
    const up = await waitFor(() => cgLive(f, t), 30_000);
    if (!up) {
      throw new Error(
        `ticket ${t} did not start:\n${fs.existsSync(log) ? fs.readFileSync(log, "utf8") : "(no log)"}`,
      );
    }
    return t;
  };
  const bless = (f: F) =>
    fs.writeFileSync(
      f.manifest(),
      `${f.sha("# law v1\n")} 2026-10-06T00:00:00Z  #110 retry test\n`,
    );
  const postByTicket = (f: F, t: string) =>
    f.posts.find(
      (p) => p.embeds[0]?.author?.name === `pi-bg ticket \u00b7 ${t}`,
    )?.embeds[0];
  const postOrThrow = (f: F, t: string) => {
    const p = postByTicket(f, t);
    if (!p) throw new Error(`no post for ${t}`);
    return p;
  };
  // plant a worktree run record (the launcher shape incl. the wt field)
  const plantRec = (f: F, t: string, wt: string) => {
    const d = recDirOf(f);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(
      path.join(d, `pi-bg-${t}.json`),
      JSON.stringify(
        {
          run: t,
          profile: "worker",
          project: null,
          cwd: f.tmp,
          started: new Date(Date.now() - 3600_000)
            .toISOString()
            .replace(".000Z", "Z"),
          delivery: "webhook",
          state: "running",
          wt,
        },
        null,
        2,
      ),
    );
  };

  test("SIGKILL mid-run -> re-dispatched ONCE into the SAME worktree (retryOf), retry callback fires", async () => {
    const f = retryFixture();
    bless(f);
    const t1 = RT(1);
    let t2 = "";
    try {
      const repo = mkRepo(f, "repo");
      fs.writeFileSync(path.join(f.tmp, `slow-${t1}`), "");
      await launchBg(
        f,
        repo,
        ["worker", "--worktree"],
        "issue-110 kill me",
        t1,
      );
      killTicket(f, t1);
      age(path.join(f.wtDir, "repo", t1), 30); // wt mtime > AGE_MIN (20)
      age(path.join(f.art, `pi-bg-${t1}-hb`), 15); // hb > STALL_MIN (10)
      const r = await f.run();
      expect(r.code).toBe(0);
      expect(r.out).toContain(`retry ${t1}: DISPATCHED`);
      const rec1 = rec(f, t1);
      expect(rec1.state).toBe("killed");
      expect((rec1.deadRetry as { state: string }).state).toBe("dispatched");
      t2 = (rec1.deadRetry as { ticket: string }).ticket;
      expect(t2).toMatch(/^\d{8}-\d{6}-\d+$/);
      expect(t2).not.toBe(t1);
      expect(rec(f, t2).retryOf).toBe(t1);
      // SAME worktree: the retry launched in the original dir; no 2nd dir
      expect(rec(f, t2).cwd).toBe(
        fs.realpathSync(path.join(f.wtDir, "repo", t1)),
      );
      expect(fs.existsSync(path.join(f.wtDir, "repo", t2))).toBe(false);
      // the retry re-runs the SAME stored prompt; fast pi -> OK callback
      const got = await waitFor(() => !!postByTicket(f, t2), 30_000);
      expect(got).toBe(true);
      expect(postOrThrow(f, t2).title).toContain("OK");
      // the original's DEAD embed shows the retry action at the reason head
      const dead = postOrThrow(f, t1);
      expect(dead.title).toBe("DEAD \u00b7 watchdog sweep");
      expect(dead.description).toContain("retry dispatched (issue #110");
      expect(recIds(f).sort()).toEqual([t1, t2].sort());
    } finally {
      killTicket(f, t2);
      f.close();
    }
  }, 90_000);

  test("kill the retry too -> second-death embed, human wake only, no third dispatch", async () => {
    const f = retryFixture();
    bless(f);
    const t1 = RT(2);
    let t2 = "";
    try {
      const repo = mkRepo(f, "repo");
      fs.writeFileSync(path.join(f.tmp, `slow-${t1}`), "");
      fs.writeFileSync(path.join(f.tmp, "slow-ALL"), ""); // retry (unknown id yet) slow too
      await launchBg(
        f,
        repo,
        ["worker", "--worktree"],
        "kill me and my retry",
        t1,
      );
      killTicket(f, t1);
      age(path.join(f.wtDir, "repo", t1), 30);
      age(path.join(f.art, `pi-bg-${t1}-hb`), 15);
      const r1 = await f.run();
      expect(r1.out).toContain(`retry ${t1}: DISPATCHED`);
      t2 = (rec(f, t1).deadRetry as { ticket: string }).ticket;
      const up = await waitFor(() => cgLive(f, t2), 30_000);
      expect(up).toBe(true);
      killTicket(f, t2);
      age(path.join(f.art, `pi-bg-${t2}-hb`), 15);
      const r2 = await f.run();
      expect(r2.code).toBe(0);
      expect(r2.out).toContain(`DEAD cwd/${t2}`);
      expect(r2.out).toContain("second death in chain (issue #110)");
      expect(r2.out).not.toContain("DISPATCHED");
      const rec2 = rec(f, t2);
      expect(rec2.state).toBe("killed");
      expect(rec2.deadRetry).toBeUndefined();
      expect(recIds(f).sort()).toEqual([t1, t2].sort());
      const em2 = postOrThrow(f, t2);
      expect(em2.title).toBe("DEAD \u00b7 watchdog sweep");
      expect(em2.description).toContain("second death in chain (issue");
      // third sweep: quiet (dead-log dedupe + terminal states)
      const n = f.posts.length;
      const r3 = await f.run();
      expect(r3.code).toBe(0);
      expect(f.posts).toHaveLength(n);
    } finally {
      killTicket(f, t2);
      f.close();
    }
  }, 120_000);

  test("first death at full cap -> HELD; slot frees -> fires on a later sweep", async () => {
    const f = retryFixture();
    bless(f);
    f.env.PI_BG_MAX_CONCURRENT = "4";
    const t = RT(3);
    const wtDir = path.join(f.wtDir, "repo", t);
    const repo = mkRepo(f, "repo");
    execSync(`git worktree add -q -b pi-bg/${t} ${shq(wtDir)}`, {
      cwd: repo,
      env: f.env,
      stdio: "pipe",
    });
    age(wtDir, 30);
    plantRec(f, t, wtDir);
    fs.writeFileSync(
      path.join(f.art, `pi-bg-${t}-prompt.md`),
      "# pi-bg worker task\n\nissue-110 held task\n",
    );
    fs.writeFileSync(path.join(f.art, `pi-bg-${t}-hb`), "");
    age(path.join(f.art, `pi-bg-${t}-hb`), 15);
    // four other live tickets (fresh hb) fill the cap
    for (let i = 1; i <= 4; i++) {
      fs.writeFileSync(path.join(f.art, `pi-bg-2099121${i}-000000-777-hb`), "");
    }
    try {
      const r1 = await f.run();
      expect(r1.code).toBe(0);
      expect(r1.out).toContain(`retry ${t}: HELD (at cap 4/4)`);
      expect((rec(f, t).deadRetry as { state: string }).state).toBe("held");
      expect(recIds(f)).toEqual([t]); // nothing launched
      expect(f.posts).toHaveLength(1);
      expect(postOrThrow(f, t).description).toContain("retry held: at cap");
      // no change: still held, no re-post (dead-log dedupe at the site,
      // cap recheck in the retry section)
      const r2 = await f.run();
      expect(r2.out).toContain(`retry ${t}: HELD (at cap 4/4)`);
      expect(recIds(f)).toEqual([t]);
      expect(f.posts).toHaveLength(1);
      // a slot frees: the later sweep fires it
      fs.rmSync(path.join(f.art, "pi-bg-20991211-000000-777-hb"));
      const r3 = await f.run();
      expect(r3.out).toContain(`retry ${t}: DISPATCHED`);
      const rec3 = rec(f, t);
      expect(rec3.state).toBe("killed");
      expect((rec3.deadRetry as { state: string }).state).toBe("dispatched");
      const t2 = (rec3.deadRetry as { ticket: string }).ticket;
      expect(rec(f, t2).retryOf).toBe(t);
      expect(recIds(f).sort()).toEqual([t, t2].sort());
      killTicket(f, t2);
    } finally {
      f.close();
    }
  }, 90_000);

  test("pre-#101 record (no stored prompt) -> plain DEAD embed only, no retry", async () => {
    const f = retryFixture();
    bless(f);
    const t = RT(4);
    const wtDir = path.join(f.wtDir, "repo", t);
    mkRepo(f, "repo");
    fs.mkdirSync(wtDir, { recursive: true });
    age(wtDir, 30);
    plantRec(f, t, wtDir);
    // NO pi-bg-<t>-prompt.md: the pre-#101 record shape
    fs.writeFileSync(path.join(f.art, `pi-bg-${t}-hb`), "");
    age(path.join(f.art, `pi-bg-${t}-hb`), 15);
    try {
      const r = await f.run();
      expect(r.code).toBe(0);
      expect(r.out).toContain(`DEAD repo/${t}`);
      expect(r.out).not.toContain(`retry ${t}:`);
      const rec4 = rec(f, t);
      expect(rec4.deadRetry).toBeUndefined();
      expect(rec4.state).toBe("running"); // the dir sweep does not mutate
      expect(recIds(f)).toEqual([t]);
      expect(f.posts).toHaveLength(1);
      expect(postOrThrow(f, t).description).not.toContain("retry");
    } finally {
      f.close();
    }
  }, 60_000);

  test("STALLED (live, stale hb) is never auto-retried, even with a stored prompt", async () => {
    const f = retryFixture();
    bless(f);
    const t = RT(5);
    const wtDir = path.join(f.wtDir, "jarate", t);
    fs.mkdirSync(wtDir, { recursive: true });
    plantRec(f, t, wtDir);
    fs.writeFileSync(
      path.join(f.art, `pi-bg-${t}-prompt.md`),
      "# pi-bg worker task\n\nstalled task\n",
    );
    const cg = path.join(f.tmp, "cg", "pi-bg", t);
    fs.mkdirSync(cg, { recursive: true });
    fs.writeFileSync(path.join(cg, "cgroup.procs"), `${process.pid}\n`);
    fs.writeFileSync(path.join(f.art, `pi-bg-${t}-hb`), "");
    age(path.join(f.art, `pi-bg-${t}-hb`), 15);
    try {
      const r = await f.run();
      expect(r.code).toBe(0);
      expect(r.out).toContain(`STALLED jarate/${t}`);
      expect(r.out).not.toContain(`retry ${t}:`);
      expect(rec(f, t).deadRetry).toBeUndefined();
      expect(rec(f, t).state).toBe("running");
      expect(recIds(f)).toEqual([t]);
      expect(f.posts).toHaveLength(1);
      expect(f.posts[0].embeds[0].title).toBe(
        "1 stalled \u00b7 watchdog sweep",
      );
    } finally {
      f.close();
    }
  }, 60_000);

  test("HUNG (alive, quiet session) is never auto-retried, even with a stored prompt", async () => {
    let sleep: ReturnType<typeof Bun.spawn> | null = null;
    const f = retryFixture();
    bless(f);
    const t = RT(6);
    sleep = Bun.spawn(["sleep", "300"], {
      cwd: f.tmp,
      stdout: "ignore",
      stderr: "ignore",
    });
    const d = recDirOf(f);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(
      path.join(d, `pi-bg-${t}.json`),
      JSON.stringify(
        {
          run: t,
          profile: "worker",
          project: null,
          cwd: f.tmp,
          started: new Date(Date.now() - 7200_000)
            .toISOString()
            .replace(".000Z", "Z"),
          delivery: "webhook",
          state: "running",
        },
        null,
        2,
      ),
    );
    fs.writeFileSync(
      path.join(f.art, `pi-bg-${t}-prompt.md`),
      "# pi-bg worker task\n\nhung task\n",
    );
    const cg = path.join(f.tmp, "cg", "pi-bg", t);
    fs.mkdirSync(cg, { recursive: true });
    fs.writeFileSync(path.join(cg, "cgroup.procs"), `${sleep.pid}\n`);
    const slug = `--${f.tmp.slice(1).replace(/\//g, "-")}--`;
    const sd = path.join(f.home, ".pi", "agent-worker", "sessions", slug);
    fs.mkdirSync(sd, { recursive: true });
    const jf = path.join(sd, "sess.jsonl");
    fs.writeFileSync(jf, "{}\n");
    age(jf, 35); // > HUNG_MIN (30)
    fs.writeFileSync(path.join(f.art, `pi-bg-${t}-hb`), ""); // fresh
    try {
      const r = await f.run();
      expect(r.code).toBe(0);
      expect(r.out).toContain(`HUNG cwd/${t}`);
      expect(r.out).not.toContain(`retry ${t}:`);
      expect(rec(f, t).hungNotified).toBe(true);
      expect(rec(f, t).deadRetry).toBeUndefined();
      expect(rec(f, t).state).toBe("running");
      expect(recIds(f)).toEqual([t]);
      expect(f.posts).toHaveLength(1);
      expect(f.posts[0].embeds[0].title).toBe(`HUNG \u00b7 ${t}`);
    } finally {
      if (sleep) sleep.kill("SIGKILL");
      f.close();
    }
  }, 60_000);

  test("idempotency: double sweep + crash window (marker without close) never double-dispatch", async () => {
    const f = retryFixture();
    bless(f);
    const t1 = RT(7);
    let t2 = "";
    try {
      const repo = mkRepo(f, "repo");
      fs.writeFileSync(path.join(f.tmp, `slow-${t1}`), "");
      fs.writeFileSync(path.join(f.tmp, "slow-ALL"), ""); // retry stays alive
      await launchBg(
        f,
        repo,
        ["worker", "--worktree"],
        "issue-110 idempotency",
        t1,
      );
      killTicket(f, t1);
      age(path.join(f.wtDir, "repo", t1), 30);
      age(path.join(f.art, `pi-bg-${t1}-hb`), 15);
      const r1 = await f.run();
      expect(r1.out).toContain(`retry ${t1}: DISPATCHED`);
      t2 = (rec(f, t1).deadRetry as { ticket: string }).ticket;
      const up = await waitFor(() => cgLive(f, t2), 30_000);
      expect(up).toBe(true);
      // double sweep with the retry still running: no second dispatch
      const r2 = await f.run();
      expect(r2.out).not.toContain("DISPATCHED");
      expect(r2.out).not.toContain("HELD (at cap");
      expect(rec(f, t1).state).toBe("killed");
      expect(recIds(f).sort()).toEqual([t1, t2].sort());
      // crash window: the watchdog died after marking dispatched but
      // before closing the original -> state back to "running"
      const r1j = rec(f, t1);
      r1j.state = "running";
      fs.writeFileSync(recFileOf(f, t1), JSON.stringify(r1j, null, 2));
      const r3 = await f.run();
      expect(r3.out).toContain(`retry ${t1}: chain confirmed (${t2})`);
      expect(rec(f, t1).state).toBe("killed");
      expect(recIds(f).sort()).toEqual([t1, t2].sort()); // no third ticket
    } finally {
      killTicket(f, t2);
      f.close();
    }
  }, 120_000);
});
