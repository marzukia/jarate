// channel/restart-ops.ts tests — moved verbatim from index.test.ts
// (god-file split 4/5, 2026-10-20). All blocks are self-contained
// (own harness); no shared index.test.ts state.
import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  clearDiscordStatesForTest,
  getChannelCursor,
  loadPersistedCursors,
  pollDiscord,
  seedChannelStateForTest,
  setChannelCursor,
} from "./discord";
import { ORCHESTRATOR_PRIME_LINE, writeHandover } from "./handover";
import extension, {
  clearAllCompacting,
  clearAllInterrupts,
  handleInbound,
  heldChannels,
  isCompacting,
  isHeld,
  opWindowLabel,
  pendingInterrupts,
  resetRuntimeStateForTest,
  runMidRunInterrupt,
  setHandoffRestartArmed,
  setInterruptCtx,
  verboseOverride,
} from "./index";
import { fence, stopAllOpTicks } from "./live";
import {
  clearQueuedInbound,
  midTurnQueues,
  queuedAcks,
  queueMidTurnInbound,
} from "./queue";
import {
  buildRestartCommand,
  moveSessionFileAside,
  parseUndoCount,
  setLiveKickoffStateHookForTest,
  setProcessExitHookForTest,
  setSystemdRestartHookForTest,
} from "./restart-ops";
import {
  type ChannelMessage,
  loadChannelConfig,
  resolveSystemdUnit,
} from "./types";

// Fleet-run gate (hall-monitor #35 gut): a dispatch agent running this
// suite inherits PI_SESSION_ID=fleetwork-<ticket> from its run wrapper;
// the gate treats that as a fleet run and would skip all channel startup
// in every test. Clear it here (#273 review (C): replicate the
// index.test.ts guard in the split-off files).
delete process.env.PI_SESSION_ID;

describe("parseUndoCount (#46 /undo N)", () => {
  test("bare / whitespace = 1; positive integers pass through", () => {
    expect(parseUndoCount(undefined)).toBe(1);
    expect(parseUndoCount("")).toBe(1);
    expect(parseUndoCount("   ")).toBe(1);
    expect(parseUndoCount("1")).toBe(1);
    expect(parseUndoCount(" 2 ")).toBe(2);
    expect(parseUndoCount("10")).toBe(10);
    expect(parseUndoCount("007")).toBe(7);
  });

  test("0, negative, non-numeric -> null (one line, no action)", () => {
    expect(parseUndoCount("0")).toBeNull();
    expect(parseUndoCount("-1")).toBeNull();
    expect(parseUndoCount("abc")).toBeNull();
    expect(parseUndoCount("1.5")).toBeNull();
    expect(parseUndoCount("1x")).toBeNull();
    expect(parseUndoCount("2 turns")).toBeNull();
  });
});

// ─── Handoff mechanism B: size-gated restart (PR2) ────────────────────────

describe("handoff mechanism B (size-gated restart)", () => {
  let tmp = "";
  let oldHome = "";
  let storeDir = "";
  let sessDir = "";
  let liveFile = "";
  let pi: any;
  let ctx: any;
  let handlers: Record<string, (...a: any[]) => any> = {};
  let fetchCalls: { url: string; method: string; body?: any }[] = [];
  let shutdowns = 0;
  let seedMsgs: string[] = [];
  let restarter: string[] = [];
  const realFetch = globalThis.fetch;

  const CHANNELS = [
    {
      id: "ch1",
      name: "Test",
      type: "discord",
      botToken: "tok1",
      ownerUserId: "uid",
      default: true,
    },
  ];

  const inbound = (body: string, id: string): ChannelMessage => ({
    channelId: "ch1",
    channelName: "Test",
    channelType: "discord",
    messageId: id,
    from: "u",
    fromId: "uid",
    body,
    timestamp: new Date().toISOString(),
    attachments: [],
    isRoom: false,
  });

  const channelPosts = () =>
    fetchCalls
      .filter(
        (c) => c.url.includes("/channels/ch1/messages") && c.method === "POST",
      )
      .map(
        (c) =>
          (typeof c.body === "string" ? JSON.parse(c.body) : c.body).content,
      );

  const edits = () =>
    fetchCalls
      .filter((c) => c.method === "PATCH" && c.url.includes("/messages/"))
      .map(
        (c) =>
          (typeof c.body === "string" ? JSON.parse(c.body) : c.body).content,
      );

  // wait out a pending op shutdown (300ms arm + immediate isIdle) so the
  // session-file move happens while HOME still points at tmp
  const waitOpShutdown = () => new Promise((r) => setTimeout(r, 1100));

  const writeSettings = (handoff: Record<string, unknown>) => {
    fs.mkdirSync(path.join(tmp, ".pi"), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, ".pi", "settings.json"),
      JSON.stringify({ channels: CHANNELS, handoff }),
    );
  };

  const markerPath = () => path.join(tmp, ".tmp", "op-marker.json");

  const writeMarker = (m: Record<string, unknown>) => {
    fs.mkdirSync(path.dirname(markerPath()), { recursive: true });
    fs.writeFileSync(markerPath(), JSON.stringify(m));
  };

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "handoff-b-"));
    oldHome = process.env.HOME || "";
    process.env.HOME = path.join(tmp, "home");
    fs.mkdirSync(path.join(tmp, "home"), { recursive: true });
    storeDir = path.join(tmp, "home", "handovers");
    sessDir = path.join(tmp, "sessions");
    fs.mkdirSync(sessDir, { recursive: true });
    liveFile = path.join(sessDir, "live.jsonl");
    fs.writeFileSync(liveFile, "x".repeat(1024));
    shutdowns = 0;
    seedMsgs = [];
    restarter = [];
    fetchCalls = [];
    (handlers as any) = {};
    pi = {
      on: (n: string, fn: any) => {
        (handlers as any)[n] = fn;
      },
      sendMessage: () => {},
      sendUserMessage: (c: string) => {
        seedMsgs.push(c);
      },
      registerMessageRenderer: () => {},
      registerTool: () => {},
    };
    ctx = {
      cwd: tmp,
      ui: { setStatus: () => {} },
      isIdle: () => true,
      hasPendingMessages: () => false,
      abort: () => {},
      model: { id: "m", name: "M", provider: "p" },
      modelRegistry: {
        getAvailable: () => [],
      },
      sessionManager: {
        getSessionFile: () => liveFile,
        getSessionId: () => "sess-b",
      },
      getContextUsage: () => ({
        tokens: 1000,
        contextWindow: 262144,
        percent: 1,
      }),
      compact: () => {},
      shutdown: () => {
        shutdowns++;
      },
      on: () => {},
    };
    // op machinery needs a live cursor: seed the discord state for ch1
    seedChannelStateForTest("ch1", "ch1", path.join(tmp, ".tmp"));
    setChannelCursor("ch1", "1000");
    (globalThis as any).fetch = jest.fn(async (url: any, init?: any) => {
      fetchCalls.push({
        method: init?.method ?? "GET",
        url: String(url),
        body: init?.body,
      });
      return { ok: true, status: 200, json: async () => ({ id: "out1" }) };
    });
    setSystemdRestartHookForTest((u) => restarter.push(u));
    setProcessExitHookForTest(() => {});
    extension(pi as any);
  });
  afterEach(() => {
    setSystemdRestartHookForTest(null);
    setProcessExitHookForTest(null);
    (globalThis as any).fetch = realFetch;
    (handlers as any) = {};
    clearAllCompacting();
    stopAllOpTicks();
    setHandoffRestartArmed(false);
    process.env.HOME = oldHome;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test("every compact restarts (issue #85 follow-up): small file, no cap check", async () => {
    // The file-size cap is gone: any handoff-qualifying compact restarts.
    // liveFile is 1KB from beforeEach — it still restarts.
    writeSettings({ enabled: true, storeDir });
    await handleInbound(pi, inbound("/compact", "m1"), ctx);
    handlers.session_compact?.({ type: "session_compact" }, ctx);
    await waitOpShutdown();
    expect(shutdowns).toBe(1);
    expect(restarter).toEqual(["pi.service"]);
    const marker = JSON.parse(fs.readFileSync(markerPath(), "utf8"));
    expect(marker.op).toBe("handoff");
    expect(marker.seeded).toBe(false);
    expect(fs.existsSync(liveFile)).toBe(false); // moved aside
  });

  test("restart op: placeholder, seeded:false marker, file move + stale archive, shutdown", async () => {
    // (was "over the cap" — the cap check is gone since c863c341: every
    // handoff-qualifying compact restarts; this test exercises the restart
    // chain, not a size gate.)
    writeSettings({ enabled: true, storeDir });
    fs.writeFileSync(liveFile, "x".repeat(1_572_864)); // 1.5 MB
    const stale = path.join(sessDir, "old.jsonl");
    fs.writeFileSync(stale, "old session");

    await handleInbound(pi, inbound("/compact", "m1"), ctx);
    handlers.session_compact?.({ type: "session_compact" }, ctx);
    await waitOpShutdown();

    // placeholder posted + marker left for the respawn to settle
    expect(channelPosts().some((t) => t.includes("[..] handing-off..."))).toBe(
      true,
    );
    expect(fs.existsSync(markerPath())).toBe(true);
    const marker = JSON.parse(fs.readFileSync(markerPath(), "utf8"));
    expect(marker.op).toBe("handoff");
    expect(marker.seeded).toBe(false);
    expect(marker.finalText).toBe(
      "context handoff -> new session (file was 1.5 MB)",
    );
    // restart chain: bounded shutdown + systemd restart
    expect(shutdowns).toBe(1);
    expect(restarter).toEqual(["pi.service"]);
    // F5: the explicit live file moved aside; F2: the OTHER .jsonl
    // archived so the respawn's 'pi -c' target is provably small
    const files = fs.readdirSync(sessDir);
    expect(files.some((f) => f.startsWith("live.jsonl.reset-"))).toBe(true);
    expect(files.some((f) => f.startsWith("old.jsonl.stale-"))).toBe(true);
    expect(files.filter((f) => f.endsWith(".jsonl"))).toEqual([]);
  });

  test("/stop during the handoff op: cancelled, marker cleared, cursor restored, file untouched", async () => {
    writeSettings({ enabled: true, storeDir });
    fs.writeFileSync(liveFile, "x".repeat(1_572_864));
    await handleInbound(pi, inbound("/compact", "m1"), ctx);
    handlers.session_compact?.({ type: "session_compact" }, ctx);
    await new Promise((r) => setTimeout(r, 50)); // B gate opened the op
    expect(opWindowLabel("ch1")).toBe("handing-off");
    await handleInbound(pi, inbound("/stop", "m2"), ctx);
    expect(isCompacting("ch1")).toBe(false);
    expect(fs.existsSync(markerPath())).toBe(false); // marker went with the op
    expect(getChannelCursor("ch1")).toBe("1000"); // rewound to op start
    await waitOpShutdown(); // the shutdown timer was dropped at /stop
    expect(shutdowns).toBe(0);
    expect(fs.existsSync(liveFile)).toBe(true); // file never moved
    expect(restarter).toEqual([]);
  });

  test("handoff disabled: large file, no restart op", async () => {
    writeSettings({ enabled: false, storeDir });
    fs.writeFileSync(liveFile, "x".repeat(2048));
    await handleInbound(pi, inbound("/compact", "m1"), ctx);
    handlers.session_compact?.({ type: "session_compact" }, ctx);
    await waitOpShutdown();
    expect(shutdowns).toBe(0);
    expect(restarter).toEqual([]);
    expect(fs.existsSync(liveFile)).toBe(true);
    expect(fs.existsSync(markerPath())).toBe(false);
  });

  test("every compact restarts (issue #85 follow-up): 2.5MB file, no cap check", async () => {
    // The file-size cap is gone: the restart fires on every handoff
    // qualifying compact regardless of file size.
    writeSettings({ enabled: true, storeDir });
    fs.writeFileSync(liveFile, "x".repeat(2_621_440)); // 2.5 MB
    await handleInbound(pi, inbound("/compact", "m1"), ctx);
    handlers.session_compact?.({ type: "session_compact" }, ctx);
    await waitOpShutdown();
    expect(shutdowns).toBe(1);
    expect(restarter).toEqual(["pi.service"]);
    const marker = JSON.parse(fs.readFileSync(markerPath(), "utf8"));
    expect(marker.op).toBe("handoff");
    expect(marker.finalText).toBe(
      "context handoff -> new session (file was 2.5 MB)",
    );
  });

  test("fresh window guard: a just-seeded session does not immediately re-restart", async () => {
    writeSettings({ enabled: true, storeDir });
    // Write a fresh handover doc (latest.md with an updated: timestamp)
    // so isHandoffFreshWindow returns true.
    const docFile = path.join(storeDir, "latest.md");
    fs.mkdirSync(storeDir, { recursive: true });
    fs.writeFileSync(
      docFile,
      `# Handover\nupdated: ${new Date().toISOString()}\n`,
    );
    await handleInbound(pi, inbound("/compact", "m1"), ctx);
    handlers.session_compact?.({ type: "session_compact" }, ctx);
    await waitOpShutdown();
    // The restart op was skipped (fresh window) — no shutdown.
    expect(shutdowns).toBe(0);
    expect(restarter).toEqual([]);
    expect(fs.existsSync(liveFile)).toBe(true); // file untouched
  });

  test("doc-written arm exempts the triggering restart from the fresh window (issue #85)", async () => {
    writeSettings({ enabled: true, storeDir });
    // session_before_compact just wrote a handover doc: it set BOTH the
    // latest.md stamp (fresh window) AND the restart arm.
    const docFile = path.join(storeDir, "latest.md");
    fs.mkdirSync(storeDir, { recursive: true });
    fs.writeFileSync(
      docFile,
      `# Handover\nupdated: ${new Date().toISOString()}\n`,
    );
    setHandoffRestartArmed(true); // what the doc write now does
    await handleInbound(pi, inbound("/compact", "m1"), ctx);
    handlers.session_compact?.({ type: "session_compact" }, ctx);
    await waitOpShutdown();
    // Restart fired DESPITE the fresh window (the arm exempts the triggering
    // compact); the session rotated -> live file moved aside.
    expect(shutdowns).toBe(1);
    expect(restarter).toEqual(["pi.service"]);
    const marker = JSON.parse(fs.readFileSync(markerPath(), "utf8"));
    expect(marker.op).toBe("handoff");
    expect(marker.seeded).toBe(false);
    expect(fs.existsSync(liveFile)).toBe(false);
  });

  test("settle-flushed /compact re-opens the window: B skips, restarts after that compact's settle", async () => {
    writeSettings({ enabled: true, storeDir });
    fs.writeFileSync(liveFile, "x".repeat(1_572_864));

    // auto-compact in flight: no bridge window (startCompact not involved),
    // isIdle false → /compact QUEUES behind it (pendingCompact)
    ctx.isIdle = () => false;
    await handleInbound(pi, inbound("/compact", "m1"), ctx);
    expect(isCompacting("ch1")).toBe(false); // queued, not started
    // the auto compaction finishes → session_compact settles + flushes
    ctx.isIdle = () => true;
    handlers.session_compact?.({ type: "session_compact" }, ctx);
    await new Promise((r) => setTimeout(r, 50));
    expect(opWindowLabel("ch1")).toBe("compacting"); // flushed C2's window
    expect(fs.existsSync(markerPath())).toBe(false); // B skipped it
    // C2 settles → B proceeds
    handlers.session_compact?.({ type: "session_compact" }, ctx);
    await waitOpShutdown();
    const marker = JSON.parse(fs.readFileSync(markerPath(), "utf8"));
    expect(marker.op).toBe("handoff");
    expect(shutdowns).toBe(1);
  });

  test("boot seed: handoff marker (seeded:false) → user-message seed + marker settled", async () => {
    writeSettings({ enabled: true, storeDir });
    writeHandover(
      [
        "# Handover - 2026-09-23 · session s · 100k tokens → handoff",
        "",
        "## 1 · Mission",
        "Ship the bridge with tests.",
        "",
        "## 2 · In-flight (NOW)",
        "Wiring the compact handler.",
        "",
        "## 10 · Last 3 user asks",
        "1. do the thing",
      ].join("\n"),
      { storeDir, now: new Date() },
    );
    writeMarker({
      op: "handoff",
      channelId: "ch1",
      at: Date.now(),
      msgId: "out1",
      finalText: "context handoff -> new session (file was 1.5 MB)",
      seeded: false,
    });
    // issue #134: the seed carries LIVE dispatch + board state (pinned here
    // - real ps/board are environment-dependent), not doc-scraped prose.
    setLiveKickoffStateHookForTest(() => ({
      dispatchText:
        "**jobs · 1 in flight**\n\n- 20261003-081922-478435 worker · 01:07:43",
      todoBoard: "**todos · 1 open**\n\n- ship it",
    }));

    try {
      await handlers.session_start?.(null, ctx);

      // the seed is a plain user message (never a channel-inbound: no
      // Discord echo, no polluting the next handover's last-asks)
      expect(seedMsgs).toHaveLength(1);
      const lines = seedMsgs[0].split("\n");
      expect(lines[1]).toBe("Mission: 1 open: ship it");
      expect(lines[2]).toBe(
        "In-flight: 20261003-081922-478435 worker · 01:07:43",
      );
      expect(lines[3]).toBe("Last ask: 1. do the thing");
      // issue #140: the hook carries no scheduledText → (none)
      expect(lines[4]).toBe("Scheduled: (none)");
      expect(lines[5]).toBe(ORCHESTRATOR_PRIME_LINE);
      expect(lines[6]).toBe(
        `Read ${storeDir}/latest.md before continuing. Answer the last pending user question if any.`,
      );
      // marker consumed: a second boot cannot re-seed
      expect(fs.existsSync(markerPath())).toBe(false);
      // placeholder replaced with the final line
      expect(
        edits().some((t) =>
          t.includes("context handoff -> new session (file was 1.5 MB)"),
        ),
      ).toBe(true);
    } finally {
      setLiveKickoffStateHookForTest(null);
    }
  });

  test("ordinary boot (no marker): no seed, even with a doc in the store", async () => {
    writeSettings({ enabled: true, storeDir });
    writeHandover("# doc\n## 1 · Mission\nShip.", {
      storeDir,
      now: new Date(),
    });
    await handlers.session_start?.(null, ctx);
    expect(seedMsgs).toHaveLength(0);
  });

  test("already-seeded marker: no re-seed, final line still settled", async () => {
    writeSettings({ enabled: true, storeDir });
    writeHandover("# doc\n## 1 · Mission\nShip.", {
      storeDir,
      now: new Date(),
    });
    writeMarker({
      op: "handoff",
      channelId: "ch1",
      at: Date.now(),
      msgId: "out1",
      finalText: "context handoff -> new session (file was 1.5 MB)",
      seeded: true,
    });
    await handlers.session_start?.(null, ctx);
    expect(seedMsgs).toHaveLength(0);
    expect(fs.existsSync(markerPath())).toBe(false);
    expect(
      edits().some((t) =>
        t.includes("context handoff -> new session (file was 1.5 MB)"),
      ),
    ).toBe(true);
  });
});

describe("restart-class ops (/reset /restart): block + tick + cursor replay", () => {
  let tmp = "";
  let oldHome = "";
  let pi: any;
  let ctx: any;
  let handlers: Record<string, (...a: any[]) => any> = {};
  let sent: { m: any; o?: any }[] = [];
  let fetchCalls: { url: string; method: string; body?: any }[] = [];
  let shutdowns = 0;
  let home = "";
  const realFetch = globalThis.fetch;

  const inbound = (body: string, id: string): ChannelMessage => ({
    channelId: "ch1",
    channelName: "Test",
    channelType: "discord",
    messageId: id,
    from: "u",
    fromId: "uid",
    body,
    timestamp: new Date().toISOString(),
    attachments: [],
    isRoom: false,
  });

  const tick = () => new Promise((r) => setTimeout(r, 0));

  const channelPosts = () =>
    fetchCalls
      .filter(
        (c) => c.url.includes("/channels/ch1/messages") && c.method === "POST",
      )
      .map(
        (c) =>
          (typeof c.body === "string" ? JSON.parse(c.body) : c.body).content,
      );

  const edits = () =>
    fetchCalls
      .filter((c) => c.method === "PATCH" && c.url.includes("/messages/"))
      .map(
        (c) =>
          (typeof c.body === "string" ? JSON.parse(c.body) : c.body).content,
      );

  // wait out a pending op shutdown (300ms arm + immediate isIdle) so the
  // session-file move happens while HOME still points at tmp
  const waitOpShutdown = () => new Promise((r) => setTimeout(r, 1100));

  beforeEach(() => {
    clearDiscordStatesForTest(); // no auto-react suppression leaks across tests
    resetRuntimeStateForTest(); // sessionStartTs/held/verbose: no leaks
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "op-test-"));
    oldHome = process.env.HOME || "";
    home = path.join(tmp, "home");
    process.env.HOME = home;
    fs.mkdirSync(path.join(tmp, ".pi"), { recursive: true });
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
            ack: true,
          },
        ],
      }),
    );
    handlers = {};
    sent = [];
    fetchCalls = [];
    shutdowns = 0;
    pi = {
      registerMessageRenderer: () => {},
      registerTool: () => {},
      on: (n: string, fn: any) => {
        handlers[n] = fn;
      },
      sendMessage: (m: any, o?: any) => {
        sent.push({ m, o });
      },
    };
    extension(pi);
    ctx = {
      cwd: tmp,
      ui: { setStatus: () => {} },
      isIdle: () => true,
      hasPendingMessages: () => false,
      abort: () => {},
      compact: () => {},
      modelRegistry: { getAvailable: () => [] },
      getContextUsage: () => undefined,
      model: { id: "cur", name: "Cur" },
      shutdown: () => {
        shutdowns++;
      },
    };
    globalThis.fetch = (async (url: any, init?: any) => {
      fetchCalls.push({
        url: String(url),
        method: init?.method ?? "GET",
        body: init?.body,
      });
      return {
        ok: true,
        status: 200,
        json: async () => ({ id: "out1" }),
        text: async () => "",
      };
    }) as any;
    // op machinery needs a live cursor: seed the discord state for ch1.
    seedChannelStateForTest("ch1", "ch1", path.join(tmp, ".tmp"));
    setChannelCursor("ch1", "1000");
    // keep the test from spawning a real `systemctl --user restart`
    setSystemdRestartHookForTest(() => {});
  });

  afterEach(async () => {
    clearDiscordStatesForTest(); // no auto-react suppression leaks across tests
    jest.useRealTimers();
    stopAllOpTicks();
    clearAllCompacting();
    clearAllInterrupts();
    resetRuntimeStateForTest(); // no hold/verbose leaks across tests (#84 L2)
    setInterruptCtx(null);
    setSystemdRestartHookForTest(null);
    setProcessExitHookForTest(null);
    for (const id of [...midTurnQueues.keys()]) clearQueuedInbound(id);
    queuedAcks.clear();
    pendingInterrupts.clear();
    handlers.agent_end?.({ messages: [] }, ctx);
    stopAllOpTicks();
    clearAllCompacting();
    clearDiscordStatesForTest();
    process.env.HOME = oldHome;
    globalThis.fetch = realFetch;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test("idle /reset: posts ticking placeholder, blocks the channel, moves the session aside, rewinds the cursor", async () => {
    const sessDir = path.join(
      home,
      ".pi",
      "agent",
      "sessions",
      `-${String(tmp).replace(/\//g, "-")}-`,
    );
    fs.mkdirSync(sessDir, { recursive: true });
    const sess = path.join(sessDir, "s.jsonl");
    fs.writeFileSync(sess, "{}\n");

    await handleInbound(pi, inbound("/reset", "m1"), ctx);
    await tick();
    expect(channelPosts().some((t) => t.includes("[..] resetting..."))).toBe(
      true,
    );
    expect(isCompacting("ch1")).toBe(true);
    expect(opWindowLabel("ch1")).toBe("resetting");

    // an inbound lands during the op -> cursor advances past it
    setChannelCursor("ch1", "1200");
    await waitOpShutdown();
    expect(shutdowns).toBe(1);
    // session file moved aside -> respawn starts a fresh session
    expect(fs.existsSync(sess)).toBe(false);
    expect(fs.readdirSync(sessDir).some((f) => f.includes(".reset-"))).toBe(
      true,
    );
    // cursor rewound to the pre-op position, persisted for the respawn
    expect(getChannelCursor("ch1")).toBe("1000");
    expect(loadPersistedCursors(path.join(tmp, ".tmp")).ch1).toBe("1000");
  });

  test("idle /restart: same block + tick, but the session file is KEPT (resumed)", async () => {
    const sessDir = path.join(
      home,
      ".pi",
      "agent",
      "sessions",
      `-${String(tmp).replace(/\//g, "-")}-`,
    );
    fs.mkdirSync(sessDir, { recursive: true });
    const sess = path.join(sessDir, "s.jsonl");
    fs.writeFileSync(sess, "{}\n");

    await handleInbound(pi, inbound("/restart", "m1"), ctx);
    await tick();
    expect(channelPosts().some((t) => t.includes("[..] restarting..."))).toBe(
      true,
    );
    expect(opWindowLabel("ch1")).toBe("restarting");
    await waitOpShutdown();
    expect(shutdowns).toBe(1);
    expect(fs.existsSync(sess)).toBe(true); // not moved aside
  });

  test("/reset drains queued inbounds before shutdown (#84 L2): acks deleted, not orphaned", async () => {
    verboseOverride.set("ch1", 1); // verbose 1: the [queued] ack posts
    await handlers.session_start?.(null, ctx); // configRoot for ack REST
    // a run is in flight: a plain message queues + posts an ack
    ctx.isIdle = () => false;
    await handleInbound(pi, inbound("queued work", "mq1"), ctx);
    await tick(); // settle the fire-and-forget ack post
    const ackId = queuedAcks.get("mq1")?.ackId;
    expect(ackId).toBeDefined();
    expect(channelPosts().some((t) => t.includes("[queued] 1 in line"))).toBe(
      true,
    );

    // #84 L2: /reset must drain the queue while the process is still alive,
    // so the ack is DELETED — a respawn never references it, and a shutdown
    // map-clear would orphan the message in the channel forever.
    await handleInbound(pi, inbound("/reset", "m1"), ctx);
    await tick(); // settle the fire-and-forget delete
    expect(midTurnQueues.get("ch1")).toBeUndefined();
    expect(queuedAcks.get("mq1")).toBeUndefined();
    const del = fetchCalls.find(
      (c) =>
        c.method === "DELETE" &&
        c.url.endsWith(`/channels/ch1/messages/${ackId}`),
    );
    expect(del).toBeDefined();
  });

  test("/reset keeps a HELD channel's buffer (#84 L2, A4 parity): no drain", async () => {
    verboseOverride.set("ch1", 1); // verbose 1: the [queued] ack posts
    await handlers.session_start?.(null, ctx); // configRoot for ack REST
    // hold the channel, then buffer a message (held queues even while idle)
    await handleInbound(pi, inbound("/hold on", "mh1"), ctx);
    await tick();
    expect(isHeld(loadChannelConfig(ctx.cwd)[0]!)).toBe(true);
    await handleInbound(pi, inbound("buffered work", "mq1"), ctx);
    await tick();
    const ackId = queuedAcks.get("mq1")?.ackId;
    expect(ackId).toBeDefined();

    // #84 L2 (A4): a HELD channel's queue is the operator's buffer — /reset
    // keeps it. No drain, the ack is NOT deleted.
    await handleInbound(pi, inbound("/reset", "m1"), ctx);
    await tick();
    expect(midTurnQueues.get("ch1")?.[0]?.msg.messageId).toBe("mq1");
    expect(queuedAcks.get("mq1")?.ackId).toBe(ackId);
    const del = fetchCalls.find(
      (c) =>
        c.method === "DELETE" &&
        c.url.endsWith(`/channels/ch1/messages/${ackId}`),
    );
    expect(del).toBeUndefined();
  });

  test("/reset placeholder ticks in place every 5s (shared op tick)", async () => {
    jest.useFakeTimers();
    await handleInbound(pi, inbound("/reset", "m1"), ctx);
    // settle the fire-and-forget placeholder post (microtasks, no timers)
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(channelPosts().some((t) => t.includes("[..] resetting..."))).toBe(
      true,
    );

    // the bounded op shutdown lands at +300ms (isIdle is immediate here)
    jest.advanceTimersByTime(300);
    // flush the async shutdown chain (race on the placeholder + rewinds)
    for (let i = 0; i < 20; i++) await Promise.resolve();
    expect(shutdowns).toBe(1);

    // window stays open until the respawn clears it -> ticks keep going
    // (one-line op status = prose, bare ticks per v4 §2.3)
    jest.advanceTimersByTime(4699); // t=4999
    expect(edits().length).toBe(0);
    jest.advanceTimersByTime(1); // t=5000
    expect(edits()).toEqual(["[..] resetting… 5s"]);
    jest.advanceTimersByTime(5000); // t=10000
    expect(edits()).toEqual(["[..] resetting… 5s", "[..] resetting… 10s"]);

    // respawn clears the window -> ticks stop
    clearAllCompacting();
    jest.advanceTimersByTime(60000);
    expect(edits().length).toBe(2);
  });

  test("inbound during the /reset window: queued with an ack, no interrupt armed", async () => {
    verboseOverride.set("ch1", 1); // verbose 1: the [queued] ack posts
    await handleInbound(pi, inbound("/reset", "m1"), ctx);
    await tick();
    expect(isCompacting("ch1")).toBe(true);

    await handleInbound(pi, inbound("hello", "m2"), ctx);
    await tick();
    expect(channelPosts().some((t) => t.includes("[queued] 1 in line"))).toBe(
      true,
    );
    expect(midTurnQueues.get("ch1")?.[0]?.msg.messageId).toBe("m2");
    expect(pendingInterrupts.get("ch1")).toBeUndefined();
    await waitOpShutdown();
  });

  test("respawn: session_start settles the placeholder in place + cursor replays the op window", async () => {
    await handleInbound(pi, inbound("/reset", "m1"), ctx);
    await tick();
    setChannelCursor("ch1", "1200"); // an op-window inbound was delivered
    await waitOpShutdown();
    expect(shutdowns).toBe(1);

    // fresh process boots: old in-memory window/ticks are gone
    clearAllCompacting();
    stopAllOpTicks();
    const editsBefore = edits().length;
    await handlers.session_start?.(null, ctx);
    await tick();

    // the placeholder is REPLACED in place with the bare final line, not
    // re-posted (status is prose — unfenced placeholder, unfenced settle;
    // same form on both sides per v4 §2.3)
    const finalText = "[new] new session (context cleared)";
    expect(
      edits()
        .slice(editsBefore)
        .some((t) => t === finalText),
    ).toBe(true);
    expect(channelPosts().some((t) => t === finalText)).toBe(false);
    // marker consumed
    expect(fs.existsSync(path.join(tmp, ".tmp", "op-marker.json"))).toBe(false);

    // the new process replays the op window: first poll ranges after the
    // pre-op cursor (1000), not after the advanced 1200
    await pollDiscord("ch1");
    const pollUrl = fetchCalls.find((c) => c.url.includes("after="))?.url;
    expect(pollUrl).toContain("after=1000");
  });

  test("respawn settle without a msgId posts a bare final line", async () => {
    const p = path.join(tmp, ".tmp", "op-marker.json");
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const finalText = "[new] new session (context cleared)";
    fs.writeFileSync(
      p,
      JSON.stringify({
        op: "reset",
        channelId: "ch1",
        at: Date.now(),
        finalText,
      }),
    );
    await handlers.session_start?.(null, ctx);
    await tick();
    // bare fresh post — same prose form as the bare placeholder, never fenced
    expect(channelPosts().some((t) => t === finalText)).toBe(true);
    expect(channelPosts().some((t) => t === fence(finalText))).toBe(false);
    expect(edits().some((t) => t === finalText || t === fence(finalText))).toBe(
      false,
    );
    expect(fs.existsSync(p)).toBe(false); // consumed
  });

  test("stale op marker (>10m) is dropped, not shown", async () => {
    const p = path.join(tmp, ".tmp", "op-marker.json");
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(
      p,
      JSON.stringify({
        op: "reset",
        channelId: "ch1",
        at: Date.now() - 11 * 60 * 1000,
        msgId: "x",
        finalText: "[new] stale",
      }),
    );
    await handlers.session_start?.(null, ctx);
    await tick();
    expect(channelPosts().some((t) => t === "[new] stale")).toBe(false);
    expect(edits().some((t) => t === "[new] stale")).toBe(false);
    expect(fs.existsSync(p)).toBe(false); // consumed either way
  });

  test("/undo 0 and /undo abc: one [!] usage line, no action, no op window", async () => {
    const sessDir = path.join(
      home,
      ".pi",
      "agent",
      "sessions",
      `-${String(tmp).replace(/\//g, "-")}-`,
    );
    const sess = path.join(sessDir, "s.jsonl");
    fs.mkdirSync(sessDir, { recursive: true });
    const mk = (id: string, parentId: string | null, body: string) => ({
      type: "custom_message",
      id,
      parentId,
      customType: "channel-inbound",
      content: body,
      details: { body },
    });
    const asst = (id: string, parentId: string) => ({
      type: "message",
      id,
      parentId,
      message: { role: "assistant", content: [{ type: "text", text: "ok" }] },
    });
    fs.writeFileSync(
      sess,
      `${[
        { type: "session", version: 3, id: "s1", timestamp: "t", cwd: tmp },
        mk("T1", null, "q1"),
        asst("A1", "T1"),
      ]
        .map((l) => JSON.stringify(l))
        .join("\n")}\n`,
    );
    const before = fs.readFileSync(sess, "utf8");

    await handleInbound(pi, inbound("/undo 0", "m1"), ctx);
    await tick();
    await handleInbound(pi, inbound("/undo abc", "m2"), ctx);
    await tick();
    expect(
      channelPosts().filter((t) =>
        t.includes("[!] usage: /undo [N] (N is 1 or more)"),
      ),
    ).toHaveLength(2);
    expect(isCompacting("ch1")).toBe(false); // no op window opened
    expect(fs.readFileSync(sess, "utf8")).toBe(before); // session untouched
    expect(shutdowns).toBe(0);
  });

  test("/undo 99 (N > chain length): one [!] line, no restart", async () => {
    const sessDir = path.join(
      home,
      ".pi",
      "agent",
      "sessions",
      `-${String(tmp).replace(/\//g, "-")}-`,
    );
    const sess = path.join(sessDir, "s.jsonl");
    fs.mkdirSync(sessDir, { recursive: true });
    const mk = (id: string, parentId: string | null, body: string) => ({
      type: "custom_message",
      id,
      parentId,
      customType: "channel-inbound",
      content: body,
      details: { body },
    });
    const asst = (id: string, parentId: string) => ({
      type: "message",
      id,
      parentId,
      message: { role: "assistant", content: [{ type: "text", text: "ok" }] },
    });
    fs.writeFileSync(
      sess,
      `${[
        { type: "session", version: 3, id: "s1", timestamp: "t", cwd: tmp },
        mk("T1", null, "q1"),
        asst("A1", "T1"),
      ]
        .map((l) => JSON.stringify(l))
        .join("\n")}\n`,
    );
    const before = fs.readFileSync(sess, "utf8");

    await handleInbound(pi, inbound("/undo 99", "m1"), ctx);
    await tick();
    expect(
      channelPosts().some((t) =>
        t.includes("nothing to undo: only 1 turn back"),
      ),
    ).toBe(true);
    expect(isCompacting("ch1")).toBe(false);
    expect(fs.readFileSync(sess, "utf8")).toBe(before);
    expect(shutdowns).toBe(0);
  });

  test("/undo 2: ONE restart-class op reverts both turns (issue #46)", async () => {
    const sessDir = path.join(
      home,
      ".pi",
      "agent",
      "sessions",
      `-${String(tmp).replace(/\//g, "-")}-`,
    );
    const sess = path.join(sessDir, "s.jsonl");
    fs.mkdirSync(sessDir, { recursive: true });
    const mk = (id: string, parentId: string | null, body: string) => ({
      type: "custom_message",
      id,
      parentId,
      customType: "channel-inbound",
      content: body,
      details: { body },
    });
    const asst = (id: string, parentId: string) => ({
      type: "message",
      id,
      parentId,
      message: { role: "assistant", content: [{ type: "text", text: "ok" }] },
    });
    const lines = [
      { type: "session", version: 3, id: "s1", timestamp: "t", cwd: tmp },
      mk("T1", null, "q1"),
      asst("A1", "T1"),
      mk("T2", "A1", "q2"),
      asst("A2", "T2"),
      mk("T3", "A2", "q3"),
      asst("A3", "T3"),
    ];
    fs.writeFileSync(
      sess,
      `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`,
    );

    await handleInbound(pi, inbound("/undo 2", "m1"), ctx);
    await tick();
    // the restart-class op is armed (block + tick), same as /reset
    expect(channelPosts().some((t) => t.includes("[..] undoing..."))).toBe(
      true,
    );
    expect(isCompacting("ch1")).toBe(true);
    expect(opWindowLabel("ch1")).toBe("undoing");
    // BOTH turns are cut in ONE pass: session is at pre-2nd-turn state
    const ids = fs
      .readFileSync(sess, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l).id);
    expect(ids).toEqual(["s1", "T1", "A1", "T2"]);

    await waitOpShutdown();
    expect(shutdowns).toBe(1); // ONE restart for two turns
    // the op marker carries the final ack the respawn settles
    const marker = JSON.parse(
      fs.readFileSync(path.join(tmp, ".tmp", "op-marker.json"), "utf8"),
    );
    expect(marker.op).toBe("undo");
    expect(marker.finalText).toContain(
      "undone: 2 turns + conversation (re-running q2)",
    );
  });

  test("/stop during an op CANCELS it: no shutdown, no systemd restart, session file kept", async () => {
    const sessDir = path.join(
      home,
      ".pi",
      "agent",
      "sessions",
      `-${String(tmp).replace(/\//g, "-")}-`,
    );
    fs.mkdirSync(sessDir, { recursive: true });
    const sess = path.join(sessDir, "s.jsonl");
    fs.writeFileSync(sess, "{}\n");
    let restartRequests = 0;
    setSystemdRestartHookForTest(() => {
      restartRequests++;
    });

    await handleInbound(pi, inbound("/reset", "m1"), ctx);
    await tick();
    setChannelCursor("ch1", "1200"); // an op-window inbound was delivered

    await handleInbound(pi, inbound("/stop", "m3"), ctx);
    await tick();
    expect(isCompacting("ch1")).toBe(false);
    expect(getChannelCursor("ch1")).toBe("1000"); // cursor restored
    expect(
      channelPosts().some((t) => t.includes("[-] stopped (restart cancelled)")),
    ).toBe(true);
    // the marker goes with the cancelled op — no stale settle on next boot
    expect(fs.existsSync(path.join(tmp, ".tmp", "op-marker.json"))).toBe(false);

    // The original op timer (armed at 300ms) must NOT fire the chain.
    await waitOpShutdown();
    expect(shutdowns).toBe(0); // no ctx.shutdown
    expect(restartRequests).toBe(0); // no systemd restart request
    expect(fs.existsSync(sess)).toBe(true); // session file NOT moved aside
    expect(fs.readdirSync(sessDir).some((f) => f.includes(".reset-"))).toBe(
      false,
    );
  });

  test("session_shutdown re-rewinds the op cursor: a gap inbound after the rewind cannot advance it", async () => {
    await handleInbound(pi, inbound("/reset", "m1"), ctx);
    await tick();
    await waitOpShutdown(); // chain ran: rewound to 1000 + persisted
    expect(getChannelCursor("ch1")).toBe("1000");

    // an inbound lands in the gap: after the op's rewind, before the
    // shutdown's disconnects
    setChannelCursor("ch1", "1200");
    expect(getChannelCursor("ch1")).toBe("1200");

    await handlers.session_shutdown?.();
    // re-rewound (in-memory + persisted) — the respawn replays 1000..1200
    expect(getChannelCursor("ch1")).toBe("1000");
    expect(loadPersistedCursors(path.join(tmp, ".tmp")).ch1).toBe("1000");
  });

  test("#84b: session_shutdown drains queued inbounds (acks deleted); held channel keeps its buffer", async () => {
    // Two channels in settings so configRoot resolves both for the REST
    // drain — rewrite BEFORE session_start loads the channel list.
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
            ack: true,
          },
          {
            id: "ch2",
            name: "Other",
            type: "discord",
            botToken: "tok2",
            ownerUserId: "uid",
            ack: true,
          },
        ],
      }),
    );
    await handlers.session_start?.(null, ctx); // configRoot for channel REST

    // ch1 (non-held): two queued inbounds + their acks — the orphan path
    const m2 = inbound("hello", "m2");
    queueMidTurnInbound(
      "ch1",
      m2,
      "ctx\n\nhello",
      "discord/Test",
      "hello",
      false,
    );
    queuedAcks.set("m2", { ackId: "ack1", fromId: "uid", pos: 1 });
    const m2b = inbound("again", "m2b");
    queueMidTurnInbound(
      "ch1",
      m2b,
      "ctx\n\nagain",
      "discord/Test",
      "again",
      false,
    );
    queuedAcks.set("m2b", { ackId: "ack1b", fromId: "uid", pos: 2 });

    // ch2 (held): the operator's buffer — must NOT be drained (A4 parity,
    // /stop + /reset #84 L2)
    const m3: ChannelMessage = {
      ...inbound("keep", "m3"),
      channelId: "ch2",
      channelName: "Other",
    };
    queueMidTurnInbound(
      "ch2",
      m3,
      "ctx\n\nkeep",
      "discord/Other",
      "keep",
      false,
    );
    queuedAcks.set("m3", { ackId: "ack2", fromId: "uid", pos: 1 });
    heldChannels.add("ch2");

    await handlers.session_shutdown?.(); // awaits its REST deletes

    // DELETE only: the drain's renumber also PATCHes the surviving acks,
    // so a DELETE|PATCH check would pass even if a delete never fired.
    const deleted = (ackId: string) =>
      fetchCalls.some(
        (c) => c.method === "DELETE" && c.url.includes(`/messages/${ackId}`),
      );
    expect(deleted("ack1")).toBe(true); // non-held: ack deleted, no orphan
    expect(deleted("ack1b")).toBe(true); // every queued ack in the line
    expect(deleted("ack2")).toBe(false); // held: buffer kept, ack untouched
    expect(midTurnQueues.get("ch1")).toBeUndefined(); // drained
    expect(queuedAcks.has("m2")).toBe(false);
    expect(queuedAcks.has("m2b")).toBe(false);
  });

  test("#84: shutdown while a run is in flight morphs the working frame to a terminal state (no frozen 'working' box)", async () => {
    verboseOverride.set("ch1", 2);
    await handlers.session_start?.(null, ctx); // configRoot for channel REST
    await handleInbound(pi, inbound("work", "m1"), ctx);
    ctx.isIdle = () => false; // the run is in flight
    await handlers.turn_start(null, ctx); // posts the working frame (out1)
    await handlers.tool_call(
      { toolName: "bash", input: { command: "ls" } },
      ctx,
    );
    expect(edits().some((t) => t.includes("working · 1 call"))).toBe(true);

    await handlers.session_shutdown?.(); // process dies while the run lives

    // terminal morph in place (agent_end never fires on a dying process)
    expect(edits().some((t) => t.includes("┌ stopped · 1 call"))).toBe(true);
    const deleted = (id: string) =>
      fetchCalls.some(
        (c) => c.method === "DELETE" && c.url.includes(`/messages/${id}`),
      );
    expect(deleted("out1")).toBe(false); // calls > 0: morph, not delete
  });

  test("#84: shutdown on a 0-call verbose-2 run deletes the working frame (same rule as agent_end)", async () => {
    verboseOverride.set("ch1", 2);
    await handlers.session_start?.(null, ctx);
    await handleInbound(pi, inbound("work", "m1"), ctx);
    ctx.isIdle = () => false;
    await handlers.turn_start(null, ctx); // posts "working · 0 calls · 0s"
    expect(channelPosts().some((t) => t.includes("┌ working · 0 calls"))).toBe(
      true,
    );

    await handlers.session_shutdown?.();

    // agent_end deletes 0-call frames (a leftover box is noise) — shutdown must
    const deleted = (id: string) =>
      fetchCalls.some(
        (c) => c.method === "DELETE" && c.url.includes(`/messages/${id}`),
      );
    expect(deleted("out1")).toBe(true);
  });

  test("#84: shutdown after a clean run end leaves the terminal 'done' frame untouched", async () => {
    verboseOverride.set("ch1", 2);
    await handlers.session_start?.(null, ctx);
    await handleInbound(pi, inbound("work", "m1"), ctx);
    ctx.isIdle = () => false;
    await handlers.turn_start(null, ctx);
    await handlers.tool_call(
      { toolName: "bash", input: { command: "ls" } },
      ctx,
    );
    const finMsg = {
      role: "assistant",
      content: [{ type: "text", text: "done answer" }],
    };
    await handlers.agent_end({ messages: [finMsg] }, ctx); // morphs to done
    expect(edits().filter((t) => t.includes("┌ done · 1 call")).length).toBe(1);

    await handlers.session_shutdown?.(); // runOpen is false: no second morph

    expect(edits().some((t) => t.includes("stopped"))).toBe(false);
    expect(edits().filter((t) => t.includes("┌ done · 1 call")).length).toBe(1);
    const deleted = (id: string) =>
      fetchCalls.some(
        (c) => c.method === "DELETE" && c.url.includes(`/messages/${id}`),
      );
    expect(deleted("out1")).toBe(false);
  });

  test("#84: shutdown consumes the in-flight interrupt's ack line (entry spliced out of the queue)", async () => {
    jest.useFakeTimers();
    await handlers.session_start?.(null, ctx); // configRoot for channel REST
    ctx.isIdle = () => false; // a run is in flight
    const m2 = inbound("hello", "m2");
    queueMidTurnInbound(
      "ch1",
      m2,
      "ctx\n\nhello",
      "discord/Test",
      "hello",
      false,
    );
    queuedAcks.set("m2", { ackId: "ack1", fromId: "uid", pos: 1 });

    const p = runMidRunInterrupt(pi, ctx, "ch1", "m2");
    jest.advanceTimersByTime(1000); // abort fired, entry spliced, settle running

    await handlers.session_shutdown?.();

    // the "[..] interrupting… Ns" line IS the queued ack — it must go,
    // even though the drain cannot see the spliced entry
    const deleted = (id: string) =>
      fetchCalls.some(
        (c) => c.method === "DELETE" && c.url.includes(`/messages/${id}`),
      );
    expect(deleted("ack1")).toBe(true);

    // let the interrupt settle after the shutdown (no throw, no re-arm)
    ctx.isIdle = () => true;
    jest.advanceTimersByTime(50);
    await p;
  });

  test("#84: shutdown deletes the SPEC B live-text ephemeral (agent_end's delete never runs)", async () => {
    verboseOverride.set("ch1", 1); // level 1: a reads-only run posts NO frame
    await handlers.session_start?.(null, ctx);
    await handleInbound(pi, inbound("hello", "m1"), ctx);
    ctx.isIdle = () => false;
    await handlers.turn_start(null, ctx);
    // non-final step message (text + pending tool call) -> live text
    await handlers.message_end(
      {
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "let me check" },
            { type: "toolCall", toolName: "read", arguments: {} },
          ],
        },
      },
      ctx,
    );
    // the first (non-essential) tool call posts the live-text message
    await handlers.tool_call(
      { toolName: "read", input: { path: "a.txt" } },
      ctx,
    );
    const livePosted = channelPosts().some((t) => t === "let me check");
    expect(livePosted).toBe(true);
    // no working frame exists for this run
    expect(channelPosts().some((t) => t.includes("┌ working"))).toBe(false);

    await handlers.session_shutdown?.();

    const deleted = (id: string) =>
      fetchCalls.some(
        (c) => c.method === "DELETE" && c.url.includes(`/messages/${id}`),
      );
    expect(deleted("out1")).toBe(true);
  });

  test("#84: shutdown settles an open compact window's ticking line (no marker to settle it)", async () => {
    await handlers.session_start?.(null, ctx);
    await handleInbound(pi, inbound("/compact", "m1"), ctx);
    await tick(); // placeholder post landed, tick armed (out1)
    expect(channelPosts().some((t) => t.includes("[..] compacting..."))).toBe(
      true,
    );

    await handlers.session_shutdown?.(); // process dies mid-compact

    const settled = fetchCalls.some(
      (c) =>
        c.method === "PATCH" &&
        c.url.includes("/messages/out1") &&
        String(c.body).includes("compact interrupted"),
    );
    expect(settled).toBe(true);
  });

  test("second /reset while an op window is open is rejected; /compact sees the active op; /status shows the op label", async () => {
    await handleInbound(pi, inbound("/reset", "m1"), ctx);
    await tick();
    await handleInbound(pi, inbound("/reset", "m4"), ctx);
    await tick();
    expect(
      channelPosts().filter((t) => t.includes("already restarting")).length,
    ).toBe(1);
    // F5: /compact while resetting names the ACTIVE op, not itself
    await handleInbound(pi, inbound("/compact", "m4b"), ctx);
    await tick();
    expect(
      channelPosts().filter((t) => t.includes("already restarting")).length,
    ).toBe(2);

    await handleInbound(pi, inbound("/status", "m5"), ctx);
    await tick();
    expect(channelPosts().some((t) => t.includes("resetting"))).toBe(true);
    await waitOpShutdown();
  });

  test("mid-run interrupt ticks the [queued] ack in place", async () => {
    jest.useFakeTimers();
    await handlers.session_start?.(null, ctx); // configRoot for channel REST
    ctx.isIdle = () => false;
    const m2 = inbound("hello", "m2");
    queueMidTurnInbound("ch1", m2, "ctx\n\nhello", "discord/Test", "hello");
    queuedAcks.set("m2", { ackId: "ack1", fromId: "uid", pos: 1 });

    const ackEdits = () =>
      fetchCalls
        .filter((c) => c.method === "PATCH" && c.url.includes("/messages/ack1"))
        .map(
          (c) =>
            (typeof c.body === "string" ? JSON.parse(c.body) : c.body).content,
        );

    let done = false;
    const p = runMidRunInterrupt(pi, ctx, "ch1", "m2").then(() => {
      done = true;
    });
    // abort fired, settle-wait running, tick armed on the queued ack
    // (one-line op status = prose, bare tick per v4 §2.3)
    jest.advanceTimersByTime(5000);
    expect(ackEdits()).toEqual(["[..] interrupting… 5s"]);

    ctx.isIdle = () => true;
    jest.advanceTimersByTime(50);
    await p;
    expect(done).toBe(true);
    // the queued text went through to pi
    expect(sent.some((s) => s.m.customType === "channel-inbound")).toBe(true);
    // tick stopped in finally -> no further edits
    const n = ackEdits().length;
    jest.advanceTimersByTime(10000);
    expect(ackEdits().length).toBe(n);
  });

  test("#28: /restart asks systemd for the env-configured unit, not hardcoded pi.service", async () => {
    const got: string[] = [];
    setSystemdRestartHookForTest((u) => {
      got.push(u);
    });
    process.env.PI_SERVICE = "banky-pi.service";
    try {
      await handleInbound(pi, inbound("/restart", "m1"), ctx);
      await tick();
      await waitOpShutdown();
    } finally {
      delete process.env.PI_SERVICE;
    }
    expect(got[0]).toBe("banky-pi.service");
  });

  test("#28: /restart asks systemd for the settings-configured unit (systemdUnit)", async () => {
    // beforeEach wrote tmp/.pi/settings.json with only channels — add the unit
    const s = path.join(tmp, ".pi", "settings.json");
    const cfg = JSON.parse(fs.readFileSync(s, "utf-8"));
    cfg.systemdUnit = "banky-pi.service";
    fs.writeFileSync(s, JSON.stringify(cfg));
    const got: string[] = [];
    setSystemdRestartHookForTest((u) => {
      got.push(u);
    });
    await handleInbound(pi, inbound("/restart", "m1"), ctx);
    await tick();
    await waitOpShutdown();
    expect(got[0]).toBe("banky-pi.service");
  });

  test("#28 partial: no respawn after ~15s -> watchdog closes the window, drains the queue, posts the RESOLVED unit", async () => {
    verboseOverride.set("ch1", 1); // verbose 1: the [queued] ack posts
    jest.useFakeTimers();
    const got: string[] = [];
    // restart hook that never settles: the unit never respawns
    setSystemdRestartHookForTest((u) => {
      got.push(u);
    });
    // F7 (PR2): capture the delayed self-exit instead of killing the
    // test runner (installed BEFORE the watchdog fires)
    const exits: number[] = [];
    setProcessExitHookForTest((c) => exits.push(c));
    const flush = async (n: number) => {
      for (let i = 0; i < n; i++) await Promise.resolve();
    };

    await handleInbound(pi, inbound("/restart", "m1"), ctx);
    await flush(10);
    expect(channelPosts().some((t) => t.includes("[..] restarting..."))).toBe(
      true,
    );

    // an inbound lands during the op -> queued behind the window
    await handleInbound(pi, inbound("hello", "m2"), ctx);
    await flush(10);
    expect(channelPosts().some((t) => t.includes("[queued] 1 in line"))).toBe(
      true,
    );

    // op shutdown chain at +300ms: restart requested, watchdog armed
    jest.advanceTimersByTime(300);
    await flush(30);
    expect(shutdowns).toBe(1);
    expect(got).toEqual(["pi.service"]); // resolved name

    // 14.9s later: the failure is not yet declared
    jest.advanceTimersByTime(14_999);
    expect(isCompacting("ch1")).toBe(true);
    expect(channelPosts().some((t) => t.includes("restart failed"))).toBe(
      false,
    );

    // ~15s: watchdog fires — process still alive, same window entry open
    jest.advanceTimersByTime(2);
    await flush(10);
    // The watchdog SYNCHRONOUSLY closed the window, deleted the op marker,
    // and posted the RESOLVED unit (the fetch mock records the post when
    // invoked). The re-waked inbound is in flight but parked on REAL
    // async hops (fs I/O): under fake timers its completion only arrives
    // if it happens to ride a 0ms fake timer, which is load/cold-cache
    // sensitive and flaked (issue #63: fresh-HOME runs fail
    // `expect(drained).toBeDefined()` ~1 in 4). So settle every
    // fake-timer assertion here first, then switch to REAL timers and let
    // the re-wake's fs I/O complete on the real event loop — the same
    // pattern the compaction fallback-timer test above uses.
    expect(isCompacting("ch1")).toBe(false); // op window closed
    expect(
      channelPosts().some((t) =>
        t.includes("restart failed - check unit pi.service"),
      ),
    ).toBe(true); // RESOLVED unit name in the channel
    // no stale marker left to settle some future boot
    expect(fs.existsSync(path.join(tmp, ".tmp", "op-marker.json"))).toBe(false);
    // F7 (PR2): the failed restart KILLS the process (delayed 500ms,
    // after the post lands) so systemd Restart=always actually respawns
    // 'pi -c' — a live process leaves the unit "active" forever.
    // The 500ms nudge trips only the exit: the next armed op tick is 5s
    // out.
    expect(exits).toEqual([]);
    jest.advanceTimersByTime(500);
    await flush(10);
    expect(exits).toEqual([1]);
    // Real timers: bounded poll of real event-loop turns until the
    // parked readFile completes and the message reaches pi.
    jest.useRealTimers();
    for (let i = 0; i < 200; i++) {
      if (
        sent.some(
          (s) =>
            s.m.customType === "channel-inbound" &&
            s.m.details?.body?.includes("hello"),
        )
      )
        break;
      await tick();
    }
    // queued inbound drained through pi (replay, not re-queue)
    const drained = sent.find(
      (s) =>
        s.m.customType === "channel-inbound" &&
        s.m.details?.body?.includes("hello"),
    );
    expect(drained).toBeDefined();
    expect(midTurnQueues.get("ch1")?.length ?? 0).toBe(0);
  });
});

describe("#28: systemd unit resolution (restart command)", () => {
  test("buildRestartCommand embeds the resolved unit, not a hardcoded one", () => {
    expect(buildRestartCommand("pi.service")).toBe(
      "sleep 3; systemctl --user restart pi.service",
    );
    expect(buildRestartCommand("banky-pi.service")).toBe(
      "sleep 3; systemctl --user restart banky-pi.service",
    );
  });

  test("resolveSystemdUnit defaults to pi.service", () => {
    const old = process.env.PI_SERVICE;
    delete process.env.PI_SERVICE;
    try {
      expect(resolveSystemdUnit("/nonexistent-cwd-x")).toBe("pi.service");
    } finally {
      if (old !== undefined) process.env.PI_SERVICE = old;
    }
  });

  test("env PI_SERVICE beats settings.json systemdUnit", () => {
    const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), "unit-test-"));
    fs.mkdirSync(path.join(tmpdir, ".pi"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpdir, ".pi", "settings.json"),
      JSON.stringify({ systemdUnit: "from-settings.service" }),
    );
    process.env.PI_SERVICE = "from-env.service";
    try {
      expect(resolveSystemdUnit(tmpdir)).toBe("from-env.service");
    } finally {
      delete process.env.PI_SERVICE;
      fs.rmSync(tmpdir, { recursive: true, force: true });
    }
  });

  test("settings.json systemdUnit is honoured when env is unset", () => {
    const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), "unit-test-"));
    fs.mkdirSync(path.join(tmpdir, ".pi"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpdir, ".pi", "settings.json"),
      JSON.stringify({ systemdUnit: "from-settings.service" }),
    );
    const old = process.env.PI_SERVICE;
    delete process.env.PI_SERVICE;
    try {
      expect(resolveSystemdUnit(tmpdir)).toBe("from-settings.service");
    } finally {
      if (old !== undefined) process.env.PI_SERVICE = old;
      fs.rmSync(tmpdir, { recursive: true, force: true });
    }
  });
});

// ─── moveSessionFileAside (F5) ──────────────────────────────────────────────

describe("moveSessionFileAside (F5)", () => {
  let tmp = "";
  let oldHome = "";
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "handover-move-"));
    oldHome = process.env.HOME || "";
    process.env.HOME = tmp;
  });
  afterEach(() => {
    process.env.HOME = oldHome;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const mkSession = (name: string, ageMs: number): string => {
    const dir = path.join(tmp, ".pi", "agent", "sessions", "profile");
    fs.mkdirSync(dir, { recursive: true });
    const f = path.join(dir, name);
    fs.writeFileSync(f, "{}");
    const t = Date.now() - ageMs;
    fs.utimesSync(f, t / 1000, t / 1000);
    return f;
  };

  test("explicit target is moved even when another file is newer", () => {
    const live = mkSession("live.jsonl", 60_000); // older
    const other = mkSession("newer.jsonl", 1_000); // newer mtime
    const ctx: any = {
      cwd: tmp,
      sessionManager: { getSessionFile: () => live },
    };
    moveSessionFileAside(ctx, live);
    expect(fs.existsSync(live)).toBe(false);
    expect(
      fs
        .readdirSync(path.dirname(live))
        .some((f) => f.startsWith("live.jsonl.reset-")),
    ).toBe(true);
    expect(fs.existsSync(other)).toBe(true); // the mtime trap is avoided
  });
  test("explicit target missing → mtime fallback picks the newest", () => {
    const old = mkSession("old.jsonl", 60_000);
    const newer = mkSession("newer.jsonl", 1_000);
    const ctx: any = {
      cwd: tmp,
      sessionManager: { getSessionFile: () => path.join(tmp, "gone.jsonl") },
    };
    moveSessionFileAside(ctx);
    expect(fs.existsSync(newer)).toBe(false);
    expect(fs.existsSync(old)).toBe(true);
  });
  test("no sessionManager at all → mtime fallback still works", () => {
    const newer = mkSession("newer.jsonl", 1_000);
    moveSessionFileAside({ cwd: tmp } as any);
    expect(fs.existsSync(newer)).toBe(false);
  });
});
