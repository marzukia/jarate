/**
 * bin/jarate-vault — bun CLI contract tests (docs/vault-design.md).
 *
 * The real bun wrapper is run against an in-process fake vault (a node:net
 * server speaking the minimal line protocol). Covers:
 *   - shellWords(): split + quote + escape + error cases
 *   - parseRequestArgv(): flags + positionals
 *   - request / request-raw: ok / error / unavailable / usage docs;
 *     from-env value on the wire but never in stdout
 *   - run (socket): value in child ENV only (captured via /proc cmdline),
 *     git header for github-pat, argv passthrough, rc pass-through,
 *     done rc accounting, timeout -> 124
 *   - run (file): published doc read, value in env, clean missing file
 *   - status / revoke / audit
 *   - bin/jarate bash dispatch: subcommand -> tool mapping, rc passthrough
 */
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "bun";
import { parseRequestArgv, shellWords } from "./jarate-vault";

const WRAPPER = path.join(import.meta.dir, "jarate-vault");
const JARATE = path.join(import.meta.dir, "jarate");

const KEY_VALUE = `sk-test-${"y".repeat(24)}`; // api-key shape
const TOKEN = `ghp_${"x".repeat(36)}`; // github-pat shape
const PW_VALUE = "p w s s word"; // password shape (spaces ok)

type Doc = Record<string, unknown>;

interface RunResult {
  code: number;
  out: string;
  err: string;
}

/** Minimal fake vault: line protocol on a temp unix socket. */
class FakeVault {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "fvf-"));
  socketDir = path.join(this.dir, "socket");
  fileDir = path.join(this.dir, "runtime");
  sockPath = path.join(this.socketDir, "vault.sock");
  lines: Doc[] = [];
  doneRcs: Array<{ id: string; rc: number }> = [];
  reply: (m: Doc) => Doc = () => ({
    ok: true,
    id: "vault_f1",
    state: "pending",
  });
  runReply: (m: Doc) => Doc = () => ({
    ok: true,
    token: KEY_VALUE,
    kind: "api-key",
    envvar: "MY_KEY",
    git_header: false,
  });
  private server: net.Server | null = null;
  private clients: net.Socket[] = [];

  env(over: Record<string, string> = {}): Record<string, string> {
    return {
      JARATE_VAULT_SOCKET_DIR: this.socketDir,
      JARATE_VAULT_FILE_DIR: this.fileDir,
      JARATE_AGENT: "monky",
      ...over,
    };
  }

  async start(): Promise<this> {
    fs.mkdirSync(this.socketDir, { recursive: true });
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
            if (m.op === "vrun") {
              st.stage = "done";
              st.runId = String(m.id);
              c.write(`${JSON.stringify({ v: 1, ...this.runReply(m) })}\n`);
            } else {
              c.write(`${JSON.stringify({ v: 1, ...this.reply(m) })}\n`);
              c.end();
            }
          } else if (m.op === "vdone") {
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
      fs.rmSync(this.dir, { recursive: true, force: true });
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

/** Child script: prints env value + its own cmdline (value must NOT
 *  appear in cmdline). */
const CHILD_SCRIPT = `const fs = require("node:fs");
console.log(JSON.stringify({
  env: process.env.MY_KEY,
  gtp: process.env.GIT_TERMINAL_PROMPT,
  gh: process.env.GH_TOKEN,
  hdr: process.env.GIT_CONFIG_VALUE_0,
  argv: process.argv.slice(1),
  cmd: fs.readFileSync("/proc/self/cmdline", "utf8")
}))`;

const CHILD_ONE = `const fs=require('node:fs');console.log(JSON.stringify({env:process.env.MY_KEY,gh:process.env.GH_TOKEN,hdr:process.env.GIT_CONFIG_VALUE_0,argv:process.argv.slice(1),cmd:fs.readFileSync('/proc/self/cmdline','utf8')}))`;

// ─── shellWords ────────────────────────────────────────────────────────────

describe("shellWords", () => {
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

  test("unterminated quote / trailing backslash throw", () => {
    expect(() => shellWords("'abc")).toThrow();
    expect(() => shellWords('"abc')).toThrow();
    expect(() => shellWords("a\\")).toThrow();
  });
});

// ─── parseRequestArgv ──────────────────────────────────────────────────────

describe("parseRequestArgv", () => {
  test("valid full flags", () => {
    const p = parseRequestArgv([
      "github-pat",
      "marzukia/jarate:write",
      "time-boxed",
      "--hours",
      "4",
      "--label",
      "PR bot",
      "needs a token for x",
    ]);
    expect(p.kind).toBe("github-pat");
    expect(p.name).toBe("marzukia/jarate:write");
    expect(p.level).toBe("time-boxed");
    expect(p.hours).toBe(4);
    expect(p.label).toBe("PR bot");
    expect(p.reason).toBe("needs a token for x");
  });

  test("envvar + from-env", () => {
    const p = parseRequestArgv([
      "api-key",
      "k",
      "one-shot",
      "--envvar",
      "MY_KEY",
      "--from-env",
      "MY_SECRET",
      "bring your own",
    ]);
    expect(p.envvar).toBe("MY_KEY");
    expect(p.fromEnv).toBe("MY_SECRET");
  });
});

// ─── request ───────────────────────────────────────────────────────────────

describe("request (fake vault)", () => {
  test("ok doc on stdout; wire line carries the fields", async () => {
    const v = await new FakeVault().start();
    try {
      const r = await runTool(
        [
          "request",
          "github-pat",
          "marzukia/jarate:write",
          "one-shot",
          "open PR for #41",
        ],
        v.env(),
      );
      expect(r.code).toBe(0);
      const doc = JSON.parse(r.out) as Doc;
      expect(doc.ok).toBe(true);
      expect(doc.id).toBe("vault_f1");
      expect(doc.v).toBeUndefined(); // protocol field stripped
      expect(v.lines[0]).toEqual({
        v: 1,
        op: "vrequest",
        agent: "monky",
        kind: "github-pat",
        name: "marzukia/jarate:write",
        level: "one-shot",
        envvar: "GH_TOKEN",
        reason: "open PR for #41",
      });
    } finally {
      await v.stop();
    }
  });

  test("from-env: value on the wire, never in stdout", async () => {
    const v = await new FakeVault().start();
    try {
      const r = await runTool(
        [
          "request",
          "api-key",
          "byo",
          "one-shot",
          "--envvar",
          "MY_KEY",
          "--from-env",
          "MY_SECRET",
          "bring your own key",
        ],
        { ...v.env(), MY_SECRET: KEY_VALUE },
      );
      expect(r.code).toBe(0);
      expect(r.out).not.toContain(KEY_VALUE);
      const m = v.lines[0];
      expect(m.from_env).toBe("MY_SECRET");
      expect(m.value).toBe(KEY_VALUE);
    } finally {
      await v.stop();
    }
  });

  test("from-env missing -> rc 1 before the wire", async () => {
    const v = await new FakeVault().start();
    try {
      const r = await runTool(
        [
          "request",
          "api-key",
          "byo",
          "one-shot",
          "--envvar",
          "MY_KEY",
          "--from-env",
          "MY_SECRET",
          "bring your own key",
        ],
        v.env(), // MY_SECRET unset
      );
      expect(r.code).toBe(1);
      expect(String(JSON.parse(r.out).error)).toMatch(/MY_SECRET/);
      expect(v.lines).toEqual([]);
    } finally {
      await v.stop();
    }
  });

  test("from-env shape invalid for github-pat -> rc 1", async () => {
    const v = await new FakeVault().start();
    try {
      const r = await runTool(
        [
          "request",
          "github-pat",
          "default",
          "one-shot",
          "--from-env",
          "MY_SECRET",
          "not a token",
        ],
        { ...v.env(), MY_SECRET: "not a token" },
      );
      expect(r.code).toBe(1);
      expect(String(JSON.parse(r.out).error)).toMatch(/shape/i);
      expect(v.lines).toEqual([]);
    } finally {
      await v.stop();
    }
  });

  test("no socket -> vault unavailable rc 1", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fvn-"));
    const r = await runTool(
      ["request", "api-key", "k", "one-shot", "--envvar", "K", "reason"],
      {
        JARATE_VAULT_SOCKET_DIR: dir,
        JARATE_AGENT: "monky",
      },
    );
    expect(r.code).toBe(1);
    expect(String(JSON.parse(r.out).error)).toMatch(
      /^vault unavailable: no socket at .*vault\.sock/,
    );
  });

  test("usage errors -> rc 2", async () => {
    const v = await new FakeVault().start();
    try {
      const r1 = await runTool(["request"], v.env());
      expect(r1.code).toBe(2);
      expect(String(JSON.parse(r1.out).error)).toContain("usage");
      const r2 = await runTool(
        ["request", "nope", "k", "one-shot", "reason here"],
        v.env(),
      );
      expect(r2.code).toBe(2);
      const r3 = await runTool(
        ["request", "api-key", "k", "weekly", "reason here"],
        v.env(),
      );
      expect(r3.code).toBe(2);
      const r4 = await runTool(
        ["request", "api-key", "k", "one-shot", "--bogus", "x", "reason here"],
        v.env(),
      );
      expect(r4.code).toBe(2);
      expect(v.lines).toEqual([]);
    } finally {
      await v.stop();
    }
  });

  test("request-raw: pre-joined tail re-split", async () => {
    const v = await new FakeVault().start();
    try {
      const r = await runTool(
        ["request-raw", `api-key rawkey one-shot --envvar RK needs a reason`],
        v.env(),
      );
      expect(r.code).toBe(0);
      expect(v.lines[0]).toEqual({
        v: 1,
        op: "vrequest",
        agent: "monky",
        kind: "api-key",
        name: "rawkey",
        level: "one-shot",
        envvar: "RK",
        reason: "needs a reason",
      });
    } finally {
      await v.stop();
    }
  });
});

// ─── run: socket mode ──────────────────────────────────────────────────────

describe("run (socket mode, fake vault)", () => {
  test("value in child env only; argv passthrough; done rc=0", async () => {
    const v = await new FakeVault().start();
    try {
      const r = await runTool(
        ["run", "vault_a", "--", "bun", "-e", CHILD_SCRIPT, "x", "y z"],
        v.env(),
      );
      expect(r.code).toBe(0);
      const doc = JSON.parse(r.out) as Doc;
      expect(doc.env).toBe(KEY_VALUE);
      expect(doc.gtp).toBe("0");
      expect(doc.argv).toEqual(["x", "y z"]);
      // The child's own process cmdline must not contain the value.
      expect(String(doc.cmd)).not.toContain(KEY_VALUE);
      // The wrapper's stdout is the child's output only (never-echo).
      expect((r.out.match(new RegExp(KEY_VALUE, "g")) || []).length).toBe(1);
      expect(v.doneRcs).toEqual([{ id: "vault_a", rc: 0 }]);
      const runLine = v.lines.find((m) => m.op === "vrun");
      expect(runLine).toBeDefined();
      expect(runLine?.cmd).toEqual(["bun", "-e", CHILD_SCRIPT, "x", "y z"]);
      expect(JSON.stringify(runLine)).not.toContain(KEY_VALUE);
    } finally {
      await v.stop();
    }
  });

  test("github-pat: GH_TOKEN + git env-config header", async () => {
    const v = await new FakeVault().start();
    v.runReply = () => ({
      ok: true,
      token: TOKEN,
      kind: "github-pat",
      envvar: "GH_TOKEN",
      git_header: true,
    });
    try {
      const r = await runTool(
        ["run", "vault_g", "--", "bun", "-e", CHILD_SCRIPT],
        v.env(),
      );
      expect(r.code).toBe(0);
      const doc = JSON.parse(r.out) as Doc;
      expect(doc.gh).toBe(TOKEN);
      expect(doc.hdr).toBe(`Authorization: Bearer ${TOKEN}`);
      expect(String(doc.cmd)).not.toContain(TOKEN);
    } finally {
      await v.stop();
    }
  });

  test("password value with spaces round-trips", async () => {
    const v = await new FakeVault().start();
    v.runReply = () => ({
      ok: true,
      token: PW_VALUE,
      kind: "password",
      envvar: "MY_KEY",
      git_header: false,
    });
    try {
      const r = await runTool(
        ["run", "vault_p", "--", "bun", "-e", CHILD_SCRIPT],
        v.env(),
      );
      expect(r.code).toBe(0);
      expect((JSON.parse(r.out) as Doc).env).toBe(PW_VALUE);
    } finally {
      await v.stop();
    }
  });

  test("child rc pass-through (7)", async () => {
    const v = await new FakeVault().start();
    try {
      const r = await runTool(
        ["run", "vault_r7", "--", "bun", "-e", "process.exit(7)"],
        v.env(),
      );
      expect(r.code).toBe(7);
      expect(v.doneRcs).toEqual([{ id: "vault_r7", rc: 7 }]);
    } finally {
      await v.stop();
    }
  });

  test("vault says no (consumed) -> rc 1, no child spawned", async () => {
    const v = await new FakeVault().start();
    v.runReply = () => ({ ok: false, error: "state: already used" });
    try {
      const r = await runTool(["run", "vault_c", "--", "true"], v.env());
      expect(r.code).toBe(1);
      expect(JSON.parse(r.out)).toEqual({
        ok: false,
        error: "state: already used",
      });
      expect(v.doneRcs).toEqual([]);
    } finally {
      await v.stop();
    }
  });

  test("command cap: rc 124, done rc=124, fast", async () => {
    const v = await new FakeVault().start();
    const t0 = Date.now();
    try {
      const r = await runTool(["run", "vault_cap", "--", "sleep", "5"], {
        ...v.env(),
        JARATE_VAULT_RUN_TIMEOUT_S: "1",
      });
      const dt = Date.now() - t0;
      expect(r.code).toBe(124);
      expect(dt).toBeLessThan(3000);
      expect(v.doneRcs).toEqual([{ id: "vault_cap", rc: 124 }]);
    } finally {
      await v.stop();
    }
  });

  test("usage: missing -- separator -> rc 2", async () => {
    const v = await new FakeVault().start();
    try {
      const r = await runTool(["run", "vault_a", "true"], v.env());
      expect(r.code).toBe(2);
      expect(v.lines).toEqual([]);
    } finally {
      await v.stop();
    }
  });

  test("run-raw: `--`-first raw string, quotes honored", async () => {
    const v = await new FakeVault().start();
    try {
      const r = await runTool(
        [
          "run-raw",
          "vault_rr",
          `-- bun -e ${JSON.stringify(CHILD_ONE)} "a b" c`,
        ],
        v.env(),
      );
      expect(r.code).toBe(0);
      const doc = JSON.parse(r.out) as Doc;
      expect(doc.argv).toEqual(["a b", "c"]);
      const runLine = v.lines.find((m) => m.op === "vrun");
      expect(runLine?.cmd).toEqual(["bun", "-e", CHILD_ONE, "a b", "c"]);
    } finally {
      await v.stop();
    }
  });
});

// ─── run: file mode ────────────────────────────────────────────────────────

describe("run (file mode, fake vault)", () => {
  test("published doc read; value in env; missing file -> rc 1", async () => {
    const v = await new FakeVault().start();
    v.runReply = (m) => {
      const id = String(m.id);
      if (id === "vault_fmiss")
        return {
          ok: true,
          file: true,
          kind: "api-key",
          envvar: "MY_KEY",
          git_header: false,
        };
      // publish the doc
      fs.writeFileSync(
        path.join(v.fileDir, `vault-${id}`),
        JSON.stringify({
          value: KEY_VALUE,
          kind: "api-key",
          envvar: "MY_KEY",
          git_header: false,
        }),
        { mode: 0o600 },
      );
      return {
        ok: true,
        file: true,
        kind: "api-key",
        envvar: "MY_KEY",
        git_header: false,
      };
    };
    try {
      const r = await runTool(
        ["run", "vault_f1", "--", "bun", "-e", CHILD_SCRIPT],
        v.env(),
      );
      expect(r.code).toBe(0);
      expect((JSON.parse(r.out) as Doc).env).toBe(KEY_VALUE);
      expect(v.doneRcs).toEqual([{ id: "vault_f1", rc: 0 }]);

      const r2 = await runTool(["run", "vault_fmiss", "--", "true"], v.env());
      expect(r2.code).toBe(1);
      expect(String(JSON.parse(r2.out).error)).toMatch(/file missing/);
    } finally {
      await v.stop();
    }
  });
});

// ─── status / revoke / audit ───────────────────────────────────────────────

describe("status / revoke / audit", () => {
  test("status ok -> rc 0, value never in output", async () => {
    const v = await new FakeVault().start();
    v.reply = () => ({
      ok: true,
      pending: [
        {
          id: "vault_f1",
          state: "pending",
          kind: "api-key",
          name: "byo",
          level: "one-shot",
          envvar: "MY_KEY",
        },
      ],
      budget: { approvals_last_hour: 0, cap: 5 },
    });
    try {
      const r = await runTool(["status", "vault_f1"], v.env());
      expect(r.code).toBe(0);
      expect(r.out).not.toContain(KEY_VALUE);
      const doc = JSON.parse(r.out) as Doc;
      expect(doc.ok).toBe(true);
      expect(v.lines[0]).toEqual({
        v: 1,
        op: "vstatus",
        agent: "monky",
        id: "vault_f1",
      });
    } finally {
      await v.stop();
    }
  });

  test("revoke ok -> rc 0, wire carries id", async () => {
    const v = await new FakeVault().start();
    v.reply = () => ({ ok: true, id: "vault_f1", state: "revoked" });
    try {
      const r = await runTool(["revoke", "vault_f1"], v.env());
      expect(r.code).toBe(0);
      expect(v.lines[0]).toEqual({
        v: 1,
        op: "vrevoke",
        agent: "monky",
        id: "vault_f1",
      });
    } finally {
      await v.stop();
    }
  });

  test("audit: last n lines from the local file", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fva-"));
    const ap = path.join(dir, "audit.log");
    const lines = [
      JSON.stringify({ ts: "1", event: "request", n: 1 }),
      JSON.stringify({ ts: "2", event: "approve", n: 2 }),
      JSON.stringify({ ts: "3", event: "use", n: 3 }),
    ].join("\n");
    fs.writeFileSync(ap, lines, { mode: 0o600 });
    const r = await runTool(["audit", "2"], {
      JARATE_VAULT_AUDIT_FILE: ap,
      JARATE_AGENT: "monky",
    });
    expect(r.code).toBe(0);
    const doc = JSON.parse(r.out) as Doc;
    expect(doc.count).toBe(2);
    expect((doc.lines as Doc[]).map((l) => l.n)).toEqual([2, 3]);

    // no file -> empty ok doc
    const r2 = await runTool(["audit"], {
      JARATE_VAULT_AUDIT_FILE: path.join(dir, "nope"),
      JARATE_AGENT: "monky",
    });
    expect(r2.code).toBe(0);
    expect((JSON.parse(r2.out) as Doc).count).toBe(0);
  });
});

// ─── bin/jarate bash dispatch ──────────────────────────────────────────────

describe("bin/jarate dispatch", () => {
  test("vault-request single word -> request-raw (wire vrequest)", async () => {
    const v = await new FakeVault().start();
    try {
      const r = await runJarate(
        ["vault-request", "api-key dkey one-shot --envvar DK needs a reason"],
        v.env(),
      );
      expect(r.code).toBe(0);
      expect(v.lines[0]).toMatchObject({
        op: "vrequest",
        kind: "api-key",
        name: "dkey",
        envvar: "DK",
      });
    } finally {
      await v.stop();
    }
  });

  test("vault-run (real argv) -> run path, rc passthrough", async () => {
    const v = await new FakeVault().start();
    try {
      const r = await runJarate(
        ["vault-run", "vault_a", "--", "bun", "-e", "process.exit(9)"],
        v.env(),
      );
      expect(r.code).toBe(9);
      expect(v.doneRcs).toEqual([{ id: "vault_a", rc: 9 }]);
    } finally {
      await v.stop();
    }
  });

  test("vault-run single word -> run-raw", async () => {
    const v = await new FakeVault().start();
    try {
      const r = await runJarate(
        ["vault-run", `vault_a -- bun -e ${JSON.stringify(CHILD_ONE)} "q w"`],
        v.env(),
      );
      expect(r.code).toBe(0);
      const doc = JSON.parse(r.out) as Doc;
      expect(doc.argv).toEqual(["q w"]);
      expect(doc.env).toBe(KEY_VALUE);
    } finally {
      await v.stop();
    }
  });

  test("vault-status / vault-revoke / vault-audit", async () => {
    const v = await new FakeVault().start();
    v.reply = () => ({
      ok: true,
      pending: [],
      budget: { approvals_last_hour: 0, cap: 5 },
    });
    try {
      const r1 = await runJarate(["vault-status"], v.env());
      expect(r1.code).toBe(0);
      expect(v.lines[0].op).toBe("vstatus");

      const r2 = await runJarate(["vault-revoke", "vault_f1"], v.env());
      expect(r2.code).toBe(0);
      expect(v.lines[1].op).toBe("vrevoke");
    } finally {
      await v.stop();
    }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fvj-"));
    const ap = path.join(dir, "audit.log");
    fs.writeFileSync(ap, `${JSON.stringify({ ts: "1", event: "request" })}\n`, {
      mode: 0o600,
    });
    const r3 = await runJarate(["vault-audit", "5"], {
      JARATE_VAULT_AUDIT_FILE: ap,
      JARATE_AGENT: "monky",
    });
    expect(r3.code).toBe(0);
    expect((JSON.parse(r3.out) as Doc).count).toBe(1);
  });
});
