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
      "ctx-report",
      "journal-errors",
      "memory-grep",
      "rag",
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
