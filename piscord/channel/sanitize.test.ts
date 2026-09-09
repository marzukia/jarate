import { test, expect, describe } from "bun:test";
import { sanitizeSensitiveText, sanitizeUnknownValue } from "./sanitize";

describe("sanitizeSensitiveText", () => {
  test("empty input", () => {
    expect(sanitizeSensitiveText("")).toBe("");
  });

  test("redacts Bearer tokens (and the surrounding key)", () => {
    // The Authorization key/value rule also fires, so both spots are redacted
    expect(sanitizeSensitiveText("Authorization: Bearer abc123def456"))
      .toBe("Authorization: [REDACTED] [REDACTED]");
    expect(sanitizeSensitiveText("Bearer abc123def456 on its own"))
      .toBe("Bearer [REDACTED] on its own");
  });

  test("redacts OpenAI-style sk- keys", () => {
    expect(sanitizeSensitiveText("key: sk-abcdefghijklmnop1234"))
      .toBe("key: [REDACTED_OPENAI_KEY]");
  });

  test("redacts Discord bot tokens", () => {
    const token = "MTA5MTk5NTIxMTM4OTk3NzUxMg.MnOpQr.STU-VWXyzaBCdefGHIjklMNOpQrSTU";
    expect(sanitizeSensitiveText(`bot=${token}`)).toBe("bot=[REDACTED_DISCORD_TOKEN]");
  });

  test("redacts secrets in query strings", () => {
    expect(sanitizeSensitiveText("https://x.test/cb?token=abcdef123456&x=1"))
      .toBe("https://x.test/cb?token=[REDACTED]");
  });

  test("redacts quoted key secrets", () => {
    expect(sanitizeSensitiveText('api_key: "supersecretvalue"'))
      .toBe("api_key: [REDACTED]");
  });

  test("redacts bare key=value for sensitive key names only", () => {
    expect(sanitizeSensitiveText("secret=abcd1234efgh5678"))
      .toBe("secret=[REDACTED]");
    expect(sanitizeSensitiveText("session=abcd1234efgh5678"))
      .toBe("session=abcd1234efgh5678");
  });

  test("redacts unix paths when redactPaths is set", () => {
    const out = sanitizeSensitiveText("path is /home/u/.config/opencode", {
      redactPaths: true,
    });
    expect(out).toBe("path is [REDACTED_PATH]");
    // without the flag, paths stay
    expect(sanitizeSensitiveText("path is /home/u/.config/opencode"))
      .toBe("path is /home/u/.config/opencode");
  });

  test("ordinary text unchanged", () => {
    expect(sanitizeSensitiveText("hello world, all good")).toBe("hello world, all good");
  });
});

describe("sanitizeUnknownValue", () => {
  test("strings pass through", () => {
    expect(sanitizeUnknownValue("plain")).toBe("plain");
  });

  test("numbers, booleans, null, undefined pass through", () => {
    expect(sanitizeUnknownValue(42)).toBe(42);
    expect(sanitizeUnknownValue(true)).toBe(true);
    expect(sanitizeUnknownValue(null)).toBeNull();
    expect(sanitizeUnknownValue(undefined)).toBeUndefined();
  });

  test("Date becomes ISO string", () => {
    expect(sanitizeUnknownValue(new Date("2026-01-02T03:04:05Z")))
      .toBe("2026-01-02T03:04:05.000Z");
  });

  test("Error becomes plain object, cause recursed", () => {
    const err = new Error("outer", { cause: new Error("root cause") });
    const out = sanitizeUnknownValue(err);
    expect(out).toMatchObject({
      name: "Error",
      message: "outer",
      cause: { name: "Error", message: "root cause" },
    });
  });

  test("Error messages are sanitized", () => {
    const err = new Error("Bearer abc123def456 failed");
    const out = sanitizeUnknownValue(err) as { message: string };
    expect(out.message).toBe("Bearer [REDACTED] failed");
  });

  test("circular reference does not hang", () => {
    const obj: Record<string, unknown> = { a: 1 };
    obj.self = obj;
    expect(sanitizeUnknownValue(obj)).toEqual({
      a: 1,
      self: "[REDACTED_CIRCULAR]",
    });
  });

  test("nested object and array", () => {
    expect(sanitizeUnknownValue({ a: [1, "two"], b: { c: 3 } }))
      .toEqual({ a: [1, "two"], b: { c: 3 } });
  });

  test("strings inside objects are sanitized", () => {
    expect(sanitizeUnknownValue({ url: "sk-abcdefghijklmnop1234" }))
      .toEqual({ url: "[REDACTED_OPENAI_KEY]" });
  });
});
