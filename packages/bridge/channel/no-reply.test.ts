import { describe, expect, test } from "bun:test";
import { isNoReply } from "./index";
import { stripNoReply } from "./no-reply";

describe("stripNoReply (lenient NO_REPLY, op order 2026-10-31)", () => {
  test("exact token -> silence (empty remainder)", () => {
    expect(stripNoReply("NO_REPLY")).toBe("");
    expect(stripNoReply("  no_reply  ")).toBe("");
  });

  test("leading summary line: token line removed, summary posted", () => {
    // The 2026-10-31 symptom: "Healthy: \nNO_REPLY" used to post in full.
    expect(stripNoReply("Healthy: \nNO_REPLY")).toBe("Healthy:");
  });

  test("trailing text: token line removed, remainder posted", () => {
    expect(stripNoReply("NO_REPLY\nextra line")).toBe("extra line");
  });

  test("token + whitespace only -> silence", () => {
    expect(stripNoReply("NO_REPLY\n\n   \nno_reply")).toBe("");
  });

  test("case-insensitive and line-trimmed", () => {
    expect(stripNoReply("done\n  No_ReplY \n")).toBe("done");
  });

  test("token embedded in a line is NOT a token line (stays posted)", () => {
    expect(stripNoReply("NO_REPLY.")).toBe("NO_REPLY.");
    expect(stripNoReply("still here: NO_REPLY")).toBe("still here: NO_REPLY");
  });

  test("every token line removed, remainder trimmed", () => {
    expect(stripNoReply("NO_REPLY\nhead\nNO_REPLY\ntail")).toBe("head\ntail");
  });

  test("isNoReply stays the exact-match primitive", () => {
    expect(isNoReply("NO_REPLY")).toBe(true);
    expect(isNoReply("no_reply")).toBe(true);
    expect(isNoReply("Healthy: \nNO_REPLY")).toBe(false);
  });
});
