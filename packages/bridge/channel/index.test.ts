import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  clearDiscordStatesForTest,
  seedChannelStateForTest,
  setChannelCursor,
} from "./discord";
import { isFleetRun } from "./fleet-run";
import { fmtTokensLC, styleGuard } from "./format";
import { FRAME_COL_MAX } from "./frame";
import extension, {
  autoCompactByToken,
  bashToolEssential,
  buildRepliedMessageBlock,
  chunkText,
  clearAllCompacting,
  clearAllInterrupts,
  collectFinals,
  fileOnlyPrompt,
  handleInbound,
  heldChannels,
  interruptStepTimeoutMs,
  isBgInbound,
  isCompacting,
  isEssentialToolCall,
  isNoReply,
  isVerbose,
  LIVE_MARKER_DIR,
  maybeAutoCompactByToken,
  parseReplyTo,
  parseVerboseLevel,
  pendingAttachments,
  pendingInterrupts,
  prunePendingBatches,
  REPEAT_WARNING,
  RUN_FRAME_MAX_STEPS,
  resetRuntimeStateForTest,
  runFrame,
  setInterruptCtx,
  setRuntimeStateDir,
  TOOL_LINE_MAX,
  TOOL_TEXT_MAX,
  toolActionText,
  touchLiveMarker,
  verboseLevel,
  verboseOverride,
  workingMaxMs,
} from "./index";
import { settleOpTick, stopAllOpTicks } from "./live";
import {
  clearQueuedInbound,
  midTurnQueues,
  queuedAcks,
  queueMidTurnInbound,
} from "./queue";
import { setProcessExitHookForTest } from "./restart-ops";
import { getCurrentSessionFile, rewakeCommitDelivered } from "./restart-queue";
import { fit } from "./todos";
import { type ChannelMessage, loadChannelConfig } from "./types";
import { performUndo } from "./undo";

// Fleet-run gate (hall-monitor #35 gut): a dispatch agent running this
// suite inherits PI_SESSION_ID=fleetwork-<ticket> from its run wrapper;
// the gate treats that as a fleet run and would skip all channel startup
// in every test. Clear it here (the fleet-gate describe re-sets it).
delete process.env.PI_SESSION_ID;

/** A2 (polish sweep, 2026-09-15) + 2026-10-18: styleGuard once wrapped
 *  untagged fence bodies to the 40-col budget; the wrap is GONE (no width
 *  budget on fences anymore), so this collapse is a no-op kept for the
 *  historical assertions that use it. */
const unwarped = (s: string) => s.replace(/\n +/g, " ");

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

describe("chunkText", () => {
  test("short fenced block is unchanged", () => {
    const text = "```js\nconst x = 1\n```";
    expect(chunkText(text, 200)).toEqual([text]);
  });

  test("fenced block over max is split and each piece stays fenced under max (M1)", () => {
    const line = "x".repeat(1200);
    const text = ["```js", line, "const y = 2", "```"].join("\n");
    const chunks = chunkText(text, 500);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(500);
      expect(c.startsWith("```js\n")).toBe(true);
      expect(c.endsWith("\n```")).toBe(true);
    }
    // No content lost: strip fences and newlines, must equal the inner text.
    const stripped = chunks
      .map((c) => c.replace(/^```js\n/, "").replace(/\n```$/, ""))
      .join("\n")
      .replace(/\n/g, "");
    expect(stripped).toBe(`${line}const y = 2`);
  });

  test("single oversized code line inside a fence is split (M1)", () => {
    const line = "b".repeat(400);
    const text = ["```", line, "```"].join("\n");
    const chunks = chunkText(text, 100);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(100);
      expect(c.startsWith("```\n")).toBe(true);
      expect(c.endsWith("\n```")).toBe(true);
    }
  });

  test("single long line outside a fence is split without loss", () => {
    const chunks = chunkText("a".repeat(250), 100);
    expect(chunks.every((c) => c.length <= 100)).toBe(true);
    expect(chunks.join("")).toBe("a".repeat(250));
  });
});

describe("isNoReply", () => {
  test("exact token (trim + case-insensitive)", () => {
    expect(isNoReply("NO_REPLY")).toBe(true);
    expect(isNoReply("no_reply")).toBe(true);
    expect(isNoReply("  No_ReplY  ")).toBe(true);
  });
  test("non-matches stay postable", () => {
    expect(isNoReply("NO_REPLY.")).toBe(false);
    expect(isNoReply("NO_REPLY extra")).toBe(false);
    expect(isNoReply("·")).toBe(false);
    expect(isNoReply("")).toBe(false);
  });
});

describe("collectFinals", () => {
  const inbound = (id: string) => ({
    customType: "channel-inbound",
    details: { messageId: id },
  });
  const assistantText = (text: string) => ({
    role: "assistant",
    content: [{ type: "text", text }],
  });

  test("pairs each final with the nearest preceding inbound (L4)", () => {
    // Steering run shape: [A, X, B, Y] must thread X → A and Y → B.
    const finals = collectFinals([
      inbound("A"),
      assistantText("X"),
      inbound("B"),
      assistantText("Y"),
    ]);
    expect(finals).toEqual([
      { text: "X", replyTo: "A" },
      { text: "Y", replyTo: "B" },
    ]);
  });

  test("tool-call turns are not finals (L4)", () => {
    const finals = collectFinals([
      inbound("A"),
      {
        role: "assistant",
        content: [{ type: "toolCall", toolName: "read", arguments: {} }],
      },
      assistantText("done"),
    ]);
    expect(finals).toEqual([{ text: "done", replyTo: "A" }]);
  });

  test("final before any inbound has no reply target", () => {
    const finals = collectFinals([assistantText("hi")]);
    expect(finals).toEqual([{ text: "hi", replyTo: undefined }]);
  });

  test("<reply-to> tag matching a burst id wins over the last-message target", () => {
    const burst = {
      customType: "channel-inbound",
      details: { messageId: "333", messageIds: ["111", "222", "333"] },
    };
    const finals = collectFinals([
      burst,
      assistantText("<reply-to:111>\nthanks andy"),
    ]);
    expect(finals).toEqual([{ text: "thanks andy", replyTo: "111" }]);
  });

  test("<reply-to> tag mid-text is stripped and used when valid", () => {
    const burst = {
      customType: "channel-inbound",
      details: { messageId: "333", messageIds: ["111", "222", "333"] },
    };
    const finals = collectFinals([
      burst,
      assistantText("done, see above <reply-to: 222 >"),
    ]);
    expect(finals).toEqual([{ text: "done, see above ", replyTo: "222" }]);
  });

  test("<reply-to> tag not in the triggering ids falls back to last-message target", () => {
    const burst = {
      customType: "channel-inbound",
      details: { messageId: "333", messageIds: ["111", "222", "333"] },
    };
    const finals = collectFinals([burst, assistantText("<reply-to:999>\nhi")]);
    expect(finals).toEqual([{ text: "hi", replyTo: "333" }]);
  });

  test("<reply-to> tag without any inbound falls back (no target)", () => {
    const finals = collectFinals([assistantText("<reply-to:111>\nhi")]);
    expect(finals).toEqual([{ text: "hi", replyTo: undefined }]);
  });

  test("no tag: existing behavior unchanged, text untouched", () => {
    const finals = collectFinals([inbound("A"), assistantText("  spaced  ")]);
    expect(finals).toEqual([{ text: "spaced", replyTo: "A" }]);
  });

  test("rapid-fire: reply-to an earlier inbound in the same run (2026-09-20)", () => {
    // operator msg 1 → my reply → operator msg 2 → my reply with <reply-to:msg1>
    // The allowed set must accumulate ALL inbound ids, not just the last.
    const finals = collectFinals([
      inbound("111"),
      assistantText("first reply"),
      inbound("222"),
      assistantText("<reply-to:111>\ntagging the earlier one"),
    ]);
    expect(finals).toEqual([
      { text: "first reply", replyTo: "111" },
      { text: "tagging the earlier one", replyTo: "111" },
    ]);
  });

  test("rapid-fire burst: reply-to a burst member from an earlier burst (2026-09-20)", () => {
    const burst1 = {
      customType: "channel-inbound",
      details: { messageId: "333", messageIds: ["111", "222", "333"] },
    };
    const burst2 = {
      customType: "channel-inbound",
      details: { messageId: "444", messageIds: ["444"] },
    };
    const finals = collectFinals([
      burst1,
      assistantText("<reply-to:111>\ntagging 111 from burst 1"),
      burst2,
      assistantText("<reply-to:111>\nstill tagging 111 after burst 2"),
    ]);
    expect(finals).toEqual([
      { text: "tagging 111 from burst 1", replyTo: "111" },
      { text: "still tagging 111 after burst 2", replyTo: "111" },
    ]);
  });
});

describe("parseReplyTo", () => {
  test("strips a leading tag and the newline it leaves", () => {
    expect(parseReplyTo("<reply-to:123456>\nbody text")).toEqual({
      text: "body text",
      replyTo: "123456",
    });
  });

  test("strips a tag anywhere in the text", () => {
    expect(parseReplyTo("a <reply-to:123> b")).toEqual({
      text: "a  b",
      replyTo: "123",
    });
  });

  test("no tag: text unchanged, replyTo undefined", () => {
    expect(parseReplyTo("plain text")).toEqual({
      text: "plain text",
      replyTo: undefined,
    });
  });

  test("non-numeric payload is not a tag", () => {
    expect(parseReplyTo("<reply-to:abc>\nbody")).toEqual({
      text: "<reply-to:abc>\nbody",
      replyTo: undefined,
    });
  });

  test("empty text", () => {
    expect(parseReplyTo("")).toEqual({ text: "", replyTo: undefined });
  });

  test("tag inside a code fence is content, not a directive", () => {
    expect(parseReplyTo("example:\n```\n<reply-to:111>\n```\ndone")).toEqual({
      text: "example:\n```\n<reply-to:111>\n```\ndone",
      replyTo: undefined,
    });
  });

  test("tag outside a fence next to a fenced tag is honored, fenced one kept", () => {
    expect(
      parseReplyTo("```\n<reply-to:111>\n```\nsee above <reply-to:222>"),
    ).toEqual({
      text: "```\n<reply-to:111>\n```\nsee above ",
      replyTo: "222",
    });
  });

  test("multiple tags: first outside fences wins, all are stripped", () => {
    expect(parseReplyTo("<reply-to:111>\nbody <reply-to:333>")).toEqual({
      text: "body ",
      replyTo: "111",
    });
  });
});

describe("fileOnlyPrompt", () => {
  const att = (filename: string) => ({
    id: "1",
    filename,
    contentType: "image/jpeg",
    size: 1024,
  });

  test("single file uses singular wording", () => {
    expect(fileOnlyPrompt([att("IMG_1358.jpg")])).toBe(
      "[user sent 1 file without text: IMG_1358.jpg]",
    );
  });

  test("multiple files are listed", () => {
    expect(fileOnlyPrompt([att("a.txt"), att("b.jpg")])).toBe(
      "[user sent 2 files without text: a.txt, b.jpg]",
    );
  });
});

describe("prunePendingBatches", () => {
  test("drops batches older than the 10-minute TTL", () => {
    const now = Date.now();
    pendingAttachments.set("ch1", [
      {
        folder: ".tmp/attachments/old",
        files: [],
        addedAt: now - 11 * 60 * 1000,
      },
      { folder: ".tmp/attachments/fresh", files: [], addedAt: now - 60 * 1000 },
    ]);
    const fresh = prunePendingBatches("ch1", now);
    expect(fresh.map((b) => b.folder)).toEqual([".tmp/attachments/fresh"]);
    pendingAttachments.delete("ch1");
  });

  test("empty channel has no batches and no map entry", () => {
    expect(prunePendingBatches("nope")).toEqual([]);
    expect(pendingAttachments.has("nope")).toBe(false);
  });
});

// ─── Integration: extension handlers with mocked fetch ──────────────────────
// Exercises the default factory's message_end / agent_end / handleInbound
// wiring without a live Discord: channel config from a temp workspace,
// global fetch captured, pi.sendMessage captured.

describe("extension handlers (A1/A2/A4)", () => {
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

  // Bounded clock-time flush for the fire-and-forget re-wake kick
  // (cancel branch, index.ts): the kick's send chain needs real
  // event-loop turns that competing macrotasks steal under load, so a
  // fixed setImmediate-hop budget flakes (MEDIUM-1, review 3005244).
  // All real clocks are faked under jest.useFakeTimers (Date/performance/
  // hrtime move with advanceTimersByTime), so the budget is virtual
  // clock time: 25ms steps (settle-tick cadence) interleaved with a real
  // loop turn. Exits as soon as cond() holds or 20s of clock elapses.
  // (20s = 800 ticks: instrumented kick chains need 1-6 ticks normally,
  // up to 147 under 20-process load — the send chain's real localhost
  // fetches stretch across many loop turns when the CPU is contended.)
  // Only call under fake timers.
  const flushUntil = async (cond: () => boolean, budgetMs = 20000) => {
    for (let used = 0; used < budgetMs && !cond(); used += 25) {
      jest.advanceTimersByTime(25);
      await new Promise<void>((r) => setImmediate(r));
    }
  };

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

  test("A1: message_end early send unreacts the 👀 ack on the last inbound", async () => {
    await handleInbound(pi, inbound("hello", "m123"), ctx);
    await handlers.turn_start(null, ctx);
    // step-final (text only) is the early-send path; intermediate
    // (text + toolCall) lands in the SPEC B live-text slot instead
    const stepFinal = {
      role: "assistant",
      content: [{ type: "text", text: "working on it" }],
    };
    await handlers.message_end({ message: stepFinal }, ctx);

    const posted = fetchCalls.filter(
      (c) => c.method === "POST" && c.url.endsWith("/channels/ch1/messages"),
    );
    expect(posted.length).toBeGreaterThan(0);
    const unreact = fetchCalls.find(
      (c) =>
        c.method === "DELETE" &&
        c.url.includes("/channels/ch1/messages/m123/reactions/"),
    );
    expect(unreact).toBeDefined();
  });

  test("message_end early send strips <reply-to> and threads to the tagged inbound", async () => {
    await handleInbound(pi, inbound("hello", "111"), ctx);
    await handlers.turn_start(null, ctx);
    const stepFinal = {
      role: "assistant",
      content: [{ type: "text", text: "<reply-to:111>\nhi there" }],
    };
    await handlers.message_end({ message: stepFinal }, ctx);

    const posts = fetchCalls.filter(
      (c) => c.method === "POST" && c.url.endsWith("/channels/ch1/messages"),
    );
    const post = posts[posts.length - 1]; // last: earlier POSTs are the activity placeholder
    expect(post).toBeDefined();
    const body = JSON.parse(post!.body);
    expect(body.content).toBe("hi there");
    expect(body.message_reference?.message_id).toBe("111");
  });

  test("message_end invalid <reply-to> falls back to the last inbound", async () => {
    await handleInbound(pi, inbound("hello", "111"), ctx);
    await handlers.turn_start(null, ctx);
    const stepFinal = {
      role: "assistant",
      content: [{ type: "text", text: "<reply-to:999>\nhi there" }],
    };
    await handlers.message_end({ message: stepFinal }, ctx);

    const posts = fetchCalls.filter(
      (c) => c.method === "POST" && c.url.endsWith("/channels/ch1/messages"),
    );
    const post = posts[posts.length - 1]; // last: earlier POSTs are the activity placeholder
    const body = JSON.parse(post!.body);
    expect(body.content).toBe("hi there");
    expect(body.message_reference?.message_id).toBe("111");
  });

  test("message_end untagged final threads to the last inbound", async () => {
    await handleInbound(pi, inbound("hello", "111"), ctx);
    await handlers.turn_start(null, ctx);
    const stepFinal = {
      role: "assistant",
      content: [{ type: "text", text: "hi there" }],
    };
    await handlers.message_end({ message: stepFinal }, ctx);

    const posts = fetchCalls.filter(
      (c) => c.method === "POST" && c.url.endsWith("/channels/ch1/messages"),
    );
    const post = posts[posts.length - 1]; // last: earlier POSTs are the activity placeholder
    const body = JSON.parse(post!.body);
    expect(body.message_reference?.message_id).toBe("111");
  });

  test("A2: agent_end posts errorMessage on a failed run", async () => {
    await handleInbound(pi, inbound("hello", "m1"), ctx);
    const failure = {
      role: "assistant",
      content: [{ type: "text", text: "" }],
      stopReason: "error",
      errorMessage: "boom",
    };
    await handlers.agent_end({ messages: [failure] }, ctx);

    const posts = fetchCalls.filter(
      (c) => c.method === "POST" && c.url.endsWith("/channels/ch1/messages"),
    );
    const post = posts[posts.length - 1]; // last: earlier POSTs are the activity placeholder
    expect(post).toBeDefined();
    // Op status is bare prose (no fence, no tag - v4 §2.3 + 2026-10-20):
    expect(JSON.parse(post!.body).content).toBe(styleGuard("boom"));
  });

  test("A2: user /stop abort is not posted as a run error", async () => {
    await handleInbound(pi, inbound("hello", "m1"), ctx);
    ctx.isIdle = () => false; // a run is active when /stop lands
    fetchCalls.length = 0;
    await handleInbound(pi, inbound("/stop", "m2"), ctx);

    const failure = {
      role: "assistant",
      content: [{ type: "text", text: "" }],
      stopReason: "aborted",
      errorMessage: "aborted",
    };
    await handlers.agent_end({ messages: [failure] }, ctx);

    const errors = fetchCalls.filter(
      (c) =>
        c.method === "POST" &&
        c.url.endsWith("/channels/ch1/messages") &&
        String(JSON.parse(c.body).content).startsWith("[!]"),
    );
    expect(errors.length).toBe(0);
  });

  test("activity block: 0 tool calls -> deleted at agent_end (no done line)", async () => {
    verboseOverride.set("ch1", 2); // display gate: block renders only when verbose (level 2 = all)
    await handleInbound(pi, inbound("hello", "m1"), ctx);
    await handlers.turn_start(null, ctx);
    const pureTextFinal = {
      role: "assistant",
      content: [{ type: "text", text: "hi there" }],
    };
    await handlers.agent_end({ messages: [pureTextFinal] }, ctx);

    const placeholder = fetchCalls.find(
      (c) =>
        c.method === "POST" &&
        c.url.endsWith("/channels/ch1/messages") &&
        String(JSON.parse(c.body).content).includes("┌ working"), // fenced working frame (live-frame unification)
    );
    expect(placeholder).toBeDefined(); // live block existed during the run
    const deleted = fetchCalls.find(
      (c) => c.method === "DELETE" && c.url.includes("/messages/out1"),
    );
    expect(deleted).toBeDefined(); // 0 calls: block deleted, not left behind
    const doneEdit = fetchCalls.find(
      (c) => c.method === "PATCH" && String(c.body).includes("┗ done"),
    );
    expect(doneEdit).toBeUndefined(); // no "done · 0 calls" line
  });

  test("activity block: 1+ tool calls -> closed with done line (regression)", async () => {
    verboseOverride.set("ch1", 2); // display gate: block renders only when verbose (level 2 = all)
    await handleInbound(pi, inbound("hello", "m1"), ctx);
    await handlers.turn_start(null, ctx);
    await handlers.tool_call(
      { toolName: "bash", input: { command: "ls" } },
      ctx,
    );
    const withTool = {
      role: "assistant",
      content: [
        { type: "text", text: "done" },
        { type: "toolCall", toolName: "bash", arguments: {} },
      ],
    };
    await handlers.agent_end({ messages: [withTool] }, ctx);

    const doneEdit = fetchCalls.find(
      (c) =>
        c.method === "PATCH" &&
        String(JSON.parse(c.body).content).includes("┌ done · 1 call"),
    );
    expect(doneEdit).toBeDefined(); // block stays, shows the finished run
    // live-frame unification: the morph is an edit of the SAME placeholder
    // message (mock id out1), not a fresh post at run end
    expect(doneEdit!.url).toContain("/channels/ch1/messages/out1");
    expect(
      fetchCalls.some(
        (c) =>
          c.method === "POST" &&
          String(JSON.parse(c.body ?? "{}").content ?? "").includes("┌ done"),
      ),
    ).toBe(false);
    const doneBody = String(JSON.parse(doneEdit!.body).content);
    expect(doneBody).toContain("│ └ bash ls"); // sub-step, last = └
    // multi-line frame lives in a code fence (mockup3), same fence() as
    // every other machine line
    expect(doneBody.startsWith("```\n")).toBe(true);
    expect(doneBody.trimEnd()).toMatch(/\n└\n```$/); // closing bar, then fence
    const deleted = fetchCalls.find(
      (c) => c.method === "DELETE" && c.url.includes("/messages/out1"),
    );
    expect(deleted).toBeUndefined();
  });

  test("live tick re-renders the full working frame in place (same message)", async () => {
    jest.useFakeTimers();
    verboseOverride.set("ch1", 2);
    await handleInbound(pi, inbound("hello", "m1"), ctx);
    await handlers.turn_start(null, ctx);
    // settle the fire-and-forget placeholder post (microtasks, no timers)
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    // level-2 placeholder IS the 0-call working frame (live-frame unification)
    const placeholder = fetchCalls.find(
      (c) =>
        c.method === "POST" &&
        c.url.endsWith("/channels/ch1/messages") &&
        String(JSON.parse(c.body).content).includes("┌ working · 0 calls"),
    );
    expect(placeholder).toBeDefined();

    const edits = () =>
      fetchCalls
        .filter((c) => c.method === "PATCH" && c.url.includes("/messages/"))
        .map((c) =>
          String(
            (typeof c.body === "string" ? JSON.parse(c.body) : c.body).content,
          ),
        );

    // a tool call edits the SAME message with the full working frame
    await handlers.tool_call(
      { toolName: "bash", input: { command: "git push" } },
      ctx,
    );
    let last = edits().at(-1)!;
    expect(last).toContain("┌ working · 1 call");
    expect(last).toContain("│ └ bash git push");
    expect(last.trimEnd()).toMatch(/\n└\n```$/); // full frame, fenced
    expect((last.match(/^```/gm) ?? []).length).toBe(2); // exactly one fence

    // 5s-step tick: still the full frame (not a one-line status), same
    // message id, elapsed stepped to 5s
    jest.advanceTimersByTime(5001);
    last = edits().at(-1)!;
    expect(last).toContain("┌ working · 1 call · 5s");
    expect(last).toContain("│ └ bash git push");
    expect((last.match(/^```/gm) ?? []).length).toBe(2); // exactly one fence (F1)
    const tickEdit = fetchCalls
      .filter((c) => c.method === "PATCH" && c.url.includes("/messages/"))
      .at(-1);
    expect(tickEdit!.url).toContain("/channels/ch1/messages/out1");
    // the tick never posts a fresh working message
    expect(
      fetchCalls.filter(
        (c) =>
          c.method === "POST" &&
          c.url.endsWith("/channels/ch1/messages") &&
          String(JSON.parse(c.body).content).includes("┌ working"),
      ).length,
    ).toBe(1);

    // a second call grows the frame in place; the tick keeps the shape
    await handlers.tool_call(
      { toolName: "edit", input: { path: "a.txt" } },
      ctx,
    );
    jest.advanceTimersByTime(5000);
    last = edits().at(-1)!;
    expect(last).toContain("┌ working · 2 calls · 10s");
    expect(last).toContain("│ ├ bash git push");
    expect(last).toContain("│ └ edit a.txt");
  });

  test("working frame stalls after the max lifetime without agent_end (#84 L3)", async () => {
    jest.useFakeTimers();
    verboseOverride.set("ch1", 2);
    await handleInbound(pi, inbound("hello", "m1"), ctx);
    await handlers.turn_start(null, ctx);
    // settle the fire-and-forget placeholder post (microtasks, no timers)
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    const placeholder = fetchCalls.find(
      (c) =>
        c.method === "POST" &&
        c.url.endsWith("/channels/ch1/messages") &&
        String(JSON.parse(c.body).content).includes("┌ working · 0 calls"),
    );
    expect(placeholder).toBeDefined();

    const edits = () =>
      fetchCalls
        .filter(
          (c) =>
            c.method === "PATCH" && c.url.includes("/channels/ch1/messages/"),
        )
        .map((c) =>
          String(
            (typeof c.body === "string" ? JSON.parse(c.body) : c.body).content,
          ),
        );

    // still counting up well before the cap
    jest.advanceTimersByTime(5000);
    expect(edits().at(-1)).toContain("┌ working · 0 calls · 5s");

    // cross the 30-min cap: the run never ended (no agent_end), so the tick
    // settles the frame to its TRUE state (stalled) and stops — it must not
    // count up forever.
    jest.advanceTimersByTime(workingMaxMs() - 5000 + 5000);
    await Promise.resolve();
    await Promise.resolve();
    expect(edits().at(-1)).toBe("run stalled - /stop to abort");

    // tick is gone: advancing further must not edit the frame again
    const n = edits().length;
    jest.advanceTimersByTime(10000);
    expect(edits().length).toBe(n);
  });

  test("verbose off: no tool-call block created, sent, or edited (#38)", async () => {
    // ch1 has no forwardToolCalls and no override -> verbose off
    expect(isVerbose(loadChannelConfig(ctx.cwd)[0]!)).toBe(false);
    await handleInbound(pi, inbound("hello", "m1"), ctx);
    await handlers.turn_start(null, ctx);
    await handlers.tool_call(
      { toolName: "bash", input: { command: "ls" } },
      ctx,
    );
    await handlers.tool_call(
      { toolName: "read", input: { path: "/tmp/a.md" } },
      ctx,
    );
    const pureTextFinal = {
      role: "assistant",
      content: [{ type: "text", text: "hi there" }],
    };
    await handlers.agent_end({ messages: [pureTextFinal] }, ctx);

    const posts = fetchCalls.filter(
      (c) => c.method === "POST" && c.url.endsWith("/channels/ch1/messages"),
    );
    expect(
      posts.filter((c) =>
        String(JSON.parse(c.body).content).includes("┌ working"),
      ).length,
    ).toBe(0); // no working frame placeholder, no tool frame
    const edits = fetchCalls.filter((c) => c.method === "PATCH");
    expect(edits.length).toBe(0); // nothing to edit, no done line either
    const deleted = fetchCalls.filter((c) => c.method === "DELETE");
    expect(deleted.length).toBe(0); // no block to delete at run end
    // the final still lands
    expect(
      posts.some((c) =>
        String(JSON.parse(c.body).content).includes("hi there"),
      ),
    ).toBe(true);
  });

  test("verbose-off run leaves the previous run's done line untouched (#38)", async () => {
    // run 1: verbose on — block created, closed with a done line
    verboseOverride.set("ch1", 2);
    await handleInbound(pi, inbound("hello", "m1"), ctx);
    await handlers.turn_start(null, ctx);
    await handlers.tool_call(
      { toolName: "bash", input: { command: "ls" } },
      ctx,
    );
    const fin = (t: string) => ({
      role: "assistant",
      content: [{ type: "text", text: t }],
    });
    await handlers.agent_end({ messages: [fin("one")] }, ctx);
    expect(
      fetchCalls.some(
        (c) => c.method === "PATCH" && String(c.body).includes("┌ done"),
      ),
    ).toBe(true); // run 1's frame closed

    // run 2: verbose off, no tool calls — statusMsgId still points at
    // run 1's line; agent_end must not delete or re-edit it
    verboseOverride.set("ch1", 0);
    fetchCalls.length = 0;
    await handleInbound(pi, inbound("again", "m2"), ctx);
    await handlers.turn_start(null, ctx);
    await handlers.agent_end({ messages: [fin("two")] }, ctx);
    expect(fetchCalls.some((c) => c.method === "PATCH")).toBe(false); // no done line (nothing to close)
    expect(fetchCalls.some((c) => c.method === "DELETE")).toBe(false);
    // run 2's final still posts
    expect(
      fetchCalls.some(
        (c) =>
          c.method === "POST" &&
          c.url.endsWith("/channels/ch1/messages") &&
          String(JSON.parse(c.body).content).includes("two"),
      ),
    ).toBe(true);
  });

  test("verbose on->off mid-run deletes the live block (#38)", async () => {
    verboseOverride.set("ch1", 2);
    await handleInbound(pi, inbound("hello", "m1"), ctx);
    await handlers.turn_start(null, ctx);
    await handlers.tool_call(
      { toolName: "bash", input: { command: "ls" } },
      ctx,
    );
    expect(
      fetchCalls.some(
        (c) =>
          c.method === "POST" &&
          c.url.endsWith("/channels/ch1/messages") &&
          String(JSON.parse(c.body).content).includes("┌ working"), // fenced working frame (live-frame unification)
      ),
    ).toBe(true); // live block exists (mock id out1)

    // flip verbose off while the run is in flight
    await handleInbound(pi, inbound("/verbose off", "m2"), ctx);
    const del = fetchCalls.find(
      (c) =>
        c.method === "DELETE" && c.url.includes("/channels/ch1/messages/out1"),
    );
    expect(del).toBeDefined(); // live block deleted on the transition

    // next tool call: no edit (no block to update)
    fetchCalls.length = 0;
    await handlers.tool_call(
      { toolName: "bash", input: { command: "pwd" } },
      ctx,
    );
    expect(fetchCalls.some((c) => c.method === "PATCH")).toBe(false);

    // run end: done line no-ops, final still posts
    await handlers.agent_end(
      {
        messages: [
          { role: "assistant", content: [{ type: "text", text: "done" }] },
        ],
      },
      ctx,
    );
    expect(
      fetchCalls.some(
        (c) => c.method === "PATCH" && String(c.body).includes("┌ done"),
      ),
    ).toBe(false); // no done frame after the live block was deleted
    expect(
      fetchCalls.some(
        (c) =>
          c.method === "POST" &&
          c.url.endsWith("/channels/ch1/messages") &&
          String(JSON.parse(c.body).content).includes("done"),
      ),
    ).toBe(true);
  });

  test("verbose off->on mid-run re-arms the block on the next tool call (#38)", async () => {
    await handleInbound(pi, inbound("hello", "m1"), ctx);
    await handlers.turn_start(null, ctx);
    await handlers.tool_call(
      { toolName: "bash", input: { command: "ls" } },
      ctx,
    );
    expect(
      fetchCalls
        .filter(
          (c) =>
            c.method === "POST" && c.url.endsWith("/channels/ch1/messages"),
        )
        .filter((c) =>
          String(JSON.parse(c.body).content).includes("┌ working"),
        ),
    ).toHaveLength(0); // quiet run so far

    verboseOverride.set("ch1", 2);
    await handlers.tool_call(
      { toolName: "bash", input: { command: "pwd" } },
      ctx,
    );
    // fresh block created by the next tool call (no stale placeholder to edit)
    const toolPost = fetchCalls.find(
      (c) =>
        c.method === "POST" &&
        c.url.endsWith("/channels/ch1/messages") &&
        String(JSON.parse(c.body).content).includes("┌ working") &&
        String(JSON.parse(c.body).content).includes("bash pwd"),
    );
    expect(toolPost).toBeDefined();
  });

  test("/status reflects the verbose state (#38)", async () => {
    const statusPost = () => {
      const posts = fetchCalls.filter(
        (c) => c.method === "POST" && c.url.endsWith("/channels/ch1/messages"),
      );
      return posts
        .map((p) => String(JSON.parse(p.body).content))
        .find((t) => t.includes("[status]"));
    };
    // off by default: quiet
    await handleInbound(pi, inbound("/status", "m1"), ctx);
    let st = statusPost();
    expect(st).toBeDefined();
    expect(st).toContain("quiet");
    expect(st).not.toContain("verbose");

    // /verbose on (legacy = level 2): the next /status says verbose
    await handleInbound(pi, inbound("/verbose on", "m2"), ctx);
    expect(
      fetchCalls.some(
        (c) =>
          c.method === "POST" &&
          c.url.endsWith("/channels/ch1/messages") &&
          String(JSON.parse(c.body).content).includes("[ok] verbose: 2"),
      ),
    ).toBe(true);
    fetchCalls.length = 0;
    await handleInbound(pi, inbound("/status", "m3"), ctx);
    st = statusPost();
    expect(st).toBeDefined();
    expect(st).toContain("verbose 2");

    // #47: queue depth in the status line
    queueMidTurnInbound(
      "ch1",
      inbound("queued q1", "m4"),
      "text",
      "discord/Test",
      "text",
      false,
    );
    queueMidTurnInbound(
      "ch1",
      inbound("queued q2", "m5"),
      "text",
      "discord/Test",
      "text",
      false,
    );
    fetchCalls.length = 0;
    await handleInbound(pi, inbound("/status", "m6"), ctx);
    st = statusPost();
    expect(st).toContain("queue 2");

    // #47: hold state in the status line (queue survives the hold)
    await handleInbound(pi, inbound("/hold on", "m7"), ctx);
    fetchCalls.length = 0;
    await handleInbound(pi, inbound("/status", "m8"), ctx);
    st = statusPost();
    expect(st).toContain("hold on");
    expect(st).toContain("queue 2");

    // release: idle mock runs the oldest now; the rest chain via the
    // re-wake loop (one run each) and stay queued until then
    await handleInbound(pi, inbound("/hold off", "m9"), ctx);
    await new Promise((r) => setImmediate(r));
    fetchCalls.length = 0;
    await handleInbound(pi, inbound("/status", "m10"), ctx);
    st = statusPost();
    expect(st).not.toContain("hold on");
    expect(st).toContain("queue 1");

    // drain the last entry (the mock never fires agent_end, so no
    // re-wake): status is back to a clean line
    midTurnQueues.delete("ch1");
    fetchCalls.length = 0;
    await handleInbound(pi, inbound("/status", "m11"), ctx);
    st = statusPost();
    expect(st).not.toContain("hold on");
    expect(st).not.toContain("queue");
  });

  test("A4: /stop drains the channel's queued mid-turn inbounds", async () => {
    ctx.isIdle = () => false; // inbounds while a run is active get queued
    await handleInbound(pi, inbound("followup", "m1"), ctx);
    expect(sent.length).toBe(0); // queued, not sent yet
    expect(midTurnQueues.get("ch1")?.length).toBe(1);

    await handleInbound(pi, inbound("/stop", "m2"), ctx);
    expect(midTurnQueues.has("ch1")).toBe(false); // /stop drained the queue

    // The run ends; nothing queued, so no re-wake send.
    await handlers.agent_end({ messages: [] }, ctx);
    expect(sent.length).toBe(0);
  });

  test("mid-turn inbound is queued and re-woken at agent_end (no swallow)", async () => {
    ctx.isIdle = () => false; // a run is in flight
    await handleInbound(pi, inbound("pi-bg webhook callback", "m100"), ctx);
    // While busy: NOT sent to pi, queued for a guaranteed re-wake instead.
    expect(sent.length).toBe(0);
    expect(midTurnQueues.get("ch1")?.length).toBe(1);

    // The run ends → agent_end re-wakes the queued message as a fresh run.
    await handlers.agent_end({ messages: [] }, ctx);
    expect(sent.length).toBe(1); // re-wake fired a new run
    expect(sent[0].o.triggerTurn).toBe(true);
    // Full inbound context preserved (processed exactly as a fresh inbound).
    expect(sent[0].m.details.body).toBe("pi-bg webhook callback");
    expect(sent[0].m.details.messageId).toBe("m100");
    expect(midTurnQueues.has("ch1")).toBe(false); // queue drained
  });

  test("multiple mid-turn inbounds re-wake in order (FIFO)", async () => {
    ctx.isIdle = () => false;
    await handleInbound(pi, inbound("first", "m1"), ctx);
    await handleInbound(pi, inbound("second", "m2"), ctx);
    expect(midTurnQueues.get("ch1")?.length).toBe(2);

    // First agent_end re-wakes only the oldest; the rest stay queued.
    await handlers.agent_end({ messages: [] }, ctx);
    expect(sent.length).toBe(1);
    expect(sent[0].m.details.body).toBe("first");
    expect(midTurnQueues.get("ch1")?.length).toBe(1);

    // Second agent_end re-wakes the next; queue fully drained.
    await handlers.agent_end({ messages: [] }, ctx);
    expect(sent.length).toBe(2);
    expect(sent[1].m.details.body).toBe("second");
    expect(midTurnQueues.has("ch1")).toBe(false);
  });

  test("mid-turn inbound with attachments keeps full context on re-wake", async () => {
    ctx.isIdle = () => false;
    const withAtt = inbound("look at this", "m200");
    withAtt.attachments = [
      { id: "a1", filename: "x.jpg", contentType: "image/jpeg", size: 100 },
    ];
    await handleInbound(pi, withAtt, ctx);
    expect(sent.length).toBe(0);
    expect(midTurnQueues.get("ch1")?.length).toBe(1);

    await handlers.agent_end({ messages: [] }, ctx);
    expect(sent.length).toBe(1);
    // The re-wake re-processed the message as a fresh inbound: the attachment
    // context block is present in the LLM content.
    expect(sent[0].m.content).toContain("x.jpg");
    expect(sent[0].m.details.body).toContain("look at this");
  });

  test("idle inbound is sent immediately, not queued", async () => {
    ctx.isIdle = () => true;
    await handleInbound(pi, inbound("hello", "m1"), ctx);
    expect(sent.length).toBe(1);
    expect(midTurnQueues.has("ch1")).toBe(false);
  });

  test("no double-processing: a busy inbound is queued, not also sent", async () => {
    ctx.isIdle = () => false;
    await handleInbound(pi, inbound("callback", "m1"), ctx);
    // Exactly one owner: queued (not sent now), and present in the queue.
    expect(sent.length).toBe(0);
    expect(midTurnQueues.get("ch1")?.length).toBe(1);
    await handlers.agent_end({ messages: [] }, ctx);
    // The re-wake sends it exactly once (not a second time).
    expect(sent.length).toBe(1);
  });

  describe("mid-run interrupt", () => {
    let abortCount: number;
    let idle: boolean;

    beforeEach(() => {
      jest.useFakeTimers();
      abortCount = 0;
      idle = false;
      // Model the real session: abort kills the run and it settles (idle).
      ctx.isIdle = () => idle;
      ctx.abort = () => {
        abortCount += 1;
        idle = true;
      };
      setInterruptCtx(ctx);
    });

    afterEach(() => {
      clearDiscordStatesForTest(); // no auto-react suppression leaks across tests
      resetRuntimeStateForTest(); // sessionStartTs/held/verbose: no leaks
      setInterruptCtx(null);
      clearAllInterrupts();
      pendingInterrupts.clear();
      queuedAcks.clear();
      jest.useRealTimers();
    });

    test("plain message during a run interrupts after the timeout (abort + fresh run)", async () => {
      expect(idle).toBe(false);
      await handleInbound(pi, inbound("redirect me", "m1"), ctx);
      expect(sent.length).toBe(0);
      expect(midTurnQueues.get("ch1")?.length).toBe(1);
      expect(pendingInterrupts.get("ch1")?.length).toBe(1);

      jest.advanceTimersByTime(interruptStepTimeoutMs() - 1);
      expect(abortCount).toBe(0);
      expect(sent.length).toBe(0);
      jest.advanceTimersByTime(1);

      // Force-delivered: in-flight step aborted, message sent as a fresh run
      // after the session settles.
      expect(abortCount).toBe(1);
      expect(sent.length).toBe(1);
      expect(sent[0].m.content).toContain("redirect me");
      expect(sent[0].m.details.body).toBe("redirect me");
      expect(sent[0].m.details.messageId).toBe("m1");
      expect(sent[0].o).toMatchObject({
        triggerTurn: true,
        deliverAs: "steer",
      });
      // Consumed from the re-wake queue: no second delivery at agent_end.
      expect(midTurnQueues.has("ch1")).toBe(false);
    });

    test("no duplicate delivery after interrupt (agent_end sees an empty queue)", async () => {
      await handleInbound(pi, inbound("redirect", "m1"), ctx);
      jest.advanceTimersByTime(interruptStepTimeoutMs());
      expect(sent.length).toBe(1);

      // The aborted run's agent_end: nothing queued, so no re-wake send.
      await handlers.agent_end({ messages: [] }, ctx);
      expect(sent.length).toBe(1);
      expect(midTurnQueues.has("ch1")).toBe(false);
    });

    test("aborted run from an interrupt posts no failure line", async () => {
      await handleInbound(pi, inbound("redirect", "m1"), ctx);
      jest.advanceTimersByTime(interruptStepTimeoutMs());
      expect(abortCount).toBe(1);

      // pi's aborted run ends with an empty assistant message shaped
      // stopReason "error" + errorMessage "This operation was aborted".
      // userStoppedRun suppresses the failure post for that shape.
      const fail = {
        role: "assistant",
        content: [{ type: "text", text: "" }],
        stopReason: "error",
        errorMessage: "This operation was aborted",
      };
      await handlers.agent_end({ messages: [fail] }, ctx);
      const posts = fetchCalls.filter(
        (c) => c.method === "POST" && c.url.endsWith("/messages"),
      );
      expect(
        posts.every(
          (p) => !String(JSON.parse(p.body).content).startsWith("[!]"),
        ),
      ).toBe(true);
    });

    test("no raw abort string reaches the send mock when the user-stopped flag raced", async () => {
      // The race: the interrupt sets the flag, then the re-wake's fresh
      // run starts (turn_start resets the flag) BEFORE the aborted run's
      // agent_end runs its failure check. The abort marker must still
      // suppress the post.
      await handleInbound(pi, inbound("redirect", "m1"), ctx);
      jest.advanceTimersByTime(interruptStepTimeoutMs());
      expect(abortCount).toBe(1);
      // The fresh run's turn_start reset the flag (mock pi never fires
      // it, so drive it here, in the real pi's ordering).
      await handlers.turn_start(null, ctx);

      const fail = {
        role: "assistant",
        content: [{ type: "text", text: "" }],
        stopReason: "error",
        errorMessage: "This operation was aborted",
      };
      await handlers.agent_end({ messages: [fail] }, ctx);
      const posts = fetchCalls.filter(
        (c) => c.method === "POST" && c.url.endsWith("/messages"),
      );
      expect(
        posts.every(
          (p) => !String(JSON.parse(p.body).content).includes("aborted"),
        ),
      ).toBe(true);
    });

    test("aborted run with a genuine API error still posts the short marker", async () => {
      await handleInbound(pi, inbound("redirect", "m1"), ctx);
      jest.advanceTimersByTime(interruptStepTimeoutMs());
      expect(abortCount).toBe(1);
      await handlers.turn_start(null, ctx); // flag raced to false

      const fail = {
        role: "assistant",
        content: [{ type: "text", text: "" }],
        stopReason: "error",
        errorMessage: "429 Too Many Requests",
      };
      await handlers.agent_end({ messages: [fail] }, ctx);
      const posts = fetchCalls.filter(
        (c) => c.method === "POST" && c.url.endsWith("/messages"),
      );
      expect(
        posts.some(
          (p) =>
            String(JSON.parse(p.body).content) ===
            styleGuard("rate limited, retrying"),
        ),
      ).toBe(true);
    });

    test("command during a run is NOT interrupted", async () => {
      await handleInbound(pi, inbound("/status", "m1"), ctx);
      expect(midTurnQueues.has("ch1")).toBe(false);
      expect(pendingInterrupts.has("ch1")).toBe(false);
      jest.advanceTimersByTime(interruptStepTimeoutMs() * 3);
      expect(abortCount).toBe(0);
      expect(sent.length).toBe(0);
    });

    test("PISCORD_INTERRUPT_STEP_TIMEOUT_MS is honored", async () => {
      process.env.PISCORD_INTERRUPT_STEP_TIMEOUT_MS = "500";
      try {
        expect(interruptStepTimeoutMs()).toBe(500);
        await handleInbound(pi, inbound("go", "m1"), ctx);
        jest.advanceTimersByTime(499);
        expect(abortCount).toBe(0);
        jest.advanceTimersByTime(1);
        expect(abortCount).toBe(1);
        expect(sent.length).toBe(1);
      } finally {
        delete process.env.PISCORD_INTERRUPT_STEP_TIMEOUT_MS;
      }
    });

    test("invalid env value falls back to the 3000ms default", async () => {
      process.env.PISCORD_INTERRUPT_STEP_TIMEOUT_MS = "not-a-number";
      try {
        expect(interruptStepTimeoutMs()).toBe(3000);
        await handleInbound(pi, inbound("go", "m1"), ctx);
        jest.advanceTimersByTime(2999);
        expect(abortCount).toBe(0);
        jest.advanceTimersByTime(1);
        expect(abortCount).toBe(1);
      } finally {
        delete process.env.PISCORD_INTERRUPT_STEP_TIMEOUT_MS;
      }
    });

    // ── arm window pins ────────────────────────────────────────────
    // Mid-settle (an interrupt already in flight) arms at the 4x (12s)
    // window — the rapid-fire cascade guard (the in-flight disjunct).
    // Every other mid-run inbound arms the 3s default (quick cut-in);
    // machine wakes arm nothing from #177 on (queue-only). The
    // queued message always has the guaranteed re-wake as fallback, so
    // the longer window only changes WHEN the interrupt cuts in, never
    // WHETHER it delivers. (2026-10-06 abort RCA: a mid-run reply armed
    // the 3s DEFAULT mid-settle and expired mid-REST-POST; the 4x
    // window now keys off the in-flight state, not the sender.)

    test("mid-settle inbound arms the 4x in-flight window; #124 order intact", async () => {
      // The settle window (an interrupt already in flight) arms at 4x
      // via the in-flight disjunct — the arm must not double, shorten,
      // or reorder the #124 delivery.
      expect(idle).toBe(false);
      const baseSends = sent.length;
      const baseAborts = abortCount;
      ctx.abort = () => {
        abortCount += 1;
      }; // slow settle: interrupt stays in flight across the window
      // 1. Human m1 mid-run: 3s arm, fires, settle polling begins.
      await handleInbound(pi, inbound("first", "m1"), ctx);
      jest.advanceTimersByTime(interruptStepTimeoutMs());
      await Promise.resolve();
      expect(abortCount).toBe(baseAborts + 1);
      expect(sent.length).toBe(baseSends); // still settling
      // 2. Inbound m2 arrives mid-settle (interrupt in flight): 4x arm.
      await handleInbound(pi, inbound("second", "m2"), ctx);
      expect(midTurnQueues.get("ch1")?.length).toBe(1);
      const armed = pendingInterrupts
        .get("ch1")
        ?.find((p) => p.messageId === "m2");
      expect(armed).toBeDefined();
      expect(
        Math.abs(armed!.at - Date.now() - interruptStepTimeoutMs() * 4),
      ).toBeLessThanOrEqual(1);
      // 3. A plain 3s elapse must NOT fire m2 (no early re-arm, no abort).
      jest.advanceTimersByTime(interruptStepTimeoutMs());
      await Promise.resolve();
      expect(abortCount).toBe(baseAborts + 1);
      expect(sent.length).toBe(baseSends);
      // 4. The run settles: m1 (the in-flight interrupt) gets the next run.
      idle = true;
      jest.advanceTimersByTime(25);
      await Promise.resolve();
      expect(sent.length).toBe(baseSends + 1);
      expect(sent[baseSends].m.details.messageId).toBe("m1");
      // 5. m1's re-wake run is now active; m2's 4x timer fires on schedule.
      idle = false;
      jest.advanceTimersByTime(interruptStepTimeoutMs() * 3 - 25);
      await Promise.resolve();
      expect(abortCount).toBe(baseAborts + 2);
      idle = true;
      jest.advanceTimersByTime(25);
      await Promise.resolve();
      expect(sent.length).toBe(baseSends + 2);
      expect(sent[baseSends + 1].m.details.messageId).toBe("m2");
      expect(midTurnQueues.has("ch1")).toBe(false);
    });

    test("machine wake (Author: pi-bg) is queue-only, arms nothing (#177)", async () => {
      expect(idle).toBe(false);
      const baseAborts = abortCount;
      const baseSends = sent.length;
      // the 2026-10-21 de-prefix shape: content "" + one embed whose
      // author starts pi-bg (the bridge-built body is the serialized
      // embed)
      const wake = {
        ...inbound(
          "<embed>\nAuthor: pi-bg etl \u00b7 t1\nTitle: etl \u00b7 OK\nresult: ticket\n</embed>",
          "bm1",
        ),
        from: "bg",
      };
      await handleInbound(pi, wake, ctx);
      // Queue-only: not the 3s default, not the 4x in-flight window.
      expect(midTurnQueues.get("ch1")?.length).toBe(1);
      expect(pendingInterrupts.has("ch1")).toBe(false);
      jest.advanceTimersByTime(interruptStepTimeoutMs() * 4);
      await Promise.resolve();
      expect(abortCount).toBe(baseAborts);
      expect(sent.length).toBe(baseSends);
      // The run ends → the re-wake queue owns delivery.
      idle = true;
      await handlers.agent_end({ messages: [] }, ctx);
      expect(sent.length).toBe(baseSends + 1);
      expect(sent[baseSends].m.details.messageId).toBe("bm1");
      expect(midTurnQueues.has("ch1")).toBe(false);
    });

    test("inbound with no run in flight delivers directly, arms no interrupt", async () => {
      idle = true; // no run in flight
      const baseSends = sent.length;
      const baseAborts = abortCount;
      await handleInbound(pi, inbound("idle inbound", "pi1"), ctx);
      // Not queued, not armed — straight to pi as a fresh run.
      expect(midTurnQueues.has("ch1")).toBe(false);
      expect(pendingInterrupts.has("ch1")).toBe(false);
      expect(sent.length).toBe(baseSends + 1);
      expect(sent[baseSends].m.details.messageId).toBe("pi1");
      // Nothing pending to fire at 3s or 12s.
      jest.advanceTimersByTime(interruptStepTimeoutMs() * 5);
      await Promise.resolve();
      expect(abortCount).toBe(baseAborts);
      expect(sent.length).toBe(baseSends + 1);
    });

    test("run that ends before the timeout: re-wake delivers, timer is a no-op", async () => {
      await handleInbound(pi, inbound("later", "m1"), ctx);
      idle = true; // the run ends
      await handlers.agent_end({ messages: [] }, ctx);
      expect(sent.length).toBe(1); // re-wake fired
      expect(midTurnQueues.has("ch1")).toBe(false);
      jest.advanceTimersByTime(interruptStepTimeoutMs() + 1000);
      expect(sent.length).toBe(1); // timer found no entry, no double send
      expect(abortCount).toBe(0);
    });

    test("/stop clears armed interrupts", async () => {
      await handleInbound(pi, inbound("x", "m1"), ctx);
      expect(pendingInterrupts.get("ch1")?.length).toBe(1);
      await handleInbound(pi, inbound("/stop", "m2"), ctx);
      expect(pendingInterrupts.has("ch1")).toBe(false);
      expect(abortCount).toBe(1); // /stop's own abort
      jest.advanceTimersByTime(interruptStepTimeoutMs() + 1000);
      expect(abortCount).toBe(1); // no interrupt abort
      expect(sent.length).toBe(0);
    });

    test("interrupt does not fire when pi is idle at timer time", async () => {
      await handleInbound(pi, inbound("x", "m1"), ctx);
      idle = true; // run settled before the timer fires
      jest.advanceTimersByTime(interruptStepTimeoutMs());
      expect(abortCount).toBe(0);
      expect(sent.length).toBe(0);
      // message stays in the re-wake queue, owned by agent_end
      expect(midTurnQueues.get("ch1")?.length).toBe(1);
    });

    test("interrupt waits for a slow settle before sending", async () => {
      // abort does NOT settle immediately — the wait loop must poll isIdle
      ctx.abort = () => {
        abortCount += 1;
      };
      await handleInbound(pi, inbound("slow", "m1"), ctx);
      jest.advanceTimersByTime(interruptStepTimeoutMs());
      await Promise.resolve();
      expect(abortCount).toBe(1);
      expect(sent.length).toBe(0); // not sent while the run is still settling
      // settle after 2 polls (microtask flush after each fake-timer advance)
      jest.advanceTimersByTime(50);
      await Promise.resolve();
      idle = true;
      jest.advanceTimersByTime(25);
      await Promise.resolve();
      expect(sent.length).toBe(1);
      expect(sent[0].m.details.messageId).toBe("m1");
    });

    test("settle beyond the cap leaves the message to the re-wake queue", async () => {
      // abort never settles: the poll loop must hit its 120 s cap, restore
      // the entry (FIFO position) and let the re-wake path own it — never
      // steer into a still-active run (the lossy path).
      ctx.abort = () => {
        abortCount += 1;
      };
      await handleInbound(pi, inbound("stuck", "m1"), ctx);
      // 120 x 25 ms covers the interrupt arm; 4800 x 25 ms is the poll cap.
      for (let i = 0; i < 4925; i++) {
        jest.advanceTimersByTime(25);
        await Promise.resolve();
      }
      expect(abortCount).toBe(1);
      expect(sent.length).toBe(0);
      const q = midTurnQueues.get("ch1");
      expect(q?.length).toBe(1);
      expect(q?.[0].msg.messageId).toBe("m1");
    });

    test("re-wake yields to an in-flight interrupt; deferred entry re-wakes after the interrupt run", async () => {
      // Slow settle: the abort does NOT settle the run immediately, so the
      // interrupt stays in flight across the aborted run's agent_end — the
      // real pi ordering (pi awaits the agent_end handler before clearing
      // the run-active flag).
      ctx.abort = () => {
        abortCount += 1;
      };
      await handleInbound(pi, inbound("first queued msg", "m1"), ctx);
      // m1's interrupt fires and starts its settle wait (run still active).
      jest.advanceTimersByTime(interruptStepTimeoutMs());
      await Promise.resolve();
      expect(abortCount).toBe(1);
      expect(sent.length).toBe(0); // settle still polling
      // A second message arrives mid-settle: queued + armed.
      await handleInbound(pi, inbound("second queued msg", "m2"), ctx);
      expect(midTurnQueues.get("ch1")?.length).toBe(1);
      // The aborted run's agent_end lands while m1's interrupt is in
      // flight: the re-wake DEFERS — m2 stays queued, no run starts, no
      // send. (Before the fix this started m2's full run, which held
      // isIdle() false and ate m1's 120 s settle cap — the 2026-09-30
      // incident.)
      await handlers.agent_end({ messages: [] }, ctx);
      expect(sent.length).toBe(0);
      expect(midTurnQueues.get("ch1")?.length).toBe(1);
      expect(midTurnQueues.get("ch1")?.[0].msg.messageId).toBe("m2");
      // The run settles: the interrupt message gets the next run.
      idle = true;
      jest.advanceTimersByTime(25);
      await Promise.resolve();
      expect(sent.length).toBe(1);
      expect(sent[0].m.details.messageId).toBe("m1");
      // The interrupt run ends: the deferred entry re-wakes in order.
      await handlers.agent_end({ messages: [] }, ctx);
      expect(sent.length).toBe(2);
      expect(sent[1].m.details.messageId).toBe("m2");
      expect(midTurnQueues.has("ch1")).toBe(false);
    });

    test("/stop during the settle window drops the pending send", async () => {
      ctx.abort = () => {
        abortCount += 1;
      }; // does not settle immediately
      await handleInbound(pi, inbound("redirect me", "m1"), ctx);
      jest.advanceTimersByTime(interruptStepTimeoutMs());
      await Promise.resolve();
      expect(abortCount).toBe(1);
      expect(sent.length).toBe(0);
      // /stop while the settle wait is pending
      await handleInbound(pi, inbound("/stop", "m2"), ctx);
      jest.advanceTimersByTime(25);
      await Promise.resolve();
      expect(sent.length).toBe(0); // send dropped, entry not restored
      expect(midTurnQueues.has("ch1")).toBe(false);
    });

    test("/stop while idle does not poison later interrupts (F7 guard)", async () => {
      // /stop with no in-flight interrupt must not set the cancel flag
      idle = true;
      await handleInbound(pi, inbound("/stop", "m0"), ctx);
      // A run becomes active; a plain message is queued and armed
      idle = false;
      await handleInbound(pi, inbound("m9 message", "m9"), ctx);
      expect(pendingInterrupts.get("ch1")?.length).toBe(1);
      // Timer fires while the run is still active: the interrupt must be
      // delivered, not dropped by a stale flag (abort mock settles at once)
      jest.advanceTimersByTime(interruptStepTimeoutMs());
      await Promise.resolve();
      expect(abortCount).toBe(1);
      expect(sent.length).toBe(1);
      expect(sent[0].m.details.messageId).toBe("m9");
    });

    test("a dropped interrupt does not poison later interrupts (F7 consume)", async () => {
      ctx.abort = () => {
        abortCount += 1;
      }; // does not settle immediately
      // Relative zero-asserts (MEDIUM-1, review 3005244): a late
      // send/abort leaked from a prior test lands in this test's shared
      // `sent` binding / abortCount — only GROWTH during this test's
      // window counts.
      const baseSends = sent.length;
      const baseAborts = abortCount;
      await handleInbound(pi, inbound("first", "m1"), ctx);
      jest.advanceTimersByTime(interruptStepTimeoutMs());
      await Promise.resolve();
      expect(abortCount).toBe(baseAborts + 1);
      // /stop during the settle window: drops m1 AND consumes the flag
      await handleInbound(pi, inbound("/stop", "m2"), ctx);
      jest.advanceTimersByTime(25);
      await Promise.resolve();
      expect(sent.length).toBe(baseSends);
      // Run still active; m3 is queued and armed. While m1's cancel poll
      // still holds the in-flight flag (it waits for the settle so its
      // re-wake kick cannot race the agent_end window, #124), m3's
      // interrupt is DEFERRED like any in-flight one (re-armed, long
      // delay) — not dropped. Its delivery is guaranteed by the settle
      // the poll is waiting for.
      await handleInbound(pi, inbound("third", "m3"), ctx);
      // The run settles: m1's cancel poll exits and kicks m3 (the oldest
      // queued entry) — delivered exactly once, no second abort.
      idle = true;
      jest.advanceTimersByTime(25);
      await Promise.resolve();
      await flushUntil(() =>
        sent.some((s) => s.m?.details?.messageId === "m3"),
      );
      expect(sent.length).toBe(baseSends + 1);
      expect(sent.some((s) => s.m?.details?.messageId === "m3")).toBe(true);
      expect(abortCount).toBe(baseAborts + 2); // m1's abort + /stop's abort
      // m3's armed interrupt (4x delay while the flag was held) later
      // finds pi idle and the queue empty: no double send, no spurious
      // abort.
      jest.advanceTimersByTime(interruptStepTimeoutMs() * 5);
      await Promise.resolve();
      for (let i = 0; i < 10; i++)
        await new Promise<void>((r) => setImmediate(r));
      expect(sent.length).toBe(baseSends + 1);
      expect(abortCount).toBe(baseAborts + 2);
    });

    test("/status shows the armed interrupt state", async () => {
      ctx.isIdle = () => false;
      await handleInbound(pi, inbound("x", "m1"), ctx);
      await handleInbound(pi, inbound("/status", "m2"), ctx);
      const posts = fetchCalls.filter(
        (c) => c.method === "POST" && c.url.endsWith("/messages"),
      );
      const statusPost = posts
        .map((p) => String(JSON.parse(p.body).content))
        .find((t) => t.includes("running"));
      expect(statusPost).toBeDefined();
      expect(statusPost).toContain("interrupt in ");
    });

    // ── Interrupt tick lifecycle (ack message is the tick target) ────
    const ackFlush = async () => {
      for (let i = 0; i < 20; i++) await Promise.resolve();
    };

    test("tick: success path settles the tick before the ack delete", async () => {
      verboseOverride.set("ch1", 1); // verbose 1: the [queued] ack posts
      await handlers.session_start?.(null, ctx); // configRoot for ack REST
      await handleInbound(pi, inbound("redirect me", "m1"), ctx);
      await ackFlush(); // ack post resolves -> tick armed on the ack id
      const ackId = queuedAcks.get("m1")?.ackId;
      expect(ackId).toBeDefined();

      jest.advanceTimersByTime(interruptStepTimeoutMs());
      await ackFlush();
      expect(abortCount).toBe(1);
      expect(sent.length).toBe(1);

      // The final edit (settle) must land on the ack BEFORE the delete:
      // a PATCH after the DELETE would re-create the message with a stale
      // line that nothing cleans up. Op status is prose — unfenced (v4).
      const settleIdx = fetchCalls.findIndex(
        (c) =>
          c.method === "PATCH" &&
          c.url.includes(`/channels/ch1/messages/${ackId}`) &&
          String(JSON.parse(c.body).content) === "interrupted",
      );
      const deleteIdx = fetchCalls.findIndex(
        (c) =>
          c.method === "DELETE" &&
          c.url.endsWith(`/channels/ch1/messages/${ackId}`),
      );
      expect(settleIdx).toBeGreaterThanOrEqual(0);
      expect(deleteIdx).toBeGreaterThan(settleIdx);
    });

    test("tick: cancel path settles the tick before the ack delete", async () => {
      verboseOverride.set("ch1", 1); // verbose 1: the [queued] ack posts
      await handlers.session_start?.(null, ctx); // configRoot for ack REST
      ctx.abort = () => {
        abortCount += 1;
      }; // does not settle immediately
      await handleInbound(pi, inbound("redirect me", "m1"), ctx);
      await ackFlush();
      const ackId = queuedAcks.get("m1")?.ackId;
      expect(ackId).toBeDefined();

      jest.advanceTimersByTime(interruptStepTimeoutMs());
      await ackFlush();
      expect(abortCount).toBe(1);
      // /stop while the settle wait is pending: cancels the in-flight
      // interrupt (its ack must be cleaned up, tick settled first).
      await handleInbound(pi, inbound("/stop", "m2"), ctx);
      jest.advanceTimersByTime(25);
      await ackFlush();
      expect(sent.length).toBe(0); // send dropped

      const settleIdx = fetchCalls.findIndex(
        (c) =>
          c.method === "PATCH" &&
          c.url.includes(`/channels/ch1/messages/${ackId}`) &&
          String(JSON.parse(c.body).content) === "interrupted",
      );
      const deleteIdx = fetchCalls.findIndex(
        (c) =>
          c.method === "DELETE" &&
          c.url.endsWith(`/channels/ch1/messages/${ackId}`),
      );
      expect(settleIdx).toBeGreaterThanOrEqual(0);
      expect(deleteIdx).toBeGreaterThan(settleIdx);
      // tick is gone: no tick edit can re-create the deleted ack
      expect(settleOpTick(`interrupt:ch1`, "[probe]")).toBe(false);
    });

    test("tick: settle-cap path settles the tick back to the queued line (#84 L1)", async () => {
      verboseOverride.set("ch1", 1); // verbose 1: the [queued] ack posts
      await handlers.session_start?.(null, ctx); // configRoot for ack REST
      ctx.abort = () => {
        abortCount += 1;
      }; // never settles: the poll loop must hit its 120 s cap
      await handleInbound(pi, inbound("stuck", "m1"), ctx);
      await ackFlush();
      const ackId = queuedAcks.get("m1")?.ackId;
      expect(ackId).toBeDefined();

      // 120 x 25 ms covers the interrupt arm; 4800 x 25 ms is the poll cap.
      for (let i = 0; i < 4925; i++) {
        jest.advanceTimersByTime(25);
        await Promise.resolve();
      }
      await ackFlush();
      expect(abortCount).toBe(1);
      expect(sent.length).toBe(0);
      // entry restored to the re-wake queue (existing behavior)
      expect(midTurnQueues.get("ch1")?.[0]?.msg.messageId).toBe("m1");

      const ackPatches = fetchCalls
        .filter(
          (c) =>
            c.method === "PATCH" &&
            c.url.includes(`/channels/ch1/messages/${ackId}`),
        )
        .map((c) => String(JSON.parse(c.body).content));
      // the tick moved while the settle wait ran (one-line status = prose,
      // no fence, v4 §2.3)...
      expect(ackPatches).toContain("[..] interrupting… 5s");
      // ...but the cap path SETTLES the tick back to the queued line (the
      // message's TRUE state — an interrupt did not happen), NOT a frozen
      // mid-interrupt line (#84 L1)...
      expect(ackPatches.at(-1)).toBe("[queued] 1 in line");
      expect(ackPatches).not.toContain("interrupted");
      // ...and the ack is NOT deleted (it stays with the queued entry).
      expect(
        fetchCalls.some(
          (c) =>
            c.method === "DELETE" &&
            c.url.endsWith(`/channels/ch1/messages/${ackId}`),
        ),
      ).toBe(false);
      // tick is gone: advancing further must not edit the ack again
      expect(settleOpTick(`interrupt:ch1`, "[probe]")).toBe(false);
      const patchesBefore = ackPatches.length;
      jest.advanceTimersByTime(10000);
      await ackFlush();
      const ackPatchesAfter = fetchCalls.filter(
        (c) =>
          c.method === "PATCH" &&
          c.url.includes(`/channels/ch1/messages/${ackId}`),
      ).length;
      expect(ackPatchesAfter).toBe(patchesBefore);
    });

    // ── Queue ack + interrupt verbosity (2026-10-20) ──────────────────
    // Verbose 0: the "[queued] N in line" ack and the mid-run interrupt
    // (which only ticks that ack) are SILENT. Verbose 1+: both post.
    // The entry always queues (and re-wakes) - only the line changes.
    test("verbose 0 (default): mid-run inbound queues silently - no [queued] line, no interrupt tick, entry still delivered", async () => {
      // The default fixture channel has no forwardToolCalls: level 0.
      expect(verboseLevel(loadChannelConfig(ctx.cwd)[0]!)).toBe(0);
      await handleInbound(pi, inbound("redirect me", "m1"), ctx);
      await ackFlush();
      // Queued for the re-wake, but the ack line never posts.
      expect(midTurnQueues.get("ch1")?.length).toBe(1);
      expect(queuedAcks.has("m1")).toBe(false);
      const ackPosts = fetchCalls.filter(
        (c) =>
          c.method === "POST" &&
          c.url.endsWith("/channels/ch1/messages") &&
          String(JSON.parse(c.body).content).includes("in line"),
      );
      expect(ackPosts.length).toBe(0);

      // The interrupt fires: no ack to tick, so it is fully silent -
      // no tick edit, no settle post - and the entry still goes through
      // as a fresh run.
      jest.advanceTimersByTime(interruptStepTimeoutMs());
      await ackFlush();
      expect(abortCount).toBe(1);
      expect(sent.length).toBe(1);
      expect(
        fetchCalls.some(
          (c) =>
            c.method === "PATCH" && c.url.includes("/channels/ch1/messages/"),
        ),
      ).toBe(false);
      expect(
        fetchCalls.some(
          (c) =>
            c.method === "POST" &&
            c.url.endsWith("/channels/ch1/messages") &&
            String(JSON.parse(c.body).content).includes("interrupt"),
        ),
      ).toBe(false);
    });

    test("verbose 1: mid-run inbound posts the [queued] line and the interrupt settles it", async () => {
      verboseOverride.set("ch1", 1);
      await handlers.session_start?.(null, ctx); // configRoot for ack REST
      await handleInbound(pi, inbound("redirect me", "m1"), ctx);
      await ackFlush();
      const ackId = queuedAcks.get("m1")?.ackId;
      expect(ackId).toBeDefined();
      expect(
        fetchCalls.some(
          (c) =>
            c.method === "POST" &&
            c.url.endsWith("/channels/ch1/messages") &&
            String(JSON.parse(c.body).content) === "[queued] 1 in line",
        ),
      ).toBe(true);

      // The interrupt settles the ack in place (the one visible edit).
      jest.advanceTimersByTime(interruptStepTimeoutMs());
      await ackFlush();
      expect(abortCount).toBe(1);
      expect(sent.length).toBe(1);
      const ackPatches = fetchCalls
        .filter(
          (c) =>
            c.method === "PATCH" &&
            c.url.includes(`/channels/ch1/messages/${ackId}`),
        )
        .map((c) => String(JSON.parse(c.body).content));
      expect(ackPatches).toContain("interrupted");
    });
  });

  describe("mid-run interrupt (#177 machine-wake queue-only)", () => {
    // #177: machine-wake webhook inbounds (pi-bg callbacks - the
    // `Author: pi-bg` embed author, or legacy `[bg:` content -
    // dead-letter re-posts, not-yet-restyled cross-repo producers) ride
    // the re-wake queue and deliver at agent_end; they arm NO mid-run
    // interrupt — the queue already guarantees delivery, the interrupt
    // only jumps the line, and a machine alert is never more urgent than
    // the in-flight turn. Human 3s arming and peer-bot 12s arming
    // (#165/#175) are untouched; a later human cut-in still arms even
    // with a machine-wake entry queued ahead of it.
    let abortCount: number;
    let idle: boolean;

    beforeEach(() => {
      jest.useFakeTimers();
      abortCount = 0;
      idle = false;
      // Model the real session: abort kills the run and it settles (idle).
      ctx.isIdle = () => idle;
      ctx.abort = () => {
        abortCount += 1;
        idle = true;
      };
      setInterruptCtx(ctx);
    });

    afterEach(() => {
      clearDiscordStatesForTest(); // no auto-react suppression leaks across tests
      resetRuntimeStateForTest(); // sessionStartTs/held/verbose: no leaks
      setInterruptCtx(null);
      clearAllInterrupts();
      pendingInterrupts.clear();
      queuedAcks.clear();
      jest.useRealTimers();
    });

    test("isBgInbound classifies the machine-wake shapes (legacy [bg: prefix + Author: pi-bg embed marker)", () => {
      expect(isBgInbound(inbound("[bg:worker:OK] x", "1"))).toBe(true);
      expect(isBgInbound(inbound("  [bg:etl] y", "2"))).toBe(true);
      expect(isBgInbound(inbound("[bg] no colon", "3"))).toBe(false);
      expect(isBgInbound(inbound("plain", "4"))).toBe(false);
      expect(isBgInbound(inbound("see [bg: ticket", "5"))).toBe(false);
      // the 2026-10-21 de-prefix shape: content "" + embed author pi-bg
      // (serializeEmbeds renders it as "Author: pi-bg …")
      expect(
        isBgInbound(
          inbound("<embed>\nAuthor: pi-bg ticket \u00b7 r1\n</embed>", "6"),
        ),
      ).toBe(true);
    });

    test("[bg:pat] tap wake mid-run: queued, no arm, delivered at agent_end (#220)", async () => {
      // The wake is posted via the dispatch webhook — to the gateway it
      // is a bot-authored message (Beepy-style), like the [bg: callback.
      // Legacy `[bg:` content shape (producer outside this repo - restyle
      // lands with the migration arm's one-release window).
      const body =
        "[bg:pat] approved pat_a (monky, triage) — claim within 60s: jarate pat-run pat_a -- <cmd>";
      const msg = {
        ...inbound(body, "wke1"),
        from: "Beepy",
        fromId: "1546769099252695103",
      };
      const baseSends = sent.length;
      const baseAborts = abortCount;
      const baseTimers = pendingInterrupts.size;
      await handleInbound(pi, msg, ctx);
      // Queued for the guaranteed re-wake...
      expect(midTurnQueues.get("ch1")?.length).toBe(1);
      // ...but nothing armed: the timer count is unchanged.
      expect(pendingInterrupts.size).toBe(baseTimers);
      expect(pendingInterrupts.has("ch1")).toBe(false);
      jest.advanceTimersByTime(interruptStepTimeoutMs() * 2);
      await Promise.resolve();
      expect(abortCount).toBe(baseAborts);
      expect(sent.length).toBe(baseSends);
      // The run ends → the re-wake queue owns delivery.
      idle = true;
      await handlers.agent_end({ messages: [] }, ctx);
      expect(sent.length).toBe(baseSends + 1);
      expect(sent[baseSends].m.details.body).toBe(body);
      expect(sent[baseSends].m.details.messageId).toBe("wke1");
      expect(midTurnQueues.has("ch1")).toBe(false);
    });

    test("legacy [bg: content inbound mid-run: no interrupt armed (migration arm, one release), delivered at agent_end via re-wake", async () => {
      const baseSends = sent.length;
      const baseAborts = abortCount;
      const baseTimers = pendingInterrupts.size;
      await handleInbound(
        pi,
        inbound("[bg:worker:OK] task 42 done", "bm1"),
        ctx,
      );
      // Queued for the guaranteed re-wake...
      expect(midTurnQueues.get("ch1")?.length).toBe(1);
      // ...but nothing armed: the timer count is unchanged.
      expect(pendingInterrupts.size).toBe(baseTimers);
      expect(pendingInterrupts.has("ch1")).toBe(false);
      // The 3s point (and beyond) passes with no abort, no early delivery.
      jest.advanceTimersByTime(interruptStepTimeoutMs() * 2);
      await Promise.resolve();
      expect(abortCount).toBe(baseAborts);
      expect(sent.length).toBe(baseSends);
      // The run ends → the re-wake queue owns delivery.
      idle = true;
      await handlers.agent_end({ messages: [] }, ctx);
      expect(sent.length).toBe(baseSends + 1);
      expect(sent[baseSends].m.details.body).toBe(
        "[bg:worker:OK] task 42 done",
      );
      expect(sent[baseSends].m.details.messageId).toBe("bm1");
      expect(midTurnQueues.has("ch1")).toBe(false);
    });

    test("embed-only pi-bg callback (content='', Author: pi-bg) mid-run: queued, no arm, delivered at agent_end — EXACT lost-callback shape (2026-10-06, ticket 3580612)", async () => {
      // The standard pi-bg completion callback is embed-only by
      // construction (content='', embed author "pi-bg ticket · <rid>") -
      // and since 2026-10-21 the de-prefix shape of EVERY jarate
      // producer. Legacy "[bg:" content (in-flight posts, dead letters,
      // not-yet-restyled cross-repo producers) is the other arm.
      // The bridge-built body is the serialized embed — no "[bg:" prefix
      // anywhere. The 2026-10-06 incident lost EXACTLY this shape
      // (msg 1556883632919150653, Beepy webhook author, mid-run):
      // pre-fix isBgInbound missed it and the 3s interrupt armed + was
      // lost at compact.
      const body = [
        "<embed>",
        "Author: pi-bg ticket · 20261006-040516-3580612",
        "Title: reviewer · PASS · 14m27s",
        "```bash",
        "┌ jarate-bg 20261006-040516-3580612",
        "└",
        "```",
        "task: adversarially review marzukia/jarate PR #179",
        "result: VERDICT: PASS (pack: /var/tmp/reviews/pr-179-result.md)",
        "Footer: pi-bg",
        "</embed>",
      ].join("\n");
      const baseSends = sent.length;
      const baseAborts = abortCount;
      const baseTimers = pendingInterrupts.size;
      // Beepy-style author: a webhook bot.
      const msg = {
        ...inbound(body, "1556883632919150653"),
        from: "Beepy",
        fromId: "1546769099252695103",
      };
      await handleInbound(pi, msg, ctx);
      // Queued for the guaranteed re-wake (depth +1)...
      expect(midTurnQueues.get("ch1")?.length).toBe(1);
      // ...but NO timer armed (arm count unchanged, nothing pending for
      // ch1) — the embed-only shape is a machine wake like the [bg:
      // prefix shape.
      expect(pendingInterrupts.size).toBe(baseTimers);
      expect(pendingInterrupts.has("ch1")).toBe(false);
      // The 3s point (and beyond) passes with no abort, no early
      // delivery: the in-flight run survives intact.
      jest.advanceTimersByTime(interruptStepTimeoutMs() * 2);
      await Promise.resolve();
      expect(abortCount).toBe(baseAborts);
      expect(sent.length).toBe(baseSends);
      // The run ends → the re-wake queue owns delivery.
      idle = true;
      await handlers.agent_end({ messages: [] }, ctx);
      expect(sent.length).toBe(baseSends + 1);
      expect(sent[baseSends].m.details.body).toBe(body);
      expect(sent[baseSends].m.details.messageId).toBe("1556883632919150653");
      expect(midTurnQueues.has("ch1")).toBe(false);
    });

    test("legacy [bg: content inbound idle: immediate delivery, nothing queued or armed (regression pin)", async () => {
      const baseSends = sent.length;
      const baseAborts = abortCount;
      idle = true; // no run in flight
      await handleInbound(
        pi,
        inbound("[bg:worker:OK] task 43 done", "bm2"),
        ctx,
      );
      // Straight to pi as a fresh run: the delivery path is unchanged.
      expect(midTurnQueues.has("ch1")).toBe(false);
      expect(pendingInterrupts.has("ch1")).toBe(false);
      expect(sent.length).toBe(baseSends + 1);
      expect(sent[baseSends].m.details.messageId).toBe("bm2");
      // Nothing pending to fire later.
      jest.advanceTimersByTime(interruptStepTimeoutMs() * 2);
      await Promise.resolve();
      expect(sent.length).toBe(baseSends + 1);
      expect(abortCount).toBe(baseAborts);
    });

    test("human inbound mid-run: 3s arm (regression pin)", async () => {
      const baseSends = sent.length;
      const baseAborts = abortCount;
      await handleInbound(pi, inbound("human mid-run", "hm1"), ctx);
      expect(midTurnQueues.get("ch1")?.length).toBe(1);
      const armed = pendingInterrupts.get("ch1")?.[0];
      expect(armed).toBeDefined();
      expect(armed!.messageId).toBe("hm1");
      expect(
        Math.abs(armed!.at - Date.now() - interruptStepTimeoutMs()),
      ).toBeLessThanOrEqual(1);
      // Fires at the 3s point: the quick cut-in is intact.
      jest.advanceTimersByTime(interruptStepTimeoutMs());
      await Promise.resolve();
      expect(abortCount).toBe(baseAborts + 1);
      expect(sent.length).toBe(baseSends + 1);
      expect(sent[baseSends].m.details.messageId).toBe("hm1");
    });

    test("human arriving mid-run after a machine wake (Author: pi-bg) was queued: still arms (the queue does not suppress later human cuts)", async () => {
      const baseSends = sent.length;
      const baseAborts = abortCount;
      // 1. Machine wake (the 2026-10-21 de-prefix shape) lands mid-run:
      // queued, no arm.
      const wakeBody =
        "<embed>\nAuthor: pi-bg worker \u00b7 r44\nTitle: worker \u00b7 OK\nresult: task 44 done\n</embed>";
      await handleInbound(pi, inbound(wakeBody, "bm1"), ctx);
      expect(midTurnQueues.get("ch1")?.length).toBe(1);
      expect(pendingInterrupts.has("ch1")).toBe(false);
      // 2. Human arrives while the wake is queued: the cut-in still arms.
      await handleInbound(pi, inbound("human cut", "hm1"), ctx);
      expect(midTurnQueues.get("ch1")?.length).toBe(2);
      const armed = pendingInterrupts
        .get("ch1")
        ?.find((p) => p.messageId === "hm1");
      expect(armed).toBeDefined();
      expect(
        Math.abs(armed!.at - Date.now() - interruptStepTimeoutMs()),
      ).toBeLessThanOrEqual(1);
      // 3. The 3s point fires: the HUMAN's message is force-delivered...
      jest.advanceTimersByTime(interruptStepTimeoutMs());
      await Promise.resolve();
      expect(abortCount).toBe(baseAborts + 1);
      expect(sent.length).toBe(baseSends + 1);
      expect(sent[baseSends].m.details.messageId).toBe("hm1");
      // ...and the machine-wake entry stays queued for its agent_end
      // re-wake.
      expect(midTurnQueues.get("ch1")?.length).toBe(1);
      expect(midTurnQueues.get("ch1")?.[0]?.msg.messageId).toBe("bm1");
    });
  });

  describe("mid-run interrupt (two channels)", () => {
    let abortCount: number;
    let idle: boolean;

    // Two-channel variant of the `inbound` helper: channelId selects the
    // fixture channel (ch1 = interrupted, ch2 = the entry at risk).
    const inboundCh = (
      body: string,
      id: string,
      channelId = "ch1",
    ): ChannelMessage => ({
      channelId,
      channelName: channelId === "ch1" ? "Test" : "Test2",
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
      jest.useFakeTimers();
      abortCount = 0;
      idle = false;
      // Two-channel settings fixture (ch1 + ch2, both owned by "uid").
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
              name: "Test2",
              type: "discord",
              botToken: "tok2",
              ownerUserId: "uid",
              ack: true,
            },
          ],
        }),
      );
      // Re-run the extension so handler closures (the re-wake
      // handleInbound, pi.sendMessage) target this fixture.
      handlers = {};
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
      // Slow settle: the abort does NOT settle the run immediately, so
      // the interrupt stays in flight across the aborted run's agent_end
      // (the real pi ordering: pi awaits the agent_end handler before
      // clearing the run-active flag).
      ctx.isIdle = () => idle;
      ctx.abort = () => {
        abortCount += 1;
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

    test("/stop in the deferral window re-wakes the cross-channel queued entry (cancel-branch kick)", async () => {
      await handlers.session_start?.(null, ctx); // configRoot for ack REST
      expect(idle).toBe(false);
      // Relative zero-asserts (MEDIUM-1, review 3005244): a late send
      // from a prior test can land in this test's shared `sent` binding
      // — only GROWTH during this test's window counts.
      const baseSends = sent.length;
      const baseAborts = abortCount;
      // 1. m1 (ch1) arrives mid-run: queued, interrupt armed.
      await handleInbound(pi, inboundCh("m1 body", "m1"), ctx);
      // 2. m1's interrupt fires: abort in flight, settle polling — the
      //    run is still active, so no send yet.
      jest.advanceTimersByTime(interruptStepTimeoutMs());
      await Promise.resolve();
      expect(abortCount).toBe(baseAborts + 1);
      expect(sent.length).toBe(baseSends);
      // 3. m2 (ch2) arrives mid-settle: queued in a DIFFERENT channel —
      //    the entry the deferred agent_end should re-wake.
      await handleInbound(pi, inboundCh("m2 body", "m2", "ch2"), ctx);
      expect(midTurnQueues.get("ch2")?.length).toBe(1);
      // 4. The aborted run's agent_end lands while m1's interrupt is in
      //    flight: the re-wake DEFERS — m2 stays queued, no run starts,
      //    no send.
      await handlers.agent_end({ messages: [] }, ctx);
      expect(sent.length).toBe(baseSends);
      expect(midTurnQueues.get("ch2")?.length).toBe(1);
      // 5. The run settles and /stop on ch1 wins the race: the interrupt
      //    send is dropped at the next settle tick. /stop clears only
      //    ch1's queue — m2 (ch2) is NOT cleared, and with the interrupt
      //    dropped there is no run left to re-wake it.
      idle = true;
      await handleInbound(pi, inboundCh("/stop", "m3"), ctx);
      jest.advanceTimersByTime(25);
      await Promise.resolve();
      // m1's send never happened. Assert on m1's id, not total growth:
      // the cancel-branch kick's m2 send can land inside this window
      // (no I/O hop before send on the plain path).
      expect(sent.some((s) => s.m?.details?.messageId === "m1")).toBe(false);
      expect(midTurnQueues.has("ch1")).toBe(false);
      // The cancel branch's re-wake kick runs handleInbound for m2
      // fire-and-forget: wait for it on the bounded clock-time budget
      // (flushUntil), not a fixed hop count.
      await flushUntil(() =>
        sent.some((s) => s.m?.details?.messageId === "m2"),
      );
      // 6. m2 was re-woken by the cancel branch: no orphaned entry with a
      //    stale [queued] ack (fails without the kick).
      expect(sent.some((s) => s.m?.details?.messageId === "m2")).toBe(true);
      expect(midTurnQueues.has("ch2")).toBe(false);
      expect(sent.length).toBe(baseSends + 1);
      // m2's own armed interrupt now finds pi idle and the queue empty:
      // no double send, no spurious abort.
      jest.advanceTimersByTime(interruptStepTimeoutMs());
      await Promise.resolve();
      expect(sent.length).toBe(baseSends + 1);
      expect(abortCount).toBe(baseAborts + 1);
    });

    test("/stop INSIDE the agent_end handler window re-wakes the cross-channel entry exactly once (#124)", async () => {
      await handlers.session_start?.(null, ctx); // configRoot for ack REST
      expect(idle).toBe(false);
      // Relative zero-asserts (MEDIUM-1, review 3005244): a late send
      // from a prior test can land in this test's shared `sent` binding
      // — only GROWTH during this test's window counts.
      const baseSends = sent.length;
      const baseAborts = abortCount;
      // 1. m1 (ch1) arrives mid-run: queued, interrupt armed.
      await handleInbound(pi, inboundCh("m1 body", "m1"), ctx);
      // 2. m1's interrupt fires: abort in flight, settle polling — the
      //    run is still active, so no send yet.
      jest.advanceTimersByTime(interruptStepTimeoutMs());
      await Promise.resolve();
      expect(abortCount).toBe(baseAborts + 1);
      expect(sent.length).toBe(baseSends);
      // 3. m2 (ch2) arrives mid-settle: queued in a DIFFERENT channel —
      //    the entry the deferred agent_end should re-wake.
      await handleInbound(pi, inboundCh("m2 body", "m2", "ch2"), ctx);
      expect(midTurnQueues.get("ch2")?.length).toBe(1);
      // 4. The aborted run's agent_end starts carrying a real final: the
      //    re-wake DEFERS (interrupt in flight), then the handler suspends
      //    on the final's Discord POST. That models the real pi ordering:
      //    the deferral decision is made, but pi clears the run flag only
      //    in _emitAgentSettled — AFTER the awaited handler resolves. The
      //    orphan window is exactly this suspension.
      let resolveFinal: (() => void) | undefined;
      const finalGate = new Promise<void>((r) => (resolveFinal = r));
      const prevFetch = globalThis.fetch;
      globalThis.fetch = (async (url: any, init?: any) => {
        const body = init?.body ? JSON.parse(String(init.body)) : null;
        const isFinalPost =
          init?.method === "POST" &&
          typeof body?.content === "string" &&
          body.content.includes("final answer");
        if (isFinalPost) await finalGate;
        return prevFetch(url, init);
      }) as any;
      const logs: string[] = [];
      const realLog = console.log;
      console.log = (...args: unknown[]) => {
        logs.push(args.map(String).join(" "));
      };
      try {
        const ae = handlers.agent_end(
          {
            messages: [
              {
                role: "assistant",
                content: [{ type: "text", text: "final answer" }],
              },
            ],
          },
          ctx,
        );
        // Flush until the deferral decision has run (observable: the
        // deferral log). The handler then sits on the gated final POST —
        // in flight, flag still held, isIdle still false.
        for (
          let i = 0;
          i < 100 && !logs.some((l) => l.includes("re-wake deferred"));
          i++
        ) {
          await new Promise<void>((r) => setImmediate(r));
        }
        expect(logs.some((l) => l.includes("re-wake deferred"))).toBe(true);
        await new Promise<void>((r) => setImmediate(r));
        expect(idle).toBe(false); // pi has not cleared the run flag yet
        expect(midTurnQueues.get("ch2")?.length).toBe(1); // deferral held
        // 5. /stop on ch1 lands INSIDE the handler window: the settle tick
        //    sees the cancel with isIdle still FALSE (the old one-shot
        //    check skips the kick here and orphans m2 — #124). /stop also
        //    re-aborts: from its view the run is still active.
        await handleInbound(pi, inboundCh("/stop", "m3"), ctx);
        expect(abortCount).toBe(baseAborts + 2);
        jest.advanceTimersByTime(25);
        await Promise.resolve();
        expect(sent.length).toBe(baseSends); // m1's send never happened
        expect(midTurnQueues.has("ch1")).toBe(false);
        expect(midTurnQueues.get("ch2")?.length).toBe(1); // still queued
        // 6. The handler finishes; pi clears the run flag.
        resolveFinal!();
        await ae;
        idle = true;
        // 7. The cancel-branch kick must fire on the next settle tick —
        //    exactly once for m2 (the atomic pop is the dedupe). The
        //    kick is fire-and-forget: wait for m2 on the bounded
        //    clock-time budget (flushUntil), not a fixed hop count
        //    (MEDIUM-1, review 3005244).
        await flushUntil(() =>
          sent.some((s) => s.m?.details?.messageId === "m2"),
        );
        const m2Sends = sent.filter((s) => s.m?.details?.messageId === "m2");
        expect(m2Sends.length).toBe(1);
        expect(midTurnQueues.has("ch2")).toBe(false);
        expect(sent.length).toBe(baseSends + 1); // m2 is the only send
        // 8. No double-wake: m2's own armed interrupt fires into an idle
        //    session with an empty queue — no second send, no abort.
        jest.advanceTimersByTime(interruptStepTimeoutMs());
        await Promise.resolve();
        for (let i = 0; i < 10; i++)
          await new Promise<void>((r) => setImmediate(r));
        expect(sent.length).toBe(baseSends + 1);
        expect(abortCount).toBe(baseAborts + 2);
      } finally {
        console.log = realLog;
        globalThis.fetch = prevFetch;
      }
    });

    test("/stop in the settle window with nothing queued: no wake (cancel-branch kick finds an empty queue)", async () => {
      await handlers.session_start?.(null, ctx); // configRoot for ack REST
      expect(idle).toBe(false);
      // Relative zero-asserts (MEDIUM-1, review 3005244): a late send
      // from the prior test's fire-and-forget kick can land in this
      // test's shared `sent` binding after its `sent = []` reset (the
      // leak is documented in the outer afterEach comment) and fail an
      // absolute 0. Only GROWTH during this test's own window counts.
      const baseSends = sent.length;
      const baseAborts = abortCount;
      // m1 (ch1) arrives mid-run: queued, interrupt armed. No other
      // channel's entry exists — the only line is m1's.
      await handleInbound(pi, inboundCh("m1 body", "m1"), ctx);
      jest.advanceTimersByTime(interruptStepTimeoutMs());
      await Promise.resolve();
      expect(abortCount).toBe(baseAborts + 1); // m1's interrupt aborted
      expect(sent.length).toBe(baseSends); // settling: no send yet
      // /stop while the settle wait is pending; the run settles on the
      // next tick. The cancel branch's kick must find an empty queue.
      await handleInbound(pi, inboundCh("/stop", "m3"), ctx);
      idle = true;
      jest.advanceTimersByTime(25);
      await Promise.resolve();
      expect(sent.length).toBe(baseSends); // m1 dropped, nothing else: no wake
      expect(midTurnQueues.has("ch1")).toBe(false);
      // More settle ticks: still nothing to wake, no stray send.
      jest.advanceTimersByTime(interruptStepTimeoutMs());
      for (let i = 0; i < 10; i++)
        await new Promise<void>((r) => setImmediate(r));
      expect(sent.length).toBe(baseSends);
    });

    test("/stop twice during the cancel poll does not drop the next same-channel interrupt (#167 LOW-2)", async () => {
      await handlers.session_start?.(null, ctx); // configRoot for ack REST
      expect(idle).toBe(false);
      // Relative zero-asserts (MEDIUM-1, review 3005244): a late send
      // from a prior test can land in this test's shared `sent` binding
      // after its reset and fail an absolute 0. Only GROWTH during this
      // test's own window counts.
      const baseSends = sent.length;
      const baseAborts = abortCount;
      const ackFlush = async () => {
        for (let i = 0; i < 20; i++) await Promise.resolve();
      };
      // 1. Run active. m1 arrives mid-run: queued, interrupt armed.
      await handleInbound(pi, inboundCh("m1 body", "m1"), ctx);
      await ackFlush(); // ack post resolves -> tick can arm on the ack id
      // 2. m1's interrupt fires: abort, settle polling (the slow-settle
      //    mock keeps the run active).
      jest.advanceTimersByTime(interruptStepTimeoutMs());
      await Promise.resolve();
      expect(abortCount).toBe(baseAborts + 1);
      expect(sent.length).toBe(baseSends); // settling: no send yet
      // 3. /stop#1 while the settle wait is pending: the cancel branch
      //    drops m1, CONSUMES the flag, then polls for settle (not idle).
      await handleInbound(pi, inboundCh("/stop", "m2"), ctx);
      jest.advanceTimersByTime(25);
      await Promise.resolve();
      expect(sent.length).toBe(baseSends); // m1's send dropped
      expect(abortCount).toBe(baseAborts + 2); // /stop#1's own abort
      expect(midTurnQueues.has("ch1")).toBe(false);
      // 4. /stop#2 lands DURING the cancel poll (the in-flight flag is
      //    still held, so /stop re-sets interruptCancelled). This re-set
      //    has no consumer: the cancel branch already consumed /stop#1's.
      await handleInbound(pi, inboundCh("/stop", "m3"), ctx);
      expect(abortCount).toBe(baseAborts + 3); // /stop#2's own abort
      // 5. The aborted run never settles: the cancel poll hits its
      //    120 s cap (4800 x 25 ms), skips the kick, and releases the
      //    channel. The run is STILL active (cap corner, INFO-3), so a
      //    later interrupt fires against a run that predates /stop#2 with
      //    no sendToPi in between to clear the stale flag.
      for (let i = 0; i < 4800; i++) {
        jest.advanceTimersByTime(25);
        await Promise.resolve();
      }
      expect(idle).toBe(false); // the run outlived the poll cap
      // 6. m4 arrives mid-run: queued, interrupt armed (normal delay: no
      //    interrupt in flight anymore).
      await handleInbound(pi, inboundCh("m4 body", "m4"), ctx);
      await ackFlush();
      // 7. m4's interrupt fires while the run is still active. Without
      //    the fix the stale /stop#2 flag makes the settle loop exit
      //    immediately and m4 is dropped once (message + ack). With the
      //    fix the flag was swept when the first interrupt released the
      //    channel, so m4 waits for the settle and is delivered.
      jest.advanceTimersByTime(interruptStepTimeoutMs());
      await Promise.resolve();
      expect(abortCount).toBe(baseAborts + 4); // m4's interrupt aborted
      expect(sent.length).toBe(baseSends); // still settling
      // 8. The run settles: m4's interrupt must deliver, not drop.
      idle = true;
      jest.advanceTimersByTime(25);
      await Promise.resolve();
      await flushUntil(() =>
        sent.some((s) => s.m?.details?.messageId === "m4"),
      );
      const m4Sends = sent.filter((s) => s.m?.details?.messageId === "m4");
      expect(m4Sends.length).toBe(1);
      expect(sent.length).toBe(baseSends + 1); // m4 is the only send
      expect(midTurnQueues.has("ch1")).toBe(false);
      // 9. No double-wake: more settle ticks find nothing queued.
      jest.advanceTimersByTime(interruptStepTimeoutMs());
      await Promise.resolve();
      for (let i = 0; i < 10; i++)
        await new Promise<void>((r) => setImmediate(r));
      expect(sent.length).toBe(baseSends + 1);
      expect(abortCount).toBe(baseAborts + 4);
    });
  });

  test("F2: second-channel inbound during the re-wake await does not retarget the first run's failure post", async () => {
    // Two channels configured so the second channel resolves.
    fs.writeFileSync(
      path.join(tmp, ".pi", "settings.json"),
      JSON.stringify({
        channels: [
          {
            id: "ch1",
            name: "One",
            type: "discord",
            botToken: "tok1",
            ownerUserId: "uid",
            ack: true,
          },
          {
            id: "ch2",
            name: "Two",
            type: "discord",
            botToken: "tok2",
            ack: true,
          },
        ],
      }),
    );
    const ch2 = (body: string, id: string): ChannelMessage => ({
      channelId: "ch2",
      channelName: "Two",
      channelType: "discord",
      messageId: id,
      from: "u2",
      fromId: "uid2",
      body,
      timestamp: new Date().toISOString(),
      attachments: [],
      isRoom: false,
    });

    ctx.isIdle = () => false; // a run is in flight on ch1
    await handleInbound(pi, inbound("queued cb", "m900"), ctx);
    expect(midTurnQueues.get("ch1")?.length).toBe(1);

    // The run ends with a failure; the re-wake starts (suspended mid-await).
    const failure = {
      role: "assistant",
      content: [{ type: "text", text: "" }],
      stopReason: "error",
      errorMessage: "boom",
    };
    const p = handlers.agent_end({ messages: [failure] }, ctx);

    // While the re-wake is in flight, a second channel's inbound lands and
    // becomes the last active channel (itself queued — still mid-run).
    await handleInbound(pi, ch2("other channel", "m901"), ctx);
    expect(midTurnQueues.get("ch2")?.length).toBe(1);

    await p;

    // The re-wake fired for ch1's queued message.
    expect(sent.length).toBe(1);
    // The ORIGINAL run's failure post targets ch1 (channel captured before
    // the re-wake await), not ch2 — what lastActiveChannel points at after.
    const ch1Posts = fetchCalls.filter(
      (c) => c.method === "POST" && c.url.endsWith("/channels/ch1/messages"),
    );
    expect(
      ch1Posts.some((c) => String(JSON.parse(c.body).content).includes("boom")),
    ).toBe(true);
    const ch2FailPosts = fetchCalls.filter(
      (c) =>
        c.method === "POST" &&
        c.url.endsWith("/channels/ch2/messages") &&
        String(JSON.parse(c.body).content).includes("boom"),
    );
    expect(ch2FailPosts.length).toBe(0);
  });

  test("F3: re-wake preserves the pending attachment batch", async () => {
    // #24 flipped the default (file-only now fires a turn); this test pins
    // the explicit bufferFileOnly: true behavior.
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
            bufferFileOnly: true,
          },
        ],
      }),
    );
    ctx.isIdle = () => false; // a run is in flight
    // 1. File-only message → buffered (no text, no voice note).
    const fileOnly = inbound("", "m300");
    fileOnly.attachments = [
      { id: "b1", filename: "notes.txt", contentType: "text/plain", size: 50 },
    ];
    await handleInbound(pi, fileOnly, ctx);
    expect(pendingAttachments.get("ch1")?.length).toBe(1);
    expect(sent.length).toBe(0);
    // 2. Text follow-up mid-run → gated for a re-wake; the pending batch must
    //    survive (the re-wake pass re-applies the file context).
    await handleInbound(pi, inbound("read this", "m301"), ctx);
    expect(sent.length).toBe(0);
    expect(midTurnQueues.get("ch1")?.length).toBe(1);
    expect(pendingAttachments.get("ch1")?.length).toBe(1);
    // 3. The re-wake sends the text WITH the buffered file context.
    await handlers.agent_end({ messages: [] }, ctx);
    expect(sent.length).toBe(1);
    expect(sent[0].m.content).toContain("notes.txt");
    expect(sent[0].m.details.body).toContain("read this");
    // The batch was consumed by the re-wake pass.
    expect(pendingAttachments.has("ch1")).toBe(false);
  });

  test("#24: file-only with default config fires a turn immediately (no buffer)", async () => {
    // No bufferFileOnly in settings → default FALSE → file-only fires a turn.
    const fileOnly = inbound("", "m400");
    fileOnly.attachments = [
      { id: "b1", filename: "notes.txt", contentType: "text/plain", size: 50 },
    ];
    await handleInbound(pi, fileOnly, ctx);
    expect(pendingAttachments.has("ch1")).toBe(false);
    expect(sent.length).toBe(1);
    expect(sent[0].m.content).toContain(
      "[user sent 1 file without text: notes.txt]",
    );
    expect(sent[0].m.content).toContain("notes.txt");
    // No [buffered] ack posted on the default path.
    const bufferedAck = fetchCalls.find(
      (c) =>
        c.method === "POST" &&
        String(JSON.parse(c.body).content).includes("[buffered]"),
    );
    expect(bufferedAck).toBeUndefined();
  });

  test("#24: bufferFileOnly:true buffers, posts ONE [buffered] ack, text follow-up consumes", async () => {
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
            bufferFileOnly: true,
          },
        ],
      }),
    );
    const fileOnly = inbound("", "m401");
    fileOnly.attachments = [
      { id: "b1", filename: "a.txt", contentType: "text/plain", size: 10 },
      { id: "b2", filename: "b.jpg", contentType: "image/jpeg", size: 20 },
    ];
    await handleInbound(pi, fileOnly, ctx);
    // Buffered, no turn.
    expect(sent.length).toBe(0);
    expect(pendingAttachments.get("ch1")?.length).toBe(1);
    // Exactly one visible [buffered] ack line.
    const acks = fetchCalls.filter(
      (c) =>
        c.method === "POST" &&
        String(JSON.parse(c.body).content).includes("[buffered]"),
    );
    expect(acks.length).toBe(1);
    expect(JSON.parse(acks[0].body).content).toContain(
      "[buffered] 2 files - send text to attach them",
    );
    // v4: the [buffered] ack ships BARE - no code fence (STYLE §3.1 ruling,
    // 2026-10-20; pins the unfence so a re-added fence fails this test)
    expect(JSON.parse(acks[0].body).content).not.toContain("```");
    // No regression: text after buffer consumes the batch with file context.
    fetchCalls.length = 0;
    await handleInbound(pi, inbound("look at these", "m402"), ctx);
    expect(sent.length).toBe(1);
    expect(sent[0].m.content).toContain("a.txt");
    expect(sent[0].m.content).toContain("b.jpg");
    expect(sent[0].m.details.body).toContain("look at these");
    expect(pendingAttachments.has("ch1")).toBe(false);
    // The text follow-up posts no second [buffered] ack.
    const acks2 = fetchCalls.filter(
      (c) =>
        c.method === "POST" &&
        String(JSON.parse(c.body).content).includes("[buffered]"),
    );
    expect(acks2.length).toBe(0);
  });

  test("#24: buffered batch auto-flushes as a file-only turn at 10 minutes (frozen clock)", async () => {
    jest.useFakeTimers();
    const t0 = Date.now();
    const nowSpy = jest.spyOn(Date, "now").mockReturnValue(t0);
    try {
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
              bufferFileOnly: true,
            },
          ],
        }),
      );
      const fileOnly = inbound("", "m403");
      fileOnly.attachments = [
        { id: "b1", filename: "late.txt", contentType: "text/plain", size: 30 },
      ];
      await handleInbound(pi, fileOnly, ctx);
      expect(pendingAttachments.get("ch1")?.length).toBe(1);
      expect(sent.length).toBe(0);
      // session_start arms the 60s flush ticker (sleepPoller alongside).
      await handlers.session_start(null, ctx);
      // 9 minutes of ticks: batch not yet due, nothing fires.
      nowSpy.mockReturnValue(t0 + 9 * 60_000);
      jest.advanceTimersByTime(9 * 60_000);
      expect(sent.length).toBe(0);
      expect(pendingAttachments.has("ch1")).toBe(true);
      // Cross the 10-minute boundary: next tick flushes a file-only turn.
      nowSpy.mockReturnValue(t0 + 11 * 60_000);
      jest.advanceTimersByTime(2 * 60_000);
      expect(sent.length).toBe(1);
      expect(sent[0].m.content).toContain(
        "[user sent 1 file without text: late.txt]",
      );
      expect(sent[0].m.details.body).toContain("late.txt");
      // The batch was consumed by the flush.
      expect(pendingAttachments.has("ch1")).toBe(false);
    } finally {
      nowSpy.mockRestore();
      jest.useRealTimers();
    }
  });

  test("#24: voice-note-only message is not buffered (unaffected by the default flip)", async () => {
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
            bufferFileOnly: true,
          },
        ],
      }),
    );
    const voice = inbound("", "m404");
    voice.attachments = [
      {
        id: "v1",
        filename: "recording.m4a",
        contentType: "audio/ogg",
        size: 1000,
        duration: 12,
      },
    ];
    await handleInbound(pi, voice, ctx);
    // Voice note fires a turn with its marker line; nothing buffered, no ack.
    expect(pendingAttachments.has("ch1")).toBe(false);
    expect(sent.length).toBe(1);
    expect(sent[0].m.content).toContain("[voice note: recording.m4a (12s)]");
    expect(sent[0].m.content).not.toContain("[buffered]");
    const acks = fetchCalls.filter(
      (c) =>
        c.method === "POST" &&
        String(JSON.parse(c.body).content).includes("[buffered]"),
    );
    expect(acks.length).toBe(0);
  });

  test("repetition: 3 consecutive identical finals → abort + one warning, 3rd dropped", async () => {
    let aborts = 0;
    ctx.abort = () => {
      aborts++;
    };
    await handleInbound(pi, inbound("hello", "m1"), ctx);
    await handlers.turn_start(null, ctx);
    const fin = (t: string) => ({
      role: "assistant",
      content: [{ type: "text", text: t }],
    });
    await handlers.message_end({ message: fin("same") }, ctx);
    await handlers.message_end({ message: fin("same") }, ctx);
    await handlers.message_end({ message: fin("same") }, ctx);

    expect(aborts).toBe(1);
    const contents = fetchCalls
      .filter(
        (c) => c.method === "POST" && c.url.endsWith("/channels/ch1/messages"),
      )
      .map((c) => JSON.parse(c.body).content);
    expect(contents.filter((t) => t === "same").length).toBe(2); // 3rd dropped
    expect(contents.filter((t) => t.includes(REPEAT_WARNING)).length).toBe(1);

    // 4th identical does not re-warn (counter reset after the trip).
    await handlers.message_end({ message: fin("same") }, ctx);
    expect(aborts).toBe(1);
    const after = fetchCalls
      .filter(
        (c) => c.method === "POST" && c.url.endsWith("/channels/ch1/messages"),
      )
      .map((c) => JSON.parse(c.body).content);
    expect(after.filter((t) => t.includes(REPEAT_WARNING)).length).toBe(1);
  });

  test("repetition: a different final resets the counter", async () => {
    let aborts = 0;
    ctx.abort = () => {
      aborts++;
    };
    await handleInbound(pi, inbound("hello", "m1"), ctx);
    await handlers.turn_start(null, ctx);
    const fin = (t: string) => ({
      role: "assistant",
      content: [{ type: "text", text: t }],
    });
    for (const t of ["a", "a", "b", "a", "a"]) {
      await handlers.message_end({ message: fin(t) }, ctx);
    }
    expect(aborts).toBe(0);
  });

  test("repetition: a new inbound user message resets the counter", async () => {
    let aborts = 0;
    ctx.abort = () => {
      aborts++;
    };
    await handleInbound(pi, inbound("hello", "m1"), ctx);
    await handlers.turn_start(null, ctx);
    const fin = (t: string) => ({
      role: "assistant",
      content: [{ type: "text", text: t }],
    });
    await handlers.message_end({ message: fin("a") }, ctx);
    await handlers.message_end({ message: fin("a") }, ctx);
    await handleInbound(pi, inbound("more", "m2"), ctx); // resets the counter
    await handlers.message_end({ message: fin("a") }, ctx);
    await handlers.message_end({ message: fin("a") }, ctx);
    expect(aborts).toBe(0);
  });

  test("repetition: agent_end finals trip the guard once, warning posted", async () => {
    let aborts = 0;
    ctx.abort = () => {
      aborts++;
    };
    await handleInbound(pi, inbound("hello", "m1"), ctx);
    const fin = (t: string) => ({
      role: "assistant",
      content: [{ type: "text", text: t }],
    });
    await handlers.agent_end({ messages: [fin("x"), fin("x")] }, ctx);
    expect(aborts).toBe(0);
    await handlers.agent_end({ messages: [fin("x")] }, ctx);
    expect(aborts).toBe(1);
    const contents = fetchCalls
      .filter(
        (c) => c.method === "POST" && c.url.endsWith("/channels/ch1/messages"),
      )
      .map((c) => JSON.parse(c.body).content);
    // agent_end posts go through mdToDiscord: the bare warning line is
    // guarded (fenced; no 40-col wrap since 2026-10-18)
    expect(
      contents.filter((t) => t === styleGuard(REPEAT_WARNING)).length,
    ).toBe(1);
  });

  test("F1: /undo re-run — session_start re-sends the parked trigger after the undo-restart", async () => {
    // Redirect HOME so the undo store + sessions dir live under tmp.
    const oldHome = process.env.HOME || "";
    process.env.HOME = path.join(tmp, "home");
    const sessDir = path.join(
      process.env.HOME,
      ".pi",
      "agent",
      "sessions",
      `-${tmp}-`,
    );
    fs.mkdirSync(sessDir, { recursive: true });
    const sess = path.join(sessDir, "s.jsonl");
    const lines = [
      { type: "session", version: 3, id: "s1", timestamp: "t", cwd: tmp },
      {
        type: "custom_message",
        id: "t1",
        parentId: null,
        customType: "channel-inbound",
        content: "<channel-ctx>ch: Test</channel-ctx>\n\nfix the bug",
        details: { title: "Test", body: "fix the bug" },
      },
      {
        type: "message",
        id: "a1",
        parentId: "t1",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "done" }],
        },
      },
    ];
    fs.writeFileSync(
      sess,
      `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`,
    );

    // /undo: truncate + park the re-run trigger (restarted=true would then
    // scheduleRestart -> systemd respawns pi -> fresh process, new session_start).
    const r = performUndo(sess);
    expect(r.restarted).toBe(true);
    expect(r.reRun).toBe(true);
    expect(fs.readFileSync(sess, "utf8").trim().split("\n")).toHaveLength(2); // through t1 (a1 removed)

    const sentBefore = sent.length;
    await handlers.session_start?.(null, ctx);
    process.env.HOME = oldHome;

    // the bridge re-sent the kept trigger through the normal inbound path
    const rerun = sent
      .slice(sentBefore)
      .find(
        (s) =>
          s.m.customType === "channel-inbound" &&
          s.m.details?.body === "fix the bug",
      );
    expect(rerun).toBeDefined();
    expect(rerun?.o?.triggerTurn).toBe(true);
  });

  test("F1: session_start without a parked rerun sends nothing", async () => {
    const oldHome = process.env.HOME || "";
    process.env.HOME = path.join(tmp, "home"); // keep the store away from the real HOME
    fs.mkdirSync(process.env.HOME, { recursive: true });
    const sentBefore = sent.length;
    await handlers.session_start?.(null, ctx);
    process.env.HOME = oldHome;
    expect(sent.length).toBe(sentBefore);
  });
});

// ─── #42 voice-note transcription: wiring in the attachment branch ──────
// Stub convention (jobs.test.ts): sh scripts in a temp dir, prepended to
// PATH. The whisper-cli stub echoes a fixed transcript; the ffmpeg stub
// stands in for the m4a -> 16 kHz wav conversion (it writes the output
// file whisper-cli would read).

describe("voice transcription (#42)", () => {
  let tmp = "";
  let scriptsDir = "";
  let pi: any;
  let ctx: any;
  let handlers: Record<string, (...a: any[]) => any> = {};
  let sent: { m: any; o?: any }[] = [];
  let fetchCalls: { url: string; method: string; body?: any }[] = [];
  const realFetch = globalThis.fetch;
  const savedEnv: Record<string, string | undefined> = {};
  const ENV_KEYS = [
    "PATH",
    "JB_TRANSCRIBE_BIN",
    "JB_TRANSCRIBE_MODEL",
    "JB_TRANSCRIBE_FFMPEG",
    "JB_TRANSCRIBE_TIMEOUT_S",
    "JB_TRANSCRIBE_THREADS",
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

  const voiceAtt = (over: Partial<any> = {}): any => ({
    id: "v1",
    filename: "recording.m4a",
    contentType: "audio/mp4",
    size: 1000,
    duration: 12,
    url: "https://files.example/recording.m4a",
    ...over,
  });

  function stub(name: string, body: string): void {
    const p = path.join(scriptsDir, name);
    fs.writeFileSync(p, body);
    fs.chmodSync(p, 0o755);
  }

  function writeSettings(channels: any[]): void {
    fs.writeFileSync(
      path.join(tmp, ".pi", "settings.json"),
      JSON.stringify({ channels }),
    );
  }

  const FFMPEG_OK = `#!/bin/sh
out=""
for a in "$@"; do out="$a"; done
printf RIFF > "$out"
exit 0
`;
  const WHISPER_OK = (sentinel?: string) =>
    `#!/bin/sh\n` +
    (sentinel ? `echo x >> ${sentinel}\n` : "") +
    `echo "hello transcript words"\n`;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "voice-42-"));
    fs.mkdirSync(path.join(tmp, ".pi"), { recursive: true });
    scriptsDir = path.join(tmp, "scripts");
    fs.mkdirSync(scriptsDir, { recursive: true });
    writeSettings([
      { id: "ch1", name: "Test", type: "discord", botToken: "tok1" },
    ]);
    handlers = {};
    sent = [];
    midTurnQueues.clear();
    pendingAttachments.clear();
    verboseOverride.clear();
    fetchCalls = [];
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
    // fetch mock: audio URLs serve a small buffer, everything else is the
    // plain REST stub (message posts return { id }).
    globalThis.fetch = (async (url: any, init?: any) => {
      const u = String(url);
      fetchCalls.push({
        url: u,
        method: init?.method ?? "GET",
        body: init?.body,
      });
      if (u.startsWith("https://files.example/")) {
        return {
          ok: true,
          status: 200,
          headers: {
            get: (h: string) =>
              h.toLowerCase() === "content-length" ? "1000" : null,
          },
          arrayBuffer: async () => new Uint8Array([1, 2, 3, 4]).buffer,
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ id: "out" }),
        text: async () => "",
      };
    }) as any;
    // PATH: stub dir first; drop JB_TRANSCRIBE_* so defaults apply, then
    // point JB_TRANSCRIBE_MODEL at a fake model in tmp so the existsSync
    // gate passes on fresh HOMEs (CI runners without the real
    // ggml-base.bin). The stub whisper-cli never parses it.
    for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
    process.env.PATH = `${scriptsDir}${path.delimiter}${savedEnv.PATH ?? ""}`;
    for (const k of ENV_KEYS.slice(1)) delete process.env[k];
    const fakeModel = path.join(tmp, "ggml-fake.bin");
    fs.writeFileSync(fakeModel, "FAKE-WHISPER-MODEL\n");
    process.env.JB_TRANSCRIBE_MODEL = fakeModel;
  });

  afterEach(async () => {
    clearDiscordStatesForTest(); // no auto-react suppression leaks across tests
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
    midTurnQueues.clear();
    pendingAttachments.clear();
    clearAllInterrupts();
    setInterruptCtx(null);
    await handlers.agent_end?.({ messages: [] }, ctx);
    globalThis.fetch = realFetch;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test("m4a + working stubs -> transcript inlined, marker gone", async () => {
    stub("ffmpeg", FFMPEG_OK);
    stub("whisper-cli", WHISPER_OK());
    const v = inbound("", "m42a");
    v.attachments = [voiceAtt()];
    await handleInbound(pi, v, ctx);
    expect(sent.length).toBe(1);
    expect(sent[0].m.content).toContain("hello transcript words");
    expect(sent[0].m.content).not.toContain("[voice note:");
    // the agent sees the words as plain message text (display body too)
    expect(sent[0].m.details.body).toContain("hello transcript words");
  });

  test("stub exits 1 -> marker fallback kept", async () => {
    stub("ffmpeg", FFMPEG_OK);
    stub("whisper-cli", "#!/bin/sh\nexit 1\n");
    const v = inbound("", "m42b");
    v.attachments = [voiceAtt()];
    await handleInbound(pi, v, ctx);
    expect(sent.length).toBe(1);
    expect(sent[0].m.content).toContain("[voice note: recording.m4a (12s)]");
    expect(sent[0].m.content).not.toContain("hello transcript words");
  });

  test("opt-out channel (transcribe: false) -> no transcribe call", async () => {
    const sentinel = path.join(tmp, "whisper-called");
    writeSettings([
      {
        id: "ch1",
        name: "Test",
        type: "discord",
        botToken: "tok1",
        ownerUserId: "uid",
        transcribe: false,
      },
    ]);
    stub("ffmpeg", FFMPEG_OK);
    stub("whisper-cli", WHISPER_OK(sentinel));
    const v = inbound("", "m42c");
    v.attachments = [voiceAtt()];
    await handleInbound(pi, v, ctx);
    expect(sent.length).toBe(1);
    expect(sent[0].m.content).toContain("[voice note: recording.m4a (12s)]");
    expect(sent[0].m.content).not.toContain("hello transcript words");
    expect(fs.existsSync(sentinel)).toBe(false);
  });

  test("non-audio attachment -> no transcribe call", async () => {
    const sentinel = path.join(tmp, "whisper-called");
    stub("whisper-cli", WHISPER_OK(sentinel));
    const m = inbound("read this", "m42d");
    m.attachments = [
      {
        id: "t1",
        filename: "notes.txt",
        contentType: "text/plain",
        size: 30,
        url: "https://files.example/notes.txt",
      },
    ];
    await handleInbound(pi, m, ctx);
    expect(sent.length).toBe(1);
    expect(sent[0].m.content).toContain("notes.txt");
    expect(fs.existsSync(sentinel)).toBe(false);
  });

  test("voice note with failed download -> marker, no transcribe call", async () => {
    const sentinel = path.join(tmp, "whisper-called");
    stub("ffmpeg", FFMPEG_OK);
    stub("whisper-cli", WHISPER_OK(sentinel));
    const v = inbound("", "m42e");
    v.attachments = [voiceAtt({ url: undefined })]; // download fails
    await handleInbound(pi, v, ctx);
    expect(sent.length).toBe(1);
    expect(sent[0].m.content).toContain("[voice note: recording.m4a (12s)]");
    expect(fs.existsSync(sentinel)).toBe(false);
  });

  test("wav voice note -> native path, no ffmpeg needed", async () => {
    stub("whisper-cli", WHISPER_OK());
    const v = inbound("", "m42f");
    v.attachments = [
      voiceAtt({
        id: "v2",
        filename: "tone.wav",
        contentType: "audio/wav",
        url: "https://files.example/tone.wav",
      }),
    ];
    await handleInbound(pi, v, ctx);
    expect(sent.length).toBe(1);
    expect(sent[0].m.content).toContain("hello transcript words");
    expect(sent[0].m.content).not.toContain("[voice note:");
  });

  test("voice note + text -> transcript replaces marker, text kept", async () => {
    stub("ffmpeg", FFMPEG_OK);
    stub("whisper-cli", WHISPER_OK());
    const v = inbound("what did I just say?", "m42g");
    v.attachments = [voiceAtt()];
    await handleInbound(pi, v, ctx);
    expect(sent.length).toBe(1);
    expect(sent[0].m.content).toContain("what did I just say?");
    expect(sent[0].m.content).toContain("hello transcript words");
    expect(sent[0].m.content).not.toContain("[voice note:");
  });
});

// ─── #39 /hold: channel-wide queue mode ──────────────────────────────

// ─── #10 3-level persistent verbosity ────────────────────────────────

describe("#10 verbosity levels", () => {
  let tmp = "";
  let pi: any;
  let ctx: any;
  let handlers: Record<string, (...a: any[]) => any> = {};
  let sent: { m: any; o?: any }[] = [];
  let fetchCalls: { url: string; method: string; body?: any }[] = [];
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
  const patches = () =>
    fetchCalls.filter((c) => c.method === "PATCH").map((c) => String(c.body));

  const setup = (channelOpts: Record<string, unknown> = {}) => {
    handlers = {};
    sent = [];
    fetchCalls = [];
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
            forwardToolCalls: false,
            ...channelOpts,
          },
        ],
      }),
    );
  };

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jarate-verb-"));
    fs.mkdirSync(path.join(tmp, ".pi"), { recursive: true });
    setup();
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
  });

  afterEach(async () => {
    clearDiscordStatesForTest(); // no auto-react suppression leaks across tests
    jest.useRealTimers();
    midTurnQueues.clear();
    pendingAttachments.clear();
    clearAllInterrupts();
    setInterruptCtx(null);
    setRuntimeStateDir(null);
    await handlers.agent_end?.({ messages: [] }, ctx);
    globalThis.fetch = realFetch;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test("parseVerboseLevel: digits, legacy, kimaki names, garbage", () => {
    expect(parseVerboseLevel("0")).toBe(0);
    expect(parseVerboseLevel("off")).toBe(0);
    expect(parseVerboseLevel("text")).toBe(0);
    expect(parseVerboseLevel("text-only")).toBe(0);
    expect(parseVerboseLevel("1")).toBe(1);
    expect(parseVerboseLevel("essential")).toBe(1);
    expect(parseVerboseLevel("text-and-essential-tools")).toBe(1);
    expect(parseVerboseLevel("2")).toBe(2);
    expect(parseVerboseLevel("on")).toBe(2);
    expect(parseVerboseLevel("all")).toBe(2);
    expect(parseVerboseLevel("tools-and-text")).toBe(2);
    expect(parseVerboseLevel("ON")).toBe(2);
    expect(parseVerboseLevel("3")).toBeNull();
    expect(parseVerboseLevel("maybe")).toBeNull();
  });

  test("bashToolEssential: read-only hidden, side effects shown", () => {
    const t = (c: string) => bashToolEssential({ command: c });
    // read-only
    expect(t("ls")).toBe(false);
    expect(t("cat /etc/hosts")).toBe(false);
    expect(t("git log --oneline")).toBe(false);
    expect(t("git status")).toBe(false);
    expect(t("git diff")).toBe(false);
    expect(t("git branch")).toBe(false);
    expect(t("git tag")).toBe(false);
    expect(t("git tag -l")).toBe(false);
    expect(t("git stash list")).toBe(false);
    expect(t("rg foo bar/")).toBe(false);
    expect(t("FOO=1 BAR=2 ls -la")).toBe(false);
    expect(t("ls | grep x")).toBe(false);
    expect(t("cat a && head b")).toBe(false);
    // side effects
    expect(t("git commit -m x")).toBe(true);
    expect(t("git push")).toBe(true);
    expect(t("git branch -d old")).toBe(true);
    expect(t("mkdir -p out")).toBe(true);
    expect(t("rm -rf node_modules")).toBe(true);
    expect(t("echo hi > out.txt")).toBe(true);
    expect(t("ls && rm x")).toBe(true);
    expect(t("bun test")).toBe(true); // unknown head = shown
    expect(t("")).toBe(false); // empty: nothing to show
  });

  test("isEssentialToolCall: non-essential set, MCP always shown", () => {
    for (const n of ["read", "grep", "ls", "find"])
      expect(isEssentialToolCall(n, {})).toBe(false);
    expect(isEssentialToolCall("edit", {})).toBe(true);
    expect(isEssentialToolCall("write", {})).toBe(true);
    expect(isEssentialToolCall("todo", {})).toBe(true);
    expect(isEssentialToolCall("tavily_tavily_search", {})).toBe(true);
    expect(isEssentialToolCall("jarate", {})).toBe(true);
    expect(isEssentialToolCall("bash", { command: "ls" })).toBe(false);
    expect(isEssentialToolCall("bash", { command: "git push" })).toBe(true);
  });

  test("level 1: non-essential calls hidden live, essentials shown", async () => {
    verboseOverride.set("ch1", 1);
    await handleInbound(pi, inbound("hello", "m1"), ctx);
    await handlers.turn_start(null, ctx);
    // reads + read-only bash: no block created, no frame edited
    await handlers.tool_call(
      { toolName: "read", input: { path: "a.txt" } },
      ctx,
    );
    await handlers.tool_call(
      { toolName: "bash", input: { command: "ls" } },
      ctx,
    );
    expect(posts().some((p) => p.includes("┌ working"))).toBe(false);
    // an edit shows up (fresh working frame)
    await handlers.tool_call(
      { toolName: "edit", input: { path: "a.txt" } },
      ctx,
    );
    expect(
      posts().some((p) => p.includes("┌ working") && p.includes("edit a.txt")),
    ).toBe(true);
    // a side-effect bash shows in the existing frame; the header count is
    // the ESSENTIAL count (2: edit + bash), not the total 4 (review L2)
    await handlers.tool_call(
      { toolName: "bash", input: { command: "git push" } },
      ctx,
    );
    expect(
      patches().some(
        (p) => p.includes("┌ working · 2 calls") && p.includes("bash git push"),
      ),
    ).toBe(true);
  });

  test("level 1 done frame lists essentials only; all-read run deletes the block", async () => {
    verboseOverride.set("ch1", 1);
    const fin = (t: string) => ({
      role: "assistant",
      content: [{ type: "text", text: t }],
    });
    // run A: read + edit + bash push -> frame shows 2 calls, no read
    await handleInbound(pi, inbound("hello", "m1"), ctx);
    await handlers.turn_start(null, ctx);
    await handlers.tool_call(
      { toolName: "read", input: { path: "a.txt" } },
      ctx,
    );
    await handlers.tool_call(
      { toolName: "edit", input: { path: "a.txt" } },
      ctx,
    );
    await handlers.tool_call(
      { toolName: "bash", input: { command: "git push" } },
      ctx,
    );
    await handlers.agent_end({ messages: [fin("done A")] }, ctx);
    const donePatch = patches().find((p) => p.includes("┌ done"));
    expect(donePatch).toBeDefined();
    expect(donePatch).toContain("┌ done · 2 calls · ");
    expect(donePatch).toContain("edit a.txt");
    expect(donePatch).toContain("bash git push");
    expect(donePatch).not.toContain("read a.txt");

    // run B: only non-essential calls -> no live block at level 1 and no
    // done frame (nothing was ever posted to close)
    fetchCalls.length = 0;
    await handleInbound(pi, inbound("again", "m2"), ctx);
    await handlers.turn_start(null, ctx);
    await handlers.tool_call(
      { toolName: "read", input: { path: "b.txt" } },
      ctx,
    );
    await handlers.tool_call(
      { toolName: "bash", input: { command: "ls" } },
      ctx,
    );
    // level 1: no live block was created at all
    expect(posts().some((p) => p.includes("┣"))).toBe(false);
    await handlers.agent_end({ messages: [fin("done B")] }, ctx);
    expect(patches().some((p) => p.includes("┌ done"))).toBe(false);
    expect(
      fetchCalls.some(
        (c) =>
          c.method === "POST" &&
          c.url.endsWith("/channels/ch1/messages") &&
          String(JSON.parse(c.body).content).includes("done B"),
      ),
    ).toBe(true); // final still posts
  });

  test("level 2 shows everything (incl. reads) in the done frame", async () => {
    verboseOverride.set("ch1", 2);
    const fin = (t: string) => ({
      role: "assistant",
      content: [{ type: "text", text: t }],
    });
    await handleInbound(pi, inbound("hello", "m1"), ctx);
    await handlers.turn_start(null, ctx);
    await handlers.tool_call(
      { toolName: "read", input: { path: "a.txt" } },
      ctx,
    );
    await handlers.tool_call(
      { toolName: "edit", input: { path: "a.txt" } },
      ctx,
    );
    await handlers.agent_end({ messages: [fin("done")] }, ctx);
    const donePatch = patches().find((p) => p.includes("┌ done"));
    expect(donePatch).toContain("┌ done · 2 calls · ");
    expect(donePatch).toContain("read a.txt");
  });

  test("/verbose sets + persists; bare shows; legacy on/off map to 2/0", async () => {
    setRuntimeStateDir(path.join(tmp, ".tmp"));
    const dir = path.join(tmp, ".tmp");
    await handleInbound(pi, inbound("/verbose 1", "m1"), ctx);
    expect(posts().some((t) => t.includes("[ok] verbose: 1 (essential)"))).toBe(
      true,
    );
    let onDisk = JSON.parse(
      fs.readFileSync(path.join(dir, "channel-state.json"), "utf-8"),
    );
    expect(onDisk.channels.ch1.verbose).toBe(1);

    // bare /verbose shows the current level and changes nothing
    await handleInbound(pi, inbound("/verbose", "m2"), ctx);
    expect(posts().some((t) => t.includes("[ok] verbose: 1 (essential)"))).toBe(
      true,
    );
    onDisk = JSON.parse(
      fs.readFileSync(path.join(dir, "channel-state.json"), "utf-8"),
    );
    expect(onDisk.channels.ch1.verbose).toBe(1);

    // legacy on/off still accepted
    await handleInbound(pi, inbound("/verbose on", "m3"), ctx);
    expect(posts().some((t) => t.includes("[ok] verbose: 2 (all)"))).toBe(true);
    await handleInbound(pi, inbound("/verbose off", "m4"), ctx);
    expect(posts().some((t) => t.includes("[ok] verbose: 0 (text)"))).toBe(
      true,
    );
    onDisk = JSON.parse(
      fs.readFileSync(path.join(dir, "channel-state.json"), "utf-8"),
    );
    expect(onDisk.channels.ch1.verbose).toBe(0);

    // bad arg: usage error, no change
    await handleInbound(pi, inbound("/verbose 3", "m5"), ctx);
    expect(posts().some((t) => t.includes("[!] usage: /verbose 0|1|2"))).toBe(
      true,
    );
    onDisk = JSON.parse(
      fs.readFileSync(path.join(dir, "channel-state.json"), "utf-8"),
    );
    expect(onDisk.channels.ch1.verbose).toBe(0);
  });

  test("verbosity level survives a simulated restart (state file reload)", async () => {
    setRuntimeStateDir(path.join(tmp, ".tmp"));
    await handleInbound(pi, inbound("/verbose 1", "m1"), ctx);
    // simulated process restart: in-memory wiped, file reloaded
    resetRuntimeStateForTest();
    setRuntimeStateDir(path.join(tmp, ".tmp"));
    const ch = loadChannelConfig(ctx.cwd)[0]!;
    expect(verboseLevel(ch)).toBe(1);
    expect(isVerbose(ch)).toBe(true);
    // and it renders at level 1
    await handleInbound(pi, inbound("hello", "m2"), ctx);
    await handlers.turn_start(null, ctx);
    await handlers.tool_call(
      { toolName: "read", input: { path: "a.txt" } },
      ctx,
    );
    expect(posts().some((p) => p.includes("┌ working"))).toBe(false); // read hidden at 1
  });

  test("forwardToolCalls=true defaults to level 2; override wins", async () => {
    setup({ forwardToolCalls: true });
    const ch = loadChannelConfig(ctx.cwd)[0]!;
    expect(verboseLevel(ch)).toBe(2);
    verboseOverride.set("ch1", 1);
    expect(verboseLevel(ch)).toBe(1);
    verboseOverride.set("ch1", 0);
    expect(verboseLevel(ch)).toBe(0);
  });

  test("level 2->1 transition keeps the live block; 1->0 deletes it", async () => {
    verboseOverride.set("ch1", 2);
    await handleInbound(pi, inbound("hello", "m1"), ctx);
    await handlers.turn_start(null, ctx);
    await handlers.tool_call(
      { toolName: "read", input: { path: "a.txt" } },
      ctx,
    );
    expect(posts().some((p) => p.includes("┌ working"))).toBe(true); // block at level 2

    // 2 -> 1: block stays (still verbose); reads stop rendering
    await handleInbound(pi, inbound("/verbose 1", "m2"), ctx);
    expect(
      fetchCalls.some(
        (c) => c.method === "DELETE" && c.url.includes("/messages/out1"),
      ),
    ).toBe(false);
    fetchCalls.length = 0;
    await handlers.tool_call(
      { toolName: "read", input: { path: "b.txt" } },
      ctx,
    );
    expect(patches().length).toBe(0); // no edit: non-essential at 1

    // 1 -> 0: live block deleted on the transition
    await handleInbound(pi, inbound("/verbose off", "m3"), ctx);
    expect(
      fetchCalls.some(
        (c) => c.method === "DELETE" && c.url.includes("/messages/out1"),
      ),
    ).toBe(true);
  });
});

// ─── Slash registry ↔ dispatch routing (2026-10-09) ─────────────────────────
// 2026-10-09 operator report: /usage, /context, /diff, /hold, /tasks,
// /new-worktree, /merge-worktree (+ /handover) had dispatch cases but no
// registered command, so the '/' menu never offered them. One routing test
// per newly registered command: the slash interaction must reach its
// runChannelCommand case WITH the option value (allowlist passthrough).
// Pattern: #206 vault-slash tests (real interaction payload, stubbed fetch,
// deferred-ack edits as the assertion surface).

describe("compaction-queue guard", () => {
  let tmp = "";
  let pi: any;
  let ctx: any;
  let handlers: Record<string, (...a: any[]) => any> = {};
  let sent: { m: any; o: any }[] = [];
  let fetchCalls: { url: string; method: string; body?: any }[] = [];
  const realFetch = globalThis.fetch;

  const inbound = (
    body: string,
    id: string,
    channelId = "ch1",
    fromId = "owner1",
  ): ChannelMessage => ({
    channelId,
    channelName: channelId === "ch2" ? "Test2" : "Test",
    channelType: "discord",
    messageId: id,
    from: fromId,
    fromId,
    body,
    timestamp: new Date().toISOString(),
    attachments: [],
    isRoom: false,
  });

  const tick = () => new Promise((r) => setTimeout(r, 0));
  // The settle drain is macrotask-deferred, and the re-wake handleInbound
  // chain has its own awaits before pi.sendMessage — settle a few ticks.
  const settleTicks = async () => {
    await tick();
    await tick();
    await tick();
  };

  const channelPosts = (chId = "ch1") =>
    fetchCalls
      .filter(
        (c) =>
          (c.url.includes(`/channels/${chId}/messages`) ||
            // ch2 resolves its Discord channel id from settings
            (chId === "ch2" && c.url.includes("/channels/999/messages"))) &&
          c.method === "POST",
      )
      .map(
        (c) =>
          (typeof c.body === "string" ? JSON.parse(c.body) : c.body).content,
      );

  const piSends = () =>
    sent.filter((s) => s.m?.customType === "channel-inbound");

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
            channel: "ch1",
            ack: true,
            ownerUserId: "owner1",
          },
          {
            id: "ch2",
            name: "Test2",
            type: "discord",
            botToken: "tok2",
            channel: "999",
            ack: true,
            ownerUserId: "owner1",
          },
        ],
      }),
    );
    handlers = {};
    fetchCalls = [];
    sent = [];
    pi = {
      registerMessageRenderer: () => {},
      on: (n: string, fn: any) => {
        handlers[n] = fn;
      },
      sendMessage: (m: any, o: any) => {
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
  });

  afterEach(async () => {
    clearDiscordStatesForTest(); // no auto-react suppression leaks across tests
    jest.useRealTimers();
    clearAllCompacting();
    for (const id of [...midTurnQueues.keys()]) clearQueuedInbound(id);
    queuedAcks.clear();
    pendingInterrupts.clear();
    handlers.agent_end?.({ messages: [] }, ctx); // flush any pending compact
    clearAllCompacting();
    globalThis.fetch = realFetch;
    fs.rmSync(tmp, { recursive: true, force: true });
    // A settleCompacting deferred drain (setTimeout 0) scheduled by the
    // last test's settle event can still be pending — fire it here, after
    // the queue is cleared, so it no-ops instead of draining the NEXT
    // test's queue (its ctx is stale; isIdle() is the mock default true).
    await tick();
  });

  test("flag lifecycle: set on /compact dispatch, cleared by session_compact and session_compact_failed", async () => {
    ctx.compact = () => {};
    await handleInbound(pi, inbound("/compact", "m1"), ctx);
    expect(isCompacting("ch1")).toBe(true);
    expect(isCompacting("ch2")).toBe(false);

    handlers.session_compact?.(
      {
        type: "session_compact",
        compactionEntry: {},
        fromExtension: false,
        reason: "manual",
        willRetry: false,
      },
      ctx,
    );
    expect(isCompacting("ch1")).toBe(false);

    // re-open, then a FAILED settle also clears
    await handleInbound(pi, inbound("/compact", "m2"), ctx);
    expect(isCompacting("ch1")).toBe(true);
    handlers.session_compact_failed?.(
      {
        type: "session_compact_failed",
        reason: "manual",
        errorMessage: "model down",
        aborted: false,
        willRetry: false,
        fromExtension: false,
      },
      ctx,
    );
    expect(isCompacting("ch1")).toBe(false);
  });

  test("fallback timer: clears the flag after 10 min with a console.warn", async () => {
    jest.useFakeTimers();
    const warns: string[] = [];
    const realWarn = console.warn;
    console.warn = (...a: any[]) => {
      warns.push(a.join(" "));
    };
    try {
      ctx.compact = () => {};
      await handleInbound(pi, inbound("/compact", "m1"), ctx); // dispatched idle
      expect(isCompacting("ch1")).toBe(true);
      jest.advanceTimersByTime(10 * 60 * 1000);
      expect(isCompacting("ch1")).toBe(false);
      expect(warns.some((w) => w.includes("still compacting"))).toBe(true);
    } finally {
      console.warn = realWarn;
      jest.useRealTimers();
    }
  });

  test("fallback timer drains a queued message behind the stuck window", async () => {
    jest.useFakeTimers();
    ctx.compact = () => {};
    await handleInbound(pi, inbound("/compact", "m1"), ctx); // dispatched idle
    // flag set: even with isIdle true the gate keeps the window active,
    // so a plain message queues (with the flag, isIdle stays moot)
    await handleInbound(pi, inbound("late msg", "m2"), ctx);
    expect(midTurnQueues.get("ch1")?.length).toBe(1);
    jest.advanceTimersByTime(10 * 60 * 1000); // fallback: clear + drain (idle)
    jest.useRealTimers(); // let the async re-wake run on real timers
    // the drain's handleInbound has its own async hops, so its
    // completion can land late under load; poll instead of a single tick
    for (let i = 0; i < 200; i++) {
      if (piSends().some((s) => s.m.details?.body === "late msg")) break;
      await tick();
    }
    expect(piSends().some((s) => s.m.details?.body === "late msg")).toBe(true);
    expect(isCompacting("ch1")).toBe(false);
  });

  test("plain message while compacting: queued with ack, interrupt NOT armed", async () => {
    verboseOverride.set("ch1", 1); // verbose 1: the [queued] ack posts
    ctx.compact = () => {};
    await handleInbound(pi, inbound("/compact", "m1"), ctx);
    ctx.isIdle = () => false; // compaction now in flight
    expect(isCompacting("ch1")).toBe(true);

    await handleInbound(pi, inbound("hello while compacting", "m2"), ctx);
    await tick();
    expect(midTurnQueues.get("ch1")?.length).toBe(1);
    expect(pendingInterrupts.has("ch1")).toBe(false); // no interrupt armed
    expect(channelPosts().some((t) => t.includes("[queued] 1 in line"))).toBe(
      true,
    );
    expect(piSends().length).toBe(0); // not sent to pi yet
  });

  test("queued message delivered on the SUCCESS settle without further inbound (pi emits session_compact BEFORE clearing its compaction state, so isIdle() is still false at event time)", async () => {
    ctx.compact = () => {};
    await handleInbound(pi, inbound("/compact", "m1"), ctx);
    ctx.isIdle = () => false; // compaction in flight
    await handleInbound(pi, inbound("queued one", "m2"), ctx);
    await handleInbound(pi, inbound("queued two", "m3"), ctx);
    expect(piSends().length).toBe(0);

    // pi real ordering (agent-session.js): await emit(session_compact) with
    // _compactionAbortController still set -> isIdle() false DURING the
    // handler; _clearManualCompactionState() runs only after the emit
    // returns. The settle drain is macrotask-deferred, so it must survive
    // the false-at-event-time isIdle.
    handlers.session_compact?.(
      {
        compactionEntry: {},
        reason: "manual",
        willRetry: false,
        fromExtension: false,
      },
      ctx,
    );
    ctx.isIdle = () => true; // _clearManualCompactionState() ran
    await settleTicks();
    // No further inbound: the queued message is re-woken by the settle.
    const first = piSends().find((s) => s.m.details?.body === "queued one");
    expect(first).toBeDefined();
    expect(first?.o?.triggerTurn).toBe(true);
    // one re-wake per settle; the run's agent_end drains the rest
    expect(midTurnQueues.get("ch1")?.length).toBe(1);
  });

  test("queued messages also drain after a failed compaction", async () => {
    ctx.compact = () => {};
    await handleInbound(pi, inbound("/compact", "m1"), ctx);
    ctx.isIdle = () => false;
    await handleInbound(pi, inbound("queued one", "m2"), ctx);
    // pi real ordering (failure path): _clearManualCompactionState() runs
    // BEFORE the emit, so isIdle() is already true at event time.
    ctx.isIdle = () => true;
    handlers.session_compact_failed?.(
      {
        reason: "manual",
        errorMessage: "model down",
        aborted: false,
        willRetry: false,
        fromExtension: false,
      },
      ctx,
    );
    await settleTicks();
    expect(piSends().some((s) => s.m.details?.body === "queued one")).toBe(
      true,
    );
  });

  test("/status works while compacting (read-only, shows compacting)", async () => {
    ctx.compact = () => {};
    await handleInbound(pi, inbound("/compact", "m1"), ctx);
    ctx.isIdle = () => false;
    await handleInbound(pi, inbound("/status", "m2"), ctx);
    await tick();
    const st = channelPosts().find((t) => t.includes("[status]"));
    expect(st).toBeDefined();
    expect(st).toContain("compacting");
    expect(midTurnQueues.has("ch1")).toBe(false); // consumed, not queued
  });

  test("/stop while compacting: owner clears the window, aborts, drops the queue", async () => {
    let aborted = 0;
    ctx.compact = () => {};
    ctx.abort = () => {
      aborted++;
    };
    await handleInbound(pi, inbound("/compact", "m1"), ctx);
    ctx.isIdle = () => false;
    await handleInbound(pi, inbound("wait for me", "m2"), ctx);
    expect(midTurnQueues.get("ch1")?.length).toBe(1);

    await handleInbound(pi, inbound("/stop", "m3"), ctx);
    await tick();
    expect(isCompacting("ch1")).toBe(false);
    expect(aborted).toBe(1);
    expect(midTurnQueues.has("ch1")).toBe(false); // /stop drained the queue
    expect(channelPosts().some((t) => t.includes("[-] stopped"))).toBe(true);
  });

  test("/stop while compacting is owner-only: non-owner gets an immediate reply, nothing queued, window stays", async () => {
    ctx.compact = () => {};
    await handleInbound(pi, inbound("/compact", "m1"), ctx);
    ctx.isIdle = () => false;
    await handleInbound(pi, inbound("/stop", "m2", "ch1", "other"), ctx);
    await tick();
    expect(isCompacting("ch1")).toBe(true); // window untouched
    expect(channelPosts().some((t) => t.includes("[!] owner only"))).toBe(true);
    // Not queued: a queued /stop would re-run ungated after the window
    // closes and drop the channel's re-wake queue + abort the next run.
    expect(midTurnQueues.has("ch1")).toBe(false);
    expect(piSends().length).toBe(0);
    expect(pendingInterrupts.has("ch1")).toBe(false);
  });

  test("/compact while compacting: 'already compacting', single dispatch", async () => {
    let compacts = 0;
    ctx.compact = () => {
      compacts++;
    };
    await handleInbound(pi, inbound("/compact", "m1"), ctx);
    ctx.isIdle = () => false;
    await handleInbound(pi, inbound("/compact again", "m2"), ctx);
    await tick();
    expect(compacts).toBe(1);
    expect(channelPosts().some((t) => t.includes("already compacting"))).toBe(
      true,
    );
    expect(isCompacting("ch1")).toBe(true); // window unchanged
  });

  test("other commands while compacting: queued, but /reset refuses", async () => {
    ctx.compact = () => {};
    await handleInbound(pi, inbound("/compact", "m1"), ctx);
    ctx.isIdle = () => false;
    // /reset would open a second op window on the re-wake — refuse now
    // (F5: names the ACTIVE op — compaction, not a restart)
    await handleInbound(pi, inbound("/reset", "m2"), ctx);
    await tick();
    expect(channelPosts().some((t) => t.includes("already compacting"))).toBe(
      true,
    );
    // a queued-eligible command (/undo) still waits like a plain message
    await handleInbound(pi, inbound("/undo", "m3"), ctx);
    await tick();
    expect(midTurnQueues.get("ch1")?.[0]?.msg.body).toBe("/undo");
    expect(pendingInterrupts.has("ch1")).toBe(false);
  });

  test("channel isolation: ch2 unaffected while ch1 is compacting", async () => {
    jest.useFakeTimers();
    ctx.compact = () => {};
    await handleInbound(pi, inbound("/compact", "m1"), ctx); // ch1
    ctx.isIdle = () => false;
    expect(isCompacting("ch1")).toBe(true);
    expect(isCompacting("ch2")).toBe(false);

    // ch1: queued, interrupt NOT armed
    await handleInbound(pi, inbound("ch1 msg", "m2"), ctx);
    expect(midTurnQueues.get("ch1")?.length).toBe(1);
    expect(pendingInterrupts.has("ch1")).toBe(false);

    // ch2: queued too (isIdle false) and interrupt NOT armed — compaction
    // is session-wide, a ch2 interrupt (ctx.abort()) would kill ch1's
    // compaction, so arming is suppressed while ANY window is open.
    await handleInbound(pi, inbound("ch2 msg", "m3", "ch2"), ctx);
    expect(midTurnQueues.get("ch2")?.length).toBe(1);
    expect(pendingInterrupts.has("ch2")).toBe(false);

    // ch2 /compact is allowed (its own window is closed): it defers behind
    // the session-wide in-flight compaction
    await handleInbound(pi, inbound("/compact", "m4", "ch2"), ctx);
    expect(
      channelPosts("ch2").some((t) =>
        unwarped(t).includes("[queued] compact (compact already in progress)"),
      ),
    ).toBe(true);
    jest.useRealTimers();
  });
});

describe("buildRepliedMessageBlock", () => {
  test("renders author attribute + escaped text (T1)", () => {
    const out = buildRepliedMessageBlock({
      author: 'al "ice"',
      text: "a < b & c",
    });
    expect(out).toBe(
      "This message was a reply to message\n\n<replied-message author=\"al 'ice'\">\na &lt; b &amp; c\n</replied-message>",
    );
  });

  test("empty/absent → empty string (T1)", () => {
    expect(buildRepliedMessageBlock()).toBe("");
    expect(buildRepliedMessageBlock(undefined)).toBe("");
    expect(buildRepliedMessageBlock({ author: "x", text: "" })).toBe("");
  });

  test("missing author omits the attribute (T1)", () => {
    expect(buildRepliedMessageBlock({ author: "", text: "t" })).toBe(
      "This message was a reply to message\n\n<replied-message>\nt\n</replied-message>",
    );
  });
});

describe("handoff token gate: agent_settled re-check (issue #85)", () => {
  // RC1: the gate's first shot fires from agent_end via a 0ms timer, but
  // pi clears the run-active flag (isIdle → true) only in
  // _emitAgentSettled — AFTER the awaited agent_end handler resolves. On
  // any run whose handler awaits Discord I/O (live-text delete, re-wake)
  // the timer fires while isIdle() is still false → silent bail. The
  // agent_settled listener is the reliable shot: pi emits it exactly once
  // per completed run, after every continuation.
  let tmp = "";
  let oldHome = "";
  let storeDir = "";
  let sessDir = "";
  let liveFile = "";
  let pi: any;
  let ctx: any;
  let handlers: Record<string, (...a: any[]) => any> = {};
  let fetchCalls: { url: string; method: string; body?: any }[] = [];
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

  const tick = (ms = 25) => new Promise((r) => setTimeout(r, ms));

  const writeSettings = (handoff: Record<string, unknown>) => {
    fs.mkdirSync(path.join(tmp, ".pi"), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, ".pi", "settings.json"),
      JSON.stringify({ channels: CHANNELS, handoff }),
    );
  };

  const compactPosts = () =>
    fetchCalls
      .filter(
        (c) => c.url.includes("/channels/ch1/messages") && c.method === "POST",
      )
      .map(
        (c) =>
          (typeof c.body === "string" ? JSON.parse(c.body) : c.body).content,
      )
      .filter(
        (t: unknown) =>
          typeof t === "string" && t.includes("[..] compacting..."),
      );

  beforeEach(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "handoff-a85-"));
    oldHome = process.env.HOME || "";
    process.env.HOME = path.join(tmp, "home");
    fs.mkdirSync(path.join(tmp, "home"), { recursive: true });
    storeDir = path.join(tmp, "home", "handovers");
    sessDir = path.join(tmp, "sessions");
    fs.mkdirSync(sessDir, { recursive: true });
    liveFile = path.join(sessDir, "live.jsonl");
    fs.writeFileSync(liveFile, "x".repeat(1024));
    fetchCalls = [];
    (handlers as any) = {};
    pi = {
      on: (n: string, fn: any) => {
        (handlers as any)[n] = fn;
      },
      sendMessage: () => {},
      sendUserMessage: () => {},
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
      modelRegistry: { getAvailable: () => [] },
      sessionManager: {
        getSessionFile: () => liveFile,
        getSessionId: () => "sess-a85",
      },
      getContextUsage: () => ({
        tokens: 222_822,
        contextWindow: 262_144,
        percent: 85,
      }),
      compact: () => {},
      shutdown: () => {},
      on: () => {},
    };
    (globalThis as any).fetch = jest.fn(async (url: any, init?: any) => {
      fetchCalls.push({
        method: init?.method ?? "GET",
        url: String(url),
        body: init?.body,
      });
      return { ok: true, status: 200, json: async () => ({ id: "out1" }) };
    });
    setProcessExitHookForTest(() => {});
    writeSettings({ enabled: true, threshold: 0.8, storeDir });
    seedChannelStateForTest("ch1", "ch1", path.join(tmp, ".tmp"));
    setChannelCursor("ch1", "1000");
    extension(pi as any);
    // Re-point lastActiveChannel at THIS describe's ch1 (module state,
    // leaked by earlier describes) and load channels for presence paths.
    await handlers.session_start?.(null, ctx);
  });
  afterEach(() => {
    setProcessExitHookForTest(null);
    (globalThis as any).fetch = realFetch;
    (handlers as any) = {};
    clearAllCompacting();
    stopAllOpTicks();
    process.env.HOME = oldHome;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test("I/O-pending agent_end bails; agent_settled re-checks and fires", async () => {
    // A run whose agent_end handler awaits Discord I/O (live-text delete,
    // re-wake): pi has NOT cleared the run flag, so isIdle() is false
    // while the 0ms gate timer from agent_end fires.
    ctx.isIdle = () => false;
    await handlers.agent_end?.({ type: "agent_end", messages: [] }, ctx);
    await tick();
    expect(isCompacting("ch1")).toBe(false); // RC1: the agent_end shot bailed

    // pi settles: _isAgentRunActive cleared, agent_settled emitted.
    ctx.isIdle = () => true;
    await handlers.agent_settled?.({ type: "agent_settled" }, ctx);
    await tick();
    expect(isCompacting("ch1")).toBe(true); // the settled shot fired
    expect(compactPosts()).toHaveLength(1);
  });

  test("re-wake active at agent_settled: skip; the re-wake's own settled fires", async () => {
    // The re-wake continuation started from agent_end is still running
    // (a run is active → isIdle false → the gate must yield to that run).
    ctx.isIdle = () => false;
    await handlers.agent_settled?.({ type: "agent_settled" }, ctx);
    await tick();
    expect(isCompacting("ch1")).toBe(false);
    // The re-wake run settles → its own agent_settled re-checks.
    ctx.isIdle = () => true;
    await handlers.agent_settled?.({ type: "agent_settled" }, ctx);
    await tick();
    expect(isCompacting("ch1")).toBe(true);
    expect(compactPosts()).toHaveLength(1);
  });

  test("I/O-free agent_end fires first; agent_settled double-fire is safe", async () => {
    // The old lucky path: the handler settles I/O-free, so the agent_end
    // 0ms timer runs the gate with isIdle() true and starts the compact.
    ctx.isIdle = () => true;
    await handlers.agent_end?.({ type: "agent_end", messages: [] }, ctx);
    await tick();
    expect(isCompacting("ch1")).toBe(true);
    // agent_settled's second shot must bail on the isCompacting guard —
    // ONE compact window, ONE placeholder post.
    await handlers.agent_settled?.({ type: "agent_settled" }, ctx);
    await tick();
    expect(isCompacting("ch1")).toBe(true);
    expect(compactPosts()).toHaveLength(1);
  });

  test("under threshold at settled: no compact", async () => {
    ctx.getContextUsage = () => ({
      tokens: 131_072,
      contextWindow: 262_144,
      percent: 50,
    });
    ctx.isIdle = () => true;
    await handlers.agent_settled?.({ type: "agent_settled" }, ctx);
    await tick();
    expect(isCompacting("ch1")).toBe(false);
    expect(compactPosts()).toHaveLength(0);
  });

  test("handoff disabled at settled: no compact", async () => {
    writeSettings({ enabled: false, threshold: 0.8, storeDir });
    ctx.isIdle = () => true;
    await handlers.agent_settled?.({ type: "agent_settled" }, ctx);
    await tick();
    expect(isCompacting("ch1")).toBe(false);
    expect(compactPosts()).toHaveLength(0);
  });

  test("stale ctx at timer fire: gate skips, no unhandled rejection (2026-10-19 pi -p exit crash)", async () => {
    // pi -p: the session ends at run end, so the agent_settled gate timer
    // ALWAYS fires against a replaced (dead) session: the ctx.cwd getter
    // throws "stale". Pre-fix, that throw escaped as a REJECTED promise —
    // the try/catch around `void maybeAutoCompactByToken` only caught
    // sync throws — and the unhandled rejection killed `pi -p` at exit.
    Object.defineProperty(ctx, "cwd", {
      get() {
        throw new Error(
          "This extension ctx is stale after session replacement or reload. Do not use a captured pi or command ctx after ctx.newSession(), ctx.fork(), ctx.switchSession(), or ctx.reload().",
        );
      },
      configurable: true,
    });

    // 1. Direct call: the defensive guard makes the gate RESOLVE (not
    // reject) on a stale ctx — the replacement session's own settle
    // re-runs the gate.
    await expect(maybeAutoCompactByToken(pi, ctx)).resolves.toBeUndefined();
    expect(isCompacting("ch1")).toBe(false);

    // 2. The real crash path: the armed 0ms timer with a stale ctx must
    // not surface an unhandled rejection.
    const rejections: unknown[] = [];
    const onRejection = (r: unknown) => rejections.push(r);
    process.on("unhandledRejection", onRejection);
    try {
      autoCompactByToken(pi, ctx);
      await tick(50); // let the timer + rejection microtask run
    } finally {
      process.off("unhandledRejection", onRejection);
    }
    expect(rejections).toEqual([]);
    expect(isCompacting("ch1")).toBe(false);
  });
});

describe("v3 column budget (mockup3): every rendered frame line fits 40 cols", () => {
  const longAction =
    "bash cargo build --release --features everything,extra,long-flags -p some-crate";
  const longPath =
    "/home/monky/.pi-bg-wt/jarate/20260913-091303-15761/packages/bridge/channel/index.ts";

  // one constant per language: the TS fit budgets derive from the shared
  // 40-col law (frame.ts), never a local re-hardcode
  test("fit budgets derive from FRAME_COL_MAX (the 40-col law)", () => {
    expect(FRAME_COL_MAX).toBe(40);
    expect(TOOL_LINE_MAX).toBe(FRAME_COL_MAX);
    expect(TOOL_TEXT_MAX).toBe(FRAME_COL_MAX - "│ ├ ".length);
    expect(TOOL_TEXT_MAX).toBe(36);
  });

  test("runFrame(working) fits the budget at any call count or elapsed time", () => {
    const calls = Array.from(
      { length: 999 },
      (_, i) => `bash step-${i} --flag`,
    );
    for (const count of [0, 1, 9, 99, 999]) {
      for (const secs of [0, 5, 96, 9999]) {
        const frame = runFrame(
          "working",
          calls.slice(0, count),
          count,
          secs,
        ).split("\n");
        // header uses the k/m compact form (fmtTokensLC): raw 9999 secs
        // would be `9999s` (5 cols), the compact form is `10ks` (4 cols)
        expect(frame[0]).toBe(
          `┌ working · ${fmtTokensLC(count)} call${count === 1 ? "" : "s"} · ${fmtTokensLC(secs)}s`,
        );
        expect(frame.at(-1)).toBe("└");
        for (const line of frame) {
          expect(line.length).toBeLessThanOrEqual(TOOL_LINE_MAX);
        }
      }
    }
  });

  test("runFrame header: 6-digit count/secs compact, never > 40 cols (PR #64 review P3)", () => {
    // the review probe: `┌ working · 123456 calls · 999999s` = 34 cols
    for (const count of [1000, 9999, 123456, 999999]) {
      for (const secs of [1000, 9999, 123456, 999999]) {
        const header = runFrame("working", [], count, secs).split("\n")[0];
        expect(header.length).toBeLessThanOrEqual(TOOL_LINE_MAX);
      }
    }
    expect(runFrame("working", [], 123456, 999999).split("\n")[0]).toBe(
      "┌ working · 123k calls · 1000ks",
    );
    expect(runFrame("failed", [], 999999, 999999).split("\n")[0]).toBe(
      "┤ failed · 1000k calls · 1000ks",
    );
    expect(runFrame("done", [], 1000, 999).split("\n")[0]).toBe(
      "┌ done · 1k calls · 999s",
    );
  });

  test("toolActionText is frame-safe (<=36) and keeps verbs + filename tails", () => {
    const cases: Array<[string, Record<string, unknown>]> = [
      ["bash", { command: "bun run build 2>&1 | tail -4 && echo done" }],
      ["read", { path: longPath }],
      ["edit", { path: longPath }],
      ["write", { path: longPath }],
      ["web_search", { query: "discord embed column budget mobile" }],
      ["some_custom_tool", { a: "b".repeat(80) }],
    ];
    for (const [name, input] of cases) {
      const action = toolActionText(name, input);
      expect(action.length).toBeLessThanOrEqual(TOOL_TEXT_MAX);
      // a done-frame sub-step always fits the mobile budget
      expect(`│ ├ ${action}`.length).toBeLessThanOrEqual(TOOL_LINE_MAX);
    }
    // verb survives clipping; path clips the head so the filename survives
    expect(toolActionText("edit", { path: longPath })).toBe(
      "edit …ckages/bridge/channel/index.ts",
    );
    expect(
      toolActionText("bash", {
        command: "cargo test --features a,b,c --package some-long-crate-name",
      }),
    ).toBe("bash cargo test --features a,b,c --…");
  });

  test("runFrame(done): header + capped sub-steps + overflow line, all <= 40 cols", () => {
    const calls = Array.from({ length: 14 }, (_, i) => `bash step-${i} --flag`);
    const frame = runFrame("done", calls, 14, 96).split("\n");
    expect(frame[0]).toBe("┌ done · 14 calls · 96s");
    expect(frame[1]).toBe("├ … +6 earlier calls");
    expect(frame.length).toBe(2 + RUN_FRAME_MAX_STEPS + 1);
    expect(frame.at(-1)).toBe("└");
    // last 8 calls, in order, last sub-step on └
    expect(frame[2]).toBe("│ ├ bash step-6 --flag");
    expect(frame.at(-2)).toBe("│ └ bash step-13 --flag");
    for (const line of frame) {
      expect(line.length).toBeLessThanOrEqual(TOOL_LINE_MAX);
    }
  });

  test("runFrame(failed): failed runs swap the header to the ┤ failed glyph", () => {
    const frame = runFrame("failed", ["read x.ts"], 1, 5).split("\n");
    expect(frame[0]).toBe("┤ failed · 1 call · 5s");
    expect(frame.at(-1)).toBe("└");
    for (const line of frame) {
      expect(line.length).toBeLessThanOrEqual(TOOL_LINE_MAX);
    }
  });

  test("runFrame: working/done/failed share the body; only the header flips", () => {
    const calls = ["edit a.txt", "bash git push"];
    const w = runFrame("working", calls, 2, 7).split("\n");
    const d = runFrame("done", calls, 2, 96).split("\n");
    const f = runFrame("failed", calls, 2, 96).split("\n");
    expect(w[0]).toBe("┌ working · 2 calls · 7s");
    expect(d[0]).toBe("┌ done · 2 calls · 96s");
    expect(f[0]).toBe("┤ failed · 2 calls · 96s");
    // live-frame unification: sub-steps + closing bar are identical across
    // states — the done/failed morph changes the header line only
    expect(w.slice(1)).toEqual(d.slice(1));
    expect(w.slice(1)).toEqual(f.slice(1));
    expect(w[1]).toBe("│ ├ edit a.txt");
    expect(w[2]).toBe("│ └ bash git push");
  });

  test("runFrame(working): 0 calls renders header + closing bar only", () => {
    const frame = runFrame("working", [], 0, 10).split("\n");
    expect(frame).toEqual(["┌ working · 0 calls · 10s", "└"]);
  });

  test("runFrame(done): very long actions clip at the line budget", () => {
    const frame = runFrame("done", [longAction, "bash ok"], 2, 5).split("\n");
    for (const line of frame) {
      expect(line.length).toBeLessThanOrEqual(TOOL_LINE_MAX);
    }
    expect(frame.at(-2)).toBe("│ └ bash ok");
  });

  test("fit: a cut between a backslash and its escaped char shifts back one", () => {
    // cut lands after a lone escape backslash (odd run) -> shift back,
    // the dangling backslash drops, budget stays <= max
    expect(fit(`${"a".repeat(14)}\\bc`, 16)).toBe(`${"a".repeat(14)}…`);
    // even trailing run = complete escaped pair -> no shift
    expect(fit(`${"a".repeat(13)}\\\\"b`, 16)).toBe(`${"a".repeat(13)}\\\\…`);
    // no backslash at the cut -> unchanged behavior
    expect(fit("abcdef", 4)).toBe("abc…");
    // short strings pass through
    expect(fit("ab", 4)).toBe("ab");
  });

  test("toolActionText: clipped escaped args never end in a dangling backslash", () => {
    // 3-char key + 9 JSON quotes: the 36-col cut lands inside a
    // 2-char escape unit (the old clip left a dangling `\` before …)
    const action = toolActionText("t", { abc: `"`.repeat(9) });
    expect(action.length).toBeLessThanOrEqual(36);
    expect(action.endsWith("…")).toBe(true);
    // backslash run right before the ellipsis must be even (paired)
    const run = action.match(/(\\*)…$/)![1].length;
    expect(run % 2).toBe(0);
  });
});

// ─── wave 2c: #12 worktree, #13 ctx watch, #40 run usage, #44 jobs ──

// ─────────────────────────────────────────────────────────────────────────

// ── #84: stale placeholder settlement (all exit paths) ──────────────────
//
// A placeholder (working frame, SPEC B live text, [queued] ack, in-flight
// interrupt, compact line) must reach a terminal state on EVERY exit path:
// interrupt, run end (any channel), channel switch, agent_end throw,
// shutdown, and process death (crash record settled at next startup).

// ─── Live marker (issue #191 M2: agent liveness) ─────────────────────────
// The bridge touches <LIVE_MARKER_DIR>/<uid> (0644) in a sticky 1777 dir
// once per poll cycle + at session start. The liveness paging on marker
// staleness now runs on the hall-monitor control plane (hm#59; the
// watchdog's fleet liveness sweep left with #280/3a). The class it
// exists for: a pi.service death with no in-flight tickets produced
// zero ticket-class events (2026-10-04 monky OOM incident, 33 min
// dark). /var/tmp (not /tmp): the pre-boot marker survives a reboot
// so a reboot classifies as BOOT-GAP instead of a fresh-boot alert.
// The touch is best-effort: a failure must never break the poll loop.
describe("live marker (#191 M2)", () => {
  const uid = process.getuid?.() ?? 0;

  test("LIVE_MARKER_DIR defaults to /var/tmp/jarate-live (the shared default root)", () => {
    expect(LIVE_MARKER_DIR).toBe("/var/tmp/jarate-live");
  });

  test("touchLiveMarker creates the sticky 1777 dir + 0644 <uid> file and returns the path", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jarate-live-"));
    try {
      const before = Date.now();
      const f = touchLiveMarker(dir);
      expect(f).toBe(path.join(dir, String(uid)));
      expect(fs.statSync(dir).mode & 0o7777).toBe(0o1777);
      expect(fs.statSync(f as string).mode & 0o777).toBe(0o644);
      expect(
        Number(fs.readFileSync(f as string, "utf8")),
      ).toBeGreaterThanOrEqual(before);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("touchLiveMarker is idempotent: re-touch refreshes the same file, no churn", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jarate-live-"));
    try {
      const f1 = touchLiveMarker(dir);
      const f2 = touchLiveMarker(dir);
      expect(f2).toBe(f1);
      expect(fs.readdirSync(dir)).toEqual([String(uid)]);
      expect(fs.statSync(dir).mode & 0o7777).toBe(0o1777);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("touchLiveMarker is best-effort: a non-creatable path returns null (never throws)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jarate-live-"));
    try {
      const blocker = path.join(dir, "blocker");
      fs.writeFileSync(blocker, "x"); // a file where the dir must go
      expect(touchLiveMarker(path.join(blocker, "sub"))).toBeNull();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("fleet dispatch run gate (hall-monitor #35 gut, 2026-10-20)", () => {
  let tmp = "";
  let pi: any;
  let ctx: any;
  let handlers: Record<string, (...a: any[]) => any> = {};
  let sent: { m: any; o?: any }[] = [];
  let fetchCalls: { url: string; method: string }[] = [];

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "piscord-fleet-"));
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
    resetRuntimeStateForTest();
    fetchCalls = [];
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
    // URL-aware mock: channel "ch1" resolves to Discord id 111 via the DM
    // list; a persisted cursor seeds the #180 scan window. (The generic
    // {id:"out1"} shape is not iterable, so guild/DM traversal would fail.)
    globalThis.fetch = (async (url: any, init?: any) => {
      const u = String(url);
      fetchCalls.push({ url: u, method: init?.method ?? "GET" });
      let body: any = { id: "out1" };
      if (u.includes("/users/@me/guilds")) body = [];
      else if (u.includes("/users/@me/channels"))
        body = [{ name: "ch1", id: "111" }];
      else if (u.endsWith("/users/@me")) body = { id: "999" };
      else if (u.includes("/messages")) body = [];
      return {
        ok: true,
        status: 200,
        json: async () => body,
        text: async () => "",
      };
    }) as any;
    // persisted cursor (the previous process's last message): with it the
    // #180 startup scan has a window to fetch
    fs.mkdirSync(path.join(tmp, ".tmp"), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, ".tmp", "channel-state.json"),
      JSON.stringify({ channels: {}, cursors: { "111": "123456" } }),
    );
  });

  afterEach(() => {
    clearDiscordStatesForTest();
    resetRuntimeStateForTest();
    delete process.env.PI_SESSION_ID;
  });

  test("isFleetRun: the wrapper's fleetwork- session id only", () => {
    expect(isFleetRun()).toBe(false); // unset (interactive shells)
    // pi sets PI_SESSION_ID to its own UUID for interactive sessions -
    // only the run wrapper's fleetwork-<ticket> pin gates the channel
    process.env.PI_SESSION_ID = "01a0ccd0-0e87-75ec-bfa0-7d382f5274";
    expect(isFleetRun()).toBe(false);
    process.env.PI_SESSION_ID = "fleetwork-35";
    expect(isFleetRun()).toBe(true);
  });

  test("fleet run: session_start gates ALL channel startup (no connect, no scan, no wake)", async () => {
    process.env.PI_SESSION_ID = "fleetwork-35";
    await handlers.session_start?.({ reason: "startup" }, ctx);
    // the pilot failure shape: dispatch runs 3/5/6 posted restart-wake
    // cards onto the interactive channel on start. Now: zero Discord
    // REST (no connect /users/@me, no #180 scan messages?before=),
    // zero outbound (no wake post).
    expect(fetchCalls).toHaveLength(0);
    expect(sent).toHaveLength(0);
  });

  test("interactive run: startup connect + #180 scan proceed unchanged", async () => {
    process.env.PI_SESSION_ID = "01a0ccd0-0e87-75ec-bfa0-7d382f5274";
    await handlers.session_start?.({ reason: "startup" }, ctx);
    // the #180 scan is fire-and-forget; give it loop turns to fetch
    for (
      let i = 0;
      i < 40 && !fetchCalls.some((c) => c.url.includes("before="));
      i++
    )
      await new Promise((r) => setTimeout(r, 10));
    // connect REST (bot identity) + the bounded startup history scan
    // (before=<persisted cursor>)
    expect(fetchCalls.some((c) => c.url.includes("/users/@me"))).toBe(true);
    expect(fetchCalls.some((c) => c.url.includes("before=123456"))).toBe(true);
  });

  test("#306 amnesia: session_start re-queues accepted-but-unpersisted inbounds", async () => {
    // The resumed session file (a DIFFERENT prompt — the committed id
    // was never persisted: the mid-turn restart killed pi first).
    const sessionFile = path.join(tmp, "session.jsonl");
    fs.writeFileSync(
      sessionFile,
      JSON.stringify({
        type: "custom_message",
        content: "ctx\n\nsome other body",
      }) + "\n",
    );
    (ctx as any).sessionManager = { getSessionFile: () => sessionFile };
    // A delivered id committed against THIS session file, with metadata.
    rewakeCommitDelivered(path.join(tmp, ".tmp"), "ch1", "100", {
      prompt: "ctx\n\nbody 100",
      msg: {
        channelId: "ch1",
        channelName: "Test",
        channelType: "discord",
        messageId: "100",
        from: "Beepy",
        body: "body 100",
        timestamp: new Date().toISOString(),
        attachments: [],
        isRoom: false,
      },
      at: Date.now(),
      sf: sessionFile,
    });
    midTurnQueues.clear();
    await handlers.session_start?.({ reason: "startup" }, ctx);
    // The amnesia re-queue is synchronous: the entry is back in the
    // in-memory re-wake queue (delivered at the next agent_end).
    const q = midTurnQueues.get("ch1");
    expect(q?.some((e) => e.msg.messageId === "100")).toBe(true);
    // The session file slot was captured for the commit stamp.
    expect(getCurrentSessionFile()).toBe(sessionFile);
  });

  test("#306 amnesia: a persisted (answered) commit is NOT re-queued", async () => {
    const sessionFile = path.join(tmp, "session2.jsonl");
    // The session file HAS the committed id's exact prompt — answered.
    fs.writeFileSync(
      sessionFile,
      JSON.stringify({ type: "custom_message", content: "ctx\n\nbody 200" }) +
        "\n",
    );
    (ctx as any).sessionManager = { getSessionFile: () => sessionFile };
    rewakeCommitDelivered(path.join(tmp, ".tmp"), "ch1", "200", {
      prompt: "ctx\n\nbody 200",
      msg: {
        channelId: "ch1",
        channelName: "Test",
        channelType: "discord",
        messageId: "200",
        from: "Beepy",
        body: "body 200",
        timestamp: new Date().toISOString(),
        attachments: [],
        isRoom: false,
      },
      at: Date.now(),
      sf: sessionFile,
    });
    midTurnQueues.clear();
    await handlers.session_start?.({ reason: "startup" }, ctx);
    // The persisted commit is not re-queued: the queue has no "200"
    // (an empty queue is the expected shape — nothing to deliver).
    expect(
      midTurnQueues.get("ch1")?.some((e) => e.msg.messageId === "200") ?? false,
    ).toBe(false);
  });
});
