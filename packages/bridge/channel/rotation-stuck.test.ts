// #315 scope C (root fix) tests: the compacting window must close on
// settle AND the stuck-label timeout must close it + re-run the restart
// gate, so a doc-written compact whose settle never arrives still
// rotates (H2); the arm set at the doc write (H1) is what the gate
// consumes. Hermetic: temp HOME/cwd, mocked fetch, fake timers.
import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { clearDiscordStatesForTest } from "./discord";
import extension, {
  beginCompacting,
  clearAllCompacting,
  clearCompacting,
  compactingChannels,
  isCompacting,
  isHandoffRestartArmed,
  opShutdownTimers,
  opWindowLabel,
  resetRuntimeStateForTest,
  setHandoffRestartArmed,
} from "./index";
import { stopAllOpTicks } from "./live";
import {
  setProcessExitHookForTest,
  setSystemdRestartHookForTest,
} from "./restart-ops";
import {
  type ChannelConfig,
  getDefaultChannel,
  loadChannelConfig,
} from "./types";

// The 10-min stuck-label fallback (COMPACT_FALLBACK_MS).
const FALLBACK_MS = 10 * 60 * 1000;

describe("#315 scope C: compacting window close + stuck-label timeout", () => {
  let tmp = "";
  let pi: any;
  let ctx: any;
  let ch: ChannelConfig;
  let handlers: Record<string, (...a: any[]) => any>;
  let errors: string[];
  const realFetch = globalThis.fetch;
  const realHome = process.env.HOME;
  const realError = console.error;

  const compactEvent = {
    type: "session_compact",
    compactionEntry: {},
    fromExtension: false,
    reason: "manual",
    willRetry: false,
  };
  const compactFailedEvent = {
    type: "session_compact_failed",
    reason: "manual",
    errorMessage: "model down",
    aborted: false,
    willRetry: false,
    fromExtension: false,
  };
  const prep = () => ({
    firstKeptEntryId: "e1",
    messagesToSummarize: [{ role: "user", content: "hi" }],
    turnPrefixMessages: [],
    isSplitTurn: false,
    tokensBefore: 1000,
    fileOps: {
      read: new Set<string>(),
      written: new Set<string>(),
      edited: new Set<string>(),
    },
  });

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pir315-test-"));
    process.env.HOME = tmp;
    fs.mkdirSync(path.join(tmp, ".pi"), { recursive: true });
    fs.mkdirSync(path.join(tmp, "sessions"), { recursive: true });
    const live = path.join(tmp, "sessions", "live.jsonl");
    fs.writeFileSync(live, `${JSON.stringify({ type: "message" })}\n`);
    fs.writeFileSync(
      path.join(tmp, ".pi", "settings.json"),
      JSON.stringify({
        channels: [
          {
            id: "ch1",
            name: "Test",
            type: "discord",
            botToken: "tok1",
            ownerUserId: "uid",
          },
        ],
      }),
    );
    handlers = {};
    errors = [];
    pi = {
      registerMessageRenderer: () => {},
      registerTool: () => {},
      on: (n: string, fn: any) => {
        handlers[n] = fn;
      },
      sendMessage: () => {},
    };
    extension(pi);
    ctx = {
      cwd: tmp,
      ui: { setStatus: () => {} },
      isIdle: () => true,
      hasPendingMessages: () => false,
      abort: () => {},
      shutdown: () => {},
      sessionManager: { getSessionFile: () => live },
    };
    globalThis.fetch = (async () => ({
      ok: true,
      status: 200,
      json: async () => ({ id: "out1" }),
      text: async () => "",
    })) as any;
    console.error = (...a: any[]) => {
      errors.push(a.join(" "));
      realError(...a);
    };
    ch = getDefaultChannel(loadChannelConfig(tmp)!)!;
  });

  afterEach(async () => {
    jest.useRealTimers();
    for (const t of opShutdownTimers.values()) clearTimeout(t);
    opShutdownTimers.clear();
    clearAllCompacting();
    setHandoffRestartArmed(false);
    stopAllOpTicks();
    setProcessExitHookForTest(null);
    setSystemdRestartHookForTest(null);
    clearDiscordStatesForTest();
    resetRuntimeStateForTest();
    const realError = console.error;
    console.error = (...a: any[]) => {
      errors.push(a.join(" "));
      realError(...a);
    };
    console.error = realError;
    console.error = realError;
    globalThis.fetch = realFetch;
    if (realHome) process.env.HOME = realHome;
    else delete process.env.HOME;
    fs.rmSync(tmp, { recursive: true, force: true });
  });
  // A bounded fake-timer flush for the deferred gate (0ms timer) + the
  // async maybeHandoffRestart: virtual 0ms steps interleaved with real
  // loop turns, exiting when cond() holds.
  const flushUntil = async (cond: () => boolean, budgetMs = 5000) => {
    for (let used = 0; used < budgetMs && !cond(); used += 1) {
      jest.advanceTimersByTime(0);
      await new Promise<void>((r) => setImmediate(r));
    }
  };

  test("(a) window closes on settle: session_compact and session_compact_failed", async () => {
    // handoff disabled: the settle's gate re-run is inert, so only the
    // window close is under test.
    const p = path.join(tmp, ".pi", "settings.json");
    const cfg = JSON.parse(fs.readFileSync(p, "utf8"));
    cfg.handoff = { enabled: false };
    fs.writeFileSync(p, JSON.stringify(cfg));
    const ch2 = getDefaultChannel(loadChannelConfig(tmp)!)!;

    beginCompacting(pi, ch2, ctx);
    expect(isCompacting("ch1")).toBe(true);
    expect(opWindowLabel("ch1")).toBe("compacting");
    await handlers.session_compact?.(compactEvent, ctx);
    expect(isCompacting("ch1")).toBe(false);

    // re-open: a FAILED settle closes it too
    beginCompacting(pi, ch2, ctx);
    expect(isCompacting("ch1")).toBe(true);
    await handlers.session_compact_failed?.(compactFailedEvent, ctx);
    expect(isCompacting("ch1")).toBe(false);
  });

  test("(b) stuck-label timeout: window closes at 10 min, loud STUCK line, gate re-run opens the restart op", async () => {
    jest.useFakeTimers();
    setSystemdRestartHookForTest(() => {});
    setProcessExitHookForTest(() => {});
    beginCompacting(pi, ch, ctx);
    expect(isCompacting("ch1")).toBe(true);
    // H1 arm: a doc was written for this compact (the (c) test proves the
    // real doc-write path sets it; here the arm is set directly).
    setHandoffRestartArmed(true);

    // Nothing settles: advance to the 10-min stuck-label timeout.
    jest.advanceTimersByTime(FALLBACK_MS);
    await flushUntil(() =>
      fs.existsSync(path.join(tmp, ".tmp", "op-marker.json")),
    );
    expect(fs.existsSync(path.join(tmp, ".tmp", "op-marker.json"))).toBe(true);

    // The stuck window was closed and the gate re-run opened the restart
    // op (window re-opened under the op label, marker written, arm
    // consumed exactly once).
    expect(opWindowLabel("ch1")).toBe("handing-off");
    const marker = JSON.parse(
      fs.readFileSync(path.join(tmp, ".tmp", "op-marker.json"), "utf8"),
    );
    expect(marker.op).toBe("handoff");
    expect(marker.seeded).toBe(false);
    expect(isHandoffRestartArmed()).toBe(false);
    // The stuck-label class is visible in the journal (loud, distinct).
    expect(errors.some((e) => e.includes("[op:compacting] STUCK"))).toBe(true);
  });

  test("(c) arm-on-doc-write: the session_before_compact doc write arms the restart", async () => {
    const event = {
      reason: "manual",
      preparation: prep(),
      branchEntries: [],
      customInstructions: undefined,
    };
    expect(isHandoffRestartArmed()).toBe(false);
    const res = await handlers.session_before_compact?.(event, ctx);
    // Doc written: the compaction result carries the doc as the summary.
    expect(res?.compaction?.summary).toContain("## Transcript");
    // The doc landed in the store (temp HOME).
    const store = path.join(tmp, ".jarate", "handovers");
    expect(fs.existsSync(path.join(store, "latest.md"))).toBe(true);
    // H1: the arm is set by the doc write, for the settle's gate re-run.
    expect(isHandoffRestartArmed()).toBe(true);
  });

  test("(d) idempotency: a second doc write in the same episode does not double-arm or re-open a closed window; the timeout fires once", async () => {
    jest.useFakeTimers();
    setSystemdRestartHookForTest(() => {});
    setProcessExitHookForTest(() => {});
    const event = (extra?: object) => ({
      reason: "manual",
      preparation: prep(),
      branchEntries: [],
      customInstructions: undefined,
      ...extra,
    });
    const store = path.join(tmp, ".jarate", "handovers");

    // Episode: doc write 1, the compact window opens, doc write 2.
    await handlers.session_before_compact?.(event(), ctx);
    expect(isHandoffRestartArmed()).toBe(true);
    beginCompacting(pi, ch, ctx);
    expect(isCompacting("ch1")).toBe(true);
    await handlers.session_before_compact?.(event(), ctx);
    // Double doc write: the arm is a single boolean (no double-arm),
    // the window is the SAME single window (not re-opened).
    expect(isHandoffRestartArmed()).toBe(true);
    expect(compactingEntries("ch1")).toBe(1);

    // Nothing settles: the stuck-label timeout fires ONCE (the first
    // window's timer was replaced by the second beginCompacting).
    jest.advanceTimersByTime(FALLBACK_MS);
    await flushUntil(() =>
      fs.existsSync(path.join(tmp, ".tmp", "op-marker.json")),
    );
    // One restart op, arm consumed once, exactly one STUCK line.
    expect(opWindowLabel("ch1")).toBe("handing-off");
    expect(isHandoffRestartArmed()).toBe(false);
    expect(
      errors.filter((e) => e.includes("[op:compacting] STUCK")),
    ).toHaveLength(1);

    // The op window is closed (cancel), and a LATER doc write must not
    // re-open a closed window: the window stays closed.
    clearCompacting("ch1");
    expect(isCompacting("ch1")).toBe(false);
    await handlers.session_before_compact?.(event(), ctx);
    expect(isCompacting("ch1")).toBe(false);
    // The new doc write re-arms for ITS OWN compact (the arm means "the
    // compact that wrote this doc must restart") - a fresh arm, not a
    // double-arm of the consumed one.
    expect(isHandoffRestartArmed()).toBe(true);
    expect(fs.existsSync(path.join(store, "latest.md"))).toBe(true);
  });
});

// The compacting-window map is per-channel keyed; count entries for a
// channel (a re-opened window replaces, never stacks - 1 is the only
// value this can take).
function compactingEntries(id: string): number {
  let n = 0;
  for (const k of compactingChannels.keys()) if (k === id) n++;
  return n;
}
