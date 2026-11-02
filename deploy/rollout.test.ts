/**
 * deploy/jarate-rollout.sh — fleet-wide rollout (#314, G4 of P1 #322), pure-helper tests.
 *
 * Sourced-harness pattern (task spec, same as deploy.test.ts): the REAL validate_hm_base / resolve_key_file / first_key_line / classify_lane / wait_marker / enumerate_agents / smoke_target are extracted verbatim from jarate-rollout.sh (sed range over the function bodies) and eval'd in a stubbed subshell, so the tests exercise the script's own code — a rename or logic change in the script is what the tests catch (an extraction failure exits 90).
 *
 * The cross-user flow (sudo, systemctl, curl) is operator-run (vault plan); only the pure helpers are tested here.
 */
import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "bun";

const ROLLOUT = path.join(import.meta.dir, "jarate-rollout.sh");

// Leak guard: every fixture mkdtemp dir is tracked and force-removed in a file-level afterEach, so a failed or aborted test cannot leave dirs in /tmp.
const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

/** The sourced-harness script. $1 = tmp dir, $2 = jarate-rollout.sh path, $3 = scenario. Extracts the REAL helper bodies from the script and evals them, then runs the scenario's invocations, recording the results in $T/out (one per line). */
const HARNESS = `#!/usr/bin/env bash
set -euo pipefail
T="$1"
SRC="$2"
CASE="$3"
LAPSED_S="\${LAPSED_S:-300}"

extract() { sed -n "$1" "$SRC"; }
eval "$(extract '/^validate_hm_base() {/,/^}/p')"
eval "$(extract '/^resolve_key_file() {/,/^}/p')"
eval "$(extract '/^classify_lane() {/,/^}/p')"
eval "$(extract '/^first_key_line() {/,/^}/p')"
eval "$(extract '/^wait_marker() {/,/^}/p')"
eval "$(extract '/^enumerate_agents() {/,/^}/p')"
eval "$(extract '/^smoke_target() {/,/^}/p')"
for fn in validate_hm_base resolve_key_file classify_lane first_key_line wait_marker enumerate_agents smoke_target; do
  declare -f "$fn" >/dev/null || { echo "harness: extraction of $fn from jarate-rollout.sh failed" >&2; exit 90; }
done

case "$CASE" in
  vhb)
    for base in "http://127.0.0.1:8001" "https://hall" "http://10.1.2.3" "https://h.example:443"; do
      validate_hm_base "$base" && echo "ok $base" || echo "bad $base"
    done
    for base in "" "ftp://x" "http://127.0.0.1:8001/" "http://x/path" "http://x:9999/"; do
      validate_hm_base "$base" && echo "ok \${base:-EMPTY}" || echo "bad \${base:-EMPTY}"
    done
    ;;
  keyline)
    f="$T/key"
    printf '# comment\\n\\n  # indented\\n  the-key  \\nnext\\n' >"$f"
    first_key_line "$f" >"$T/kout" 2>/dev/null && echo "exit 0" || echo "exit 1"
    cat "$T/kout"
    first_key_line "$T/no-such-file" >/dev/null 2>&1 && echo "missing exit 0" || echo "missing exit 1"
    printf '# only comments\\n\\n# more\\n' >"$T/key2"
    first_key_line "$T/key2" >/dev/null 2>&1 && echo "onlycomments exit 0" || echo "onlycomments exit 1"
    printf '# onboarding key file\\nBASE_URL=http://10.1.2.3:8001\\nX_AGENT_KEY=  agentkey-padded  \\n' >"$T/key3"
    first_key_line "$T/key3" >"$T/k3" 2>/dev/null && echo "newformat exit 0" || echo "newformat exit 1"
    cat "$T/k3"
    printf 'BASE_URL=http://10.1.2.3:8001\\nhm_agent_abc123\\n' >"$T/key4"
    first_key_line "$T/key4" >"$T/k4" 2>/dev/null && echo "hmagent exit 0" || echo "hmagent exit 1"
    cat "$T/k4"
    ;;
  keyresolve)
    mkdir -p "$T/h1/.config/hall-monitor" "$T/h2/.config/hall-monitor" "$T/h3"
    touch "$T/h1/.config/hall-monitor/agent-key" "$T/h1/.config/hall-monitor/key" "$T/h1/hall-monitor.key"
    touch "$T/h2/.config/hall-monitor/key" "$T/h2/hall-monitor.key"
    touch "$T/h3/hall-monitor.key"
    resolve_key_file "$T/h1" | sed "s|^$T/||"
    resolve_key_file "$T/h2" | sed "s|^$T/||"
    resolve_key_file "$T/h3" | sed "s|^$T/||"
    resolve_key_file "$T/hnone" >/dev/null 2>&1 && echo "none exit 0" || echo "none exit 1"
    ;;
  lane)
    # The full lane matrix (key check runs FIRST: a stale marker on a no-key user is the no-key skip, never lapsed; missing marker = fresh, operator ruling 2026-11-02). Marker age is a numeric input (the main loop reads it from the live marker's mtime); the fixtures fix only checkout + key presence.
    mkdir -p "$T/h_ckptkey/projects/jarate" "$T/h_ckptkey/.config/hall-monitor" "$T/h_ckpt/projects/jarate" "$T/h_key/.config/hall-monitor"
    touch "$T/h_ckptkey/projects/jarate/.git" "$T/h_ckptkey/.config/hall-monitor/agent-key" "$T/h_ckpt/projects/jarate/.git" "$T/h_key/.config/hall-monitor/key"
    classify_lane "$T/h_ckptkey" 10
    classify_lane "$T/h_ckptkey" "$(( 2 * LAPSED_S ))"
    classify_lane "$T/h_ckpt" "$(( 2 * LAPSED_S ))"
    classify_lane "$T/h_ckpt" 10
    classify_lane "$T/h_ckptkey" missing
    classify_lane "$T/h_key" 10
    classify_lane "$T/h_none" 10
    ;;
  laneorder)
    # passwd-order determinism: classification output follows the (deliberately unsorted) input order, the main loop's iteration order (with an explicit fresh marker age on every lane).
    mkdir -p "$T/b/projects/jarate" "$T/b/.config/hall-monitor" "$T/a" "$T/c/projects/jarate" "$T/c/.config/hall-monitor" "$T/d/projects/jarate"
    touch "$T/b/projects/jarate/.git" "$T/b/.config/hall-monitor/key" "$T/c/projects/jarate/.git" "$T/c/.config/hall-monitor/agent-key" "$T/d/projects/jarate/.git"
    for h in "$T/d" "$T/a" "$T/c" "$T/b"; do printf '%s ' "$(classify_lane "$h" 10)"; done
    echo
    ;;
  enum)
    pf="$T/passwd"
    {
      echo "root:x:0:0:root:/root:/bin/bash"
      echo "alice:x:1000:1000::/home/alice:/bin/bash"
      echo "nobody1:x:1001:1001::/home/nobody1:/usr/sbin/nologin"
      echo "bob:x:1002:1002::/home/bob:/bin/zsh"
      echo "svc:x:1003:1003::/home/svc:/bin/false"
      echo "carol:x:1004:1004::/home/carol:/bin/sh"
      echo "dave:x:1005:1005::/home/dave:/usr/bin/dash"
    } >"$pf"
    enumerate_agents "$pf"
    ;;
  smoketarget)
    # #332: the smoke-say recipient is 'warden' EXCEPT on the warden lane itself, which self-says (the say edge 400s) and targets 'piboy' instead.
    smoke_target warden
    smoke_target frank
    smoke_target piboy
    ;;
  waitpos)
    d="$T/live"
    mkdir -p "$d"
    bar=$(( $(date +%s) - 5 ))
    ( sleep 1; touch "$d/42" ) >/dev/null 2>&1 &
    wait_marker "$d" 42 "$bar" 30 && echo "rc=0" || echo "rc=1"
    ;;
  waitneg)
    d="$T/live"
    mkdir -p "$d"
    bar="$(date +%s)"
    touch "$d/42" # an OLD marker: mtime <= bar, must not satisfy
    t0=$(date +%s)
    wait_marker "$d" 42 "$bar" 2 && echo "rc=0" || echo "rc=1"
    echo "elapsed=$(( $(date +%s) - t0 ))"
    ;;
esac
`;

/** Run the harness for a scenario; returns { code, out, err }. */
function runCase(
  caseName: string,
  prep?: (tmp: string) => void,
): Promise<{ code: number; out: string; err: string }> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jarate-rollout-test-"));
  tmpDirs.push(tmp);
  fs.writeFileSync(path.join(tmp, "harness.sh"), HARNESS);
  fs.chmodSync(path.join(tmp, "harness.sh"), 0o755);
  prep?.(tmp);
  const p = spawn(
    ["bash", path.join(tmp, "harness.sh"), tmp, ROLLOUT, caseName],
    {
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const outP = new Response(p.stdout).text();
  const errP = new Response(p.stderr).text();
  const codeP = p.exited;
  return (async () => {
    const code = await codeP;
    const [out, err] = await Promise.all([outP, errP]);
    return { code, out, err };
  })();
}

describe("jarate-rollout.sh: validate_hm_base (no default, strict shape)", () => {
  test("host[:port] bases pass; empty / wrong-scheme / path / trailing-slash fail", async () => {
    const r = await runCase("vhb");
    expect(r.code).toBe(0);
    const lines = r.out.trim().split("\n");
    expect(lines).toEqual([
      "ok http://127.0.0.1:8001",
      "ok https://hall",
      "ok http://10.1.2.3",
      "ok https://h.example:443",
      "bad EMPTY",
      "bad ftp://x",
      "bad http://127.0.0.1:8001/",
      "bad http://x/path",
      "bad http://x:9999/",
    ]);
  });
});

describe("jarate-rollout.sh: first_key_line (the agent-key file shape)", () => {
  test("legacy bare-key: the first non-comment, non-blank line wins; X_AGENT_KEY= (value trimmed) / hm_agent_ lines win (onboarding format); missing / comment-only files fail", async () => {
    const r = await runCase("keyline");
    expect(r.code).toBe(0);
    const lines = r.out.trim().split("\n");
    expect(lines).toEqual([
      "exit 0",
      "the-key",
      "missing exit 1",
      "onlycomments exit 1",
      "newformat exit 0",
      "agentkey-padded",
      "hmagent exit 0",
      "hm_agent_abc123",
    ]);
  });
});

describe("jarate-rollout.sh: resolve_key_file (the fleet agent-key path chain)", () => {
  test("first existing candidate wins (agent-key -> key -> hall-monitor.key); none existing fails", async () => {
    const r = await runCase("keyresolve");
    expect(r.code).toBe(0);
    const lines = r.out.trim().split("\n");
    expect(lines).toEqual([
      "h1/.config/hall-monitor/agent-key",
      "h2/.config/hall-monitor/key",
      "h3/hall-monitor.key",
      "none exit 1",
    ]);
  });
});

describe("jarate-rollout.sh: classify_lane (the fleet lane set + lapsed-lane visible skip, #326)", () => {
  test("(fresh marker, key, checkout)=roll; (stale marker, key, checkout)=lapsed-skip; (stale marker, no key)=skip-no-key (key check first); (fresh marker, no key)=skip-no-key; (missing marker, key, checkout)=roll (missing=fresh ruling); (key, no checkout)=fail; (no key, no checkout)=ignore", async () => {
    const r = await runCase("lane");
    expect(r.code).toBe(0);
    expect(r.out.trim().split("\n")).toEqual([
      "roll",
      "lapsed",
      "skip",
      "skip",
      "roll",
      "fail",
      "ignore",
    ]);
  });
  test("classification output follows the input order (passwd-order determinism, no reordering)", async () => {
    const r = await runCase("laneorder");
    expect(r.code).toBe(0);
    expect(r.out.trim()).toBe("skip ignore roll roll");
  });
});

describe("jarate-rollout.sh: enumerate_agents (deterministic enumeration)", () => {
  test("login-shell users only, sorted", async () => {
    const r = await runCase("enum");
    expect(r.code).toBe(0);
    expect(r.out.trim().split("\n")).toEqual([
      "alice",
      "bob",
      "carol",
      "dave",
      "root",
    ]);
  });
});

describe("jarate-rollout.sh: smoke_target (smoke-say recipient, #332)", () => {
  test("the warden lane targets piboy (a self-say 400s); other lanes target warden (frank + piboy controls)", async () => {
    const r = await runCase("smoketarget");
    expect(r.code).toBe(0);
    expect(r.out.trim().split("\n")).toEqual(["piboy", "warden", "warden"]);
  });
});

describe("jarate-rollout.sh: wait_marker (the liveness verify)", () => {
  test("marker mtime advances after the restart bar -> 0", async () => {
    const r = await runCase("waitpos");
    expect(r.code).toBe(0);
    expect(r.out).toContain("rc=0");
  });
  test("an old marker (mtime <= bar) never satisfies; timeout -> 1", async () => {
    const r = await runCase("waitneg");
    expect(r.code).toBe(0);
    expect(r.out).toContain("rc=1");
    const elapsed = Number(r.out.match(/elapsed=(\d+)/)?.[1] ?? 999);
    expect(elapsed).toBeGreaterThanOrEqual(2);
    expect(elapsed).toBeLessThan(15); // the 2s timeout was honored, not a hang
  });
});
