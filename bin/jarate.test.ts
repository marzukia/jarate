/**
 * bin/jarate — JSON entrypoint contract tests (issue #17).
 *
 * Runs the real bash entrypoint against a fake HOME with stubbed externals
 * (pi-token-cost.py, journalctl, sshpass, recall CLI) and asserts the JSON
 * discipline: exactly one doc on stdout, ok:true|false + error, stable
 * snake_case keys, no partial output.
 */
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "bun";

const JARATE = path.join(import.meta.dir, "jarate");

type RunResult = { code: number; out: string; err: string };

interface Fixture {
  tmp: string;
  home: string;
  bin: string;
  env: Record<string, string>;
  run: (
    args: string[],
    overrides?: Record<string, string>,
  ) => Promise<RunResult>;
}

function fixture(): Fixture {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jarate-test-"));
  const home = path.join(tmp, "home");
  const bin = path.join(tmp, "bin");
  const peerHome = path.join(tmp, "peer-home");
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(bin, { recursive: true });
  fs.mkdirSync(peerHome, { recursive: true });

  // stub journalctl: two warning lines
  const jc = path.join(bin, "journalctl");
  fs.writeFileSync(
    jc,
    "#!/bin/sh\necho 'W1 first warn'\necho 'W2 second warn'\n",
  );
  fs.chmodSync(jc, 0o755);

  // stub sshpass: prints the pi-agent marker + one peer warning
  const sp = path.join(bin, "sshpass");
  fs.writeFileSync(sp, "#!/bin/sh\necho '[jarate:pi]'\necho 'P1 peer warn'\n");
  fs.chmodSync(sp, 0o755);

  // stub pi-token-cost.py (python3 -r JSON)
  const ptc = path.join(home, "scripts", "pi-token-cost.py");
  fs.mkdirSync(path.dirname(ptc), { recursive: true });
  fs.writeFileSync(
    ptc,
    `#!/usr/bin/env python3
import json
print(json.dumps({"model": "m/test", "openrouter_pricing": {}, "agents": [{"home": "h", "stats": {"files": 1, "turns": 5, "input": 100, "output": 10, "cacheRead": 50, "cacheWrite": 1, "totalTokens": 161}, "pricing": {"cost": 0.1234}}]}))
`,
  );

  // session jsonl: one user turn, one assistant turn with usage
  const sessDir = path.join(home, ".pi", "agent", "sessions", "--cwd--");
  fs.mkdirSync(sessDir, { recursive: true });
  const userTurn = {
    type: "message",
    id: "t0",
    message: { role: "user", content: "hi" },
  };
  const asstTurn = {
    type: "message",
    id: "t1",
    message: {
      role: "assistant",
      usage: {
        input: 200_000,
        output: 1_000,
        cacheRead: 50_000,
        totalTokens: 251_000,
      },
    },
  };
  fs.writeFileSync(
    path.join(sessDir, "s1.jsonl"),
    `${JSON.stringify(userTurn)}\n${JSON.stringify(asstTurn)}\n`,
  );
  // dead session: must be skipped by the newest-session scan
  fs.writeFileSync(path.join(sessDir, "s0.jsonl.reset-1"), "{}\n");

  // models.json with the switchboard context limit header
  const agentDir = path.join(home, ".pi", "agent");
  fs.writeFileSync(
    path.join(agentDir, "models.json"),
    JSON.stringify({
      providers: {
        hydrogen: { headers: { "X-Switchboard-Context": "262144" } },
      },
    }),
  );

  // memory
  const mem = path.join(home, "memory");
  fs.mkdirSync(mem, { recursive: true });
  fs.writeFileSync(
    path.join(mem, "2026-01-01-a.md"),
    "# a\nneedle in a\nline two\n",
  );
  fs.writeFileSync(path.join(mem, "2026-01-02-b.md"), "# b\nNEEDLE in b\n");
  // regex chars: prove fixed-string default (dot/paren are literal)
  fs.writeFileSync(
    path.join(mem, "2026-01-05-regex.md"),
    [
      "# regex chars",
      "literal a.b line",
      "regex axb line",
      "a (unterminated paren",
      "-1h window note",
      "",
    ].join("\n"),
  );

  // stub recall CLI: one result, echoes RAG_PROJECT into source.
  // NOTE: bun pre-parses shebang'd scripts as JS (">&2" breaks), so the stub
  // is plain JS, not sh.
  const recallStub = path.join(tmp, "recall-stub.js");
  fs.writeFileSync(
    recallStub,
    [
      "process.stdout.write(JSON.stringify([{",
      '  source: "src:" + (process.env.RAG_PROJECT ?? ""),',
      '  content: "chunk",',
      "  score: 0.5,",
      "}]));",
      "",
    ].join("\n"),
  );

  const env = { ...process.env } as Record<string, string>;
  env.HOME = home;
  env.PATH = `${bin}:${env.PATH ?? ""}`;
  env.XDG_RUNTIME_DIR = path.join(tmp, "xdg");
  env.JARATE_AGENT_HOMES = `${home}:${peerHome}`;
  // peer hop stub: run_remote_probe needs a sudo password before it even
  // execs sshpass (2026-09-14: fixture was missing this -> red on main)
  env.JARATE_SUDO_PASS = "test-pass";
  env.JARATE_RECALL_CLI = recallStub;
  fs.mkdirSync(env.XDG_RUNTIME_DIR, { recursive: true });

  const run = async (
    args: string[],
    overrides?: Record<string, string>,
  ): Promise<RunResult> => {
    const p = spawn(["bash", JARATE, ...args], {
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

  return { tmp, home, bin, env, run };
}

const doc = (r: RunResult) => JSON.parse(r.out);

describe("entrypoint", () => {
  test("no args -> help doc with the full command list", async () => {
    const f = fixture();
    const r = await f.run([]);
    const d = doc(r);
    expect(d.ok).toBe(true);
    expect(d.error).toBeNull();
    expect(Object.keys(d)).toEqual(["ok", "ts", "error", "usage", "commands"]);
    expect(d.usage).toBe("jarate <cmd> [args]");
    expect(d.commands).toEqual([
      "setup",
      "ctx-report",
      "journal-errors",
      "memory-grep",
      "rag",
      "projects",
      "projects-backfill",
      "agents-check",
      "agents-bless",
    ]);
    fs.rmSync(f.tmp, { recursive: true, force: true });
  });

  test("unknown command -> ok:false + commands list, rc 2", async () => {
    const f = fixture();
    const r = await f.run(["bogus"]);
    expect(r.code).toBe(2);
    const d = doc(r);
    expect(d.ok).toBe(false);
    expect(d.error).toBe("unknown command: bogus");
    expect(d.commands).toContain("rag");
    fs.rmSync(f.tmp, { recursive: true, force: true });
  });

  test("pre-joined args string and split args both work", async () => {
    const f = fixture();
    const joined = await f.run(["memory-grep", "needle in"]);
    const split = await f.run(["memory-grep", "needle", "in"]);
    expect(doc(joined).count).toBe(doc(split).count);
    expect(doc(joined).count).toBeGreaterThan(0);
    fs.rmSync(f.tmp, { recursive: true, force: true });
  });
});

describe("ctx-report", () => {
  test("context % + cost from the stubbed sources", async () => {
    const f = fixture();
    const r = await f.run(["ctx-report"]);
    expect(r.code).toBe(0);
    const d = doc(r);
    expect(d.ok).toBe(true);
    expect(d.error).toBeNull();
    expect(d.cost_error).toBeNull();
    expect(d.profile).toBe("main");
    // newest session = s1.jsonl (the .reset- file must not win)
    expect(d.context.session.endsWith("s1.jsonl")).toBe(true);
    expect(d.context.tokens).toBe(251_000);
    expect(d.context.limit).toBe(262_144);
    expect(d.context.pct).toBe(95); // floor(251000*100/262144) = 95
    expect(d.context.compact_recommended).toBe(true);
    // cost from the pi-token-cost stub
    expect(d.cost.model).toBe("m/test");
    expect(d.cost.turns).toBe(5);
    expect(d.cost.cache_read).toBe(50);
    expect(d.cost.usd).toBe(0.1234);
    fs.rmSync(f.tmp, { recursive: true, force: true });
  });

  test("cost source failing -> cost null + cost_error, still ok:true", async () => {
    const f = fixture();
    const r = await f.run(["ctx-report"], {
      JARATE_TOKEN_COST: path.join(f.tmp, "nope.py"),
    });
    const d = doc(r);
    expect(d.ok).toBe(true);
    expect(d.cost).toBeNull();
    expect(d.cost_error).toContain("not found");
    expect(d.context.tokens).toBe(251_000);
    fs.rmSync(f.tmp, { recursive: true, force: true });
  });

  test("no sessions AND no cost -> ok:false + error", async () => {
    const f = fixture();
    const emptyHome = path.join(f.tmp, "empty-home");
    fs.mkdirSync(emptyHome, { recursive: true });
    const r = await f.run(["ctx-report"], {
      HOME: emptyHome,
      JARATE_TOKEN_COST: path.join(f.tmp, "nope.py"),
    });
    expect(r.code).toBe(1);
    const d = doc(r);
    expect(d.ok).toBe(false);
    expect(d.error).toContain("no context or cost data");
    expect(d.context).toBeNull();
    expect(d.cost).toBeNull();
    fs.rmSync(f.tmp, { recursive: true, force: true });
  });

  test("unknown profile -> ok:false usage error, rc 2", async () => {
    const f = fixture();
    const r = await f.run(["ctx-report", "--profile", "bogus"]);
    expect(r.code).toBe(2);
    const d = doc(r);
    expect(d.ok).toBe(false);
    expect(d.error).toContain("profile must be main or worker");
    fs.rmSync(f.tmp, { recursive: true, force: true });
  });

  test("missing flag value -> JSON error doc, empty stderr, rc 2", async () => {
    const f = fixture();
    const cases: Array<[string[], string]> = [
      [["ctx-report", "--profile"], "--profile needs a value"],
      [["journal-errors", "--since"], "--since needs a value"],
      [["journal-errors", "--agent"], "--agent needs a value"],
      [["memory-grep", "q", "--root"], "--root needs a value"],
      [["rag", "q", "--project"], "--project needs a value"],
      [["projects", "--project"], "--project needs a value"],
      [["projects", "--since"], "--since needs a value"],
      [["projects", "--agent"], "--agent needs a value"],
      [["projects-backfill", "--agent"], "--agent needs a value"],
      [["projects-backfill", "--set"], "--set needs a value"],
    ];
    for (const [args, msg] of cases) {
      const r = await f.run(args);
      expect(r.code).toBe(2);
      expect(r.err).toBe("");
      const d = doc(r);
      expect(d.ok).toBe(false);
      expect(d.error).toContain(msg);
    }
    fs.rmSync(f.tmp, { recursive: true, force: true });
  });

  test("session usage python is timeout-bounded", async () => {
    const f = fixture();
    const slowPy = path.join(f.tmp, "slow-py-bin");
    fs.mkdirSync(slowPy, { recursive: true });
    fs.writeFileSync(path.join(slowPy, "python3"), "#!/bin/sh\nsleep 5\n");
    fs.chmodSync(path.join(slowPy, "python3"), 0o755);
    const t0 = Date.now();
    const r = await f.run(["ctx-report"], {
      PATH: `${slowPy}:${f.env.PATH}`,
      JARATE_TIMEOUT_S: "1",
    });
    const elapsed = (Date.now() - t0) / 1000;
    const d = doc(r);
    expect(d.ok).toBe(true);
    expect(d.context.tokens).toBeNull(); // usage scan timed out
    expect(d.cost_error).toContain("timed out"); // ptc python timed out
    expect(elapsed).toBeLessThan(8);
    fs.rmSync(f.tmp, { recursive: true, force: true });
  });
});

describe("journal-errors", () => {
  test("self local + peer via ssh stub, stable row schema", async () => {
    const f = fixture();
    const r = await f.run(["journal-errors"]);
    expect(r.code).toBe(0);
    const d = doc(r);
    expect(d.ok).toBe(true);
    // default since = absolute UTC datetime, one hour back
    expect(d.since).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    expect(Object.keys(d)).toEqual(["ok", "ts", "error", "since", "agents"]);
    expect(d.agents).toHaveLength(2);
    const [self, peer] = d.agents;
    expect(self.source).toBe("local");
    expect(self.count).toBe(2);
    expect(self.warnings).toEqual(["W1 first warn", "W2 second warn"]);
    expect(self.error).toBeNull();
    expect(peer.source).toBe("ssh+sudo");
    expect(peer.count).toBe(1);
    expect(peer.warnings).toEqual(["P1 peer warn"]);
    fs.rmSync(f.tmp, { recursive: true, force: true });
  });

  test("peer hop failing -> row error, top-level ok:false naming the agent", async () => {
    const f = fixture();
    fs.writeFileSync(
      path.join(f.bin, "sshpass"),
      "#!/bin/sh\necho 'ssh: refused' >&2\nexit 255\n",
    );
    const r = await f.run(["journal-errors"]);
    expect(r.code).toBe(1);
    const d = doc(r);
    expect(d.ok).toBe(false);
    expect(d.error).toContain("peer-home");
    const peer = d.agents.find(
      (a: { name: string }) => a.source === "ssh+sudo",
    );
    expect(peer.warnings).toBeNull();
    expect(peer.error).toContain("cross-user hop failed");
    fs.rmSync(f.tmp, { recursive: true, force: true });
  });

  test("--agent filter narrows rows; no match -> ok:false", async () => {
    const f = fixture();
    const r1 = await f.run(["journal-errors", "--agent", "home"]);
    expect(doc(r1).agents).toHaveLength(1);
    const r2 = await f.run(["journal-errors", "--agent", "nosuch"]);
    const d2 = doc(r2);
    expect(d2.ok).toBe(false);
    expect(d2.error).toContain("no agents matched");
    fs.rmSync(f.tmp, { recursive: true, force: true });
  });

  test("peer without the pi marker is skipped, not errored", async () => {
    const f = fixture();
    fs.writeFileSync(
      path.join(f.bin, "sshpass"),
      "#!/bin/sh\necho 'no unit here'\n",
    );
    const r = await f.run(["journal-errors"]);
    const d = doc(r);
    expect(d.ok).toBe(true);
    expect(d.agents).toHaveLength(1);
    expect(d.agents[0].source).toBe("local");
    fs.rmSync(f.tmp, { recursive: true, force: true });
  });

  test("--since: T-form and space-form accepted, relative rejected (rc 2)", async () => {
    const f = fixture();
    const r1 = await f.run([
      "journal-errors",
      "--since",
      "2026-09-13T00:00:00Z",
      "--agent",
      "home",
    ]);
    expect(r1.code).toBe(0);
    expect(doc(r1).since).toBe("2026-09-13T00:00:00Z");
    const r2 = await f.run([
      "journal-errors",
      "--since",
      "2026-09-13",
      "00:00:00",
      "--agent",
      "home",
    ]);
    expect(r2.code).toBe(0);
    expect(doc(r2).since).toBe("2026-09-13 00:00:00");
    const r3 = await f.run([
      "journal-errors",
      "--since",
      "-1h",
      "--agent",
      "home",
    ]);
    expect(r3.code).toBe(2);
    expect(doc(r3).error).toContain("absolute datetime");
    fs.rmSync(f.tmp, { recursive: true, force: true });
  });
});

describe("memory-grep", () => {
  test("case-insensitive fixed-string search, top-20, match schema", async () => {
    const f = fixture();
    const r = await f.run(["memory-grep", "needle"]);
    const d = doc(r);
    expect(d.ok).toBe(true);
    expect(d.error).toBeNull();
    expect(Object.keys(d)).toEqual([
      "ok",
      "ts",
      "error",
      "query",
      "root",
      "count",
      "truncated",
      "matches",
    ]);
    expect(d.count).toBe(2);
    expect(d.truncated).toBe(false);
    expect(d.matches).toHaveLength(2);
    expect(d.matches[0].file).toContain("2026-01-01-a.md");
    expect(d.matches[0].line).toBe(2);
    expect(d.matches[0].text).toBe("needle in a");
    expect(d.matches[1].file).toContain("2026-01-02-b.md");
    fs.rmSync(f.tmp, { recursive: true, force: true });
  });

  test("no matches -> ok:true with empty matches", async () => {
    const f = fixture();
    const r = await f.run(["memory-grep", "zzz-not-there"]);
    const d = doc(r);
    expect(d.ok).toBe(true);
    expect(d.count).toBe(0);
    expect(d.matches).toEqual([]);
    fs.rmSync(f.tmp, { recursive: true, force: true });
  });

  test("more than 20 matches -> truncated, exactly 20 kept", async () => {
    const f = fixture();
    fs.writeFileSync(
      path.join(f.home, "memory", "2026-01-03-c.md"),
      `${Array.from({ length: 25 }, (_, i) => `x line ${i}`).join("\n")}\n`,
    );
    const r = await f.run(["memory-grep", "x line"]);
    const d = doc(r);
    expect(d.count).toBe(25);
    expect(d.truncated).toBe(true);
    expect(d.matches).toHaveLength(20);
    fs.rmSync(f.tmp, { recursive: true, force: true });
  });

  test("bad regex with --regex -> ok:false rg failed", async () => {
    const f = fixture();
    const r = await f.run(["memory-grep", "[", "--regex"]);
    const d = doc(r);
    expect(d.ok).toBe(false);
    expect(d.error).toContain("rg failed");
    fs.rmSync(f.tmp, { recursive: true, force: true });
  });

  test("default mode is fixed-string: regex chars match literally", async () => {
    const f = fixture();
    const r = await f.run(["memory-grep", "a.b"]);
    const d = doc(r);
    expect(d.ok).toBe(true);
    // only the literal "a.b" line; "axb" must NOT match (dot is not a regex)
    expect(d.count).toBe(1);
    expect(d.matches[0].text).toBe("literal a.b line");
    fs.rmSync(f.tmp, { recursive: true, force: true });
  });

  test("(unterminated is a literal match, not a regex error", async () => {
    const f = fixture();
    const r = await f.run(["memory-grep", "(unterminated"]);
    const d = doc(r);
    expect(d.ok).toBe(true);
    expect(d.count).toBe(1);
    expect(d.matches[0].text).toBe("a (unterminated paren");
    // same query with --regex is a bad regex -> ok:false
    const r2 = await f.run(["memory-grep", "(unterminated", "--regex"]);
    const d2 = doc(r2);
    expect(d2.ok).toBe(false);
    expect(d2.error).toContain("rg failed");
    fs.rmSync(f.tmp, { recursive: true, force: true });
  });

  test("two identical runs -> identical match order (deterministic)", async () => {
    const f = fixture();
    const tree = path.join(f.tmp, "tree");
    fs.mkdirSync(tree, { recursive: true });
    for (let i = 1; i <= 400; i++) {
      fs.writeFileSync(
        path.join(tree, `f${String(i).padStart(3, "0")}.md`),
        `matchline ${i}\nother\n`,
      );
    }
    const r1 = await f.run(["memory-grep", "matchline", "--root", tree]);
    const r2 = await f.run(["memory-grep", "matchline", "--root", tree]);
    expect(doc(r1).count).toBe(400);
    expect(JSON.stringify(doc(r1).matches)).toBe(
      JSON.stringify(doc(r2).matches),
    );
    fs.rmSync(f.tmp, { recursive: true, force: true });
  });

  test("rg is timeout-bounded (JARATE_TIMEOUT_S honored)", async () => {
    const f = fixture();
    const slowRg = path.join(f.tmp, "slow-rg-bin");
    fs.mkdirSync(slowRg, { recursive: true });
    fs.writeFileSync(path.join(slowRg, "rg"), "#!/bin/sh\nsleep 5\nexit 0\n");
    fs.chmodSync(path.join(slowRg, "rg"), 0o755);
    const t0 = Date.now();
    const r = await f.run(["memory-grep", "needle"], {
      PATH: `${slowRg}:${f.env.PATH}`,
      JARATE_TIMEOUT_S: "1",
    });
    const elapsed = (Date.now() - t0) / 1000;
    const d = doc(r);
    expect(d.ok).toBe(false);
    expect(d.error).toContain("timed out");
    expect(elapsed).toBeLessThan(4);
    fs.rmSync(f.tmp, { recursive: true, force: true });
  });

  test("-- terminator allows dash-leading queries", async () => {
    const f = fixture();
    const r = await f.run(["memory-grep", "--", "-1h window"]);
    const d = doc(r);
    expect(d.ok).toBe(true);
    expect(d.query).toBe("-1h window");
    expect(d.count).toBe(1);
    expect(d.matches[0].text).toBe("-1h window note");
    fs.rmSync(f.tmp, { recursive: true, force: true });
  });

  test("unknown flag / missing query / missing root -> rc 2 usage errors", async () => {
    const f = fixture();
    const r1 = await f.run(["memory-grep", "x", "-wat"]);
    expect(r1.code).toBe(2);
    expect(doc(r1).error).toContain("unknown flag");
    const r2 = await f.run(["memory-grep"]);
    expect(r2.code).toBe(2);
    expect(doc(r2).error).toContain("usage:");
    const r3 = await f.run([
      "memory-grep",
      "x",
      "--root",
      path.join(f.tmp, "nope"),
    ]);
    expect(r3.code).toBe(2);
    expect(doc(r3).error).toContain("root not found");
    fs.rmSync(f.tmp, { recursive: true, force: true });
  });
});

describe("rag", () => {
  test("wraps the recall --json array, project null by default", async () => {
    const f = fixture();
    const r = await f.run(["rag", "what", "is", "dispatch"]);
    expect(r.code).toBe(0);
    const d = doc(r);
    expect(d.ok).toBe(true);
    expect(d.error).toBeNull();
    expect(d.backend).toBe("recall");
    expect(d.question).toBe("what is dispatch");
    expect(d.project).toBeNull();
    expect(d.count).toBe(1);
    expect(d.results[0]).toEqual({
      source: "src:", // RAG_PROJECT unset
      content: "chunk",
      score: 0.5,
    });
    fs.rmSync(f.tmp, { recursive: true, force: true });
  });

  test("--project is forwarded as RAG_PROJECT", async () => {
    const f = fixture();
    const r = await f.run(["rag", "q", "--project", "jarate"]);
    const d = doc(r);
    expect(d.project).toBe("jarate");
    expect(d.results[0].source).toBe("src:jarate");
    fs.rmSync(f.tmp, { recursive: true, force: true });
  });

  test("recall failing -> ok:false with the first stderr line", async () => {
    const f = fixture();
    fs.writeFileSync(
      path.join(f.tmp, "recall-stub.js"),
      'process.stderr.write("connect ECONNREFUSED 127.0.0.1:11434\n");\nprocess.exit(1);\n',
    );
    const r = await f.run(["rag", "q"]);
    const d = doc(r);
    expect(d.ok).toBe(false);
    expect(d.error).toContain("recall query failed");
    expect(d.error).toContain("ECONNREFUSED");
    fs.rmSync(f.tmp, { recursive: true, force: true });
  });

  test("non-array recall output -> ok:false", async () => {
    const f = fixture();
    fs.writeFileSync(
      path.join(f.tmp, "recall-stub.js"),
      'process.stdout.write("no results");\n',
    );
    const r = await f.run(["rag", "q"]);
    const d = doc(r);
    expect(d.ok).toBe(false);
    expect(d.error).toContain("expected JSON array");
    fs.rmSync(f.tmp, { recursive: true, force: true });
  });

  test("stderr noise does not fail a successful query", async () => {
    const f = fixture();
    fs.writeFileSync(
      path.join(f.tmp, "recall-stub.js"),
      [
        'process.stderr.write("WARN: warmup\\n");',
        'process.stdout.write(JSON.stringify([{source: "s", content: "c", score: 0.7}]));',
        "",
      ].join("\n"),
    );
    const r = await f.run(["rag", "q"]);
    expect(r.code).toBe(0);
    const d = doc(r);
    expect(d.ok).toBe(true);
    expect(d.count).toBe(1);
    expect(d.results[0].content).toBe("c");
    fs.rmSync(f.tmp, { recursive: true, force: true });
  });

  test("missing question -> ok:false usage error, rc 2", async () => {
    const f = fixture();
    const r = await f.run(["rag"]);
    expect(r.code).toBe(2);
    const d = doc(r);
    expect(d.ok).toBe(false);
    expect(d.error).toContain("usage: jarate rag");
    fs.rmSync(f.tmp, { recursive: true, force: true });
  });

  test("JARATE_ROOT env is honored for recall CLI resolution", async () => {
    const f = fixture();
    // bun shim: command -v bun finds it, execs the real bun binary
    const bunStub = path.join(f.bin, "bun");
    fs.writeFileSync(
      bunStub,
      `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} "$@"\n`,
    );
    fs.chmodSync(bunStub, 0o755);
    const r = await f.run(["rag", "q"], {
      JARATE_RECALL_CLI: "",
      JARATE_ROOT: path.join(f.tmp, "nope"),
    });
    expect(r.code).toBe(1);
    expect(doc(r).error).toContain("recall CLI not found");
    fs.rmSync(f.tmp, { recursive: true, force: true });
  });
});

describe("agents-check / agents-bless", () => {
  // AGENTS.md is prompt-level law; the manifest makes the approval rule
  // mechanical. Manifest format: <sha256>  <UTC ts>  <note> (one line).
  const sha = (s: string) => createHash("sha256").update(s).digest("hex");
  const AGENTS = (f: Fixture) => path.join(f.home, ".pi", "agent", "AGENTS.md");
  const MANIFEST = (f: Fixture) =>
    path.join(f.home, ".pi", "agent", ".agents-md-hash");

  test("no manifest -> ok:true, drift:true, expected null", async () => {
    const f = fixture();
    fs.writeFileSync(AGENTS(f), "# law v1\n");
    const r = await f.run(["agents-check"]);
    expect(r.code).toBe(0);
    expect(r.err).toBe("");
    const d = doc(r);
    expect(d.ok).toBe(true);
    expect(d.error).toBeNull();
    expect(Object.keys(d)).toEqual([
      "ok",
      "ts",
      "error",
      "hash",
      "expected",
      "drift",
    ]);
    expect(d.hash).toBe(sha("# law v1\n"));
    expect(d.expected).toBeNull();
    expect(d.drift).toBe(true);
    fs.rmSync(f.tmp, { recursive: true, force: true });
  });

  test("bless writes one-line manifest; check -> drift:false", async () => {
    const f = fixture();
    fs.writeFileSync(AGENTS(f), "# law v1\n");
    const r = await f.run(["agents-bless", "blessed by andryo"]);
    expect(r.code).toBe(0);
    const d = doc(r);
    expect(d.ok).toBe(true);
    expect(d.error).toBeNull();
    expect(d.hash).toBe(sha("# law v1\n"));
    expect(d.note).toBe("blessed by andryo");
    // manifest: exactly one line, <sha256>  <ts>  <note>
    const lines = fs.readFileSync(MANIFEST(f), "utf8").split("\n");
    expect(lines).toHaveLength(2); // trailing newline -> last element ""
    const [mh, mts, ...mnote] = lines[0].split("  ");
    expect(mh).toBe(sha("# law v1\n"));
    expect(mts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    expect(mnote.join("  ")).toBe("blessed by andryo");
    const r2 = await f.run(["agents-check"]);
    const d2 = doc(r2);
    expect(d2.drift).toBe(false);
    expect(d2.expected).toBe(sha("# law v1\n"));
    fs.rmSync(f.tmp, { recursive: true, force: true });
  });

  test("edit -> drift:true (expected = old hash); re-bless -> drift:false", async () => {
    const f = fixture();
    fs.writeFileSync(AGENTS(f), "# law v1\n");
    await f.run(["agents-bless", "v1"]);
    fs.appendFileSync(AGENTS(f), "# amendment\n");
    const r = await f.run(["agents-check"]);
    const d = doc(r);
    expect(d.ok).toBe(true); // drift is not an error
    expect(d.drift).toBe(true);
    expect(d.expected).toBe(sha("# law v1\n"));
    expect(d.hash).toBe(sha("# law v1\n# amendment\n"));
    // re-bless the approved change
    const r2 = await f.run(["agents-bless", "amendment approved"]);
    expect(doc(r2).hash).toBe(sha("# law v1\n# amendment\n"));
    expect(doc(r2).note).toBe("amendment approved");
    const r3 = await f.run(["agents-check"]);
    expect(doc(r3).drift).toBe(false);
    fs.rmSync(f.tmp, { recursive: true, force: true });
  });

  test("bless with no note -> manifest note field is '-'", async () => {
    const f = fixture();
    fs.writeFileSync(AGENTS(f), "# law\n");
    const r = await f.run(["agents-bless"]);
    expect(r.code).toBe(0);
    expect(doc(r).note).toBe("-");
    const line = fs.readFileSync(MANIFEST(f), "utf8").split("\n")[0];
    expect(line.split("  ")[2]).toBe("-");
    fs.rmSync(f.tmp, { recursive: true, force: true });
  });

  test("AGENTS.md missing -> ok:false rc 1 for check AND bless", async () => {
    const f = fixture();
    const rc = await f.run(["agents-check"]);
    expect(rc.code).toBe(1);
    const dc = doc(rc);
    expect(dc.ok).toBe(false);
    expect(dc.error).toContain("unreadable or missing");
    const rb = await f.run(["agents-bless", "x"]);
    expect(rb.code).toBe(1);
    expect(doc(rb).ok).toBe(false);
    expect(doc(rb).error).toContain("unreadable or missing");
    // no manifest was written by the failed bless
    expect(fs.existsSync(MANIFEST(f))).toBe(false);
    fs.rmSync(f.tmp, { recursive: true, force: true });
  });

  test("fallback: law file in ~/AGENTS.md (live-box layout) is resolved; manifest stays in ~/.pi/agent", async () => {
    const f = fixture();
    // fixture home has ~/.pi/agent/ but no AGENTS.md there; live boxes keep
    // the main profile's law in ~/AGENTS.md
    fs.writeFileSync(path.join(f.home, "AGENTS.md"), "# law at home\n");
    const r = await f.run(["agents-check"]);
    const d = doc(r);
    expect(d.ok).toBe(true);
    expect(d.hash).toBe(sha("# law at home\n"));
    expect(d.drift).toBe(true); // never blessed
    const rb = await f.run(["agents-bless", "home layout"]);
    expect(doc(rb).ok).toBe(true);
    // manifest in the FIXED design path, not next to ~/AGENTS.md
    expect(fs.existsSync(MANIFEST(f))).toBe(true);
    expect(fs.existsSync(path.join(f.home, ".agents-md-hash"))).toBe(false);
    const r2 = await f.run(["agents-check"]);
    expect(doc(r2).drift).toBe(false);
    fs.rmSync(f.tmp, { recursive: true, force: true });
  });

  test("JARATE_AGENTS_MD override points at a different file", async () => {
    const f = fixture();
    const alt = path.join(f.tmp, "worker-AGENTS.md");
    fs.writeFileSync(alt, "# worker law\n");
    const r = await f.run(["agents-check"], { JARATE_AGENTS_MD: alt });
    const d = doc(r);
    expect(d.ok).toBe(true);
    expect(d.hash).toBe(sha("# worker law\n"));
    // manifest lands next to the overridden file
    expect(fs.existsSync(path.join(f.tmp, ".agents-md-hash"))).toBe(false);
    await f.run(["agents-bless", "w"], { JARATE_AGENTS_MD: alt });
    expect(fs.existsSync(path.join(f.tmp, ".agents-md-hash"))).toBe(true);
    fs.rmSync(f.tmp, { recursive: true, force: true });
  });
});

// ─── setup ───────────────────────────────────────────────────────────────────
// FTUE subcommand. Hermetic: tmp HOME, stubbed curl/systemctl/loginctl/
// journalctl in the fixture bin dir, fake jarate checkout (stub install.sh,
// real unit templates copied from the repo). No live systemd, no network.

const SETUP_REPO = path.join(import.meta.dir, "..");

function listTree(root: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      out.push(path.relative(root, p));
      if (e.isDirectory()) walk(p);
    }
  };
  walk(root);
  return out.sort();
}

// Fake jarate checkout: .git marker + stub install.sh + real unit templates
// (so setup's sed/cp paths exercise production files).
function fakeCheckout(f: Fixture): string {
  const dir = path.join(f.tmp, "fake-repo");
  fs.mkdirSync(path.join(dir, ".git"), { recursive: true });
  fs.mkdirSync(path.join(dir, "assets"), { recursive: true });
  fs.copyFileSync(
    path.join(SETUP_REPO, "assets", "jarate-icon.png"),
    path.join(dir, "assets", "jarate-icon.png"),
  );
  const install = path.join(dir, "install.sh");
  fs.writeFileSync(
    install,
    '#!/bin/sh\necho ran > "$(dirname "$0")/.install-ran"\n',
  );
  fs.chmodSync(install, 0o755);
  for (const rel of [
    "deploy/pi.service",
    "deploy/jarate-deploy.service",
    "deploy/jarate-deploy.timer",
    "dispatch/pi-bg-watchdog.service",
    "dispatch/pi-bg-watchdog.timer",
  ]) {
    const dst = path.join(dir, rel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(path.join(SETUP_REPO, rel), dst);
  }
  return dir;
}

// Stub curl: logs each call, answers canned Discord responses.
// Dispatches on METHOD + URL. channel 123 = guild text channel;
// channel 456 = DM.
function curlStub(
  f: Fixture,
  existingWebhook = false,
  webhook403 = false,
): void {
  const p = path.join(f.bin, "curl");
  const wh403 = webhook403
    ? `
    if [ -f "$(dirname "$0")/curl.webhook403" ]; then
      printf '{"message":"Missing Permissions","code":50013}'
    fi`
    : "";
  fs.writeFileSync(
    p,
    [
      "#!/bin/sh",
      'log="$(dirname "$0")/curl.log"',
      'printf \'%s\\n\' "$*" >> "$log"',
      "method=GET",
      'url=""',
      'prev=""',
      "has_body=0",
      'for a in "$@"; do',
      '  if [ "$prev" = "-X" ]; then method="$a"; fi',
      '  if [ "$a" = "@-" ]; then has_body=1; fi',
      '  case "$a" in http*) url="$a";; esac',
      '  prev="$a"',
      "done",
      'if [ "$has_body" = 1 ]; then printf \'%s\\n\' "$(cat)" >> "$log"; fi',
      'case "$method $url" in',
      '  GET\\ */users/@me) printf \'{"id":"101","username":"stubbot"}\' ;;',
      "  GET\\ */channels/123/webhooks) " +
        (webhook403 ? wh403 + "; " : " ") +
        (existingWebhook
          ? 'printf \'[{"id":"555","name":"Jarate"}]\''
          : "printf '[]'") +
        " ;;",
      '  POST\\ */channels/123/webhooks) printf \'{"id":"999","token":"tok999"}\' ;;',
      '  GET\\ */webhooks/555) printf \'{"id":"555","token":"oldtok"}\' ;;',
      // Discord v10 channel types: 0 = guild text, 1 = DM, 4 = guild voice
      '  GET\\ */channels/123) printf \'{"id":"123","type":0,"guild_id":"9"}\' ;;',
      '  GET\\ */channels/456) printf \'{"id":"456","type":1,"guild_id":null}\' ;;',
      '  GET\\ */channels/789) printf \'{"id":"789","type":4,"guild_id":"9"}\' ;;',
      '  *) printf \'{"id":"999","token":"tok999"}\' ;;',
      "esac",
      "",
    ].join("\n"),
  );
  fs.chmodSync(p, 0o755);
}

// Stub systemctl (logs calls; is-active -> active) + failing loginctl
// (exercises the "needs root" note) + journalctl with the boot-gate line.
function systemdStubs(f: Fixture, isActive = "active"): void {
  const sc = path.join(f.bin, "systemctl");
  fs.writeFileSync(
    sc,
    [
      "#!/bin/sh",
      'printf \'%s\\n\' "$*" >> "$(dirname "$0")/systemctl.log"',
      'if [ "${1:-}" = "--user" ] && [ "${2:-}" = "is-active" ]; then',
      `  echo ${isActive}`,
      "  exit 0",
      "fi",
      "exit 0",
      "",
    ].join("\n"),
  );
  fs.chmodSync(sc, 0o755);
  const lc = path.join(f.bin, "loginctl");
  fs.writeFileSync(lc, "#!/bin/sh\nexit 1\n");
  fs.chmodSync(lc, 0o755);
  const jc = path.join(f.bin, "journalctl");
  fs.writeFileSync(
    jc,
    "#!/bin/sh\necho '[interactions] registered 0 slash commands in guild test'\n",
  );
  fs.chmodSync(jc, 0o755);
}

describe("setup", () => {
  test("default is dry-run: plan on stderr, no network, zero HOME writes", async () => {
    const f = fixture();
    const repo = fakeCheckout(f);
    curlStub(f); // must NOT be called in dry-run
    const before = listTree(f.home);
    const r = await f.run([
      "setup",
      "aa.bb.cc",
      "123",
      "--owner",
      "456",
      "--name",
      "testbot",
      "--jarate-dir",
      repo,
      "--model-base",
      "http://127.0.0.1:8081/v1",
      "--model-id",
      "m1",
      "--model-key",
      "k1",
    ]);
    expect(r.code).toBe(0);
    const d = doc(r);
    expect(d.ok).toBe(true);
    expect(d.dry_run).toBe(true);
    expect(d.agent).toBe("testbot");
    expect(d.channel).toBe("123");
    expect(d.bot_id).toBeNull(); // no network: placeholder id nulled
    expect(d.webhook_id).toBeNull();
    expect(d.units).toBeNull(); // nothing written
    expect(d.verified).toBeNull(); // gate skipped
    expect(d.next_steps[0]).toContain("--yes");
    expect(fs.existsSync(path.join(f.bin, "curl.log"))).toBe(false);
    expect(listTree(f.home)).toEqual(before); // zero writes
    expect(r.err).toContain("[setup dry]");
    expect(r.err).toContain("settings.json");
    expect(r.err).toContain("daemon-reload");
    fs.rmSync(f.tmp, { recursive: true, force: true });
  });

  test("--yes executes: merges configs, writes webhook + units, gate passes", async () => {
    const f = fixture();
    const repo = fakeCheckout(f);
    curlStub(f);
    systemdStubs(f);
    const agentDir = path.join(f.home, ".pi", "agent");
    fs.mkdirSync(agentDir, { recursive: true });
    // pre-existing config: another channel (kept) + another provider (kept)
    fs.writeFileSync(
      path.join(agentDir, "settings.json"),
      JSON.stringify({
        packages: ["/old/packages/bridge"],
        channels: [
          {
            id: "discord-old",
            name: "OLD",
            type: "discord",
            enabled: true,
            channel: "777",
            botToken: "old.token.x",
            default: true,
          },
        ],
      }),
    );
    fs.writeFileSync(
      path.join(agentDir, "models.json"),
      JSON.stringify({
        providers: {
          other: {
            name: "Other",
            baseUrl: "http://other/v1",
            api: "openai-completions",
            apiKey: "k",
            models: [],
          },
        },
      }),
    );
    const r = await f.run([
      "setup",
      "aa.bb.cc",
      "123",
      "--yes",
      "--jarate-dir",
      repo,
      "--name",
      "testbot",
      "--owner",
      "456",
      "--model-base",
      "http://127.0.0.1:8081/v1",
      "--model-id",
      "m1",
      "--model-key",
      "k1",
    ]);
    expect(r.code).toBe(0);
    const d = doc(r);
    expect(d.ok).toBe(true);
    expect(d.dry_run).toBe(false);
    expect(d.bot_id).toBe("101");
    expect(d.webhook_id).toBe("999");
    expect(d.units).toBe(true);
    expect(d.verified).toBe(true);
    expect(d.next_steps.join("\n")).not.toContain("LLM creds");

    // install.sh ran inside the fake checkout
    expect(fs.readFileSync(path.join(repo, ".install-ran"), "utf8")).toBe(
      "ran\n",
    );

    // exactly the API calls, in design order, with the bot token header
    const calls = fs
      .readFileSync(path.join(f.bin, "curl.log"), "utf8")
      .trim()
      .split("\n");
    expect(calls.length).toBe(5); // 4 argv lines + 1 body line
    expect(calls[0]).toBe(
      "-sS -m 15 https://discord.com/api/v10/users/@me -H Authorization: Bot aa.bb.cc",
    );
    expect(calls[1]).toBe(
      "-sS -m 15 https://discord.com/api/v10/channels/123 -H Authorization: Bot aa.bb.cc",
    );
    expect(calls[2]).toBe(
      "-sS -m 15 https://discord.com/api/v10/channels/123/webhooks -H Authorization: Bot aa.bb.cc",
    );
    expect(calls[3].startsWith("-sS -m 15 -X POST")).toBe(true);
    expect(calls[3]).toContain("Authorization: Bot aa.bb.cc");
    expect(calls[3]).toContain("-d @-"); // body via stdin (argv size limit)
    expect(calls[4]).toContain('"name":"Jarate"');
    expect(calls[4]).toContain("data:image/png;base64,");

    // settings.json merged: channel replaced in place, others kept
    const settings = JSON.parse(
      fs.readFileSync(path.join(agentDir, "settings.json"), "utf8"),
    );
    expect(settings.packages).toContain(path.join(repo, "packages/bridge"));
    const mine = settings.channels.filter(
      (c: { channel: string }) => c.channel === "123",
    );
    expect(mine.length).toBe(1);
    expect(mine[0]).toEqual({
      id: "discord-testbot",
      name: "TESTBOT",
      type: "discord",
      enabled: true,
      channel: "123",
      botToken: "aa.bb.cc",
      default: true,
      forwardToolCalls: true,
      ack: false,
      ownerUserId: "456",
    });
    expect(
      settings.channels.some((c: { channel: string }) => c.channel === "777"),
    ).toBe(true);
    expect(settings.defaultProvider).toBe("127.0.0.1:8081");
    expect(settings.defaultModel).toBe("m1");
    expect(
      fs.readdirSync(agentDir).filter((x) => x.startsWith("settings.json.bak-"))
        .length,
    ).toBe(1);
    expect(
      fs.readdirSync(agentDir).filter((x) => x.startsWith("models.json.bak-"))
        .length,
    ).toBe(1);

    // models.json merged: new provider added, old kept, defaults match
    const models = JSON.parse(
      fs.readFileSync(path.join(agentDir, "models.json"), "utf8"),
    );
    expect(models.providers.other).toBeDefined();
    const p = models.providers["127.0.0.1:8081"];
    expect(p.api).toBe("openai-completions");
    expect(p.apiKey).toBe("k1");
    expect(p.models[0].id).toBe("m1");
    expect(p.models[0].contextWindow).toBe(262144);

    // dispatch webhook files (600)
    const wcfg = path.join(f.home, ".config", "pi-dispatch");
    expect(fs.readFileSync(path.join(wcfg, "webhook"), "utf8")).toBe(
      "https://discord.com/api/webhooks/999/tok999\n",
    );
    expect(fs.readFileSync(path.join(wcfg, "webhook_author"), "utf8")).toBe(
      "999\n",
    );
    expect(fs.statSync(path.join(wcfg, "webhook")).mode & 0o777).toBe(0o600);

    // units: %h kept, name substituted, deploy path -> fake checkout
    const ud = path.join(f.home, ".config", "systemd", "user");
    const pi = fs.readFileSync(path.join(ud, "pi.service"), "utf8");
    expect(pi).toContain("pi coding agent (testbot)");
    expect(pi).not.toContain("__AGENT_NAME__");
    expect(pi).toContain("EnvironmentFile=-%h/.hermes/.env");
    expect(pi).toContain(
      "Environment=PATH=%h/.local/bin:%h/bin:%h/scripts:/usr/local/bin:/usr/bin:/bin",
    );
    const jd = fs.readFileSync(path.join(ud, "jarate-deploy.service"), "utf8");
    expect(jd).toContain(`WorkingDirectory=${repo}`);
    expect(jd).toContain(`ExecStart=${repo}/deploy/deploy.sh`);
    // watchdog units copied verbatim from the repo
    expect(fs.readFileSync(path.join(ud, "pi-bg-watchdog.timer"), "utf8")).toBe(
      fs.readFileSync(
        path.join(SETUP_REPO, "dispatch", "pi-bg-watchdog.timer"),
        "utf8",
      ),
    );

    // systemctl sequence; loginctl failure is a note, not a failure
    const scLog = fs
      .readFileSync(path.join(f.bin, "systemctl.log"), "utf8")
      .trim()
      .split("\n");
    expect(scLog).toContain("--user daemon-reload");
    expect(scLog).toContain("--user enable --now pi.service");
    expect(scLog).toContain(
      "--user enable --now jarate-deploy.timer pi-bg-watchdog.timer",
    );
    expect(scLog).toContain("--user is-active pi.service");
    expect(r.err).toContain("enable-linger needs root");
    fs.rmSync(f.tmp, { recursive: true, force: true });
  });

  test("idempotent re-run: reuses existing Jarate webhook, no dup entries", async () => {
    const f = fixture();
    const repo = fakeCheckout(f);
    curlStub(f, true);
    systemdStubs(f);
    const args = [
      "setup",
      "aa.bb.cc",
      "123",
      "--yes",
      "--jarate-dir",
      repo,
      "--name",
      "testbot",
      "--no-verify",
    ];
    const r1 = await f.run(args);
    expect(r1.code).toBe(0);
    expect(doc(r1).webhook_id).toBe("555"); // reused, not created
    // no POST: the existing webhook was reused
    const calls = fs
      .readFileSync(path.join(f.bin, "curl.log"), "utf8")
      .trim()
      .split("\n");
    expect(calls.filter((l) => l.includes("-X POST")).length).toBe(0); // no POST: the existing webhook was reused
    // second run: same result, still exactly one channel entry
    const r2 = await f.run(args);
    expect(r2.code).toBe(0);
    const settings = JSON.parse(
      fs.readFileSync(
        path.join(f.home, ".pi", "agent", "settings.json"),
        "utf8",
      ),
    );
    expect(
      settings.channels.filter((c: { channel: string }) => c.channel === "123")
        .length,
    ).toBe(1);
    expect(new Set(settings.packages).size).toBe(settings.packages.length);
    expect(
      fs.readFileSync(
        path.join(f.home, ".config", "pi-dispatch", "webhook"),
        "utf8",
      ),
    ).toBe("https://discord.com/api/webhooks/555/oldtok\n");
    fs.rmSync(f.tmp, { recursive: true, force: true });
  });

  test("--webhook-url: parses id/token, skips the webhook API entirely", async () => {
    const f = fixture();
    const repo = fakeCheckout(f);
    curlStub(f);
    systemdStubs(f);
    const r = await f.run([
      "setup",
      "aa.bb.cc",
      "123",
      "--yes",
      "--no-units",
      "--no-verify",
      "--jarate-dir",
      repo,
      "--webhook-url",
      "https://discord.com/api/webhooks/77/tok77",
    ]);
    expect(r.code).toBe(0);
    expect(doc(r).webhook_id).toBe("77");
    expect(
      fs.readFileSync(
        path.join(f.home, ".config", "pi-dispatch", "webhook"),
        "utf8",
      ),
    ).toBe("https://discord.com/api/webhooks/77/tok77\n");
    const calls = fs
      .readFileSync(path.join(f.bin, "curl.log"), "utf8")
      .trim()
      .split("\n");
    expect(calls.length).toBe(2); // @me + channel only
    fs.rmSync(f.tmp, { recursive: true, force: true });
  });

  test("DM channel -> rc 1 with the guild-channel hint", async () => {
    const f = fixture();
    const repo = fakeCheckout(f);
    curlStub(f);
    systemdStubs(f);
    const r = await f.run([
      "setup",
      "aa.bb.cc",
      "456",
      "--yes",
      "--no-units",
      "--no-verify",
      "--jarate-dir",
      repo,
    ]);
    expect(r.code).toBe(1);
    const d = doc(r);
    expect(d.ok).toBe(false);
    expect(d.error).toContain("DM");
    fs.rmSync(f.tmp, { recursive: true, force: true });
  });

  test("voice channel -> rc 1 (only guild text types 0/15 accepted)", async () => {
    const f = fixture();
    const repo = fakeCheckout(f);
    curlStub(f);
    systemdStubs(f);
    const r = await f.run([
      "setup",
      "aa.bb.cc",
      "789",
      "--yes",
      "--no-units",
      "--no-verify",
      "--jarate-dir",
      repo,
    ]);
    expect(r.code).toBe(1);
    expect(doc(r).error).toContain("not a guild text channel");
    fs.rmSync(f.tmp, { recursive: true, force: true });
  });

  test("webhook list 403 Missing Permissions -> rc 1 with the mask hint", async () => {
    const f = fixture();
    const repo = fakeCheckout(f);
    curlStub(f, false, true);
    fs.writeFileSync(path.join(f.bin, "curl.webhook403"), "");
    systemdStubs(f);
    const r = await f.run([
      "setup",
      "aa.bb.cc",
      "123",
      "--yes",
      "--no-units",
      "--no-verify",
      "--jarate-dir",
      repo,
    ]);
    expect(r.code).toBe(1);
    const d = doc(r);
    expect(d.error).toContain("MANAGE_WEBHOOKS");
    expect(d.error).toContain("539098960");
    fs.rmSync(f.tmp, { recursive: true, force: true });
  });

  test("boot gate failing -> rc 1 with journal tail + suspects", async () => {
    const f = fixture();
    const repo = fakeCheckout(f);
    curlStub(f);
    systemdStubs(f, "inactive"); // is-active never turns active
    const r = await f.run(
      [
        "setup",
        "aa.bb.cc",
        "123",
        "--yes",
        "--jarate-dir",
        repo,
        "--name",
        "testbot",
      ],
      { JARATE_SETUP_GATE_S: "3", JARATE_SETUP_POLL_S: "1" },
    );
    expect(r.code).toBe(1);
    const d = doc(r);
    expect(d.ok).toBe(false);
    expect(d.error).toContain("boot gate failed");
    expect(d.error).toContain("intents");
    fs.rmSync(f.tmp, { recursive: true, force: true });
  });

  test("usage errors -> rc 2 + error doc, before any side effect", async () => {
    const f = fixture();
    curlStub(f);
    const cases: Array<[string[], string]> = [
      [["setup"], "usage"],
      [["setup", "aa.bb.cc", "abc"], "numeric"],
      [["setup", "aa.bb.cc", "123", "456"], "extra arg"],
      [["setup", "aa.bb.cc", "123", "--owner"], "needs a value"],
      [["setup", "aa.bb.cc", "123", "--bogus"], "unknown flag"],
      [["setup", "aa.bb.cc", "123", "--model-headers", "{x"], "valid JSON"],
    ];
    for (const [args, frag] of cases) {
      const r = await f.run(args);
      expect(r.code).toBe(2);
      const d = doc(r);
      expect(d.ok).toBe(false);
      expect(d.error).toContain(frag);
    }
    expect(fs.existsSync(path.join(f.bin, "curl.log"))).toBe(false);
    fs.rmSync(f.tmp, { recursive: true, force: true });
  });

  test("--help -> ok:true usage doc", async () => {
    const f = fixture();
    const r = await f.run(["setup", "--help"]);
    expect(r.code).toBe(0);
    const d = doc(r);
    expect(d.ok).toBe(true);
    expect(d.usage).toBe("jarate setup <bot-token> <channel-id> [options]");
    expect(d.options).toContain("--owner <discord-user-id>");
    fs.rmSync(f.tmp, { recursive: true, force: true });
  });

  test("pre-joined args and split args both work", async () => {
    const f = fixture();
    const repo = fakeCheckout(f);
    curlStub(f);
    const joined = await f.run([
      "setup",
      `aa.bb.cc 123 --owner 456 --name testbot --jarate-dir ${repo}`,
    ]);
    const split = await f.run([
      "setup",
      "aa.bb.cc",
      "123",
      "--owner",
      "456",
      "--name",
      "testbot",
      "--jarate-dir",
      repo,
    ]);
    expect(joined.code).toBe(0);
    expect(split.code).toBe(0);
    const dj = doc(joined);
    const ds = doc(split);
    expect(dj.ok).toBe(true);
    expect(dj.agent).toBe(ds.agent);
    expect(dj.next_steps).toEqual(ds.next_steps);
    fs.rmSync(f.tmp, { recursive: true, force: true });
  });
});

// ─── projects / projects-backfill ───────────────────────────────────────────
// Cross-agent run-record rollup (2026-09-18). Hermetic: fake homes, records
// planted under <home>/.pi-dispatch/runs, and an sshpass stub that extracts
// the driver out of the sudo hop and execs it locally (PI_HOME selects the
// peer's home), so the "remote" scan runs against the fixture files.

/**
 * sshpass stub for the scan hop: the last arg is the remote command
 * `echo 'pass' | sudo -S -u 'owner' bash -c '<driver>'` — strip through
 * `bash -c '` and the trailing quote, then run the driver in this shell.
 */
function scanSshpass(f: Fixture, fail = false): void {
  const sp = path.join(f.bin, "sshpass");
  fs.writeFileSync(
    sp,
    fail
      ? "#!/bin/sh\necho 'ssh: refused' >&2\nexit 255\n"
      : `#!/bin/sh
last=""
for a in "$@"; do last="$a"; done
q="'"
rest="\${last#*"bash -c "$q}"
driver="\${rest%"$q"}"
exec sh -c "$driver"
`,
  );
  fs.chmodSync(sp, 0o755);
}

function plantRecord(
  homeDir: string,
  name: string,
  rec: Record<string, unknown>,
): void {
  const d = path.join(homeDir, ".pi-dispatch", "runs");
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, name), JSON.stringify(rec, null, 2));
}

const readRecord = (homeDir: string, name: string): Record<string, unknown> =>
  JSON.parse(
    fs.readFileSync(path.join(homeDir, ".pi-dispatch", "runs", name), "utf8"),
  );

describe("projects", () => {
  const seed = (f: Fixture) => {
    // local home: 3 records (2 nestfinder, 1 untagged)
    plantRecord(f.home, "pi-bg-aaa.json", {
      run: "aaa",
      profile: "worker",
      project: "nestfinder",
      started: "2026-09-10T10:00:00Z",
      tokens: {
        input: 100,
        output: 10,
        cacheRead: 5,
        cacheWrite: 1,
        total: 115,
      },
      cost_usd: 0.01,
    });
    plantRecord(f.home, "pi-bg-bbb.json", {
      run: "bbb",
      profile: "reviewer",
      started: "2026-09-11T10:00:00Z",
    });
    plantRecord(f.home, "pi-bg-ccc.json", {
      run: "ccc",
      profile: "worker",
      project: "nestfinder",
      started: "2026-09-12T10:00:00Z",
      tokens: { input: 50, output: 5, cacheRead: 0, cacheWrite: 0, total: 55 },
      cost_usd: null,
    });
    // peer home: 1 fully-priced record
    plantRecord(f.env.JARATE_AGENT_HOMES.split(":")[1], "pi-bg-ddd.json", {
      run: "ddd",
      profile: "worker",
      project: "jarate",
      started: "2026-09-09T10:00:00Z",
      tokens: { input: 10, output: 1, cacheRead: 0, cacheWrite: 0, total: 11 },
      cost_usd: 0.001,
    });
  };

  test("cross-agent rollup: buckets, token sums, cost null semantics, sort", async () => {
    const f = fixture();
    scanSshpass(f);
    seed(f);
    const r = await f.run(["projects"]);
    expect(r.code).toBe(0);
    const d = doc(r);
    expect(d.ok).toBe(true);
    expect(d.error).toBeNull();
    expect(Object.keys(d)).toEqual([
      "ok",
      "ts",
      "error",
      "since",
      "project",
      "warn",
      "projects",
      "agents",
    ]);
    expect(d.since).toBeNull();
    expect(d.project).toBeNull();
    expect(d.warn).toBeNull();
    expect(d.agents).toEqual([
      { agent: "home", source: "local", scanned: 3, error: null },
      { agent: "peer-home", source: "ssh+sudo", scanned: 1, error: null },
    ]);
    // sort: runs desc, then project asc
    expect(d.projects.map((p: any) => p.project)).toEqual([
      "nestfinder",
      "jarate",
      "unspecified",
    ]);
    const [nf, jt, un] = d.projects;
    expect(nf).toEqual({
      project: "nestfinder",
      runs: 2,
      workers: 2,
      reviewers: 0,
      tokens: {
        input: 150,
        output: 15,
        cacheRead: 5,
        cacheWrite: 1,
        total: 170,
      },
      // one record unpriced -> the bucket is null, never a partial sum
      cost_usd: null,
      cost_covered: 1,
      first: "2026-09-10T10:00:00Z",
      last: "2026-09-12T10:00:00Z",
    });
    expect(jt).toEqual({
      project: "jarate",
      runs: 1,
      workers: 1,
      reviewers: 0,
      tokens: { input: 10, output: 1, cacheRead: 0, cacheWrite: 0, total: 11 },
      cost_usd: 0.001,
      cost_covered: 1,
      first: "2026-09-09T10:00:00Z",
      last: "2026-09-09T10:00:00Z",
    });
    expect(un).toEqual({
      project: "unspecified",
      runs: 1,
      workers: 0,
      reviewers: 1,
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      cost_usd: null,
      cost_covered: 0,
      first: "2026-09-11T10:00:00Z",
      last: "2026-09-11T10:00:00Z",
    });
    fs.rmSync(f.tmp, { recursive: true, force: true });
  });

  test("boolean cost_usd is not priced: rollup rejects it (LOW-4)", async () => {
    const f = fixture();
    scanSshpass(f);
    plantRecord(f.home, "pi-bg-n1.json", {
      run: "n1",
      profile: "worker",
      project: "nestfinder",
      started: "2026-09-10T10:00:00Z",
      tokens: {
        input: 100,
        output: 10,
        cacheRead: 0,
        cacheWrite: 0,
        total: 110,
      },
      cost_usd: 0.01,
    });
    plantRecord(f.home, "pi-bg-n2.json", {
      run: "n2",
      profile: "worker",
      project: "nestfinder",
      started: "2026-09-11T10:00:00Z",
      tokens: { input: 10, output: 1, cacheRead: 0, cacheWrite: 0, total: 11 },
      cost_usd: true, // JSON true -> python bool: must not count as priced
    });
    const r = await f.run(["projects"]);
    expect(r.code).toBe(0);
    const d = doc(r);
    const nf = d.projects.find((p: any) => p.project === "nestfinder");
    expect(nf.runs).toBe(2);
    // a bool would inflate the sum to 1.01 and count as covered; the
    // bool-excluding guard keeps it unpriced -> bucket null, only the
    // numeric record covered
    expect(nf.cost_usd).toBeNull();
    expect(nf.cost_covered).toBe(1);
    fs.rmSync(f.tmp, { recursive: true, force: true });
  });

  test("--project filter keeps one bucket; unknown tag -> zeroed entry", async () => {
    const f = fixture();
    scanSshpass(f);
    seed(f);
    const r1 = await f.run(["projects", "--project", "nestfinder"]);
    const d1 = doc(r1);
    expect(d1.project).toBe("nestfinder");
    expect(d1.projects).toHaveLength(1);
    expect(d1.projects[0].project).toBe("nestfinder");
    expect(d1.projects[0].runs).toBe(2);
    const r2 = await f.run(["projects", "--project", "nosuch"]);
    const d2 = doc(r2);
    expect(d2.ok).toBe(true);
    expect(d2.projects).toEqual([
      {
        project: "nosuch",
        runs: 0,
        workers: 0,
        reviewers: 0,
        tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        cost_usd: null,
        cost_covered: 0,
        first: null,
        last: null,
      },
    ]);
    fs.rmSync(f.tmp, { recursive: true, force: true });
  });

  test("--since drops older records (string compare on started)", async () => {
    const f = fixture();
    scanSshpass(f);
    seed(f);
    const r = await f.run(["projects", "--since", "2026-09-11"]);
    const d = doc(r);
    expect(d.since).toBe("2026-09-11");
    // aaa (09-10) and ddd (09-09) gone; ccc (09-12) + bbb (09-11) kept
    expect(d.projects.map((p: any) => p.project)).toEqual([
      "nestfinder",
      "unspecified",
    ]);
    const nf = d.projects.find((p: any) => p.project === "nestfinder");
    expect(nf.runs).toBe(1);
    expect(nf.first).toBe("2026-09-12T10:00:00Z");
    expect(nf.cost_covered).toBe(0);
    fs.rmSync(f.tmp, { recursive: true, force: true });
  });

  test("--agent narrows to one agent; no match -> ok:false rc 1", async () => {
    const f = fixture();
    scanSshpass(f);
    seed(f);
    const r1 = await f.run(["projects", "--agent", "peer-home"]);
    const d1 = doc(r1);
    expect(d1.agents).toEqual([
      { agent: "peer-home", source: "ssh+sudo", scanned: 1, error: null },
    ]);
    expect(d1.projects.map((p: any) => p.project)).toEqual(["jarate"]);
    const r2 = await f.run(["projects", "--agent", "nosuch"]);
    expect(r2.code).toBe(1);
    const d2 = doc(r2);
    expect(d2.ok).toBe(false);
    expect(d2.error).toContain("no agents matched");
    fs.rmSync(f.tmp, { recursive: true, force: true });
  });

  test("peer hop failing -> row error + warn, local data intact, still ok", async () => {
    const f = fixture();
    scanSshpass(f, true);
    seed(f);
    const r = await f.run(["projects"]);
    expect(r.code).toBe(0);
    const d = doc(r);
    expect(d.ok).toBe(true);
    expect(d.warn).toBe("agent hop failed: peer-home");
    const peer = d.agents.find((a: any) => a.agent === "peer-home");
    expect(peer.scanned).toBeNull();
    expect(peer.error).toContain("cross-user hop failed");
    // local records still rolled up
    expect(d.projects.map((p: any) => p.project)).toEqual([
      "nestfinder",
      "unspecified",
    ]);
    fs.rmSync(f.tmp, { recursive: true, force: true });
  });

  test("bad --since and invalid --project tag -> rc 2 usage errors", async () => {
    const f = fixture();
    const r1 = await f.run(["projects", "--since", "2026-13"]);
    expect(r1.code).toBe(2);
    expect(doc(r1).error).toContain("bad --since");
    const r2 = await f.run(["projects", "--project", "Bad_Tag"]);
    expect(r2.code).toBe(2);
    expect(doc(r2).error).toContain("invalid --project tag");
    fs.rmSync(f.tmp, { recursive: true, force: true });
  });

  test("no run records anywhere -> ok, empty projects, zero agent scans", async () => {
    const f = fixture();
    scanSshpass(f);
    const r = await f.run(["projects"]);
    expect(r.code).toBe(0);
    const d = doc(r);
    expect(d.ok).toBe(true);
    expect(d.projects).toEqual([]);
    expect(d.agents.map((a: any) => a.scanned)).toEqual([0, 0]);
    fs.rmSync(f.tmp, { recursive: true, force: true });
  });
});

describe("projects-backfill", () => {
  const seedLocal = (f: Fixture) => {
    // cwd under ~/projects/<name> -> "cwd" rule
    plantRecord(f.home, "pi-bg-r1.json", {
      run: "r1",
      profile: "worker",
      cwd: `${f.home}/projects/nestfinder/sub`,
      started: "2026-09-01T00:00:00Z",
    });
    // cwd under ~/.pi-bg-wt/<repo>/<id> -> "worktree" rule
    plantRecord(f.home, "pi-bg-r2.json", {
      run: "r2",
      profile: "worker",
      cwd: `${f.home}/.pi-bg-wt/jarate/20260918-123`,
      started: "2026-09-02T00:00:00Z",
    });
    // no derivation -> per-agent default (home != frank -> unspecified)
    plantRecord(f.home, "pi-bg-r3.json", {
      run: "r3",
      profile: "reviewer",
      cwd: "/tmp/elsewhere",
      started: "2026-09-03T00:00:00Z",
    });
    // already tagged -> skipped, never overwritten
    plantRecord(f.home, "pi-bg-r4.json", {
      run: "r4",
      profile: "worker",
      project: "existing",
      cwd: "/tmp/x",
      started: "2026-09-04T00:00:00Z",
    });
  };

  test("--dry-run plans without writing; sources per rule", async () => {
    const f = fixture();
    scanSshpass(f);
    seedLocal(f);
    const before = fs.readFileSync(
      path.join(f.home, ".pi-dispatch", "runs", "pi-bg-r1.json"),
      "utf8",
    );
    const r = await f.run(["projects-backfill", "--dry-run"]);
    expect(r.code).toBe(0);
    const d = doc(r);
    expect(d.ok).toBe(true);
    expect(d.error).toBeNull();
    expect(Object.keys(d)).toEqual([
      "ok",
      "ts",
      "error",
      "dry_run",
      "agents",
      "total",
    ]);
    expect(d.dry_run).toBe(true);
    expect(d.total).toEqual({ scanned: 4, tagged: 3, skipped: 1 });
    const local = d.agents.find((a: any) => a.agent === "home");
    expect(local.source).toBe("local");
    expect(local.error).toBeNull();
    expect(local.map).toEqual([
      { run: "r1", project: "nestfinder", source: "cwd" },
      { run: "r2", project: "jarate", source: "worktree" },
      { run: "r3", project: "unspecified", source: "default" },
    ]);
    const peer = d.agents.find((a: any) => a.agent === "peer-home");
    expect(peer.source).toBe("ssh+sudo");
    expect(peer.scanned).toBe(0);
    expect(peer.map).toEqual([]);
    // nothing written
    expect(
      fs.readFileSync(
        path.join(f.home, ".pi-dispatch", "runs", "pi-bg-r1.json"),
        "utf8",
      ),
    ).toBe(before);
    fs.rmSync(f.tmp, { recursive: true, force: true });
  });

  test("non-dict record files are not scanned: totals reconcile (LOW-5)", async () => {
    const f = fixture();
    scanSshpass(f);
    seedLocal(f);
    const runsDir = path.join(f.home, ".pi-dispatch", "runs");
    // valid JSON that is not an object, plus a corrupt file: neither may
    // count in scanned (they are in neither tagged nor skipped)
    fs.writeFileSync(path.join(runsDir, "pi-bg-list.json"), "[1, 2, 3]\n");
    fs.writeFileSync(path.join(runsDir, "pi-bg-corr.json"), '{"run": "corr"\n');
    const r = await f.run(["projects-backfill"]);
    expect(r.code).toBe(0);
    const b = doc(r);
    expect(b.total).toEqual({ scanned: 4, tagged: 3, skipped: 1 });
    // the rollup scanner agrees on the same input (scanned after the
    // isinstance guard in both scanners)
    const r2 = await f.run(["projects"]);
    const d2 = doc(r2);
    const local = d2.agents.find((a: any) => a.agent === "home");
    expect(local.scanned).toBe(4);
    fs.rmSync(f.tmp, { recursive: true, force: true });
  });

  test("real run writes project + backfilled + backfilled_at; idempotent", async () => {
    const f = fixture();
    scanSshpass(f);
    seedLocal(f);
    const r1 = await f.run(["projects-backfill"]);
    const d1 = doc(r1);
    expect(d1.dry_run).toBe(false);
    expect(d1.total).toEqual({ scanned: 4, tagged: 3, skipped: 1 });
    const rec = readRecord(f.home, "pi-bg-r1.json");
    expect(rec.project).toBe("nestfinder");
    expect(rec.backfilled).toBe(true);
    expect(rec.backfilled_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    expect(rec.cwd).toBe(`${f.home}/projects/nestfinder/sub`); // intact
    const rec2 = readRecord(f.home, "pi-bg-r2.json");
    expect(rec2.project).toBe("jarate");
    const rec4 = readRecord(f.home, "pi-bg-r4.json");
    expect(rec4.project).toBe("existing"); // never overwritten
    expect("backfilled" in rec4).toBe(false);
    // idempotent second pass: everything already tagged
    const r2 = await f.run(["projects-backfill"]);
    const d2 = doc(r2);
    expect(d2.total).toEqual({ scanned: 4, tagged: 0, skipped: 4 });
    const local = d2.agents.find((a: any) => a.agent === "home");
    expect(local.map).toEqual([]);
    fs.rmSync(f.tmp, { recursive: true, force: true });
  });

  test("--set overrides derivation for the named run", async () => {
    const f = fixture();
    scanSshpass(f);
    seedLocal(f);
    const r = await f.run(["projects-backfill", "--set", "r1=custom-tag"]);
    const d = doc(r);
    const local = d.agents.find((a: any) => a.agent === "home");
    const m1 = local.map.find((m: any) => m.run === "r1");
    expect(m1).toEqual({ run: "r1", project: "custom-tag", source: "set" });
    // others unaffected by the set
    const m2 = local.map.find((m: any) => m.run === "r2");
    expect(m2.source).toBe("worktree");
    expect(readRecord(f.home, "pi-bg-r1.json").project).toBe("custom-tag");
    fs.rmSync(f.tmp, { recursive: true, force: true });
  });

  test("frank home defaults to nestfinder (peer hop); --agent narrows", async () => {
    const f = fixture();
    scanSshpass(f);
    const frankHome = path.join(f.tmp, "frank");
    fs.mkdirSync(frankHome, { recursive: true });
    plantRecord(frankHome, "pi-bg-f1.json", {
      run: "f1",
      profile: "worker",
      cwd: "/tmp/zz",
      started: "2026-09-05T00:00:00Z",
    });
    plantRecord(f.home, "pi-bg-l1.json", {
      run: "l1",
      profile: "worker",
      cwd: "/tmp/yy",
      started: "2026-09-06T00:00:00Z",
    });
    const homes = `${f.home}:${frankHome}`;
    const r = await f.run(["projects-backfill"], { JARATE_AGENT_HOMES: homes });
    const d = doc(r);
    const frank = d.agents.find((a: any) => a.agent === "frank");
    expect(frank.source).toBe("ssh+sudo");
    expect(frank.map).toEqual([
      { run: "f1", project: "nestfinder", source: "default" },
    ]);
    const local = d.agents.find((a: any) => a.agent === "home");
    expect(local.map).toEqual([
      { run: "l1", project: "unspecified", source: "default" },
    ]);
    expect(readRecord(frankHome, "pi-bg-f1.json").project).toBe("nestfinder");
    // --agent narrows to the frank home only
    const r2 = await f.run(["projects-backfill", "--agent", "frank"], {
      JARATE_AGENT_HOMES: homes,
    });
    const d2 = doc(r2);
    expect(d2.agents).toHaveLength(1);
    expect(d2.agents[0].agent).toBe("frank");
    expect(d2.total).toEqual({ scanned: 1, tagged: 0, skipped: 1 });
    const r3 = await f.run(["projects-backfill", "--agent", "nosuch"], {
      JARATE_AGENT_HOMES: homes,
    });
    expect(r3.code).toBe(1);
    expect(doc(r3).error).toContain("no agents matched");
    fs.rmSync(f.tmp, { recursive: true, force: true });
  });

  test("peer hop failing -> row error, totals count the local agent only", async () => {
    const f = fixture();
    scanSshpass(f, true);
    seedLocal(f);
    plantRecord(f.env.JARATE_AGENT_HOMES.split(":")[1], "pi-bg-p1.json", {
      run: "p1",
      profile: "worker",
      cwd: "/tmp/p",
    });
    const r = await f.run(["projects-backfill"]);
    expect(r.code).toBe(0);
    const d = doc(r);
    expect(d.ok).toBe(true);
    const peer = d.agents.find((a: any) => a.agent === "peer-home");
    expect(peer.scanned).toBeNull();
    expect(peer.error).toContain("cross-user hop failed");
    expect(d.total).toEqual({ scanned: 4, tagged: 3, skipped: 1 });
    fs.rmSync(f.tmp, { recursive: true, force: true });
  });

  test("--set validation: no '=', empty run, bad tag -> rc 2", async () => {
    const f = fixture();
    const cases: Array<[string[], string]> = [
      [["projects-backfill", "--set", "novalue"], "wants <run>=<tag>"],
      [["projects-backfill", "--set", "=tag"], "wants <run>=<tag>"],
      [["projects-backfill", "--set", "r1=Bad_Tag"], "invalid tag"],
    ];
    for (const [args, frag] of cases) {
      const r = await f.run(args);
      expect(r.code).toBe(2);
      expect(doc(r).error).toContain(frag);
    }
    fs.rmSync(f.tmp, { recursive: true, force: true });
  });
});
