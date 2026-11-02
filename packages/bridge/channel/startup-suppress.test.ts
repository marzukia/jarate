import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  isStartupMessageSuppressedForThisStart,
  resetStartupMessageSuppressionForTests,
  suppressStartupMessageForThisStart,
} from "./startup-suppress";

// #328: the shared once-per-process flag that makes an unclean restart
// post exactly one message (the restart-wake card) instead of two
// (card + startup message). Pattern: the version-drift checkedOnce
// flag, with a test-hook reset.
describe("startup-suppress (#328: one post per restart)", () => {
  beforeEach(() => {
    resetStartupMessageSuppressionForTests();
  });

  // bun test can share the module registry across files in one worker —
  // never leave the flag set at test end (other suites' startup
  // message posts must not see it).
  afterEach(() => {
    resetStartupMessageSuppressionForTests();
  });

  test("starts unset; suppress sets it; idempotent; reset re-arms", () => {
    expect(isStartupMessageSuppressedForThisStart()).toBe(false);
    suppressStartupMessageForThisStart();
    suppressStartupMessageForThisStart(); // idempotent (once per process)
    expect(isStartupMessageSuppressedForThisStart()).toBe(true);
    resetStartupMessageSuppressionForTests();
    expect(isStartupMessageSuppressedForThisStart()).toBe(false);
  });

  test("once set for the process, it stays set (a later reload does not re-arm it)", () => {
    suppressStartupMessageForThisStart();
    // no reset in between: a later session_start in the same process
    // still sees the suppression (the flag is per process, not per
    // session start — a reload is not a new start)
    expect(isStartupMessageSuppressedForThisStart()).toBe(true);
  });
});
