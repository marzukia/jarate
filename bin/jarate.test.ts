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

// cross-user read removed (2026-10-17): the exact error a non-$HOME agent
// home carries. Hall-monitor owns the privileged read (SUDO_PW plan).
const XUSER = "cross-user read removed: use a hall-monitor plan (SUDO_PW)";

describe("entrypoint", () => {
  test("no args -> help doc with the full command list", async () => {
    const f = fixture();
    const r = await f.run([]);
    const d = doc(r);
    expect(d.ok).toBe(true);
    expect(d.error).toBeNull();
    expect(Object.keys(d)).toEqual(["ok", "ts", "error", "usage", "commands"]);
    expect(d.usage).toBe("jarate <cmd> [args]");
    expect(d.commands).toEqual(["setup", "ctx-report", "journal-errors"]);
    fs.rmSync(f.tmp, { recursive: true, force: true });
  });

  test("unknown command -> ok:false + commands list, rc 2", async () => {
    const f = fixture();
    const r = await f.run(["bogus"]);
    expect(r.code).toBe(2);
    const d = doc(r);
    expect(d.ok).toBe(false);
    expect(d.error).toBe("unknown command: bogus");
    expect(d.commands).toContain("journal-errors");
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
    "deploy/jarate-bg-watchdog.service",
    "deploy/jarate-bg-watchdog.timer",
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

    // watchdog units: %h-only templates copied verbatim (no checkout path)
    const wdSvc = fs.readFileSync(
      path.join(ud, "jarate-bg-watchdog.service"),
      "utf8",
    );
    expect(wdSvc).toContain("ExecStart=%h/scripts/jarate-bg-watchdog");
    const wdTmr = fs.readFileSync(
      path.join(ud, "jarate-bg-watchdog.timer"),
      "utf8",
    );
    expect(wdTmr).toContain("OnUnitActiveSec=15min");
    expect(wdTmr).toContain("WantedBy=timers.target");

    // systemctl sequence; loginctl failure is a note, not a failure
    const scLog = fs
      .readFileSync(path.join(f.bin, "systemctl.log"), "utf8")
      .trim()
      .split("\n");
    expect(scLog).toContain("--user daemon-reload");
    expect(scLog).toContain("--user enable --now pi.service");
    expect(scLog).toContain("--user enable --now jarate-deploy.timer");
    expect(scLog).toContain("--user enable --now jarate-bg-watchdog.timer");
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
