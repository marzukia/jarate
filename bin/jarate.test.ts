/**
 * bin/jarate — JSON entrypoint contract tests (issue #17).
 *
 * Runs the real bash entrypoint against a fake HOME with stubbed externals
 * (pi-token-cost.py, journalctl, sshpass, recall CLI) and asserts the JSON
 * discipline: exactly one doc on stdout, ok:true|false + error, stable
 * snake_case keys, no partial output.
 */
import { describe, expect, test } from "bun:test";
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
  test("no args -> help doc with the four commands", async () => {
    const f = fixture();
    const r = await f.run([]);
    const d = doc(r);
    expect(d.ok).toBe(true);
    expect(d.usage).toBe("jarate <cmd> [args]");
    expect(d.commands).toEqual([
      "ctx-report",
      "journal-errors",
      "memory-grep",
      "rag",
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

  test("unknown profile -> ok:false usage error", async () => {
    const f = fixture();
    const r = await f.run(["ctx-report", "--profile", "bogus"]);
    const d = doc(r);
    expect(d.ok).toBe(false);
    expect(d.error).toContain("profile must be main or worker");
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
    expect(d.since).toBe("-1h");
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
});

describe("memory-grep", () => {
  test("case-insensitive fixed-string search, top-20, match schema", async () => {
    const f = fixture();
    const r = await f.run(["memory-grep", "needle"]);
    const d = doc(r);
    expect(d.ok).toBe(true);
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

  test("missing query / missing root -> ok:false", async () => {
    const f = fixture();
    const r1 = await f.run(["memory-grep"]);
    expect(doc(r1).error).toContain("usage:");
    const r2 = await f.run([
      "memory-grep",
      "x",
      "--root",
      path.join(f.tmp, "nope"),
    ]);
    expect(doc(r2).error).toContain("root not found");
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

  test("missing question -> ok:false usage error", async () => {
    const f = fixture();
    const r = await f.run(["rag"]);
    const d = doc(r);
    expect(d.ok).toBe(false);
    expect(d.error).toContain("usage: jarate rag");
    fs.rmSync(f.tmp, { recursive: true, force: true });
  });
});
