import { test, expect, describe } from "bun:test";
import { extractBtwSuffix, BTW_HINT } from "./btw";

describe("extractBtwSuffix", () => {
  test("matches after period", () => {
    expect(extractBtwSuffix("fix the bug. btw")).toEqual({
      prompt: "fix the bug",
      forceBtw: true,
    });
  });

  test("matches after exclamation", () => {
    expect(extractBtwSuffix("done! btw")).toEqual({ prompt: "done", forceBtw: true });
  });

  test("matches after comma", () => {
    expect(extractBtwSuffix("sure, btw")).toEqual({ prompt: "sure", forceBtw: true });
  });

  test("matches after newline", () => {
    expect(extractBtwSuffix("fix the bug\nbtw")).toEqual({ prompt: "fix the bug", forceBtw: true });
  });

  test("matches with trailing dot", () => {
    expect(extractBtwSuffix("fix the bug. btw.")).toEqual({ prompt: "fix the bug", forceBtw: true });
  });

  test("case insensitive", () => {
    expect(extractBtwSuffix("done. BTW")).toEqual({ prompt: "done", forceBtw: true });
  });

  test("no space between punctuation and btw", () => {
    expect(extractBtwSuffix("done.btw")).toEqual({ prompt: "done", forceBtw: true });
  });

  test("does not match at start of message", () => {
    expect(extractBtwSuffix("btw fix this")).toEqual({ prompt: "btw fix this", forceBtw: false });
  });

  test("does not match mid-message without punctuation", () => {
    expect(extractBtwSuffix("hello btw")).toEqual({ prompt: "hello btw", forceBtw: false });
  });

  test("does not match empty content", () => {
    expect(extractBtwSuffix("")).toEqual({ prompt: "", forceBtw: false });
  });

  test("multiline message with btw at end", () => {
    expect(extractBtwSuffix("first line\nsecond line. btw")).toEqual({
      prompt: "first line\nsecond line",
      forceBtw: true,
    });
  });
});

test("BTW_HINT tells the model to answer briefly", () => {
  expect(BTW_HINT).toContain("briefly");
});
