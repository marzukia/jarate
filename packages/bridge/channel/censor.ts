/**
 * Secret egress censor — redacts secrets from every string the bridge
 * posts to Discord. See docs/secret-censor.md for the design.
 *
 * Two passes, in order:
 *   (a) REGISTRY: exact literals from ~/.pi/agent/secrets.txt
 *       ($JARATE_SECRETS_FILE overrides), longest first.
 *       → [REDACTED:secret#N]
 *   (b) PATTERN: built-in classes (GitHub/Switchboard/GitLab/Anthropic/
 *       OpenAI/AWS/Google/Slack/Bearer/DSN/sshpass/key-value).
 *       → [REDACTED:<class>]
 *
 * Guarantees:
 *   - the raw value never appears in the output
 *   - idempotent: censor(censor(x)) === censor(x)
 *   - a missing registry file is NOT an error (patterns only)
 *   - every fired match logs a WARN with a fingerprint (registry:
 *     first-4+last-4; patterns: class name), once per fingerprint per
 *     process — debuggable without re-leaking
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// ─── Registry ────────────────────────────────────────────────────────────

export interface RegistryEntry {
  /** 1-based index of the entry in the file (stable tag number). */
  index: number;
  literal: string;
}

export function defaultRegistryPath(): string {
  return (
    process.env.JARATE_SECRETS_FILE ||
    path.join(os.homedir(), ".pi", "agent", "secrets.txt")
  );
}

let cachedMtime: number | null = null;
let cachedEntries: RegistryEntry[] = [];

/**
 * Load the per-agent secret registry. One exact literal per line; `#`
 * comments and blank lines are skipped. Sorted longest-first so a short
 * secret that is a substring of a longer one cannot eat the longer match.
 * Missing/unreadable file = empty registry (patterns only), never throws.
 * Re-reads automatically when the file's mtime changes (no restart needed
 * to add a secret).
 */
export function loadRegistry(file?: string): RegistryEntry[] {
  const p = file || defaultRegistryPath();
  let mtimeMs: number | null = null;
  let raw: string | null = null;
  try {
    mtimeMs = fs.statSync(p).mtimeMs;
    raw = fs.readFileSync(p, "utf-8");
  } catch {
    cachedMtime = mtimeMs; // null mtime = no file; re-stat on next call
    cachedEntries = [];
    return cachedEntries;
  }
  if (file === undefined && mtimeMs === cachedMtime) return cachedEntries;
  const entries: RegistryEntry[] = [];
  for (const line of raw.split("\n")) {
    // trim: a trailing space would keep the literal wider than the egress
    // text (no match), and a whitespace-only line would redact prose spacing
    const literal = line.replace(/\r$/, "").trim();
    if (!literal || literal.startsWith("#")) continue;
    entries.push({ index: entries.length + 1, literal });
  }
  entries.sort((a, b) => b.literal.length - a.literal.length);
  if (file === undefined) {
    cachedMtime = mtimeMs;
    cachedEntries = entries;
  }
  return entries;
}

/** Drop the registry cache. Exported for tests. */
export function clearRegistryCache(): void {
  cachedMtime = null;
  cachedEntries = [];
}

function fingerprint(literal: string): string {
  if (literal.length <= 8) return `${literal.length}ch`;
  return `${literal.slice(0, 4)}…${literal.slice(-4)}`;
}

// ─── Pattern classes ─────────────────────────────────────────────────────

interface PatternRule {
  cls: string;
  re: RegExp;
  /** Fixed replacement (no raw value, so censor is idempotent). */
  sub: (match: string, ...groups: string[]) => string;
}

/**
 * Built-in pattern classes, applied in this fixed order. The kv rule is
 * last: it is the loosest and must not shadow the specific token classes.
 */
const RULES: PatternRule[] = [
  {
    // Classic PAT: ghp_/gho_/ghu_/ghs_/ghr_ + exactly 36 alnum.
    // Fine-grained: github_pat_ + 22..255 word chars. Short/partial runs
    // are not token-shaped and must not trigger (issue #54).
    cls: "github",
    re: /\b(?:gh[pousr]_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{22,255})\b/g,
    sub: () => "[REDACTED:github]",
  },
  {
    // Switchboard house key: sbk_<name>_<16 hex> (docs/NEW-AGENT.md).
    // The run-frame path censors BEFORE it clips (toolActionText), so the
    // key is whole and unescaped there. The final-send censor still sees
    // the escaped + clipped form (sbk\_jimmy\_…, cut at the 28-col text
    // budget), so the pattern must accept the escaped form too. The
    // classic/fine-grained GitHub shapes are longer than any tool-line
    // clip and reach the final censor unescaped (or clipped mid-run, where
    // the trailing \b lands on the ellipsis).
    cls: "switchboard",
    re: /\bsbk\\?_[A-Za-z0-9\\_]{8,}\b/g,
    sub: () => "[REDACTED:switchboard]",
  },
  {
    cls: "gitlab",
    re: /\bglpat-[A-Za-z0-9_-]{8,}\b/g,
    sub: () => "[REDACTED:gitlab]",
  },
  {
    cls: "anthropic",
    re: /\bsk-ant-[A-Za-z0-9_-]{8,}\b/g,
    sub: () => "[REDACTED:anthropic]",
  },
  {
    cls: "openai",
    re: /\bsk-(?:or-[A-Za-z0-9_-]{8,}|[A-Za-z0-9]{20,})\b/g,
    sub: () => "[REDACTED:openai]",
  },
  {
    cls: "aws",
    re: /\bAKIA[0-9A-Z]{16}\b/g,
    sub: () => "[REDACTED:aws]",
  },
  {
    cls: "google",
    re: /\bAIza[0-9A-Za-z_-]{35}\b/g,
    sub: () => "[REDACTED:google]",
  },
  {
    cls: "slack",
    re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
    sub: () => "[REDACTED:slack]",
  },
  {
    cls: "bearer",
    re: /\bBearer\s+[A-Za-z0-9._~+-]{8,}/g,
    sub: () => "Bearer [REDACTED:bearer]",
  },
  {
    // postgresql://user:pass@host, redis://:pass@host, etc.
    cls: "dsn",
    re: /\b(postgres(?:ql)?|mysql|rediss?|mongodb(?:\+srv)?|amqps?):\/\/(?:(?:[^@\s/:]+)?:)?[^@\s/:]+@/gi,
    sub: (_m, scheme) => `${scheme.toLowerCase()}://[REDACTED:dsn]@`,
  },
  {
    // The unquoted value class must not match an already-redacted marker
    // fragment: toolActionText censors BEFORE it clips, so the egress
    // censor re-sees `sshpass -p [REDACTED:s…` — the fit can leave as few
    // as ONE marker char (`sshpass -p […]`, the kv line's fragment is even
    // shorter). Any value starting `[` here is a marker fragment, never a
    // raw secret; re-expanding it ships a 38-col line (PR #64 review P2).
    cls: "sshpass",
    re: /\bsshpass\s+-p\s+(?!\[)\S+/g,
    sub: () => "sshpass -p [REDACTED:sshpass]",
  },
  {
    // key = value (any context) — the strongest leak signal. Same
    // self-exclusion as sshpass: the unquoted value class skips marker
    // fragments (`token=[…` after a 23-col fit) so the egress pass is a
    // no-op on already-clipped frames (PR #64 review P2).
    cls: "kv",
    re: /(?<![\w-])\b(password|passwd|secret|token|api[_-]?key)\b\s*=\s*("[^"]*"|'[^']*'|(?!\[)\S+)/gi,
    sub: (_m, key) => `${key.toLowerCase()}=[REDACTED:kv]`,
  },
  {
    // key: value — only when the value is quoted (>=4) or an unquoted
    // token-like run of >=8 chars, so prose like "the password: forgot it"
    // (6 letters) is left alone while real tokens are caught.
    cls: "kv",
    re: /(?<![\w-])\b(password|passwd|secret|token)\b\s*:\s*("[^"]{4,}"|'[^']{4,}'|[^\s,:;'"[\]]{8,})/gi,
    sub: (_m, key) => `${key.toLowerCase()}: [REDACTED:kv]`,
  },
];

// ─── Censor ──────────────────────────────────────────────────────────────

/** Fingerprints already WARNed about this process (dedupe; tick edits
 *  re-censor the same line every 30s and must not spam). */
const warned = new Set<string>();

/** Reset the WARN dedupe set. Exported for tests. */
export function clearCensorWarns(): void {
  warned.clear();
}

function warn(
  log: (line: string) => void,
  kind: string,
  fp: string,
  n: number,
): void {
  const key = `${kind}:${fp}`;
  if (warned.has(key)) return;
  warned.add(key);
  log(`[censor] ${kind} fp=${fp} (replaced ${n}x)`);
}

export interface CensorOptions {
  /** Registry file (default: ~/.pi/agent/secrets.txt or $JARATE_SECRETS_FILE). */
  file?: string;
  /** WARN sink (default: console.warn). Inject a spy in tests. */
  log?: (line: string) => void;
}

/**
 * Redact secrets from one outbound string. Pure w.r.t. its input; the
 * only side effect is a once-per-fingerprint WARN. Returns the input
 * unchanged when nothing matches. Never throws.
 */
export function censor(text: string, opts: CensorOptions = {}): string {
  if (!text) return text;
  const log = opts.log || console.warn;

  let out = text;

  // (a) registry: exact literals, longest first
  for (const entry of loadRegistry(opts.file)) {
    const before = out.length;
    out = out.split(entry.literal).join(`[REDACTED:secret#${entry.index}]`);
    if (out.length !== before) {
      warn(
        log,
        `registry secret#${entry.index}`,
        fingerprint(entry.literal),
        out.split(`[REDACTED:secret#${entry.index}]`).length - 1,
      );
    }
  }

  // (b) pattern classes, fixed order
  for (const rule of RULES) {
    const matches = [...out.matchAll(rule.re)];
    if (matches.length === 0) continue;
    out = out.replace(rule.re, rule.sub);
    warn(log, `class=${rule.cls}`, rule.cls, matches.length);
  }

  return out;
}
