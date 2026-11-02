/**
 * version-drift.ts — fleet-wide version parity, startup drift check
 * (issue #314, G4 of P1 #322).
 *
 * Hermetic: no test touches the live hall-monitor API (the HTTP leg is
 * injected via setDriftHttp), and the pinned-SHA pointer lives in a temp
 * dir via JARATE_PINNED_DIR. The git HEAD is the real HEAD of this
 * worktree (the module resolves its own checkout via realpath — the test
 * runs inside the repo, so it is a usable git repo).
 *
 * Coverage:
 *   - pointer file missing = feature dormant (silent no-op, no fetch)
 *   - pointer == local HEAD = in-parity (no fetch)
 *   - pointer != HEAD + JARATE_INBOX_URL/KEY set = ONE page to warden
 *     (POST <base>/fleet/say, X-Agent-Key; 2xx = delivered)
 *   - page failure (4xx) = logged, never thrown
 *   - key file fallback (first non-comment line of the agent-key file)
 *   - no URL/key = local log line, no fetch
 *   - JARATE_PINNED_DIR override respected
 *   - once per process (a second start no-ops); reset re-arms
 */
import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  checkVersionDrift,
  localHead,
  readKeyFile,
  resetDriftStateForTests,
  setDriftHttp,
} from "./version-drift";

// Leak guard: every fixture mkdtemp dir is tracked and force-removed in a
// file-level afterEach, so a failed or aborted test cannot leave dirs in /tmp.
const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) {
    fs.rmSync(d, { recursive: true, force: true });
  }
  resetDriftStateForTests();
  setDriftHttp(null);
  delete process.env.JARATE_PINNED_DIR;
  delete process.env.JARATE_INBOX_URL;
  delete process.env.JARATE_INBOX_KEY;
  delete process.env.JARATE_INBOX_KEY_FILE;
});

const REAL_HEAD = localHead();
expect(REAL_HEAD).toMatch(/^[0-9a-f]{40}$/); // the test must run inside the repo

// The uid this process runs as (the pointer filename; the test writes the
// pointer itself, so only consistency with the module matters).
const UID = typeof process.getuid === "function" ? process.getuid() : 0;

// A recorded page call from the injected HTTP leg.
interface PageCall {
  url: string;
  key: string;
  to: string;
  message: string;
}

/**
 * Set the pinned pointer in a fresh JARATE_PINNED_DIR; returns the dir.
 * pass "none" to leave the dir empty (missing pointer file).
 */
function pinTo(sha: string | "none"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jarate-drift-pin-"));
  tmpDirs.push(dir);
  process.env.JARATE_PINNED_DIR = dir;
  if (sha !== "none") fs.writeFileSync(path.join(dir, String(UID)), `${sha}\n`);
  return dir;
}

function withHttp(
  status: number,
  calls: PageCall[],
): void {
  setDriftHttp(async (url, init) => {
    const body = JSON.parse(String(init.body)) as {
      to: string;
      message: string;
    };
    calls.push({
      url,
      key: String((init.headers as Record<string, string> | undefined)?.["X-Agent-Key"] ?? ""),
      to: body.to,
      message: body.message,
    });
    return { ok: status >= 200 && status < 300, status };
  });
}

// Point JARATE_INBOX_KEY_FILE at a fixture (os.homedir() reads the
// passwd entry, not $HOME, so the path override is the test seam).
function homeWithKeyFile(key: string): void {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "jarate-drift-home-"));
  tmpDirs.push(home);
  const dir = path.join(home, ".config", "hall-monitor");
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, "agent-key");
  fs.writeFileSync(f, `# comment line\n\n${key}\nsecond-line-ignored\n`);
  process.env.JARATE_INBOX_KEY_FILE = f;
}

describe("version-drift: the startup parity check", () => {
  test("pointer file missing = dormant, silent, no fetch", async () => {
    const calls: PageCall[] = [];
    pinTo("none");
    withHttp(200, calls);
    const r = await checkVersionDrift();
    expect(r?.status).toBe("dormant");
    expect(calls.length).toBe(0);
  });

  test("pointer == local HEAD = in-parity, no fetch", async () => {
    const calls: PageCall[] = [];
    pinTo(REAL_HEAD);
    withHttp(200, calls);
    const r = await checkVersionDrift();
    expect(r?.status).toBe("in-parity");
    expect(r?.head).toBe(REAL_HEAD);
    expect(calls.length).toBe(0);
  });

  test("mismatch + URL/key set = ONE page to warden, 2xx = delivered", async () => {
    const calls: PageCall[] = [];
    pinTo("0".repeat(40));
    process.env.JARATE_INBOX_URL = "http://127.0.0.1:18001/api/";
    process.env.JARATE_INBOX_KEY = "test-agent-key";
    withHttp(200, calls);
    const r = await checkVersionDrift();
    expect(r?.status).toBe("drift-paged");
    expect(calls.length).toBe(1); // exactly one page
    expect(calls[0].url).toBe("http://127.0.0.1:18001/api/fleet/say"); // trailing slash trimmed, /fleet/say appended
    expect(calls[0].key).toBe("test-agent-key");
    expect(calls[0].to).toBe("warden");
    expect(calls[0].message).toContain(REAL_HEAD.slice(0, 7));
    expect(calls[0].message).toContain("0000000"); // the pinned short SHA
  });

  test("page failure (4xx) = drift-page-failed, never thrown", async () => {
    const calls: PageCall[] = [];
    pinTo("1".repeat(40));
    process.env.JARATE_INBOX_URL = "http://127.0.0.1:18001/api";
    process.env.JARATE_INBOX_KEY = "test-agent-key";
    withHttp(403, calls);
    const r = await checkVersionDrift();
    expect(r?.status).toBe("drift-page-failed");
    expect(r?.detail).toBe("http 403");
    expect(calls.length).toBe(1);
  });

  test("key file fallback: JARATE_INBOX_KEY unset, agent-key file provides the key", async () => {
    const calls: PageCall[] = [];
    pinTo("2".repeat(40));
    homeWithKeyFile("file-fallback-key");
    process.env.JARATE_INBOX_URL = "http://127.0.0.1:18001/api";
    withHttp(200, calls);
    const r = await checkVersionDrift();
    expect(r?.status).toBe("drift-paged");
    expect(calls[0].key).toBe("file-fallback-key");
  });

  test("no URL/key = local log line, no fetch (drift-local)", async () => {
    const calls: PageCall[] = [];
    pinTo("3".repeat(40));
    homeWithKeyFile("file-fallback-key"); // no URL set, so the key is moot
    withHttp(200, calls);
    const r = await checkVersionDrift();
    expect(r?.status).toBe("drift-local");
    expect(calls.length).toBe(0);
    expect(r?.detail).toContain("JARATE_INBOX_URL/JARATE_INBOX_KEY unset");
  });

  test("JARATE_PINNED_DIR override: the pointer is read from the override dir", async () => {
    pinTo("4".repeat(40)); // the active dir (env override) carries the mismatch
    process.env.JARATE_INBOX_URL = "http://127.0.0.1:18001/api";
    process.env.JARATE_INBOX_KEY = "test-agent-key";
    const calls: PageCall[] = [];
    withHttp(200, calls);
    const r = await checkVersionDrift();
    expect(r?.status).toBe("drift-paged");
    expect(r?.pinned).toBe("4".repeat(40)); // read from the override dir
  });

  test("once per process: a second start no-ops (no second page); reset re-arms", async () => {
    const calls: PageCall[] = [];
    pinTo("5".repeat(40));
    process.env.JARATE_INBOX_URL = "http://127.0.0.1:18001/api";
    process.env.JARATE_INBOX_KEY = "test-agent-key";
    withHttp(200, calls);
    expect((await checkVersionDrift())?.status).toBe("drift-paged");
    expect(await checkVersionDrift()).toBeNull(); // the /new / /reload re-session
    expect(calls.length).toBe(1);
    resetDriftStateForTests();
    expect((await checkVersionDrift())?.status).toBe("drift-paged");
    expect(calls.length).toBe(2); // re-armed: one page per process start
  });
});

describe("version-drift: readKeyFile (the agent-key file shape)", () => {
  test("first non-comment, non-blank line wins", () => {
    const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "jarate-key-")), "agent-key");
    tmpDirs.push(path.dirname(f));
    fs.writeFileSync(f, `# comment\n\n  # indented comment\n  the-key  \nnext\n`);
    expect(readKeyFile(f)).toBe("the-key");
  });
  test("missing file = empty", () => {
    expect(readKeyFile("/nonexistent/agent-key")).toBe("");
  });
});
