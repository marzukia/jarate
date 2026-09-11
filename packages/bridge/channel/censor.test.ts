import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  censor,
  clearCensorWarns,
  clearRegistryCache,
  loadRegistry,
} from "./censor";

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

describe("pattern classes", () => {
  test("github classic token ghp_", () => {
    const out = censor(
      `url: https://ghp_aBc123D456eF78901234567890123456@github.com/x/y.git`,
      { file: R },
    );
    expect(out).toContain("[REDACTED:github]");
    expect(out).not.toContain("ghp_aBc123");
  });

  test("github fine-grained token github_pat_", () => {
    const out = censor("token github_pat_11ABCDEFG1234567890abcdefgh here", {
      file: R,
    });
    expect(out).toBe("token [REDACTED:github] here");
  });

  test("github read-only token gho_ (x-access-token)", () => {
    const out = censor(
      "https://x-access-token:gho_Xy9876543210AbCdEfGhIjKl@h",
      {
        file: R,
      },
    );
    expect(out).toContain("x-access-token:[REDACTED:github]@h");
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
    expect(out).toBe(
      "sshpass -p [REDACTED:sshpass] ssh andryo@10.9.8.7 ls",
    );
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
});

describe("registry", () => {
  test("exact literal from secrets.txt, longest-first", () => {
    reg(["REDACTED", "REDACTED-extended-sudo"]);
    const out = censor(
      "run sudo -S with REDACTED-extended-sudo, or just REDACTED",
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
    expect(() =>
      censor("REDACTED and ghp_aBc123D456eF78901234567890123456", {
        file: R,
      }),
    ).not.toThrow();
    const out = censor("REDACTED and ghp_aBc123D456eF78901234567890123456", {
      file: R,
    });
    expect(out).toContain("REDACTED"); // no registry → literal survives
    expect(out).toContain("[REDACTED:github]"); // patterns still fire
  });

  test("unreadable directory path never throws", () => {
    const d = path.join(tmp, "adir");
    fs.mkdirSync(d);
    expect(() => censor("x", { file: d })).not.toThrow();
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
      "ghp_aBc123D456eF78901234567890123456",
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
    const secret = "REDACTED";
    reg([secret]);
    const out = censor(`echo ${secret}`, { file: registryFile });
    expect(out).not.toContain(secret);
    expect(out).toContain("[REDACTED:secret#1]");
  });

  test("registry match logs WARN with fingerprint, not the raw value", () => {
    const lines: string[] = [];
    reg(["REDACTEDpassword"]);
    censor("echo REDACTEDpassword", {
      file: registryFile,
      log: (l) => lines.push(l),
    });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("secret#1");
    expect(lines[0]).toContain("phis"); // first 4
    expect(lines[0]).toContain("word"); // last 4
    expect(lines[0]).not.toContain("REDACTEDpassword"); // no raw value
  });

  test("short registry secret fingerprint is length only (no leak)", () => {
    const lines: string[] = [];
    reg(["REDACTED"]); // 8 chars: first4+last4 would be the whole secret
    censor("echo REDACTED", { file: registryFile, log: (l) => lines.push(l) });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("8ch");
    expect(lines[0]).not.toContain("REDACTED");
  });

  test("pattern match logs WARN with class only", () => {
    const lines: string[] = [];
    censor("ghp_aBc123D456eF78901234567890123456", {
      file: R,
      log: (l) => lines.push(l),
    });
    expect(lines.some((l) => l.includes("class=github"))).toBe(true);
    expect(lines.join(" ")).not.toContain("ghp_aBc123");
  });

  test("WARN fires once per fingerprint (tick-edit spam guard)", () => {
    const lines: string[] = [];
    const opts = { file: R, log: (l: string) => lines.push(l) };
    censor("ghp_aBc123D456eF78901234567890123456", opts);
    censor("ghp_aBc123D456eF78901234567890123456", opts);
    expect(lines).toHaveLength(1);
  });
});
