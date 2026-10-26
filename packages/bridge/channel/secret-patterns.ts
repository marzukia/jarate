/**
 * Shared secret-pattern table — the single source of truth for BOTH
 * redaction engines:
 *
 *   - log:    sanitizeSensitiveText (./sanitize.ts) — redacts log lines,
 *             capped tool output, and error payloads
 *   - egress: censor (./censor.ts) — redacts every string the bridge
 *             posts to Discord
 *
 * Each entry declares its SCOPE, so the log-vs-egress split is explicit
 * data instead of two drifting copies (issue #254):
 *
 *   - "both"   — both engines apply it, each with its own regex +
 *                replacement. Per-engine shape overrides live here as
 *                data (e.g. ghp_ is {36} on egress but {20,} on logs).
 *   - "log"    — log engine only (Discord bot tokens, key-value rules,
 *                path rules)
 *   - "egress" — egress engine only (github_pat_, sbk_, glpat-, AKIA,
 *                xox, DSN, sshpass)
 *
 * Why the shapes differ per engine: egress text is user-visible, so
 * egress shapes are strict — a ghp_ run redacts on egress at exactly 36
 * chars (a real PAT shape), not at 35 (not token-shaped; redacting would
 * eat user content, issue #54). Log text is not user-visible, so the log
 * side is looser ({20,} catches partials too: a partial match in a log
 * beats a live secret).
 *
 * APPLICATION ORDER is per-side data (SecretPatternSide.order, lower
 * runs first): the two engines need different orders. The log engine
 * runs Bearer before the sk- class (a Bearer value can carry an sk- key
 * in its run: `Bearer sk-…` must redact as one Bearer match, not let
 * the sk- rule split it); the egress engine runs its kv rules last
 * (they are the loosest and must not shadow the specific token
 * classes). The derived rule lists below sort by it.
 *
 * Pinned by secret-patterns.test.ts: drop a pattern, reorder, shorten a
 * length specifier, or flip a scope and CI fails. See
 * docs/secret-censor.md for the design and the full split table.
 */

export type SecretScope = "both" | "log" | "egress";

/** String replacement (backrefs like $1 are ok) or a function
 *  replacement. Never echo the raw value back: the egress censor is
 *  idempotent, so every replacement must match no later rule. */
export type SecretReplacement =
  | string
  | ((match: string, ...groups: string[]) => string);

export interface SecretPatternSide {
  re: RegExp;
  sub: SecretReplacement;
  /** Application order within the engine (lower runs first). */
  order: number;
}

export interface SecretPattern {
  /** Stable name. For egress-side rules it is also the WARN class tag
   *  (`[censor] class=<name>`); the two kv rules share the name "kv"
   *  (one class, two shapes: the `=` form and the `:` form). */
  name: string;
  /** Which engine(s) apply this pattern. */
  scope: SecretScope;
  /** Applied by the log engine when scope is "both" or "log". */
  log?: SecretPatternSide;
  /** Applied by the egress engine when scope is "both" or "egress". */
  egress?: SecretPatternSide;
  /** Log-engine only: applied only when sanitize's redactPaths option
   *  is set. */
  paths?: boolean;
}

export const SECRET_PATTERNS: SecretPattern[] = [
  {
    // Classic PAT: ghp_/gho_/ghu_/ghs_/ghr_ + exactly 36 alnum on egress
    // (short/partial runs are not token-shaped and must not trigger,
    // issue #54), +20+ alnum on logs. Fine-grained: github_pat_ +
    // 22..255 word chars — egress only.
    name: "github",
    scope: "both",
    log: {
      re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
      sub: "[REDACTED_GITHUB_TOKEN]",
      order: 4,
    },
    egress: {
      re: /\b(?:gh[pousr]_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{22,255})\b/g,
      sub: "[REDACTED:github]",
      order: 1,
    },
  },
  {
    // Switchboard house key: sbk_<name>_<16 hex> (docs/NEW-AGENT.md).
    // The run-frame path censors BEFORE it clips (toolActionText), so
    // the key is whole and unescaped there. The final-send censor still
    // sees the escaped + clipped form (sbk\_agent\_…, cut at the 28-col
    // text budget), so the pattern must accept the escaped form too.
    name: "switchboard",
    scope: "egress",
    egress: {
      re: /\bsbk\\?_[A-Za-z0-9\\_]{8,}\b/g,
      sub: "[REDACTED:switchboard]",
      order: 2,
    },
  },
  {
    name: "gitlab",
    scope: "egress",
    egress: {
      re: /\bglpat-[A-Za-z0-9_-]{8,}\b/g,
      sub: "[REDACTED:gitlab]",
      order: 3,
    },
  },
  {
    name: "anthropic",
    scope: "egress",
    egress: {
      re: /\bsk-ant-[A-Za-z0-9_-]{8,}\b/g,
      sub: "[REDACTED:anthropic]",
      order: 4,
    },
  },
  {
    // sk-ant- is its own egress class (sk-ant- is not a valid generic
    // sk- token: the hyphen breaks the alnum run).
    name: "openai",
    scope: "both",
    log: {
      re: /\bsk-[A-Za-z0-9]{16,}\b/g,
      sub: "[REDACTED_OPENAI_KEY]",
      order: 2,
    },
    egress: {
      re: /\bsk-(?:or-[A-Za-z0-9_-]{8,}|[A-Za-z0-9]{20,})\b/g,
      sub: "[REDACTED:openai]",
      order: 5,
    },
  },
  {
    name: "aws",
    scope: "egress",
    egress: {
      re: /\bAKIA[0-9A-Z]{16}\b/g,
      sub: "[REDACTED:aws]",
      order: 6,
    },
  },
  {
    name: "google",
    scope: "both",
    log: {
      re: /\bAIza[0-9A-Za-z_-]{20,}\b/g,
      sub: "[REDACTED_GOOGLE_KEY]",
      order: 3,
    },
    egress: {
      re: /\bAIza[0-9A-Za-z_-]{35}\b/g,
      sub: "[REDACTED:google]",
      order: 7,
    },
  },
  {
    name: "slack",
    scope: "egress",
    egress: {
      re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
      sub: "[REDACTED:slack]",
      order: 8,
    },
  },
  {
    name: "bearer",
    scope: "both",
    log: {
      re: /\bBearer\s+[A-Za-z0-9._-]{10,}\b/gi,
      sub: "Bearer [REDACTED]",
      order: 1,
    },
    egress: {
      re: /\bBearer\s+[A-Za-z0-9._~+-]{8,}/g,
      sub: "Bearer [REDACTED:bearer]",
      order: 9,
    },
  },
  {
    // Discord bot token: <20+>.<6>.<25+> base64-ish parts.
    name: "discord",
    scope: "log",
    log: {
      re: /\b[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{25,}\b/g,
      sub: "[REDACTED_DISCORD_TOKEN]",
      order: 5,
    },
  },
  {
    // postgresql://user:pass@host, redis://:pass@host, etc.
    name: "dsn",
    scope: "egress",
    egress: {
      re: /\b(postgres(?:ql)?|mysql|rediss?|mongodb(?:\+srv)?|amqps?):\/\/(?:(?:[^@\s/:]+)?:)?[^@\s/:]+@/gi,
      sub: (_m, scheme) => `${scheme.toLowerCase()}://[REDACTED:dsn]@`,
      order: 10,
    },
  },
  {
    // The unquoted value class must not match an already-redacted marker
    // fragment: toolActionText censors BEFORE it clips, so the egress
    // censor re-sees `sshpass -p [REDACTED:s…` — the fit can leave as few
    // as ONE marker char (`sshpass -p […]`). Any value starting `[` here
    // is a marker fragment, never a raw secret; re-expanding it ships a
    // 38-col line (PR #64 review P2).
    name: "sshpass",
    scope: "egress",
    egress: {
      re: /\bsshpass\s+-p\s+(?!\[)\S+/g,
      sub: "sshpass -p [REDACTED:sshpass]",
      order: 11,
    },
  },
  {
    // ?token= / &api_key= — query-string secrets.
    name: "kv-query",
    scope: "log",
    log: {
      re: /([?&](?:token|api[_-]?key|key|secret|password|authorization)=)[^&\s]+/gi,
      sub: "$1[REDACTED]",
      order: 6,
    },
  },
  {
    // token: "v" / secret: "v" — quoted values. Runs before kv-bare so
    // the quoted form keeps its quotes stripped in one pass.
    name: "kv-quoted",
    scope: "log",
    log: {
      re: /(\b(?:token|api[_-]?key|secret|password|authorization)\b\s*[:=]\s*")([^"]+)(")/gi,
      sub: "$1[REDACTED]$3",
      order: 7,
    },
  },
  {
    // token=v / secret: v — bare values. The value class stops at
    // whitespace, comma, semicolon (so `&x=1` in a query string is
    // swallowed with the value: a redacted run plus its tail).
    name: "kv-bare",
    scope: "log",
    log: {
      re: /(\b(?:token|api[_-]?key|secret|password|authorization)\b\s*[:=]\s*)([^\s,;]+)/gi,
      sub: "$1[REDACTED]",
      order: 8,
    },
  },
  {
    // key = value (any context) — the strongest leak signal. Same
    // self-exclusion as sshpass: the unquoted value class skips marker
    // fragments (`token=[…` after a 23-col fit) so the egress pass is a
    // no-op on already-clipped frames (PR #64 review P2).
    name: "kv",
    scope: "egress",
    egress: {
      re: /(?<![\w-])\b(password|passwd|secret|token|api[_-]?key)\b\s*=\s*("[^"]*"|'[^']*'|(?!\[)\S+)/gi,
      sub: (_m, key) => `${key.toLowerCase()}=[REDACTED:kv]`,
      order: 12,
    },
  },
  {
    // key: value — only when the value is quoted (>=4) or an unquoted
    // token-like run of >=8 chars, so prose like "the password: forgot
    // it" (6 letters) is left alone while real tokens are caught.
    name: "kv",
    scope: "egress",
    egress: {
      re: /(?<![\w-])\b(password|passwd|secret|token)\b\s*:\s*("[^"]{4,}"|'[^']{4,}'|[^\s,:;'"[\]]{8,})/gi,
      sub: (_m, key) => `${key.toLowerCase()}: [REDACTED:kv]`,
      order: 13,
    },
  },
  {
    // /Users/<name>/… and /home/<name>/… — log-engine path redaction,
    // opt-in via redactPaths (paths are not secrets, but they leak
    // usernames + layout).
    name: "path-unix",
    scope: "log",
    paths: true,
    log: {
      re: /\/(?:Users|home)\/[^/\s]+\/[^\s'"`)]*/g,
      sub: "[REDACTED_PATH]",
      order: 9,
    },
  },
  {
    name: "path-win",
    scope: "log",
    paths: true,
    log: {
      re: /[A-Za-z]:\\[^\s'"`)]*/g,
      sub: "[REDACTED_PATH]",
      order: 10,
    },
  },
];

/**
 * Apply one rule to a line. String.prototype.replace has no union
 * overload (string replacement vs function replacement are separate
 * overloads), so both engines route through here; the narrowing is the
 * only difference from an inline replace.
 */
export function applyRule(
  text: string,
  re: RegExp,
  sub: SecretReplacement,
): string {
  return typeof sub === "string" ? text.replace(re, sub) : text.replace(re, sub);
}

export interface LogSecretRule {
  re: RegExp;
  sub: SecretReplacement;
  /** true = applied only when sanitize's redactPaths option is set. */
  paths: boolean;
}

/** Log-engine rules, in application order (sorted by side order).
 *  Consumed by sanitize.ts. */
export const LOG_SECRET_RULES: LogSecretRule[] = SECRET_PATTERNS.flatMap(
  (p) => {
    if ((p.scope === "both" || p.scope === "log") && p.log) {
      return [
        {
          re: p.log.re,
          sub: p.log.sub,
          paths: p.paths === true,
          order: p.log.order,
        },
      ];
    }
    return [];
  },
)
  .sort((a, b) => a.order - b.order)
  .map(({ re, sub, paths }) => ({ re, sub, paths }));

export interface EgressSecretRule {
  /** WARN class tag. */
  cls: string;
  re: RegExp;
  sub: SecretReplacement;
}

/** Egress-engine rules, in application order (sorted by side order,
 *  kv last). Consumed by censor.ts. */
export const EGRESS_SECRET_RULES: EgressSecretRule[] = SECRET_PATTERNS.flatMap(
  (p) => {
    if ((p.scope === "both" || p.scope === "egress") && p.egress) {
      return [
        {
          cls: p.name,
          re: p.egress.re,
          sub: p.egress.sub,
          order: p.egress.order,
        },
      ];
    }
    return [];
  },
)
  .sort((a, b) => a.order - b.order)
  .map(({ cls, re, sub }) => ({ cls, re, sub }));
