import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  clearDiscordStatesForTest,
  loadPersistedCursors,
  pollDiscord,
  setChannelCursor,
} from "./discord";
import extension, {
  CHANNEL_MSG_TYPE,
  clearAllCompacting,
  clearAllInterrupts,
  handleInbound,
  heldChannels,
  interruptStepTimeoutMs,
  isHeld,
  pendingAttachments,
  pendingInterrupts,
  resetRuntimeStateForTest,
  setHeld,
  setInterruptCtx,
  setRuntimeStateDir,
  verboseOverride,
} from "./index";
import { stopAllOpTicks } from "./live";
import {
  clearQueuedInbound,
  deleteQueuedInbound,
  extractQueueSuffix,
  midTurnQueues,
  popOldestQueuedInbound,
  queuedAcks,
  queueMidTurnInbound,
  updateQueuedInbound,
} from "./queue";
import { setSystemdRestartHookForTest } from "./restart-ops";
import { loadRewakeQueue, rewakeAddPending } from "./restart-queue";
import type { ChannelMessage } from "./types";

describe("extractQueueSuffix", () => {
  test("dot + space + queue at end", () => {
    expect(extractQueueSuffix("fix the bug. queue")).toEqual({
      prompt: "fix the bug",
      forceQueue: true,
    });
  });

  test("no space: '.queue'", () => {
    expect(extractQueueSuffix("fix the bug.queue")).toEqual({
      prompt: "fix the bug",
      forceQueue: true,
    });
  });

  test("punctuation run: '... queue'", () => {
    expect(extractQueueSuffix("fix the bug... queue")).toEqual({
      prompt: "fix the bug",
      forceQueue: true,
    });
  });

  test("trailing spaces are fine", () => {
    expect(extractQueueSuffix("fix the bug. queue   ")).toEqual({
      prompt: "fix the bug",
      forceQueue: true,
    });
  });

  test("other sentence punctuation: ! ; :", () => {
    for (const p of ["!", ";", ":"]) {
      expect(extractQueueSuffix(`fix the bug${p} queue`)).toEqual({
        prompt: "fix the bug",
        forceQueue: true,
      });
    }
  });

  test("optional trailing period after queue", () => {
    expect(extractQueueSuffix("fix the bug. queue.")).toEqual({
      prompt: "fix the bug",
      forceQueue: true,
    });
  });

  test("case-insensitive", () => {
    expect(extractQueueSuffix("fix the bug. QUEUE")).toEqual({
      prompt: "fix the bug",
      forceQueue: true,
    });
  });

  test("suffixed-only message strips to empty", () => {
    expect(extractQueueSuffix(". queue")).toEqual({
      prompt: "",
      forceQueue: true,
    });
  });

  test("mid-sentence 'queue' does NOT match", () => {
    expect(extractQueueSuffix("put it in the queue")).toEqual({
      prompt: "put it in the queue",
      forceQueue: false,
    });
  });

  test("'queue' alone does NOT match (no punctuation)", () => {
    expect(extractQueueSuffix("queue")).toEqual({
      prompt: "queue",
      forceQueue: false,
    });
  });

  test("comma before queue does NOT match (list, ambiguous)", () => {
    expect(extractQueueSuffix("buy eggs, queue")).toEqual({
      prompt: "buy eggs, queue",
      forceQueue: false,
    });
  });

  test("similar words do NOT match", () => {
    expect(extractQueueSuffix("do this. queued")).toEqual({
      prompt: "do this. queued",
      forceQueue: false,
    });
    expect(extractQueueSuffix("do this. queueing")).toEqual({
      prompt: "do this. queueing",
      forceQueue: false,
    });
  });

  test("queue in the middle, other text after", () => {
    expect(extractQueueSuffix(". queue it up")).toEqual({
      prompt: ". queue it up",
      forceQueue: false,
    });
  });

  test("no suffix: unchanged", () => {
    expect(extractQueueSuffix("fix the bug please")).toEqual({
      prompt: "fix the bug please",
      forceQueue: false,
    });
  });
});

// The queue-control block below shared its outer harness with the
// "extension handlers (A1/A2/A4)" describe in index.test.ts (pi/ctx/
// inbound/fetch mocks + settings); the harness is duplicated verbatim
// here — the block is otherwise byte-identical to its pre-move form
// (moved 2026-10-19, god-file split 2/5). The re-wake-marker block
// (#231 P3, further down) carries its own harness and moved as-is.

describe("queue control (harness shared with extension handlers A1/A2/A4)", () => {
  let tmp = "";
  let pi: any;
  let ctx: any;
  let handlers: Record<string, (...a: any[]) => any> = {};
  let sent: { m: any; o?: any }[] = [];
  let fetchCalls: { url: string; method: string; body?: any }[] = [];
  // sequential message ids: the working frame is out1, a later live-text
  // post (SPEC B) gets out2, so id-based assertions stay unambiguous
  let msgN = 0;
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

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "piscord-test-"));
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
    midTurnQueues.clear();
    pendingAttachments.clear();
    verboseOverride.clear();
    fetchCalls = [];
    msgN = 0;
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
    };
    globalThis.fetch = (async (url: any, init?: any) => {
      fetchCalls.push({
        url: String(url),
        method: init?.method ?? "GET",
        body: init?.body,
      });
      let id = "out1";
      if (
        init?.method === "POST" &&
        String(url).endsWith("/channels/ch1/messages")
      )
        id = `out${++msgN}`;
      return {
        ok: true,
        status: 200,
        json: async () => ({ id }),
        text: async () => "",
      };
    }) as any;
  });

  afterEach(async () => {
    clearDiscordStatesForTest(); // no auto-react suppression leaks across tests
    jest.useRealTimers();
    // Drop leftover re-wake state BEFORE the cleanup agent_end, or it would
    // start an in-flight re-wake whose sendToPi continuation leaks into the
    // next test's mock pi (shared `sent` binding).
    midTurnQueues.clear();
    pendingAttachments.clear();
    clearAllInterrupts(); // armed interrupt timers + in-flight flags
    setInterruptCtx(null);
    await handlers.agent_end?.({ messages: [] }, ctx); // clears any typing interval
    globalThis.fetch = realFetch;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  describe("queue control (. queue suffix, edit, delete)", () => {
    let abortCount: number;
    let idle: boolean;
    const flush = async () => {
      for (let i = 0; i < 20; i++) await Promise.resolve();
    };

    beforeEach(() => {
      abortCount = 0;
      idle = false;
      ctx.isIdle = () => idle;
      ctx.abort = () => {
        abortCount += 1;
        idle = true;
      };
      setInterruptCtx(ctx);
    });

    afterEach(() => {
      clearDiscordStatesForTest(); // no auto-react suppression leaks across tests
      setInterruptCtx(null);
      clearAllInterrupts();
      pendingInterrupts.clear();
      queuedAcks.clear();
      jest.useRealTimers();
    });

    test("queued ack shows the position in line (and suppresses the 👀)", async () => {
      verboseOverride.set("ch1", 1); // verbose 1: the [queued] ack posts
      ctx.isIdle = () => false;
      await handleInbound(pi, inbound("first", "m1"), ctx);
      await flush();
      expect(midTurnQueues.get("ch1")?.length).toBe(1);
      const ack1 = fetchCalls.find(
        (c) =>
          c.method === "POST" &&
          String(JSON.parse(c.body).content).includes("[queued] 1 in line"),
      );
      expect(ack1).toBeDefined();
      expect(JSON.parse(ack1!.body).message_reference?.message_id).toBe("m1");

      await handleInbound(pi, inbound("second", "m2"), ctx);
      await flush();
      expect(midTurnQueues.get("ch1")?.length).toBe(2);
      const ack2 = fetchCalls.find(
        (c) =>
          c.method === "POST" &&
          String(JSON.parse(c.body).content).includes("[queued] 2 in line"),
      );
      expect(ack2).toBeDefined();

      // The [queued] line IS the ack: no 👀 reaction on the queued message.
      const react = fetchCalls.find(
        (c) => c.method === "PUT" && c.url.includes("/messages/m1/reactions/"),
      );
      expect(react).toBeUndefined();
    });

    test("#231 P2: [bg: inbound mid-run queues silently (no [queued] post)", async () => {
      ctx.isIdle = () => false; // a run is in flight
      await handleInbound(
        pi,
        inbound("[bg:worker:OK] 20261017-000000-1 · test task", "m1"),
        ctx,
      );
      await flush();
      // queued for the re-wake exactly as a human message is…
      expect(midTurnQueues.get("ch1")?.length).toBe(1);
      // …but no "[queued] N in line" post (no human waits in line).
      expect(
        fetchCalls.find(
          (c) =>
            c.method === "POST" &&
            String(JSON.parse(c.body).content).includes("[queued]"),
        ),
      ).toBeUndefined();
      // the entry still re-wakes at agent_end (queue semantics unchanged)
      idle = true;
      await handlers.agent_end({ messages: [] }, ctx);
      expect(sent.length).toBe(1);
      expect(sent[0].m.details.messageId).toBe("m1");
      expect(midTurnQueues.has("ch1")).toBe(false);
    });

    test("#231 P2: human inbound mid-run still posts the [queued] line", async () => {
      verboseOverride.set("ch1", 1); // verbose 1: the [queued] ack posts
      ctx.isIdle = () => false;
      await handleInbound(pi, inbound("hello", "m1"), ctx);
      await flush();
      expect(midTurnQueues.get("ch1")?.length).toBe(1);
      const ack = fetchCalls.find(
        (c) =>
          c.method === "POST" &&
          String(JSON.parse(c.body).content).includes("[queued] 1 in line"),
      );
      expect(ack).toBeDefined();
    });

    test("'. queue' parks in the re-wake queue and does NOT arm the interrupt", async () => {
      verboseOverride.set("ch1", 1); // verbose 1: the [queued] ack posts
      jest.useFakeTimers();
      idle = false;
      await handleInbound(pi, inbound("later. queue", "m1"), ctx);
      await flush();
      expect(midTurnQueues.get("ch1")?.length).toBe(1);
      expect(pendingInterrupts.has("ch1")).toBe(false);
      // The ack still shows the position.
      const ack = fetchCalls.find(
        (c) =>
          c.method === "POST" &&
          String(JSON.parse(c.body).content).includes("[queued] 1 in line"),
      );
      expect(ack).toBeDefined();
      jest.advanceTimersByTime(interruptStepTimeoutMs() + 1000);
      expect(abortCount).toBe(0);
      expect(sent.length).toBe(0);
      jest.useRealTimers();

      // The run ends → re-wake delivers the SUFFIX-STRIPPED text.
      idle = true;
      await handlers.agent_end({ messages: [] }, ctx);
      expect(sent.length).toBe(1);
      expect(sent[0].m.details.body).toBe("later");
      expect(sent[0].m.content).not.toContain(". queue");
      expect(midTurnQueues.has("ch1")).toBe(false);
    });

    test("plain message still arms the interrupt (unchanged behavior)", async () => {
      jest.useFakeTimers();
      idle = false;
      await handleInbound(pi, inbound("plain", "m1"), ctx);
      await flush();
      expect(midTurnQueues.get("ch1")?.length).toBe(1);
      expect(pendingInterrupts.get("ch1")?.length).toBe(1);
      jest.advanceTimersByTime(interruptStepTimeoutMs());
      expect(abortCount).toBe(1);
      expect(sent.length).toBe(1);
      expect(sent[0].m.details.body).toBe("plain");
      // Consumed entry's ack is dropped with it.
      expect(queuedAcks.has("m1")).toBe(false);
      jest.useRealTimers();
    });

    test("mid-sentence 'queue' is NOT treated as the suffix", async () => {
      verboseOverride.set("ch1", 1); // verbose 1: the [queued] ack posts
      ctx.isIdle = () => false;
      await handleInbound(pi, inbound("put it in the queue", "m1"), ctx);
      await flush();
      expect(midTurnQueues.get("ch1")?.length).toBe(1);
      // No suffix → interrupt armed...
      expect(pendingInterrupts.get("ch1")?.length).toBe(1);
      // ...and the queued ack still shows the position.
      const ack = fetchCalls.find(
        (c) =>
          c.method === "POST" &&
          String(JSON.parse(c.body).content).includes("[queued] 1 in line"),
      );
      expect(ack).toBeDefined();
    });

    test("edit re-renders the queued entry (interrupt delivers the new text)", async () => {
      jest.useFakeTimers();
      idle = false;
      await handleInbound(pi, inbound("original text", "m1"), ctx);
      await flush();
      expect(
        await updateQueuedInbound(ctx, "ch1", "m1", "edited text", [], "uid"),
      ).toBe(true);
      const entry = midTurnQueues.get("ch1")?.[0];
      expect(entry?.msg.body).toBe("edited text");
      expect(entry?.text).toContain("edited text");

      jest.advanceTimersByTime(interruptStepTimeoutMs());
      expect(abortCount).toBe(1);
      expect(sent.length).toBe(1);
      expect(sent[0].m.content).toContain("edited text");
      expect(sent[0].m.content).not.toContain("original text");
      expect(sent[0].m.details.messageId).toBe("m1");
      jest.useRealTimers();
    });

    test("edit of a non-queued message is a no-op", async () => {
      expect(
        await updateQueuedInbound(ctx, "ch1", "nope", "x", [], "uid"),
      ).toBe(false);
    });

    test("edit is owner-only", async () => {
      fs.writeFileSync(
        path.join(tmp, ".pi", "settings.json"),
        JSON.stringify({
          channels: [
            {
              id: "ch1",
              name: "Test",
              type: "discord",
              botToken: "tok1",
              ownerUserId: "owner1",
            },
          ],
        }),
      );
      ctx.isIdle = () => false;
      await handleInbound(pi, inbound("orig", "m1"), ctx);
      await flush();
      expect(
        await updateQueuedInbound(ctx, "ch1", "m1", "nope", [], "uid"),
      ).toBe(false);
      expect(midTurnQueues.get("ch1")?.[0].msg.body).toBe("orig");
      expect(
        await updateQueuedInbound(ctx, "ch1", "m1", "yes", [], "owner1"),
      ).toBe(true);
      expect(midTurnQueues.get("ch1")?.[0].msg.body).toBe("yes");
    });

    test("delete drops the entry (other channels untouched) and disarms it", async () => {
      ctx.isIdle = () => false;
      await handleInbound(pi, inbound("first", "m1"), ctx);
      await flush();
      const m2: ChannelMessage = {
        ...inbound("other channel", "cm2"),
        channelId: "ch2",
        channelName: "Other",
      };
      queueMidTurnInbound("ch2", m2, "ctx\n\ntext", "discord/Other", "text");
      expect(midTurnQueues.get("ch1")?.length).toBe(1);
      expect(midTurnQueues.get("ch2")?.length).toBe(1);
      expect(pendingInterrupts.get("ch1")?.length).toBe(1);
      expect(pendingInterrupts.get("ch2")?.length).toBe(1);

      await deleteQueuedInbound(ctx, "ch1", "m1");
      expect(midTurnQueues.has("ch1")).toBe(false);
      expect(pendingInterrupts.has("ch1")).toBe(false);
      // ch2's entry + armed interrupt survive.
      expect(midTurnQueues.get("ch2")?.length).toBe(1);
      expect(pendingInterrupts.get("ch2")?.length).toBe(1);
      // Deleting an unknown message is a no-op.
      await deleteQueuedInbound(ctx, "ch1", "ghost");
      expect(midTurnQueues.has("ch1")).toBe(false);
    });

    test("delete cleans up the ack and renumbers the remaining line", async () => {
      verboseOverride.set("ch1", 1); // verbose 1: the [queued] ack posts
      await handlers.session_start?.(null, ctx); // configRoot for ack REST
      ctx.isIdle = () => false;
      await handleInbound(pi, inbound("first", "m1"), ctx);
      await handleInbound(pi, inbound("second", "m2"), ctx);
      await flush();
      expect(queuedAcks.get("m1")?.pos).toBe(1);
      expect(queuedAcks.get("m2")?.pos).toBe(2);

      await deleteQueuedInbound(ctx, "ch1", "m1");
      await flush();
      expect(queuedAcks.has("m1")).toBe(false);
      expect(queuedAcks.get("m2")?.pos).toBe(1);
      const del = fetchCalls.find(
        (c) =>
          c.method === "DELETE" && c.url.includes("/channels/ch1/messages/"),
      );
      expect(del).toBeDefined();
      const patch = fetchCalls.find(
        (c) =>
          c.method === "PATCH" &&
          String(JSON.parse(c.body).content).includes("[queued] 1 in line"),
      );
      expect(patch).toBeDefined();
    });

    test("delete is owner-only", async () => {
      verboseOverride.set("ch1", 1); // verbose 1: the [queued] ack posts
      fs.writeFileSync(
        path.join(tmp, ".pi", "settings.json"),
        JSON.stringify({
          channels: [
            {
              id: "ch1",
              name: "Test",
              type: "discord",
              botToken: "tok1",
              ownerUserId: "owner1",
            },
          ],
        }),
      );
      ctx.isIdle = () => false;
      await handleInbound(pi, inbound("first", "m1"), ctx);
      await flush();
      // m1's author is "uid" — not the owner → entry and ack survive.
      await deleteQueuedInbound(ctx, "ch1", "m1");
      expect(midTurnQueues.get("ch1")?.length).toBe(1);
      expect(queuedAcks.has("m1")).toBe(true);
    });

    test("consumed re-wake drops its ack and renumbers the rest", async () => {
      verboseOverride.set("ch1", 1); // verbose 1: the [queued] ack posts
      await handlers.session_start?.(null, ctx); // configRoot for ack REST
      ctx.isIdle = () => false;
      await handleInbound(pi, inbound("first", "m1"), ctx);
      await handleInbound(pi, inbound("second", "m2"), ctx);
      await flush();
      expect(queuedAcks.get("m2")?.pos).toBe(2);

      idle = true; // the run ends
      await handlers.agent_end({ messages: [] }, ctx);
      await flush();
      expect(sent.length).toBe(1);
      expect(sent[0].m.details.body).toBe("first");
      expect(queuedAcks.has("m1")).toBe(false);
      expect(queuedAcks.get("m2")?.pos).toBe(1);
      const del = fetchCalls.find(
        (c) =>
          c.method === "DELETE" && c.url.includes("/channels/ch1/messages/"),
      );
      expect(del).toBeDefined();
    });
  });
});

describe("re-wake in-turn consumed marker (#231 P3)", () => {
  let tmp = "";
  let oldHome = "";
  const stateDir = () => path.join(tmp, ".pi-dispatch-state");
  const markerDir = () => path.join(tmp, ".pi-dispatch", "in-turn-consumed");
  const writeMarker = (id: string) => {
    fs.mkdirSync(markerDir(), { recursive: true });
    fs.writeFileSync(path.join(markerDir(), id), "");
  };
  const base = {
    channelId: "ch1",
    channelName: "Test",
    channelType: "discord" as const,
    timestamp: new Date().toISOString(),
    attachments: [],
    isRoom: false,
  };
  const bgInbound = (id: string): ChannelMessage => ({
    ...base,
    messageId: id,
    from: "pi-bg",
    fromId: "wa-1",
    body: `[bg:worker:OK] 20261017-000000-1 · task ${id}`,
  });
  const humanInbound = (id: string): ChannelMessage => ({
    ...base,
    messageId: id,
    from: "u",
    fromId: "uid",
    body: `human text ${id}`,
  });

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "itc-test-"));
    oldHome = process.env.HOME || "";
    process.env.HOME = tmp; // hasInTurnConsumedMarker resolves $HOME live
    setRuntimeStateDir(stateDir());
    midTurnQueues.clear();
    queuedAcks.clear();
    heldChannels.clear();
  });

  afterEach(() => {
    process.env.HOME = oldHome;
    setRuntimeStateDir(null);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test("queued [bg: entry WITH a consumed marker is dropped, next entry popped", () => {
    queueMidTurnInbound("ch1", bgInbound("111"), "t", "discord/Test", "t");
    queueMidTurnInbound("ch1", bgInbound("222"), "t", "discord/Test", "t");
    // jarate-wait consumed the OLDEST in turn; the other keeps its wake
    writeMarker("111");
    const popped = popOldestQueuedInbound();
    expect(popped?.msg.messageId).toBe("222");
    // the consumed copy is gone from memory AND the survival file…
    expect(midTurnQueues.has("ch1")).toBe(false);
    const file = loadRewakeQueue(stateDir(), "ch1");
    // …the popped copy (222) stays pending — it commits via sendToPi on
    // delivery; the dropped copy (111) is committed as delivered
    expect(file.pending.map((p) => p.msg.messageId)).toEqual(["222"]);
    expect(file.delivered).toContain("111");
  });

  test("queued [bg: entry WITHOUT a marker is delivered (timeout path)", () => {
    queueMidTurnInbound("ch1", bgInbound("111"), "t", "discord/Test", "t");
    const popped = popOldestQueuedInbound();
    expect(popped?.msg.messageId).toBe("111");
    expect(midTurnQueues.has("ch1")).toBe(false);
  });

  test("human entry with a marker file for its id is still delivered", () => {
    queueMidTurnInbound(
      "ch1",
      humanInbound("333"),
      "t",
      "discord/Test",
      "t",
      false,
    );
    writeMarker("333"); // the marker only gates [bg: wakes
    const popped = popOldestQueuedInbound();
    expect(popped?.msg.messageId).toBe("333");
  });
});

// #180: queued inbounds survive a process restart.
//
// The re-wake queue is in-memory and session_shutdown drains it on EVERY
// death, while the Discord cursor already advanced past the queued inbound
// at receipt — so a respawn never re-fetches it (2026-10-06 incident:
// pi-bg callback msg 1556883632919150653 queued 04:19:44, process
// restarted 04:19:52, callback never consumed).
//
//   option 2 (primary): the queued entry is mirrored into a per-channel
//     state file at queue time, pruned on commit/drop; session_shutdown
//     keeps draining memory (fast path) but keeps the file (survival
//     path); a real process start (reason "startup") drains the file back
//     into the queue and the normal agent_end re-wake delivers it.
//   option 1 (backstop): the same startup does one bounded history scan
//     (before=<cursor>) re-queueing undelivered [bg:/pi-bg webhook posts.
//
// These tests model REAL process boundaries: fresh pi + fresh handlers,
// clearDiscordStatesForTest between "processes", persisted state files
// (cursor + rewake) are the only thing that crosses the boundary.
// ─────────────────────────────────────────────────────────────────────────
describe("restart-queue survival (#180): incident-shape e2e", () => {
  let tmp = "";
  let oldHome = "";
  const realFetch = globalThis.fetch;
  let script: {
    polls: any[][];
    scan: any[];
    calls: { url: string; method: string }[];
  };

  const rewakeDir = () => path.join(tmp, ".tmp");

  const inbound = (body: string, id: string): ChannelMessage => ({
    channelId: "ch1",
    channelName: "Test",
    channelType: "discord",
    messageId: id,
    from: "Beepy",
    fromId: "uid",
    body,
    timestamp: new Date().toISOString(),
    attachments: [],
    isRoom: false,
  });

  /** Raw REST [bg: webhook post (the pi-bg callback shape). */
  const bgRaw = (id: string) => ({
    id,
    webhook_id: "7000",
    content: `[bg:worker:OK] ${id}`,
    timestamp: new Date().toISOString(),
    author: { id: "7000", bot: true, username: "beepy" },
  });
  /** Raw REST restart-wake post (the bridge's own wake). */
  const wakeRaw = (id: string) => ({
    id,
    webhook_id: "7000",
    content: "[bg: restart-wake] clean",
    timestamp: new Date().toISOString(),
    author: { id: "7000", bot: true, username: "beepy" },
  });

  /** One fake pi "process": fresh handler table + fresh send capture. */
  const mkProcess = () => {
    const handlers: Record<string, (...a: any[]) => any> = {};
    const sent: { m: any; o?: any }[] = [];
    const pi: any = {
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
    return { pi, handlers, sent };
  };

  const mkCtx = (idle: boolean): any => ({
    cwd: tmp,
    ui: { setStatus: () => {} },
    isIdle: () => idle,
    hasPendingMessages: () => false,
    abort: () => {},
    compact: () => {},
    modelRegistry: { getAvailable: () => [] },
    getContextUsage: () => undefined,
    model: { id: "cur", name: "Cur" },
    shutdown: () => {},
  });

  /** Flush microtasks + drive polls until pred() or timeout. */
  const waitFor = async (pred: () => boolean, ms = 2000) => {
    const t0 = Date.now();
    while (!pred()) {
      if (Date.now() - t0 > ms) throw new Error("waitFor: timeout");
      await new Promise((r) => setTimeout(r, 10));
      await pollDiscord("ch1");
    }
  };

  const customSends = (sent: { m: any }[]) =>
    sent.filter((s) => s.m?.customType === CHANNEL_MSG_TYPE);

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "issue180-"));
    oldHome = process.env.HOME || "";
    process.env.HOME = path.join(tmp, "home");
    fs.mkdirSync(path.join(tmp, ".pi"), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, ".pi", "settings.json"),
      JSON.stringify({
        channels: [
          {
            id: "ch1",
            name: "Test",
            type: "discord",
            enabled: true,
            channel: "111",
            botToken: "tok1",
            ownerUserId: "uid",
            ack: true,
          },
        ],
      }),
    );
    script = { polls: [[], [], []], scan: [], calls: [] };
    globalThis.fetch = (async (url: any, init?: any) => {
      const u = String(url);
      const method = init?.method ?? "GET";
      script.calls.push({ url: u, method });
      const json = (v: any) => ({
        ok: true,
        status: 200,
        json: async () => v,
        text: async () => JSON.stringify(v),
      });
      const notFound = () => ({
        ok: false,
        status: 204,
        json: async () => ({}),
        text: async () => "",
      });
      if (u.endsWith("/users/@me")) return json({ id: "9000" });
      if (method === "POST" && u.includes("/messages"))
        return json({ id: "w1" }); // wake + ack posts: fixed id
      if (u.includes("reactions")) return notFound();
      if (method === "DELETE") return notFound();
      if (u.includes("before=")) return json(script.scan); // #180 scan
      if (u.includes("after=")) return json(script.polls.shift() ?? []); // polls (FIFO)
      return json([]); // seed ?limit=1, guilds, dms, ...
    }) as any;
    setSystemdRestartHookForTest(() => {});
    setRuntimeStateDir(null);
  });

  afterEach(() => {
    clearDiscordStatesForTest();
    stopAllOpTicks();
    clearAllCompacting();
    clearAllInterrupts();
    resetRuntimeStateForTest();
    setInterruptCtx(null);
    setSystemdRestartHookForTest(null);
    for (const id of [...midTurnQueues.keys()])
      clearQueuedInbound(id, undefined, { keepFile: true });
    midTurnQueues.clear();
    queuedAcks.clear();
    pendingInterrupts.clear();
    heldChannels.clear();
    setRuntimeStateDir(null);
    process.env.HOME = oldHome;
    globalThis.fetch = realFetch;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test("incident: callback queued mid-run, clean restart -> delivered exactly once", async () => {
    // ── Process 1: the callback lands while a run is live → queued ──
    const p1 = mkProcess();
    const ctx1 = mkCtx(false); // a run is in flight
    await p1.handlers.session_start?.(null, ctx1);
    await waitFor(() => p1.handlers.agent_end !== undefined);
    setChannelCursor("ch1", "1000");
    await handleInbound(
      p1.pi,
      inbound("[bg:worker:OK] 2000", "2000"),
      ctx1,
      false,
    );
    // delivery advances the cursor PAST the queued inbound (the incident)
    setChannelCursor("ch1", "2000");
    expect(midTurnQueues.get("ch1")?.length).toBe(1);
    // option 2: the entry is mirrored into the state file at queue time
    expect(
      loadRewakeQueue(rewakeDir(), "ch1").pending.map((p) => p.msg.messageId),
    ).toEqual(["2000"]);

    // the process dies (clean stop)
    await p1.handlers.session_shutdown?.();
    // fast path: memory drained…
    expect(midTurnQueues.get("ch1")).toBeUndefined();
    // survival path: the file is intact
    expect(
      loadRewakeQueue(rewakeDir(), "ch1").pending.map((p) => p.msg.messageId),
    ).toEqual(["2000"]);
    // (live state is dropped by the disconnects — assert the persisted file)
    expect(loadPersistedCursors(rewakeDir())["111"]).toBe("2000");

    // ── Process 2: respawn (reason "startup") ──
    clearDiscordStatesForTest();
    const p2 = mkProcess();
    const ctx2 = mkCtx(true); // idle
    script.polls = [[wakeRaw("w1")], [wakeRaw("w1")], [], []];
    script.scan = [];
    await p2.handlers.session_start?.({ reason: "startup" }, ctx2);
    // survival drain re-queued the callback before anything else ran
    expect(midTurnQueues.get("ch1")?.length).toBe(1);
    // the wake post comes in via the poll → direct send (idle)
    await waitFor(() =>
      customSends(p2.sent).some((s) =>
        String(s.m.details?.body ?? "").includes("[bg: restart-wake]"),
      ),
    );
    // the wake run ends → re-wake delivers the survived callback
    await p2.handlers.agent_end?.({ type: "agent_end", messages: [] }, ctx2);
    const delivered = customSends(p2.sent).filter((s) =>
      String(s.m.details?.body ?? "").includes("[bg:worker:OK] 2000"),
    );
    expect(delivered).toHaveLength(1); // exactly once
    // commit: pending pruned, id recorded for the scan dedupe
    const f2 = loadRewakeQueue(rewakeDir(), "ch1");
    expect(f2.pending).toEqual([]);
    expect(f2.delivered).toContain("2000");

    // ── Process 3: restart AGAIN (crash after delivery) ──
    clearDiscordStatesForTest();
    const p3 = mkProcess();
    const ctx3 = mkCtx(true);
    // the original callback post is STILL in history below the cursor —
    // the scan must NOT re-queue it (delivered set dedupe)
    script.polls = [[], [], []];
    script.scan = [bgRaw("2000")];
    await p3.handlers.session_start?.({ reason: "startup" }, ctx3);
    await new Promise((r) => setTimeout(r, 150));
    await pollDiscord("ch1");
    expect(customSends(p3.sent)).toHaveLength(0); // no wake (lock), no re-run
    expect(
      loadRewakeQueue(rewakeDir(), "ch1").pending.map((p) => p.msg.messageId),
    ).toEqual([]);
  });

  test("empty restart: no queued inbounds -> no rewake state file, no scan fetch", async () => {
    const p1 = mkProcess();
    const ctx1 = mkCtx(false);
    await p1.handlers.session_start?.(null, ctx1);
    await waitFor(() => p1.handlers.agent_end !== undefined);
    await p1.handlers.session_shutdown?.();
    const rewakeFile = path.join(rewakeDir(), "rewake-ch1.json");
    expect(fs.existsSync(rewakeFile)).toBe(false); // nothing was ever queued

    const p2 = mkProcess();
    const ctx2 = mkCtx(true);
    await p2.handlers.session_start?.({ reason: "startup" }, ctx2);
    await new Promise((r) => setTimeout(r, 150));
    await pollDiscord("ch1");
    expect(fs.existsSync(rewakeFile)).toBe(false); // drain+scan wrote nothing
    // no cursor was ever persisted → the scan issues no REST call at all
    expect(script.calls.some((c) => c.url.includes("before="))).toBe(false);
    expect(customSends(p2.sent)).toHaveLength(0);
  });

  test("option 1 backstop: cursor advanced, queue file lost → history scan re-queues", async () => {
    const p1 = mkProcess();
    const ctx1 = mkCtx(false);
    await p1.handlers.session_start?.(null, ctx1);
    await waitFor(() => p1.handlers.agent_end !== undefined);
    setChannelCursor("ch1", "1000");
    await handleInbound(
      p1.pi,
      inbound("[bg:worker:OK] 2000", "2000"),
      ctx1,
      false,
    );
    setChannelCursor("ch1", "2000");
    // a later (human) receipt advances the cursor past the callback —
    // the scan window (before=<cursor>) now contains it; human posts
    // are never scan candidates, so only the machine wake is re-queued
    setChannelCursor("ch1", "2001");
    fs.rmSync(path.join(rewakeDir(), "rewake-ch1.json"), { force: true });
    await p1.handlers.session_shutdown?.();
    expect(midTurnQueues.get("ch1")).toBeUndefined();

    const p2 = mkProcess();
    const ctx2 = mkCtx(true);
    // the post is in history below the cursor — the scan finds it
    script.polls = [[wakeRaw("w1")], [wakeRaw("w1")], [], []];
    script.scan = [bgRaw("2000")];
    await p2.handlers.session_start?.({ reason: "startup" }, ctx2);
    await waitFor(() =>
      customSends(p2.sent).some((s) =>
        String(s.m.details?.body ?? "").includes("[bg: restart-wake]"),
      ),
    );
    await p2.handlers.agent_end?.({ type: "agent_end", messages: [] }, ctx2);
    expect(
      customSends(p2.sent).filter((s) =>
        String(s.m.details?.body ?? "").includes("[bg:worker:OK] 2000"),
      ),
    ).toHaveLength(1); // delivered via the scan-re-queued entry
    const f2 = loadRewakeQueue(rewakeDir(), "ch1");
    expect(f2.pending).toEqual([]);
    expect(f2.delivered).toContain("2000");
  });

  test("in-process /new//reload (reason != startup) clears the file, not just memory", async () => {
    const p1 = mkProcess();
    const ctx1 = mkCtx(false);
    await p1.handlers.session_start?.(null, ctx1);
    await waitFor(() => p1.handlers.agent_end !== undefined);
    setChannelCursor("ch1", "1000");
    await handleInbound(
      p1.pi,
      inbound("[bg:worker:OK] 2000", "2000"),
      ctx1,
      false,
    );
    await p1.handlers.session_shutdown?.(); // memory drained, file kept
    expect(
      loadRewakeQueue(rewakeDir(), "ch1").pending.map((p) => p.msg.messageId),
    ).toEqual(["2000"]);

    // in-process session restart (the /new and /reload path)
    clearDiscordStatesForTest();
    const p2 = mkProcess();
    const ctx2 = mkCtx(true);
    await p2.handlers.session_start?.({ reason: "reload" }, ctx2);
    await new Promise((r) => setTimeout(r, 50));
    // the /new-dropped queue must not resurrect on the next real restart
    expect(loadRewakeQueue(rewakeDir(), "ch1").pending).toEqual([]);
    expect(midTurnQueues.get("ch1")).toBeUndefined();
  });

  test("held channel: the buffer survives the restart (drained back into the held queue)", async () => {
    const p1 = mkProcess();
    const ctx1 = mkCtx(false);
    await p1.handlers.session_start?.(null, ctx1);
    await waitFor(() => p1.handlers.agent_end !== undefined);
    setChannelCursor("ch1", "1000");
    setHeld("ch1", true);
    await handleInbound(
      p1.pi,
      inbound("[bg:worker:OK] 2000", "2000"),
      ctx1,
      false,
    );
    setChannelCursor("ch1", "2000");
    await p1.handlers.session_shutdown?.();
    expect(midTurnQueues.get("ch1")).toBeUndefined(); // memory wiped
    // held channels skip the shutdown drain loop — file was never pruned
    expect(
      loadRewakeQueue(rewakeDir(), "ch1").pending.map((p) => p.msg.messageId),
    ).toEqual(["2000"]);

    clearDiscordStatesForTest();
    const p2 = mkProcess();
    const ctx2 = mkCtx(true);
    script.polls = [[], [], []];
    script.scan = [];
    await p2.handlers.session_start?.({ reason: "startup" }, ctx2);
    // the hold flag is persisted (channel-state.json) → re-held at start,
    // and the survived entry is back in the (held) channel's queue
    expect(isHeld({ id: "ch1", name: "Test", type: "discord" } as any)).toBe(
      true,
    );
    expect(midTurnQueues.get("ch1")?.length).toBe(1);
    expect(midTurnQueues.get("ch1")?.[0].msg.messageId).toBe("2000");
  });

  test("F1: op-window inbound after the drain + rewound cursor -> replay and survival drain deliver ONCE", async () => {
    // ── Process 1: restart-class op. The inbound lands AFTER the op
    // drained the queue but BEFORE process death (mirrored to the file,
    // cursor advances past it); the op rewinds the cursor to W.
    const p1 = mkProcess();
    const ctx1 = mkCtx(false); // a run is in flight
    await p1.handlers.session_start?.(null, ctx1);
    await waitFor(() => p1.handlers.agent_end !== undefined);
    setChannelCursor("ch1", "1000"); // W: pre-op cursor (rewind point)
    await handleInbound(
      p1.pi,
      inbound("[bg:worker:OK] 2000", "2000"),
      ctx1,
      false,
    );
    // receipt advances the cursor past the queued inbound
    setChannelCursor("ch1", "2000");
    expect(midTurnQueues.get("ch1")?.length).toBe(1);
    expect(
      loadRewakeQueue(rewakeDir(), "ch1").pending.map((p) => p.msg.messageId),
    ).toEqual(["2000"]);
    // the op rewinds the cursor to W before death (persisted)
    setChannelCursor("ch1", "1000");
    await p1.handlers.session_shutdown?.();
    // fast path: memory drained; survival path: file + rewound cursor
    expect(midTurnQueues.get("ch1")).toBeUndefined();
    expect(
      loadRewakeQueue(rewakeDir(), "ch1").pending.map((p) => p.msg.messageId),
    ).toEqual(["2000"]);
    expect(loadPersistedCursors(rewakeDir())["111"]).toBe("1000");

    // ── Process 2: respawn — the double-delivery window. The survival
    // drain re-queues 2000 from the file; the first poll (after=W)
    // replays the op window and delivers it directly. Its commit must
    // prune the drained IN-MEMORY copy too — not just the file copy.
    clearDiscordStatesForTest();
    const p2 = mkProcess();
    const ctx2 = mkCtx(true); // idle
    script.polls = [[bgRaw("2000")], [], []]; // first poll = the replay
    script.scan = [];
    await p2.handlers.session_start?.({ reason: "startup" }, ctx2);
    expect(midTurnQueues.get("ch1")?.length).toBe(1); // the drained copy
    await waitFor(() =>
      customSends(p2.sent).some((s) =>
        String(s.m.details?.body ?? "").includes("[bg:worker:OK] 2000"),
      ),
    );
    // the replay run ends -> the re-wake must NOT pop the drained copy
    await p2.handlers.agent_end?.({ type: "agent_end", messages: [] }, ctx2);
    const delivered = customSends(p2.sent).filter((s) =>
      String(s.m.details?.body ?? "").includes("[bg:worker:OK] 2000"),
    );
    expect(delivered).toHaveLength(1); // was 2 at 6753cec9 (replay + re-wake)
    expect(midTurnQueues.get("ch1")).toBeUndefined();
    const f2 = loadRewakeQueue(rewakeDir(), "ch1");
    expect(f2.pending).toEqual([]);
    expect(f2.delivered).toContain("2000");
  });

  test("F1 secondary: replay commits the id while the scan fetch is in flight -> exactly once (scan live-dedupes)", async () => {
    // Same op-window shape, plus the (fake) scan window contains the id:
    // a startup replay delivery that commits the id mid-scan-fetch must
    // not be re-queued by the scan (dedupe re-checked live at push time,
    // not only from the pre-fetch snapshot).
    const p1 = mkProcess();
    const ctx1 = mkCtx(false);
    await p1.handlers.session_start?.(null, ctx1);
    await waitFor(() => p1.handlers.agent_end !== undefined);
    setChannelCursor("ch1", "1000");
    await handleInbound(
      p1.pi,
      inbound("[bg:worker:OK] 2000", "2000"),
      ctx1,
      false,
    );
    setChannelCursor("ch1", "2000");
    setChannelCursor("ch1", "1000"); // op rewind, persisted
    await p1.handlers.session_shutdown?.();
    expect(
      loadRewakeQueue(rewakeDir(), "ch1").pending.map((p) => p.msg.messageId),
    ).toEqual(["2000"]);

    clearDiscordStatesForTest();
    const p2 = mkProcess();
    const ctx2 = mkCtx(true);
    script.polls = [[bgRaw("2000")], [], []]; // the replay delivers + commits
    script.scan = [bgRaw("2000")]; // the scan window also sees the id
    await p2.handlers.session_start?.({ reason: "startup" }, ctx2);
    expect(midTurnQueues.get("ch1")?.length).toBe(1); // the drained copy
    await waitFor(() =>
      customSends(p2.sent).some((s) =>
        String(s.m.details?.body ?? "").includes("[bg:worker:OK] 2000"),
      ),
    );
    // the scan fetch (in flight during the replay commit) has landed
    await new Promise((r) => setTimeout(r, 150));
    // the scan must not have re-queued the committed id
    expect(midTurnQueues.get("ch1")).toBeUndefined();
    expect(
      loadRewakeQueue(rewakeDir(), "ch1").pending.map((p) => p.msg.messageId),
    ).toEqual([]);
    await p2.handlers.agent_end?.({ type: "agent_end", messages: [] }, ctx2);
    expect(
      customSends(p2.sent).filter((s) =>
        String(s.m.details?.body ?? "").includes("[bg:worker:OK] 2000"),
      ),
    ).toHaveLength(1); // exactly once
  });

  test("F2: edit of a queued inbound rewrites the FILE copy — restart drains the edited msg", async () => {
    const p1 = mkProcess();
    const ctx1 = mkCtx(false); // a run is in flight
    await p1.handlers.session_start?.(null, ctx1);
    await waitFor(() => p1.handlers.agent_end !== undefined);
    setChannelCursor("ch1", "1000");
    await handleInbound(
      p1.pi,
      inbound("[bg:worker:OK] 2000", "2000"),
      ctx1,
      false,
    );
    setChannelCursor("ch1", "2000");
    expect(midTurnQueues.get("ch1")?.length).toBe(1);
    // the owner edits the queued message (MESSAGE_UPDATE route)
    expect(
      await updateQueuedInbound(
        ctx1,
        "ch1",
        "2000",
        "[bg:worker:OK] 2000 EDITED",
        [],
        "uid",
      ),
    ).toBe(true);
    // memory re-rendered AND the file copy rewritten (F2)
    expect(midTurnQueues.get("ch1")?.[0].msg.body).toBe(
      "[bg:worker:OK] 2000 EDITED",
    );
    expect(loadRewakeQueue(rewakeDir(), "ch1").pending[0].msg.body).toBe(
      "[bg:worker:OK] 2000 EDITED",
    );
    await p1.handlers.session_shutdown?.();
    // the file kept the EDITED msg across the restart boundary
    expect(loadRewakeQueue(rewakeDir(), "ch1").pending[0].msg.body).toBe(
      "[bg:worker:OK] 2000 EDITED",
    );

    clearDiscordStatesForTest();
    const p2 = mkProcess();
    const ctx2 = mkCtx(true);
    script.polls = [[], [], []];
    script.scan = [];
    await p2.handlers.session_start?.({ reason: "startup" }, ctx2);
    // the survival drain re-queues the EDITED body, not the stale one
    expect(midTurnQueues.get("ch1")?.[0].msg.body).toBe(
      "[bg:worker:OK] 2000 EDITED",
    );
  });

  test("crash with a live [queued] line: ack id survives in the file, restored + deleted exactly once", async () => {
    verboseOverride.set("ch1", 1); // verbose 1: the [queued] ack posts
    // ── Process 1: a HUMAN inbound queued mid-run; its [queued] ack
    // POST resolves (fake id "w1") and its id is mirrored into the
    // file. (#231 P2: [bg: inbounds queue silently — no ack line — so
    // the line-survival contract is exercised on the human entry; the
    // [bg: entry joins in the ack-less shape below.)
    const p1 = mkProcess();
    const ctx1 = mkCtx(false);
    await p1.handlers.session_start?.(null, ctx1);
    await waitFor(() => p1.handlers.agent_end !== undefined);
    setChannelCursor("ch1", "1000");
    await handleInbound(p1.pi, inbound("fix the thing", "2000"), ctx1, false);
    setChannelCursor("ch1", "2000");
    await waitFor(
      () =>
        queuedAcks.get("2000")?.ackId === "w1" &&
        loadRewakeQueue(rewakeDir(), "ch1").pending[0]?.ackId === "w1",
    );
    // an ACK-LESS [bg: entry (the #231 P2 shape, and any pre-fix
    // writer: no ackId key on disk) joins the file — it must still
    // load and drain
    rewakeAddPending(rewakeDir(), "ch1", {
      msg: inbound("[bg:worker:OK] 3000", "3000"),
      queuedAt: Date.now(),
    });
    const raw = JSON.parse(
      fs.readFileSync(path.join(rewakeDir(), "rewake-ch1.json"), "utf8"),
    ) as { pending: Array<Record<string, unknown>> };
    expect(raw.pending[0].ackId).toBe("w1");
    expect(raw.pending[1].ackId).toBeUndefined(); // no line on disk

    // ── CRASH: no session_shutdown. Memory (incl. the ack map) dies
    // with the process, the ack line stays in Discord, the file
    // survives — the only thing crossing the boundary
    clearDiscordStatesForTest();
    const p2 = mkProcess();
    const ctx2 = mkCtx(true);
    queuedAcks.clear(); // fresh process: the map is empty
    midTurnQueues.clear(); // module state a real respawn never carries
    script.polls = [[wakeRaw("w1")], [wakeRaw("w1")], [], []];
    script.scan = [];
    await p2.handlers.session_start?.({ reason: "startup" }, ctx2);
    // the survival drain re-queued BOTH entries (ack-less loads)…
    expect(midTurnQueues.get("ch1")?.length).toBe(2);
    // …and restored ONLY the entry whose ack survived, at its line
    // position — the [bg: entry has no (nonexistent) line
    expect(queuedAcks.get("2000")?.ackId).toBe("w1");
    expect(queuedAcks.get("2000")?.pos).toBe(1);
    expect(queuedAcks.has("3000")).toBe(false);

    // the wake run ends -> the re-wake pop delivers the survived
    // inbound and consumes the restored ack
    await waitFor(() =>
      customSends(p2.sent).some((s) =>
        String(s.m.details?.body ?? "").includes("[bg: restart-wake]"),
      ),
    );
    await p2.handlers.agent_end?.({ type: "agent_end", messages: [] }, ctx2);
    const delivered = customSends(p2.sent).filter((s) =>
      String(s.m.details?.body ?? "").includes("fix the thing"),
    );
    expect(delivered).toHaveLength(1);
    // the kept [queued] line is deleted EXACTLY ONCE: the crash left
    // it live (no shutdown fast path), the restored id is consumed —
    // no orphan, no double delete
    expect(
      script.calls.filter(
        (c) => c.method === "DELETE" && c.url.endsWith("/messages/w1"),
      ),
    ).toHaveLength(1);
    expect(queuedAcks.get("2000")).toBeUndefined();
    // the [bg: entry is still queued (no line to delete) and the
    // delivered set now holds the committed id
    const f2 = loadRewakeQueue(rewakeDir(), "ch1");
    expect(f2.pending.map((p) => p.msg.messageId)).toEqual(["3000"]);
    expect(f2.delivered).toContain("2000");
  });
});
