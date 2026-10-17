/**
 * deploy/deploy.sh — SIGTERM fail-recording (issue #235, deploy tick
 * livelock).
 *
 * The 30s tick runs the full pre-deploy gate (bun install, install.sh,
 * typecheck, test). Under box load the gate can outlast the unit's
 * TimeoutStartSec; systemd then kills the tick's cgroup with SIGTERM
 * mid-gate. Before the fix the untrapped TERM exited the shell without
 * running the EXIT trap, so record_fail never fired and the 3-fail backoff
 * never accumulated: the next tick (~30s) restarted the same gate, forever.
 *
 * Two layers of proof:
 *
 * 1. End-to-end: runs the real deploy.sh against a fake HOME + a local git
 *    origin with a stubbed bun, SIGTERMs the whole process group (the
 *    systemd cgroup kill), asserts on .deploy-state (line 2 =
 *    "<failed-commit> <consecutive-fails>"):
 *      - TERM mid-gate records EXACTLY one fail (counter 0->1, not 0->2:
 *        the TERM trap clears the EXIT trap, so the resulting shell exit
 *        does not re-record). The post-kill log lines are absent by
 *        design: the cgroup TERM kills the log `tee` too, so everything
 *        written after the kill is lost; the state file is the record.
 *      - the EXIT-only path still records exactly once on a nonzero exit
 *        (regression guard; the tee is alive there, so the log line shows).
 *      - after 3 fails (TERM + EXIT mixed), the next tick backs off BEFORE
 *        running the gate (the livelock is closed).
 *
 * 2. Sourced harness (task spec for the ec=143 proof): evals the REAL
 *    on_exit + REAL trap arming extracted verbatim from deploy.sh, stubs
 *    record_fail/log/state_* to append to temp files, sets DEPLOY_TRIED /
 *    DEPLOY_PREV, SIGTERMs the subshell, and asserts record_fail was called
 *    exactly once with ec=143 (a wrapper logs the $1 the real on_exit
 *    receives); the EXIT-only path records once on nonzero exit, zero on
 *    zero; an early TERM (DEPLOY_TRIED empty) no-ops via the existing guard.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "bun";

const DEPLOY = path.join(import.meta.dir, "deploy.sh");

// Leak guard: every fixture mkdtemp dir is tracked and force-removed in a
// file-level afterEach, so a failed or aborted test cannot leave dirs in /tmp.
const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const countOf = (s: string, needle: string) => s.split(needle).length - 1;

const revParse = (repo: string, ref: string) =>
  execSync(`git -C "${repo}" rev-parse "${ref}"`, {
    encoding: "utf8",
  }).trim();

const read = (p: string) =>
  fs.existsSync(p) ? fs.readFileSync(p, "utf8") : "";

interface RunResult {
  code: number;
  out: string;
  err: string;
}

/**
 * The sourced-harness script. $1 = tmp dir, $2 = deploy.sh path,
 * $3 = scenario (term | term-early | exit-nonzero | exit-zero).
 * Tests the REAL on_exit + REAL traps (sed range covers the on_exit
 * definition through the TERM trap line), with the side effects stubbed.
 */
const HARNESS = `#!/usr/bin/env bash
set -euo pipefail
T="$1"
SRC="$2"
SCENARIO="$3"

block="$(sed -n '/^  on_exit() {/,/^  trap .ec=/p' "$SRC")"
[[ -n "$block" ]] || { echo "harness: extraction from deploy.sh failed" >&2; exit 90; }
eval "$block"

# stub the side effects to append to temp files
record_fail() { echo "record_fail tried=$1 deployed_after=$2" >> "$T/rec"; }
log() { echo "log: $*" >> "$T/hlog"; }
state_fail_count() { printf '1'; }

# observe the ec the REAL on_exit receives: $1 under TERM (passed by the
# TERM trap); on the EXIT path the wrapper captures $? and passes it the
# same way (its own commands would otherwise clobber $?) before the real
# on_exit reads it
real_on_exit="$(declare -f on_exit)"
on_exit() {
  local ec0=$?
  if [[ -n "\${1:-}" ]]; then ec0=$1; fi
  echo "ec=$ec0" >> "$T/ec"
  eval "$real_on_exit"
  on_exit "$ec0"
}

case "$SCENARIO" in
  term)
    DEPLOY_TRIED=commitB
    DEPLOY_PREV=commitA
    ;;
  term-early)
    # trap armed, but the gate has not started (DEPLOY_TRIED still empty)
    DEPLOY_TRIED=""
    DEPLOY_PREV=commitA
    ;;
  exit-nonzero)
    DEPLOY_TRIED=commitB
    DEPLOY_PREV=commitA
    exit 5
    ;;
  exit-zero)
    DEPLOY_TRIED=commitB
    DEPLOY_PREV=commitA
    exit 0
    ;;
esac
touch "$T/ready"
sleep 30
`;

interface Fixture {
  a: string; // deployed commit (local main)
  b: string; // incoming commit (origin/main only)
  state: () => string;
  /** .deploy-state line 2 ("<commit> <fails>"), "" when absent */
  failLine: () => string;
  markerPath: string;
  logText: () => string;
  /** logText after letting the script's `tee -a $LOG_FILE` flush */
  log: () => Promise<string>;
  run: (opts?: {
    mode?: "hang" | "fail";
    termOnMarker?: boolean;
  }) => Promise<RunResult>;
  /** run the sourced harness; term scenarios are SIGTERM'd as a process group */
  harness: (
    scenario: "term" | "term-early" | "exit-nonzero" | "exit-zero",
  ) => Promise<RunResult>;
  harnessFile: (name: string) => string;
}

function fixture(): Fixture {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jarate-deploy-test-"));
  tmpDirs.push(tmp);
  const home = path.join(tmp, "home");
  const bunBin = path.join(home, ".bun", "bin");
  const xdg = path.join(tmp, "xdg");
  const repo = path.join(tmp, "repo");
  const origin = path.join(tmp, "origin.git");
  const lock = path.join(tmp, "deploy.lock");
  const markerPath = path.join(tmp, "bun-typecheck-marker");
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(bunBin, { recursive: true });
  fs.mkdirSync(xdg, { recursive: true });

  // Local git origin: main = A locally, B on origin (one pending roll).
  execSync(`git init --bare -q -b main "${origin}"`);
  execSync(`git init -q -b main "${repo}"`);
  execSync(
    `git -C "${repo}" config user.email deploy@test && ` +
      `git -C "${repo}" config user.name deploy-test && ` +
      `git -C "${repo}" config commit.gpgsign false`,
  );
  execSync(
    `printf 'a\\n' > "${repo}/f" && ` +
      `git -C "${repo}" add f && ` +
      `git -C "${repo}" commit -qm A && ` +
      `git -C "${repo}" remote add origin "${origin}" && ` +
      `git -C "${repo}" push -q origin HEAD:main`,
  );
  execSync(
    `git -C "${repo}" checkout -qb wip && ` +
      `printf 'b\\n' >> "${repo}/f" && ` +
      `git -C "${repo}" commit -qam B && ` +
      `git -C "${repo}" push -q origin wip:main && ` +
      `git -C "${repo}" checkout -q main`,
  );
  const a = revParse(repo, "main");
  const b = revParse(repo, "origin/main");

  // State: A deployed, no fails yet. install.sh stub (deploy.sh runs
  // `bash $REPO/install.sh --jarate-dir $REPO` for the machine links).
  fs.writeFileSync(path.join(repo, ".deploy-state"), `${a}\n`);
  fs.writeFileSync(
    path.join(repo, "install.sh"),
    "#!/usr/bin/env bash\nexit 0\n",
  );

  // bun stub: deploy.sh prepends $HOME/.bun/bin to PATH. mode via env:
  // "fail" = typecheck exits 3; "hang" = reach typecheck, mark, sleep 30.
  fs.writeFileSync(
    path.join(bunBin, "bun"),
    [
      "#!/bin/sh",
      'case "$1" in',
      "  install) exit 0;;",
      "  run)",
      '    case "$2" in',
      "      typecheck)",
      '        echo t >> "$DEPLOY_TEST_BUN_MARK"',
      '        if [ "$DEPLOY_TEST_BUN_MODE" = "hang" ]; then',
      "          sleep 30",
      "        else",
      "          exit 3",
      "        fi",
      "        ;;",
      "    esac",
      "    ;;",
      "esac",
      "exit 0",
      "",
    ].join("\n"),
  );
  fs.chmodSync(path.join(bunBin, "bun"), 0o755);

  const env = { ...process.env } as Record<string, string>;
  env.HOME = home;
  env.JARATE_HOME = repo;
  env.JARATE_DEPLOY_LOCK = lock;
  env.JARATE_DEPLOY_SERVICE = "fake.service";
  env.XDG_RUNTIME_DIR = xdg;
  env.DEPLOY_TEST_BUN_MARK = markerPath;
  env.DEPLOY_TEST_BUN_MODE = "fail";

  const state = () => fs.readFileSync(path.join(repo, ".deploy-state"), "utf8");
  const failLine = () => state().trim().split("\n")[1] ?? "";

  const logText = () => {
    const dir = path.join(home, ".local", "share", "jarate", "logs");
    if (!fs.existsSync(dir)) return "";
    return fs
      .readdirSync(dir)
      .filter((f) => f.startsWith("deploy-"))
      .sort()
      .map((f) => fs.readFileSync(path.join(dir, f), "utf8"))
      .join("\n");
  };
  // deploy.sh tees stdout to a log file; the tee child can lag the parent's
  // exit, so settle before reading.
  const log = async () => {
    await sleep(300);
    return logText();
  };

  const waitFor = async (p: string, timeoutMs: number) => {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      if (fs.existsSync(p)) return true;
      await sleep(50);
    }
    return fs.existsSync(p);
  };

  const spawnAndKill = async (
    cmd: string[],
    readyPath: string,
    term: boolean,
  ): Promise<RunResult> => {
    // detached: own process group, so a TERM can hit the whole tree
    // (deploy.sh + stub bun + sleep) like a systemd cgroup kill.
    const p = spawn(cmd, {
      env,
      cwd: tmp,
      detached: true,
      stdout: "pipe",
      stderr: "pipe",
    });
    const outP = new Response(p.stdout).text();
    const errP = new Response(p.stderr).text();
    if (term) {
      // Wait until the child has reached the kill point, then SIGTERM the
      // whole group (systemd TimeoutStartSec kill).
      if (!(await waitFor(readyPath, 15000))) {
        try {
          process.kill(-p.pid, "SIGKILL");
        } catch {
          // already dead
        }
        throw new Error("child never reached the kill point");
      }
      process.kill(-p.pid, "SIGTERM");
    }
    const code = await p.exited;
    const [out, err] = await Promise.all([outP, errP]);
    return { code, out, err };
  };

  const run = (opts?: { mode?: "hang" | "fail"; termOnMarker?: boolean }) => {
    env.DEPLOY_TEST_BUN_MODE = opts?.mode ?? "fail";
    fs.rmSync(markerPath, { force: true });
    return spawnAndKill(
      ["bash", DEPLOY],
      markerPath,
      opts?.termOnMarker ?? false,
    );
  };

  const harness = (
    scenario: "term" | "term-early" | "exit-nonzero" | "exit-zero",
  ) => {
    fs.rmSync(path.join(tmp, "ready"), { force: true });
    fs.rmSync(path.join(tmp, "rec"), { force: true });
    fs.rmSync(path.join(tmp, "ec"), { force: true });
    fs.rmSync(path.join(tmp, "hlog"), { force: true });
    return spawnAndKill(
      ["bash", path.join(tmp, "harness.sh"), tmp, DEPLOY, scenario],
      path.join(tmp, "ready"),
      scenario.startsWith("term"),
    );
  };
  const harnessFile = (name: string) => path.join(tmp, name);

  fs.writeFileSync(path.join(tmp, "harness.sh"), HARNESS);
  fs.chmodSync(path.join(tmp, "harness.sh"), 0o755);

  return {
    a,
    b,
    state,
    failLine,
    markerPath,
    logText,
    log,
    run,
    harness,
    harnessFile,
  };
}

describe("deploy.sh #235: SIGTERM kill records the fail (no livelock)", () => {
  test("TERM mid-gate (cgroup kill): exactly one fail recorded, not two", async () => {
    const f = fixture();
    const r = await f.run({ mode: "hang", termOnMarker: true });
    // TERM trap records, then bash resumes the `|| die` list -> exit 1.
    expect(r.code).toBe(1);
    // Exactly one fail recorded: counter 0->1, not 0->2. If the EXIT trap
    // had not been cleared by the TERM trap, the resulting shell exit would
    // have re-fired on_exit and bumped it to 2.
    expect(f.state()).toBe(`${f.a}\n${f.b} 1\n`);
    // The pre-kill lines made it to the log; the post-kill ones (record +
    // die) cannot: the cgroup TERM kills the log tee too (EPIPE, ignored by
    // the `trap '' PIPE` added in #235), so the state file is the record.
    const t = await f.log();
    expect(t).toContain(`deploying ${f.a} -> ${f.b}`);
  });

  test("EXIT-only path unchanged: nonzero exit records exactly once", async () => {
    const f = fixture();
    const r = await f.run({ mode: "fail" });
    expect(r.code).toBe(1);
    expect(f.state()).toBe(`${f.a}\n${f.b} 1\n`);
    const t = await f.log();
    expect(countOf(t, "recorded fail #")).toBe(1);
    expect(t).toContain(`recorded fail #1 on ${f.b}`);
  });

  test("3 fails (TERM + EXIT mixed) -> next tick backs off, gate not re-run", async () => {
    const f = fixture();
    // #1: the systemd timeout kill (the #235 livelock trigger)
    await f.run({ mode: "hang", termOnMarker: true });
    expect(f.failLine()).toBe(`${f.b} 1`);
    // #2 + #3: ordinary gate failures
    await f.run({ mode: "fail" });
    expect(f.failLine()).toBe(`${f.b} 2`);
    await f.run({ mode: "fail" });
    expect(f.failLine()).toBe(`${f.b} 3`);
    // Tick 4: mode "hang" would wedge in typecheck if the gate re-ran; the
    // backoff must short-circuit first (exit 0, before any bun call).
    const r = await f.run({ mode: "hang" });
    expect(r.code).toBe(0);
    const t = await f.log();
    expect(t).toContain(`backoff: 3 consecutive fails on ${f.b}`);
    expect(fs.existsSync(f.markerPath)).toBe(false); // bun never reached
  });
});

describe("deploy.sh #235: sourced harness (real on_exit + real traps, ec=143)", () => {
  test("TERM: record_fail exactly once, on_exit receives ec=143", async () => {
    const f = fixture();
    const r = await f.harness("term");
    // bare `sleep 30` + set -e: after the TERM trap, the shell exits 143
    // with the EXIT trap already cleared by the TERM trap.
    expect(r.code).toBe(143);
    expect(read(f.harnessFile("ec"))).toBe("ec=143\n");
    const rec = read(f.harnessFile("rec"));
    expect(rec).toBe("record_fail tried=commitB deployed_after=commitA\n");
    // exactly ONE record: the cleared EXIT trap did not re-fire on exit
    expect(countOf(rec, "record_fail")).toBe(1);
    // the stub log confirms on_exit took the record branch once
    expect(countOf(read(f.harnessFile("hlog")), "recorded fail #")).toBe(1);
  });

  test("early TERM (DEPLOY_TRIED empty): trap runs, guard no-ops", async () => {
    const f = fixture();
    const r = await f.harness("term-early");
    expect(r.code).toBe(143);
    expect(read(f.harnessFile("ec"))).toBe("ec=143\n"); // trap fired
    expect(read(f.harnessFile("rec"))).toBe(""); // no record
  });

  test("EXIT-only: records once on nonzero exit, zero on zero exit", async () => {
    const f = fixture();
    const nz = await f.harness("exit-nonzero");
    expect(nz.code).toBe(5);
    expect(read(f.harnessFile("rec"))).toBe(
      "record_fail tried=commitB deployed_after=commitA\n",
    );
    const z = await f.harness("exit-zero");
    expect(z.code).toBe(0);
    expect(read(f.harnessFile("rec"))).toBe("");
  });
});
