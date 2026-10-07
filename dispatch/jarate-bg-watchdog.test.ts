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
  content?: string;
  embeds: Array<{
    title: string;
    description: string;
    color?: number;
    author?: { name: string };
    footer?: { text: string };
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
  // keep the OOM signature section (issue #191 M1) off the real cgroup fs:
  // the fake root has no slices by default -> the section is a no-op
  env.PI_BG_OOM_ROOT = path.join(tmp, "oom");
  // pin the baseline/run-record location to the fake HOME (clean-env
  // lesson: the OOM tests must not inherit an ambient
  // $PI_DISPATCH_RECORD_DIR from the harness box)
  env.PI_DISPATCH_RECORD_DIR = path.join(home, ".pi-dispatch", "runs");
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
      // the worktree sweep owns the flag; since #51 it also marks the
      // record killed (sticky terminal: no cross-day re-flag), so the
      // cwd sweep's running-only filter skips it - exactly ONE flag
      expect(JSON.parse(fs.readFileSync(recFile(f, t), "utf8")).state).toBe(
        "killed",
      );
    } finally {
      f.close();
    }
  }, 30_000);
});

/**
 * #51 sticky terminal lifecycle (the zombie one-shot fix). The per-day
 * deadlog dedupe only suppresses SAME-day re-flags; pre-#51 a SIGKILLed
 * worktree run left its record state=running, so the NEXT day's sweep
 * re-flagged the same death with a second terminal embed (the "zombie
 * one-shot": the orchestrator's queue kept a ticket that was already
 * dead). Now the worktree sweep marks the record killed at flag time
 * (same audit path as the cwd sweep) - a ticket whose record reached a
 * terminal state is never flagged again. HELD records (the #110 retry
 * machinery) stay running on purpose so the retry section re-decides
 * them daily; manual kills end state=cancelled (jarate-bg-kill, the
 * CANCELLED class) and are never DEAD.
 */
describe("watchdog #51: sticky terminal lifecycle", () => {
  const TID = (n: number) => `20991231-235958-${700 + n}`;
  const recFile = (f: { home: string }, t: string) =>
    path.join(f.home, ".pi-dispatch", "runs", `pi-bg-${t}.json`);
  const deadlog = (f: { home: string }) => path.join(f.home, ".pi-bg-deadlog");
  const wtDir = (f: { wtDir: string }, t: string) =>
    path.join(f.wtDir, "jarate", t);
  const age = (d: string, min: number) =>
    fs.utimesSync(
      d,
      new Date(Date.now() - min * 60 * 1000),
      new Date(Date.now() - min * 60 * 1000),
    );
  const bless = (f: { manifest: () => string; sha: (s: string) => string }) =>
    fs.writeFileSync(
      f.manifest(),
      `${f.sha("# law v1\n")} 2026-09-14T00:00:00Z  sticky terminal test\n`,
    );
  const plantRunning = (f: { home: string; tmp: string }, t: string) => {
    const d = path.join(f.home, ".pi-dispatch", "runs");
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(
      recFile(f, t),
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
  };
  const backdateDeadlog = (f: { home: string }, t: string) => {
    const today = new Date().toISOString().slice(0, 10);
    const yesterday = new Date(Date.now() - 86_400_000)
      .toISOString()
      .slice(0, 10);
    const p = deadlog(f);
    const lines = fs
      .readFileSync(p, "utf8")
      .split("\n")
      .map((l) =>
        l.startsWith(`${today} ${t} `) ? l.replace(today, yesterday) : l,
      );
    fs.writeFileSync(p, `${lines.join("\n").trimEnd()}\n`);
  };

  test("cross-day: a flagged worktree death is never re-flagged", async () => {
    const f = fixture();
    try {
      bless(f);
      const t = TID(1);
      fs.mkdirSync(wtDir(f, t), { recursive: true });
      age(wtDir(f, t), 30);
      plantRunning(f, t);
      // no hb file: pre-upgrade-style ticket, DEAD on the first sweep
      const r1 = await f.run();
      expect(r1.code).toBe(0);
      expect(r1.out).toContain(`DEAD jarate/${t}`);
      expect(f.posts).toHaveLength(1);
      // the sticky mark closed the record at flag time
      expect(JSON.parse(fs.readFileSync(recFile(f, t), "utf8")).state).toBe(
        "killed",
      );

      // the per-day deadlog dedupe EXPIRES: simulate the next day
      backdateDeadlog(f, t);
      const r2 = await f.run();
      expect(r2.code).toBe(0);
      expect(r2.out).not.toContain(`DEAD jarate/${t}`);
      expect(f.posts).toHaveLength(1); // no second terminal embed
      expect(JSON.parse(fs.readFileSync(recFile(f, t), "utf8")).state).toBe(
        "killed",
      );
    } finally {
      f.close();
    }
  }, 30_000);

  test("cross-day after record prune: the worktree dir cannot outlive the record", async () => {
    const f = fixture();
    try {
      bless(f);
      const t = TID(5);
      // SIGKILLed worktree ticket: no kill marker (the worktree
      // auto-prune's gate), record closed state=killed by the flag
      // sweep, record + dir now 8 days old (> PRUNE_DAYS default 7):
      // the run-state prune claims the record this sweep. Pre-fix the
      // dir survived the record and the sweep re-flagged DEAD every
      // UTC day after (fresh terminal embed; review #183 F3).
      const wt = wtDir(f, t);
      fs.mkdirSync(wt, { recursive: true });
      const old = new Date(Date.now() - 8 * 86_400_000);
      fs.utimesSync(wt, old, old);
      plantRunning(f, t);
      const rec = recFile(f, t);
      fs.writeFileSync(
        rec,
        fs
          .readFileSync(rec, "utf8")
          .replace(/"state": "running"/, '"state": "killed"'),
      );
      fs.utimesSync(rec, old, old);

      // sweep 1: the prune runs - record AND worktree dir go together
      const r1 = await f.run();
      expect(r1.code).toBe(0);
      // record_done guard: the closed record is not flagged on the
      // prune sweep itself
      expect(r1.out).not.toContain(`DEAD jarate/${t}`);
      expect(r1.out).toContain(`pruned run state ${t}`);
      expect(r1.out).toContain(`pruned worktree ${wt}`);
      expect(fs.existsSync(rec)).toBe(false);
      expect(fs.existsSync(wt)).toBe(false);
      expect(f.posts).toHaveLength(0);

      // sweep 2: no deadlog line was ever written (nothing flagged),
      // so the per-day dedupe is not what suppresses a re-flag here -
      // the dir itself is gone
      const r2 = await f.run();
      expect(r2.code).toBe(0);
      expect(r2.out).not.toContain(`DEAD jarate/${t}`);
      expect(f.posts).toHaveLength(0);
    } finally {
      f.close();
    }
  }, 30_000);

  test("held record: re-flagged daily until the retry fires (stays running)", async () => {
    const f = fixture();
    // Scrub the ambient PI_BG_* leak vars (mirrors retryFixture's list,
    // plus PI_BG_HB_PID): the bare fixture only scrubs PI_SERVICE/
    // JARATE_AGENTS_MD, and inside a jarate-bg wrapper the launched
    // retry run inherits the wrapper's env. That made this test green
    // by accident in wrapper envs and deterministically red in a clean
    // env (review #183 F1). Without the scrub the launched run takes
    // the PI_BG_TASK_FILE branch and reads the wrapper's prompt as its
    // task - or, on CI, dies "missing task" before the record write.
    for (const k of [
      "PI_BG_SETSID",
      "PI_BG_SNAP",
      "PI_BG_RUN_ID",
      "PI_BG_TASK_FILE",
      "PI_BG_HB_PID",
      "SNAP_DIR",
      "PI_BG_LANCHED_CWD",
      "PI_BG_HB_INTERVAL",
      "PI_BG_CMD_TIMEOUT",
      "PI_BG_PRUNE_AGE_H",
      "PI_BG_KEEP_SESSION",
      "PI_BG_PRUNE_SESSIONS",
      "PI_BG_RUN_START_EPOCH",
    ]) {
      delete f.env[k];
    }
    try {
      bless(f);
      const t = TID(2);
      const wt = wtDir(f, t);
      fs.mkdirSync(wt, { recursive: true });
      age(wt, 30);
      plantRunning(f, t);
      // canonical 3-line shape jarate-bg writes itself: the retry
      // launch extracts the task with `tail -n +3` (jarate-bg-watchdog:
      // 483), so a 1-line prompt comes out EMPTY -> "missing task" exit 2
      // before the run-record write -> the DISPATCH below never lands.
      fs.writeFileSync(
        path.join(f.art, `pi-bg-${t}-prompt.md`),
        "# pi-bg worker task\n\nretry me\n",
      );
      // cap 1 with one "live" ticket (fresh hb file, no record)
      fs.writeFileSync(path.join(f.art, `pi-bg-${TID(9)}-hb`), "");
      const over = {
        PI_BG_LAUNCHER: JB,
        PI_BG_MAX_CONCURRENT: "1",
        // Headroom, not the fix. Both CI reds (37473320280 at 8s,
        // 37484172676 at 30s) were the same non-timing cause: the
        // 1-line prompt (empty after `tail -n +3`) plus the ambient
        // PI_BG_* leak in wrapper envs - fixed above. 30s is kept as
        // headroom for a slow clean-env launch (worktree add, cgroup
        // escape); the production default stays 8s.
        PI_BG_RETRY_WAIT: "30",
      };
      const r1 = await f.run([], over);
      expect(r1.code).toBe(0);
      expect(r1.out).toContain(`retry ${t}: HELD (at cap 1/1)`);
      expect(f.posts).toHaveLength(1);
      expect(f.posts[0].embeds[0].description).toContain("retry held: at cap");
      // held records stay state=running (the #110 retry section
      // re-decides them daily; closing them would kill the retry)
      const rec1 = JSON.parse(fs.readFileSync(recFile(f, t), "utf8"));
      expect(rec1.state).toBe("running");
      expect(rec1.deadRetry.state).toBe("held");

      // same day: the sweep dedupes, the retry section re-decides
      const r2 = await f.run([], over);
      expect(r2.out).toContain(`retry ${t}: HELD (at cap 1/1)`);
      expect(f.posts).toHaveLength(1);

      // next day: re-flag + re-decide - still held, still running
      backdateDeadlog(f, t);
      const r3 = await f.run([], over);
      expect(r3.out).toContain(`DEAD jarate/${t}`);
      expect(f.posts).toHaveLength(2);
      expect(f.posts[1].embeds[0].description).toContain("retry held: at cap");
      expect(JSON.parse(fs.readFileSync(recFile(f, t), "utf8")).state).toBe(
        "running",
      );

      // a slot frees: the retry fires and closes the record
      fs.rmSync(path.join(f.art, `pi-bg-${TID(9)}-hb`));
      const r4 = await f.run([], over);
      expect(r4.out).toContain(`retry ${t}: DISPATCHED`);
      const rec4 = JSON.parse(fs.readFileSync(recFile(f, t), "utf8"));
      expect(rec4.state).toBe("killed");
      expect(rec4.deadRetry.state).toBe("dispatched");
      // clean up the retry record so the reaper/prune see a settled box
      const recIds = fs
        .readdirSync(path.join(f.home, ".pi-dispatch", "runs"))
        .filter((n) => n !== `pi-bg-${t}.json`);
      for (const n of recIds) {
        const rj = JSON.parse(
          fs.readFileSync(path.join(f.home, ".pi-dispatch", "runs", n), "utf8"),
        );
        rj.state = "killed";
        fs.writeFileSync(
          path.join(f.home, ".pi-dispatch", "runs", n),
          JSON.stringify(rj),
        );
      }
    } finally {
      f.close();
    }
  }, 90_000);

  const setCancelled = (f: { home: string }, t: string) => {
    const p = recFile(f, t);
    fs.writeFileSync(
      p,
      fs
        .readFileSync(p, "utf8")
        .replace(/"state": "running"/, '"state": "cancelled"'),
    );
  };

  test("state=cancelled record + kill marker: never flagged (worktree + cwd)", async () => {
    const f = fixture();
    try {
      bless(f);
      // worktree run, manually killed: kill marker + cancelled record
      const t1 = TID(3);
      const wt = wtDir(f, t1);
      fs.mkdirSync(wt, { recursive: true });
      age(wt, 30);
      plantRunning(f, t1);
      setCancelled(f, t1);
      fs.writeFileSync(path.join(f.art, `pi-bg-${t1}-killed`), "killed\n");
      // cwd run, manually killed: cancelled record, empty cgroup, stale hb
      const t2 = TID(4);
      plantRunning(f, t2);
      setCancelled(f, t2);
      fs.mkdirSync(path.join(f.tmp, "cg", "pi-bg", t2), { recursive: true });
      const hb = path.join(f.art, `pi-bg-${t2}-hb`);
      fs.writeFileSync(hb, "");
      age(hb, 15);
      const r = await f.run();
      expect(r.code).toBe(0);
      expect(r.out).not.toContain(`DEAD jarate/${t1}`);
      expect(r.out).not.toContain(`DEAD cwd/${t2}`);
      expect(r.out).not.toContain(`STALLED jarate/${t1}`);
      expect(f.posts).toHaveLength(0);
      expect(JSON.parse(fs.readFileSync(recFile(f, t1), "utf8")).state).toBe(
        "cancelled",
      );
      expect(JSON.parse(fs.readFileSync(recFile(f, t2), "utf8")).state).toBe(
        "cancelled",
      );
    } finally {
      f.close();
    }
  }, 30_000);
});

/**
 * #116: cwd-sweep vs cgroup-reaper race. A
 * SIGKILLed long cwd run leaves an
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
  // plant a CWD run record (no wt field) + stored prompt + stale hb +
  // empty cgroup dir (the SIGKILL shape): the cwd sweep's DEAD fixture
  const plantCwdRun = (f: F, t: string, prompt: string) => {
    const d = recDirOf(f);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(
      recFileOf(f, t),
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
        },
        null,
        2,
      ),
    );
    fs.writeFileSync(
      path.join(f.art, `pi-bg-${t}-prompt.md`),
      `# pi-bg worker task\n\n${prompt}\n`,
    );
    const hb = path.join(f.art, `pi-bg-${t}-hb`);
    fs.writeFileSync(hb, "");
    age(hb, 15); // > STALL_MIN (10)
    const cg = path.join(f.tmp, "cg", "pi-bg", t);
    fs.mkdirSync(cg, { recursive: true });
    fs.writeFileSync(path.join(cg, "cgroup.procs"), "");
  };
  // two fresh filler hbs filling PI_BG_MAX_CONCURRENT=2; returns the
  // first filler's path (rm it to free a slot)
  const plantFillers = (f: F) => {
    const fa = path.join(f.art, "pi-bg-20991211-000000-777-hb");
    const fb = path.join(f.art, "pi-bg-20991212-000000-777-hb");
    fs.writeFileSync(fa, "");
    fs.writeFileSync(fb, "");
    return fa;
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
      // wt-chain retry: the repo name, not "cwd" (review F4)
      expect(r2.out).toContain(`DEAD repo/${t2}`);
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
      // #51: the sticky terminal mark closes the record (nothing to hold:
      // no prompt -> no retry decision)
      expect(rec4.state).toBe("killed");
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

  test("cwd run: first death at full cap -> HELD, record stays running; slot frees -> fires on a later sweep (review F1)", async () => {
    const f = retryFixture();
    bless(f);
    f.env.PI_BG_MAX_CONCURRENT = "2";
    const t = RT(8);
    plantCwdRun(f, t, "cwd held task");
    const filler = plantFillers(f);
    let t2 = "";
    try {
      const r1 = await f.run();
      expect(r1.code).toBe(0);
      expect(r1.out).toContain(`DEAD cwd/${t}`);
      expect(r1.out).toContain(`retry ${t}: HELD (at cap 2/2)`);
      // the record must STAY running: killed+held is never re-checked by
      // the retry section and the retry is dropped forever (review F1)
      expect(rec(f, t).state).toBe("running");
      expect((rec(f, t).deadRetry as { state: string }).state).toBe("held");
      expect(recIds(f)).toEqual([t]); // nothing launched
      expect(f.posts).toHaveLength(1);
      expect(postOrThrow(f, t).description).toContain("retry held: at cap");
      // sweep 2: dead-log dedupe at the site; cap recheck in the retry
      // section still held; no re-post
      const r2 = await f.run();
      expect(r2.code).toBe(0);
      expect(r2.out).toContain(`retry ${t}: HELD (at cap 2/2)`);
      expect(recIds(f)).toEqual([t]);
      expect(f.posts).toHaveLength(1);
      // a slot frees: the later sweep fires it (T3 shape, cwd variant)
      fs.rmSync(filler);
      const r3 = await f.run();
      expect(r3.code).toBe(0);
      expect(r3.out).toContain(`retry ${t}: DISPATCHED`);
      // no worktree claim for a cwd run (review F4a)
      expect(r3.out).toContain(`(retry_of=${t}, same cwd)`);
      const rec3 = rec(f, t);
      expect(rec3.state).toBe("killed");
      expect((rec3.deadRetry as { state: string }).state).toBe("dispatched");
      t2 = (rec3.deadRetry as { ticket: string }).ticket;
      expect(t2).toMatch(/^\d{8}-\d{6}-\d+$/);
      expect(rec(f, t2).retryOf).toBe(t);
      expect(recIds(f).sort()).toEqual([t, t2].sort());
      killTicket(f, t2);
    } finally {
      f.close();
    }
  }, 90_000);

  test("quiet + PI_BG_WATCHDOG_RETRY=1: retry fully functional, zero posts (review F2)", async () => {
    const f = retryFixture();
    bless(f);
    f.env.PI_BG_MAX_CONCURRENT = "2";
    const t = RT(9);
    plantCwdRun(f, t, "cwd quiet-retry task");
    const filler = plantFillers(f);
    // retry pi stays slow: no OK callback can race the zero-post asserts
    fs.writeFileSync(path.join(f.tmp, "slow-ALL"), "");
    const q = { PI_BG_WATCHDOG_RETRY: "1" };
    let t2 = "";
    try {
      const r1 = await f.run(["--quiet"], q);
      expect(r1.code).toBe(0);
      expect(r1.out).toContain(`retry ${t}: HELD (at cap 2/2)`);
      expect(rec(f, t).state).toBe("running");
      expect((rec(f, t).deadRetry as { state: string }).state).toBe("held");
      expect(f.posts).toHaveLength(0); // quiet contract: no posts
      // quiet WITHOUT the override: the retry machinery is off entirely
      const r1b = await f.run(["--quiet"]);
      expect(r1b.code).toBe(0);
      expect(r1b.out).not.toContain(`retry ${t}:`);
      expect(r1b.out).toContain("retry_on=0");
      expect(recIds(f)).toEqual([t]);
      expect(f.posts).toHaveLength(0);
      // a slot frees + override: fires, record advances, still zero posts
      fs.rmSync(filler);
      const r2 = await f.run(["--quiet"], q);
      expect(r2.code).toBe(0);
      expect(r2.out).toContain(`retry ${t}: DISPATCHED`);
      expect(r2.out).toContain("retry_on=1");
      const rec2 = rec(f, t);
      expect(rec2.state).toBe("killed");
      expect((rec2.deadRetry as { state: string }).state).toBe("dispatched");
      t2 = (rec2.deadRetry as { ticket: string }).ticket;
      expect(rec(f, t2).retryOf).toBe(t);
      expect(recIds(f).sort()).toEqual([t, t2].sort());
      expect(f.posts).toHaveLength(0);
      killTicket(f, t2);
    } finally {
      f.close();
    }
  }, 90_000);

  test("live retry in the original dir: no spurious STALLED re-flag of the original after midnight (review F3)", async () => {
    const f = retryFixture();
    bless(f);
    // 8-digit date parts: the sweep skips ticket ids that do not match
    // ^[0-9]{8}-[0-9]{6}-[0-9]+$ (the RT() helper is 1-digit only)
    const t1 = "20991220-040506-110";
    const t2 = "20991221-040506-110";
    const wt = path.join(f.wtDir, "repo", t1);
    fs.mkdirSync(wt, { recursive: true });
    const d = recDirOf(f);
    fs.mkdirSync(d, { recursive: true });
    // original: dead + closed, its chain dispatched to t2 (yesterday)
    fs.writeFileSync(
      recFileOf(f, t1),
      JSON.stringify(
        {
          run: t1,
          profile: "worker",
          project: null,
          cwd: f.tmp,
          started: new Date(Date.now() - 7200_000)
            .toISOString()
            .replace(".000Z", "Z"),
          delivery: "webhook",
          state: "killed",
          wt,
          deadRetry: {
            state: "dispatched",
            ticket: t2,
            at: "2026-10-05T23:50:00Z",
          },
        },
        null,
        2,
      ),
    );
    // retry: live, running, in the SAME dir (the wt-reuse shape)
    fs.writeFileSync(
      recFileOf(f, t2),
      JSON.stringify(
        {
          run: t2,
          profile: "worker",
          project: null,
          cwd: wt,
          started: new Date(Date.now() - 600_000)
            .toISOString()
            .replace(".000Z", "Z"),
          delivery: "webhook",
          state: "running",
          wt,
          retryOf: t1,
        },
        null,
        2,
      ),
    );
    // yesterday's dead-log line for t1: today's dedupe has expired
    const yday = new Date(Date.now() - 86400_000).toISOString().slice(0, 10);
    fs.writeFileSync(
      path.join(f.home, ".pi-bg-deadlog"),
      `${yday} ${t1} repo 2026-10-05T23:50:00Z started, no completion marker (callback lost - SIGKILL/OOM)\n`,
    );
    // the retry alive in the original dir (its cgroup member sits in wt)
    const sleep = Bun.spawn(["sleep", "300"], {
      cwd: wt,
      stdout: "ignore",
      stderr: "ignore",
    });
    const cg = path.join(f.tmp, "cg", "pi-bg", t2);
    fs.mkdirSync(cg, { recursive: true });
    fs.writeFileSync(path.join(cg, "cgroup.procs"), `${sleep.pid}\n`);
    const hb1 = path.join(f.art, `pi-bg-${t1}-hb`);
    fs.writeFileSync(hb1, "");
    age(hb1, 15); // original hb stale
    fs.writeFileSync(path.join(f.art, `pi-bg-${t2}-hb`), ""); // retry fresh
    try {
      const r = await f.run();
      expect(r.code).toBe(0);
      expect(r.out).not.toContain("STALLED");
      expect(f.posts).toHaveLength(0);
      expect(rec(f, t1).state).toBe("killed"); // untouched
      // control: chain unconfirmed (retry record gone) -> STALLED stands
      fs.rmSync(recFileOf(f, t2));
      const r2 = await f.run();
      expect(r2.code).toBe(0);
      expect(r2.out).toContain(`STALLED repo/${t1}`);
      expect(f.posts).toHaveLength(1);
      expect(f.posts[0].embeds[0].title).toBe(
        "1 stalled \u00b7 watchdog sweep",
      );
    } finally {
      sleep.kill("SIGKILL");
      f.close();
    }
  }, 60_000);
});

/**
 * #53: dead-letter consumption. A callback that failed all 3 post
 * attempts (webhook down, bridge restart gap) leaves a dead letter and
 * the orchestrator never wakes on a DIED it never sees. The watchdog now
 * re-posts every letter whose JSON body is recoverable: self-contained
 * letters carry the body after the `--- body json ---` marker; pre-#53
 * letters reference a body file (fallback while it exists). Success:
 * wb-status re-post note + letter deleted (exactly-once). Failure: kept.
 */
describe("#53: dead-letter consumption", () => {
  const TID = (n: number) => `20991231-235958-${600 + n}`;
  const recFile = (f: { home: string }, t: string) =>
    path.join(f.home, ".pi-dispatch", "runs", `pi-bg-${t}.json`);
  const wtDir = (f: { wtDir: string }, t: string) =>
    path.join(f.wtDir, "jarate", t);
  const age = (d: string, min: number) =>
    fs.utimesSync(
      d,
      new Date(Date.now() - min * 60 * 1000),
      new Date(Date.now() - min * 60 * 1000),
    );
  const bless = (f: { manifest: () => string; sha: (s: string) => string }) =>
    fs.writeFileSync(
      f.manifest(),
      `${f.sha("# law v1\n")} 2026-09-14T00:00:00Z  dead letter test\n`,
    );
  const plantRunning = (f: { home: string; tmp: string }, t: string) => {
    const d = path.join(f.home, ".pi-dispatch", "runs");
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(
      recFile(f, t),
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
  };

  // Self-contained letter (post-#53 shape): header + embedded JSON body.
  const plantLetter = (
    f: { art: string },
    t: string,
    kind: "cb" | "kill",
    body: object,
  ) => {
    const name =
      kind === "kill"
        ? `pi-bg-${t}-kill-webhook-failed`
        : `pi-bg-${t}-webhook-failed`;
    const p = path.join(f.art, name);
    const lines = [
      `ticket   : ${t}`,
      ...(kind === "kill" ? ["event    : kill"] : []),
      "http     : 000 (3 attempts)",
      "when     : 2026-10-06T00:00:00Z",
      "response : ",
      "--- body json ---",
      JSON.stringify(body),
      "",
    ];
    fs.writeFileSync(p, lines.join("\n"));
    return p;
  };

  const DIED_BODY = {
    content: "[bg:worker:DIED] cwd=/w task=dead letter task\n\nout",
  };

  test("self-contained cb letter: re-posted, wb-status note, deleted (exactly-once)", async () => {
    const f = fixture();
    bless(f);
    const t = TID(1);
    const lp = plantLetter(f, t, "cb", DIED_BODY);
    try {
      const r = await f.run();
      expect(r.code).toBe(0);
      expect(r.out).toContain(`dead letter ${t}: re-posted`);
      expect(f.posts).toHaveLength(1);
      expect(f.posts[0]).toEqual(DIED_BODY);
      expect(fs.existsSync(lp)).toBe(false);
      const ws = fs.readFileSync(
        path.join(f.art, `pi-bg-${t}-wb-status`),
        "utf8",
      );
      expect(ws).toContain("(watchdog re-post, issue #53)");
      // exactly-once: a second sweep finds nothing to consume
      const r2 = await f.run();
      expect(r2.code).toBe(0);
      expect(f.posts).toHaveLength(1);
    } finally {
      f.close();
    }
  });

  test("kill letter: re-posted and cleared like a callback letter", async () => {
    const f = fixture();
    bless(f);
    const t = TID(2);
    const body = {
      content: "",
      embeds: [{ title: `pi-bg ${t} \u00b7 CANCELLED` }],
    };
    const lp = plantLetter(f, t, "kill", body);
    try {
      const r = await f.run();
      expect(r.code).toBe(0);
      expect(r.out).toContain(`dead letter ${t}: re-posted`);
      expect(f.posts).toHaveLength(1);
      expect(f.posts[0]).toEqual(body);
      expect(fs.existsSync(lp)).toBe(false);
    } finally {
      f.close();
    }
  });

  test("pre-#53 letter: body-file fallback while the file exists", async () => {
    const f = fixture();
    bless(f);
    const t = TID(3);
    const bodyPath = path.join(f.art, `pi-bg-${t}-body.json`);
    fs.writeFileSync(bodyPath, JSON.stringify(DIED_BODY));
    const lp = path.join(f.art, `pi-bg-${t}-webhook-failed`);
    fs.writeFileSync(
      lp,
      [
        `ticket   : ${t}`,
        "http     : 000 (3 attempts)",
        "when     : 2026-10-06T00:00:00Z",
        `body     : ${bodyPath}`,
        "",
      ].join("\n"),
    );
    try {
      const r = await f.run();
      expect(r.code).toBe(0);
      expect(r.out).toContain(`dead letter ${t}: re-posted`);
      expect(f.posts).toHaveLength(1);
      expect(f.posts[0]).toEqual(DIED_BODY);
      expect(fs.existsSync(lp)).toBe(false);
    } finally {
      f.close();
    }
  });

  test("no recoverable body: letter kept for forensics, no post", async () => {
    const f = fixture();
    bless(f);
    const t = TID(4);
    const lp = path.join(f.art, `pi-bg-${t}-webhook-failed`);
    fs.writeFileSync(
      lp,
      [
        `ticket   : ${t}`,
        "http     : 000 (3 attempts)",
        "when     : 2026-10-06T00:00:00Z",
        `body     : ${path.join(f.art, "gone.json")}`,
        "",
      ].join("\n"),
    );
    try {
      const r = await f.run();
      expect(r.code).toBe(0);
      expect(r.out).toContain("no recoverable body - kept for forensics");
      expect(f.posts).toHaveLength(0);
      expect(fs.existsSync(lp)).toBe(true);
      // still there after a second sweep (not a transient failure)
      await f.run();
      expect(fs.existsSync(lp)).toBe(true);
    } finally {
      f.close();
    }
  });

  test("dry-run: would re-post, letter kept, nothing posted", async () => {
    const f = fixture();
    bless(f);
    const t = TID(5);
    const lp = plantLetter(f, t, "cb", DIED_BODY);
    try {
      const r = await f.run(["--dry-run"]);
      expect(r.code).toBe(0);
      expect(r.out).toContain(`dry-run: would re-post dead letter ${t}`);
      expect(f.posts).toHaveLength(0);
      expect(fs.existsSync(lp)).toBe(true);
    } finally {
      f.close();
    }
  });

  test("--quiet: letters kept, zero posts (quiet contract, review F4)", async () => {
    const f = fixture();
    bless(f);
    const t = TID(11);
    const lp = plantLetter(f, t, "cb", DIED_BODY);
    try {
      const r = await f.run(["--quiet"]);
      expect(r.code).toBe(0);
      expect(r.out).toContain(`quiet: dead letter ${t} kept (no post)`);
      expect(f.posts).toHaveLength(0); // quiet contract: no posts
      expect(fs.existsSync(lp)).toBe(true); // kept for the next sweep
      // the next NON-quiet sweep consumes it (exactly-once still holds)
      const r2 = await f.run();
      expect(r2.code).toBe(0);
      expect(r2.out).toContain(`dead letter ${t}: re-posted`);
      expect(f.posts).toHaveLength(1);
      expect(f.posts[0]).toEqual(DIED_BODY);
      expect(fs.existsSync(lp)).toBe(false);
    } finally {
      f.close();
    }
  });

  test("webhook down: re-post fails, letter kept for the next sweep", async () => {
    const f = fixture();
    bless(f);
    const t = TID(6);
    const lp = plantLetter(f, t, "cb", DIED_BODY);
    try {
      // port 9 (discard): conn refused -> all 3 attempts 000
      const r = await f.run([], {
        PI_DISPATCH_WEBHOOK: "http://127.0.0.1:9/dl",
      });
      expect(r.code).toBe(0);
      expect(r.err).toContain(
        `dead letter ${t}: re-post failed - kept for next sweep`,
      );
      expect(f.posts).toHaveLength(0);
      expect(fs.existsSync(lp)).toBe(true);
    } finally {
      f.close();
    }
  }, 30_000);

  test("DEAD sweep + consumption: dead-letter reason AND re-posted DIED", async () => {
    const f = fixture();
    bless(f);
    const t = TID(7);
    const wt = wtDir(f, t);
    fs.mkdirSync(wt, { recursive: true });
    age(wt, 30);
    plantRunning(f, t);
    const lp = plantLetter(f, t, "cb", DIED_BODY);
    try {
      const r = await f.run();
      expect(r.code).toBe(0);
      expect(r.out).toContain(`DEAD jarate/${t}`);
      // TWO posts: the DEAD digest (posted by the sweep) + the re-posted
      // DIED callback (posted by the consumer, in order)
      expect(f.posts).toHaveLength(2);
      const digest = f.posts[0].embeds[0];
      expect(digest.title).toBe("DEAD \u00b7 watchdog sweep");
      // the reason line tail-clips at the 29-col value budget
      expect(digest.description).toContain("webhook dead letter exists");
      expect(f.posts[1]).toEqual(DIED_BODY);
      // the letter is gone after the sweep (consumed, exactly-once)
      expect(fs.existsSync(lp)).toBe(false);
      // #51 sticky mark: the flagged death closed the running record
      const rec = JSON.parse(fs.readFileSync(recFile(f, t), "utf8"));
      expect(rec.state).toBe("killed");
    } finally {
      f.close();
    }
  }, 30_000);
});

// ---------------------------------------------------------------------------
// #143: mid-run events (child-left / sess-write). The after-intervention
// case: a dispatched run is alive but its cgroup membership changed
// (an external kill of a wedged child) or its session jsonl advanced (pi
// wrote again). Additive status lines - no state change, never
// DEAD/HUNG/retry. Dedupe per ticket per class per UTC day in the dead
// log; the DEAD/STALLED dedupe ignores event lines.
// ---------------------------------------------------------------------------
describe("#143: mid-run events (child-left / sess-write)", () => {
  type F = ReturnType<typeof fixture>;

  // manifest matching the fixture's AGENTS.md content -> no drift post
  const bless = (f: F) =>
    fs.writeFileSync(
      f.manifest(),
      `${f.sha("# law v1\n")} 2026-10-06T00:00:00Z  #143 events test\n`,
    );

  // distinct tickets; the NNNNN run-id part is unique per suffix query
  const ET = (n: number): string => `2026101${n}-050607-95143${n}7`;

  // Plant a live cwd run: backdated record (started 2h ago, running),
  // fake cgroup (dir aged 30min - past the reaper guard) with the given
  // member pids (REAL live processes in the test), a session jsonl with
  // an explicit backdated mtime, a fresh heartbeat (no STALLED).
  // Returns the session jsonl path (the test advances it).
  const plant = (
    f: F,
    t: string,
    pids: string[],
    jsonlAgeSec: number,
  ): string => {
    const recDir = path.join(f.home, ".pi-dispatch", "runs");
    fs.mkdirSync(recDir, { recursive: true });
    fs.writeFileSync(
      path.join(recDir, `pi-bg-${t}.json`),
      JSON.stringify({
        run: t,
        profile: "worker",
        project: null,
        cwd: f.tmp,
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
      pids.length ? `${pids.join("\n")}\n` : "",
    );
    const old = new Date(Date.now() - 30 * 60 * 1000);
    fs.utimesSync(cg, old, old);
    const slug = `--${f.tmp.slice(1).replace(/\//g, "-")}--`;
    const sd = path.join(f.home, ".pi", "agent-worker", "sessions", slug);
    fs.mkdirSync(sd, { recursive: true });
    const jf = path.join(sd, "sess.jsonl");
    fs.writeFileSync(jf, "{}\n");
    fs.utimesSync(
      jf,
      new Date(Date.now() - jsonlAgeSec * 1000),
      new Date(Date.now() - jsonlAgeSec * 1000),
    );
    // fresh heartbeat (a live run, not a stalled one)
    fs.writeFileSync(path.join(f.art, `pi-bg-${t}-hb`), "");
    return jf;
  };

  const setProcs = (f: F, t: string, pids: string[]): void =>
    fs.writeFileSync(
      path.join(f.tmp, "cg", "pi-bg", t, "cgroup.procs"),
      pids.length ? `${pids.join("\n")}\n` : "",
    );

  const rec = (f: F, t: string): Record<string, unknown> =>
    JSON.parse(
      fs.readFileSync(
        path.join(f.home, ".pi-dispatch", "runs", `pi-bg-${t}.json`),
        "utf8",
      ),
    );

  const deadlog = (f: F): string => {
    const p = path.join(f.home, ".pi-bg-deadlog");
    return fs.existsSync(p) ? fs.readFileSync(p, "utf8") : "";
  };

  const frameLines = (s: string): string[] =>
    s
      .replace(/^```bash\n/, "")
      .replace(/\n```$/, "")
      .split("\n");

  // (a)+(b) external kill of a grandchild between sweeps -> exactly one
  // CHILD-LEFT line + one post, then nothing (dedupe) on the next sweep;
  // the run stays running (no DEAD/HUNG side effects).
  test("kill between sweeps -> one child-left line, next sweep quiet", async () => {
    const f = fixture();
    bless(f);
    const t = ET(1);
    let w: ReturnType<typeof Bun.spawn> | null = null;
    let g: ReturnType<typeof Bun.spawn> | null = null;
    try {
      w = Bun.spawn(["sleep", "300"], {
        cwd: f.tmp,
        stdout: "ignore",
        stderr: "ignore",
      });
      g = Bun.spawn(["sleep", "300"], {
        cwd: f.tmp,
        stdout: "ignore",
        stderr: "ignore",
      });
      const gp = g.pid;
      plant(f, t, [String(w.pid), String(gp)], 300);
      // sweep 1: first sight = baseline only, no event
      const r1 = await f.run();
      expect(r1.code).toBe(0);
      expect(r1.out).not.toContain("CHILD-LEFT");
      expect(r1.out).not.toContain("SESS-WRITE");
      expect(f.posts).toHaveLength(0);
      expect(rec(f, t).cgPids).toEqual([w.pid, gp]);
      expect(typeof rec(f, t).sessMtime).toBe("number");
      // the operator kill (cgroupfs drops the pid on exit)
      g.kill("SIGKILL");
      await g.exited;
      g = null;
      setProcs(f, t, [String(w.pid)]);
      // sweep 2: exactly one CHILD-LEFT line + one post
      const r2 = await f.run();
      expect(r2.code).toBe(0);
      expect(r2.out).toContain(`CHILD-LEFT cwd/${t}`);
      expect((r2.out.match(/CHILD-LEFT/g) ?? []).length).toBe(1);
      expect(r2.out).toContain(String(gp));
      expect(r2.out).toContain("1 mid-run event(s)");
      // no run class fired: the run is alive (w is a cgroup member)
      expect(r2.out).not.toContain("DEAD cwd/");
      expect(r2.out).not.toContain("HUNG cwd/");
      expect(rec(f, t).state).toBe("running");
      expect(rec(f, t).hungNotified).toBeUndefined();
      // post shape: green embed, sweep author, 40-col frame
      expect(f.posts).toHaveLength(1);
      const e = f.posts[0].embeds[0];
      expect(e.title).toBe(`CHILD-LEFT \u00b7 ${t}`);
      expect(e.author?.name).toBe(`pi-bg ticket \u00b7 ${t}`);
      expect(e.color).toBe(3066993);
      for (const line of frameLines(e.description)) {
        expect(line.length).toBeLessThanOrEqual(40);
      }
      expect(e.description).toContain(String(gp));
      // dead-log receipt (house style: date ticket repo ts reason)
      const dl = deadlog(f);
      expect(dl).toMatch(
        new RegExp(
          `^\\d{4}-\\d{2}-\\d{2} ${t} cwd \\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}Z child-left: pids ${gp} left cgroup$`,
          "m",
        ),
      );
      // sweep 3: nothing new (baseline refreshed + class deduped)
      const r3 = await f.run();
      expect(r3.code).toBe(0);
      expect(r3.out).not.toContain("CHILD-LEFT");
      expect(f.posts).toHaveLength(1);
      expect(rec(f, t).state).toBe("running");
    } finally {
      w?.kill("SIGKILL");
      g?.kill("SIGKILL");
      await Promise.all([w?.exited, g?.exited]);
      f.close();
    }
  }, 30_000);

  // (c) session jsonl advance while the wrapper is quiet -> at most one
  // SESS-WRITE per class per day; the line names the previous write time.
  test("session advance while quiet -> one sess-write line, then dedupe", async () => {
    const f = fixture();
    bless(f);
    const t = ET(2);
    let w: ReturnType<typeof Bun.spawn> | null = null;
    try {
      w = Bun.spawn(["sleep", "300"], {
        cwd: f.tmp,
        stdout: "ignore",
        stderr: "ignore",
      });
      // explicit backdates (no same-second races): T0 < T1 < T2, all past
      const now = Math.floor(Date.now() / 1000);
      const T0 = now - 300;
      const T1 = now - 240;
      const T2 = now - 180;
      const jf = plant(f, t, [String(w.pid)], 300); // mtime = ~T0
      fs.utimesSync(jf, new Date(T0 * 1000), new Date(T0 * 1000));
      const r1 = await f.run();
      expect(r1.out).not.toContain("SESS-WRITE");
      const base0 = rec(f, t).sessMtime as number;
      expect(base0).toBe(T0);
      // pi wrote again (the run resumed after the kill)
      fs.appendFileSync(jf, '{"type":"message"}\n');
      fs.utimesSync(jf, new Date(T1 * 1000), new Date(T1 * 1000));
      const r2 = await f.run();
      expect(r2.out).toContain(`SESS-WRITE cwd/${t}`);
      expect((r2.out.match(/SESS-WRITE/g) ?? []).length).toBe(1);
      expect(r2.out).toContain(
        new Date(T0 * 1000).toISOString().replace(".000Z", "Z"),
      );
      expect(f.posts).toHaveLength(1);
      expect(f.posts[0].embeds[0].title).toBe(`SESS-WRITE \u00b7 ${t}`);
      expect(deadlog(f)).toMatch(
        new RegExp(
          `^\\d{4}-\\d{2}-\\d{2} ${t} cwd .* sess-write: session jsonl wrote \\(was `,
          "m",
        ),
      );
      // a second advance: the diff exists (T2 > T1) but the class was
      // already logged today -> no line, no post
      fs.appendFileSync(jf, '{"type":"message2"}\n');
      fs.utimesSync(jf, new Date(T2 * 1000), new Date(T2 * 1000));
      const r3 = await f.run();
      expect(r3.out).not.toContain("SESS-WRITE");
      expect(f.posts).toHaveLength(1);
    } finally {
      w?.kill("SIGKILL");
      await w?.exited;
      f.close();
    }
  }, 30_000);

  // (d) healthy run: two sweeps, nothing new (no lines, no posts, no
  // dead log), baseline stored.
  test("healthy run -> nothing new across sweeps", async () => {
    const f = fixture();
    bless(f);
    const t = ET(3);
    let w: ReturnType<typeof Bun.spawn> | null = null;
    try {
      w = Bun.spawn(["sleep", "300"], {
        cwd: f.tmp,
        stdout: "ignore",
        stderr: "ignore",
      });
      plant(f, t, [String(w.pid)], 300);
      const r1 = await f.run();
      const r2 = await f.run();
      for (const r of [r1, r2]) {
        expect(r.code).toBe(0);
        expect(r.out).not.toContain("CHILD-LEFT");
        expect(r.out).not.toContain("SESS-WRITE");
      }
      expect(f.posts).toHaveLength(0);
      expect(deadlog(f)).toBe("");
      expect(r2.out).toContain("0 mid-run event(s)");
      expect(rec(f, t).cgPids).toEqual([w.pid]);
    } finally {
      w?.kill("SIGKILL");
      await w?.exited;
      f.close();
    }
  }, 30_000);

  // (e) --quiet: the log line is still emitted (local record), no post.
  test("--quiet -> log line present, no post", async () => {
    const f = fixture();
    bless(f);
    const t = ET(4);
    let w: ReturnType<typeof Bun.spawn> | null = null;
    let g: ReturnType<typeof Bun.spawn> | null = null;
    try {
      w = Bun.spawn(["sleep", "300"], {
        cwd: f.tmp,
        stdout: "ignore",
        stderr: "ignore",
      });
      g = Bun.spawn(["sleep", "300"], {
        cwd: f.tmp,
        stdout: "ignore",
        stderr: "ignore",
      });
      const gp = g.pid;
      plant(f, t, [String(w.pid), String(gp)], 300);
      await f.run(); // baseline
      g.kill("SIGKILL");
      await g.exited;
      g = null;
      setProcs(f, t, [String(w.pid)]);
      const r = await f.run(["--quiet"]);
      expect(r.code).toBe(0);
      expect(r.out).toContain(`CHILD-LEFT cwd/${t}`);
      expect(r.out).toContain(String(gp));
      expect(f.posts).toHaveLength(0);
      expect(deadlog(f)).toMatch(/child-left: pids .* left cgroup/);
      expect(rec(f, t).state).toBe("running");
    } finally {
      w?.kill("SIGKILL");
      g?.kill("SIGKILL");
      await Promise.all([w?.exited, g?.exited]);
      f.close();
    }
  }, 30_000);

  // --dry-run: would-emit line only, no state (the baseline survives, so
  // the next real sweep still sees the diff and emits).
  test("--dry-run -> would-emit line, no state, next sweep emits", async () => {
    const f = fixture();
    bless(f);
    const t = ET(5);
    let w: ReturnType<typeof Bun.spawn> | null = null;
    let g: ReturnType<typeof Bun.spawn> | null = null;
    try {
      w = Bun.spawn(["sleep", "300"], {
        cwd: f.tmp,
        stdout: "ignore",
        stderr: "ignore",
      });
      g = Bun.spawn(["sleep", "300"], {
        cwd: f.tmp,
        stdout: "ignore",
        stderr: "ignore",
      });
      const gp = g.pid;
      plant(f, t, [String(w.pid), String(gp)], 300);
      await f.run(); // baseline
      g.kill("SIGKILL");
      await g.exited;
      g = null;
      setProcs(f, t, [String(w.pid)]);
      const r2 = await f.run(["--dry-run"]);
      expect(r2.code).toBe(0);
      expect(r2.out).toContain(`dry-run: would emit CHILD-LEFT cwd/${t}`);
      expect(f.posts).toHaveLength(0);
      expect(deadlog(f)).toBe("");
      // baseline untouched by the dry sweep
      expect(rec(f, t).cgPids).toEqual([w.pid, gp]);
      // the real sweep still sees the diff
      const r3 = await f.run();
      expect(r3.out).toContain(`CHILD-LEFT cwd/${t}`);
      expect(f.posts).toHaveLength(1);
    } finally {
      w?.kill("SIGKILL");
      g?.kill("SIGKILL");
      await Promise.all([w?.exited, g?.exited]);
      f.close();
    }
  }, 30_000);

  // an event line today must not suppress a real death later today
  // (already_dead ignores event classes).
  test("child-left event does not suppress the later DEAD flag", async () => {
    const f = fixture();
    bless(f);
    const t = ET(6);
    let w: ReturnType<typeof Bun.spawn> | null = null;
    let g: ReturnType<typeof Bun.spawn> | null = null;
    try {
      w = Bun.spawn(["sleep", "300"], {
        cwd: f.tmp,
        stdout: "ignore",
        stderr: "ignore",
      });
      g = Bun.spawn(["sleep", "300"], {
        cwd: f.tmp,
        stdout: "ignore",
        stderr: "ignore",
      });
      plant(f, t, [String(w.pid), String(g.pid)], 300);
      await f.run(); // baseline
      g.kill("SIGKILL");
      await g.exited;
      g = null;
      setProcs(f, t, [String(w.pid)]);
      const r2 = await f.run();
      expect(r2.out).toContain(`CHILD-LEFT cwd/${t}`);
      // now the whole run dies: wrapper gone, cgroup drained, hb stale
      w.kill("SIGKILL");
      await w.exited;
      w = null;
      setProcs(f, t, []);
      const stale = new Date(Date.now() - 20 * 60 * 1000);
      fs.utimesSync(path.join(f.art, `pi-bg-${t}-hb`), stale, stale);
      const r3 = await f.run();
      expect(r3.code).toBe(0);
      expect(r3.out).toContain(`DEAD cwd/${t}`);
      // child-left post (r2) + DEAD digest (r3)
      expect(f.posts).toHaveLength(2);
      expect(f.posts[1].embeds[0].title).toBe("DEAD \u00b7 watchdog sweep");
      expect(rec(f, t).state).toBe("killed");
    } finally {
      w?.kill("SIGKILL");
      g?.kill("SIGKILL");
      await Promise.all([w?.exited, g?.exited]);
      f.close();
    }
  }, 30_000);
});
// ────────────────────────────────────────────────────────────────────────────
// #191 M1: agent OOM signature (slice memory.events delta)
//
// Kernel OOM text did not persist to the system journal (proven on
// hydrogen 2026-10-07: 0 kernel OOM entries for the 2026-10-04 incident
// window); the slice cgroup counters are the only durable OOM record. The
// sweep reads $PI_BG_OOM_ROOT/user-<uid>.slice/memory.events for the
// in-scope uids (own uid + the fleet-agents roster; the fixture's fake
// root is the spec's test seam - unit tests never read real cgroups),
// compares oom_kill/oom against the persisted baseline
// ($PI_DISPATCH_RECORD_DIR/oom-baseline.json, survives restarts), and
// posts an OOM-ALERT ([bg: agent-watch] content prefix + 40-col frame) on
// a positive oom_kill delta. Baseline semantics: first sight = quiet
// baseline (the historical counter never alerts); the baseline advances
// ONLY after a successful post (dead webhook -> same grown delta re-posts
// next sweep); counter regression (slice recreated) = quiet re-baseline;
// max 1 ALERT per uid per 60 min (dedupe state in the same file, written
// only after a successful post). FINDING only (M1): no auto-restart, no
// MemoryMax changes, no marker/liveness logic (M2).
// ────────────────────────────────────────────────────────────────────────────
describe("#191 M1: agent OOM signature (slice memory.events delta)", () => {
  const OWN = os.userInfo().uid; // the test runner's uid (frank = 1002 on hydrogen)
  const PEER = OWN === 1003 ? 1004 : 1003; // fleet-roster uid (fake slice)

  type OomEvents = { oom?: number; oom_kill?: number; max?: number };
  type OomEntry = { oom_kill: number; oom: number; last_alert_epoch?: number };

  /** Base fixture + slice helpers on the fake OOM root. */
  const oomFixture = () => {
    const f = fixture();
    const oomRoot = f.env.PI_BG_OOM_ROOT as string;
    const recDir = f.env.PI_DISPATCH_RECORD_DIR as string;
    // no drift post under the OOM tests: bless the fixture AGENTS.md
    // (the sweep runs `jarate agents-check` on every run when bun is on
    // PATH - CI and this box both are)
    fs.writeFileSync(
      f.manifest(),
      `${f.sha("# law v1\n")} 2026-10-06T00:00:00Z  #191 M1 oom test\n`,
    );
    const slice = (uid: number) => {
      const d = path.join(oomRoot, `user-${uid}.slice`);
      fs.mkdirSync(d, { recursive: true });
      return d;
    };
    // same key set as the real file (incl. oom_group_kill: the parser
    // must pick "oom", not "oom_kill", by exact key match)
    const events = (uid: number, e: OomEvents) => {
      const d = slice(uid);
      fs.writeFileSync(
        path.join(d, "memory.events"),
        `${[
          `low 0`,
          `high 0`,
          `max ${e.max ?? 0}`,
          `oom ${e.oom ?? 0}`,
          `oom_kill ${e.oom_kill ?? 0}`,
          `oom_group_kill 0`,
        ].join("\n")}\n`,
      );
    };
    const setMax = (uid: number, s: string) => {
      fs.writeFileSync(path.join(slice(uid), "memory.max"), `${s}\n`);
    };
    const setPeak = (uid: number, s: string) => {
      fs.writeFileSync(path.join(slice(uid), "memory.peak"), `${s}\n`);
    };
    const baselineFile = path.join(recDir, "oom-baseline.json");
    const seedBaseline = (entries: Record<string, OomEntry>) => {
      fs.mkdirSync(recDir, { recursive: true });
      fs.writeFileSync(baselineFile, JSON.stringify(entries, null, 2));
    };
    const baseline = (): Record<string, OomEntry> =>
      JSON.parse(fs.readFileSync(baselineFile, "utf8"));
    const fleet = (lines: string[]) => {
      const d = path.join(f.home, ".config", "jarate");
      fs.mkdirSync(d, { recursive: true });
      fs.writeFileSync(path.join(d, "fleet-agents"), `${lines.join("\n")}\n`);
    };
    return {
      ...f,
      oomRoot,
      recDir,
      slice,
      events,
      setMax,
      setPeak,
      baselineFile,
      seedBaseline,
      baseline,
      fleet,
    };
  };

  test("first sight baselines quietly: the historical counter never alerts (the 32-kill rule)", async () => {
    const f = oomFixture();
    try {
      f.events(OWN, { oom: 63, oom_kill: 32 });
      f.setMax(OWN, "25769803776");
      f.setPeak(OWN, "22764904448");
      const r = await f.run();
      expect(r.code).toBe(0);
      expect(f.posts).toHaveLength(0); // quiet: a historical 32 never alerts
      expect(r.out).toContain(
        `oom baseline: user-${OWN}.slice (oom_kill=32 oom=63)`,
      );
      const b = f.baseline();
      expect(b[String(OWN)].oom_kill).toBe(32);
      expect(b[String(OWN)].oom).toBe(63);
      expect(b[String(OWN)].last_alert_epoch).toBeUndefined();
    } finally {
      f.close();
    }
  });

  test("positive oom_kill delta -> OOM-ALERT post ([bg: agent-watch], delta + totals + max + peak), baseline advances", async () => {
    const f = oomFixture();
    try {
      f.seedBaseline({ [String(OWN)]: { oom_kill: 0, oom: 0 } });
      f.events(OWN, { oom: 5, oom_kill: 2 });
      f.setMax(OWN, "25769803776");
      f.setPeak(OWN, "22764904448");
      const r = await f.run();
      expect(r.code).toBe(0);
      expect(f.posts).toHaveLength(1);
      const body = f.posts[0];
      // the content prefix is the webhook wake marker (isBgWebhook)
      expect(body.content).toBe(
        `[bg: agent-watch] OOM: user-${OWN}.slice oom_kill +2 (2 total since baseline 0)`,
      );
      const em = body.embeds[0];
      expect(em.title).toBe(`OOM-ALERT \u00b7 user-${OWN}.slice`);
      expect(em.author?.name).toBe("pi-bg watchdog");
      expect(em.color).toBe(15158332); // red: kills in the agent slice
      expect(em.footer?.text).toBe("pi-bg watchdog (oom, issue #191)");
      const lines = codeLines(em);
      for (const want of [
        `\u250c oom \u00b7 user-${OWN}.slice`,
        `\u251c kill   : +2 (2 total, base 0)`,
        `\u251c oom    : +5 (5 total, base 0)`,
        `\u251c max    : 25769803776 (24.0G)`,
        `\u251c peak   : 22764904448 (21.2G)`,
      ]) {
        expect(lines).toContain(want);
      }
      // the frame obeys the 40-col mobile budget (docs/STYLE.md 2.3)
      for (const l of lines) expect(l.length).toBeLessThanOrEqual(40);
      // baseline advanced AFTER the successful post, dedupe stamp set
      const b = f.baseline();
      expect(b[String(OWN)].oom_kill).toBe(2);
      expect(b[String(OWN)].oom).toBe(5);
      expect(b[String(OWN)].last_alert_epoch).toBeGreaterThan(0);
      expect(r.out).toContain(
        `OOM user-${OWN}.slice: oom_kill +2 (2 total, base 0), oom +5 (5 total)`,
      );
      expect(r.out).toContain("flagged 1 agent OOM finding(s)");
    } finally {
      f.close();
    }
  });

  test("no new kills (delta 0) -> no re-post, entry untouched", async () => {
    const f = oomFixture();
    try {
      f.seedBaseline({ [String(OWN)]: { oom_kill: 2, oom: 5 } });
      f.events(OWN, { oom: 5, oom_kill: 2 });
      const r = await f.run();
      expect(r.code).toBe(0);
      expect(f.posts).toHaveLength(0);
      expect(r.out).not.toContain("OOM user-");
      const b = f.baseline();
      expect(b[String(OWN)].last_alert_epoch).toBeUndefined();
    } finally {
      f.close();
    }
  });

  test("post failure keeps the baseline: next sweep re-posts the grown delta (dead-letter pattern)", async () => {
    const f = oomFixture();
    try {
      f.seedBaseline({ [String(OWN)]: { oom_kill: 0, oom: 0 } });
      f.events(OWN, { oom: 2, oom_kill: 1 });
      // webhook down: connection refused, 3 attempts + backoff
      const r1 = await f.run([], {
        PI_DISPATCH_WEBHOOK: "http://127.0.0.1:1/none",
      });
      expect(r1.code).toBe(0);
      expect(f.posts).toHaveLength(0);
      expect(r1.err).toContain(
        `OOM post failed for user-${OWN}.slice - baseline kept, retries next sweep`,
      );
      // baseline NOT advanced (the dead-letter rule)
      expect(f.baseline()[String(OWN)].oom_kill).toBe(0);
      // the storm keeps killing while the webhook is down; it comes back
      f.events(OWN, { oom: 7, oom_kill: 3 });
      const r2 = await f.run();
      expect(r2.code).toBe(0);
      expect(f.posts).toHaveLength(1);
      // the accumulated delta is reported (nothing was lost)
      expect(f.posts[0].content).toBe(
        `[bg: agent-watch] OOM: user-${OWN}.slice oom_kill +3 (3 total since baseline 0)`,
      );
      expect(f.baseline()[String(OWN)].oom_kill).toBe(3);
      expect(f.baseline()[String(OWN)].oom).toBe(7);
    } finally {
      f.close();
    }
  }, 30_000);

  test("60-min dedupe: a second alert inside the window is suppressed; the next posts the accumulated delta", async () => {
    const f = oomFixture();
    const now = Math.floor(Date.now() / 1000);
    try {
      f.seedBaseline({
        [String(OWN)]: { oom_kill: 0, oom: 0, last_alert_epoch: now - 600 },
      });
      f.events(OWN, { oom: 2, oom_kill: 1 });
      const r1 = await f.run();
      expect(r1.code).toBe(0);
      expect(f.posts).toHaveLength(0);
      expect(r1.out).toContain(`oom user-${OWN}.slice: oom_kill +1 suppressed`);
      expect(r1.out).toContain("deduped 1 OOM alert(s) (60m window)");
      // suppressed = no post = no baseline advance, dedupe stamp kept
      const b1 = f.baseline();
      expect(b1[String(OWN)].oom_kill).toBe(0);
      expect(b1[String(OWN)].last_alert_epoch).toBe(now - 600);
      // window elapses (70 min); the storm added 2 more kills meanwhile
      f.seedBaseline({
        [String(OWN)]: { oom_kill: 0, oom: 0, last_alert_epoch: now - 4200 },
      });
      f.events(OWN, { oom: 6, oom_kill: 3 });
      const r2 = await f.run();
      expect(r2.code).toBe(0);
      expect(f.posts).toHaveLength(1);
      expect(f.posts[0].content).toContain(
        "oom_kill +3 (3 total since baseline 0)",
      );
    } finally {
      f.close();
    }
  });

  test("counter regression (slice cgroup recreated) -> quiet re-baseline, no alert", async () => {
    const f = oomFixture();
    const now = Math.floor(Date.now() / 1000);
    try {
      f.seedBaseline({
        [String(OWN)]: { oom_kill: 32, oom: 63, last_alert_epoch: now - 100 },
      });
      f.events(OWN, { oom: 0, oom_kill: 0 });
      const r = await f.run();
      expect(r.code).toBe(0);
      expect(f.posts).toHaveLength(0);
      expect(r.out).toContain(
        `oom re-baseline: user-${OWN}.slice (counter regression: oom_kill 32 -> 0, oom 63 -> 0)`,
      );
      // new counter era: rebaselined, dedupe stamp dropped
      const b = f.baseline();
      expect(b[String(OWN)].oom_kill).toBe(0);
      expect(b[String(OWN)].last_alert_epoch).toBeUndefined();
    } finally {
      f.close();
    }
  });

  test("slice absent (session gone) -> skipped, no post, entry kept (M2 owns the session class)", async () => {
    const f = oomFixture();
    try {
      f.seedBaseline({ [String(OWN)]: { oom_kill: 1, oom: 2 } });
      // no user-<OWN>.slice dir at all
      const r = await f.run();
      expect(r.code).toBe(0);
      expect(f.posts).toHaveLength(0);
      expect(r.out).not.toContain("OOM user-");
      const b = f.baseline();
      expect(b[String(OWN)].oom_kill).toBe(1);
      expect(b[String(OWN)].oom).toBe(2);
    } finally {
      f.close();
    }
  });

  test("fleet-agents roster: a peer slice's OOM posts to the box operator webhook (webhook column is M2's)", async () => {
    const f = oomFixture();
    try {
      f.fleet([
        "# hydrogen fleet",
        `${PEER} https://hook.example/peer`,
        "garbage line",
        `${OWN} https://hook.example/self`,
      ]);
      f.seedBaseline({
        [String(OWN)]: { oom_kill: 0, oom: 0 },
        [String(PEER)]: { oom_kill: 0, oom: 0 },
      });
      f.events(OWN, { oom: 0, oom_kill: 0 });
      f.events(PEER, { oom: 9, oom_kill: 4 });
      f.setMax(PEER, "max"); // uncapped slice passes through as "max"
      f.setPeak(PEER, "1073741824");
      const r = await f.run();
      expect(r.code).toBe(0);
      expect(f.posts).toHaveLength(1); // only the peer's delta
      const em = f.posts[0].embeds[0];
      expect(em.title).toBe(`OOM-ALERT \u00b7 user-${PEER}.slice`);
      const lines = codeLines(em);
      expect(lines).toContain(`\u251c max    : max`);
      expect(lines).toContain(`\u251c peak   : 1073741824 (1.0G)`);
      // peer advanced; the quiet own uid is untouched
      expect(f.baseline()[String(PEER)].oom_kill).toBe(4);
      expect(f.baseline()[String(OWN)].last_alert_epoch).toBeUndefined();
      expect(r.out).toContain(`flagged 1 agent OOM finding(s)`);
    } finally {
      f.close();
    }
  });

  test("--dry-run: no post, no baseline write (first sight AND delta)", async () => {
    const f = oomFixture();
    try {
      // first sight
      f.events(OWN, { oom: 6, oom_kill: 3 });
      const r1 = await f.run(["--dry-run"]);
      expect(r1.code).toBe(0);
      expect(f.posts).toHaveLength(0);
      expect(r1.out).toContain(
        `dry-run: would baseline user-${OWN}.slice (oom_kill=3 oom=6)`,
      );
      expect(fs.existsSync(f.baselineFile)).toBe(false);
      // delta
      f.seedBaseline({ [String(OWN)]: { oom_kill: 0, oom: 0 } });
      const r2 = await f.run(["--dry-run"]);
      expect(r2.code).toBe(0);
      expect(f.posts).toHaveLength(0);
      expect(r2.out).toContain(
        `dry-run: would post OOM-ALERT user-${OWN}.slice (oom_kill +3, 3 total)`,
      );
      expect(f.baseline()[String(OWN)].oom_kill).toBe(0); // untouched
    } finally {
      f.close();
    }
  });

  test("--quiet: detect + log, no post, no baseline advance (the delta survives to the next non-quiet sweep)", async () => {
    const f = oomFixture();
    try {
      f.seedBaseline({ [String(OWN)]: { oom_kill: 0, oom: 0 } });
      f.events(OWN, { oom: 4, oom_kill: 2 });
      const r1 = await f.run(["--quiet"]);
      expect(r1.code).toBe(0);
      expect(f.posts).toHaveLength(0);
      expect(r1.out).toContain(
        `quiet: OOM user-${OWN}.slice oom_kill +2 not posted (no baseline advance)`,
      );
      expect(f.baseline()[String(OWN)].oom_kill).toBe(0);
      const r2 = await f.run();
      expect(r2.code).toBe(0);
      expect(f.posts).toHaveLength(1); // the delta survived the quiet run
      expect(f.posts[0].content).toContain(
        "oom_kill +2 (2 total since baseline 0)",
      );
    } finally {
      f.close();
    }
  });

  test("no webhook configured: detection only, exit 0, no baseline advance", async () => {
    const f = oomFixture();
    try {
      f.seedBaseline({ [String(OWN)]: { oom_kill: 0, oom: 0 } });
      f.events(OWN, { oom: 2, oom_kill: 1 });
      const r = await f.run([], { PI_DISPATCH_WEBHOOK: "" });
      expect(r.code).toBe(0);
      expect(f.posts).toHaveLength(0);
      expect(r.out).toContain(
        `oom user-${OWN}.slice: oom_kill +1 - no webhook configured (no baseline advance)`,
      );
      expect(f.baseline()[String(OWN)].oom_kill).toBe(0);
    } finally {
      f.close();
    }
  });

  test("clean env: the OOM sweep fires with a REPLACED env (no harness PI_* needed)", async () => {
    const f = oomFixture();
    try {
      // failing control for the var wiring: a DIFFERENT rec dir than the
      // fixture default. If PI_DISPATCH_RECORD_DIR did not reach the
      // sweep, the baseline would land at the default
      // $HOME/.pi-dispatch/runs and this assertion goes red.
      const recDir = path.join(f.tmp, "recdir-envi");
      fs.mkdirSync(recDir, { recursive: true });
      fs.writeFileSync(
        path.join(recDir, "oom-baseline.json"),
        JSON.stringify({ [String(OWN)]: { oom_kill: 0, oom: 0 } }),
      );
      f.events(OWN, { oom: 2, oom_kill: 1 });
      f.setMax(OWN, "25769803776");
      f.setPeak(OWN, "17325654016");
      // env -i: the sweep's env is EXACTLY this list - no PI_* from the
      // bun test process, no ambient state. (Bun.spawn with the env var
      // list replaces the child's env, same contract as `env -i`.)
      // Awaited, not execSync: the webhook POST lands on THIS process's
      // fixture server, which must keep running its event loop.
      const child = Bun.spawn(
        [
          "env",
          "-i",
          `HOME=${f.home}`,
          `PATH=/usr/local/bin:/usr/bin:/bin`,
          `PI_BG_WT_DIR=${f.env.PI_BG_WT_DIR}`,
          `PI_BG_TMPDIR=${f.env.PI_BG_TMPDIR}`,
          `PI_BG_CG_ROOT=${f.env.PI_BG_CG_ROOT}`,
          `PI_BG_OOM_ROOT=${f.oomRoot}`,
          `PI_DISPATCH_RECORD_DIR=${recDir}`,
          `PI_DISPATCH_WEBHOOK=${f.env.PI_DISPATCH_WEBHOOK}`,
          "bash",
          WD,
        ],
        { env: {}, stdout: "pipe", stderr: "pipe" },
      );
      const out = await new Response(child.stdout).text();
      // bun 1.4: `exited` is the promise; `exit` is not a property
      const exitCode = await child.exited;
      expect(exitCode).toBe(0);
      expect(out).toContain(
        `OOM user-${OWN}.slice: oom_kill +1 (1 total, base 0), oom +2 (2 total)`,
      );
      // the post reached the fixture capture server
      expect(f.posts).toHaveLength(1);
      expect(f.posts[0].content).toContain(
        `[bg: agent-watch] OOM: user-${OWN}.slice oom_kill +1`,
      );
      // and the baseline advanced AT THE PASSED rec dir
      const b = JSON.parse(
        fs.readFileSync(path.join(recDir, "oom-baseline.json"), "utf8"),
      );
      expect(b[String(OWN)].oom_kill).toBe(1);
      expect(b[String(OWN)].last_alert_epoch).toBeGreaterThan(0);
      // the fixture-default rec dir was never written
      expect(fs.existsSync(path.join(f.recDir, "oom-baseline.json"))).toBe(
        false,
      );
    } finally {
      f.close();
    }
  });

  // INTEGRATION PROBE (the one allowed real-cgroup read in the suite):
  // point the section at THIS box's real cgroup root, baseline frank's own
  // slice, and prove the parse against reality. First-sight path only:
  // the baseline lands in the fixture's fake rec dir, nothing real is
  // written, and the counters are re-read after the sweep to prove no
  // mutation. Skips where the runner's own user slice has no memory.events
  // (no cgroup v2 user session).
  const REAL_ROOT = "/sys/fs/cgroup/user.slice";
  const realEvents = path.join(REAL_ROOT, `user-${OWN}.slice`, "memory.events");
  const parseReal = (p: string): OomEntry => {
    const txt = fs.readFileSync(p, "utf8");
    const oom = /(^|\n)oom (\d+)/.exec(txt)?.[2];
    const oom_kill = /(^|\n)oom_kill (\d+)/.exec(txt)?.[2];
    if (!oom || !oom_kill)
      throw new Error(`unparseable real memory.events: ${p}`);
    return { oom: Number(oom), oom_kill: Number(oom_kill) };
  };

  test("probe (this box): parses the real own-slice counters, baselines them quietly, posts nothing", async () => {
    if (!fs.existsSync(realEvents)) {
      console.log(
        "[skip] no own user-slice memory.events on this box (probe no-op)",
      );
      return;
    }
    const f = oomFixture();
    try {
      const ref = parseReal(realEvents); // pre-read (parse reference)
      f.env.PI_BG_OOM_ROOT = REAL_ROOT; // the one real read in the suite
      const r = await f.run();
      expect(r.code).toBe(0);
      expect(f.posts).toHaveLength(0); // first sight = quiet baseline
      expect(r.out).toContain(
        `oom baseline: user-${OWN}.slice (oom_kill=${ref.oom_kill} oom=${ref.oom})`,
      );
      const b = f.baseline();
      expect(b[String(OWN)].oom_kill).toBe(ref.oom_kill);
      expect(b[String(OWN)].oom).toBe(ref.oom);
      // read-only: the real counters are unchanged after the sweep
      expect(parseReal(realEvents)).toEqual(ref);
    } finally {
      f.close();
    }
  });
});

// ────────────────────────────────────────────────────────────────────────────
// #191 M2: agent liveness (marker sweep). Each agent's bridge touches
// $PI_BG_LIVE_ROOT/<uid> (0644 file in a sticky 1777 dir; real default
// /var/tmp/jarate-live) every poll cycle + at session start. The sweep
// checks the roster (own uid + ~/.config/jarate/fleet-agents, the same
// file as M1 - but M2 uses the webhook column: the per-agent wake) for
// FRESH (marker within PI_BG_LIVE_STALE_MIN, default 15 -> ok) / BOOT-GAP
// (marker predates kernel btime AND boot younger than the limit -> no
// alert; an OLD boot with a still-pre-boot marker escalates like stale -
// "agent never came up after reboot") / SILENT (marker stale, or gone
// after having been seen -> WARN post on the ok->silent transition, one
// per episode) / AGENT-DEAD (two consecutive stale sweeps -> ALERT post;
// the user@<uid>.service cgroup (M1 PI_BG_OOM_ROOT seam) empty/gone adds
// the "session gone" class) / NEVER-SEEN (no marker ever observed -> WARN
// only, never dead: the fleet deploy window). State:
// $rec_dir/live-state.json (same write discipline as oom-baseline.json:
// state + the dedupe stamp advance ONLY after a successful operator post;
// dead webhook -> same class re-posts next sweep). Max 1 ALERT per uid
// per PI_BG_LIVE_DEDUPE_MIN (60, 0 = off); the window spans episodes.
// Wake: operator webhook + the roster's per-agent webhook; content prefix
// [bg: agent-watch]. Test seams: PI_BG_LIVE_ROOT (fake marker dir),
// PI_BG_LIVE_BTIME_FILE (fake btime file).
// ────────────────────────────────────────────────────────────────────────────
describe("#191 M2: agent liveness (marker sweep)", () => {
  const OWN = os.userInfo().uid;
  const PEER = OWN === 1003 ? 1004 : 1003; // fleet-roster uid (fake marker)
  const NOW = () => Math.floor(Date.now() / 1000);

  type LiveEntry = {
    state: "ok" | "silent" | "dead";
    marker_seen?: boolean;
    mtime?: number;
    last_alert_epoch?: number;
    at?: string;
  };

  /** Base fixture + marker/session/btime helpers on the fake live root. */
  const liveFixture = () => {
    const f = fixture();
    const liveRoot = path.join(f.tmp, "live");
    const oomRoot = f.env.PI_BG_OOM_ROOT as string;
    const recDir = f.env.PI_DISPATCH_RECORD_DIR as string;
    fs.mkdirSync(liveRoot, { recursive: true, mode: 0o1777 });
    const btimeFile = path.join(f.tmp, "btime");
    // boot 1h ago by default: BOOT-GAP requires an explicit recent boot
    fs.writeFileSync(
      btimeFile,
      `btime ${NOW() - 3600}\ncpu  1 0 1 0 0 0 0 0 0 0\n`,
    );
    f.env.PI_BG_LIVE_ROOT = liveRoot;
    f.env.PI_BG_LIVE_BTIME_FILE = btimeFile;
    // no drift post under the liveness tests (same as M1): bless the
    // fixture AGENTS.md
    fs.writeFileSync(
      f.manifest(),
      `${f.sha("# law v1\n")} 2026-10-07T00:00:00Z  #191 M2 live test\n`,
    );
    // the roster's per-agent own hook: a second capture server
    const peerPosts: Post[] = [];
    const peerServer = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: async (req) => {
        if (req.method === "POST") peerPosts.push((await req.json()) as Post);
        return new Response("ok", { status: 200 });
      },
    });
    const markerPath = (uid: number) => path.join(liveRoot, String(uid));
    const marker = (uid: number, ageMin: number) => {
      const p = markerPath(uid);
      fs.writeFileSync(p, `${Date.now()}\n`);
      const t = NOW() - ageMin * 60;
      fs.utimesSync(p, t, t);
      return p;
    };
    const stateFile = path.join(recDir, "live-state.json");
    const seedState = (entries: Record<string, LiveEntry>) => {
      fs.mkdirSync(recDir, { recursive: true });
      fs.writeFileSync(stateFile, JSON.stringify(entries, null, 2));
    };
    const state = (): Record<string, LiveEntry> =>
      JSON.parse(fs.readFileSync(stateFile, "utf8"));
    // the session class: the user@<uid>.service cgroup under the M1 OOM
    // root seam (cg_has_members reads the plain cgroup.procs file)
    const session = (uid: number, pids: number[] = [4242]) => {
      const d = path.join(oomRoot, `user-${uid}.slice`, `user@${uid}.service`);
      fs.mkdirSync(d, { recursive: true });
      fs.writeFileSync(
        path.join(d, "cgroup.procs"),
        pids.map(String).join("\n") + (pids.length > 0 ? "\n" : ""),
      );
    };
    return {
      ...f,
      liveRoot,
      oomRoot,
      recDir,
      btimeFile,
      setBtime: (epoch: number) =>
        fs.writeFileSync(
          btimeFile,
          `btime ${epoch}\ncpu  1 0 1 0 0 0 0 0 0 0\n`,
        ),
      peerPosts,
      peerUrl: `http://127.0.0.1:${peerServer.port}/peer`,
      markerPath,
      marker,
      stateFile,
      seedState,
      state,
      session,
      fleet: (lines: string[]) => {
        const d = path.join(f.home, ".config", "jarate");
        fs.mkdirSync(d, { recursive: true });
        fs.writeFileSync(path.join(d, "fleet-agents"), `${lines.join("\n")}\n`);
      },
      close: () => {
        peerServer.stop(true);
        f.close();
      },
    };
  };

  test("FRESH: marker within the limit -> state ok, no post, no state churn on re-sweep", async () => {
    const f = liveFixture();
    try {
      f.marker(OWN, 1);
      const r = await f.run();
      expect(r.code).toBe(0);
      expect(f.posts).toHaveLength(0);
      const s = f.state();
      expect(s[String(OWN)].state).toBe("ok");
      expect(s[String(OWN)].marker_seen).toBe(true);
      expect(s[String(OWN)].mtime).toBeGreaterThan(NOW() - 125);
      const m1 = s[String(OWN)].mtime as number;
      const r2 = await f.run();
      expect(f.posts).toHaveLength(0);
      expect(f.state()[String(OWN)].mtime).toBe(m1); // no churn
      void r2;
    } finally {
      f.close();
    }
  });

  test("first sight with no marker: recorded, no alert", async () => {
    const f = liveFixture();
    try {
      const r = await f.run();
      expect(r.code).toBe(0);
      expect(f.posts).toHaveLength(0);
      expect(r.out).toContain(
        `live: user-${OWN} no marker (first sight, no alert)`,
      );
      const s = f.state();
      expect(s[String(OWN)].state).toBe("ok");
      expect(s[String(OWN)].marker_seen).toBe(false);
      expect(s[String(OWN)].mtime).toBeUndefined();
    } finally {
      f.close();
    }
  });

  test("stale sweep 1: SILENT WARN post (orange near-miss), state silent, summary counts", async () => {
    const f = liveFixture();
    try {
      f.marker(OWN, 20);
      const r = await f.run();
      expect(r.code).toBe(0);
      expect(f.posts).toHaveLength(1);
      const body = f.posts[0];
      // the content prefix is the webhook wake marker (isBgWebhook)
      expect(body.content).toBe(
        `[bg: agent-watch] SILENT: user-${OWN} 20m stale (limit 15m)`,
      );
      const em = body.embeds[0];
      expect(em.title).toBe(`SILENT \u00b7 user-${OWN}`);
      expect(em.author?.name).toBe("pi-bg watchdog");
      expect(em.color).toBe(15105570); // orange: near-miss, not the page
      expect(em.footer?.text).toBe("pi-bg watchdog (live, issue #191)");
      const lines = codeLines(em);
      for (const want of [
        `\u250c silent \u00b7 user-${OWN}`,
        `\u251c $ jarate-bg-watchdog live`,
        `\u251c uid    : ${OWN}`,
        `\u251c age    : 20m stale (limit 15m)`,
        `\u251c note   : marker stale`,
        `\u251c session: gone`,
      ]) {
        expect(lines).toContain(want);
      }
      // the frame obeys the 40-col mobile budget (docs/STYLE.md 2.3)
      for (const l of lines) expect(l.length).toBeLessThanOrEqual(40);
      const s = f.state();
      expect(s[String(OWN)].state).toBe("silent");
      expect(s[String(OWN)].marker_seen).toBe(true);
      expect(s[String(OWN)].mtime).toBeGreaterThan(NOW() - 1205);
      // the sweep summary line carries the live counters (shims contract)
      expect(r.out).toContain("1 agent SILENT(s)");
      expect(r.out).toContain("live_stale_min=15 live_dedupe_min=60");
    } finally {
      f.close();
    }
  });

  test("stale sweep 2: AGENT-DEAD ALERT (red) + dedupe stamp; sweep 3: still dead (no post, no stamp churn)", async () => {
    const f = liveFixture();
    try {
      f.marker(OWN, 20);
      f.seedState({
        [String(OWN)]: {
          state: "silent",
          marker_seen: true,
          mtime: NOW() - 1200,
        },
      });
      const r1 = await f.run();
      expect(r1.code).toBe(0);
      expect(f.posts).toHaveLength(1);
      expect(f.posts[0].content).toBe(
        `[bg: agent-watch] AGENT-DEAD: user-${OWN} 20m stale (limit 15m), session gone`,
      );
      const em = f.posts[0].embeds[0];
      expect(em.title).toBe(`AGENT-DEAD \u00b7 user-${OWN} (session gone)`);
      expect(em.color).toBe(15158332); // red: the page
      expect(codeLines(em)).toContain(
        `\u251c note   : 2 consecutive stale sweeps`,
      );
      expect(r1.out).toContain(
        `AGENT-DEAD user-${OWN}: 20m stale (limit 15m) (session gone)`,
      );
      const s = f.state();
      expect(s[String(OWN)].state).toBe("dead");
      expect(s[String(OWN)].last_alert_epoch).toBeGreaterThanOrEqual(NOW() - 5);
      const stamp = s[String(OWN)].last_alert_epoch as number;
      // sweep 3: still stale, state dead -> no post, stamp untouched
      const r2 = await f.run();
      expect(f.posts).toHaveLength(1);
      expect(r2.out).toContain(
        `live: user-${OWN} still dead (20m stale (limit 15m))`,
      );
      expect(f.state()[String(OWN)].last_alert_epoch).toBe(stamp);
    } finally {
      f.close();
    }
  });

  test("recovery: FRESH marker after dead -> state ok, no post, dedupe stamp kept", async () => {
    const f = liveFixture();
    try {
      const stamp = NOW() - 4200;
      f.seedState({
        [String(OWN)]: {
          state: "dead",
          marker_seen: true,
          mtime: NOW() - 1200,
          last_alert_epoch: stamp,
        },
      });
      f.marker(OWN, 0); // the agent is back
      const r = await f.run();
      expect(r.code).toBe(0);
      expect(f.posts).toHaveLength(0);
      expect(r.out).toContain(
        `live: user-${OWN} recovered (marker 0m old, was dead)`,
      );
      const s = f.state();
      expect(s[String(OWN)].state).toBe("ok");
      expect(s[String(OWN)].marker_seen).toBe(true);
      expect(s[String(OWN)].last_alert_epoch).toBe(stamp); // kept: the window spans episodes
    } finally {
      f.close();
    }
  });

  test("BOOT-GAP: marker predates a recent boot -> no alert (first sight and silent state)", async () => {
    const f = liveFixture();
    try {
      f.setBtime(NOW() - 600); // boot 10m ago (< the 15m limit)
      f.marker(OWN, 60); // marker 60m old: pre-boot
      const r = await f.run();
      expect(r.code).toBe(0);
      expect(f.posts).toHaveLength(0);
      expect(r.out).toContain(
        `live: user-${OWN} marker predates boot (boot 10m old, no alert)`,
      );
      const s = f.state();
      expect(s[String(OWN)].state).toBe("ok");
      expect(s[String(OWN)].marker_seen).toBe(true);
    } finally {
      f.close();
    }
    // a SILENT-state uid under a recent boot stays silent (no alert, no reset)
    const g = liveFixture();
    try {
      g.setBtime(NOW() - 300); // boot 5m ago
      g.fleet([String(PEER)]); // roster: uid-only line (no webhook column)
      g.marker(PEER, 120);
      g.seedState({
        [String(PEER)]: {
          state: "silent",
          marker_seen: true,
          mtime: NOW() - 7200,
        },
      });
      const r = await g.run();
      expect(r.code).toBe(0);
      expect(g.posts).toHaveLength(0);
      expect(r.out).toContain(
        `live: user-${PEER} marker predates boot (boot 5m old, no alert)`,
      );
      expect(g.state()[String(PEER)].state).toBe("silent");
    } finally {
      g.close();
    }
  });

  test("BOOT-GAP aged: old boot + pre-boot marker -> escalates (SILENT then AGENT-DEAD, age = uptime)", async () => {
    const f = liveFixture();
    try {
      f.setBtime(NOW() - 3600); // boot 1h ago (> the 15m limit)
      f.marker(OWN, 120); // marker 2h old: pre-boot
      f.seedState({
        [String(OWN)]: { state: "ok", marker_seen: true, mtime: NOW() - 7200 },
      });
      await f.run();
      expect(f.posts).toHaveLength(1);
      expect(f.posts[0].content).toBe(
        `[bg: agent-watch] SILENT: user-${OWN} predates boot (up 60m)`,
      );
      expect(codeLines(f.posts[0].embeds[0])).toContain(
        `\u251c note   : agent never up after reboot`,
      );
      expect(f.state()[String(OWN)].state).toBe("silent");
      await f.run();
      expect(f.posts).toHaveLength(2);
      expect(f.posts[1].content).toBe(
        `[bg: agent-watch] AGENT-DEAD: user-${OWN} predates boot (up 60m), session gone`,
      );
      expect(f.state()[String(OWN)].state).toBe("dead");
    } finally {
      f.close();
    }
  });

  test("NEVER-SEEN: no marker ever -> WARN only, never dead (3 sweeps)", async () => {
    const f = liveFixture();
    try {
      const r1 = await f.run(); // first sight
      expect(f.posts).toHaveLength(0);
      expect(f.state()[String(OWN)].marker_seen).toBe(false);
      const r2 = await f.run(); // the WARN fires once
      expect(f.posts).toHaveLength(1);
      expect(f.posts[0].content).toBe(
        `[bg: agent-watch] SILENT: user-${OWN} no marker (never seen)`,
      );
      expect(
        codeLines(f.posts[0].embeds[0]).some((l) =>
          l.includes("\u251c note   : marker never observed"),
        ),
      ).toBe(true);
      expect(f.state()[String(OWN)].state).toBe("silent");
      expect(f.state()[String(OWN)].marker_seen).toBe(false);
      const r3 = await f.run(); // no escalation, no repeat
      expect(f.posts).toHaveLength(1);
      expect(f.state()[String(OWN)].state).toBe("silent");
      void r1;
      void r2;
      void r3;
    } finally {
      f.close();
    }
  });

  test("marker gone after sight: stale from the last-seen mtime", async () => {
    const f = liveFixture();
    try {
      f.marker(OWN, 10);
      await f.run(); // ok
      expect(f.state()[String(OWN)].state).toBe("ok");
      fs.rmSync(f.markerPath(OWN));
      f.seedState({
        [String(OWN)]: { state: "ok", marker_seen: true, mtime: NOW() - 1200 },
      });
      const r = await f.run();
      expect(r.code).toBe(0);
      expect(f.posts).toHaveLength(1);
      expect(f.posts[0].content).toBe(
        `[bg: agent-watch] SILENT: user-${OWN} gone (last seen 20m ago)`,
      );
      expect(codeLines(f.posts[0].embeds[0])).toContain(
        `\u251c note   : marker deleted after sight`,
      );
      expect(f.state()[String(OWN)].state).toBe("silent");
    } finally {
      f.close();
    }
  });

  test("AGENT-DEAD dedupe: suppressed inside the 60m window (stamp kept), fires after it elapses", async () => {
    const f = liveFixture();
    try {
      f.marker(OWN, 20);
      f.seedState({
        [String(OWN)]: {
          state: "silent",
          marker_seen: true,
          mtime: NOW() - 1200,
          last_alert_epoch: NOW() - 600,
        },
      });
      const r1 = await f.run();
      expect(f.posts).toHaveLength(0);
      expect(r1.out).toContain(
        `live: user-${OWN} AGENT-DEAD suppressed (last alert 10m ago < 60m)`,
      );
      const s = f.state();
      expect(s[String(OWN)].state).toBe("dead");
      // the OLD stamp is kept: the window is not restarted by a suppressed sweep
      expect(s[String(OWN)].last_alert_epoch).toBeGreaterThanOrEqual(
        NOW() - 605,
      );
      expect(s[String(OWN)].last_alert_epoch).toBeLessThanOrEqual(NOW() - 595);
      // the window elapsed: the same dead episode pages again
      f.seedState({
        [String(OWN)]: {
          state: "silent",
          marker_seen: true,
          mtime: NOW() - 1200,
          last_alert_epoch: NOW() - 4200,
        },
      });
      await f.run();
      expect(f.posts).toHaveLength(1);
      expect(f.posts[0].content).toContain("AGENT-DEAD");
    } finally {
      f.close();
    }
  });

  test("dead webhook: state kept, the same class re-posts after the webhook recovers (SILENT then AGENT-DEAD)", async () => {
    const f = liveFixture();
    try {
      const deadHook = "http://127.0.0.1:1/none";
      f.marker(OWN, 20);
      const r1 = await f.run([], { PI_DISPATCH_WEBHOOK: deadHook });
      expect(r1.code).toBe(0);
      expect(f.posts).toHaveLength(0);
      expect(r1.err).toContain(
        `live: user-${OWN} silent post failed - state kept, retries next sweep`,
      );
      expect(fs.existsSync(f.stateFile)).toBe(false); // no advance
      const r2 = await f.run(); // the webhook is back
      expect(f.posts).toHaveLength(1);
      expect(f.posts[0].content).toContain("SILENT");
      expect(f.state()[String(OWN)].state).toBe("silent");
      // the ALERT with a dead webhook: state stays silent (the retry case)
      const r3 = await f.run([], { PI_DISPATCH_WEBHOOK: deadHook });
      expect(f.posts).toHaveLength(1);
      expect(r3.err).toContain(
        `live: user-${OWN} dead post failed - state kept, retries next sweep`,
      );
      expect(f.state()[String(OWN)].state).toBe("silent");
      await f.run();
      expect(f.posts).toHaveLength(2);
      expect(f.posts[1].content).toContain("AGENT-DEAD");
      expect(f.state()[String(OWN)].state).toBe("dead");
      void r2;
      void r3;
    } finally {
      f.close();
    }
  }, 60_000);

  test("session class: members present -> 'session present' (no title suffix); empty cgroup -> 'session gone' + title suffix", async () => {
    const f = liveFixture();
    try {
      f.marker(OWN, 20);
      f.session(OWN, [4242]); // the user session is alive: agent-only death
      f.seedState({
        [String(OWN)]: {
          state: "silent",
          marker_seen: true,
          mtime: NOW() - 1200,
        },
      });
      const r1 = await f.run();
      expect(r1.code).toBe(0);
      expect(f.posts).toHaveLength(1);
      expect(f.posts[0].content).toBe(
        `[bg: agent-watch] AGENT-DEAD: user-${OWN} 20m stale (limit 15m)`,
      );
      expect(f.posts[0].embeds[0].title).toBe(`AGENT-DEAD \u00b7 user-${OWN}`);
      expect(codeLines(f.posts[0].embeds[0])).toContain(
        `\u251c session: present`,
      );
      expect(r1.out).toContain(
        `AGENT-DEAD user-${OWN}: 20m stale (limit 15m) (session present)`,
      );
    } finally {
      f.close();
    }
    const g = liveFixture();
    try {
      g.marker(OWN, 20);
      g.session(OWN, []); // the cgroup exists but is empty: session gone
      g.seedState({
        [String(OWN)]: {
          state: "silent",
          marker_seen: true,
          mtime: NOW() - 1200,
        },
      });
      await g.run();
      expect(g.posts).toHaveLength(1);
      expect(g.posts[0].content).toBe(
        `[bg: agent-watch] AGENT-DEAD: user-${OWN} 20m stale (limit 15m), session gone`,
      );
      expect(g.posts[0].embeds[0].title).toBe(
        `AGENT-DEAD \u00b7 user-${OWN} (session gone)`,
      );
      expect(codeLines(g.posts[0].embeds[0])).toContain(`\u251c session: gone`);
    } finally {
      g.close();
    }
  });

  test("fleet roster: the peer's marker is swept; the peer gets its own webhook copy; own stays quiet", async () => {
    const f = liveFixture();
    try {
      f.fleet([`# fleet`, `${PEER} ${f.peerUrl}`, `garbage line`]);
      f.marker(OWN, 1); // own: fresh
      f.marker(PEER, 20); // peer: stale
      const r1 = await f.run();
      expect(r1.code).toBe(0);
      expect(f.posts).toHaveLength(1); // only the peer's SILENT
      expect(f.posts[0].content).toBe(
        `[bg: agent-watch] SILENT: user-${PEER} 20m stale (limit 15m)`,
      );
      expect(f.peerPosts).toHaveLength(1); // the peer's own hook got a copy
      expect(f.peerPosts[0].content).toBe(f.posts[0].content);
      await f.run();
      expect(f.posts).toHaveLength(2);
      expect(f.posts[1].content).toContain(`AGENT-DEAD: user-${PEER}`);
      expect(f.peerPosts).toHaveLength(2);
      expect(f.peerPosts[1].content).toContain(`AGENT-DEAD: user-${PEER}`);
      // own uid: ok, no post of any kind
      expect(f.state()[String(OWN)].state).toBe("ok");
      expect(f.state()[String(PEER)].state).toBe("dead");
    } finally {
      f.close();
    }
  });

  test("roster parse: duplicate uids first-wins, bad lines skipped, a uid whose hook IS the operator hook is not double-posted", async () => {
    const f = liveFixture();
    try {
      f.fleet([
        `${PEER} ${f.env.PI_DISPATCH_WEBHOOK}`, // first: the operator hook
        `${PEER} ${f.peerUrl}`, // dup: ignored (first-wins)
        `garbage line`, // no uid
        ``,
        `# comment`,
      ]);
      f.marker(OWN, 1); // fresh: no post
      f.marker(PEER, 20);
      const r = await f.run();
      expect(r.code).toBe(0);
      expect(f.posts).toHaveLength(1); // the operator SILENT (no dup post)
      expect(f.peerPosts).toHaveLength(0); // first-wins hook == operator
      expect(f.state()[String(PEER)].state).toBe("silent");
    } finally {
      f.close();
    }
  });

  test("--dry-run: no post, no state write (first sight, SILENT, AGENT-DEAD)", async () => {
    const f = liveFixture();
    try {
      const r0 = await f.run(["--dry-run"]);
      expect(r0.out).toContain(
        `dry-run: would record live first-sight user-${OWN} (no marker, no alert)`,
      );
      expect(fs.existsSync(f.stateFile)).toBe(false);
      f.marker(OWN, 20);
      const r1 = await f.run(["--dry-run"]);
      expect(f.posts).toHaveLength(0);
      expect(r1.out).toContain(
        `dry-run: would post silent user-${OWN} (20m stale (limit 15m))`,
      );
      expect(fs.existsSync(f.stateFile)).toBe(false);
      // AGENT-DEAD dry: the seeded state is untouched
      const seeded: Record<string, LiveEntry> = {
        [String(OWN)]: {
          state: "silent",
          marker_seen: true,
          mtime: NOW() - 1200,
        },
      };
      f.seedState(seeded);
      const r2 = await f.run(["--dry-run"]);
      expect(f.posts).toHaveLength(0);
      expect(r2.out).toContain(
        `dry-run: would post dead user-${OWN} (20m stale (limit 15m))`,
      );
      expect(f.state()).toEqual(seeded);
    } finally {
      f.close();
    }
  });

  test("--quiet: detect + log, no post, no state advance (the next live run posts)", async () => {
    const f = liveFixture();
    try {
      f.marker(OWN, 20);
      const r1 = await f.run(["--quiet"]);
      expect(f.posts).toHaveLength(0);
      expect(r1.out).toContain(
        `quiet: silent user-${OWN} (20m stale (limit 15m)) not posted (no state advance)`,
      );
      expect(fs.existsSync(f.stateFile)).toBe(false);
      await f.run();
      expect(f.posts).toHaveLength(1); // not advanced -> ok -> silent
      expect(f.posts[0].content).toContain("SILENT");
    } finally {
      f.close();
    }
  });

  test("no operator webhook: detect + log only, no state advance", async () => {
    const f = liveFixture();
    try {
      f.marker(OWN, 20);
      const r = await f.run([], { PI_DISPATCH_WEBHOOK: "" });
      expect(r.code).toBe(0);
      expect(f.posts).toHaveLength(0);
      expect(r.out).toContain(
        `live: user-${OWN} silent - no webhook configured (no state advance)`,
      );
      expect(fs.existsSync(f.stateFile)).toBe(false);
    } finally {
      f.close();
    }
  });

  test("clean env (env -i): PI_BG_LIVE_ROOT + PI_BG_LIVE_BTIME_FILE + PI_DISPATCH_RECORD_DIR wiring", async () => {
    const f = liveFixture();
    try {
      // failing control for the var wiring: a DIFFERENT rec dir than the
      // fixture default. If PI_DISPATCH_RECORD_DIR did not reach the
      // sweep, the state would land at the default
      // $HOME/.pi-dispatch/runs and this assertion goes red.
      const recDir2 = path.join(f.tmp, "recdir-live");
      fs.mkdirSync(recDir2, { recursive: true });
      f.session(OWN, [4242]);
      f.marker(OWN, 20);
      fs.writeFileSync(
        path.join(recDir2, "live-state.json"),
        JSON.stringify(
          {
            [String(OWN)]: {
              state: "silent",
              marker_seen: true,
              mtime: NOW() - 1200,
            },
          },
          null,
          2,
        ),
      );
      const child = Bun.spawn(
        [
          "env",
          "-i",
          `HOME=${f.home}`,
          `PATH=/usr/local/bin:/usr/bin:/bin`,
          `PI_BG_WT_DIR=${f.env.PI_BG_WT_DIR}`,
          `PI_BG_TMPDIR=${f.env.PI_BG_TMPDIR}`,
          `PI_BG_CG_ROOT=${f.env.PI_BG_CG_ROOT}`,
          `PI_BG_OOM_ROOT=${f.oomRoot}`,
          `PI_BG_LIVE_ROOT=${f.liveRoot}`,
          `PI_BG_LIVE_BTIME_FILE=${f.btimeFile}`,
          `PI_DISPATCH_RECORD_DIR=${recDir2}`,
          `PI_DISPATCH_WEBHOOK=${f.env.PI_DISPATCH_WEBHOOK}`,
          "bash",
          WD,
        ],
        { env: {}, stdout: "pipe", stderr: "pipe" },
      );
      const out = await new Response(child.stdout).text();
      const exitCode = await child.exited;
      expect(exitCode).toBe(0);
      expect(f.posts).toHaveLength(1);
      expect(f.posts[0].content).toBe(
        `[bg: agent-watch] AGENT-DEAD: user-${OWN} 20m stale (limit 15m)`,
      );
      expect(codeLines(f.posts[0].embeds[0])).toContain(
        `\u251c session: present`,
      );
      // the state advanced AT THE PASSED rec dir
      const s2 = JSON.parse(
        fs.readFileSync(path.join(recDir2, "live-state.json"), "utf8"),
      ) as Record<string, LiveEntry>;
      expect(s2[String(OWN)].state).toBe("dead");
      expect(s2[String(OWN)].last_alert_epoch).toBeGreaterThanOrEqual(
        NOW() - 5,
      );
      // the fixture-default rec dir was never written
      expect(fs.existsSync(f.stateFile)).toBe(false);
      void out;
    } finally {
      f.close();
    }
  });
});
