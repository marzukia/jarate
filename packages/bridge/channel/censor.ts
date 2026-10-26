/**
 * Secret egress censor — redacts secrets from every string the bridge
 * posts to Discord. See docs/secret-censor.md for the design.
 *
 * Two passes, in order:
 *   (a) REGISTRY: exact literals from ~/.pi/agent/secrets.txt
 *       ($JARATE_SECRETS_FILE overrides), longest first.
 *       → [REDACTED:secret#N]
 *   (b) PATTERN: the shared secret table (./secret-patterns.ts, egress
 *       scope) — GitHub/Switchboard/GitLab/Anthropic/OpenAI/AWS/Google/
 *       Slack/Bearer/DSN/sshpass/key-value.
 *       → [REDACTED:<class>]
 *
 * The log engine (./sanitize.ts) consumes the log scope of the SAME
 * table; the log-vs-egress split is explicit there and in
 * docs/secret-censor.md (issue #254).
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
import {
  applyRule,
  EGRESS_SECRET_RULES,
  type EgressSecretRule,
} from "./secret-patterns";

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

/**
 * Built-in pattern classes, applied in this fixed order. The rules are
 * the egress scope of the shared secret table (./secret-patterns.ts) —
 * the log engine consumes the log scope of the same table, so the two
 * cannot silently diverge (issue #254). The kv rules are last: they are
 * the loosest and must not shadow the specific token classes.
 */
const RULES: EgressSecretRule[] = EGRESS_SECRET_RULES;

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

  // (a) registry literals, longest first.
  const reg = loadRegistry(opts.file);
  const combined: RegistryEntry[] = [...reg];
  combined.sort((a, b) => b.literal.length - a.literal.length);
  for (const entry of combined) {
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
    out = applyRule(out, rule.re, rule.sub);
    warn(log, `class=${rule.cls}`, rule.cls, matches.length);
  }

  return out;
}
