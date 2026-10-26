/**
 * Pin tests for the shared secret-pattern table (issue #254).
 *
 * ./secret-patterns.ts is the single source of truth for both redaction
 * engines — log (sanitize.ts) and egress (censor.ts). These tests pin
 * every entry: name, order, scope, regex source + flags, and
 * replacement. Any mutation — a dropped pattern, a reordered entry, a
 * shortened length specifier ({36} → {35}), a scope flip, a changed
 * replacement — fails here. The behavior of each engine is pinned by
 * sanitize.test.ts / censor.test.ts; the log-vs-egress split is pinned
 * behaviorally in "log-vs-egress split (behavior)" below.
 */
import { describe, expect, test } from "bun:test";
import { censor } from "./censor";
import {
  EGRESS_SECRET_RULES,
  LOG_SECRET_RULES,
  SECRET_PATTERNS,
  type SecretPattern,
  type SecretReplacement,
  type SecretScope,
} from "./secret-patterns";
import { sanitizeSensitiveText } from "./sanitize";

interface PinnedSide {
  /** Exact regex source (carries the length specifiers). */
  src: string;
  flags: string;
  /** Application order within the engine (lower runs first). */
  order: number;
  /** Pinned for string replacements; function replacements are probed
   *  separately ("function replacements are pinned by probe"). */
  sub?: string;
}

interface PinnedEntry {
  name: string;
  scope: SecretScope;
  paths?: boolean;
  log?: PinnedSide;
  egress?: PinnedSide;
}

/** The table as it must be. Keep in sync with secret-patterns.ts —
 *  that is the point: any drift fails CI. */
const PINNED: PinnedEntry[] = [
  {
    name: "github",
    scope: "both",
    log: {
      src: "\\bgh[pousr]_[A-Za-z0-9]{20,}\\b",
      order: 4,
      flags: "g",
      sub: "[REDACTED_GITHUB_TOKEN]",
    },
    egress: {
      src: "\\b(?:gh[pousr]_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{22,255})\\b",
      order: 1,
      flags: "g",
      sub: "[REDACTED:github]",
    },
  },
  {
    name: "switchboard",
    scope: "egress",
    egress: {
      src: "\\bsbk\\\\?_[A-Za-z0-9\\\\_]{8,}\\b",
      order: 2,
      flags: "g",
      sub: "[REDACTED:switchboard]",
    },
  },
  {
    name: "gitlab",
    scope: "egress",
    egress: {
      src: "\\bglpat-[A-Za-z0-9_-]{8,}\\b",
      order: 3,
      flags: "g",
      sub: "[REDACTED:gitlab]",
    },
  },
  {
    name: "anthropic",
    scope: "egress",
    egress: {
      src: "\\bsk-ant-[A-Za-z0-9_-]{8,}\\b",
      order: 4,
      flags: "g",
      sub: "[REDACTED:anthropic]",
    },
  },
  {
    name: "openai",
    scope: "both",
    log: {
      src: "\\bsk-[A-Za-z0-9]{16,}\\b",
      order: 2,
      flags: "g",
      sub: "[REDACTED_OPENAI_KEY]",
    },
    egress: {
      src: "\\bsk-(?:or-[A-Za-z0-9_-]{8,}|[A-Za-z0-9]{20,})\\b",
      order: 5,
      flags: "g",
      sub: "[REDACTED:openai]",
    },
  },
  {
    name: "aws",
    scope: "egress",
    egress: {
      src: "\\bAKIA[0-9A-Z]{16}\\b",
      order: 6,
      flags: "g",
      sub: "[REDACTED:aws]",
    },
  },
  {
    name: "google",
    scope: "both",
    log: {
      src: "\\bAIza[0-9A-Za-z_-]{20,}\\b",
      order: 3,
      flags: "g",
      sub: "[REDACTED_GOOGLE_KEY]",
    },
    egress: {
      src: "\\bAIza[0-9A-Za-z_-]{35}\\b",
      order: 7,
      flags: "g",
      sub: "[REDACTED:google]",
    },
  },
  {
    name: "slack",
    scope: "egress",
    egress: {
      src: "\\bxox[baprs]-[A-Za-z0-9-]{10,}\\b",
      order: 8,
      flags: "g",
      sub: "[REDACTED:slack]",
    },
  },
  {
    name: "bearer",
    scope: "both",
    log: {
      src: "\\bBearer\\s+[A-Za-z0-9._-]{10,}\\b",
      order: 1,
      flags: "gi",
      sub: "Bearer [REDACTED]",
    },
    egress: {
      src: "\\bBearer\\s+[A-Za-z0-9._~+-]{8,}",
      order: 9,
      flags: "g",
      sub: "Bearer [REDACTED:bearer]",
    },
  },
  {
    name: "discord",
    scope: "log",
    log: {
      src: "\\b[A-Za-z0-9_-]{20,}\\.[A-Za-z0-9_-]{6}\\.[A-Za-z0-9_-]{25,}\\b",
      order: 5,
      flags: "g",
      sub: "[REDACTED_DISCORD_TOKEN]",
    },
  },
  {
    name: "dsn",
    scope: "egress",
    egress: {
      src: "\\b(postgres(?:ql)?|mysql|rediss?|mongodb(?:\\+srv)?|amqps?):\\/\\/(?:(?:[^@\\s/:]+)?:)?[^@\\s/:]+@",
      order: 10,
      flags: "gi",
    },
  },
  {
    name: "sshpass",
    scope: "egress",
    egress: {
      src: "\\bsshpass\\s+-p\\s+(?!\\[)\\S+",
      order: 11,
      flags: "g",
      sub: "sshpass -p [REDACTED:sshpass]",
    },
  },
  {
    name: "kv-query",
    scope: "log",
    log: {
      src: "([?&](?:token|api[_-]?key|key|secret|password|authorization)=)[^&\\s]+",
      order: 6,
      flags: "gi",
      sub: "$1[REDACTED]",
    },
  },
  {
    name: "kv-quoted",
    scope: "log",
    log: {
      src: "(\\b(?:token|api[_-]?key|secret|password|authorization)\\b\\s*[:=]\\s*\")([^\"]+)(\")",
      order: 7,
      flags: "gi",
      sub: "$1[REDACTED]$3",
    },
  },
  {
    name: "kv-bare",
    scope: "log",
    log: {
      src: "(\\b(?:token|api[_-]?key|secret|password|authorization)\\b\\s*[:=]\\s*)([^\\s,;]+)",
      order: 8,
      flags: "gi",
      sub: "$1[REDACTED]",
    },
  },
  {
    name: "kv",
    scope: "egress",
    egress: {
      src: "(?<![\\w-])\\b(password|passwd|secret|token|api[_-]?key)\\b\\s*=\\s*(\"[^\"]*\"|'[^']*'|(?!\\[)\\S+)",
      order: 12,
      flags: "gi",
    },
  },
  {
    name: "kv",
    scope: "egress",
    egress: {
      src: "(?<![\\w-])\\b(password|passwd|secret|token)\\b\\s*:\\s*(\"[^\"]{4,}\"|'[^']{4,}'|[^\\s,:;'\"[\\]]{8,})",
      order: 13,
      flags: "gi",
    },
  },
  {
    name: "path-unix",
    scope: "log",
    paths: true,
    log: {
      src: "\\/(?:Users|home)\\/[^/\\s]+\\/[^\\s'\"`)]*",
      order: 9,
      flags: "g",
      sub: "[REDACTED_PATH]",
    },
  },
  {
    name: "path-win",
    scope: "log",
    paths: true,
    log: {
      src: "[A-Za-z]:\\\\[^\\s'\"`)]*",
      order: 10,
      flags: "g",
      sub: "[REDACTED_PATH]",
    },
  },
];

/** Project a table entry to its pin-relevant shape. */
function project(p: SecretPattern): PinnedEntry {
  const out: PinnedEntry = { name: p.name, scope: p.scope };
  if (p.paths === true) out.paths = true;
  if (p.log) {
    out.log = {
      src: p.log.re.source,
      flags: p.log.re.flags,
      order: p.log.order,
    };
    if (typeof p.log.sub === "string") out.log.sub = p.log.sub;
  }
  if (p.egress) {
    out.egress = {
      src: p.egress.re.source,
      flags: p.egress.re.flags,
      order: p.egress.order,
    };
    if (typeof p.egress.sub === "string") out.egress.sub = p.egress.sub;
  }
  return out;
}

describe("shared secret table (issue #254)", () => {
  test("table matches the pin exactly (name, order, scope, source, flags, sub)", () => {
    expect(SECRET_PATTERNS.map(project)).toEqual(PINNED);
  });

  test("scope and sides are consistent", () => {
    for (const p of SECRET_PATTERNS) {
      if (p.scope === "both") {
        expect(p.log, `${p.name}: both needs a log side`).toBeDefined();
        expect(p.egress, `${p.name}: both needs an egress side`).toBeDefined();
      } else if (p.scope === "log") {
        expect(p.log, `${p.name}: log scope needs a log side`).toBeDefined();
        expect(p.egress, `${p.name}: log scope must not have egress`).toBeUndefined();
      } else {
        expect(p.egress, `${p.name}: egress scope needs an egress side`).toBeDefined();
        expect(p.log, `${p.name}: egress scope must not have log`).toBeUndefined();
      }
      // every pattern matches globally (multi-match per line)
      for (const side of [p.log, p.egress]) {
        if (side) expect(side.re.flags, `${p.name}: global flag`).toContain("g");
      }
      // path rules are log-engine only
      if (p.paths === true) expect(p.scope, `${p.name}: paths is log-only`).toBe("log");
    }
  });

  test("both engines consume the shared table (no private copies)", () => {
    // log engine: every log side, sorted by its order
    const expectedLog = SECRET_PATTERNS.filter(
      (p) => (p.scope === "both" || p.scope === "log") && p.log,
    )
      .map((p) => p)
      .sort((a, b) => a.log!.order - b.log!.order);
    expect(LOG_SECRET_RULES.length).toBe(expectedLog.length);
    LOG_SECRET_RULES.forEach((rule, i) => {
      expect(rule.re, `log rule ${i} is the table's regex`).toBe(
        expectedLog[i].log!.re,
      );
      expect(rule.sub, `log rule ${i} is the table's replacement`).toBe(
        expectedLog[i].log!.sub,
      );
      expect(rule.paths).toBe(expectedLog[i].paths === true);
    });
    // egress engine: every egress side, sorted by its order
    const expectedEgress = SECRET_PATTERNS.filter(
      (p) => (p.scope === "both" || p.scope === "egress") && p.egress,
    )
      .map((p) => p)
      .sort((a, b) => a.egress!.order - b.egress!.order);
    expect(EGRESS_SECRET_RULES.length).toBe(expectedEgress.length);
    EGRESS_SECRET_RULES.forEach((rule, i) => {
      expect(rule.re, `egress rule ${i} is the table's regex`).toBe(
        expectedEgress[i].egress!.re,
      );
      expect(rule.sub, `egress rule ${i} is the table's replacement`).toBe(
        expectedEgress[i].egress!.sub,
      );
      expect(rule.cls, `egress rule ${i} WARN tag`).toBe(expectedEgress[i].name);
    });
  });

  test("function replacements are pinned by probe", () => {
    const bySrc = (needle: string) => {
      const hit = SECRET_PATTERNS.find(
        (p) => p.egress?.re.source.includes(needle),
      );
      expect(hit?.egress, `no egress rule containing ${needle}`).toBeDefined();
      return hit!.egress!;
    };
    const probe = (sub: SecretReplacement, ...groups: string[]): string => {
      expect(typeof sub, "probe side has a function replacement").toBe(
        "function",
      );
      return (sub as (m: string, ...g: string[]) => string)("m", ...groups);
    };
    const dsn = bySrc("postgres(?:ql)?|mysql");
    expect(probe(dsn.sub, "Postgres")).toBe("postgres://[REDACTED:dsn]@");
    expect(probe(dsn.sub, "redis")).toBe("redis://[REDACTED:dsn]@");
    const kvEq = bySrc("password|passwd|secret|token|api[_-]?key");
    expect(probe(kvEq.sub, "Password")).toBe("password=[REDACTED:kv]");
    const kvColon = bySrc(
      "(?<![\\w-])\\b(password|passwd|secret|token)\\b\\s*:",
    );
    expect(probe(kvColon.sub, "Token")).toBe("token: [REDACTED:kv]");
  });
});

describe("log-vs-egress split (behavior)", () => {
  const NOFILE = "/nonexistent/secrets-254.txt"; // missing file: patterns only
  const T36 = "aB3".repeat(12); // 36 alnum (classic PAT body)
  const GHP = `ghp_${T36}`;
  const GHP35 = `ghp_${"c".repeat(35)}`; // one short of the egress shape
  const GPAT = `github_pat_${"a1".repeat(11)}`; // fine-grained (22)
  const DISCORD =
    "MTA5MTk5NTIxMTM4OTk3NzUxMg.MnOpQr.STU-VWXyzaBCdefGHIjklMNOpQrSTU";

  test("classic ghp_ token: redacted by BOTH engines", () => {
    expect(sanitizeSensitiveText(`x ${GHP} y`)).toBe(
      "x [REDACTED_GITHUB_TOKEN] y",
    );
    expect(censor(`x ${GHP} y`, { file: NOFILE })).toBe(
      "x [REDACTED:github] y",
    );
  });

  test("ghp_ one char short of egress shape: log redacts ({20,}), egress leaves ({36})", () => {
    expect(sanitizeSensitiveText(`x ${GHP35} y`)).toBe(
      "x [REDACTED_GITHUB_TOKEN] y",
    );
    expect(censor(`x ${GHP35} y`, { file: NOFILE })).toBe(`x ${GHP35} y`);
  });

  test("github_pat_: egress redacts, log leaves (documented split)", () => {
    expect(censor(GPAT, { file: NOFILE })).toBe("[REDACTED:github]");
    expect(sanitizeSensitiveText(GPAT)).toBe(GPAT);
  });

  test("egress-only classes stay out of logs", () => {
    for (const s of [
      "AKIAIOSFODNN7EXAMPLE",
      "glpat-AbCdEf123456XyZwQq",
      "xoxb-1234567890-abcdefghij",
      "sbk_agent_0123456789abcdef",
      "postgres://dbuser:hunter2!@db:5432/prod",
    ]) {
      expect(sanitizeSensitiveText(s), `log must leave ${s}`).toBe(s);
    }
    expect(censor("AKIAIOSFODNN7EXAMPLE", { file: NOFILE })).toBe(
      "[REDACTED:aws]",
    );
  });

  test("discord token: log redacts, egress leaves (documented split)", () => {
    expect(sanitizeSensitiveText(DISCORD)).toBe("[REDACTED_DISCORD_TOKEN]");
    expect(censor(DISCORD, { file: NOFILE })).toBe(DISCORD);
  });
});
