/**
 * bin/jarate-pat — bun CLI contract tests (design v4, issue: PAT vault).
 *
 * The real bun wrapper is run against an in-process fake vault (a node:net
 * server speaking the minimal line protocol). Covers:
 *   - shellWords() (N4): split + quote + escape + error cases
 *   - request: ok / error / unavailable / usage docs
 *   - run (bash path, real argv): GH_TOKEN + git env, argv passthrough,
 *     no token in child cmdline, done rc accounting, output passthrough,
 *     timeout -> 124
 *   - run-raw (tool path): `--`-first raw string, tokens as-is, parity
 *     with the bash path, usage errors
 *   - file mode: token file consumed + unlinked, clean missing/invalid
 *   - status: by id and by agent; token never in output
 *   - bin/jarate bash dispatch: subcommand -> tool mapping, single-word
 *     run-raw rule, rc passthrough, JSON on stdout
 */
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "bun";
import { shellWords } from "./jarate-pat";

const WRAPPER = path.join(import.meta.dir, "jarate-pat");
const JARATE = path.join(import.meta.dir, "jarate");

const TOKEN = `ghp_${"x".repeat(36)}`; // 40 chars, shape-checked by vault

type Doc = Record<string, unknown>;

interface RunResult {
  code: number;
  out: string;
  err: string;
}

/** Minimal fake vault: one line per connection, run gets a token or a
 *  file-mode reply then a done line (rc recorded). */
class FakeVault {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "pvf-"));
  fileDir = path.join(this.dir, "runtime");
  sockPath = path.join(this.dir, "pat.sock");
  lines: Doc[] = [];
  doneRcs: Array<{ id: string; rc: number }> = [];
  reply: (m: Doc) => Doc = () => ({
    ok: true,
    id: "pat_f1",
    state: "pending",
    ttl: "0s",
  });
  runReply: (m: Doc) => Doc = () => ({ ok: true, token: TOKEN });
  private server: net.Server | null = null;
  private clients: net.Socket[] = [];

  env(): Record<string, string> {
    return {
      JARATE_PAT_DIR: this.dir,
      XDG_RUNTIME_DIR: this.fileDir,
      JARATE_AGENT: "monky",
    };
  }

  async start(): Promise<this> {
    fs.mkdirSync(this.fileDir, { recursive: true });
    const server = net.createServer((c) => {
      this.clients.push(c);
      const st = { buf: "", stage: "cmd" as "cmd" | "done", runId: "" };
      c.on("data", (d: Buffer) => {
        st.buf += d.toString("utf-8");
        let i = st.buf.indexOf("\n");
        while (i >= 0) {
          const line = st.buf.slice(0, i);
          st.buf = st.buf.slice(i + 1);
          i = st.buf.indexOf("\n");
          if (!line) continue;
          const m = JSON.parse(line) as Doc;
          this.lines.push(m);
          if (st.stage === "cmd") {
            if (m.op === "run") {
              st.stage = "done";
              st.runId = String(m.id);
              c.write(`${JSON.stringify({ v: 1, ...this.runReply(m) })}\n`);
            } else {
              c.write(`${JSON.stringify({ v: 1, ...this.reply(m) })}\n`);
              c.end();
            }
          } else if (m.op === "done") {
            this.doneRcs.push({ id: st.runId, rc: Number(m.rc) });
            c.write(`${JSON.stringify({ v: 1, ok: true })}\n`);
            c.end();
          }
        }
      });
    });
    this.server = server;
    await new Promise<void>((res, rej) => {
      server.once("error", rej);
      server.listen(this.sockPath, () => {
        server.removeListener("error", rej);
        res();
      });
    });
    return this;
  }

  async stop(): Promise<void> {
    for (const c of this.clients) c.destroy();
    this.clients = [];
    await new Promise<void>((res) => {
      if (!this.server) return res();
      this.server.close(() => res());
    });
    try {
      fs.rmSync(this.sockPath, { force: true });
    } catch {
      /* ignore */
    }
  }
}

async function runTool(
  args: string[],
  env: Record<string, string>,
): Promise<RunResult> {
  const p = spawn(["bun", WRAPPER, ...args], {
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
    p.exited,
  ]);
  return { code, out, err };
}

async function runJarate(
  args: string[],
  env: Record<string, string>,
): Promise<RunResult> {
  const p = spawn(["bash", JARATE, ...args], {
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
    p.exited,
  ]);
  return { code, out, err };
}

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "jpd-"));
}

describe("shellWords (N4)", () => {
  test("splits on space + tab runs, empty -> []", () => {
    expect(shellWords("a\t b  c")).toEqual(["a", "b", "c"]);
    expect(shellWords("   ")).toEqual([]);
    expect(shellWords("")).toEqual([]);
  });

  test("double quotes group and preserve", () => {
    expect(shellWords('a "x y" b')).toEqual(["a", "x y", "b"]);
    expect(shellWords('"$HOME /tmp"')).toEqual(["$HOME /tmp"]);
    expect(shellWords('"a\\"b"')).toEqual(['a"b']);
  });

  test("single quotes group verbatim", () => {
    expect(shellWords("a 'x $y' b")).toEqual(["a", "x $y", "b"]);
    expect(shellWords("'a\\b'")).toEqual(["a\\b"]);
  });

  test("backslash outside quotes escapes the next char", () => {
    expect(shellWords("a\\ b")).toEqual(["a b"]);
    expect(shellWords('a\\"b')).toEqual(['a"b']);
  });

  test("unterminated quote throws", () => {
    expect(() => shellWords("'abc")).toThrow();
    expect(() => shellWords('"abc')).toThrow();
    expect(() => shellWords('"abc\\')).toThrow();
  });

  test("trailing backslash throws", () => {
    expect(() => shellWords("a\\")).toThrow();
  });
});

describe("jarate-pat request (fake vault)", () => {
  test("ok doc on stdout; wire line carries agent/scope/reason", async () => {
    const v = await new FakeVault().start();
    try {
      const r = await runTool(
        ["request", "marzukia/jarate:write", "open PR"],
        v.env(),
      );
      expect(r.code).toBe(0);
      const doc = JSON.parse(r.out) as Doc;
      expect(doc.ok).toBe(true);
      expect(doc.id).toBe("pat_f1");
      expect(doc.state).toBe("pending");
      expect(doc.ttl).toBe("0s");
      expect(doc.v).toBeUndefined(); // protocol field stripped
      expect(doc.ts).toBeUndefined(); // wrapper docs are stable-key, no ts
      expect(v.lines[0]).toEqual({
        v: 1,
        op: "request",
        agent: "monky",
        scope: "marzukia/jarate:write",
        reason: "open PR",
      });
    } finally {
      await v.stop();
    }
  });

  test("error doc -> rc 1, no ts", async () => {
    const v = new FakeVault();
    v.reply = () => ({ ok: false, error: "pending exists" });
    await v.start();
    try {
      const r = await runTool(["request", "s", "r"], v.env());
      expect(r.code).toBe(1);
      expect(JSON.parse(r.out)).toEqual({ ok: false, error: "pending exists" });
    } finally {
      await v.stop();
    }
  });

  test("no socket -> vault unavailable rc 1", async () => {
    const dir = tmpDir();
    const r = await runTool(["request", "s", "r"], {
      JARATE_PAT_DIR: dir,
      XDG_RUNTIME_DIR: dir,
      JARATE_AGENT: "monky",
    });
    expect(r.code).toBe(1);
    expect(String(JSON.parse(r.out).error)).toMatch(
      /^vault unavailable: no socket at .*pat\.sock/,
    );
  });

  test("usage (no scope) -> rc 2, JSON usage doc", async () => {
    const v = await new FakeVault().start();
    try {
      const r = await runTool(["request"], v.env());
      expect(r.code).toBe(2);
      const doc = JSON.parse(r.out) as Doc;
      expect(doc.ok).toBe(false);
      expect(String(doc.error)).toContain("usage");
      expect(v.lines).toEqual([]); // nothing hit the wire
    } finally {
      await v.stop();
    }
  });
});

describe("jarate-pat run: socket mode (fake vault)", () => {
  test("env: GH_TOKEN + git env; argv passthrough; done rc=0", async () => {
    const v = await new FakeVault().start();
    try {
      const script =
        "console.log(JSON.stringify({ argv: process.argv.slice(1), tok: process.env.GH_TOKEN, gtp: process.env.GIT_TERMINAL_PROMPT, hdr: process.env.GIT_CONFIG_VALUE_0 }))";
      const r = await runTool(
        ["run", "pat_a", "--", "bun", "-e", script, "x", "y z"],
        v.env(),
      );
      expect(r.code).toBe(0);
      const doc = JSON.parse(r.out) as Doc;
      // bun -e: process.argv = [bun, ...script args] — no -e/script in argv
      expect(doc.argv).toEqual(["x", "y z"]);
      expect(doc.tok).toBe(TOKEN);
      expect(doc.gtp).toBe("0");
      expect(doc.hdr).toBe(`Authorization: Bearer ${TOKEN}`);
      expect(v.doneRcs).toEqual([{ id: "pat_a", rc: 0 }]);
    } finally {
      await v.stop();
    }
  });

  test("child cmdline (/proc) contains no token", async () => {
    const v = await new FakeVault().start();
    try {
      const script =
        'console.log(require("fs").readFileSync("/proc/self/cmdline", "utf8").split("\\0").join(" | "))';
      const r = await runTool(
        ["run", "pat_cl", "--", "bun", "-e", script, "has space"],
        v.env(),
      );
      expect(r.code).toBe(0);
      expect(r.out).toContain("-e");
      expect(r.out).toContain("has space");
      expect(r.out).not.toContain(TOKEN);
      expect(v.doneRcs).toEqual([{ id: "pat_cl", rc: 0 }]);
    } finally {
      await v.stop();
    }
  });

  test("nonzero rc passes through + done carries it", async () => {
    const v = await new FakeVault().start();
    try {
      const r = await runTool(
        ["run", "pat_e", "--", "bun", "-e", "process.exit(3)"],
        v.env(),
      );
      expect(r.code).toBe(3);
      expect(v.doneRcs).toEqual([{ id: "pat_e", rc: 3 }]);
    } finally {
      await v.stop();
    }
  });

  test("stdout + stderr pass through verbatim", async () => {
    const v = await new FakeVault().start();
    try {
      const script = "console.log('OUT-1'); console.error('ERR-1');";
      const r = await runTool(
        ["run", "pat_io", "--", "bun", "-e", script],
        v.env(),
      );
      expect(r.code).toBe(0);
      expect(r.out).toBe("OUT-1\n");
      expect(r.err).toBe("ERR-1\n");
    } finally {
      await v.stop();
    }
  });

  test("timeout: rc 124, partial output kept, no JSON doc, done rc=124", async () => {
    const v = await new FakeVault().start();
    try {
      const t0 = Date.now();
      const r = await runTool(
        [
          "run",
          "pat_t",
          "--",
          "bun",
          "-e",
          "console.log('partial'); await new Promise((q) => setTimeout(q, 5000));",
        ],
        { ...v.env(), JARATE_PAT_RUN_TIMEOUT_S: "1" },
      );
      const elapsed = Date.now() - t0;
      expect(r.code).toBe(124);
      expect(elapsed).toBeLessThan(4000);
      expect(r.out).toContain("partial");
      expect(() => JSON.parse(r.out)).toThrow();
      expect(v.doneRcs).toEqual([{ id: "pat_t", rc: 124 }]);
    } finally {
      await v.stop();
    }
  });

  test("run on non-approved id -> state error rc 1, no done", async () => {
    const v = await new FakeVault();
    v.runReply = () => ({ ok: false, error: "unknown id" });
    await v.start();
    try {
      const r = await runTool(["run", "pat_u", "--", "true"], v.env());
      expect(r.code).toBe(1);
      expect(JSON.parse(r.out)).toEqual({ ok: false, error: "unknown id" });
      expect(v.doneRcs).toEqual([]);
    } finally {
      await v.stop();
    }
  });
});

describe("jarate-pat run-raw: tool path (fake vault)", () => {
  const joinArgv =
    "console.log(process.argv.slice(1).join(String.fromCharCode(1)))";

  test("-- first, tokens as-is", async () => {
    const v = await new FakeVault().start();
    try {
      const raw = `-- bun -e ${JSON.stringify(joinArgv)} a "b c" d`;
      const r = await runTool(["run-raw", "pat_r", raw], v.env());
      expect(r.code).toBe(0);
      expect(r.out.trim()).toBe(["a", "b c", "d"].join(String.fromCharCode(1)));
      expect(v.doneRcs).toEqual([{ id: "pat_r", rc: 0 }]);
    } finally {
      await v.stop();
    }
  });

  test("bash path (run) and tool path (run-raw) give identical child argv", async () => {
    const v = await new FakeVault().start();
    try {
      const raw = `-- bun -e ${JSON.stringify(joinArgv)} a "b c" d`;
      const rb = await runTool(
        ["run", "pat_p1", "--", "bun", "-e", joinArgv, "a", "b c", "d"],
        v.env(),
      );
      const rr = await runTool(["run-raw", "pat_p2", raw], v.env());
      expect(rb.out.trim()).toBe(rr.out.trim());
      expect(rb.out.trim()).toBe(
        ["a", "b c", "d"].join(String.fromCharCode(1)),
      );
    } finally {
      await v.stop();
    }
  });

  test("usage errors -> rc 2", async () => {
    const v = await new FakeVault().start();
    try {
      const cases: string[][] = [
        ["run-raw", "pat_x", "no-dash a b"], // raw does not start with --
        ["run-raw", "pat_x", '"-- a b"'], // quoted first token
        ["run-raw", "pat_x", `-- a "unterm`], // unterminated quote
        ["run", "pat_x", "a", "b"], // run without --
      ];
      for (const c of cases) {
        const r = await runTool(c, v.env());
        expect(r.code, JSON.stringify(c)).toBe(2);
        const doc = JSON.parse(r.out) as Doc;
        expect(doc.ok, JSON.stringify(c)).toBe(false);
      }
      // the two pure-usage cases name the usage in-band
      const r1 = await runTool(["run-raw", "pat_x", "no-dash a b"], v.env());
      expect(String(JSON.parse(r1.out).error)).toContain("usage");
      const r2 = await runTool(["run-raw", "pat_x", '"-- a b"'], v.env());
      expect(String(JSON.parse(r2.out).error)).toContain("usage");
    } finally {
      await v.stop();
    }
  });
});

describe("jarate-pat run: file mode (fake vault)", () => {
  test("token file consumed + unlinked (early)", async () => {
    const v = new FakeVault();
    v.runReply = () => ({ ok: true, file: true });
    const subDir = path.join(v.fileDir, "jarate-pat");
    const tokFile = path.join(subDir, "pat-b");
    fs.mkdirSync(subDir, { recursive: true });
    fs.writeFileSync(tokFile, TOKEN, { mode: 0o600 });
    await v.start();
    try {
      const r = await runTool(
        [
          "run",
          "b",
          "--",
          "bun",
          "-e",
          "console.log(process.env.GH_TOKEN ?? 'none')",
        ],
        v.env(),
      );
      expect(r.code).toBe(0);
      expect(r.out.trim()).toBe(TOKEN);
      expect(fs.existsSync(tokFile)).toBe(false);
      expect(v.doneRcs).toEqual([{ id: "b", rc: 0 }]);
    } finally {
      await v.stop();
    }
  });

  test("missing file -> clean error rc 1, no stderr stack", async () => {
    const v = new FakeVault();
    v.runReply = () => ({ ok: true, file: true });
    await v.start();
    try {
      const r = await runTool(["run", "c", "--", "true"], v.env());
      expect(r.code).toBe(1);
      const doc = JSON.parse(r.out) as Doc;
      expect(doc.ok).toBe(false);
      expect(String(doc.error)).toBe(
        `file missing: ${path.join(v.fileDir, "jarate-pat", "pat-c")}`,
      );
      expect(r.err).toBe("");
    } finally {
      await v.stop();
    }
  });

  test("invalid file (bad shape) -> retry once, then file invalid rc 1", async () => {
    const v = new FakeVault();
    v.runReply = () => ({ ok: true, file: true });
    const subDir = path.join(v.fileDir, "jarate-pat");
    const tokFile = path.join(subDir, "pat-d");
    fs.mkdirSync(subDir, { recursive: true });
    fs.writeFileSync(tokFile, "not-a-token");
    await v.start();
    try {
      const r = await runTool(["run", "d", "--", "true"], v.env());
      expect(r.code).toBe(1);
      const doc = JSON.parse(r.out) as Doc;
      expect(String(doc.error)).toBe(`file invalid: ${tokFile} (token shape)`);
    } finally {
      await v.stop();
    }
  });
});

describe("jarate-pat status (fake vault)", () => {
  test("by id and by agent; token never in output", async () => {
    const v = new FakeVault();
    v.reply = (m) =>
      m.id
        ? {
            ok: true,
            id: String(m.id),
            state: "approved",
            runRc: null,
            runAt: "2026-09-27T00:00:00Z",
          }
        : {
            ok: true,
            agent: String(m.agent),
            active: "pat_s1",
            state: "pending",
          };
    await v.start();
    try {
      const r1 = await runTool(["status", "pat_s1"], v.env());
      const d1 = JSON.parse(r1.out) as Doc;
      expect(r1.code).toBe(0);
      expect(d1.state).toBe("approved");
      expect(v.lines[0]).toEqual({
        v: 1,
        op: "status",
        agent: "monky",
        id: "pat_s1",
      });

      const r2 = await runTool(["status"], v.env());
      const d2 = JSON.parse(r2.out) as Doc;
      expect(r2.code).toBe(0);
      expect(d2.agent).toBe("monky");
      expect(v.lines[1]).toEqual({ v: 1, op: "status", agent: "monky" });

      expect(r1.out + r2.out).not.toContain(TOKEN);
    } finally {
      await v.stop();
    }
  });
});

describe("bin/jarate bash dispatch (stub jarate-pat)", () => {
  interface Stub {
    env: Record<string, string>;
    log: () => string;
    callsPath: string;
  }

  function mkStub(exitCode = 0): Stub {
    const dir = tmpDir();
    const callsPath = path.join(dir, "calls.log");
    const stub = path.join(dir, "jarate-pat-stub");
    fs.writeFileSync(
      stub,
      `#!/bin/sh
echo "$@" >> ${callsPath}
case "$1" in
  request) echo '{"ok":true,"id":"pat_stub","state":"pending","ttl":"300s"}'; exit ${exitCode};;
  run|run-raw) echo 'stub-run'; exit ${exitCode};;
  status) echo '{"ok":true,"agent":"monky"}'; exit ${exitCode};;
esac
exit ${exitCode}
`,
    );
    fs.chmodSync(stub, 0o755);
    return {
      env: { JARATE_PAT_BIN: stub, JARATE_AGENT: "monky" },
      log: () =>
        fs.existsSync(callsPath) ? fs.readFileSync(callsPath, "utf-8") : "",
      callsPath,
    };
  }

  test("pat-request -> request; JSON doc passes through; rc 0", async () => {
    const s = mkStub();
    const r = await runJarate(["pat-request", "s1", "reason"], s.env);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toEqual({
      ok: true,
      id: "pat_stub",
      state: "pending",
      ttl: "300s",
    });
    expect(s.log()).toBe("request s1 reason\n");
  });

  test("pat-request missing args -> usage rc 2 with JSON error", async () => {
    const s = mkStub();
    const r = await runJarate(["pat-request"], s.env);
    expect(r.code).toBe(2);
    const doc = JSON.parse(r.out) as Doc;
    expect(doc.ok).toBe(false);
    expect(String(doc.error)).toContain("usage");
  });

  test("pat-request tool path: pre-joined single word -> request; rc 0", async () => {
    // LLM tool path (jarate.ts): the whole tail arrives as ONE pre-joined
    // string. Must not die_usage (issue #98).
    const s = mkStub();
    const r = await runJarate(["pat-request", "s1 reason with spaces"], s.env);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toEqual({
      ok: true,
      id: "pat_stub",
      state: "pending",
      ttl: "300s",
    });
    expect(s.log()).toBe("request s1 reason with spaces\n");
  });

  test("pat-request tool path and bash path give identical wrapper argv", async () => {
    const s1 = mkStub();
    const r1 = await runJarate(["pat-request", "s1 reason words here"], s1.env);
    const s2 = mkStub();
    const r2 = await runJarate(
      ["pat-request", "s1", "reason words here"],
      s2.env,
    );
    expect(r1.code).toBe(0);
    expect(r2.code).toBe(0);
    expect(s1.log()).toBe(s2.log());
  });

  test("pat-request single word with no reason -> usage rc 2", async () => {
    const s = mkStub();
    const r = await runJarate(["pat-request", "s1"], s.env);
    expect(r.code).toBe(2);
    const doc = JSON.parse(r.out) as Doc;
    expect(doc.ok).toBe(false);
    expect(String(doc.error)).toContain("usage");
  });

  test("pat-run multi-word tail -> run (real argv)", async () => {
    const s = mkStub(7);
    const r = await runJarate(["pat-run", "pat_x", "--", "cmd", "a b"], s.env);
    expect(r.code).toBe(7); // rc passthrough
    expect(s.log()).toBe("run pat_x -- cmd a b\n");
    expect(r.out).toBe("stub-run\n");
  });

  test("pat-run single-word tail -> run-raw (verbatim)", async () => {
    const s = mkStub(7);
    const r = await runJarate(["pat-run", 'pat_x -- cmd "a b"'], s.env);
    expect(r.code).toBe(7);
    expect(s.log()).toBe('run-raw pat_x -- cmd "a b"\n');
  });

  test("pat-run id only -> run-raw with empty raw -> usage rc 2", async () => {
    // No JARATE_PAT_BIN: find_jarate_pat falls back to the real sibling
    // wrapper, which validates raw before dialing.
    const r = await runJarate(["pat-run", "pat_x"], { JARATE_AGENT: "monky" });
    expect(r.code).toBe(2);
    expect(JSON.parse(r.out).ok).toBe(false);
  });

  test("pat-status: agent form, id form, too many args -> rc 2", async () => {
    const s = mkStub();
    const r1 = await runJarate(["pat-status"], s.env);
    expect(r1.code).toBe(0);
    expect(JSON.parse(r1.out)).toEqual({ ok: true, agent: "monky" });
    expect(s.log()).toBe("status\n");

    const r2 = await runJarate(["pat-status", "pat_y"], s.env);
    expect(r2.code).toBe(0);
    expect(s.log()).toBe("status\nstatus pat_y\n");

    const r3 = await runJarate(["pat-status", "a", "b"], s.env);
    expect(r3.code).toBe(2);
  });
});
