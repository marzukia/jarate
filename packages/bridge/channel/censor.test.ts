import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  censor,
  clearCensorWarns,
  clearRegistryCache,
  loadRegistry,
} from "./censor";
import { toolActionText } from "./index";

let tmp: string;
let registryFile: string;
let R: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "censor-"));
  registryFile = path.join(tmp, "secrets.txt");
  R = path.join(tmp, "nope-secrets.txt"); // missing file
  clearCensorWarns();
  clearRegistryCache();
});

afterEach(() => {
  clearRegistryCache();
  fs.rmSync(tmp, { recursive: true, force: true });
});
const reg = (lines: string[]) => {
  fs.writeFileSync(registryFile, `${lines.join("\n")}\n`);
  clearRegistryCache();
};

// Realistic token shapes (classic PAT = prefix + exactly 36 alnum;
// switchboard key = sbk_<name>_<16 hex>).
const T36 = "aB3".repeat(12); // 36 alnum
const GHP = `ghp_${T36}`;
const GHO = `gho_${T36}`;
const SBK = "sbk_<agent>_<hex>";

describe("pattern classes", () => {
  test("github classic token ghp_ (36 alnum)", () => {
    const out = censor(`url: https://${GHP}@github.com/x/y.git`, { file: R });
    expect(out).toBe(`url: https://[REDACTED:github]@github.com/x/y.git`);
    expect(out).not.toContain(T36);
  });

  test("github: every classic prefix form (36 alnum)", () => {
    for (const prefix of ["ghp_", "gho_", "ghu_", "ghs_", "ghr_"]) {
      expect(censor(`x ${prefix}${T36} y`, { file: R })).toBe(
        "x [REDACTED:github] y",
      );
    }
  });

  test("github fine-grained token github_pat_", () => {
    const out = censor("token github_pat_11ABCDEFG1234567890abcdefgh here", {
      file: R,
    });
    expect(out).toBe("token [REDACTED:github] here");
  });

  test("github read-only token gho_ (x-access-token)", () => {
    const out = censor(`https://x-access-token:${GHO}@h`, { file: R });
    expect(out).toContain("x-access-token:[REDACTED:github]@h");
  });

  test("github_pat_: 22 and 255 word chars redact; 21 and 256 stay", () => {
    const min = `github_pat_${"a1".repeat(11)}`; // 22
    const max = `github_pat_${"b2c".repeat(85)}`; // 255
    expect(censor(min, { file: R })).toBe("[REDACTED:github]");
    expect(censor(max, { file: R })).toBe("[REDACTED:github]");
    const short = `github_pat_${"a".repeat(21)}`;
    const long = `github_pat_${"b".repeat(256)}`;
    expect(censor(short, { file: R })).toBe(short);
    expect(censor(long, { file: R })).toBe(long);
  });

  test("github: short/partial runs do not trigger (no false positives)", () => {
    const s35 = `ghp_${"c".repeat(35)}`; // one short of a real token
    const s37 = `ghp_${"d".repeat(37)}`; // one long: not a token shape
    expect(censor(s35, { file: R })).toBe(s35);
    expect(censor(s37, { file: R })).toBe(s37);
    expect(censor("ghp_ and ghp_abc are not tokens", { file: R })).toBe(
      "ghp_ and ghp_abc are not tokens",
    );
    // no word boundary before the prefix: not token-shaped
    expect(censor(`xghp_${T36}`, { file: R })).toBe(`xghp_${T36}`);
  });

  test("switchboard house key sbk_ (issue #54)", () => {
    expect(censor(SBK, { file: R })).toBe("[REDACTED:switchboard]");
    expect(censor(`apiKey ${SBK}`, { file: R })).toBe(
      "apiKey [REDACTED:switchboard]",
    );
    // rendered tool-line form: markdown-escaped underscores
    expect(
      censor(`bash echo sbk\\_jimmy\\_56659a2ca404b4a6`, { file: R }),
    ).toBe("bash echo [REDACTED:switchboard]");
    // short tails and the bare prefix stay
    expect(censor("the sbk_ key and sbk_abc", { file: R })).toBe(
      "the sbk_ key and sbk_abc",
    );
  });

  test("forwarded tool-call line: inline GH_TOKEN redacts (issue #54 leak shape)", () => {
    const line = `┣ bash python3 -c "import os" GH_TOKEN=${GHP} SHARD=1`;
    const out = censor(line, { file: R });
    expect(out).toBe(
      `┣ bash python3 -c "import os" GH_TOKEN=[REDACTED:github] SHARD=1`,
    );
    expect(out).not.toContain(T36);
  });

  test("render path: toolActionText censors BEFORE the frame clip", () => {
    // The 26-char switchboard key is longer than the 23-col bash text
    // budget, so censor runs first (audit 2026-09-15, aesthetics #2):
    // the key is redacted whole, then the [REDACTED:...] marker itself is
    // what the clip trims - no raw key can reach the frame. (The
    // final-send censor still sees the escaped + clipped form, so its
    // pattern keeps the sbk\_ shape - see censor.ts.)
    const action = toolActionText("bash", { command: `echo ${SBK}` });
    expect(action).toBe("bash echo [REDACTED:switchb…");
    expect(action).not.toContain(SBK);
    expect(`│ ├ ${action}`.length).toBeLessThanOrEqual(32);
    expect(censor(action, { file: R })).not.toContain(SBK);
    // A classic token (40 chars) can never survive the clip whole; the
    // censor takes it out before the clip, and the full value must not
    // appear in the rendered line.
    const clipped = toolActionText("bash", {
      command: `GH_TOKEN=${GHP} python -c 'print(1)'`,
    });
    expect(clipped).not.toContain(GHP);
    expect(censor(clipped, { file: R })).not.toContain(GHP);
  });

  test("gitlab glpat-", () => {
    const out = censor("glpat-AbCdEf123456XyZwQq", { file: R });
    expect(out).toBe("[REDACTED:gitlab]");
  });

  test("anthropic sk-ant-", () => {
    const out = censor("key: sk-ant-api03-abcdefghijklmnopqrstuvwxyz1234", {
      file: R,
    });
    expect(out).toBe("key: [REDACTED:anthropic]");
  });

  test("openai sk-or- and generic sk-", () => {
    expect(censor("sk-or-v1-abcdef1234567890abcdef", { file: R })).toBe(
      "[REDACTED:openai]",
    );
    expect(censor("sk-aabbccddeeffgghhiijj", { file: R })).toBe(
      "[REDACTED:openai]",
    );
  });

  test("aws AKIA key id", () => {
    const out = censor("aws_access_key_id=AKIAIOSFODNN7EXAMPLE", { file: R });
    expect(out).toBe("aws_access_key_id=[REDACTED:aws]");
  });

  test("google AIza key", () => {
    const out = censor("AIzaSyA1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q", { file: R });
    expect(out).toBe("[REDACTED:google]");
  });

  test("slack xoxb token", () => {
    const out = censor("xoxb-1234567890-abcdefghij", { file: R });
    expect(out).toBe("[REDACTED:slack]");
  });

  test("Bearer hex token", () => {
    const out = censor("Authorization: Bearer ab12cd34ef567890", { file: R });
    expect(out).toBe("Authorization: Bearer [REDACTED:bearer]");
  });

  test("DSN user:pass and :pass forms", () => {
    expect(censor("postgres://dbuser:hunter2!@db:5432/prod", { file: R })).toBe(
      "postgres://[REDACTED:dsn]@db:5432/prod",
    );
    expect(censor("redis://:s3cr3tpw@cache:6379", { file: R })).toBe(
      "redis://[REDACTED:dsn]@cache:6379",
    );
    expect(censor("mysql://root:pw@host:3306/x", { file: R })).toBe(
      "mysql://[REDACTED:dsn]@host:3306/x",
    );
    // no credentials → untouched
    expect(censor("postgres://host:5432/db", { file: R })).toBe(
      "postgres://host:5432/db",
    );
  });

  test("sshpass -p <arg>", () => {
    const out = censor("sshpass -p hunter2 ssh andryo@10.9.8.7 ls", {
      file: R,
    });
    expect(out).toBe("sshpass -p [REDACTED:sshpass] ssh andryo@10.9.8.7 ls");
  });

  test("key-adjacent values in code blocks", () => {
    const out = censor('```\npassword=hunter2\ntoken: "abc123def"\n```', {
      file: R,
    });
    expect(out).toContain("password=[REDACTED:kv]");
    expect(out).toContain("token: [REDACTED:kv]");
    expect(out).not.toContain("hunter2");
    expect(out).not.toContain("abc123def");
  });

  test("kv colon: short prose values stay, token-like values redact", () => {
    // reviewer repro: 6-letter English word after a colon is not a secret
    expect(censor("the password: forgot it quickly", { file: R })).toBe(
      "the password: forgot it quickly",
    );
    // 7 chars (just under the 8-char unquoted bar) also stays
    expect(censor("token: changed", { file: R })).toBe("token: changed");
    // real token after colon (12 alnum) — redacted
    expect(censor("token: a1b2c3d4e5f6", { file: R })).toBe(
      "token: [REDACTED:kv]",
    );
    // quoted values keep the lower 4-char bar
    expect(censor('password: "abc123"', { file: R })).toBe(
      "password: [REDACTED:kv]",
    );
    // the = rule is unchanged (strongest leak signal, any value)
    expect(censor("password=x", { file: R })).toBe("password=[REDACTED:kv]");
  });
});

describe("registry", () => {
  test("exact literal from secrets.txt, longest-first", () => {
    reg(["testpass", "testpass-extended-sudo"]);
    const out = censor(
      "run sudo -S with testpass-extended-sudo, or just testpass",
      { file: registryFile },
    );
    expect(out).toBe(
      "run sudo -S with [REDACTED:secret#2], or just [REDACTED:secret#1]",
    );
  });

  test("longest-first: substring literal does not eat longer one", () => {
    reg(["abc", "abcdef"]);
    const out = censor("x abcdef y abc z", { file: registryFile });
    expect(out).toBe("x [REDACTED:secret#2] y [REDACTED:secret#1] z");
  });

  test("comments and blank lines skipped; index is file order", () => {
    reg(["# the sudo password", "", "hunter2"]);
    expect(loadRegistry(registryFile)).toEqual([
      { index: 1, literal: "hunter2" },
    ]);
    expect(censor("pw=hunter2", { file: registryFile })).toBe(
      "pw=[REDACTED:secret#1]",
    );
  });

  test("missing file = patterns only, never an error", () => {
    expect(() => censor(`testpass and ${GHP}`, { file: R })).not.toThrow();
    const out = censor(`testpass and ${GHP}`, { file: R });
    expect(out).toContain("testpass"); // no registry → literal survives
    expect(out).toContain("[REDACTED:github]"); // patterns still fire
  });

  test("unreadable directory path never throws", () => {
    const d = path.join(tmp, "adir");
    fs.mkdirSync(d);
    expect(() => censor("x", { file: d })).not.toThrow();
  });

  test("registry lines are trimmed; whitespace-only lines skipped", () => {
    reg(["trailsec  ", "   ", "# comment  "]);
    expect(loadRegistry(registryFile)).toEqual([
      { index: 1, literal: "trailsec" },
    ]);
    // trailing-space line still matches egress text (reviewer repro)
    expect(censor("value trailsec. end", { file: registryFile })).toBe(
      "value [REDACTED:secret#1]. end",
    );
    // whitespace-only line must not mangle prose spacing
    const ws = path.join(tmp, "ws.txt");
    fs.writeFileSync(ws, "\n   \n");
    expect(loadRegistry(ws)).toEqual([]);
    expect(censor("a   b", { file: ws })).toBe("a   b");
  });
});

describe("behavior", () => {
  test("pass-through: the word 'password' alone is not redacted", () => {
    const lines = [
      "the password is fine",
      "┣ working…",
      "done. tests green.",
      "can I reset your password?",
      "password policy discussion",
    ];
    for (const line of lines) expect(censor(line, { file: R })).toBe(line);
  });

  test("idempotent: censor(censor(x)) === censor(x)", () => {
    const x = [
      GHP,
      "postgres://u:p@h:5432/d",
      "sshpass -p pw cmd",
      '```password=x\ntoken: "abcdef123"```',
      "Bearer ab12cd34ef567890",
      "glpat-AbCdEf123456XyZwQq",
      "the word password alone",
    ].join("\n");
    reg(["somesecret"]);
    const x2 = `${x}\nsomesecret`;
    const once = censor(x2, { file: registryFile });
    const twice = censor(once, { file: registryFile });
    expect(twice).toBe(once);
    expect(once).not.toContain("somesecret");
  });

  test("raw value never appears in output", () => {
    const secret = "testpass";
    reg([secret]);
    const out = censor(`echo ${secret}`, { file: registryFile });
    expect(out).not.toContain(secret);
    expect(out).toContain("[REDACTED:secret#1]");
  });

  test("registry match logs WARN with fingerprint, not the raw value", () => {
    const lines: string[] = [];
    reg(["testpassphrase"]);
    censor("echo testpassphrase", {
      file: registryFile,
      log: (l) => lines.push(l),
    });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("secret#1");
    expect(lines[0]).toContain("test"); // first 4
    expect(lines[0]).toContain("rase"); // last 4
    expect(lines[0]).not.toContain("testpassphrase"); // no raw value
  });

  test("short registry secret fingerprint is length only (no leak)", () => {
    const lines: string[] = [];
    reg(["testpass"]); // 8 chars: first4+last4 would be the whole secret
    censor("echo testpass", { file: registryFile, log: (l) => lines.push(l) });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("8ch");
    expect(lines[0]).not.toContain("testpass");
  });

  test("pattern match logs WARN with class only", () => {
    const lines: string[] = [];
    censor(GHP, {
      file: R,
      log: (l) => lines.push(l),
    });
    expect(lines.some((l) => l.includes("class=github"))).toBe(true);
    expect(lines.join(" ")).not.toContain("ghp_aB3");
  });

  test("WARN fires once per fingerprint (tick-edit spam guard)", () => {
    const lines: string[] = [];
    const opts = { file: R, log: (l: string) => lines.push(l) };
    censor(GHP, opts);
    censor(GHP, opts);
    expect(lines).toHaveLength(1);
  });
});

describe("jarate-censor CLI (bin/jarate-censor: stdin -> censor -> stdout)", () => {
  const BIN = path.resolve(import.meta.dir, "../../../bin/jarate-censor");
  const run = (input: string, registry: string): string =>
    cp.execFileSync("bun", [BIN], {
      input,
      encoding: "utf-8",
      env: { ...process.env, JARATE_SECRETS_FILE: registry },
    });

  test("redacts with the same registry the bridge uses", () => {
    reg(["trailsecret"]);
    const out = run(`here is trailsecret and ${GHP}\n`, registryFile);
    expect(out).toBe("here is [REDACTED:secret#1] and [REDACTED:github]\n");
  });

  test("missing registry = patterns only, never fails the caller", () => {
    const out = run(GHP, R);
    expect(out).toBe("[REDACTED:github]");
  });

  test("pass-through text is unchanged (incl. trailing newline)", () => {
    const out = run("the password is fine\n", R);
    expect(out).toBe("the password is fine\n");
  });
});
