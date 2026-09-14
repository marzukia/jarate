import { describe, expect, test } from "bun:test";
import { fmtTokensLC, newCtxWatch, observeCtx } from "./ctxwatch";

describe("fmtTokensLC (#13)", () => {
  test("units: raw below 1k, k integer, m one decimal, lowercase", () => {
    expect(fmtTokensLC(0)).toBe("0");
    expect(fmtTokensLC(999)).toBe("999");
    expect(fmtTokensLC(104_480)).toBe("104k");
    expect(fmtTokensLC(262_144)).toBe("262k");
    expect(fmtTokensLC(999_999)).toBe("1000k");
    expect(fmtTokensLC(1_000_000)).toBe("1.0m");
    expect(fmtTokensLC(2_621_440)).toBe("2.6m");
    expect(fmtTokensLC(12_500_000)).toBe("13m");
    expect(fmtTokensLC(-1)).toBe("?");
    expect(fmtTokensLC(NaN)).toBe("?");
    expect(fmtTokensLC(Infinity)).toBe("?");
  });
});

describe("observeCtx (#13) — one notice per 10% boundary, upward only", () => {
  test("first observation is the baseline: silent, even mid-window", () => {
    const st = newCtxWatch();
    expect(observeCtx(st, 42.3, 110_000, 262_000)).toBeNull();
    // a second sample in the same step: still silent
    expect(observeCtx(st, 44.1, 115_000, 262_000)).toBeNull();
  });

  test("upward crossing fires exactly once with current pct + raw figures", () => {
    const st = newCtxWatch();
    expect(observeCtx(st, 38.0, 99_000, 262_000)).toBeNull();
    expect(observeCtx(st, 41.2, 108_000, 262_000)).toBe(
      "[ctx] 41% (108k/262k)",
    );
    // same boundary again: silent
    expect(observeCtx(st, 45.0, 118_000, 262_000)).toBeNull();
  });

  test("downward moves never fire; a boundary is announced at most once per session", () => {
    const st = newCtxWatch();
    expect(observeCtx(st, 85.0, 223_000, 262_000)).toBeNull(); // baseline at 80s
    // /compact: pct drops 85 -> 20: no notice
    expect(observeCtx(st, 20.0, 52_000, 262_000)).toBeNull();
    // re-crossing boundaries already below the baseline: silent — each
    // boundary is announced at most once per session
    expect(observeCtx(st, 31.0, 81_000, 262_000)).toBeNull();
    expect(observeCtx(st, 62.0, 162_000, 262_000)).toBeNull();
    // a NEW boundary above the baseline still fires
    expect(observeCtx(st, 91.0, 238_000, 262_000)).toBe(
      "[ctx] 91% (238k/262k)",
    );
  });

  test("each boundary is announced at most once per session, even when jumped", () => {
    const st = newCtxWatch();
    observeCtx(st, 5.0, 13_000, 262_000); // baseline
    // a big single step jumps 5 -> 55: one line (the current level),
    // the intermediate 20/30/40/50 boundaries are never announced twice
    expect(observeCtx(st, 55.0, 144_000, 262_000)).toBe(
      "[ctx] 55% (144k/262k)",
    );
    expect(observeCtx(st, 59.0, 155_000, 262_000)).toBeNull();
    // next boundary (60) still fires later
    expect(observeCtx(st, 61.0, 160_000, 262_000)).toBe(
      "[ctx] 61% (160k/262k)",
    );
  });

  test("boundary exactly on the step edge fires (39.9 -> 40.0)", () => {
    const st = newCtxWatch();
    observeCtx(st, 39.9, 104_500, 262_000);
    expect(observeCtx(st, 40.0, 104_800, 262_000)).toBe(
      "[ctx] 40% (105k/262k)",
    );
  });

  test("pct above 90 rounds but never exceeds 100", () => {
    const st = newCtxWatch();
    observeCtx(st, 10.0, 26_200, 262_000);
    expect(observeCtx(st, 99.6, 261_000, 262_000)).toBe(
      "[ctx] 100% (261k/262k)",
    );
  });

  test("bad samples are ignored without corrupting state", () => {
    const st = newCtxWatch();
    expect(observeCtx(st, NaN, 100, 262_000)).toBeNull();
    expect(observeCtx(st, 40, 100, 0)).toBeNull();
    expect(observeCtx(st, 40, -5, 262_000)).toBeNull();
    expect(observeCtx(st, -3, 100, 262_000)).toBeNull();
    // still unprimed: the first GOOD sample is the baseline
    expect(observeCtx(st, 12.0, 31_000, 262_000)).toBeNull();
    expect(observeCtx(st, 21.0, 55_000, 262_000)).toBe("[ctx] 21% (55k/262k)");
  });
});
