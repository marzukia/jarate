/**
 * bin/jarate — JSON entrypoint contract tests (issue #17).
 *
 * Runs the real bash entrypoint against a fake HOME with stubbed externals
 * (pi-token-cost.py, journalctl, getent) and asserts the JSON
 * discipline: exactly one doc on stdout, ok:true|false + error, stable
 * snake_case keys, no partial output. Cross-user reads are gone
 * (2026-10-17, hall-monitor owns the privileged read): a non-$HOME agent
 * home yields an ok:false entry, never a sshpass/sudo hop.
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
  getentPasswd: string;
  getentWheel: string;
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

  // stub getent: canned passwd for the agent-home discovery fallback
  // (JARATE_AGENT_HOMES unset) — hermetic on every machine. The fixture
  // env always sets JARATE_AGENT_HOMES, so discovery does not fire in
  // these tests; the stub keeps the fallback path testable.
  const getentPasswd = path.join(tmp, "getent.passwd");
  const getentWheel = path.join(tmp, "getent.wheel");
  fs.writeFileSync(
    getentPasswd,
    [
      "root:x:0:0:root:/root:/usr/sbin/nologin",
      "operator:x:1000:1000:Operator:/home/operator:/bin/bash",
      "svc:x:1001:1001:svc account:/home/svc:/usr/sbin/nologin",
      "peer-home:x:1002:1002:Peer:/home/peer-home:/bin/bash",
      "",
    ].join("\n"),
  );
  fs.writeFileSync(getentWheel, "wheel:x:10:operator\n");
  const ge = path.join(bin, "getent");
  fs.writeFileSync(
    ge,
    `#!/bin/sh
if [ \${1:-} = "group" ] && [ \${2:-} = "wheel" ]; then
  if [ -f "${getentWheel}" ]; then cat "${getentWheel}"; else exit 2; fi
elif [ \${1:-} = "group" ]; then
  exit 2
elif [ \${1:-} = "passwd" ]; then
  if [ -z \${2:-} ]; then
    cat "${getentPasswd}"
  else
    # per-name lookup (audit F8): answer from the fixture file, rc 2 when
    # the name is absent (real getent contract)
    l="$(awk -F: -v u="$2" '$1==u {print; exit}' "${getentPasswd}")"
    [ -n "$l" ] || exit 2
    printf '%s\n' "$l"
  fi
else
  exit 2
fi
`,
  );
  fs.chmodSync(ge, 0o755);

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
        vllm: { headers: { "X-Switchboard-Context": "262144" } },
      },
    }),
  );

  const env = { ...process.env } as Record<string, string>;
  // Ambient-env hygiene (audit F1): scrub every var the entrypoint reads
  // (JARATE_*, AGENT_SAY_*) before the explicit fixture values below are
  // set, same explicit-scrub pattern as the dispatch #110 fixture. A
  // caller's shell must not flip a test: stray JARATE_* env (e.g.
  // JARATE_SSH_HOST) into the entrypoint.
  for (const k of Object.keys(env)) {
    if (k.startsWith("JARATE_") || k.startsWith("AGENT_SAY_")) {
      delete env[k];
    }
  }
  env.HOME = home;
  env.PATH = `${bin}:${env.PATH ?? ""}`;
  env.XDG_RUNTIME_DIR = path.join(tmp, "xdg");
  env.JARATE_AGENT_HOMES = `${home}:${peerHome}`;
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

  return { tmp, home, bin, env, run, getentPasswd, getentWheel };
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
    expect(d.commands).toContain("projects");
    fs.rmSync(f.tmp, { recursive: true, force: true });
  });

  test("pre-joined args string and split args both work", async () => {
    const f = fixture();
    fs.writeFileSync(path.join(f.home, "AGENTS.md"), "# law\n");
    const joined = await f.run(["agents-bless", "a b"]);
    const split = await f.run(["agents-bless", "a", "b"]);
    expect(doc(joined).note).toBe(doc(split).note);
    expect(doc(joined).note).toBe("a b");
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
  test("self local + peer cross-user entry, stable row schema", async () => {
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
    expect(self.ok).toBe(true);
    expect(self.source).toBe("local");
    expect(self.count).toBe(2);
    expect(self.warnings).toEqual(["W1 first warn", "W2 second warn"]);
    expect(self.error).toBeNull();
    // the peer home is not $HOME: cross-user read removed -> ok:false
    // entry; the run itself stays ok (rc 0)
    expect(peer.ok).toBe(false);
    expect(peer.source).toBe("cross-user");
    expect(peer.count).toBeNull();
    expect(peer.warnings).toBeNull();
    expect(peer.truncated).toBe(false);
    expect(peer.error).toBe(XUSER);
    fs.rmSync(f.tmp, { recursive: true, force: true });
  });

  test("only non-local homes requested -> run still ok (rc 0)", async () => {
    const f = fixture();
    const peerHome = f.env.JARATE_AGENT_HOMES.split(":")[1];
    const r = await f.run(["journal-errors"], { JARATE_AGENT_HOMES: peerHome });
    expect(r.code).toBe(0);
    const d = doc(r);
    expect(d.ok).toBe(true);
    expect(d.agents).toHaveLength(1);
    expect(d.agents[0]).toEqual({
      ok: false,
      name: "peer-home",
      source: "cross-user",
      count: null,
      warnings: null,
      truncated: false,
      error: XUSER,
    });
    fs.rmSync(f.tmp, { recursive: true, force: true });
  });

  test("local journalctl failing -> row error, top-level ok:false, rc 1", async () => {
    const f = fixture();
    fs.writeFileSync(
      path.join(f.bin, "journalctl"),
      "#!/bin/sh\necho 'no systemd' >&2\nexit 1\n",
    );
    fs.chmodSync(path.join(f.bin, "journalctl"), 0o755);
    const r = await f.run(["journal-errors", "--agent", "home"]);
    expect(r.code).toBe(1);
    const d = doc(r);
    expect(d.ok).toBe(false);
    expect(d.error).toContain("home");
    const self = d.agents[0];
    expect(self.source).toBe("local");
    expect(self.warnings).toBeNull();
    expect(self.error).toContain("journalctl failed");
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
    const r = await f.run(["agents-bless", "blessed by operator"]);
    expect(r.code).toBe(0);
    const d = doc(r);
    expect(d.ok).toBe(true);
    expect(d.error).toBeNull();
    expect(d.hash).toBe(sha("# law v1\n"));
    expect(d.note).toBe("blessed by operator");
    // manifest: exactly one line, <sha256>  <ts>  <note>
    const lines = fs.readFileSync(MANIFEST(f), "utf8").split("\n");
    expect(lines).toHaveLength(2); // trailing newline -> last element ""
    const [mh, mts, ...mnote] = lines[0].split("  ");
    expect(mh).toBe(sha("# law v1\n"));
    expect(mts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    expect(mnote.join("  ")).toBe("blessed by operator");
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

// Fake jarate checkout: .git marker + stub install.sh + real deploy unit
// templates (so setup's sed/cp paths exercise production files).
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
        (webhook403 ? `${wh403}; ` : " ") +
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
      `if [ "\${1:-}" = "--user" ] && [ "\${2:-}" = "is-active" ]; then`,
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
    expect(pi).toContain("EnvironmentFile=-%h/.pi/agent/secrets.env");
    expect(pi).toContain(
      "Environment=PATH=%h/.local/bin:%h/bin:%h/scripts:/usr/local/bin:/usr/bin:/bin",
    );
    const jd = fs.readFileSync(path.join(ud, "jarate-deploy.service"), "utf8");
    expect(jd).toContain(`WorkingDirectory=${repo}`);
    expect(jd).toContain(`ExecStart=${repo}/deploy/deploy.sh`);

    // systemctl sequence; loginctl failure is a note, not a failure
    const scLog = fs
      .readFileSync(path.join(f.bin, "systemctl.log"), "utf8")
      .trim()
      .split("\n");
    expect(scLog).toContain("--user daemon-reload");
    expect(scLog).toContain("--user enable --now pi.service");
    expect(scLog).toContain("--user enable --now jarate-deploy.timer");
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

  test("boot gate: already-active service + prior registration passes (no false-fail, #72)", async () => {
    const f = fixture();
    const repo = fakeCheckout(f);
    curlStub(f);
    systemdStubs(f, "active"); // is-active -> active from the start (service was already running)
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
    // Post-#72: an already-active service that has EVER registered passes the
    // gate (the old code required a fresh registration line in the current
    // run's journal, which an already-running service never emits -> false-fail).
    expect(r.code).toBe(0);
    const d = doc(r);
    expect(d.ok).toBe(true);
    expect(d.verified).toBe(true);
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

  test("split args work; pre-joined string is one arg (no re-split)", async () => {
    const f = fixture();
    const repo = fakeCheckout(f);
    curlStub(f);
    // Split args: the correct form. Each flag + value is its own arg.
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
    expect(split.code).toBe(0);
    const ds = doc(split);
    expect(ds.ok).toBe(true);
    expect(ds.agent).toBe("testbot");
    // Pre-joined: a single arg with embedded spaces is ONE arg (not re-split).
    // setup receives it as the bot-token and finds no channel-id -> usage error.
    // This is the post-#72 behavior: the old `read -r -a args <<<"$*"` re-split
    // made this work by accident; the fix (cmd_setup "$@") keeps argv exact,
    // so callers must pass split args.
    const joined = await f.run([
      "setup",
      `aa.bb.cc 123 --owner 456 --name testbot --jarate-dir ${repo}`,
    ]);
    expect(joined.code).toBe(2);
    const dj = doc(joined);
    expect(dj.ok).toBe(false);
    expect(dj.error).toContain("usage");
    fs.rmSync(f.tmp, { recursive: true, force: true });
  });
});

// ─── projects / projects-backfill ───────────────────────────────────────────
// Cross-agent run-record rollup (2026-09-18). Hermetic: fake homes, records
// planted under <home>/.pi-dispatch/runs. Cross-user reads are gone
// (2026-10-17): the peer home is not scanned — it yields an ok:false
// cross-user entry (hall-monitor owns the privileged read now).

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

// cross-user read removed (2026-10-17): the exact error a non-$HOME agent
// home carries. Hall-monitor owns the privileged read (SUDO_PW plan).
const XUSER = "cross-user read removed: use a hall-monitor plan (SUDO_PW)";

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
  };

  test("cross-agent rollup: buckets, token sums, cost null semantics, sort", async () => {
    const f = fixture();
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
    // the peer home is non-local: warn names it, its row is ok:false
    expect(d.warn).toBe("cross-user read removed: peer-home");
    expect(d.agents).toEqual([
      { ok: true, agent: "home", source: "local", scanned: 3, error: null },
      {
        ok: false,
        agent: "peer-home",
        source: "cross-user",
        scanned: null,
        error: XUSER,
      },
    ]);
    // sort: runs desc, then project asc
    expect(d.projects.map((p: any) => p.project)).toEqual([
      "nestfinder",
      "unspecified",
    ]);
    const [nf, un] = d.projects;
    expect(nf).toEqual({
      project: "nestfinder",
      runs: 2,
      workers: 2,
      reviewers: 0,
      tokens: {
        input: 150,
        output: 15,
        cache_read: 5,
        cache_write: 1,
        total: 170,
      },
      // one record unpriced -> the bucket is null, never a partial sum
      cost_usd: null,
      cost_covered: 1,
      first: "2026-09-10T10:00:00Z",
      last: "2026-09-12T10:00:00Z",
    });
    expect(un).toEqual({
      project: "unspecified",
      runs: 1,
      workers: 0,
      reviewers: 1,
      tokens: { input: 0, output: 0, cache_read: 0, cache_write: 0, total: 0 },
      cost_usd: null,
      cost_covered: 0,
      first: "2026-09-11T10:00:00Z",
      last: "2026-09-11T10:00:00Z",
    });
    fs.rmSync(f.tmp, { recursive: true, force: true });
  });

  test("boolean cost_usd is not priced: rollup rejects it (LOW-4)", async () => {
    const f = fixture();
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
        tokens: {
          input: 0,
          output: 0,
          cache_read: 0,
          cache_write: 0,
          total: 0,
        },
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
    seed(f);
    const r = await f.run(["projects", "--since", "2026-09-11"]);
    const d = doc(r);
    expect(d.since).toBe("2026-09-11");
    // aaa (09-10) gone; ccc (09-12) + bbb (09-11) kept
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
    seed(f);
    const r1 = await f.run(["projects", "--agent", "peer-home"]);
    const d1 = doc(r1);
    expect(r1.code).toBe(0);
    // the peer home is non-local: single cross-user entry, no local data
    expect(d1.agents).toEqual([
      {
        ok: false,
        agent: "peer-home",
        source: "cross-user",
        scanned: null,
        error: XUSER,
      },
    ]);
    expect(d1.projects).toEqual([]);
    const r2 = await f.run(["projects", "--agent", "nosuch"]);
    expect(r2.code).toBe(1);
    const d2 = doc(r2);
    expect(d2.ok).toBe(false);
    expect(d2.error).toContain("no agents matched");
    fs.rmSync(f.tmp, { recursive: true, force: true });
  });

  test("peer (non-local) -> row error + warn, local data intact, still ok", async () => {
    const f = fixture();
    seed(f);
    const r = await f.run(["projects"]);
    expect(r.code).toBe(0);
    const d = doc(r);
    expect(d.ok).toBe(true);
    expect(d.warn).toBe("cross-user read removed: peer-home");
    const peer = d.agents.find((a: any) => a.agent === "peer-home");
    expect(peer.scanned).toBeNull();
    expect(peer.error).toBe(XUSER);
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
    const r = await f.run(["projects"]);
    expect(r.code).toBe(0);
    const d = doc(r);
    expect(d.ok).toBe(true);
    expect(d.projects).toEqual([]);
    // local home scanned 0; the non-local peer is null, not 0
    expect(d.agents.map((a: any) => a.scanned)).toEqual([0, null]);
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
    expect(peer).toEqual({
      ok: false,
      agent: "peer-home",
      source: "cross-user",
      scanned: null,
      tagged: null,
      skipped: null,
      map: null,
      error: XUSER,
    });
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

  test("frank home (non-local) -> cross-user entry; --agent narrows", async () => {
    const f = fixture();
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
    // the frank home is not $HOME: cross-user read removed — its record is
    // not touched (no tag written), the row is ok:false, the run stays ok
    const frank = d.agents.find((a: any) => a.agent === "frank");
    expect(frank).toEqual({
      ok: false,
      agent: "frank",
      source: "cross-user",
      scanned: null,
      tagged: null,
      skipped: null,
      map: null,
      error: XUSER,
    });
    expect("project" in readRecord(frankHome, "pi-bg-f1.json")).toBe(false);
    const local = d.agents.find((a: any) => a.agent === "home");
    expect(local.ok).toBe(true);
    expect(local.map).toEqual([
      { run: "l1", project: "unspecified", source: "default" },
    ]);
    // --agent narrows to the frank home only: zeroed totals, still ok
    const r2 = await f.run(["projects-backfill", "--agent", "frank"], {
      JARATE_AGENT_HOMES: homes,
    });
    const d2 = doc(r2);
    expect(r2.code).toBe(0);
    expect(d2.agents).toHaveLength(1);
    expect(d2.agents[0].agent).toBe("frank");
    expect(d2.total).toEqual({ scanned: 0, tagged: 0, skipped: 0 });
    const r3 = await f.run(["projects-backfill", "--agent", "nosuch"], {
      JARATE_AGENT_HOMES: homes,
    });
    expect(r3.code).toBe(1);
    expect(doc(r3).error).toContain("no agents matched");
    fs.rmSync(f.tmp, { recursive: true, force: true });
  });

  test("peer (non-local) -> row error, totals count the local agent only", async () => {
    const f = fixture();
    seedLocal(f);
    // a record planted in the peer home: inert, never scanned
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
    expect(peer.ok).toBe(false);
    expect(peer.scanned).toBeNull();
    expect(peer.error).toBe(XUSER);
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

// ─── #148 one flag grammar: --flag=value parity ────────────────────────────
// The bridge now re-splits the tool args string (shellWords), so the
// entrypoint sees real argv; --flag=value is desugared at the first '=' in
// every value-bearing flag. These tests pin both halves of the contract.
describe("#148 --flag=value (one flag grammar)", () => {
  test("journal-errors --since= T form (value flag reachable)", async () => {
    const f = fixture();
    const r = await f.run(["journal-errors", "--since=2026-09-13T00:00:00Z"]);
    expect(r.code).toBe(0);
    expect(doc(r).since).toBe("2026-09-13T00:00:00Z");
    fs.rmSync(f.tmp, { recursive: true, force: true });
  });

  test("journal-errors --since=YYYY-MM-DD + bare time word still re-joins", async () => {
    const f = fixture();
    const r = await f.run(["journal-errors", "--since=2026-09-13", "00:00:00"]);
    expect(r.code).toBe(0);
    expect(doc(r).since).toBe("2026-09-13 00:00:00");
    fs.rmSync(f.tmp, { recursive: true, force: true });
  });

  test("journal-errors --agent= and --since= together", async () => {
    const f = fixture();
    const r = await f.run([
      "journal-errors",
      "--agent=peer-home",
      "--since=2026-09-13T00:00:00Z",
    ]);
    const d = doc(r);
    expect(d.since).toBe("2026-09-13T00:00:00Z");
    expect(d.agents).toHaveLength(1);
    expect(d.agents[0].name).toBe("peer-home");
    fs.rmSync(f.tmp, { recursive: true, force: true });
  });

  test("ctx-report --profile=worker", async () => {
    const f = fixture();
    const r = await f.run(["ctx-report", "--profile=worker"]);
    expect(r.code).toBe(0);
    expect(doc(r).profile).toBe("worker");
    fs.rmSync(f.tmp, { recursive: true, force: true });
  });

  test("projects --project= / --since= / --agent= parity with two-word form", async () => {
    const f = fixture();
    plantRecord(f.home, "pi-bg-aaa.json", {
      run: "aaa",
      profile: "worker",
      project: "nestfinder",
      started: "2026-09-10T10:00:00Z",
    });
    plantRecord(f.home, "pi-bg-bbb.json", {
      run: "bbb",
      profile: "worker",
      project: "jarate",
      started: "2026-09-11T10:00:00Z",
    });
    const r = await f.run([
      "projects",
      "--project=nestfinder",
      "--since=2026-09-01",
      "--agent=home",
    ]);
    expect(r.code).toBe(0);
    const d = doc(r);
    expect(d.ok).toBe(true);
    expect(d.projects.map((p: any) => p.project)).toEqual(["nestfinder"]);
    expect(d.agents.map((a: any) => a.agent)).toEqual(["home"]);
    fs.rmSync(f.tmp, { recursive: true, force: true });
  });

  test("projects-backfill --set=run=tag splits at the FIRST =", async () => {
    const f = fixture();
    plantRecord(f.home, "pi-bg-r1.json", {
      run: "r1",
      profile: "worker",
      cwd: "/tmp/elsewhere",
      started: "2026-09-03T00:00:00Z",
    });
    const r = await f.run([
      "projects-backfill",
      "--dry-run",
      "--set=r1=nestfinder",
    ]);
    expect(r.code).toBe(0);
    const d = doc(r);
    expect(d.ok).toBe(true);
    const local = d.agents.find((a: any) => a.agent === "home");
    expect(local.map).toEqual([
      { run: "r1", project: "nestfinder", source: "set" },
    ]);
    fs.rmSync(f.tmp, { recursive: true, force: true });
  });

  test("unknown --flag= stays an unknown-arg usage error (known flags only)", async () => {
    const f = fixture();
    const r1 = await f.run(["journal-errors", "--bogus=x"]);
    expect(r1.code).toBe(2);
    expect(doc(r1).error).toContain("unknown arg: --bogus=x");
    const r2 = await f.run(["ctx-report", "--bogus=1"]);
    expect(r2.code).toBe(2);
    expect(doc(r2).error).toContain("unknown arg: --bogus=1");
    fs.rmSync(f.tmp, { recursive: true, force: true });
  });
});
// ─── local-only (2026-10-17): cross-user read removed ──────────────────────
// Hall-monitor owns credentials + privileged exec now. The sshpass/sudo hop
// (JARATE_SSH_HOST/JARATE_SUDO_PASS) is gone from the entrypoint: the fixture
// carries no ssh machinery at all (no sshpass stub, no sudo password) — a
// stray hop attempt would fail visibly.
describe("local-only (cross-user read removed)", () => {
  test("projects: peer record is inert — local rollup only, warn names peer", async () => {
    const f = fixture();
    plantRecord(f.home, "pi-bg-x1.json", {
      run: "x1",
      profile: "worker",
      project: "nestfinder",
      started: "2026-09-10T10:00:00Z",
      tokens: { input: 5, output: 1, cacheRead: 0, cacheWrite: 0, total: 6 },
      cost_usd: 0.01,
    });
    plantRecord(f.env.JARATE_AGENT_HOMES.split(":")[1], "pi-bg-x2.json", {
      run: "x2",
      profile: "worker",
      project: "jarate",
      started: "2026-09-10T10:00:00Z",
      tokens: { input: 5, output: 1, cacheRead: 0, cacheWrite: 0, total: 6 },
      cost_usd: 0.01,
    });
    const r = await f.run(["projects"]);
    expect(r.code).toBe(0);
    const d = doc(r);
    expect(d.ok).toBe(true);
    expect(d.warn).toBe("cross-user read removed: peer-home");
    // the peer record (project "jarate") is NOT in the rollup
    expect(d.projects.map((p: any) => p.project)).toEqual(["nestfinder"]);
    expect(d.projects[0].runs).toBe(1);
    const peer = d.agents.find((a: any) => a.agent === "peer-home");
    expect(peer.ok).toBe(false);
    expect(peer.source).toBe("cross-user");
    expect(peer.scanned).toBeNull();
    expect(peer.error).toBe(XUSER);
    fs.rmSync(f.tmp, { recursive: true, force: true });
  });

  test("projects-backfill: peer record stays untouched, totals local-only", async () => {
    const f = fixture();
    plantRecord(f.home, "pi-bg-b1.json", {
      run: "b1",
      profile: "worker",
      cwd: "/tmp/x",
      started: "2026-09-01T00:00:00Z",
    });
    const peerHome = f.env.JARATE_AGENT_HOMES.split(":")[1];
    plantRecord(peerHome, "pi-bg-b2.json", {
      run: "b2",
      profile: "worker",
      cwd: "/tmp/y",
      started: "2026-09-01T00:00:00Z",
    });
    const before = fs.readFileSync(
      path.join(peerHome, ".pi-dispatch", "runs", "pi-bg-b2.json"),
      "utf8",
    );
    const r = await f.run(["projects-backfill"]);
    expect(r.code).toBe(0);
    const d = doc(r);
    expect(d.ok).toBe(true);
    expect(d.total).toEqual({ scanned: 1, tagged: 1, skipped: 0 });
    const peer = d.agents.find((a: any) => a.agent === "peer-home");
    expect(peer.ok).toBe(false);
    expect(peer.map).toBeNull();
    expect(peer.error).toBe(XUSER);
    // the peer record was not tagged (no cross-user write)
    expect(
      fs.readFileSync(
        path.join(peerHome, ".pi-dispatch", "runs", "pi-bg-b2.json"),
        "utf8",
      ),
    ).toBe(before);
    fs.rmSync(f.tmp, { recursive: true, force: true });
  });
});
