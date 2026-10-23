/**
 * Shared secret-pattern table — the single source of truth for both
 * redaction engines (issue #254):
 *
 *   scope "log"    → channel/sanitize.ts (log redaction: TUI/error logs)
 *   scope "egress" → channel/censor.ts (Discord egress)
 *
 * Before this table the two engines kept private copies of the same
 * leak surface and had silently diverged (ghp_ {36} vs {20,}; AKIA /
 * glpat- / xox / sbk_ / github_pat_ / DSN absent from logs). Now each
 * entry names exactly ONE engine (`scope`), its application `order`
 * (1-based, unique per scope), the exact pattern (source + flags — the
 * length specifiers live here and only here), and the replacement.
 * A pattern that must apply to both engines appears as two entries
 * (one per scope), each with its own spec.
 *
 * The log-vs-egress split is documented in docs/secret-censor.md.
 * secret-patterns.test.ts pins every entry (id, scope, order, source,
 * flags, sub) and the preserved divergences, so neither engine can
 * silently drift.
 *
 * Ordering is load-bearing: each engine applies its scope's entries in
 * ascending `order`. Do not renumber without re-running both engines'
 * test suites (rules that re-match already-redacted output depend on
 * the sequence, e.g. log kv-bare after kv-query/kv-quoted).
 *
 * Replacements must not echo the raw value (fixed strings only — that
 * is what keeps the egress censor idempotent). String subs may use
 * $1..$n group references; function subs receive (match, ...groups).
 */

export type SecretScope = "log" | "egress";

export type SecretPatternSub =
  | string
  | ((match: string, ...groups: string[]) => string);

export interface SecretPatternEntry {
  /** Stable family name (e.g. "github"); unique per scope, not global. */
  id: string;
  /** The one engine that consumes this entry. */
  scope: SecretScope;
  /** 1-based application order within the engine (unique per scope). */
  order: number;
  /** Exact pattern, compiled once here and pinned by the table test. */
  re: RegExp;
  /** Replacement: fixed string ($n groups allowed) or group function. */
  sub: SecretPatternSub;
  /**
   * Egress only: class name for the WARN line (`class=<cls>`). Both kv
   * entries share cls "kv" (one class, two shapes) so the WARN dedupe
   * key stays what it is today.
   */
  cls?: string;
}

// ─── Table ─────────────────────────────────────────────────────────────

export const SECRET_PATTERNS: readonly SecretPatternEntry[] = [
  // ── scope "egress" — censors every string posted to Discord ──
  // Order = censor's historical RULES sequence (1..13). The kv rules are
  // last: they are the loosest and must not shadow the token classes.

  {
    // Classic PAT: ghp_/gho_/ghu_/ghs_/ghr_ + exactly 36 alnum.
    // Fine-grained: github_pat_ + 22..255 word chars. Short/partial runs
    // are not token-shaped and must not trigger (issue #54).
    id: "github",
    scope: "egress",
    order: 1,
    re: /\b(?:gh[pousr]_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{22,255})\b/g,
    sub: "[REDACTED:github]",
    cls: "github",
  },
  {
    // Switchboard house key: sbk_<name>_<16 hex> (docs/NEW-AGENT.md).
    // The run-frame path censors BEFORE it clips (toolActionText), so the
    // key is whole and unescaped there. The final-send censor still sees
    // the escaped + clipped form (sbk\_agent\_…), so the pattern must
    // accept the escaped form too.
    id: "switchboard",
    scope: "egress",
    order: 2,
    re: /\bsbk\\?_[A-Za-z0-9\\_]{8,}\b/g,
    sub: "[REDACTED:switchboard]",
    cls: "switchboard",
  },
  {
    id: "gitlab",
    scope: "egress",
    order: 3,
    re: /\bglpat-[A-Za-z0-9_-]{8,}\b/g,
    sub: "[REDACTED:gitlab]",
    cls: "gitlab",
  },
  {
    id: "anthropic",
    scope: "egress",
    order: 4,
    re: /\bsk-ant-[A-Za-z0-9_-]{8,}\b/g,
    sub: "[REDACTED:anthropic]",
    cls: "anthropic",
  },
  {
    id: "openai",
    scope: "egress",
    order: 5,
    re: /\bsk-(?:or-[A-Za-z0-9_-]{8,}|[A-Za-z0-9]{20,})\b/g,
    sub: "[REDACTED:openai]",
    cls: "openai",
  },
  {
    id: "aws",
    scope: "egress",
    order: 6,
    re: /\bAKIA[0-9A-Z]{16}\b/g,
    sub: "[REDACTED:aws]",
    cls: "aws",
  },
  {
    id: "google",
    scope: "egress",
    order: 7,
    re: /\bAIza[0-9A-Za-z_-]{35}\b/g,
    sub: "[REDACTED:google]",
    cls: "google",
  },
  {
    id: "slack",
    scope: "egress",
    order: 8,
    re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
    sub: "[REDACTED:slack]",
    cls: "slack",
  },
  {
    id: "bearer",
    scope: "egress",
    order: 9,
    re: /\bBearer\s+[A-Za-z0-9._~+-]{8,}/g,
    sub: "Bearer [REDACTED:bearer]",
    cls: "bearer",
  },
  {
    // postgresql://user:pass@host, redis://:pass@host, etc.
    id: "dsn",
    scope: "egress",
    order: 10,
    re: /\b(postgres(?:ql)?|mysql|rediss?|mongodb(?:\+srv)?|amqps?):\/\/(?:(?:[^@\s/:]+)?:)?[^@\s/:]+@/gi,
    sub: (_m, scheme) => `${scheme.toLowerCase()}://[REDACTED:dsn]@`,
    cls: "dsn",
  },
  {
    // The unquoted value class must not match an already-redacted marker
    // fragment: toolActionText censors BEFORE it clips, so the egress
    // censor re-sees `sshpass -p [REDACTED:s…` — the fit can leave as few
    // as ONE marker char (`sshpass -p […]`, the kv line's fragment is even
    // shorter). Any value starting `[` here is a marker fragment, never a
    // raw secret; re-expanding it ships a 38-col line (PR #64 review P2).
    id: "sshpass",
    scope: "egress",
    order: 11,
    re: /\bsshpass\s+-p\s+(?!\[)\S+/g,
    sub: "sshpass -p [REDACTED:sshpass]",
    cls: "sshpass",
  },
  {
    // key = value (any context) — the strongest leak signal. Same
    // self-exclusion as sshpass: the unquoted value class skips marker
    // fragments (`token=[…` after a 23-col fit) so the egress pass is a
    // no-op on already-clipped frames (PR #64 review P2).
    id: "kv-eq",
    scope: "egress",
    order: 12,
    re: /(?<![\w-])\b(password|passwd|secret|token|api[_-]?key)\b\s*=\s*("[^"]*"|'[^']*'|(?!\[)\S+)/gi,
    sub: (_m, key) => `${key.toLowerCase()}=[REDACTED:kv]`,
    cls: "kv",
  },
  {
    // key: value — only when the value is quoted (>=4) or an unquoted
    // token-like run of >=8 chars, so prose like "the password: forgot it"
    // (6 letters) is left alone while real tokens are caught.
    id: "kv-colon",
    scope: "egress",
    order: 13,
    re: /(?<![\w-])\b(password|passwd|secret|token)\b\s*:\s*("[^"]{4,}"|'[^']{4,}'|[^\s,:;'"[\]]{8,})/gi,
    sub: (_m, key) => `${key.toLowerCase()}: [REDACTED:kv]`,
    cls: "kv",
  },

  // ── scope "log" — redacts log lines (sanitize.ts) ──
  // Order = sanitize's historical CORE_SENSITIVE_REPLACEMENTS sequence
  // (1..8). Load-bearing interactions: bearer (1) must run before the
  // kv rules (it re-redacts the "Authorization: Bearer …" pair), and
  // kv-query (6) / kv-quoted (7) must run before kv-bare (8), whose
  // unquoted value class then eats the marker's tail (`?token=[REDACTED]
  // &x=1` → `?token=[REDACTED]`).

  {
    id: "bearer",
    scope: "log",
    order: 1,
    re: /\bBearer\s+[A-Za-z0-9._-]{10,}\b/gi,
    sub: "Bearer [REDACTED]",
  },
  {
    id: "openai",
    scope: "log",
    order: 2,
    re: /\bsk-[A-Za-z0-9]{16,}\b/g,
    sub: "[REDACTED_OPENAI_KEY]",
  },
  {
    id: "google",
    scope: "log",
    order: 3,
    re: /\bAIza[0-9A-Za-z_-]{20,}\b/g,
    sub: "[REDACTED_GOOGLE_KEY]",
  },
  {
    id: "github",
    scope: "log",
    order: 4,
    re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
    sub: "[REDACTED_GITHUB_TOKEN]",
  },
  {
    id: "discord",
    scope: "log",
    order: 5,
    re: /\b[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{25,}\b/g,
    sub: "[REDACTED_DISCORD_TOKEN]",
  },
  {
    id: "kv-query",
    scope: "log",
    order: 6,
    re: /([?&](?:token|api[_-]?key|key|secret|password|authorization)=)[^&\s]+/gi,
    sub: "$1[REDACTED]",
  },
  {
    id: "kv-quoted",
    scope: "log",
    order: 7,
    re: /(\b(?:token|api[_-]?key|secret|password|authorization)\b\s*[:=]\s*")([^"]+)(")/gi,
    sub: "$1[REDACTED]$3",
  },
  {
    id: "kv-bare",
    scope: "log",
    order: 8,
    re: /(\b(?:token|api[_-]?key|secret|password|authorization)\b\s*[:=]\s*)([^\s,;]+)/gi,
    sub: "$1[REDACTED]",
  },
];

// ─── Access ────────────────────────────────────────────────────────────

/**
 * Apply one table entry to a string. Single choke point for both
 * engines: string subs go through `replace`'s group-replacement
 * semantics ($1..$n), function subs receive (match, ...groups).
 */
export function applyEntry(
  text: string,
  entry: Pick<SecretPatternEntry, "re" | "sub">,
): string {
  return typeof entry.sub === "string"
    ? text.replace(entry.re, entry.sub)
    : text.replace(entry.re, entry.sub);
}

/**
 * The entries one engine consumes, in application order (ascending
 * `order`). Returns a fresh array; the entry objects are shared.
 */
export function patternsForScope(
  scope: SecretScope,
): readonly SecretPatternEntry[] {
  return SECRET_PATTERNS.filter((e) => e.scope === scope).sort(
    (a, b) => a.order - b.order,
  );
}

// Import-time invariant: a duplicate (id, scope) or (scope, order) means
// the table was hand-edited wrong — fail loud, not silently divergent.
function assertTableIntegrity(): void {
  const seenId = new Set<string>();
  const seenOrder = new Map<SecretScope, Set<number>>();
  for (const e of SECRET_PATTERNS) {
    const idKey = `${e.id}@${e.scope}`;
    if (seenId.has(idKey)) {
      throw new Error(`secret-patterns: duplicate entry ${idKey}`);
    }
    seenId.add(idKey);
    const orders = seenOrder.get(e.scope) ?? new Set<number>();
    if (orders.has(e.order)) {
      throw new Error(`secret-patterns: duplicate ${e.scope} order ${e.order}`);
    }
    orders.add(e.order);
    seenOrder.set(e.scope, orders);
  }
}
assertTableIntegrity();
