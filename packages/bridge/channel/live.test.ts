// channel/live.ts tests — moved verbatim from index.test.ts
// (god-file split 3/5, 2026-10-19). All blocks are self-contained
// (own harness); no shared index.test.ts state.
import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { clearDiscordStatesForTest } from "./discord";
import { styleGuard } from "./format";
import extension, {
  clearAllCompacting,
  clearAllInterrupts,
  handleInbound,
  heldChannels,
  pendingAttachments,
  resetRuntimeStateForTest,
  runMidRunInterrupt,
  setInterruptCtx,
  setRuntimeStateDir,
  verboseOverride,
} from "./index";
import {
  earlySendText,
  LIVE_TEXT_PLACEHOLDER,
  LIVE_TEXT_THROTTLE_MS,
  persistLivePlaceholders,
  readLivePlaceholders,
  simulateProcessDeathForTest,
  stopAllCompactTicks,
  stopAllOpTicks,
  truncateLiveText,
} from "./live";
import { midTurnQueues, queuedAcks, queueMidTurnInbound } from "./queue";
import type { ChannelMessage } from "./types";

// Fleet-run gate (hall-monitor #35 gut): a dispatch agent running this
// suite inherits PI_SESSION_ID=fleetwork-<ticket> from its run wrapper;
// the gate treats that as a fleet run and would skip all channel startup
// in every test. Clear it here (#273 review (C): replicate the
// index.test.ts guard in the split-off files).
delete process.env.PI_SESSION_ID;

/** F2 (test-fidelity audit): the interaction network contract — the ONLY
 *  (method, URL) pairs the bridge may send for one interaction:
 *   - callback (defer / plain reply): POST  /interactions/{id}/{token}/callback
 *   - edit the deferred message:       PATCH /webhooks/{app}/{token}/messages/@original
 *   - create followup:                POST  /webhooks/{app}/{token}  (webhook ROOT)
 *  The followup is the webhook ROOT: the incoming-webhook form
 *  /webhooks/{app}/{token}/messages is rejected 400 50035 (RCA 2026-10-08).
 *  Returns a violation string for any other call, null when allowed.
 *  The vault-block stub additionally allows the plain channel message
 *  routes (card post / card edit) via allowChannelMessages. */
const _interactionUrlViolation = (
  url: string,
  method: string,
  allowChannelMessages = false,
): string | null => {
  const u = String(url);
  const m = method ?? "GET";
  if (
    m === "POST" &&
    /^https:\/\/discord\.com\/api\/v10\/interactions\/[^/]+\/[^/]+\/callback$/.test(
      u,
    )
  )
    return null;
  if (
    m === "PATCH" &&
    /^https:\/\/discord\.com\/api\/v10\/webhooks\/[^/]+\/[^/]+\/messages\/@original$/.test(
      u,
    )
  )
    return null;
  if (
    m === "POST" &&
    /^https:\/\/discord\.com\/api\/v10\/webhooks\/[^/]+\/[^/]+$/.test(u)
  )
    return null;
  if (allowChannelMessages) {
    if (
      m === "POST" &&
      /^https:\/\/discord\.com\/api\/v10\/channels\/[^/]+\/messages$/.test(u)
    )
      return null;
    if (
      m === "PATCH" &&
      /^https:\/\/discord\.com\/api\/v10\/channels\/[^/]+\/messages\/[^/]+$/.test(
        u,
      )
    )
      return null;
  }
  return `${m} ${u}`;
};

describe("earlySendText", () => {
  const toolCall = { type: "toolCall", toolName: "bash", arguments: {} };

  test("intermediate assistant message (text + toolCall) returns the text", () => {
    const msg = {
      role: "assistant",
      content: [{ type: "text", text: "checking files" }, toolCall],
    };
    expect(earlySendText(msg)).toBe("checking files");
  });

  test("multiple text blocks are joined", () => {
    const msg = {
      role: "assistant",
      content: [
        { type: "text", text: "a " },
        { type: "text", text: "b" },
        toolCall,
      ],
    };
    expect(earlySendText(msg)).toBe("a b");
  });

  test("final (text only, no toolCall) returns null", () => {
    const msg = {
      role: "assistant",
      content: [{ type: "text", text: "done" }],
    };
    expect(earlySendText(msg)).toBeNull();
  });

  test("no text blocks returns null", () => {
    const msg = { role: "assistant", content: [toolCall] };
    expect(earlySendText(msg)).toBeNull();
  });

  test("non-assistant message returns null", () => {
    expect(
      earlySendText({
        role: "user",
        content: [{ type: "text", text: "hi" }, toolCall],
      }),
    ).toBeNull();
    expect(earlySendText(undefined)).toBeNull();
    expect(earlySendText(null)).toBeNull();
  });

  test("thinking tags are stripped from the result", () => {
    const msg = {
      role: "assistant",
      content: [
        {
          type: "text",
          text: "\u003cthink\u003epondering\u003c/think\u003eabout to read the file",
        },
        toolCall,
      ],
    };
    expect(earlySendText(msg)).toBe("about to read the file");
  });

  test("whitespace-only text returns null", () => {
    const msg = {
      role: "assistant",
      content: [{ type: "text", text: "  \n " }, toolCall],
    };
    expect(earlySendText(msg)).toBeNull();
  });
});

describe("live intermediate text (SPEC B)", () => {
  let tmp = "";
  let pi: any;
  let ctx: any;
  let handlers: Record<string, (...a: any[]) => any> = {};
  let fetchCalls: { url: string; method: string; body?: any }[] = [];
  /** message content -> sequential id (out1, out2, ...) in post order. */
  let posted: { content: string; id: string }[] = [];
  let msgN = 0;
  const realFetch = globalThis.fetch;
  const OWNER = "1000000000000000001";

  const inbound = (body: string, id: string): ChannelMessage => ({
    channelId: "ch1",
    channelName: "Test",
    channelType: "discord",
    messageId: id,
    from: "u",
    fromId: OWNER,
    body,
    timestamp: new Date().toISOString(),
    attachments: [],
    isRoom: false,
  });
  const posts = () =>
    fetchCalls
      .filter(
        (c) => c.method === "POST" && c.url.endsWith("/channels/ch1/messages"),
      )
      .map((c) => String(JSON.parse(c.body).content));
  const patches = (id?: string) =>
    fetchCalls
      .filter(
        (c) =>
          c.method === "PATCH" &&
          (id
            ? c.url.includes(`/messages/${id}`)
            : c.url.includes("/messages/")),
      )
      .map((c) => String(JSON.parse(c.body).content));
  const deletes = (id: string) =>
    fetchCalls.filter(
      (c) => c.method === "DELETE" && c.url.includes(`/messages/${id}`),
    );
  const idOf = (content: string) =>
    posted.find((p) => p.content === content)?.id;
  /** assistant message with intermediate text + tool call (not a final). */
  const inter = (text: string) => ({
    role: "assistant",
    content: [
      { type: "text", text },
      { type: "toolCall", toolName: "bash", arguments: {} },
    ],
  });
  const fin = (t: string) => ({
    role: "assistant",
    content: [{ type: "text", text: t }],
  });
  const tc = (toolName: string, input: Record<string, unknown> = {}) =>
    handlers.tool_call({ toolName, input }, ctx);

  beforeEach(() => {
    jest.useFakeTimers();
    clearDiscordStatesForTest(); // #273 review (B): start each harness test with a clean shared idCache (post-split, bun schedules test files concurrently in one process)
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jarate-livetext-"));
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
            ack: true,
            ownerUserId: OWNER,
            forwardToolCalls: true, // level 2
          },
        ],
      }),
    );
    handlers = {};
    fetchCalls = [];
    posted = [];
    msgN = 0;
    midTurnQueues.clear();
    pendingAttachments.clear();
    verboseOverride.clear();
    heldChannels.clear();
    setRuntimeStateDir(null);
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
      ) {
        id = `out${++msgN}`;
        posted.push({
          content: String(JSON.parse(init.body).content),
          id,
        });
      }
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
    midTurnQueues.clear();
    pendingAttachments.clear();
    clearAllInterrupts();
    setInterruptCtx(null);
    setRuntimeStateDir(null);
    await handlers.agent_end?.({ messages: [] }, ctx);
    jest.useRealTimers();
    globalThis.fetch = realFetch;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test("post-on-first-tool: first tool call posts the live-text message below the working frame", async () => {
    await handleInbound(pi, inbound("hello", "m1"), ctx);
    await handlers.turn_start(null, ctx);
    await handlers.message_end(
      { message: inter("let me check the file") },
      ctx,
    );
    // nothing live-text posted yet: the post happens on the first tool call
    expect(idOf("let me check the file")).toBeUndefined();
    await tc("read", { path: "a.txt" });
    const tId = idOf("let me check the file");
    expect(tId).toBeDefined(); // live-text message carries the latest text
    // posted AFTER the working frame -> below it in the channel
    const frameIdx = posted.findIndex((p) => p.content.includes("┌ working"));
    const tIdx = posted.findIndex((p) => p.content === "let me check the file");
    expect(tIdx).toBeGreaterThan(frameIdx);
    // the intermediate text was NOT early-sent as a separate message
    expect(posts().filter((p) => p === "let me check the file")).toHaveLength(
      1,
    );
    // still in flight: not deleted
    expect(deletes(tId!)).toHaveLength(0);
  });

  test("post-on-first-text-after-tool: no placeholder, posted once real text arrives, edited in place", async () => {
    await handleInbound(pi, inbound("hello", "m1"), ctx);
    await handlers.turn_start(null, ctx);
    await tc("bash", { command: "ls" });
    // tool call with no text yet: no live-text message posted (only the
    // working frame from turn_start exists)
    expect(posted.some((p) => p.content === "now I will edit it")).toBe(false);
    // text arrives after the tool: posts the live message
    await handlers.message_end({ message: inter("now I will edit it") }, ctx);
    const tId = idOf("now I will edit it");
    expect(tId).toBeDefined();
    // later text: same message edited in place, no second post
    jest.advanceTimersByTime(LIVE_TEXT_THROTTLE_MS + 100);
    await handlers.message_end({ message: inter("second thought") }, ctx);
    expect(patches(tId)).toContain("second thought");
    expect(
      posted.filter((p) => p.content === "now I will edit it"),
    ).toHaveLength(1);
  });

  test("edit-with-intermediate-text: segments edit the SAME message in place", async () => {
    await handleInbound(pi, inbound("hello", "m1"), ctx);
    await handlers.turn_start(null, ctx);
    await handlers.message_end({ message: inter("step one text") }, ctx);
    await tc("read", { path: "a.txt" }); // posts live text with "step one text"
    const tId = idOf("step one text");
    expect(tId).toBeDefined();

    jest.advanceTimersByTime(LIVE_TEXT_THROTTLE_MS + 100);
    await handlers.message_end({ message: inter("step two text") }, ctx);
    expect(patches(tId)).toContain("step two text");

    // a later tool call re-checks the latest text: unchanged -> no extra edit
    const editsBefore = patches(tId).length;
    await tc("bash", { command: "git push" });
    expect(patches(tId).length).toBe(editsBefore);

    // one message total for both segments
    expect(
      posts().filter((p) => p === "step one text" || p === "step two text"),
    ).toHaveLength(1);
  });

  test("truncate-long-text: tail kept with ellipsis (unit + integration)", async () => {
    // unit
    expect(truncateLiveText("short")).toBe("short");
    expect(truncateLiveText("x".repeat(900))).toBe("x".repeat(900));
    expect(truncateLiveText("y".repeat(901))).toBe(`…${"y".repeat(900)}`);
    expect(truncateLiveText("abc", 2)).toBe(`…bc`);
    // integration: a 2000-char intermediate segment posts truncated
    await handleInbound(pi, inbound("hello", "m1"), ctx);
    await handlers.turn_start(null, ctx);
    await handlers.message_end({ message: inter("z".repeat(2000)) }, ctx);
    await tc("read", { path: "a.txt" });
    const truncated = `…${"z".repeat(900)}`;
    expect(posts()).toContain(truncated);
    expect(posted.find((p) => p.content === truncated)!.content.length).toBe(
      901,
    );
  });

  test("edit-throttle: edits closer than 1.5s are skipped; the next event after the window lands the latest text", async () => {
    await handleInbound(pi, inbound("hello", "m1"), ctx);
    await handlers.turn_start(null, ctx);
    await handlers.message_end({ message: inter("text one") }, ctx);
    await tc("read", { path: "a.txt" }); // posts live text with "text one"
    const tId = idOf("text one");
    expect(tId).toBeDefined();

    // within the throttle window: skipped (message_end and tool_call)
    await handlers.message_end({ message: inter("text two") }, ctx);
    expect(patches(tId)).toHaveLength(0);
    await tc("bash", { command: "ls" });
    expect(patches(tId)).toHaveLength(0);

    // after the window: the LATEST text lands on the same message
    jest.advanceTimersByTime(LIVE_TEXT_THROTTLE_MS + 100);
    await tc("bash", { command: "git push" });
    expect(patches(tId)).toEqual(["text two"]);
    // and no second post
    expect(posts().filter((p) => p === "text two")).toHaveLength(0);
  });

  test("delete-on-final: final via message_end deletes the live-text message", async () => {
    await handleInbound(pi, inbound("hello", "m1"), ctx);
    await handlers.turn_start(null, ctx);
    await handlers.message_end({ message: inter("working text") }, ctx);
    await tc("read", { path: "a.txt" });
    const tId = idOf("working text");
    expect(tId).toBeDefined();

    await handlers.message_end({ message: fin("all done") }, ctx);
    expect(deletes(tId!)).toHaveLength(1); // ephemeral message gone
    const finalPost = posted.find((p) => p.content === "all done");
    expect(finalPost).toBeDefined(); // the final still lands, as its own message
    expect(finalPost!.id).not.toBe(tId);
  });

  test("delete-on-final: a final collected at agent_end also deletes the message", async () => {
    await handleInbound(pi, inbound("hello", "m1"), ctx);
    await handlers.turn_start(null, ctx);
    await handlers.message_end({ message: inter("working text") }, ctx);
    await tc("read", { path: "a.txt" });
    const tId = idOf("working text");
    // no message_end for the final: it is collected at agent_end
    await handlers.agent_end({ messages: [fin("all done")] }, ctx);
    expect(deletes(tId!)).toHaveLength(1);
    expect(posts()).toContain("all done");
  });

  test("delete-on-error: a failed run deletes the live-text message and still posts the error", async () => {
    await handleInbound(pi, inbound("hello", "m1"), ctx);
    await handlers.turn_start(null, ctx);
    await handlers.message_end({ message: inter("working text") }, ctx);
    await tc("read", { path: "a.txt" });
    const tId = idOf("working text");
    const failure = {
      role: "assistant",
      content: [{ type: "text", text: "" }],
      stopReason: "error",
      errorMessage: "boom",
    };
    await handlers.agent_end({ messages: [failure] }, ctx);
    expect(deletes(tId!)).toHaveLength(1);
    expect(posts().some((p) => p === styleGuard("boom"))).toBe(true);
  });

  test("no-tools-no-status: zero tool calls -> no live-text message at all", async () => {
    await handleInbound(pi, inbound("hello", "m1"), ctx);
    await handlers.turn_start(null, ctx);
    await handlers.message_end({ message: fin("hi there") }, ctx);
    await handlers.agent_end({ messages: [] }, ctx);
    // no placeholder, no intermediate post
    expect(posts()).not.toContain(LIVE_TEXT_PLACEHOLDER);
    // no edits of any kind (a live-text message would PATCH)
    expect(patches()).toHaveLength(0);
    // the only working-frame traffic: the 0-call placeholder, deleted at
    // run end
    const wf = posted.find((p) => p.content.includes("┌ working"));
    expect(wf).toBeDefined();
    expect(deletes(wf!.id)).toHaveLength(1);
    // the final landed directly
    expect(posts()).toContain("hi there");
  });

  test("level 0: live text posts on the first tool call, edits in place, deletes on the step-final (2026-10-19)", async () => {
    verboseOverride.set("ch1", 0);
    await handleInbound(pi, inbound("hello", "m1"), ctx);
    await handlers.turn_start(null, ctx);
    await handlers.message_end({ message: inter("working text") }, ctx);
    // NOT early-sent as a standalone message: it waits in the live-text
    // slot for the post gate (the first tool call)
    expect(posts()).not.toContain("working text");
    await tc("read", { path: "a.txt" });
    // the tool call posts the ONE ephemeral live-text message
    const tId = idOf("working text");
    expect(tId).toBeDefined();
    // level 0: no tool frame, no placeholder
    expect(posts().some((p) => p.includes("┌ working"))).toBe(false);
    expect(posts()).not.toContain(LIVE_TEXT_PLACEHOLDER);
    // a second intermediate text edits the SAME message in place
    jest.advanceTimersByTime(LIVE_TEXT_THROTTLE_MS + 100);
    await handlers.message_end({ message: inter("second thought") }, ctx);
    expect(patches(tId!)).toContain("second thought");
    expect(posted.filter((p) => p.content === "working text")).toHaveLength(1);
    // the step-final deletes the ephemeral message and posts as its own
    await handlers.message_end({ message: fin("done") }, ctx);
    expect(deletes(tId!)).toHaveLength(1);
    expect(posts()).toContain("done");
  });

  test("verbose on->off mid-run deletes the live-text message", async () => {
    await handleInbound(pi, inbound("hello", "m1"), ctx);
    await handlers.turn_start(null, ctx);
    await handlers.message_end({ message: inter("working text") }, ctx);
    await tc("read", { path: "a.txt" });
    const tId = idOf("working text");
    expect(tId).toBeDefined();

    await handleInbound(pi, inbound("/verbose off", "m2"), ctx);
    expect(deletes(tId!)).toHaveLength(1); // live-text goes with the block

    // next tool call at level 0: no re-arm, no traffic
    fetchCalls.length = 0;
    posted.length = 0;
    await tc("bash", { command: "ls" });
    expect(posts()).toHaveLength(0);
    expect(patches()).toHaveLength(0);
  });
});

describe("#84: placeholder settlement (all exit paths)", () => {
  let tmp = "";
  let pi: any;
  let ctx: any;
  let handlers: Record<string, (...a: any[]) => any> = {};
  let sent: { m: any; o?: any }[] = [];
  let fetchCalls: { url: string; method: string; body?: any }[] = [];
  let msgN = 0;
  const realFetch = globalThis.fetch;

  const CH1 = {
    id: "ch1",
    name: "Test",
    type: "discord",
    botToken: "tok1",
    ownerUserId: "uid",
    ack: true,
  };
  const CH2 = {
    id: "ch2",
    name: "Other",
    type: "discord",
    botToken: "tok2",
    ownerUserId: "uid",
    ack: true,
  };

  const inbound = (
    body: string,
    id: string,
    channelId = "ch1",
    channelName = "Test",
  ): ChannelMessage => ({
    channelId,
    channelName,
    channelType: "discord",
    messageId: id,
    from: "u",
    fromId: "uid",
    body,
    timestamp: new Date().toISOString(),
    attachments: [],
    isRoom: false,
  });

  const flush = async (n = 12) => {
    for (let i = 0; i < n; i++) await Promise.resolve();
  };

  const content = (c: (typeof fetchCalls)[number]) => {
    const b = typeof c.body === "string" ? JSON.parse(c.body) : (c.body ?? {});
    return b.content ?? "";
  };
  const posts = (ch = "ch1") =>
    fetchCalls
      .filter(
        (c) =>
          c.method === "POST" && c.url.includes(`/channels/${ch}/messages`),
      )
      .map(content);
  const editsTo = (id: string) =>
    fetchCalls
      .filter((c) => c.method === "PATCH" && c.url.includes(`/messages/${id}`))
      .map(content);
  const deleted = (id: string) =>
    fetchCalls.some(
      (c) =>
        c.method === "DELETE" &&
        c.url.includes(`/messages/${id}`) &&
        !c.url.includes("/reactions/"),
    );
  const file = () => path.join(tmp, ".tmp", "live-placeholders.json");

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "p84-test-"));
    fs.mkdirSync(path.join(tmp, ".pi"), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, ".pi", "settings.json"),
      JSON.stringify({ channels: [CH1] }),
    );
    handlers = {};
    sent = [];
    fetchCalls = [];
    msgN = 0;
    midTurnQueues.clear();
    queuedAcks.clear();
    verboseOverride.clear();
    pendingAttachments.clear();
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
      shutdown: () => {},
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
        /\/channels\/ch[12]\/messages$/.test(String(url))
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
    clearDiscordStatesForTest();
    jest.useRealTimers();
    stopAllOpTicks();
    stopAllCompactTicks();
    clearAllCompacting();
    midTurnQueues.clear();
    queuedAcks.clear();
    clearAllInterrupts();
    setInterruptCtx(null);
    setRuntimeStateDir(null);
    resetRuntimeStateForTest();
    try {
      await handlers.agent_end?.({ messages: [] }, ctx);
    } catch {
      /* cleanup only */
    }
    globalThis.fetch = realFetch;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  // A second extension instance in the SAME process: module state survives
  // the "death", the closure state is fresh — exactly what a restart is.
  const secondInstance = () => {
    const pi2: any = {
      registerMessageRenderer: () => {},
      registerTool: () => {},
      on: (n: string, fn: any) => {
        handlers2[n] = fn;
      },
      sendMessage: (m: any, o?: any) => {
        sent2.push({ m, o });
      },
    };
    const handlers2: Record<string, (...a: any[]) => any> = {};
    const sent2: { m: any; o?: any }[] = [];
    extension(pi2);
    return { pi2, handlers2, sent2 };
  };

  test("interrupt mid-turn: the working frame reaches its terminal state (no frozen ticking count)", async () => {
    jest.useFakeTimers();
    verboseOverride.set("ch1", 2);
    await handlers.session_start?.(null, ctx); // configRoot for channel REST
    await handleInbound(pi, inbound("work", "m1"), ctx);
    ctx.isIdle = () => false; // a run is in flight
    await handlers.turn_start(null, ctx); // working frame (out1)
    await handlers.tool_call(
      { toolName: "bash", input: { command: "ls" } },
      ctx,
    );
    expect(editsTo("out1").some((t) => t.includes("working · 1 call"))).toBe(
      true,
    );

    // a second inbound lands mid-run -> queued + acked (out2)
    await handleInbound(pi, inbound("hello", "m2"), ctx);
    await flush();
    expect(posts().some((t) => t.includes("[queued] 1 in line"))).toBe(true);

    const p = runMidRunInterrupt(pi, ctx, "ch1", "m2");
    jest.advanceTimersByTime(5000); // interrupt tick edit on the ack
    expect(editsTo("out2").some((t) => t.includes("interrupting"))).toBe(true);

    // the aborted run ends while the interrupt is in flight
    const finMsg = {
      role: "assistant",
      content: [{ type: "text", text: "partial" }],
    };
    await handlers.agent_end({ messages: [finMsg] }, ctx);

    ctx.isIdle = () => true;
    jest.advanceTimersByTime(50);
    await flush();
    await p;

    // 1. the working frame was settled in place — a FINAL frame, not a
    //    frozen count that keeps ticking or never resolves
    expect(editsTo("out1").some((t) => t.includes("┌ done · 1 call"))).toBe(
      true,
    );
    // 2. the interrupt tick settled and the ack line was consumed
    expect(editsTo("out2").some((t) => t.includes("interrupted"))).toBe(true);
    expect(deleted("out2")).toBe(true);
    // 3. the spliced entry went through to pi as a fresh run (threaded)
    const rew = sent.find(
      (s) =>
        s.m.customType === "channel-inbound" &&
        s.m.details?.body?.includes("hello"),
    );
    expect(rew).toBeDefined();
    expect(rew!.m.details.messageId).toBe("m2");
    // 4. nothing ticks after the settle
    const n1 = editsTo("out1").length;
    const n2 = editsTo("out2").length;
    jest.advanceTimersByTime(30_000);
    await flush();
    expect(editsTo("out1").length).toBe(n1);
    expect(editsTo("out2").length).toBe(n2);
  });

  test("normal run end settles the frame and leaves no crash record", async () => {
    verboseOverride.set("ch1", 2);
    await handlers.session_start?.(null, ctx);
    await handleInbound(pi, inbound("work", "m1"), ctx);
    ctx.isIdle = () => false;
    await handlers.turn_start(null, ctx); // out1
    await handlers.tool_call(
      { toolName: "bash", input: { command: "ls" } },
      ctx,
    );
    // a live frame leaves a crash record behind (for the death case)
    expect(fs.existsSync(file())).toBe(true);
    expect(readLivePlaceholders()?.frame?.msgId).toBe("out1");

    const finMsg = {
      role: "assistant",
      content: [{ type: "text", text: "the answer" }],
    };
    await handlers.agent_end({ messages: [finMsg] }, ctx);
    await flush();

    expect(editsTo("out1").some((t) => t.includes("┌ done · 1 call"))).toBe(
      true,
    );
    expect(deleted("out1")).toBe(false); // calls > 0: morph, not delete
    expect(fs.existsSync(file())).toBe(false); // settled: no crash record
  });

  test("run end after lastActiveChannel moved settles the frame + live text on the RUN'S channel", async () => {
    fs.writeFileSync(
      path.join(tmp, ".pi", "settings.json"),
      JSON.stringify({ channels: [CH1, CH2] }),
    );
    verboseOverride.set("ch1", 1); // level 1: frame on essentials only
    verboseOverride.set("ch2", 1);
    await handlers.session_start?.(null, ctx);
    await handleInbound(pi, inbound("work", "m1"), ctx);
    ctx.isIdle = () => false;
    await handlers.turn_start(null, ctx);
    // a redirect writes -> essential -> a level-1 frame posts (out1 on ch1)
    await handlers.tool_call(
      { toolName: "bash", input: { command: "echo probe > /tmp/p" } },
      ctx,
    );
    expect(posts().some((t) => t.includes("┌ working"))).toBe(true);
    await handlers.message_end(
      {
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "checking things" },
            { type: "toolCall", toolName: "read", arguments: {} },
          ],
        },
      },
      ctx,
    );
    await handlers.tool_call(
      { toolName: "read", input: { path: "a.txt" } },
      ctx,
    ); // live text out2 on ch1
    expect(posts().some((t) => t.includes("checking things"))).toBe(true);

    // a second channel's inbound flips lastActiveChannel mid-run
    await handleInbound(pi, inbound("other", "m2", "ch2", "Other"), ctx);
    await flush();

    const finMsg = {
      role: "assistant",
      content: [{ type: "text", text: "the answer" }],
    };
    await handlers.agent_end({ messages: [finMsg] }, ctx);
    await flush();

    // the frame was settled on ch1 (the run's channel), not ch2
    expect(editsTo("out1").some((t) => t.includes("┌ done"))).toBe(true);
    // the live text was deleted on ch1, not ch2
    const ltDelete = fetchCalls.find(
      (c) =>
        c.method === "DELETE" && c.url.includes("/channels/ch1/messages/out2"),
    );
    expect(ltDelete).toBeDefined();
    expect(fs.existsSync(file())).toBe(false);
  });

  test("channel switch at tool_call settles the old channel's frame in place", async () => {
    fs.writeFileSync(
      path.join(tmp, ".pi", "settings.json"),
      JSON.stringify({ channels: [CH1, CH2] }),
    );
    verboseOverride.set("ch1", 2);
    verboseOverride.set("ch2", 2);
    await handlers.session_start?.(null, ctx);
    await handleInbound(pi, inbound("work", "m1"), ctx);
    ctx.isIdle = () => false;
    await handlers.turn_start(null, ctx); // frame out1 on ch1
    await handlers.tool_call(
      { toolName: "bash", input: { command: "ls" } },
      ctx,
    );

    // ch2's inbound flips lastActiveChannel mid-run
    await handleInbound(pi, inbound("work2", "m2", "ch2", "Other"), ctx);
    await flush(); // ack out2 on ch2

    // the next tool call arrives for ch2: the display moves channels
    await handlers.tool_call(
      { toolName: "bash", input: { command: "pwd" } },
      ctx,
    );
    // the OLD channel's frame is settled in place (stopped), not frozen
    expect(editsTo("out1").some((t) => t.includes("┌ stopped · 1 call"))).toBe(
      true,
    );
    // the new channel posts its own frame (out3)
    expect(posts("ch2").some((t) => t.includes("┌ working"))).toBe(true);

    const finMsg = {
      role: "assistant",
      content: [{ type: "text", text: "the answer" }],
    };
    await handlers.agent_end({ messages: [finMsg] }, ctx);
    await flush();
    expect(editsTo("out3").some((t) => t.includes("┌ done"))).toBe(true);
  });

  test("agent_end that throws before the close block still settles the frame (finally net)", async () => {
    verboseOverride.set("ch1", 2);
    await handleInbound(pi, inbound("work", "m1"), ctx);
    ctx.isIdle = () => false;
    await handlers.turn_start(null, ctx); // 0-call frame out1
    expect(posts().some((t) => t.includes("┌ working · 0 calls"))).toBe(true);

    // messages={} makes sumRunUsage/failurePostText throw mid-handler —
    // the close block is skipped; the finally net must still settle.
    await expect(
      handlers.agent_end({ messages: {} } as any, ctx),
    ).rejects.toThrow();
    await flush();

    expect(deleted("out1")).toBe(true); // 0 calls: erase, no ghost box
  });

  test("process death with a live frame: the next startup morphs it to stopped", async () => {
    verboseOverride.set("ch1", 2);
    await handlers.session_start?.(null, ctx);
    await handleInbound(pi, inbound("work", "m1"), ctx);
    ctx.isIdle = () => false;
    await handlers.turn_start(null, ctx); // out1
    await handlers.tool_call(
      { toolName: "bash", input: { command: "ls" } },
      ctx,
    );
    const rec = readLivePlaceholders();
    expect(rec?.frame).toMatchObject({
      channelId: "ch1",
      msgId: "out1",
      calls: 1,
    });
    expect(rec?.frame?.body).toMatch(/^┌ working/);

    const { handlers2 } = secondInstance();
    simulateProcessDeathForTest(); // crash: no shutdown, no agent_end
    await handlers2.session_start?.({ reason: "startup" }, ctx);
    await flush();

    expect(editsTo("out1").some((t) => t.includes("┌ stopped · 1 call"))).toBe(
      true,
    );
    expect(deleted("out1")).toBe(false); // calls > 0: morph, not delete
    expect(fs.existsSync(file())).toBe(false); // record consumed
  });

  test("process death with a 0-call frame: the next startup deletes it", async () => {
    verboseOverride.set("ch1", 2);
    await handlers.session_start?.(null, ctx);
    await handleInbound(pi, inbound("work", "m1"), ctx);
    ctx.isIdle = () => false;
    await handlers.turn_start(null, ctx); // "working · 0 calls" out1
    expect(readLivePlaceholders()?.frame?.calls).toBe(0);

    const { handlers2 } = secondInstance();
    simulateProcessDeathForTest();
    await handlers2.session_start?.({ reason: "startup" }, ctx);
    await flush();

    expect(deleted("out1")).toBe(true);
    expect(editsTo("out1")).toEqual([]);
    expect(fs.existsSync(file())).toBe(false);
  });

  test("process death with live text: the next startup deletes it", async () => {
    verboseOverride.set("ch1", 1); // reads-only run: no frame, live text only
    await handlers.session_start?.(null, ctx);
    await handleInbound(pi, inbound("hello", "m1"), ctx);
    ctx.isIdle = () => false;
    await handlers.turn_start(null, ctx);
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
    await handlers.tool_call(
      { toolName: "read", input: { path: "a.txt" } },
      ctx,
    );
    const rec = readLivePlaceholders();
    expect(rec?.liveText).toMatchObject({ channelId: "ch1", msgId: "out1" });
    expect(rec?.frame).toBeNull();

    const { handlers2 } = secondInstance();
    simulateProcessDeathForTest();
    await handlers2.session_start?.({ reason: "startup" }, ctx);
    await flush();

    expect(deleted("out1")).toBe(true);
    expect(fs.existsSync(file())).toBe(false);
  });

  test("process death mid-interrupt: the spliced entry is redelivered and its ack deleted", async () => {
    jest.useFakeTimers();
    await handlers.session_start?.(null, ctx); // configRoot for channel REST
    ctx.isIdle = () => false;
    const m2 = inbound("hello", "m2");
    queueMidTurnInbound("ch1", m2, "ctx\n\nhello", "discord/Test", "hello");
    queuedAcks.set("m2", { ackId: "ack1", fromId: "uid", pos: 1 });

    const p = runMidRunInterrupt(pi, ctx, "ch1", "m2");
    jest.advanceTimersByTime(100); // tick pending, settle-wait polling
    const rec = readLivePlaceholders();
    expect(rec?.interrupts).toHaveLength(1);
    expect(rec?.interrupts[0]).toMatchObject({
      channelId: "ch1",
      msgId: "m2",
      ackId: "ack1",
      display: "hello",
    });

    const { handlers2, sent2 } = secondInstance();
    simulateProcessDeathForTest();
    await handlers2.session_start?.({ reason: "startup" }, ctx);
    await flush();

    // the entry was spliced out of the queue before the crash — nobody
    // else would deliver it, so the startup redelivers it as a fresh run
    const redelivered = sent2.find(
      (s) =>
        s.m.customType === "channel-inbound" && s.m.details?.body === "hello",
    );
    expect(redelivered).toBeDefined();
    expect(redelivered!.m.details.messageId).toBe("m2");
    expect(deleted("ack1")).toBe(true); // ack line not orphaned
    expect(fs.existsSync(file())).toBe(false);

    // let the old instance's dangling interrupt settle (test hygiene)
    ctx.isIdle = () => true;
    jest.advanceTimersByTime(50);
    await flush();
    await p;
  });

  test("process death with an orphaned queued ack: the startup deletes the ack line", async () => {
    await handlers.session_start?.(null, ctx);
    ctx.isIdle = () => false;
    const m2 = inbound("hello", "m2");
    queueMidTurnInbound(
      "ch1",
      m2,
      "ctx\n\nhello",
      "discord/Test",
      "hello",
      false, // no interrupt armed
    );
    queuedAcks.set("m2", { ackId: "ack1", fromId: "uid", pos: 1 });
    persistLivePlaceholders();
    expect(readLivePlaceholders()?.queueAcks).toEqual([
      { channelId: "ch1", inboundId: "m2", ackId: "ack1", pos: 1 },
    ]);

    const { handlers2, sent2 } = secondInstance();
    simulateProcessDeathForTest(); // the queue ENTRY is gone with the process
    // #186 reality: queueMidTurnInbound mirrors the entry into the rewake
    // file, and the startup drain restores it — in which case the drain
    // OWNS the ack (settled at delivery). Drop the mirror to test the
    // orphaned-ack settle path (the line is settled at startup instead).
    fs.rmSync(path.join(tmp, ".tmp", "rewake-ch1.json"), { force: true });
    await handlers2.session_start?.({ reason: "startup" }, ctx);
    await flush();

    expect(deleted("ack1")).toBe(true); // the [queued] line is not orphaned
    // the entry itself is #180's scope (queued-inbound persistence) —
    // only the placeholder line is settled here
    expect(sent2.some((s) => s.m.customType === "channel-inbound")).toBe(false);
    expect(fs.existsSync(file())).toBe(false);
  });

  test("process death mid-compact: the startup settles the compact line", async () => {
    await handlers.session_start?.(null, ctx);
    await handleInbound(pi, inbound("/compact", "m1"), ctx);
    await flush();
    expect(posts().some((t) => t.includes("[..] compacting"))).toBe(true);
    expect(readLivePlaceholders()?.compacts).toEqual([
      { channelId: "ch1", msgId: "out1" },
    ]);

    const { handlers2 } = secondInstance();
    simulateProcessDeathForTest();
    await handlers2.session_start?.({ reason: "startup" }, ctx);
    await flush();

    expect(editsTo("out1").some((t) => t.includes("compact interrupted"))).toBe(
      true,
    );
    expect(fs.existsSync(file())).toBe(false);
  });

  test("in-process restart (reason != startup) does not settle; a real start does", async () => {
    verboseOverride.set("ch1", 2);
    await handlers.session_start?.(null, ctx);
    await handleInbound(pi, inbound("work", "m1"), ctx);
    ctx.isIdle = () => false;
    await handlers.turn_start(null, ctx);
    await handlers.tool_call(
      { toolName: "bash", input: { command: "ls" } },
      ctx,
    );
    expect(fs.existsSync(file())).toBe(true);

    const { handlers2 } = secondInstance();
    simulateProcessDeathForTest();
    const nBefore = fetchCalls.length;
    await handlers2.session_start?.(null, ctx); // in-process /new-style re-fire
    await flush();
    // untouched: no settle REST since the re-fire
    expect(
      fetchCalls
        .slice(nBefore)
        .some(
          (c) =>
            (c.method === "PATCH" || c.method === "DELETE") &&
            c.url.includes("/messages/out1"),
        ),
    ).toBe(false);
    expect(readLivePlaceholders()?.frame?.msgId).toBe("out1"); // record kept

    const nStart = fetchCalls.length;
    await handlers2.session_start?.({ reason: "startup" }, ctx);
    await flush();
    expect(
      fetchCalls
        .slice(nStart)
        .some(
          (c) =>
            c.method === "PATCH" &&
            c.url.includes("/messages/out1") &&
            String(c.body).includes("stopped"),
        ),
    ).toBe(true);
    expect(fs.existsSync(file())).toBe(false);
  });

  test("shutdown unlinks the crash record (a clean exit leaves nothing to settle)", async () => {
    verboseOverride.set("ch1", 2);
    await handlers.session_start?.(null, ctx);
    await handleInbound(pi, inbound("work", "m1"), ctx);
    ctx.isIdle = () => false;
    await handlers.turn_start(null, ctx);
    await handlers.tool_call(
      { toolName: "bash", input: { command: "ls" } },
      ctx,
    );
    expect(fs.existsSync(file())).toBe(true);

    await handlers.session_shutdown?.();
    await flush();

    expect(editsTo("out1").some((t) => t.includes("┌ stopped · 1 call"))).toBe(
      true,
    );
    expect(fs.existsSync(file())).toBe(false);
  });
});
