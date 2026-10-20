/**
 * Sensitive data redaction for logs.
 *
 * Ported from kimaki's privacy-sanitizer. Redacts common secrets
 * (bearer tokens, provider API keys, query-string secrets) plus Discord bot
 * tokens, so poll/send errors never leak credentials into the TUI log.
 *
 * The secret patterns come from the SHARED table (secret-patterns.ts,
 * scope "log") — the same table the egress censor (censor.ts) consumes —
 * so the two engines cannot silently diverge. The log-vs-egress split
 * (per-pattern scope + length specifiers) is documented in
 * docs/secret-censor.md. Path redaction (redactPaths) is not a secret
 * pattern; it stays local to this module.
 */

import { applyEntry, patternsForScope } from "./secret-patterns";

const LOG_PATTERNS = patternsForScope("log");

const PATH_PATTERNS: Array<{ re: RegExp; sub: string }> = [
  {
    re: /\/(?:Users|home)\/[^/\s]+\/[^\s'"`)]*/g,
    sub: "[REDACTED_PATH]",
  },
  {
    re: /[A-Za-z]:\\[^\s'"`)]*/g,
    sub: "[REDACTED_PATH]",
  },
];

/** Redact sensitive values from a log line. */
export function sanitizeSensitiveText(
  value: string,
  { redactPaths = false }: { redactPaths?: boolean } = {},
): string {
  const replacements = redactPaths
    ? [...LOG_PATTERNS, ...PATH_PATTERNS]
    : LOG_PATTERNS;
  return replacements.reduce(
    (current, entry) => applyEntry(current, entry),
    value,
  );
}

/** Recursively redact a value of unknown shape (errors, objects, arrays). */
export function sanitizeUnknownValue(
  value: unknown,
  {
    depth = 0,
    seen = new WeakSet<object>(),
    redactPaths = false,
  }: {
    depth?: number;
    seen?: WeakSet<object>;
    redactPaths?: boolean;
  } = {},
): unknown {
  if (depth > 8) {
    return "[REDACTED_DEPTH_LIMIT]";
  }

  if (typeof value === "string") {
    return sanitizeSensitiveText(value, { redactPaths });
  }

  if (
    typeof value === "number" ||
    typeof value === "boolean" ||
    value === null ||
    value === undefined
  ) {
    return value;
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (value instanceof Error) {
    const sanitizedStack = value.stack
      ? sanitizeSensitiveText(value.stack, { redactPaths })
      : undefined;
    return {
      name: value.name,
      message: sanitizeSensitiveText(value.message, { redactPaths }),
      stack: sanitizedStack,
      cause: sanitizeUnknownValue(value.cause, {
        depth: depth + 1,
        seen,
        redactPaths,
      }),
    };
  }

  if (Array.isArray(value)) {
    return value.map((item) => {
      return sanitizeUnknownValue(item, {
        depth: depth + 1,
        seen,
        redactPaths,
      });
    });
  }

  if (typeof value === "object") {
    if (seen.has(value)) {
      return "[REDACTED_CIRCULAR]";
    }
    seen.add(value);

    const sanitizedEntries = Object.entries(value).map(([key, entryValue]) => {
      return [
        key,
        sanitizeUnknownValue(entryValue, {
          depth: depth + 1,
          seen,
          redactPaths,
        }),
      ];
    });
    return Object.fromEntries(sanitizedEntries);
  }

  return sanitizeSensitiveText(String(value), { redactPaths });
}
