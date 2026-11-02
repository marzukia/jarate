/**
 * deploy/jarate-rollout.sh — fleet-wide rollout (#314, G4 of P1 #322), pure-helper tests.
 *
 * Sourced-harness pattern (task spec, same as deploy.test.ts): the REAL validate_hm_base / first_key_line / wait_marker / enumerate_agents are extracted verbatim from jarate-rollout.sh (sed range over the function bodies) and eval'd in a stubbed subshell, so the tests exercise the script's own code — a rename or logic change in the script is what the tests catch (an extraction failure exits 90).
 *
 * The cross-user flow (sudo, systemctl, curl) is operator-run (vault plan); only the pure helpers are tested here.
 */
import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "bun";

const ROLLOUT = path.join(import.meta.dir, "jarate-rollout.sh");

// Leak guard: every fixture mkdtemp dir is tracked and force-removed in a
// file-level afterEach, so a failed or aborted test cannot leave dirs in /tmp.
const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

/**
 * The sourced-harness script. $1 = tmp dir, $2 = jarate-rollout.sh path,
 * $3 = scenario. Extracts the REAL helper bodies from the script and
 * evals them, then runs the scenario's invocations, recording the
 * results in $T/out (one per line).
 */
const HARNESS = `#!/usr/bin/env bash
set -euo pipefail
T="$1"
SRC="$2"
CASE="$3"

extract() { sed -n "$1" "$SRC"; }
eval "$(extract '/^validate_hm_base() {/,/^}/p')"
eval "$(extract '/^first_key_line() {/,/^}/p')"
eval "$(extract '/^wait_marker() {/,/^}/p')"
eval "$(extract '/^enumerate_agents() {/,/^}/p')"
for fn in validate_hm_base first_key_line wait_marker enumerate_agents; do
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
    printf '# onboarding key file\\nBASE_URL=http://10.1.2.3:8001\\nX_AGENT_KEY=agentkey-new\\n' >"$T/key3"
    first_key_line "$T/key3" >"$T/k3" 2>/dev/null && echo "newformat exit 0" || echo "newformat exit 1"
    cat "$T/k3"
    printf 'BASE_URL=http://10.1.2.3:8001\\nhm_agent_abc123\\n' >"$T/key4"
    first_key_line "$T/key4" >"$T/k4" 2>/dev/null && echo "hmagent exit 0" || echo "hmagent exit 1"
    cat "$T/k4"
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
  test("first non-comment, non-blank line wins (legacy); X_AGENT_KEY= / hm_agent_ lines win (onboarding format); missing / comment-only files fail", async () => {
    const r = await runCase("keyline");
    expect(r.code).toBe(0);
    const lines = r.out.trim().split("\n");
    expect(lines).toEqual([
      "exit 0",
      "the-key",
      "missing exit 1",
      "onlycomments exit 1",
      "newformat exit 0",
      "agentkey-new",
      "hmagent exit 0",
      "hm_agent_abc123",
    ]);
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
