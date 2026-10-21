/**
 * Table-pinning test for the shared secret-pattern table (issue #254).
 *
 * secret-patterns.ts is the single source of truth for the two
 * redaction engines — sanitize (scope "log") and censor (scope
 * "egress"). This file pins the table so the engines cannot silently
 * diverge again:
 *
 *   - exactly the pinned entries exist (id + scope + order) — dropping
 *     or re-adding a pattern, or moving it to the other scope, fails
 *   - every entry keeps its exact pattern source (the length
 *     specifiers), flags, and replacement — shortening a specifier
 *     ({36} → {30,}) or dropping a flag fails
 *   - every entry still fires at its length threshold and stays quiet
 *     just below it (behavioral pin of each specifier)
 *   - the documented log/egress divergences (ghp_ {20,} vs {36},
 *     sk- {16,} vs {20,}, AIza {20,} vs {35}, Bearer {10,} vs {8,})
 *     are still preserved end to end through the real engines
 *
 * See docs/secret-censor.md for the split.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { censor } from "./censor";
import { sanitizeSensitiveText } from "./sanitize";
import {
  applyEntry,
  SECRET_PATTERNS,
  type SecretPatternEntry,
} from "./secret-patterns";

let tmp: string;
let R: string; // missing registry file: censor runs patterns-only

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "secret-table-"));
  R = path.join(tmp, "nope-secrets.txt");
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

const A = (n: number): string => "a".repeat(n);

interface PinnedPattern {
  id: string;
  scope: "log" | "egress";
  order: number;
  /** Exact regex source — pins the length specifiers. */
  source: string;
  flags: string;
  /** Exact string replacement (entries with a function sub use probe). */
  sub?: string;
  /** [match, ...groups] → expected output, for function subs. */
  probe?: { args: [string, ...string[]]; out: string };
  /** [input, exact output of applyEntry(input, entry)] — the pattern fires. */
  samples: [string, string][];
  /** Inputs applyEntry must leave untouched (below the length bar). */
  nonSamples: string[];
}

const PINNED: PinnedPattern[] = [
  // ── scope "egress" — censor.ts, application order 1..13 ──
  {
    id: "github",
    scope: "egress",
    order: 1,
    source:
      "\\b(?:gh[pousr]_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{22,255})\\b",
    flags: "g",
    sub: "[REDACTED:github]",
    samples: [
      [`ghp_${A(36)}`, "[REDACTED:github]"],
      [`github_pat_${A(22)}`, "[REDACTED:github]"],
      [`github_pat_${A(255)}`, "[REDACTED:github]"],
    ],
    nonSamples: [
      `ghp_${A(35)}`,
      `ghp_${A(37)}`,
      `github_pat_${A(21)}`,
      `github_pat_${A(256)}`,
      `xghp_${A(36)}`, // no word boundary before the prefix
    ],
  },
  {
    id: "switchboard",
    scope: "egress",
    order: 2,
    source: "\\bsbk\\\\?_[A-Za-z0-9\\\\_]{8,}\\b",
    flags: "g",
    sub: "[REDACTED:switchboard]",
    samples: [
      ["sbk_agent_0123456789abcdef", "[REDACTED:switchboard]"],
      ["sbk\\_agent\\_0123456789abcdef", "[REDACTED:switchboard]"],
    ],
    nonSamples: ["sbk_", "sbk_abc"],
  },
  {
    id: "gitlab",
    scope: "egress",
    order: 3,
    source: "\\bglpat-[A-Za-z0-9_-]{8,}\\b",
    flags: "g",
    sub: "[REDACTED:gitlab]",
    samples: [["glpat-AbCdEf123456", "[REDACTED:gitlab]"]],
    nonSamples: ["glpat-AbCd"],
  },
  {
    id: "anthropic",
    scope: "egress",
    order: 4,
    source: "\\bsk-ant-[A-Za-z0-9_-]{8,}\\b",
    flags: "g",
    sub: "[REDACTED:anthropic]",
    samples: [
      ["sk-ant-api03-abcdefghijklmnopqrstuvwxyz1234", "[REDACTED:anthropic]"],
    ],
    nonSamples: ["sk-ant-abcde"],
  },
  {
    id: "openai",
    scope: "egress",
    order: 5,
    source: "\\bsk-(?:or-[A-Za-z0-9_-]{8,}|[A-Za-z0-9]{20,})\\b",
    flags: "g",
    sub: "[REDACTED:openai]",
    samples: [
      ["sk-or-v1-abcdef1234567890abcdef", "[REDACTED:openai]"],
      [`sk-${A(20)}`, "[REDACTED:openai]"],
    ],
    nonSamples: [`sk-${A(19)}`],
  },
  {
    id: "aws",
    scope: "egress",
    order: 6,
    source: "\\bAKIA[0-9A-Z]{16}\\b",
    flags: "g",
    sub: "[REDACTED:aws]",
    samples: [["AKIAIOSFODNN7EXAMPLE", "[REDACTED:aws]"]],
    nonSamples: ["AKIAIOSFODNN7EXAMPL"],
  },
  {
    id: "google",
    scope: "egress",
    order: 7,
    source: "\\bAIza[0-9A-Za-z_-]{35}\\b",
    flags: "g",
    sub: "[REDACTED:google]",
    samples: [[`AIza${A(35)}`, "[REDACTED:google]"]],
    nonSamples: [`AIza${A(34)}`, `AIza${A(36)}`],
  },
  {
    id: "slack",
    scope: "egress",
    order: 8,
    source: "\\bxox[baprs]-[A-Za-z0-9-]{10,}\\b",
    flags: "g",
    sub: "[REDACTED:slack]",
    samples: [["xoxb-1234567890-abcdefghij", "[REDACTED:slack]"]],
    nonSamples: ["xoxb-abcde"],
  },
  {
    id: "bearer",
    scope: "egress",
    order: 9,
    source: "\\bBearer\\s+[A-Za-z0-9._~+-]{8,}",
    flags: "g",
    sub: "Bearer [REDACTED:bearer]",
    samples: [
      ["Bearer ab12cd34ef567890", "Bearer [REDACTED:bearer]"],
      ["Bearer abc123def", "Bearer [REDACTED:bearer]"], // 9: the {8,} bar
    ],
    nonSamples: ["Bearer ab12"],
  },
  {
    id: "dsn",
    scope: "egress",
    order: 10,
    source:
      "\\b(postgres(?:ql)?|mysql|rediss?|mongodb(?:\\+srv)?|amqps?):\\/\\/(?:(?:[^@\\s/:]+)?:)?[^@\\s/:]+@",
    flags: "gi",
    probe: {
      args: ["ignored", "PostgreSQL"],
      out: "postgresql://[REDACTED:dsn]@",
    },
    samples: [
      [
        "postgres://dbuser:hunter2!@db:5432/prod",
        "postgres://[REDACTED:dsn]@db:5432/prod",
      ],
      ["redis://:s3cr3tpw@cache:6379", "redis://[REDACTED:dsn]@cache:6379"],
    ],
    nonSamples: ["postgres://host:5432/db"],
  },
  {
    id: "sshpass",
    scope: "egress",
    order: 11,
    source: "\\bsshpass\\s+-p\\s+(?!\\[)\\S+",
    flags: "g",
    sub: "sshpass -p [REDACTED:sshpass]",
    samples: [
      [
        "sshpass -p hunter2 ssh alice@h ls",
        "sshpass -p [REDACTED:sshpass] ssh alice@h ls",
      ],
    ],
    nonSamples: ["sshpass -p [REDACTED:sshpass] rest"],
  },
  {
    id: "kv-eq",
    scope: "egress",
    order: 12,
    source:
      "(?<![\\w-])\\b(password|passwd|secret|token|api[_-]?key)\\b\\s*=\\s*(\"[^\"]*\"|'[^']*'|(?!\\[)\\S+)",
    flags: "gi",
    probe: { args: ["ignored", "PASSWORD"], out: "password=[REDACTED:kv]" },
    samples: [
      ["password=hunter2", "password=[REDACTED:kv]"],
      ['token="abc123"', "token=[REDACTED:kv]"],
    ],
    nonSamples: ["the password is fine"],
  },
  {
    id: "kv-colon",
    scope: "egress",
    order: 13,
    source:
      "(?<![\\w-])\\b(password|passwd|secret|token)\\b\\s*:\\s*(\"[^\"]{4,}\"|'[^']{4,}'|[^\\s,:;'\"[\\]]{8,})",
    flags: "gi",
    probe: { args: ["ignored", "Token"], out: "token: [REDACTED:kv]" },
    samples: [
      ["token: a1b2c3d4e5f6", "token: [REDACTED:kv]"],
      ['password: "abc123"', "password: [REDACTED:kv]"],
    ],
    nonSamples: ["the password: forgot it quickly", "token: changed"],
  },

  // ── scope "log" — sanitize.ts, application order 1..8 ──
  {
    id: "bearer",
    scope: "log",
    order: 1,
    source: "\\bBearer\\s+[A-Za-z0-9._-]{10,}\\b",
    flags: "gi",
    sub: "Bearer [REDACTED]",
    samples: [
      ["Bearer abc123def456", "Bearer [REDACTED]"],
      ["bearer abc123def456", "Bearer [REDACTED]"], // case-insensitive
    ],
    nonSamples: ["Bearer abc123def"], // 9: the {10,} bar
  },
  {
    id: "openai",
    scope: "log",
    order: 2,
    source: "\\bsk-[A-Za-z0-9]{16,}\\b",
    flags: "g",
    sub: "[REDACTED_OPENAI_KEY]",
    samples: [["sk-abcdefghijklmnop1234", "[REDACTED_OPENAI_KEY]"]],
    nonSamples: ["sk-abcdefghijklmno"], // 15: the {16,} bar
  },
  {
    id: "google",
    scope: "log",
    order: 3,
    source: "\\bAIza[0-9A-Za-z_-]{20,}\\b",
    flags: "g",
    sub: "[REDACTED_GOOGLE_KEY]",
    samples: [[`AIza${A(20)}`, "[REDACTED_GOOGLE_KEY]"]],
    nonSamples: [`AIza${A(19)}`],
  },
  {
    id: "github",
    scope: "log",
    order: 4,
    source: "\\bgh[pousr]_[A-Za-z0-9]{20,}\\b",
    flags: "g",
    sub: "[REDACTED_GITHUB_TOKEN]",
    samples: [
      [`ghp_${A(20)}`, "[REDACTED_GITHUB_TOKEN]"],
      [`gho_${A(36)}`, "[REDACTED_GITHUB_TOKEN]"],
    ],
    nonSamples: [`ghp_${A(19)}`],
  },
  {
    id: "discord",
    scope: "log",
    order: 5,
    source: "\\b[A-Za-z0-9_-]{20,}\\.[A-Za-z0-9_-]{6}\\.[A-Za-z0-9_-]{25,}\\b",
    flags: "g",
    sub: "[REDACTED_DISCORD_TOKEN]",
    samples: [
      [
        "MTA5MTk5NTIxMTM4OTk3NzUxMg.MnOpQr.STU-VWXyzaBCdefGHIjklMNOpQrSTU",
        "[REDACTED_DISCORD_TOKEN]",
      ],
    ],
    nonSamples: ["MTA5MTk9NTIxMTM4OTk3NzUxMg.MnOpQr.STU-VWXyzaBCdefGHIjklMNO"],
  },
  {
    id: "kv-query",
    scope: "log",
    order: 6,
    source:
      "([?&](?:token|api[_-]?key|key|secret|password|authorization)=)[^&\\s]+",
    flags: "gi",
    sub: "$1[REDACTED]",
    samples: [
      ["?token=abcdef123456", "?token=[REDACTED]"],
      ["&api_key=xyz", "&api_key=[REDACTED]"],
    ],
    nonSamples: ["token=abcdef"],
  },
  {
    id: "kv-quoted",
    scope: "log",
    order: 7,
    source:
      '(\\b(?:token|api[_-]?key|secret|password|authorization)\\b\\s*[:=]\\s*")([^"]+)(")',
    flags: "gi",
    sub: "$1[REDACTED]$3",
    samples: [['api_key: "supersecretvalue"', 'api_key: "[REDACTED]"']],
    nonSamples: ['api_key: ""'],
  },
  {
    id: "kv-bare",
    scope: "log",
    order: 8,
    source:
      "(\\b(?:token|api[_-]?key|secret|password|authorization)\\b\\s*[:=]\\s*)([^\\s,;]+)",
    flags: "gi",
    sub: "$1[REDACTED]",
    samples: [["secret=abcd1234efgh5678", "secret=[REDACTED]"]],
    nonSamples: ["session=abcd1234efgh5678"],
  },
];

const entryFor = (id: string, scope: "log" | "egress"): SecretPatternEntry => {
  const e = SECRET_PATTERNS.find((x) => x.id === id && x.scope === scope);
  expect(e, `table entry ${id}@${scope} is missing`).toBeDefined();
  return e as SecretPatternEntry;
};

describe("shared secret-pattern table (issue #254)", () => {
  test("exactly the pinned entries exist (id + scope + order): no drops, no additions, no re-scope", () => {
    const got = SECRET_PATTERNS.map(
      (e) => `${e.id}@${e.scope}@${e.order}`,
    ).sort();
    const want = PINNED.map((p) => `${p.id}@${p.scope}@${p.order}`).sort();
    expect(got).toEqual(want);
  });

  test("every entry is pinned: exact pattern source (length specifiers), flags, replacement", () => {
    for (const p of PINNED) {
      const e = entryFor(p.id, p.scope);
      expect(e.order, `${p.id}@${p.scope} order`).toBe(p.order);
      expect(e.re.source, `${p.id}@${p.scope} pattern source`).toBe(p.source);
      expect(e.re.flags, `${p.id}@${p.scope} flags`).toBe(p.flags);
      if (p.sub !== undefined) {
        expect(e.sub, `${p.id}@${p.scope} replacement`).toBe(p.sub);
      } else {
        expect(
          typeof e.sub,
          `${p.id}@${p.scope} replacement is a function`,
        ).toBe("function");
        const fn = e.sub as (m: string, ...groups: string[]) => string;
        const probe = p.probe as NonNullable<PinnedPattern["probe"]>;
        expect(fn(...probe.args), `${p.id}@${p.scope} replacement probe`).toBe(
          probe.out,
        );
      }
    }
  });

  test("every entry fires at its length threshold and stays quiet just below it", () => {
    for (const p of PINNED) {
      const e = entryFor(p.id, p.scope);
      for (const [input, want] of p.samples) {
        expect(
          applyEntry(input, e),
          `${p.id}@${p.scope} sample: ${input}`,
        ).toBe(want);
      }
      for (const input of p.nonSamples) {
        expect(
          applyEntry(input, e),
          `${p.id}@${p.scope} nonSample: ${input}`,
        ).toBe(input);
      }
    }
  });
});

describe("log-vs-egress split: the preserved divergences (e2e, real engines)", () => {
  const c = (s: string): string => censor(s, { file: R, log: () => {} });

  test("ghp_ + 20 alnum: redacted in logs ({20,}), passes egress (wants exactly 36)", () => {
    const s = `ghp_${A(20)}`;
    expect(sanitizeSensitiveText(s)).toBe("[REDACTED_GITHUB_TOKEN]");
    expect(c(s)).toBe(s);
  });

  test("ghp_ + 36 alnum: redacted by both, each with its own tag", () => {
    const s = `ghp_${A(36)}`;
    expect(sanitizeSensitiveText(s)).toBe("[REDACTED_GITHUB_TOKEN]");
    expect(c(s)).toBe("[REDACTED:github]");
  });

  test("sk- + 17 alnum: redacted in logs ({16,}), passes egress (wants {20,} or sk-or-)", () => {
    const s = `sk-${A(17)}`;
    expect(sanitizeSensitiveText(s)).toBe("[REDACTED_OPENAI_KEY]");
    expect(c(s)).toBe(s);
  });

  test("AIza + 36: redacted in logs ({20,}), passes egress (wants exactly 35)", () => {
    const s = `AIza${A(36)}`;
    expect(sanitizeSensitiveText(s)).toBe("[REDACTED_GOOGLE_KEY]");
    expect(c(s)).toBe(s);
  });

  test("AIza + 35: redacted by both", () => {
    const s = `AIza${A(35)}`;
    expect(sanitizeSensitiveText(s)).toBe("[REDACTED_GOOGLE_KEY]");
    expect(c(s)).toBe("[REDACTED:google]");
  });

  test("Bearer + 9-char value: redacted on egress ({8,}), passes logs ({10,})", () => {
    const s = "Bearer abc123def";
    expect(sanitizeSensitiveText(s)).toBe(s);
    expect(c(s)).toBe("Bearer [REDACTED:bearer]");
  });
});

describe("engines consume the shared table (source level, choke-point style)", () => {
  test("sanitize.ts applies the log-scope entries from the shared table", () => {
    const src = fs.readFileSync(
      path.join(import.meta.dir, "sanitize.ts"),
      "utf-8",
    );
    expect(src).toContain('from "./secret-patterns"');
    expect(src).toContain('patternsForScope("log")');
  });

  test("censor.ts applies the egress-scope entries from the shared table", () => {
    const src = fs.readFileSync(
      path.join(import.meta.dir, "censor.ts"),
      "utf-8",
    );
    expect(src).toContain('from "./secret-patterns"');
    expect(src).toContain('patternsForScope("egress")');
  });
});
