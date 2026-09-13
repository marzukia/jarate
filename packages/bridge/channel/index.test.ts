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
import extension, {
  buildInteractionHandler,
  buildRepliedMessageBlock,
  buildRestartCommand,
  chunkText,
  clearAllCompacting,
  clearAllInterrupts,
  clearQueuedInbound,
  collectFinals,
  DONE_FRAME_MAX_STEPS,
  deleteQueuedInbound,
  deliverDueTasks,
  deliverDueWakes,
  doneFrame,
  earlySendText,
  failurePostText,
  fileOnlyPrompt,
  handleInbound,
  interruptStepTimeoutMs,
  isCompacting,
  isVerbose,
  matchCommand,
  midTurnQueues,
  opWindowLabel,
  parseReplyTo,
  pendingAttachments,
  pendingInterrupts,
  prunePendingBatches,
  queuedAcks,
  queueMidTurnInbound,
  REPEAT_WARNING,
  registerSleepTool,
  registerTaskTool,
  registerTodoTool,
  runMidRunInterrupt,
  runShellPassthrough,
  setInterruptCtx,
  setSystemdRestartHookForTest,
  statusLine,
  stopAllCompactTicks,
  stopAllOpTicks,
  TODO_TOOL_DESCRIPTION,
  TOOL_LINE_MAX,
  toolActionText,
  updateQueuedInbound,
  verboseOverride,
} from "./index";
import { CLAIM_TTL_MS, loadWakes, markClaimed, scheduleWake } from "./sleep";
import { loadTasks, markTaskClaimed, scheduleTask } from "./tasks";
import { loadBoard, renderBoard, saveBoard } from "./todos";
import {
  type ChannelMessage,
  loadChannelConfig,
  resolveSystemdUnit,
} from "./types";
import { performUndo } from "./undo";

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

describe("matchCommand (A3)", () => {
  test("slash commands match, with and without args", () => {
    expect(matchCommand("/stop")).toEqual({ name: "stop", arg: undefined });
    expect(matchCommand("/stop now")).toEqual({ name: "stop", arg: "now" });
    expect(matchCommand("/status")).toEqual({ name: "status", arg: undefined });
    expect(matchCommand("/reset the table")).toEqual({
      name: "reset",
      arg: "the table",
    });
    expect(matchCommand("/verbose on")).toEqual({ name: "verbose", arg: "on" });
    expect(matchCommand("/help")).toEqual({ name: "help", arg: undefined });
    expect(matchCommand("/btw what is up")).toEqual({
      name: "btw",
      arg: "what is up",
    });
    expect(matchCommand("/compact keep the decisions")).toEqual({
      name: "compact",
      arg: "keep the decisions",
    });
    expect(matchCommand("/model hydrogen/qwen3.8-27b")).toEqual({
      name: "model",
      arg: "hydrogen/qwen3.8-27b",
    });
    expect(matchCommand("/jobs")).toEqual({ name: "jobs", arg: undefined });
    expect(matchCommand("/todos")).toEqual({ name: "todos", arg: undefined });
    expect(matchCommand("/todos all")).toEqual({ name: "todos", arg: "all" });
    expect(matchCommand("/sleep")).toEqual({ name: "sleep", arg: undefined });
    expect(matchCommand("/sleep list")).toEqual({ name: "sleep", arg: "list" });
    expect(matchCommand("/sleep cancel abc123")).toEqual({
      name: "sleep",
      arg: "cancel abc123",
    });
    expect(matchCommand("/tasks")).toEqual({ name: "tasks", arg: undefined });
    expect(matchCommand("/tasks list")).toEqual({ name: "tasks", arg: "list" });
    expect(matchCommand("/tasks cancel abc123")).toEqual({
      name: "tasks",
      arg: "cancel abc123",
    });
    expect(matchCommand("/diff")).toEqual({ name: "diff", arg: undefined });
    expect(matchCommand("/diff main..HEAD")).toEqual({
      name: "diff",
      arg: "main..HEAD",
    });
  });

  test("bare stop is exact-match only", () => {
    expect(matchCommand("stop")).toEqual({ name: "stop", arg: undefined });
    expect(matchCommand("STOP")).toEqual({ name: "stop", arg: undefined });
    expect(matchCommand("stop ")).toBeNull();
    expect(matchCommand("stop that")).toBeNull();
  });

  test("no-slash other commands are chat, not commands", () => {
    expect(matchCommand("status update")).toBeNull();
    expect(matchCommand("help me with X")).toBeNull();
    expect(matchCommand("btw I was thinking")).toBeNull();
    expect(matchCommand("reset the table")).toBeNull();
    expect(matchCommand("verbose on")).toBeNull();
    expect(matchCommand("compact the logs")).toBeNull();
    expect(matchCommand("model switch")).toBeNull();
    expect(matchCommand("stop1")).toBeNull();
  });

  test("near-misses are not commands", () => {
    expect(matchCommand("/stopx")).toBeNull();
    expect(matchCommand("/todosx")).toBeNull();
    expect(matchCommand("todos")).toBeNull();
    expect(matchCommand("sleep")).toBeNull();
    expect(matchCommand("/sleepx")).toBeNull();
    expect(matchCommand(" stop")).toBeNull();
    expect(matchCommand("/ /stop")).toBeNull();
  });
});

describe("runShellPassthrough (!)", () => {
  test("runs bash -c and returns output + exit code", async () => {
    const r = await runShellPassthrough("echo hello; exit 3", "/tmp");
    expect(r.out).toContain("hello");
    expect(r.code).toBe(3);
    expect(r.timedOut).toBeFalse();
  });

  test("captures stderr", async () => {
    const r = await runShellPassthrough("echo oops 1>&2", "/tmp");
    expect(r.out).toContain("oops");
  });

  test("empty output yields empty out", async () => {
    const r = await runShellPassthrough("true", "/tmp");
    expect(r.out).toBe("");
    expect(r.code).toBe(0);
  });
});

describe("failurePostText (A2)", () => {
  const failure = (stopReason: string, errorMessage?: string) => ({
    role: "assistant",
    content: [{ type: "text", text: "" }],
    stopReason,
    errorMessage,
  });

  test("error stopReason posts the errorMessage", () => {
    expect(failurePostText([failure("error", "boom")], false)).toBe("[!] boom");
  });

  test("error without errorMessage posts a fallback", () => {
    expect(failurePostText([failure("error")], false)).toBe("[!] run failed");
  });

  test("aborted with errorMessage posts when the run was not user-stopped", () => {
    expect(failurePostText([failure("aborted", "interrupted")], false)).toBe(
      "[!] interrupted",
    );
  });

  test("aborted run shaped stopReason=error is suppressed when user-stopped", () => {
    // pi's stream layer maps ctx.abort() to stopReason "error" +
    // errorMessage "This operation was aborted" (verified in a live
    // session, 2026-09-10). /stop, /reset and the mid-run interrupt set
    // the user-stopped flag, so the failure post is expected noise.
    expect(
      failurePostText([failure("error", "This operation was aborted")], true),
    ).toBeNull();
  });

  test("error run shaped stopReason=error still posts when NOT user-stopped", () => {
    expect(
      failurePostText([failure("error", "This operation was aborted")], false),
    ).toBe("[!] This operation was aborted");
  });

  test("aborted with errorMessage is silent when the user stopped the run", () => {
    expect(
      failurePostText([failure("aborted", "interrupted")], true),
    ).toBeNull();
  });

  test("aborted without errorMessage is silent", () => {
    expect(failurePostText([failure("aborted")], false)).toBeNull();
  });

  test("normal stop is silent", () => {
    expect(failurePostText([failure("stop")], false)).toBeNull();
  });

  test("no messages or non-assistant last message is silent", () => {
    expect(failurePostText([], false)).toBeNull();
    expect(failurePostText([{ role: "user", content: [] }], false)).toBeNull();
  });
});

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
      return {
        ok: true,
        status: 200,
        json: async () => ({ id: "out1" }),
        text: async () => "",
      };
    }) as any;
  });

  afterEach(async () => {
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
    const stepFinal = {
      role: "assistant",
      content: [
        { type: "text", text: "working on it" },
        { type: "toolCall", toolName: "read", arguments: {} },
      ],
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

  test("A2: agent_end posts [!] + errorMessage on a failed run", async () => {
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
    expect(JSON.parse(post!.body).content).toBe("[!] boom");
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
    verboseOverride.set("ch1", true); // display gate: block renders only when verbose
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
        String(JSON.parse(c.body).content).startsWith("┣ working"),
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
    verboseOverride.set("ch1", true); // display gate: block renders only when verbose
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
    const doneBody = String(JSON.parse(doneEdit!.body).content);
    expect(doneBody).toContain("│ └ bash ls"); // sub-step, last = └
    expect(doneBody.trimEnd().endsWith("└")).toBe(true); // closing bar
    const deleted = fetchCalls.find(
      (c) => c.method === "DELETE" && c.url.includes("/messages/out1"),
    );
    expect(deleted).toBeUndefined();
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
      posts.filter((c) => String(JSON.parse(c.body).content).includes("┣"))
        .length,
    ).toBe(0); // no "┣ working…" placeholder, no tool line
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
    verboseOverride.set("ch1", true);
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
    verboseOverride.set("ch1", false);
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
    verboseOverride.set("ch1", true);
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
          String(JSON.parse(c.body).content).startsWith("┣ working"),
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
        .filter((c) => String(JSON.parse(c.body).content).includes("┣")),
    ).toHaveLength(0); // quiet run so far

    verboseOverride.set("ch1", true);
    await handlers.tool_call(
      { toolName: "bash", input: { command: "pwd" } },
      ctx,
    );
    // fresh block created by the next tool call (no stale placeholder to edit)
    const toolPost = fetchCalls.find(
      (c) =>
        c.method === "POST" &&
        c.url.endsWith("/channels/ch1/messages") &&
        String(JSON.parse(c.body).content).includes("┣ bash pwd"),
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
        .find((t) => t.startsWith("[status]"));
    };
    // off by default: quiet
    await handleInbound(pi, inbound("/status", "m1"), ctx);
    let st = statusPost();
    expect(st).toBeDefined();
    expect(st).toContain("quiet");
    expect(st).not.toContain("verbose");

    // /verbose on: the next /status says verbose
    await handleInbound(pi, inbound("/verbose on", "m2"), ctx);
    expect(
      fetchCalls.some(
        (c) =>
          c.method === "POST" &&
          c.url.endsWith("/channels/ch1/messages") &&
          String(JSON.parse(c.body).content).includes("[ok] verbose on"),
      ),
    ).toBe(true);
    fetchCalls.length = 0;
    await handleInbound(pi, inbound("/status", "m3"), ctx);
    st = statusPost();
    expect(st).toBeDefined();
    expect(st).toContain("verbose");
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
      setInterruptCtx(null);
      clearAllInterrupts();
      pendingInterrupts.clear();
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
      await handleInbound(pi, inbound("first", "m1"), ctx);
      jest.advanceTimersByTime(interruptStepTimeoutMs());
      await Promise.resolve();
      expect(abortCount).toBe(1);
      // /stop during the settle window: drops m1 AND consumes the flag
      await handleInbound(pi, inbound("/stop", "m2"), ctx);
      jest.advanceTimersByTime(25);
      await Promise.resolve();
      expect(sent.length).toBe(0);
      // Run still active; m3 is queued and armed — its interrupt must be
      // delivered (the flag consumed by m1's drop must not kill it)
      await handleInbound(pi, inbound("third", "m3"), ctx);
      jest.advanceTimersByTime(interruptStepTimeoutMs());
      await Promise.resolve();
      expect(abortCount).toBe(3);
      idle = true;
      jest.advanceTimersByTime(25);
      await Promise.resolve();
      expect(sent.length).toBe(1);
      expect(sent[0].m.details.messageId).toBe("m3");
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
      setInterruptCtx(null);
      clearAllInterrupts();
      pendingInterrupts.clear();
      queuedAcks.clear();
      jest.useRealTimers();
    });

    test("queued ack shows the position in line (and suppresses the 👀)", async () => {
      ctx.isIdle = () => false;
      await handleInbound(pi, inbound("first", "m1"), ctx);
      await flush();
      expect(midTurnQueues.get("ch1")?.length).toBe(1);
      const ack1 = fetchCalls.find(
        (c) =>
          c.method === "POST" &&
          String(JSON.parse(c.body).content) === "[queued] 1 in line",
      );
      expect(ack1).toBeDefined();
      expect(JSON.parse(ack1!.body).message_reference?.message_id).toBe("m1");

      await handleInbound(pi, inbound("second", "m2"), ctx);
      await flush();
      expect(midTurnQueues.get("ch1")?.length).toBe(2);
      const ack2 = fetchCalls.find(
        (c) =>
          c.method === "POST" &&
          String(JSON.parse(c.body).content) === "[queued] 2 in line",
      );
      expect(ack2).toBeDefined();

      // The [queued] line IS the ack: no 👀 reaction on the queued message.
      const react = fetchCalls.find(
        (c) => c.method === "PUT" && c.url.includes("/messages/m1/reactions/"),
      );
      expect(react).toBeUndefined();
    });

    test("'. queue' parks in the re-wake queue and does NOT arm the interrupt", async () => {
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
          String(JSON.parse(c.body).content) === "[queued] 1 in line",
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
          String(JSON.parse(c.body).content) === "[queued] 1 in line",
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
          String(JSON.parse(c.body).content) === "[queued] 1 in line",
      );
      expect(patch).toBeDefined();
    });

    test("delete is owner-only", async () => {
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
        String(JSON.parse(c.body).content).startsWith("[buffered]"),
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
        String(JSON.parse(c.body).content).startsWith("[buffered]"),
    );
    expect(acks.length).toBe(1);
    expect(JSON.parse(acks[0].body).content).toBe(
      "[buffered] 2 files - send text to attach them",
    );
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
        String(JSON.parse(c.body).content).startsWith("[buffered]"),
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
        String(JSON.parse(c.body).content).startsWith("[buffered]"),
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
    expect(contents.filter((t) => t === REPEAT_WARNING).length).toBe(1);

    // 4th identical does not re-warn (counter reset after the trip).
    await handlers.message_end({ message: fin("same") }, ctx);
    expect(aborts).toBe(1);
    const after = fetchCalls
      .filter(
        (c) => c.method === "POST" && c.url.endsWith("/channels/ch1/messages"),
      )
      .map((c) => JSON.parse(c.body).content);
    expect(after.filter((t) => t === REPEAT_WARNING).length).toBe(1);
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
    expect(contents.filter((t) => t === REPEAT_WARNING).length).toBe(1);
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

describe("buildInteractionHandler (defer-first ack)", () => {
  const realFetch = globalThis.fetch;
  const ch: any = {
    id: "ich",
    name: "IntTest",
    type: "discord",
    botToken: "tok-i",
    channel: "888",
  };
  let pi: any;
  let ctx: any;
  let calls: { url: string; method: string; body?: any }[];

  const d = (name: string, extra: Record<string, any> = {}) => ({
    id: "i1",
    token: "tok123",
    application_id: "app1",
    channel_id: "888",
    user: { id: "owner1" },
    data: { name, options: extra.options },
    ...extra,
  });

  beforeEach(() => {
    calls = [];
    pi = { setModel: async () => true, sendMessage: () => {} };
    ctx = {
      cwd: "/tmp",
      isIdle: () => true,
      hasPendingMessages: () => false,
      abort: () => {},
      compact: () => {},
      modelRegistry: { getAvailable: () => [] },
      getContextUsage: () => undefined,
      model: { id: "cur", name: "Cur" },
    };
    globalThis.fetch = (async (url: any, init?: any) => {
      calls.push({
        url: String(url),
        method: init?.method ?? "GET",
        body: init?.body,
      });
      return {
        ok: true,
        status: 200,
        json: async () => ({}),
        text: async () => "",
      };
    }) as any;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test("type-5 defer is the FIRST network call; result edits the deferred message", async () => {
    const h = buildInteractionHandler(pi, ctx, ch, "tok-i");
    await h(d("help"));
    expect(calls.length).toBe(2);
    expect(calls[0].url).toBe(
      "https://discord.com/api/v10/interactions/i1/tok123/callback",
    );
    expect(JSON.parse(calls[0].body).type).toBe(5);
    expect(calls[1].url).toBe(
      "https://discord.com/api/v10/webhooks/app1/tok123/messages/@original",
    );
    expect(calls[1].method).toBe("PATCH");
    expect(JSON.parse(calls[1].body).content).toContain("**Commands**");
  });

  test("a throwing command still produces the defer ack and an error edit", async () => {
    let abortCalled = false;
    ctx.isIdle = () => false; // a run is active, so /stop calls ctx.abort()
    ctx.abort = () => {
      abortCalled = true;
      throw new Error("boom");
    };
    const h = buildInteractionHandler(pi, ctx, ch, "tok-i");
    await h(d("stop")); // must not throw
    expect(abortCalled).toBe(true);
    expect(calls[0].url).toBe(
      "https://discord.com/api/v10/interactions/i1/tok123/callback",
    );
    expect(JSON.parse(calls[0].body).type).toBe(5);
    const edit = calls.find((c) =>
      c.url.endsWith("/webhooks/app1/tok123/messages/@original"),
    );
    expect(edit).toBeDefined();
    expect(JSON.parse(edit!.body).content).toContain("boom");
  });

  test("btw defers, sends to pi, and leaves the deferred message alone", async () => {
    let sent = false;
    pi.sendMessage = () => {
      sent = true;
    };
    const h = buildInteractionHandler(pi, ctx, ch, "tok-i");
    await h(d("btw", { options: [{ name: "question", value: "is 42 ok?" }] }));
    expect(sent).toBe(true);
    expect(JSON.parse(calls[0].body).type).toBe(5);
    expect(
      calls.find((c) => c.url.endsWith("/messages/@original")),
    ).toBeUndefined();
  });

  test("wrong channel: typed reply, no command run", async () => {
    const h = buildInteractionHandler(pi, ctx, ch, "tok-i");
    await h(d("help", { channel_id: "424242" }));
    expect(calls.length).toBe(1);
    expect(calls[0].url).toBe(
      "https://discord.com/api/v10/interactions/i1/tok123/callback",
    );
    const body = JSON.parse(calls[0].body);
    expect(body.type).toBe(4);
    expect(body.data.content).toBe("use me in #IntTest");
  });

  test("native /model routes through pi.setModel; /compact through ctx.compact", async () => {
    let set: any = null;
    pi.setModel = async (m: any) => {
      set = m;
      return true;
    };
    ctx.modelRegistry = {
      getAvailable: () => [
        { id: "qwen3.8-27b", name: "Qwen", provider: "hydrogen" },
        { id: "other-123", name: "Other", provider: "hydrogen" },
      ],
    };
    let compacted: any = null;
    ctx.compact = (o?: any) => {
      compacted = o;
    };
    const h = buildInteractionHandler(pi, ctx, ch, "tok-i");

    await h(d("model", { options: [{ name: "name", value: "qwen3.8-27b" }] }));
    expect(set?.id).toBe("qwen3.8-27b");
    const modelEdit = calls.at(-1);
    expect(JSON.parse(modelEdit!.body).content).toContain(
      "hydrogen/qwen3.8-27b",
    );

    await h(
      d("compact", {
        options: [{ name: "instructions", value: "focus on X" }],
      }),
    );
    expect(compacted?.customInstructions).toBe("focus on X");
    expect(typeof compacted?.onComplete).toBe("function");
    expect(typeof compacted?.onError).toBe("function");
  });

  test("/model with no arg lists available models", async () => {
    ctx.modelRegistry = {
      getAvailable: () => [
        { id: "m1", name: "M1", provider: "p" },
        { id: "m2", name: "M2", provider: "p" },
      ],
    };
    const h = buildInteractionHandler(pi, ctx, ch, "tok-i");
    await h(d("model"));
    const edit = calls.find((c) => c.url.endsWith("/messages/@original"));
    const content = JSON.parse(edit!.body).content;
    expect(content).toContain("p/m1");
    expect(content).toContain("p/m2");
  });
});

describe("compact: defer mid-run + always report", () => {
  let tmp = "";
  let pi: any;
  let ctx: any;
  let handlers: Record<string, (...a: any[]) => any> = {};
  let fetchCalls: { url: string; method: string; body?: any }[] = [];
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

  // contents of the extension's posts to the Discord channel
  const channelPosts = () =>
    fetchCalls
      .filter(
        (c) => c.url.includes("/channels/ch1/messages") && c.method === "POST",
      )
      .map(
        (c) =>
          (typeof c.body === "string" ? JSON.parse(c.body) : c.body).content,
      );

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
            ack: true,
          },
        ],
      }),
    );
    handlers = {};
    fetchCalls = [];
    pi = {
      registerMessageRenderer: () => {},
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

  afterEach(() => {
    jest.useRealTimers();
    stopAllCompactTicks();
    clearAllCompacting();
    for (const id of [...midTurnQueues.keys()]) clearQueuedInbound(id);
    queuedAcks.clear();
    pendingInterrupts.clear();
    handlers.agent_end?.({ messages: [] }, ctx); // clears typing timer; flushes any pending compact
    stopAllCompactTicks();
    clearAllCompacting();
    globalThis.fetch = realFetch;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test("idle /compact runs immediately and reports the token delta on completion", async () => {
    let opts: any = null;
    ctx.compact = (o?: any) => {
      opts = o;
    };
    await handleInbound(pi, inbound("/compact keep the jarate", "m1"), ctx);
    expect(opts?.customInstructions).toBe("keep the jarate");
    await tick();
    expect(channelPosts().some((t) => t === "[..] compacting...")).toBe(true);
    opts.onComplete({
      summary: "s",
      firstKeptEntryId: "e",
      tokensBefore: 219997,
      estimatedTokensAfter: 35000,
    });
    await tick();
    // The report REPLACES the ticking placeholder in place (PATCH), not a
    // fresh post — no double message when the compact lands.
    const reportText = "[ok] compacted: 219997 -> 35000 tokens";
    const edits = fetchCalls.filter(
      (c) => c.method === "PATCH" && c.url.includes("/messages/"),
    );
    expect(
      edits.some(
        (c) =>
          (typeof c.body === "string" ? JSON.parse(c.body) : c.body).content ===
          reportText,
      ),
    ).toBe(true);
    expect(channelPosts().some((t) => t === reportText)).toBe(false);
  });

  test("idle /compact placeholder ticks in place every 5s while compaction runs", async () => {
    jest.useFakeTimers();
    let opts: any = null;
    ctx.compact = (o?: any) => {
      opts = o;
    };
    const edits = () =>
      fetchCalls
        .filter((c) => c.method === "PATCH" && c.url.includes("/messages/"))
        .map(
          (c) =>
            (typeof c.body === "string" ? JSON.parse(c.body) : c.body).content,
        );
    await handleInbound(pi, inbound("/compact", "m1"), ctx);
    // settle the fire-and-forget placeholder post (microtasks, no timers)
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(channelPosts().some((t) => t === "[..] compacting...")).toBe(true);

    // No edit before the first 5s tick
    jest.advanceTimersByTime(4999);
    expect(edits().length).toBe(0);
    jest.advanceTimersByTime(1);
    expect(edits()).toEqual(["[..] compacting… 5s"]);
    // subsequent ticks keep updating the SAME message in place
    jest.advanceTimersByTime(5000);
    expect(edits()).toEqual(["[..] compacting… 5s", "[..] compacting… 10s"]);
    jest.advanceTimersByTime(5000);
    expect(edits()).toEqual([
      "[..] compacting… 5s",
      "[..] compacting… 10s",
      "[..] compacting… 15s",
    ]);

    // Settle: the report replaces the placeholder in place, tick stops
    opts.onComplete({ tokensBefore: 100, estimatedTokensAfter: 10 });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(edits().at(-1)).toBe("[ok] compacted: 100 -> 10 tokens");
    jest.advanceTimersByTime(60000);
    expect(edits().length).toBe(4); // no further ticks after settle
    expect(channelPosts().some((t) => t.startsWith("[ok]"))).toBe(false);
  });

  test("idle /compact onError replaces the ticking placeholder in place", async () => {
    let opts: any = null;
    ctx.compact = (o?: any) => {
      opts = o;
    };
    await handleInbound(pi, inbound("/compact", "m1"), ctx);
    await tick();
    expect(channelPosts().some((t) => t === "[..] compacting...")).toBe(true);
    opts.onError(new Error("model down"));
    await tick();
    const failText = "[!] compact failed: model down";
    const edits = fetchCalls.filter(
      (c) => c.method === "PATCH" && c.url.includes("/messages/"),
    );
    expect(
      edits.some(
        (c) =>
          (typeof c.body === "string" ? JSON.parse(c.body) : c.body).content ===
          failText,
      ),
    ).toBe(true);
    expect(channelPosts().some((t) => t === failText)).toBe(false);
  });

  test("idle /compact with no instructions compacts without customInstructions", async () => {
    let opts: any = null;
    ctx.compact = (o?: any) => {
      opts = o;
    };
    await handleInbound(pi, inbound("/compact", "m1"), ctx);
    expect(opts).not.toBeNull();
    expect(opts.customInstructions).toBeUndefined();
  });

  test("idle /compact reports onError (the swallowed-error path)", async () => {
    let opts: any = null;
    ctx.compact = (o?: any) => {
      opts = o;
    };
    await handleInbound(pi, inbound("/compact", "m1"), ctx);
    opts.onError(new Error("Nothing to compact (session too small)"));
    await tick();
    expect(
      channelPosts().some(
        (t) =>
          t === "[!] compact failed: Nothing to compact (session too small)",
      ),
    ).toBe(true);
  });

  test("sync throw from ctx.compact is reported, not swallowed", async () => {
    ctx.compact = () => {
      throw new Error("boom-ctx");
    };
    await handleInbound(pi, inbound("/compact", "m1"), ctx);
    await tick();
    expect(
      channelPosts().some((t) => t === "[!] compact failed: boom-ctx"),
    ).toBe(true);
    expect(channelPosts().some((t) => t === "[..] compacting...")).toBe(false);
  });

  test("mid-run /compact defers; agent_end flushes it with the stored instructions", async () => {
    let opts: any = null;
    ctx.compact = (o?: any) => {
      opts = o;
    };
    ctx.isIdle = () => false;
    // establish the active channel, then start a run
    await handleInbound(pi, inbound("hello", "m0"), ctx);
    await handlers.turn_start(null, ctx);
    // /compact mid-run
    await handleInbound(pi, inbound("/compact keep the jarate", "m1"), ctx);
    expect(opts).toBeNull(); // not started yet — the run would be aborted
    expect(
      channelPosts().some((t) =>
        t.startsWith("[queued] compact (run in progress)"),
      ),
    ).toBe(true);
    // run ends → flush (flushed compact posts its own ticking placeholder)
    await handlers.agent_end({ messages: [] }, ctx);
    expect(opts?.customInstructions).toBe("keep the jarate");
    await tick();
    expect(channelPosts().some((t) => t === "[..] compacting...")).toBe(true);
  });

  test("mid-run: a later /compact replaces the earlier pending one", async () => {
    let opts: any = null;
    ctx.compact = (o?: any) => {
      opts = o;
    };
    ctx.isIdle = () => false;
    await handleInbound(pi, inbound("hello", "m0"), ctx);
    await handlers.turn_start(null, ctx);
    await handleInbound(pi, inbound("/compact first", "m1"), ctx);
    await handleInbound(pi, inbound("/compact second", "m2"), ctx);
    expect(
      channelPosts().some((t) =>
        t.startsWith("[queued] compact (run in progress), replaces earlier"),
      ),
    ).toBe(true);
    await handlers.agent_end({ messages: [] }, ctx);
    expect(opts?.customInstructions).toBe("second");
  });

  test("/compact while a compaction is in flight defers; session_compact flushes it", async () => {
    let opts: any = null;
    ctx.compact = (o?: any) => {
      opts = o;
    };
    ctx.isIdle = () => false; // isCompacting; agentBusy stays false
    await handleInbound(pi, inbound("/compact second", "m2"), ctx);
    expect(opts).toBeNull();
    expect(
      channelPosts().some((t) =>
        t.startsWith("[queued] compact (compact already in progress)"),
      ),
    ).toBe(true);
    handlers.session_compact?.(
      {
        compactionEntry: {},
        fromExtension: true,
        reason: "manual",
        willRetry: false,
      },
      ctx,
    );
    await tick();
    expect(opts?.customInstructions).toBe("second");
  });

  test("/compact while a compaction is in flight defers; session_compact_failed also flushes", async () => {
    let opts: any = null;
    ctx.compact = (o?: any) => {
      opts = o;
    };
    ctx.isIdle = () => false;
    await handleInbound(pi, inbound("/compact second", "m2"), ctx);
    expect(opts).toBeNull();
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
    await tick();
    expect(opts?.customInstructions).toBe("second");
  });
});

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

  afterEach(() => {
    jest.useRealTimers();
    clearAllCompacting();
    for (const id of [...midTurnQueues.keys()]) clearQueuedInbound(id);
    queuedAcks.clear();
    pendingInterrupts.clear();
    handlers.agent_end?.({ messages: [] }, ctx); // flush any pending compact
    clearAllCompacting();
    globalThis.fetch = realFetch;
    fs.rmSync(tmp, { recursive: true, force: true });
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
    await tick();
    expect(piSends().some((s) => s.m.details?.body === "late msg")).toBe(true);
    expect(isCompacting("ch1")).toBe(false);
  });

  test("plain message while compacting: queued with ack, interrupt NOT armed", async () => {
    ctx.compact = () => {};
    await handleInbound(pi, inbound("/compact", "m1"), ctx);
    ctx.isIdle = () => false; // compaction now in flight
    expect(isCompacting("ch1")).toBe(true);

    await handleInbound(pi, inbound("hello while compacting", "m2"), ctx);
    await tick();
    expect(midTurnQueues.get("ch1")?.length).toBe(1);
    expect(pendingInterrupts.has("ch1")).toBe(false); // no interrupt armed
    expect(channelPosts().some((t) => t === "[queued] 1 in line")).toBe(true);
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
    const st = channelPosts().find((t) => t.startsWith("[status]"));
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
    expect(channelPosts().some((t) => t === "[-] stopped")).toBe(true);
  });

  test("/stop while compacting is owner-only: non-owner gets an immediate reply, nothing queued, window stays", async () => {
    ctx.compact = () => {};
    await handleInbound(pi, inbound("/compact", "m1"), ctx);
    ctx.isIdle = () => false;
    await handleInbound(pi, inbound("/stop", "m2", "ch1", "other"), ctx);
    await tick();
    expect(isCompacting("ch1")).toBe(true); // window untouched
    expect(channelPosts().some((t) => t === "[!] owner only")).toBe(true);
    // Not queued: a queued /stop would re-run ungated after the window
    // closes and drop the channel's re-wake queue + abort the next run.
    expect(midTurnQueues.has("ch1")).toBe(false);
    expect(piSends().length).toBe(0);
    expect(pendingInterrupts.has("ch1")).toBe(false);
  });

  test("/compact while compacting: '[!] already compacting', single dispatch", async () => {
    let compacts = 0;
    ctx.compact = () => {
      compacts++;
    };
    await handleInbound(pi, inbound("/compact", "m1"), ctx);
    ctx.isIdle = () => false;
    await handleInbound(pi, inbound("/compact again", "m2"), ctx);
    await tick();
    expect(compacts).toBe(1);
    expect(channelPosts().some((t) => t === "[!] already compacting")).toBe(
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
    expect(channelPosts().some((t) => t === "[!] already compacting")).toBe(
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
        t.startsWith("[queued] compact (compact already in progress)"),
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

// ─── Todo board: /todos command, context injection, tool, worker intake ──
// Same harness shape as the "extension handlers" block, plus a HOME
// override so ~/.pi/agent/todos stays out of the real home.

describe("todo board (integration)", () => {
  let tmp = "";
  let realHome = "";
  let pi: any;
  let ctx: any;
  let handlers: Record<string, (...a: any[]) => any> = {};
  let sent: { m: any; o?: any }[] = [];
  let tools: Record<string, any> = {};
  let fetchCalls: { url: string; method: string; body?: any }[] = [];
  let fetchImpl: ((url: any, init?: any) => Promise<any>) | null = null;
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

  const ok = { id: "out1" };
  const replyContent = (): string => {
    const posts = fetchCalls.filter(
      (c) => c.method === "POST" && c.url.endsWith("/channels/ch1/messages"),
    );
    return JSON.parse(posts.at(-1)!.body).content;
  };

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "piscord-todo-"));
    realHome = process.env.HOME!;
    process.env.HOME = tmp; // isolate ~/.pi/agent/todos from the real home
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
          },
        ],
      }),
    );
    handlers = {};
    sent = [];
    tools = {};
    fetchCalls = [];
    fetchImpl = null;
    pi = {
      registerMessageRenderer: () => {},
      registerTool: (t: any) => {
        tools[t.name] = t;
      },
      on: (n: string, fn: any) => {
        handlers[n] = fn;
      },
      sendMessage: (m: any, o?: any) => {
        sent.push({ m, o });
      },
    };
    extension(pi);
    // The factory registers LLM tools in session_start, which this
    // harness does not run — register the todo tool directly.
    registerTodoTool(pi, loadChannelConfig(tmp));
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
      if (fetchImpl) return fetchImpl(url, init);
      return {
        ok: true,
        status: 200,
        json: async () => ok,
        text: async () => "",
      };
    }) as any;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    process.env.HOME = realHome;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test("/todos prints the channel board", async () => {
    saveBoard(
      {
        channelId: "ch1",
        todos: [
          { content: "fix bug", status: "in_progress" },
          { content: "tests", status: "pending" },
        ],
        updatedAt: "t",
      },
      tmp,
    );
    await handleInbound(pi, inbound("/todos", "m1"), ctx);
    const content = replyContent();
    expect(content).toBe(
      renderBoard([
        { content: "fix bug", status: "in_progress" },
        { content: "tests", status: "pending" },
      ]),
    );
    expect(content).toContain("┌ todos · 2 open");
  });

  test("/todos with an empty board says 'no open todos'", async () => {
    await handleInbound(pi, inbound("/todos", "m1"), ctx);
    expect(replyContent()).toBe("[todos] no open todos");
  });

  test("/todos needs no owner", async () => {
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
    saveBoard(
      {
        channelId: "ch1",
        todos: [{ content: "x", status: "pending" }],
        updatedAt: "t",
      },
      tmp,
    );
    await handleInbound(pi, inbound("/todos", "m1"), ctx); // fromId "uid" ≠ owner1
    expect(replyContent()).toContain("├ x");
  });

  test("/todos all prints every channel's board", async () => {
    saveBoard(
      {
        channelId: "ch1",
        todos: [{ content: "a", status: "pending" }],
        updatedAt: "t",
      },
      tmp,
    );
    saveBoard(
      {
        channelId: "ch2",
        todos: [{ content: "b", status: "completed" }],
        updatedAt: "t",
      },
      tmp,
    );
    await handleInbound(pi, inbound("/todos all", "m1"), ctx);
    const content = replyContent();
    expect(content).toContain("┌ Test · 1 open");
    expect(content).toContain("├ a");
    expect(content).toContain("┌ ch2 · 0 open");
    expect(content).toContain("┘ ~~b~~");
    // each board block is framed: opens with ┌, closes with └
    expect(content.split("\n\n").length).toBe(2);
    for (const block of content.split("\n\n")) {
      expect(block.startsWith("┌ ")).toBe(true);
      expect(block.trimEnd().endsWith("└")).toBe(true);
    }
  });

  test("/todos all with no boards says 'no open todos'", async () => {
    await handleInbound(pi, inbound("/todos all", "m1"), ctx);
    expect(replyContent()).toBe("[todos] no open todos");
  });

  test("context injection: non-empty board appended after channel-ctx", async () => {
    saveBoard(
      {
        channelId: "ch1",
        todos: [{ content: "fix bug", status: "in_progress" }],
        updatedAt: "t",
      },
      tmp,
    );
    await handleInbound(pi, inbound("hello", "m1"), ctx);
    const content = sent.at(-1)!.m.content;
    expect(content).toContain("</channel-ctx>");
    expect(content).toContain("<todo-board>\n┣ **fix bug**\n</todo-board>");
    expect(content.indexOf("</channel-ctx>")).toBeLessThan(
      content.indexOf("<todo-board>"),
    );
  });

  test("context injection: no board block when the board is empty", async () => {
    await handleInbound(pi, inbound("hello", "m1"), ctx);
    expect(sent.at(-1)!.m.content).not.toContain("<todo-board>");
  });

  test("todo tool: posts the board, edits in place, deletes on clear", async () => {
    const t = tools.todo;
    expect(t).toBeDefined();
    expect(t.description).toBe(TODO_TOOL_DESCRIPTION);

    // 1) first call: posts one board message, stores the id in state
    const r1 = await t.execute(
      "1",
      {
        todos: [
          { content: "a", status: "in_progress" },
          { content: "b", status: "pending" },
        ],
      },
      undefined,
      undefined,
      ctx,
    );
    expect(r1.content[0].text).toBe(
      renderBoard([
        { content: "a", status: "in_progress" },
        { content: "b", status: "pending" },
      ]),
    );
    let board = loadBoard("ch1", tmp);
    expect(board?.boardMessageId).toBe("out1");
    let posts = fetchCalls.filter(
      (c) => c.method === "POST" && c.url.endsWith("/channels/ch1/messages"),
    );
    expect(posts.length).toBe(1);
    expect(JSON.parse(posts[0].body).content).toContain("┌ todos · 2 open");

    // 2) second call: edits the SAME message, no new post
    const r2 = await t.execute(
      "2",
      {
        todos: [
          { content: "a", status: "completed" },
          { content: "b", status: "pending" },
        ],
      },
      undefined,
      undefined,
      ctx,
    );
    expect(r2.content[0].text).toContain("┘ ~~a~~");
    posts = fetchCalls.filter(
      (c) => c.method === "POST" && c.url.endsWith("/channels/ch1/messages"),
    );
    expect(posts.length).toBe(1);
    const patch = fetchCalls.find(
      (c) =>
        c.method === "PATCH" && c.url.endsWith("/channels/ch1/messages/out1"),
    );
    expect(patch).toBeDefined();
    expect(JSON.parse(patch!.body).content).toContain("┘ ~~a~~");
    expect(JSON.parse(patch!.body).content).toContain("┌ todos · 1 open");

    // 3) empty list: deletes the board message, clears the state
    const r3 = await t.execute("3", { todos: [] }, undefined, undefined, ctx);
    expect(r3.content[0].text).toBe("todo board cleared");
    const del = fetchCalls.find(
      (c) =>
        c.method === "DELETE" && c.url.endsWith("/channels/ch1/messages/out1"),
    );
    expect(del).toBeDefined();
    board = loadBoard("ch1", tmp);
    expect(board?.todos).toEqual([]);
    expect(board?.boardMessageId).toBeUndefined();
  });

  test("todo tool: a failed board edit does not fail the call", async () => {
    saveBoard(
      {
        channelId: "ch1",
        todos: [{ content: "a", status: "pending" }],
        updatedAt: "t",
        boardMessageId: "gone1",
      },
      tmp,
    );
    fetchImpl = (_url: any, init?: any) => {
      if (init?.method === "PATCH") {
        return Promise.resolve({
          ok: false,
          status: 404,
          json: async () => ({}),
          text: async () => "Not Found",
        });
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ok,
        text: async () => "",
      });
    };
    const t = tools.todo;
    const r = await t.execute(
      "1",
      { todos: [{ content: "a", status: "completed" }] },
      undefined,
      undefined,
      ctx,
    );
    expect(r.content[0].text).toContain("┘ ~~a~~");
    // state still updated; id kept so the next sync retries the edit
    const board = loadBoard("ch1", tmp);
    expect(board?.todos[0].status).toBe("completed");
    expect(board?.boardMessageId).toBe("gone1");
  });

  test("todo tool: no channel available", async () => {
    await handlers.session_shutdown(); // clears lastActiveChannel
    const barePi: any = {
      registerTool: (t: any) => {
        tools.todo = t;
      },
    };
    registerTodoTool(barePi, []);
    const r = await tools.todo.execute(
      "1",
      { todos: [{ content: "a", status: "pending" }] },
      undefined,
      undefined,
      ctx,
    );
    expect(r.content[0].text).toBe("No Discord channel available");
  });

  test("worker intake: bg callback TODO lines merge into the board and re-render it", async () => {
    saveBoard(
      {
        channelId: "ch1",
        todos: [{ content: "alpha", status: "in_progress" }],
        updatedAt: "t",
        boardMessageId: "board1",
      },
      tmp,
    );
    const body =
      "[bg: worker OK · r1]\n\n<embed>\nAuthor: pi-bg ticket · r1\nTitle: worker\nresult: done\nTODO: follow up on X\nTODO: verify the deploy\n</embed>";
    await handleInbound(pi, inbound(body, "m1"), ctx);

    let board = loadBoard("ch1", tmp);
    expect(board?.todos).toEqual([
      { content: "alpha", status: "in_progress" },
      { content: "follow up on X", status: "pending" },
      { content: "verify the deploy", status: "pending" },
    ]);
    // board message edited in place with the new items
    const patch = fetchCalls.find(
      (c) =>
        c.method === "PATCH" && c.url.endsWith("/channels/ch1/messages/board1"),
    );
    expect(patch).toBeDefined();
    expect(JSON.parse(patch!.body).content).toContain("├ follow up on X");
    expect(JSON.parse(patch!.body).content).toContain("┣ **alpha**");
    // the callback still woke the agent (run forwarded to pi)
    expect(sent.length).toBeGreaterThan(0);

    // repeat callback: exact-content dedupe, no growth
    await handleInbound(pi, inbound(body, "m2"), ctx);
    board = loadBoard("ch1", tmp);
    expect(board?.todos.length).toBe(3);
  });

  test("worker intake: plain messages with TODO: lines are not merged", async () => {
    await handleInbound(
      pi,
      inbound("TODO: something I typed by hand", "m1"),
      ctx,
    );
    const board = loadBoard("ch1", tmp);
    expect(board).toBeNull();
  });
});

describe("sleep (integration)", () => {
  let tmp = "";
  let realHome = "";
  let pi: any;
  let ctx: any;
  let sent: { m: any; o?: any }[] = [];
  let tools: Record<string, any> = {};
  let fetchCalls: { url: string; method: string; body?: any }[] = [];
  const realFetch = globalThis.fetch;

  const NOW = Date.parse("2026-09-10T12:00:00Z");

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

  const replyContent = (): string => {
    const posts = fetchCalls.filter(
      (c) => c.method === "POST" && c.url.endsWith("/channels/ch1/messages"),
    );
    return JSON.parse(posts.at(-1)!.body).content;
  };

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "piscord-sleep-"));
    realHome = process.env.HOME!;
    process.env.HOME = tmp; // isolate ~/.pi/agent/sleep from the real home
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
          },
        ],
      }),
    );
    sent = [];
    tools = {};
    fetchCalls = [];
    pi = {
      registerMessageRenderer: () => {},
      registerTool: (t: any) => {
        tools[t.name] = t;
      },
      on: () => {},
      sendMessage: (m: any, o?: any) => {
        sent.push({ m, o });
      },
    };
    registerSleepTool(pi, loadChannelConfig(tmp));
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
      return {
        ok: true,
        status: 200,
        json: async () => ({ id: "out1" }),
        text: async () => "",
      };
    }) as any;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    process.env.HOME = realHome;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test("/sleep with no wakes says 'no pending wakes'", async () => {
    await handleInbound(pi, inbound("/sleep", "m1"), ctx);
    expect(replyContent()).toBe("[wake] no pending wakes");
  });

  test("/sleep list shows pending wakes with id, channel, time, note", async () => {
    const w = scheduleWake({
      channelId: "ch1",
      channelName: "Test",
      wakeAt: Date.now() + 30 * 60000,
      note: "check CI",
      home: tmp,
    });
    await handleInbound(pi, inbound("/sleep list", "m1"), ctx);
    const content = replyContent();
    expect(content).toContain("1 pending wake (of 1 total):");
    expect(content).toContain(w.id);
    expect(content).toContain("Test");
    expect(content).toContain(new Date(w.wakeAt).toISOString());
    expect(content).toContain("in 30m");
    expect(content).toContain("note: check CI");
  });

  test("/sleep cancel removes the wake from disk", async () => {
    const w = scheduleWake({
      channelId: "ch1",
      wakeAt: Date.now() + 30 * 60000,
      home: tmp,
    });
    await handleInbound(pi, inbound(`/sleep cancel ${w.id}`, "m1"), ctx);
    expect(replyContent()).toBe(`[ok] cancelled wake ${w.id}`);
    expect(loadWakes(tmp)).toHaveLength(0);
  });

  test("/sleep cancel: unknown id, missing id, bogus subcommand", async () => {
    await handleInbound(pi, inbound("/sleep cancel nope", "m1"), ctx);
    expect(replyContent()).toBe("[!] no wake with id nope");
    await handleInbound(pi, inbound("/sleep cancel", "m2"), ctx);
    expect(replyContent()).toBe("[!] usage: `/sleep cancel <id>`");
    await handleInbound(pi, inbound("/sleep xyz", "m3"), ctx);
    expect(replyContent()).toBe("[!] usage: `/sleep [list | cancel <id>]`");
  });

  test("due-on-startup delivery: injects a channel-inbound wake, completes it, no double delivery", () => {
    const w = scheduleWake({
      channelId: "ch1",
      channelName: "Test",
      wakeAt: NOW - 1000,
      note: "check the deploy",
      home: tmp,
      now: NOW - 2000,
    });
    const channels = loadChannelConfig(tmp);
    expect(deliverDueWakes(pi, channels, tmp, NOW)).toBe(1);
    const s = sent.at(-1)!;
    expect(s.o?.triggerTurn).toBe(true);
    expect(s.m.customType).toBe("channel-inbound");
    expect(s.m.content).toContain("Woke after sleeping until");
    expect(s.m.content).toContain("Note: check the deploy");
    expect(s.m.details.title).toBe("discord/Test");
    // completed on disk (removed) — a healthy process never re-delivers it
    expect(loadWakes(tmp).find((x) => x.id === w.id)).toBeUndefined();
    // immediate re-check: no double delivery
    expect(deliverDueWakes(pi, channels, tmp, NOW)).toBe(0);
    expect(sent).toHaveLength(1);
  });

  test("stale claim after PROCESS DEATH re-delivers once after CLAIM_TTL_MS", () => {
    const w = scheduleWake({
      channelId: "ch1",
      wakeAt: NOW - 1000,
      home: tmp,
      now: NOW - 2000,
    });
    // claim, then the process dies before completion (crash guard state)
    markClaimed(w.id, NOW, tmp);
    expect(loadWakes(tmp)[0]).toMatchObject({
      id: w.id,
      status: "claimed",
      claimedAt: NOW,
    });
    // a new session starts long after the claim (bridge was down through the TTL window)
    const channels = loadChannelConfig(tmp);
    expect(deliverDueWakes(pi, channels, tmp, NOW + CLAIM_TTL_MS + 1)).toBe(1);
    expect(sent).toHaveLength(1);
    // that redelivery is also completed — the loop must end
    expect(loadWakes(tmp)).toHaveLength(0);
    expect(deliverDueWakes(pi, channels, tmp, NOW + 2 * CLAIM_TTL_MS + 2)).toBe(
      0,
    );
    expect(sent).toHaveLength(1);
  });

  test("same-process late tick: a delivered wake is NOT re-delivered after the TTL (F1)", () => {
    scheduleWake({
      channelId: "ch1",
      wakeAt: NOW - 1000,
      home: tmp,
      now: NOW - 2000,
    });
    const channels = loadChannelConfig(tmp);
    expect(deliverDueWakes(pi, channels, tmp, NOW)).toBe(1);
    // 10 minutes later, same live process: the wake was completed, not claimed-stale
    expect(deliverDueWakes(pi, channels, tmp, NOW + CLAIM_TTL_MS + 1)).toBe(0);
    expect(sent).toHaveLength(1);
  });

  test("deliverDueWakes skips disabled channels (no claim, no injection)", () => {
    scheduleWake({
      channelId: "ch1",
      wakeAt: NOW - 1000,
      home: tmp,
      now: NOW - 2000,
    });
    const channels = loadChannelConfig(tmp).map((c) => ({
      ...c,
      enabled: false,
    }));
    expect(deliverDueWakes(pi, channels, tmp, NOW)).toBe(0);
    expect(sent).toHaveLength(0);
    expect(loadWakes(tmp)[0].status).toBe("pending");
  });

  test("/sleep list header counts only pending (claimed stays visible, not counted)", async () => {
    const p = scheduleWake({
      channelId: "ch1",
      channelName: "Test",
      wakeAt: Date.now() + 30 * 60000,
      note: "pending one",
      home: tmp,
    });
    const c = scheduleWake({
      channelId: "ch1",
      channelName: "Test",
      wakeAt: Date.now() + 60 * 60000,
      note: "claimed one",
      home: tmp,
    });
    markClaimed(c.id, Date.now(), tmp);
    await handleInbound(pi, inbound("/sleep list", "m1"), ctx);
    const content = replyContent();
    expect(content).toContain("1 pending wake (of 2 total):");
    expect(content).toContain(p.id);
    expect(content).toContain(c.id);
  });

  test("inbound user message cancels PENDING wakes (kimaki parity); claimed ones survive", async () => {
    const p = scheduleWake({
      channelId: "ch1",
      wakeAt: Date.now() + 30 * 60000,
      home: tmp,
    });
    const c = scheduleWake({
      channelId: "ch1",
      wakeAt: Date.now() + 60 * 60000,
      home: tmp,
    });
    markClaimed(c.id, Date.now(), tmp);
    await handleInbound(pi, inbound("hey, are you awake?", "m1"), ctx);
    const ids = loadWakes(tmp).map((w) => w.id);
    expect(ids).not.toContain(p.id);
    expect(ids).toContain(c.id); // claimed = mid-delivery, not cancelled
  });

  test("/btw and commands do NOT cancel pending wakes", async () => {
    const a = scheduleWake({
      channelId: "ch1",
      wakeAt: Date.now() + 30 * 60000,
      home: tmp,
    });
    await handleInbound(pi, inbound("/btw what is 2+2", "m1"), ctx);
    expect(loadWakes(tmp).map((w) => w.id)).toContain(a.id);
    const b = scheduleWake({
      channelId: "ch1",
      wakeAt: Date.now() + 30 * 60000,
      home: tmp,
    });
    await handleInbound(pi, inbound("/help", "m2"), ctx);
    expect(loadWakes(tmp).map((w) => w.id)).toContain(b.id);
  });

  test("inbound message on channel A does not cancel wakes on channel B", async () => {
    const w = scheduleWake({
      channelId: "other-ch",
      wakeAt: Date.now() + 30 * 60000,
      home: tmp,
    });
    await handleInbound(pi, inbound("hello", "m1"), ctx);
    expect(loadWakes(tmp).map((x) => x.id)).toEqual([w.id]);
  });

  test("sleep tool: minutes -> wake on disk + ack telling the model to end the reply", async () => {
    const r = await tools.sleep.execute(
      "1",
      { minutes: 30, note: "verify the build" },
      undefined,
      undefined,
      ctx,
    );
    expect(r.content[0].text).toContain("[ok] sleeping until");
    expect(r.content[0].text).toContain("End your reply now");
    const wakes = loadWakes(tmp);
    expect(wakes).toHaveLength(1);
    expect(wakes[0].channelId).toBe("ch1");
    expect(wakes[0].note).toBe("verify the build");
    expect(wakes[0].wakeAt).toBeGreaterThanOrEqual(Date.now() + 29 * 60000);
  });

  test("sleep tool: until ISO -> wake at that time", async () => {
    // Relative future date — a hardcoded ISO became a date bomb on
    // 2026-09-11 (past `until` is rejected, so the wake list stayed empty).
    const until = new Date(Date.now() + 30 * 60000).toISOString();
    await tools.sleep.execute("1", { until }, undefined, undefined, ctx);
    expect(loadWakes(tmp)[0].wakeAt).toBe(Date.parse(until));
  });

  test("sleep tool: bad params -> error, nothing scheduled", async () => {
    for (const params of [
      {},
      { minutes: 5, until: "2026-09-10T15:00:00Z" },
      { until: "yesterday" },
      { minutes: -1 },
      { until: "2036-01-01T00:00:00Z" },
    ]) {
      const r = await tools.sleep.execute(
        "1",
        params,
        undefined,
        undefined,
        ctx,
      );
      expect(r.content[0].text).toContain("[!]");
    }
    expect(loadWakes(tmp)).toHaveLength(0);
  });
});

describe("tasks (integration)", () => {
  let tmp = "";
  let realHome = "";
  let pi: any;
  let ctx: any;
  let sent: { m: any; o?: any }[] = [];
  let tools: Record<string, any> = {};
  let fetchCalls: { url: string; method: string; body?: any }[] = [];
  const realFetch = globalThis.fetch;

  const NOW = Date.parse("2026-09-10T12:00:00Z");

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

  const replyContent = (): string => {
    const posts = fetchCalls.filter(
      (c) => c.method === "POST" && c.url.endsWith("/channels/ch1/messages"),
    );
    return JSON.parse(posts.at(-1)!.body).content;
  };

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "piscord-tasks-"));
    realHome = process.env.HOME!;
    process.env.HOME = tmp; // isolate ~/.pi/agent/tasks from the real home
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
          },
        ],
      }),
    );
    sent = [];
    tools = {};
    fetchCalls = [];
    pi = {
      registerMessageRenderer: () => {},
      registerTool: (t: any) => {
        tools[t.name] = t;
      },
      on: () => {},
      sendMessage: (m: any, o?: any) => {
        sent.push({ m, o });
      },
    };
    registerTaskTool(pi, loadChannelConfig(tmp));
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
      return {
        ok: true,
        status: 200,
        json: async () => ({ id: "out1" }),
        text: async () => "",
      };
    }) as any;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    process.env.HOME = realHome;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test("/tasks with no tasks says 'no scheduled tasks'", async () => {
    await handleInbound(pi, inbound("/tasks", "m1"), ctx);
    expect(replyContent()).toBe("[tasks] no scheduled tasks");
  });

  test("/tasks list shows tasks with id, channel, schedule, next fire, prompt", async () => {
    const one = scheduleTask({
      channelId: "ch1",
      channelName: "Test",
      prompt: "check the build",
      spec: {
        kind: "at",
        atMs: Date.now() + 2 * 3600000,
        nextFireAt: Date.now() + 2 * 3600000,
      },
      home: tmp,
    });
    const rec = scheduleTask({
      channelId: "ch1",
      prompt: "run the fleet check",
      spec: {
        kind: "cron",
        cron: "0 6 * * *",
        tz: "UTC",
        nextFireAt: Date.parse("2026-09-11T06:00:00Z"),
      },
      home: tmp,
      now: NOW + 1,
    });
    await handleInbound(pi, inbound("/tasks list", "m1"), ctx);
    const content = replyContent();
    expect(content).toContain("2 pending tasks (of 2 total):");
    expect(content).toContain(one.id);
    expect(content).toContain("check the build");
    expect(content).toContain("in 2h");
    expect(content).toContain(rec.id);
    expect(content).toContain('cron "0 6 * * *" (UTC)');
    expect(content).toContain("2026-09-11T06:00:00.000Z");
  });

  test("/tasks cancel removes the task from disk", async () => {
    const t = scheduleTask({
      channelId: "ch1",
      prompt: "check the build",
      spec: {
        kind: "at",
        atMs: Date.now() + 30 * 60000,
        nextFireAt: Date.now() + 30 * 60000,
      },
      home: tmp,
    });
    await handleInbound(pi, inbound(`/tasks cancel ${t.id}`, "m1"), ctx);
    expect(replyContent()).toBe(`[ok] cancelled task ${t.id}`);
    expect(loadTasks(tmp)).toHaveLength(0);
  });

  test("/tasks cancel: unknown id, missing id, bogus subcommand", async () => {
    await handleInbound(pi, inbound("/tasks cancel nope", "m1"), ctx);
    expect(replyContent()).toBe("[!] no task with id nope");
    await handleInbound(pi, inbound("/tasks cancel", "m2"), ctx);
    expect(replyContent()).toBe("[!] usage: `/tasks cancel <id>`");
    await handleInbound(pi, inbound("/tasks xyz", "m3"), ctx);
    expect(replyContent()).toBe("[!] usage: `/tasks [list | cancel <id>]`");
  });

  test("due-on-startup delivery: injects a channel-inbound task, completes it, no double delivery", () => {
    scheduleTask({
      channelId: "ch1",
      channelName: "Test",
      prompt: "check the deploy",
      spec: {
        kind: "at",
        atMs: NOW - 1000,
        nextFireAt: NOW - 1000,
      },
      home: tmp,
      now: NOW - 2000,
    });
    const channels = loadChannelConfig(tmp);
    expect(deliverDueTasks(pi, channels, tmp, NOW)).toBe(1);
    const s = sent.at(-1)!;
    expect(s.o?.triggerTurn).toBe(true);
    expect(s.m.customType).toBe("channel-inbound");
    expect(s.m.content).toContain("[task] one-shot task due");
    expect(s.m.content).toContain("check the deploy");
    expect(s.m.details.title).toBe("discord/Test");
    // completed on disk (removed) — a healthy process never re-delivers it
    expect(loadTasks(tmp)).toHaveLength(0);
    expect(deliverDueTasks(pi, channels, tmp, NOW)).toBe(0);
    expect(sent).toHaveLength(1);
  });

  test("cron task delivery: survives, advances to the next slot, no immediate re-fire", () => {
    const t = scheduleTask({
      channelId: "ch1",
      channelName: "Test",
      prompt: "run the fleet check",
      spec: {
        kind: "cron",
        cron: "0 6 * * *",
        tz: "UTC",
        nextFireAt: NOW - 1000, // missed slot (bridge was down)
      },
      home: tmp,
      now: NOW - 2 * 86400000,
    });
    const channels = loadChannelConfig(tmp);
    expect(deliverDueTasks(pi, channels, tmp, NOW)).toBe(1);
    const s = sent.at(-1)!;
    expect(s.m.content).toContain(
      '[task] recurring task "0 6 * * *" (UTC) due',
    );
    expect(s.m.content).toContain("run the fleet check");
    // still scheduled — next slot strictly after NOW, not replayed
    const done = loadTasks(tmp).find((x) => x.id === t.id)!;
    expect(done.status).toBe("pending");
    expect(done.lastFiredAt).toBe(NOW - 1000);
    expect(done.nextFireAt).toBe(Date.parse("2026-09-11T06:00:00Z"));
    expect(deliverDueTasks(pi, channels, tmp, NOW)).toBe(0);
    expect(sent).toHaveLength(1);
  });

  test("stale claim after PROCESS DEATH re-delivers once after CLAIM_TTL_MS", () => {
    const t = scheduleTask({
      channelId: "ch1",
      prompt: "check the deploy",
      spec: {
        kind: "at",
        atMs: NOW - 1000,
        nextFireAt: NOW - 1000,
      },
      home: tmp,
      now: NOW - 2000,
    });
    // claim, then the process dies before completion (crash guard state)
    markTaskClaimed(t.id, NOW, tmp);
    expect(loadTasks(tmp)[0]).toMatchObject({
      id: t.id,
      status: "claimed",
      claimedAt: NOW,
    });
    const channels = loadChannelConfig(tmp);
    expect(deliverDueTasks(pi, channels, tmp, NOW + CLAIM_TTL_MS + 1)).toBe(1);
    expect(sent).toHaveLength(1);
    // that redelivery is also completed — the loop must end
    expect(loadTasks(tmp)).toHaveLength(0);
    expect(deliverDueTasks(pi, channels, tmp, NOW + 2 * CLAIM_TTL_MS + 2)).toBe(
      0,
    );
    expect(sent).toHaveLength(1);
  });

  test("deliverDueTasks skips disabled channels (no claim, no injection)", () => {
    scheduleTask({
      channelId: "ch1",
      prompt: "x",
      spec: {
        kind: "at",
        atMs: NOW - 1000,
        nextFireAt: NOW - 1000,
      },
      home: tmp,
      now: NOW - 2000,
    });
    const channels = loadChannelConfig(tmp).map((c) => ({
      ...c,
      enabled: false,
    }));
    expect(deliverDueTasks(pi, channels, tmp, NOW)).toBe(0);
    expect(sent).toHaveLength(0);
    expect(loadTasks(tmp)[0].status).toBe("pending");
  });

  test("task tool: minutes -> one-shot scheduled in the channel", async () => {
    await tools.task.execute(
      "1",
      { prompt: "check the build", minutes: 120 },
      undefined,
      undefined,
      ctx,
    );
    const tasks = loadTasks(tmp);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({
      channelId: "ch1",
      channelName: "Test",
      prompt: "check the build",
      kind: "at",
    });
    expect(tasks[0].atMs).toBeGreaterThanOrEqual(Date.now() + 119 * 60000);
  });

  test("task tool: cron + tz -> recurring with computed first fire", async () => {
    const r = await tools.task.execute(
      "1",
      { prompt: "run the fleet check", cron: "0 6 * * *", tz: "UTC" },
      undefined,
      undefined,
      ctx,
    );
    expect(r.content[0].text).toContain("[ok] task");
    expect(r.content[0].text).toContain('cron "0 6 * * *" (UTC)');
    const t = loadTasks(tmp)[0];
    expect(t.kind).toBe("cron");
    // next 06:00 UTC is strictly in the future, within 24h (real clock)
    expect(t.nextFireAt).toBeGreaterThan(Date.now());
    expect(t.nextFireAt).toBeLessThanOrEqual(
      Date.now() + 24 * 3600000 + 120000,
    );
  });

  test("task tool: bad params -> error, nothing scheduled", async () => {
    for (const params of [
      {},
      { prompt: "x", minutes: 5, cron: "0 6 * * *" },
      { prompt: "x", cron: "99 * * * *" },
      { prompt: "x", at: "yesterday" },
      { prompt: "x", cron: "0 6 * * *", tz: "Not/AZone" },
    ]) {
      const r = await tools.task.execute(
        "1",
        params,
        undefined,
        undefined,
        ctx,
      );
      expect(r.content[0].text).toContain("[!]");
    }
    expect(loadTasks(tmp)).toHaveLength(0);
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
    jest.useRealTimers();
    stopAllOpTicks();
    clearAllCompacting();
    clearAllInterrupts();
    setInterruptCtx(null);
    setSystemdRestartHookForTest(null);
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
    expect(channelPosts().some((t) => t === "[..] resetting...")).toBe(true);
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
    expect(channelPosts().some((t) => t === "[..] restarting...")).toBe(true);
    expect(opWindowLabel("ch1")).toBe("restarting");
    await waitOpShutdown();
    expect(shutdowns).toBe(1);
    expect(fs.existsSync(sess)).toBe(true); // not moved aside
  });

  test("/reset placeholder ticks in place every 5s (shared op tick)", async () => {
    jest.useFakeTimers();
    await handleInbound(pi, inbound("/reset", "m1"), ctx);
    // settle the fire-and-forget placeholder post (microtasks, no timers)
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(channelPosts().some((t) => t === "[..] resetting...")).toBe(true);

    // the bounded op shutdown lands at +300ms (isIdle is immediate here)
    jest.advanceTimersByTime(300);
    // flush the async shutdown chain (race on the placeholder + rewinds)
    for (let i = 0; i < 20; i++) await Promise.resolve();
    expect(shutdowns).toBe(1);

    // window stays open until the respawn clears it -> ticks keep going
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
    await handleInbound(pi, inbound("/reset", "m1"), ctx);
    await tick();
    expect(isCompacting("ch1")).toBe(true);

    await handleInbound(pi, inbound("hello", "m2"), ctx);
    await tick();
    expect(channelPosts().some((t) => t === "[queued] 1 in line")).toBe(true);
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

    // the placeholder is REPLACED in place with the final line, not re-posted
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
      channelPosts().some((t) => t === "[-] stopped (restart cancelled)"),
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

  test("second /reset while an op window is open is rejected; /compact sees the active op; /status shows the op label", async () => {
    await handleInbound(pi, inbound("/reset", "m1"), ctx);
    await tick();
    await handleInbound(pi, inbound("/reset", "m4"), ctx);
    await tick();
    expect(
      channelPosts().filter((t) => t === "[!] already restarting").length,
    ).toBe(1);
    // F5: /compact while resetting names the ACTIVE op, not itself
    await handleInbound(pi, inbound("/compact", "m4b"), ctx);
    await tick();
    expect(
      channelPosts().filter((t) => t === "[!] already restarting").length,
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
    jest.useFakeTimers();
    const got: string[] = [];
    // restart hook that never settles: the unit never respawns
    setSystemdRestartHookForTest((u) => {
      got.push(u);
    });
    const flush = async (n: number) => {
      for (let i = 0; i < n; i++) await Promise.resolve();
    };

    await handleInbound(pi, inbound("/restart", "m1"), ctx);
    await flush(10);
    expect(channelPosts().some((t) => t === "[..] restarting...")).toBe(true);

    // an inbound lands during the op -> queued behind the window
    await handleInbound(pi, inbound("hello", "m2"), ctx);
    await flush(10);
    expect(channelPosts().some((t) => t === "[queued] 1 in line")).toBe(true);

    // op shutdown chain at +300ms: restart requested, watchdog armed
    jest.advanceTimersByTime(300);
    await flush(30);
    expect(shutdowns).toBe(1);
    expect(got).toEqual(["pi.service"]); // resolved name

    // 14.9s later: the failure is not yet declared
    jest.advanceTimersByTime(14_999);
    expect(isCompacting("ch1")).toBe(true);
    expect(channelPosts().some((t) => t.startsWith("[!] restart failed"))).toBe(
      false,
    );

    // ~15s: watchdog fires — process still alive, same window entry open
    jest.advanceTimersByTime(2);
    await flush(10);
    // the drained inbound's fs I/O (memory toc) needs real event-loop
    // turns, which microtask flushing alone never yields
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    await flush(20);
    expect(isCompacting("ch1")).toBe(false); // op window closed
    expect(
      channelPosts().some(
        (t) => t === "[!] restart failed - check unit pi.service",
      ),
    ).toBe(true); // RESOLVED unit name in the channel
    // queued inbound drained through pi (replay, not re-queue)
    const drained = sent.find(
      (s) =>
        s.m.customType === "channel-inbound" &&
        s.m.details?.body?.includes("hello"),
    );
    expect(drained).toBeDefined();
    expect(midTurnQueues.get("ch1")?.length ?? 0).toBe(0);
    // no stale marker left to settle some future boot
    expect(fs.existsSync(path.join(tmp, ".tmp", "op-marker.json"))).toBe(false);
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

describe("/diff (issue #7)", () => {
  let tmp: string;
  let realHome: string;
  let realFetch: typeof fetch;
  let pi: any;
  let ctx: any;
  let fetchCalls: { url: string; method: string; body?: any }[];

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

  const replyContent = (): string => {
    const posts = fetchCalls.filter(
      (c) => c.method === "POST" && c.url.endsWith("/channels/ch1/messages"),
    );
    return JSON.parse(posts.at(-1)!.body).content;
  };

  beforeEach(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "piscord-diff-"));
    realHome = process.env.HOME!;
    process.env.HOME = tmp; // isolate webdrop config + .pi from the real home
    fs.mkdirSync(path.join(tmp, ".pi"), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, ".pi", "settings.json"),
      JSON.stringify({
        channels: [
          { id: "ch1", name: "Test", type: "discord", botToken: "tok1" },
        ],
      }),
    );
    fs.mkdirSync(path.join(tmp, ".config", "webdrop"), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, ".config", "webdrop", "config.toml"),
      'server = "https://drop.test"\ntoken = "cfg-token"\n',
    );
    // real git repo with one uncommitted change
    const env = {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t",
    };
    const { spawnSync } = await import("node:child_process");
    expect(spawnSync("git", ["init", "-q"], { cwd: tmp, env }).status).toBe(0);
    fs.writeFileSync(path.join(tmp, "a.txt"), "one\ntwo\n");
    spawnSync("git", ["add", "a.txt"], { cwd: tmp, env });
    expect(
      spawnSync("git", ["commit", "-q", "-m", "base"], { cwd: tmp, env })
        .status,
    ).toBe(0);
    fs.writeFileSync(path.join(tmp, "a.txt"), "one\nTWO\n");

    fetchCalls = [];
    pi = {
      registerMessageRenderer: () => {},
      registerTool: () => {},
      on: () => {},
      sendMessage: () => {},
    };
    ctx = {
      cwd: tmp,
      ui: { setStatus: () => {} },
      isIdle: () => true,
      hasPendingMessages: () => false,
      abort: () => {},
    };
    realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: any, init?: any) => {
      const u = String(url);
      fetchCalls.push({
        url: u,
        method: init?.method ?? "GET",
        body: init?.body,
      });
      if (u.startsWith("https://drop.test/")) {
        return {
          ok: true,
          status: 201,
          json: async () => ({ url: "https://drop.test/feedd00d.html" }),
        };
      }
      return { ok: true, status: 200, json: async () => ({ id: "out1" }) };
    }) as any;
  });

  afterEach(() => {
    clearDiscordStatesForTest();
    globalThis.fetch = realFetch;
    process.env.HOME = realHome;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test("/diff publishes the working tree diff and replies with url + stats", async () => {
    await handleInbound(pi, inbound("/diff", "dm1"), ctx);
    expect(replyContent()).toBe(
      "[ok] working tree · 1 file +1 -1 · ttl 7d\nhttps://drop.test/feedd00d.html",
    );
    const up = fetchCalls.find((c) =>
      c.url.startsWith("https://drop.test/api/"),
    );
    expect(up).toBeTruthy();
    // uploaded payload is the self-contained viewer page
    const body = String(up!.body ?? "");
    expect(body).toContain("<!DOCTYPE html>");
    expect(body).toContain("working tree");
    expect(body).toContain("#0d1117");
    expect(body).toContain("TWO");
    expect(body).toContain('"del"');
  });

  test("/diff with fenced paste publishes without touching git", async () => {
    await handleInbound(
      pi,
      inbound(
        "/diff ```diff\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n```",
        "dm2",
      ),
      ctx,
    );
    expect(replyContent()).toBe(
      "[ok] pasted diff · 1 file +1 -1 · ttl 7d\nhttps://drop.test/feedd00d.html",
    );
  });

  test("/diff with unresolvable arg replies usage", async () => {
    await handleInbound(pi, inbound("/diff hello\nworld", "dm3"), ctx);
    expect(replyContent()).toBe(
      "[!] usage: /diff [git-range | file | diff-paste] (default: working tree)",
    );
  });

  test("/diff without webdrop config reports the gap", async () => {
    fs.rmSync(path.join(tmp, ".config"), { recursive: true, force: true });
    await handleInbound(pi, inbound("/diff", "dm4"), ctx);
    expect(replyContent()).toBe(
      "[!] webdrop not configured (need WEBDROP_SERVER + WEBDROP_TOKEN or ~/.config/webdrop/config.toml)",
    );
  });
});

describe("v3 column budget (mockup3): every rendered frame line fits 40 cols", () => {
  const longAction =
    "bash cargo build --release --features everything,extra,long-flags -p some-crate";
  const longPath =
    "/home/monky/.pi-bg-wt/jarate/20260913-091303-15761/packages/bridge/channel/index.ts";

  test("statusLine fits the budget at any call count or elapsed time", () => {
    const t0 = Date.now() - 125_000;
    for (const n of [1, 3, 12, 99]) {
      for (const t of [t0, Date.now() - 1000, Date.now() - 960_000]) {
        const line = statusLine(longAction, n, t);
        expect(line.length).toBeLessThanOrEqual(TOOL_LINE_MAX);
        expect(line.startsWith("┣ ")).toBe(true);
      }
    }
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
      expect(action.length).toBeLessThanOrEqual(36);
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

  test("doneFrame: header + capped sub-steps + overflow line, all <= 40 cols", () => {
    const calls = Array.from({ length: 14 }, (_, i) => `bash step-${i} --flag`);
    const frame = doneFrame(calls, 14, 96, false).split("\n");
    expect(frame[0]).toBe("┌ done · 14 calls · 96s");
    expect(frame[1]).toBe("├ … +4 earlier calls");
    expect(frame.length).toBe(2 + DONE_FRAME_MAX_STEPS + 1);
    expect(frame.at(-1)).toBe("└");
    // last 10 calls, in order, last sub-step on └
    expect(frame[2]).toBe("│ ├ bash step-4 --flag");
    expect(frame.at(-2)).toBe("│ └ bash step-13 --flag");
    for (const line of frame) {
      expect(line.length).toBeLessThanOrEqual(TOOL_LINE_MAX);
    }
  });

  test("doneFrame: failed runs swap the header to the ┤ failed glyph", () => {
    const frame = doneFrame(["read x.ts"], 1, 5, true).split("\n");
    expect(frame[0]).toBe("┤ failed · 1 call · 5s");
    expect(frame.at(-1)).toBe("└");
    for (const line of frame) {
      expect(line.length).toBeLessThanOrEqual(TOOL_LINE_MAX);
    }
  });

  test("doneFrame: very long actions clip at the line budget", () => {
    const frame = doneFrame([longAction, "bash ok"], 2, 5, false).split("\n");
    for (const line of frame) {
      expect(line.length).toBeLessThanOrEqual(TOOL_LINE_MAX);
    }
    expect(frame.at(-2)).toBe("│ └ bash ok");
  });
});
