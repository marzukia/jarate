/**
 * Sensitive data redaction for logs.
 *
 * Patterns come from the shared secret table (./secret-patterns.ts, log
 * scope) — the same table the egress censor (./censor.ts) consumes, so
 * the two engines cannot silently diverge (issue #254). Redacts common
 * secrets (bearer tokens, provider API keys, GitHub and Discord tokens,
 * query-string secrets) so poll/send errors never leak credentials into
 * the TUI log. See docs/secret-censor.md for the design and the
 * log-vs-egress split.
 */

import { applyRule, LOG_SECRET_RULES } from "./secret-patterns";

/** Redact sensitive values from a log line. */
export function sanitizeSensitiveText(
  value: string,
  { redactPaths = false }: { redactPaths?: boolean } = {},
): string {
  const rules = redactPaths
    ? LOG_SECRET_RULES
    : LOG_SECRET_RULES.filter((r) => !r.paths);
  return rules.reduce((current, { re, sub }) => {
    return applyRule(current, re, sub);
  }, value);
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
