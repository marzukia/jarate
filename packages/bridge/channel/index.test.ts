import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fmtTokensLC } from "./ctxwatch";
import {
  clearDiscordStatesForTest,
  getChannelCursor,
  loadPersistedCursors,
  pollDiscord,
  seedChannelStateForTest,
  setChannelCursor,
} from "./discord";
import { FRAME_COL_MAX } from "./frame";
import extension, {
  bashToolEssential,
  buildInteractionHandler,
  buildRepliedMessageBlock,
  buildRestartCommand,
  channelError,
  chunkText,
  clearAllCompacting,
  clearAllInterrupts,
  clearQueuedInbound,
  collectFinals,
  ctxBoundaryNotice,
  ctxWatchers,
  deleteQueuedInbound,
  deliverDueTasks,
  deliverDueWakes,
  earlySendText,
  failurePostText,
  fence,
  fileOnlyPrompt,
  handleInbound,
  heldChannels,
  interruptStepTimeoutMs,
  isCompacting,
  isEssentialToolCall,
  isHeld,
  isVerbose,
  LIVE_TEXT_PLACEHOLDER,
  LIVE_TEXT_THROTTLE_MS,
  lastRunUsage,
  matchCommand,
  midTurnQueues,
  opWindowLabel,
  parseReplyTo,
  parseUndoCount,
  parseVerboseLevel,
  pendingAttachments,
  pendingInterrupts,
  popChannelQueuedInbound,
  prunePendingBatches,
  queuedAcks,
  queueMidTurnInbound,
  REPEAT_WARNING,
  RUN_FRAME_MAX_STEPS,
  registerSleepTool,
  registerTaskTool,
  registerTodoTool,
  resetRuntimeStateForTest,
  runFrame,
  runMidRunInterrupt,
  runShellPassthrough,
  runUsageLine,
  setInterruptCtx,
  setRuntimeStateDir,
  setSystemdRestartHookForTest,
  stopAllCompactTicks,
  stopAllOpTicks,
  TODO_TOOL_DESCRIPTION,
  TOOL_LINE_MAX,
  TOOL_TEXT_MAX,
  toolActionText,
  truncateLiveText,
  updateQueuedInbound,
  verboseLevel,
  verboseOverride,
} from "./index";
import { CLAIM_TTL_MS, loadWakes, markClaimed, scheduleWake } from "./sleep";
import { loadTasks, markTaskClaimed, scheduleTask } from "./tasks";
import { fit, loadBoard, renderBoard, saveBoard } from "./todos";
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

  test("0, negative, non-numeric -> null (one [!] line, no action)", () => {
    expect(parseUndoCount("0")).toBeNull();
    expect(parseUndoCount("-1")).toBeNull();
    expect(parseUndoCount("abc")).toBeNull();
    expect(parseUndoCount("1.5")).toBeNull();
    expect(parseUndoCount("1x")).toBeNull();
    expect(parseUndoCount("2 turns")).toBeNull();
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

  test("aborted run shaped stopReason=error is suppressed even when NOT user-stopped", () => {
    // The user-stopped flag can race a re-wake's turn_start reset (the
    // aborted run's agent_end runs AFTER the fresh run started). The
    // abort marker itself is the signal — suppress unconditionally.
    expect(
      failurePostText([failure("error", "This operation was aborted")], false),
    ).toBeNull();
  });

  test("genuine error is trimmed to its first line, no stack", () => {
    expect(
      failurePostText(
        [failure("error", "boom line1\n    at stack frame (x.js:1:1)")],
        false,
      ),
    ).toBe("[!] boom line1");
  });

  test("run-level timeout posts the short marker", () => {
    expect(
      failurePostText(
        [failure("error", "request timed out after 30000ms")],
        false,
      ),
    ).toBe("[!] timed out");
  });

  test("run-level rate limit posts the short marker", () => {
    expect(
      failurePostText([failure("error", "429 Too Many Requests")], false),
    ).toBe("[!] rate limited, retrying");
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

describe("channelError", () => {
  test("abort strings are suppressed (null)", () => {
    expect(channelError("This operation was aborted")).toBeNull();
    expect(channelError("Command aborted")).toBeNull();
    expect(
      channelError(
        new DOMException("This operation was aborted", "AbortError"),
      ),
    ).toBeNull();
  });

  test("genuine error: first line only, no stack, capped at 200 chars", () => {
    expect(
      channelError(
        new Error(
          "first line of failure\n    at foo (bar.js:1:1)\n    at main",
        ),
      ),
    ).toBe("first line of failure");
    expect(channelError(new Error("x".repeat(500)))).toHaveLength(200);
    expect(channelError(new Error("x".repeat(100)))).toHaveLength(100);
  });

  test("timeout markers", () => {
    expect(channelError(new Error("request timed out after 30000ms"))).toBe(
      "timed out",
    );
    const e = new Error("connect");
    (e as any).code = "ETIMEDOUT";
    expect(channelError(e)).toBe("timed out");
    expect(
      channelError(new DOMException("The operation timed out", "TimeoutError")),
    ).toBe("timed out");
  });

  test("rate limit markers", () => {
    const e = new Error("response error");
    (e as any).status = 429;
    expect(channelError(e)).toBe("rate limited, retrying");
    expect(channelError(new Error("rate limit exceeded"))).toBe(
      "rate limited, retrying",
    );
  });

  test("ENOSPC marker", () => {
    const e = new Error("write /tmp/x: no space left on device");
    (e as any).code = "ENOSPC";
    expect(channelError(e)).toBe("disk full");
  });

  test("empty input yields empty string (fallback), null/undefined suppressed", () => {
    expect(channelError("")).toBe("");
    expect(channelError(null)).toBeNull();
    expect(channelError(undefined)).toBeNull();
  });

  test("sensitive text is redacted in the fallback line", () => {
    expect(
      channelError(new Error("fetch failed: Bearer sk-abcdefghijklmnop1234")),
    ).toBe("fetch failed: Bearer [REDACTED]");
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
            String(JSON.parse(p.body).content) === "[!] rate limited, retrying",
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
      clearDiscordStatesForTest(); // no auto-react suppression leaks across tests
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
    expect(contents.filter((t) => t.includes(REPEAT_WARNING)).length).toBe(1);
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

describe("#39 /hold", () => {
  let tmp = "";
  let pi: any;
  let ctx: any;
  let handlers: Record<string, (...a: any[]) => any> = {};
  let sent: { m: any; o?: any }[] = [];
  let fetchCalls: { url: string; method: string; body?: any }[] = [];
  const realFetch = globalThis.fetch;

  const OWNER = "<user-id-1>";
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
  const otherInbound = (body: string, id: string): ChannelMessage => ({
    ...inbound(body, id),
    fromId: "someone-else",
  });
  const flush = async () => {
    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
  };
  const posts = () =>
    fetchCalls
      .filter(
        (c) => c.method === "POST" && c.url.endsWith("/channels/ch1/messages"),
      )
      .map((c) => String(JSON.parse(c.body).content));
  const mockBusy = (b: boolean) => {
    ctx.isIdle = () => !b;
  };

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jarate-hold-"));
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
            forwardToolCalls: false,
          },
        ],
      }),
    );
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
    await handlers.agent_end?.({ messages: [] }, ctx); // clears any typing interval
    globalThis.fetch = realFetch;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test("matchCommand: /hold variants", () => {
    expect(matchCommand("/hold")!.name).toBe("hold");
    expect(matchCommand("/hold on")!.arg).toBe("on");
    expect(matchCommand("/hold OFF")!.arg).toBe("OFF");
    expect(matchCommand("/holdup")).toBeNull();
  });

  test("popChannelQueuedInbound: FIFO per channel, rest stays", async () => {
    mockBusy(true);
    await handleInbound(pi, inbound("a", "m1"), ctx);
    await handleInbound(pi, inbound("b", "m2"), ctx);
    const e1 = popChannelQueuedInbound("ch1");
    expect(e1?.msg.body).toBe("a");
    expect(midTurnQueues.get("ch1")?.length).toBe(1);
    const e2 = popChannelQueuedInbound("ch1");
    expect(e2?.msg.body).toBe("b");
    expect(popChannelQueuedInbound("ch1")).toBeNull();
    expect(midTurnQueues.has("ch1")).toBe(false);
  });

  test("held + idle: plain message queues, no run, no interrupt armed", async () => {
    await handleInbound(pi, inbound("/hold on", "m1"), ctx);
    expect(
      posts().some((t) =>
        t.includes("[ok] hold on - buffered until /hold off"),
      ),
    ).toBe(true);
    expect(isHeld(loadChannelConfig(ctx.cwd)[0]!)).toBe(true);

    await handleInbound(pi, inbound("hello there", "m2"), ctx);
    await flush();
    expect(sent).toHaveLength(0); // buffered, not sent to pi
    expect(midTurnQueues.get("ch1")?.length).toBe(1);
    expect(posts().some((t) => t.includes("[queued] 1 in line"))).toBe(true);
    expect(pendingInterrupts.get("ch1")).toBeUndefined(); // no armed interrupt

    // second message stacks behind it
    await handleInbound(pi, inbound("and this too", "m3"), ctx);
    expect(midTurnQueues.get("ch1")?.length).toBe(2);
  });

  test("agent_end skips a held channel; /hold off drains FIFO", async () => {
    mockBusy(true);
    await handleInbound(pi, inbound("/hold on", "m1"), ctx);
    await handleInbound(pi, inbound("first", "m2"), ctx);
    await handleInbound(pi, inbound("second", "m3"), ctx);
    // run ends while held: the buffer must NOT drain
    await handlers.agent_end({ messages: [] }, ctx);
    expect(sent).toHaveLength(0);
    expect(midTurnQueues.get("ch1")?.length).toBe(2);

    // release while the channel is idle: oldest runs now
    mockBusy(false);
    await handleInbound(pi, inbound("/hold off", "m4"), ctx);
    await flush();
    expect(sent.map((s) => s.m.details.body)).toEqual(["first"]);
    expect(sent[0].o.triggerTurn).toBe(true);
    expect(
      posts().some((t) => t.includes("[ok] hold off - 2 in line, running")),
    ).toBe(true);

    // that run ends: the re-wake loop chains the rest
    await handlers.agent_end({ messages: [] }, ctx);
    expect(sent.map((s) => s.m.details.body)).toEqual(["first", "second"]);
    expect(midTurnQueues.has("ch1")).toBe(false);
  });

  test("/hold off while a run is in flight: no immediate send, drains at run end", async () => {
    mockBusy(true);
    await handleInbound(pi, inbound("/hold on", "m1"), ctx);
    await handleInbound(pi, inbound("first", "m2"), ctx);
    await handleInbound(pi, inbound("second", "m3"), ctx);
    await handleInbound(pi, inbound("/hold off", "m4"), ctx);
    await flush();
    expect(sent).toHaveLength(0); // still running: wait for agent_end
    expect(
      posts().some((t) => t.includes("[ok] hold off - 2 in line, will run")),
    ).toBe(true);
    expect(midTurnQueues.get("ch1")?.length).toBe(2);

    await handlers.agent_end({ messages: [] }, ctx);
    expect(sent.map((s) => s.m.details.body)).toEqual(["first"]);
    await handlers.agent_end({ messages: [] }, ctx);
    expect(sent.map((s) => s.m.details.body)).toEqual(["first", "second"]);
  });

  test("/stop while held keeps the buffer and reports it", async () => {
    mockBusy(true);
    await handleInbound(pi, inbound("/hold on", "m1"), ctx);
    await handleInbound(pi, inbound("first", "m2"), ctx);
    await handleInbound(pi, inbound("second", "m3"), ctx);
    expect(midTurnQueues.get("ch1")?.length).toBe(2);

    await handleInbound(pi, inbound("/stop", "m4"), ctx);
    expect(
      posts().some((t) => t.includes("[-] stopped - 2 held in line")),
    ).toBe(true);
    expect(midTurnQueues.get("ch1")?.length).toBe(2); // buffer intact

    // /stop on a NON-held channel still drains (regression guard)
    heldChannels.clear();
    await handleInbound(pi, inbound("/stop", "m5"), ctx);
    expect(posts().some((t) => t.includes("[-] stopped"))).toBe(true);
    expect(midTurnQueues.has("ch1")).toBe(false);
  });

  test("/hold on preserves an existing (non-held) line; off drains it", async () => {
    mockBusy(true);
    await handleInbound(pi, inbound("early", "m1"), ctx); // queued, interrupt armed
    expect(pendingInterrupts.get("ch1")?.length).toBe(1);
    await handleInbound(pi, inbound("/hold on", "m2"), ctx);
    // arming stopped + the pending interrupt disarmed
    expect(pendingInterrupts.get("ch1")).toBeUndefined();
    expect(midTurnQueues.get("ch1")?.length).toBe(1);
    await handleInbound(pi, inbound("late", "m3"), ctx);
    expect(midTurnQueues.get("ch1")?.length).toBe(2);

    mockBusy(false); // channel settles before the release
    await handleInbound(pi, inbound("/hold off", "m4"), ctx);
    await flush();
    expect(sent.map((s) => s.m.details.body)).toEqual(["early"]);
  });

  test("commands still run while held", async () => {
    await handleInbound(pi, inbound("/hold on", "m1"), ctx);
    await handleInbound(pi, inbound("/status", "m2"), ctx);
    expect(posts().some((p) => p.includes("[status]"))).toBe(true);
    expect(sent).toHaveLength(0); // status is not a pi run
  });

  test("bare /hold toggles; bad arg is a usage error; non-owner rejected", async () => {
    await handleInbound(pi, inbound("/hold", "m1"), ctx);
    expect(isHeld(loadChannelConfig(ctx.cwd)[0]!)).toBe(true);
    await handleInbound(pi, inbound("/hold", "m2"), ctx);
    expect(isHeld(loadChannelConfig(ctx.cwd)[0]!)).toBe(false);

    await handleInbound(pi, inbound("/hold maybe", "m3"), ctx);
    expect(posts().some((t) => t.includes("[!] usage: /hold on|off"))).toBe(
      true,
    );

    await handleInbound(pi, otherInbound("/hold on", "m4"), ctx);
    // text-form command from a non-owner: not executed, falls through to
    // pi as plain text (the "[!] owner only" ack is the native path)
    expect(isHeld(loadChannelConfig(ctx.cwd)[0]!)).toBe(false);
    expect(sent).toHaveLength(1);
  });

  test("hold flag persists to channel-state.json and reloads after restart", async () => {
    const dir = path.join(tmp, ".tmp");
    setRuntimeStateDir(dir);
    await handleInbound(pi, inbound("/hold on", "m1"), ctx);
    const onDisk = JSON.parse(
      fs.readFileSync(path.join(dir, "channel-state.json"), "utf-8"),
    );
    expect(onDisk.channels.ch1.hold).toBe(true);

    // simulated process restart: in-memory wiped, file reloaded
    resetRuntimeStateForTest();
    setRuntimeStateDir(dir);
    expect(isHeld(loadChannelConfig(ctx.cwd)[0]!)).toBe(true);

    // release: file updates, reload sees it off
    await handleInbound(pi, inbound("/hold off", "m2"), ctx);
    resetRuntimeStateForTest();
    setRuntimeStateDir(dir);
    expect(isHeld(loadChannelConfig(ctx.cwd)[0]!)).toBe(false);
  });
});

// ─── #10 3-level persistent verbosity ────────────────────────────────

describe("#10 verbosity levels", () => {
  let tmp = "";
  let pi: any;
  let ctx: any;
  let handlers: Record<string, (...a: any[]) => any> = {};
  let sent: { m: any; o?: any }[] = [];
  let fetchCalls: { url: string; method: string; body?: any }[] = [];
  const realFetch = globalThis.fetch;

  const OWNER = "<user-id-1>";
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
  const OWNER = "<user-id-1>";

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
    expect(posts().some((p) => p === "[!] boom")).toBe(true);
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

  test("owner-only: verbose 0 -> early-send behavior unchanged, no live-text message", async () => {
    verboseOverride.set("ch1", 0);
    await handleInbound(pi, inbound("hello", "m1"), ctx);
    await handlers.turn_start(null, ctx);
    await handlers.message_end({ message: inter("working text") }, ctx);
    await tc("read", { path: "a.txt" });
    // intermediate text early-sent as a standalone message (today's behavior)
    expect(posts()).toContain("working text");
    // no live-text message: no placeholder, no edit
    expect(posts()).not.toContain(LIVE_TEXT_PLACEHOLDER);
    expect(patches()).toHaveLength(0);
    // and the run still ends cleanly with its final
    await handlers.message_end({ message: fin("done") }, ctx);
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
    clearDiscordStatesForTest(); // no auto-react suppression leaks across tests
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
    clearDiscordStatesForTest(); // no auto-react suppression leaks across tests
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
    expect(channelPosts().some((t) => t.includes("[..] compacting..."))).toBe(
      true,
    );
    opts.onComplete({
      summary: "s",
      firstKeptEntryId: "e",
      tokensBefore: 219997,
      estimatedTokensAfter: 35000,
    });
    await tick();
    // The report REPLACES the ticking placeholder in place (PATCH), not a
    // fresh post — no double message when the compact lands. k/m form
    // (fmtTokensLC) so the line fits the 40-col budget even at 9-digit
    // token counts.
    const reportText = "[ok] compacted: 220k -> 35k";
    const edits = fetchCalls.filter(
      (c) => c.method === "PATCH" && c.url.includes("/messages/"),
    );
    expect(
      edits.some(
        (c) =>
          (typeof c.body === "string" ? JSON.parse(c.body) : c.body).content ===
          fence(reportText),
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
    expect(channelPosts().some((t) => t.includes("[..] compacting..."))).toBe(
      true,
    );

    // No edit before the first 5s tick
    jest.advanceTimersByTime(4999);
    expect(edits().length).toBe(0);
    jest.advanceTimersByTime(1);
    expect(edits()).toEqual([fence("[..] compacting… 5s")]);
    // subsequent ticks keep updating the SAME message in place
    jest.advanceTimersByTime(5000);
    expect(edits()).toEqual([
      fence("[..] compacting… 5s"),
      fence("[..] compacting… 10s"),
    ]);
    jest.advanceTimersByTime(5000);
    expect(edits()).toEqual([
      fence("[..] compacting… 5s"),
      fence("[..] compacting… 10s"),
      fence("[..] compacting… 15s"),
    ]);

    // Settle: the report replaces the placeholder in place, tick stops
    opts.onComplete({ tokensBefore: 100, estimatedTokensAfter: 10 });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(edits().at(-1)).toBe(fence("[ok] compacted: 100 -> 10"));
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
    expect(channelPosts().some((t) => t.includes("[..] compacting..."))).toBe(
      true,
    );
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
          fence(failText),
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
      channelPosts().some((t) =>
        t.includes(
          "[!] compact failed: Nothing to compact (session too small)",
        ),
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
      channelPosts().some((t) => t.includes("[!] compact failed: boom-ctx")),
    ).toBe(true);
    expect(channelPosts().some((t) => t.includes("[..] compacting..."))).toBe(
      false,
    );
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
        t.includes("[queued] compact (run in progress)"),
      ),
    ).toBe(true);
    // run ends → flush (flushed compact posts its own ticking placeholder)
    await handlers.agent_end({ messages: [] }, ctx);
    expect(opts?.customInstructions).toBe("keep the jarate");
    await tick();
    expect(channelPosts().some((t) => t.includes("[..] compacting..."))).toBe(
      true,
    );
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
        t.includes("[queued] compact (run in progress), replaces earlier"),
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
        t.includes("[queued] compact (compact already in progress)"),
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
    // the drain's handleInbound has its own awaits (memory toc readFile is
    // scheduled mid-advanceTimersByTime, so its completion can land late
    // under load); poll instead of a single tick
    for (let i = 0; i < 200; i++) {
      if (piSends().some((s) => s.m.details?.body === "late msg")) break;
      await tick();
    }
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
    expect(
      channelPosts().some((t) => t.includes("[!] already compacting")),
    ).toBe(true);
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
    expect(
      channelPosts().some((t) => t.includes("[!] already compacting")),
    ).toBe(true);
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
        t.includes("[queued] compact (compact already in progress)"),
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
    clearDiscordStatesForTest(); // no auto-react suppression leaks across tests
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
      fence(
        renderBoard([
          { content: "fix bug", status: "in_progress" },
          { content: "tests", status: "pending" },
        ]),
      ),
    );
    expect(content).toContain("┌ todos · 2 open");
  });

  test("/todos with an empty board says 'no open todos'", async () => {
    await handleInbound(pi, inbound("/todos", "m1"), ctx);
    expect(replyContent()).toBe(fence("[todos] no open todos"));
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
    // strip the code fence (machine frames are fenced) before block checks
    const content = replyContent()
      .replace(/^```\n/, "")
      .replace(/\n```$/, "");
    expect(content).toContain("┌ Test · 1 open");
    expect(content).toContain("├ a");
    expect(content).toContain("┌ ch2 · 0 open");
    expect(content).toContain("├ ~~b~~");
    // each board block is framed: opens with ┌, closes with └
    expect(content.split("\n\n").length).toBe(2);
    for (const block of content.split("\n\n")) {
      expect(block.startsWith("┌ ")).toBe(true);
      expect(block.trimEnd().endsWith("└")).toBe(true);
    }
  });

  test("/todos all with no boards says 'no open todos'", async () => {
    await handleInbound(pi, inbound("/todos all", "m1"), ctx);
    expect(replyContent()).toBe(fence("[todos] no open todos"));
  });

  test("/todos all clips a long channel name to the 40-col budget", async () => {
    const longName = "a".repeat(90);
    fs.writeFileSync(
      path.join(tmp, ".pi", "settings.json"),
      JSON.stringify({
        channels: [
          {
            id: "ch1",
            name: longName,
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
        todos: [{ content: "a", status: "pending" }],
        updatedAt: "t",
      },
      tmp,
    );
    await handleInbound(pi, inbound("/todos all", "m1"), ctx);
    const header = replyContent()
      .split("\n")
      .find((l) => l.startsWith("┌ "))!;
    // display width strips nothing here (no markdown in the header):
    // raw length is the display length
    expect(header.length).toBeLessThanOrEqual(40);
    expect(header.startsWith("┌ ")).toBe(true);
    expect(header.endsWith(" · 1 open")).toBe(true);
    expect(header).toContain("…"); // clipped
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
    expect(r2.content[0].text).toContain("├ ~~a~~");
    posts = fetchCalls.filter(
      (c) => c.method === "POST" && c.url.endsWith("/channels/ch1/messages"),
    );
    expect(posts.length).toBe(1);
    const patch = fetchCalls.find(
      (c) =>
        c.method === "PATCH" && c.url.endsWith("/channels/ch1/messages/out1"),
    );
    expect(patch).toBeDefined();
    expect(JSON.parse(patch!.body).content).toContain("├ ~~a~~");
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
    expect(r.content[0].text).toContain("├ ~~a~~");
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
    clearDiscordStatesForTest(); // no auto-react suppression leaks across tests
    globalThis.fetch = realFetch;
    process.env.HOME = realHome;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test("/sleep with no wakes says 'no pending wakes'", async () => {
    await handleInbound(pi, inbound("/sleep", "m1"), ctx);
    expect(replyContent()).toBe(fence("[wake] no pending wakes"));
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
    expect(replyContent()).toBe(fence("[!] usage: /sleep cancel <id>"));
    await handleInbound(pi, inbound("/sleep xyz", "m3"), ctx);
    expect(replyContent()).toBe(
      fence("[!] usage: /sleep [list | cancel <id>]"),
    );
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
    clearDiscordStatesForTest(); // no auto-react suppression leaks across tests
    globalThis.fetch = realFetch;
    process.env.HOME = realHome;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test("/tasks with no tasks says 'no scheduled tasks'", async () => {
    await handleInbound(pi, inbound("/tasks", "m1"), ctx);
    expect(replyContent()).toBe(fence("[tasks] no scheduled tasks"));
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
    expect(replyContent()).toBe(fence("[!] usage: /tasks cancel <id>"));
    await handleInbound(pi, inbound("/tasks xyz", "m3"), ctx);
    expect(replyContent()).toBe(
      fence("[!] usage: /tasks [list | add | reschedule | cancel]"),
    );
  });

  test("/tasks add: one-shot minutes -> scheduled in this channel", async () => {
    await handleInbound(
      pi,
      inbound('/tasks add "check the build" 30', "m1"),
      ctx,
    );
    expect(replyContent()).toContain("[ok] task");
    expect(replyContent()).toContain("cancel with /tasks cancel");
    const tasks = loadTasks(tmp);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({
      channelId: "ch1",
      channelName: "Test",
      prompt: "check the build",
      kind: "at",
    });
    expect(tasks[0].atMs).toBeGreaterThanOrEqual(Date.now() + 29 * 60000);
    expect(tasks[0].atMs).toBeLessThanOrEqual(Date.now() + 31 * 60000);
  });

  test("/tasks add: one-shot ISO time -> exact fire time", async () => {
    const iso = new Date(Date.now() + 3600000).toISOString();
    await handleInbound(
      pi,
      inbound(`/tasks add "iso check" ${iso}`, "m1"),
      ctx,
    );
    expect(replyContent()).toContain("[ok] task");
    const t = loadTasks(tmp)[0];
    expect(t).toMatchObject({
      channelId: "ch1",
      prompt: "iso check",
      kind: "at",
      atMs: Date.parse(iso),
    });
  });

  test("/tasks add: cron + tz -> recurring with computed first fire", async () => {
    await handleInbound(
      pi,
      inbound('/tasks add "run the fleet check" 0 6 * * * UTC', "m1"),
      ctx,
    );
    expect(replyContent()).toContain('cron "0 6 * * *" (UTC)');
    const t = loadTasks(tmp)[0];
    expect(t).toMatchObject({
      channelId: "ch1",
      prompt: "run the fleet check",
      kind: "cron",
      cron: "0 6 * * *",
      tz: "UTC",
    });
    // next 06:00 UTC strictly in the future, within 24h (real clock)
    expect(t.nextFireAt).toBeGreaterThan(Date.now());
    expect(t.nextFireAt).toBeLessThanOrEqual(
      Date.now() + 24 * 3600000 + 120000,
    );
  });

  test("/tasks reschedule: swaps the spec, keeps id + prompt", async () => {
    const t = scheduleTask({
      channelId: "ch1",
      channelName: "Test",
      prompt: "check the build",
      spec: {
        kind: "at",
        atMs: Date.now() + 30 * 60000,
        nextFireAt: Date.now() + 30 * 60000,
      },
      home: tmp,
    });
    await handleInbound(
      pi,
      inbound(
        `/tasks reschedule ${t.id} 0 9 * * 1-5 Australia/Melbourne`,
        "m1",
      ),
      ctx,
    );
    expect(replyContent()).toContain("[ok] rescheduled");
    expect(replyContent()).toContain(
      'cron "0 9 * * 1-5" (Australia/Melbourne)',
    );
    const after = loadTasks(tmp)[0];
    expect(after).toMatchObject({
      id: t.id,
      prompt: "check the build",
      channelId: "ch1",
      kind: "cron",
      cron: "0 9 * * 1-5",
      tz: "Australia/Melbourne",
      status: "pending",
    });
    expect(after.atMs).toBeUndefined();
    expect(after.nextFireAt).toBeGreaterThan(Date.now());
  });

  test("/tasks reschedule: unknown id or other channel -> one [!] line, nothing changes", async () => {
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
    const other = scheduleTask({
      channelId: "ch2",
      prompt: "other channel task",
      spec: {
        kind: "at",
        atMs: Date.now() + 30 * 60000,
        nextFireAt: Date.now() + 30 * 60000,
      },
      home: tmp,
    });
    await handleInbound(pi, inbound("/tasks reschedule nope 30", "m1"), ctx);
    expect(replyContent()).toBe("[!] no task with id nope");
    // same id shape on another channel is not THIS session's task
    await handleInbound(
      pi,
      inbound(`/tasks reschedule ${other.id} 30`, "m2"),
      ctx,
    );
    expect(replyContent()).toBe(`[!] no task with id ${other.id}`);
    // untouched
    expect(
      loadTasks(tmp).find((x) => x.id === t.id)!.nextFireAt,
    ).toBeGreaterThan(Date.now());
    expect(loadTasks(tmp)).toHaveLength(2);
  });

  test("/tasks add + reschedule: bad-arg paths -> one [!] line each, nothing scheduled", async () => {
    const t = scheduleTask({
      channelId: "ch1",
      prompt: "seed",
      spec: {
        kind: "at",
        atMs: Date.now() + 30 * 60000,
        nextFireAt: Date.now() + 30 * 60000,
      },
      home: tmp,
    });
    const addUsage = fence(
      '[!] usage: /tasks add "<prompt>" <minutes|ISO|cron [tz]>',
    );
    const resUsage = fence(
      "[!] usage: /tasks reschedule <id> <minutes|ISO|cron [tz]>",
    );
    // form errors -> usage line
    await handleInbound(pi, inbound("/tasks add", "m1"), ctx);
    expect(replyContent()).toBe(addUsage);
    await handleInbound(
      pi,
      inbound("/tasks add check the build 30", "m2"), // unquoted prompt
      ctx,
    );
    expect(replyContent()).toBe(addUsage);
    await handleInbound(pi, inbound('/tasks add "x"', "m3"), ctx); // no spec
    expect(replyContent()).toBe(addUsage);
    await handleInbound(pi, inbound('/tasks add "x" 30 UTC', "m4"), ctx);
    expect(replyContent()).toBe(addUsage); // 2 tokens: not any form
    await handleInbound(pi, inbound("/tasks reschedule", "m5"), ctx);
    expect(replyContent()).toBe(resUsage);
    await handleInbound(pi, inbound(`/tasks reschedule ${t.id}`, "m6"), ctx);
    expect(replyContent()).toBe(resUsage); // missing spec
    // content errors -> one [!] line (from parseTaskSpec / rescheduleTask)
    await handleInbound(pi, inbound('/tasks add "" 30', "m7"), ctx);
    expect(replyContent()).toBe("[!] prompt is required");
    await handleInbound(pi, inbound('/tasks add "x" 0', "m8"), ctx);
    expect(replyContent()).toBe("[!] minutes must be greater than 0");
    await handleInbound(pi, inbound('/tasks add "x" 99999', "m9"), ctx);
    expect(replyContent()).toBe("[!] minutes too large (max 43200 = 30d)");
    await handleInbound(pi, inbound('/tasks add "x" yesterday', "m10"), ctx);
    expect(replyContent()).toBe(
      '[!] invalid at: "yesterday" (ISO time, e.g. 2026-09-10T15:00:00Z)',
    );
    await handleInbound(pi, inbound('/tasks add "x" 99 * * * *', "m11"), ctx);
    expect(replyContent()).toBe(
      '[!] invalid cron "99 * * * *": minute out of range 0-59: 99',
    );
    await handleInbound(
      pi,
      inbound('/tasks add "x" 0 6 * * * Not/AZone', "m12"),
      ctx,
    );
    expect(replyContent()).toBe(
      '[!] unknown timezone "Not/AZone" (IANA name, e.g. Australia/Melbourne)',
    );
    await handleInbound(
      pi,
      inbound(`/tasks reschedule ${t.id} 99 * * * *`, "m13"),
      ctx,
    );
    expect(replyContent()).toBe(
      '[!] invalid cron "99 * * * *": minute out of range 0-59: 99',
    );
    // seed untouched, nothing scheduled on any path above
    expect(loadTasks(tmp).map((x) => x.id)).toEqual([t.id]);
  });

  test("/tasks list reflects add + reschedule", async () => {
    await handleInbound(
      pi,
      inbound('/tasks add "check the build" 120', "m1"),
      ctx,
    );
    const t = loadTasks(tmp)[0];
    const iso = new Date(Date.now() + 3600000).toISOString();
    await handleInbound(
      pi,
      inbound(`/tasks reschedule ${t.id} ${iso}`, "m2"),
      ctx,
    );
    await handleInbound(pi, inbound("/tasks list", "m3"), ctx);
    const content = replyContent();
    expect(content).toContain("1 pending task (of 1 total):");
    expect(content).toContain(t.id);
    expect(content).toContain("check the build");
    expect(content).toContain(iso);
    expect(content).toContain("in 1h");
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
    clearDiscordStatesForTest(); // no auto-react suppression leaks across tests
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
    jest.advanceTimersByTime(4699); // t=4999
    expect(edits().length).toBe(0);
    jest.advanceTimersByTime(1); // t=5000
    expect(edits()).toEqual([fence("[..] resetting… 5s")]);
    jest.advanceTimersByTime(5000); // t=10000
    expect(edits()).toEqual([
      fence("[..] resetting… 5s"),
      fence("[..] resetting… 10s"),
    ]);

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
        t.includes("[!] nothing to undo: only 1 turn back"),
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
      "[ok] undone: conversation (re-running)",
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

  test("second /reset while an op window is open is rejected; /compact sees the active op; /status shows the op label", async () => {
    await handleInbound(pi, inbound("/reset", "m1"), ctx);
    await tick();
    await handleInbound(pi, inbound("/reset", "m4"), ctx);
    await tick();
    expect(
      channelPosts().filter((t) => t.includes("[!] already restarting")).length,
    ).toBe(1);
    // F5: /compact while resetting names the ACTIVE op, not itself
    await handleInbound(pi, inbound("/compact", "m4b"), ctx);
    await tick();
    expect(
      channelPosts().filter((t) => t.includes("[!] already restarting")).length,
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
    expect(ackEdits()).toEqual([fence("[..] interrupting… 5s")]);

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
    expect(channelPosts().some((t) => t.includes("[!] restart failed"))).toBe(
      false,
    );

    // ~15s: watchdog fires — process still alive, same window entry open
    jest.advanceTimersByTime(2);
    await flush(10);
    // the drained inbound's fs I/O (memory toc) needs real event-loop
    // turns, which microtask flushing alone never yields. The readFile is
    // scheduled mid-advanceTimersByTime, so its completion can also ride a
    // 0ms timer that only fires on a further clock advance (or on
    // useRealTimers in afterEach). A fixed flush/immediate budget is
    // load-sensitive and flaked under box load; poll instead, alternating
    // real yields and small clock nudges (bounded; the next armed timer is
    // 5s away, so +1ms steps cannot trip anything else).
    for (let i = 0; i < 200; i++) {
      const drainedNow = sent.find(
        (s) =>
          s.m.customType === "channel-inbound" &&
          s.m.details?.body?.includes("hello"),
      );
      if (drainedNow) break;
      await new Promise((r) => setImmediate(r));
      jest.advanceTimersByTime(1);
      await flush(5);
    }
    expect(isCompacting("ch1")).toBe(false); // op window closed
    expect(
      channelPosts().some((t) =>
        t.includes("[!] restart failed - check unit pi.service"),
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
    clearDiscordStatesForTest(); // no auto-react suppression leaks across tests
    clearDiscordStatesForTest();
    globalThis.fetch = realFetch;
    process.env.HOME = realHome;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test("/diff publishes the working tree diff and replies with url + stats", async () => {
    await handleInbound(pi, inbound("/diff", "dm1"), ctx);
    expect(replyContent()).toBe(
      fence(
        "[ok] working tree · 1 file +1 -1 · ttl 7d\nhttps://drop.test/feedd00d.html",
      ),
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
      fence(
        "[ok] pasted diff · 1 file +1 -1 · ttl 7d\nhttps://drop.test/feedd00d.html",
      ),
    );
  });

  test("/diff with unresolvable arg replies usage", async () => {
    await handleInbound(pi, inbound("/diff hello\nworld", "dm3"), ctx);
    expect(replyContent()).toBe(
      fence(
        "[!] usage: /diff [git-range | file | diff-paste] (default: working tree)",
      ),
    );
  });

  test("/diff without webdrop config reports the gap", async () => {
    fs.rmSync(path.join(tmp, ".config"), { recursive: true, force: true });
    await handleInbound(pi, inbound("/diff", "dm4"), ctx);
    expect(replyContent()).toBe(
      fence(
        "[!] webdrop not configured (need WEBDROP_SERVER + WEBDROP_TOKEN or ~/.config/webdrop/config.toml)",
      ),
    );
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

describe("wave 2c bridge commands", () => {
  let tmp = "";
  let pi: any;
  let ctx: any;
  let handlers: Record<string, (...a: any[]) => any> = {};
  let sent: { m: any; o?: any }[] = [];
  let fetchCalls: { url: string; method: string; body?: any }[] = [];
  const realFetch = globalThis.fetch;
  const oldWtDir = process.env.PI_BG_WT_DIR;
  const oldGitEnv: Record<string, string | undefined> = {};

  const OWNER = "<user-id-1>";
  const base = (body: string, id: string, fromId: string): ChannelMessage => ({
    channelId: "ch1",
    channelName: "Test",
    channelType: "discord",
    messageId: id,
    from: fromId,
    fromId,
    body,
    timestamp: new Date().toISOString(),
    attachments: [],
    isRoom: false,
  });
  const inbound = (body: string, id: string) => base(body, id, OWNER);
  const otherInbound = (body: string, id: string) => base(body, id, "other");
  const posts = () =>
    fetchCalls
      .filter(
        (c) => c.method === "POST" && c.url.endsWith("/channels/ch1/messages"),
      )
      .map((c) => String(JSON.parse(c.body).content));
  const patches = () =>
    fetchCalls.filter((c) => c.method === "PATCH").map((c) => String(c.body));

  const setup = () => {
    handlers = {};
    sent = [];
    fetchCalls = [];
    midTurnQueues.clear();
    pendingAttachments.clear();
    verboseOverride.clear();
    ctxWatchers.clear();
    lastRunUsage.value = null;
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
          },
        ],
      }),
    );
  };

  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", args, {
      cwd,
      env: process.env,
      encoding: "utf8",
    }).trim();

  const initRepo = (dir: string) => {
    git(dir, "init", "-b", "main");
    fs.writeFileSync(path.join(dir, "base.txt"), "base\n");
    git(dir, "add", "base.txt");
    git(dir, "commit", "-m", "base commit");
  };

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jarate-2c-"));
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
    oldGitEnv.GIT_AUTHOR_NAME = process.env.GIT_AUTHOR_NAME;
    oldGitEnv.GIT_AUTHOR_EMAIL = process.env.GIT_AUTHOR_EMAIL;
    oldGitEnv.GIT_COMMITTER_NAME = process.env.GIT_COMMITTER_NAME;
    oldGitEnv.GIT_COMMITTER_EMAIL = process.env.GIT_COMMITTER_EMAIL;
    process.env.GIT_AUTHOR_NAME = "t";
    process.env.GIT_AUTHOR_EMAIL = "t@t";
    process.env.GIT_COMMITTER_NAME = "t";
    process.env.GIT_COMMITTER_EMAIL = "t@t";
    process.env.PI_BG_WT_DIR = path.join(tmp, "wt");
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
    process.env.GIT_AUTHOR_NAME = oldGitEnv.GIT_AUTHOR_NAME;
    process.env.GIT_AUTHOR_EMAIL = oldGitEnv.GIT_AUTHOR_EMAIL;
    process.env.GIT_COMMITTER_NAME = oldGitEnv.GIT_COMMITTER_NAME;
    process.env.GIT_COMMITTER_EMAIL = oldGitEnv.GIT_COMMITTER_EMAIL;
    process.env.PI_BG_WT_DIR = oldWtDir;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test("matchCommand: new 2c commands parse", () => {
    expect(matchCommand("/new-worktree")?.name).toBe("new-worktree");
    expect(matchCommand("/new-worktree main")?.arg).toBe("main");
    expect(matchCommand("/merge-worktree")?.name).toBe("merge-worktree");
    expect(matchCommand("/merge-worktree --squash")?.arg).toBe("--squash");
    expect(matchCommand("/usage last")?.arg).toBe("last");
    expect(matchCommand("/jobs kill 20260914-091714-3097")?.arg).toBe(
      "kill 20260914-091714-3097",
    );
    expect(matchCommand("/jobs tail 20260914-091714-3097 --n 5")?.arg).toBe(
      "tail 20260914-091714-3097 --n 5",
    );
    expect(matchCommand("/jobs")).toEqual({ name: "jobs", arg: undefined }); // bare /jobs: view, no arg
  });

  test("runUsageLine: pricing matches pi-token-cost.py (#40)", () => {
    expect(
      runUsageLine({
        turns: 1,
        input: 215_000,
        output: 1_800,
        cacheRead: 2_600,
        cacheWrite: 0,
      }),
    ).toBe("│ ~219.4k tok · ~$0.096");
    expect(
      runUsageLine({
        turns: 0,
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
      }),
    ).toBeNull();
  });

  test("runFrame: trailing line sits before the closing bar, <= 32 cols", () => {
    const frame = runFrame(
      "done",
      ["bash bun test"],
      1,
      0,
      "│ ~219.4k tok · ~$0.096",
    );
    const lines = frame.split("\n");
    expect(lines[0]).toBe("┌ done · 1 call · 0s");
    expect(lines[1]).toBe("│ └ bash bun test");
    expect(lines[2]).toBe("│ ~219.4k tok · ~$0.096");
    expect(lines[3]).toBe("└");
    for (const l of lines) expect([...l].length).toBeLessThanOrEqual(32);
  });

  test("message_end posts the [ctx] boundary notice, once per 10% step (#13)", async () => {
    const ctxAt = (p: number) => ({
      ...ctx,
      getContextUsage: () => ({
        tokens: Math.round((p / 100) * 262144),
        contextWindow: 262144,
        percent: p,
      }),
    });
    const tc = {
      role: "assistant",
      content: [{ type: "toolCall", toolName: "read", arguments: {} }],
    } as any;
    await handleInbound(pi, inbound("hello", "m1"), ctxAt(38));
    await handlers.turn_start(null, ctxAt(38));
    // baseline: silent
    await handlers.message_end({ message: tc }, ctxAt(38));
    expect(posts().some((t) => t.includes("[ctx]"))).toBe(false);
    // crosses 40: one fenced notice
    await handlers.message_end({ message: tc }, ctxAt(41.2));
    let ctxPosts = posts().filter((t) => t.includes("[ctx]"));
    expect(ctxPosts).toHaveLength(1);
    expect(ctxPosts[0]).toContain("[ctx] 41% (108k/262k)");
    expect(ctxPosts[0].startsWith("```")).toBe(true);
    // same step: silent
    await handlers.message_end({ message: tc }, ctxAt(45));
    expect(posts().filter((t) => t.includes("[ctx]"))).toHaveLength(1);
    // /compact-style drop: silent; a new step above the baseline fires
    await handlers.message_end({ message: tc }, ctxAt(20));
    await handlers.message_end({ message: tc }, ctxAt(91));
    ctxPosts = posts().filter((t) => t.includes("[ctx]"));
    expect(ctxPosts).toHaveLength(2);
    expect(ctxPosts[1]).toContain("[ctx] 91% (239k/262k)");
  });

  test("ctxBoundaryNotice: no getContextUsage / null / bad shape are silent", () => {
    expect(ctxBoundaryNotice({} as any)).toBeNull();
    expect(
      ctxBoundaryNotice({
        getContextUsage: () => null,
      } as any),
    ).toBeNull();
    expect(
      ctxBoundaryNotice({
        getContextUsage: () => ({ percent: "x" }),
      } as any),
    ).toBeNull();
  });

  test("agent_end done frame carries the run usage line (#40)", async () => {
    verboseOverride.set("ch1", 1);
    await handleInbound(pi, inbound("hello", "m1"), ctx);
    await handlers.turn_start(null, ctx);
    await handlers.tool_call(
      { toolName: "bash", input: { command: "bun test" } },
      ctx,
    );
    const fin = {
      role: "assistant",
      content: [{ type: "text", text: "done" }],
      usage: { input: 215_000, output: 1_800, cacheRead: 2_600, cacheWrite: 0 },
    } as any;
    await handlers.agent_end({ messages: [fin] }, ctx);
    const patch = patches().find((p) => p.includes("┌ done"));
    expect(patch).toBeDefined();
    const lines = String(JSON.parse(patch!).content).split("\n");
    // fenced frame: ``` / lines / ``` with the trailing usage line
    // right before the closing bar
    expect(lines.at(-2)).toBe("└");
    expect(lines.at(-3)).toBe("│ ~219.4k tok · ~$0.096");
    for (const l of lines.slice(1, -1))
      expect([...l].length).toBeLessThanOrEqual(32);
  });

  test("/usage last: empty before any run, then the last run's line (#40)", async () => {
    await handleInbound(pi, inbound("/usage last", "m1"), ctx);
    expect(posts().some((t) => t.includes("[!] no completed run yet"))).toBe(
      true,
    );
    await handleInbound(pi, inbound("hello", "m2"), ctx);
    await handlers.turn_start(null, ctx);
    await handlers.agent_end(
      {
        messages: [
          {
            role: "assistant",
            content: [{ type: "text", text: "hi" }],
            usage: { input: 1_000, output: 100, cacheRead: 0, cacheWrite: 0 },
          },
        ],
      },
      ctx,
    );
    await handleInbound(pi, inbound("/usage last", "m3"), ctx);
    const last = posts().find((t) => t.includes("[usage] last run"));
    expect(last).toBeDefined();
    expect(last).toContain("| in 1K | out 100 |");
    expect(last).toContain("est $0.00");
    // unfenced, like the rest of the /usage family
    expect(last!.startsWith("```")).toBe(false);
  });

  test("/jobs kill + tail: owner-only wrappers around pi-bg-kill/-tail (#44)", async () => {
    const home = path.join(tmp, "home");
    const scripts = path.join(home, "scripts");
    fs.mkdirSync(scripts, { recursive: true });
    fs.writeFileSync(path.join(scripts, "pi-bg-kill"), "#!/bin/sh\nexit 0\n");
    fs.writeFileSync(
      path.join(scripts, "pi-bg-tail"),
      "#!/bin/sh\necho 'line one'\necho 'line two'\n",
    );
    fs.chmodSync(path.join(scripts, "pi-bg-kill"), 0o755);
    fs.chmodSync(path.join(scripts, "pi-bg-tail"), 0o755);
    const oldHome = process.env.HOME;
    process.env.HOME = home;
    try {
      // non-owner: falls through to pi as plain text
      await handleInbound(
        pi,
        otherInbound("/jobs kill 20260914-091714-3097", "m1"),
        ctx,
      );
      expect(sent).toHaveLength(1);
      expect(posts().some((t) => t.includes("killed"))).toBe(false);
      // owner kill
      await handleInbound(
        pi,
        inbound("/jobs kill 20260914-091714-3097", "m2"),
        ctx,
      );
      expect(
        posts().some((t) => t.includes("[ok] killed 20260914-091714-3097")),
      ).toBe(true);
      // owner tail: fenced output
      await handleInbound(
        pi,
        inbound("/jobs tail 20260914-091714-3097", "m3"),
        ctx,
      );
      const tailPost = posts().find((t) => t.includes("line one"));
      expect(tailPost).toBeDefined();
      expect(tailPost).toContain("line two");
      expect(tailPost!.startsWith("```")).toBe(true);
      // missing id -> usage line
      await handleInbound(pi, inbound("/jobs kill", "m4"), ctx);
      expect(
        posts().some((t) => t.includes("[!] usage: /jobs kill <id>")),
      ).toBe(true);
      await handleInbound(pi, inbound("/jobs tail", "m5"), ctx);
      expect(
        posts().some((t) => t.includes("[!] usage: /jobs tail <id> [--n N]")),
      ).toBe(true);
      // --n accepted; bad --n is a usage error
      await handleInbound(
        pi,
        inbound("/jobs tail 20260914-091714-3097 --n 5", "m6"),
        ctx,
      );
      expect(posts().filter((t) => t.includes("line one")).length).toBe(2);
      await handleInbound(
        pi,
        inbound("/jobs tail 20260914-091714-3097 --n x", "m7"),
        ctx,
      );
      expect(
        posts().filter((t) => t.includes("usage: /jobs tail")).length,
      ).toBe(2);
      // bare /jobs: view path unchanged
      await handleInbound(pi, inbound("/jobs", "m8"), ctx);
      expect(posts().some((t) => t.includes("[jobs]"))).toBe(true);
    } finally {
      process.env.HOME = oldHome;
    }
  });

  test("/new-worktree + /merge-worktree: owner-only full cycle (#12)", async () => {
    initRepo(tmp);
    // non-owner: falls through as plain text
    await handleInbound(pi, otherInbound("/new-worktree", "m1"), ctx);
    expect(sent).toHaveLength(1);
    expect(loadWorktreeStateFile()).toBeNull();
    // owner: creates the worktree
    await handleInbound(pi, inbound("/new-worktree", "m2"), ctx);
    const ok = posts().find((t) => t.includes("[ok] worktree "));
    expect(ok).toBeDefined();
    expect(ok!.startsWith("```")).toBe(true);
    expect(ok).toContain("branch pi-bg/");
    expect(ok).toContain(path.join(tmp, "wt"));
    const st = loadWorktreeStateFile();
    expect(st).not.toBeNull();
    expect(st!.branch).toMatch(/^pi-bg\/\d{8}-\d{6}-\d{4}$/);
    expect(st!.path).toBe(path.join(tmp, "wt", path.basename(tmp), st!.id));
    // a second /new-worktree while one is active: refused
    await handleInbound(pi, inbound("/new-worktree", "m3"), ctx);
    expect(posts().some((t) => t.includes("[!] worktree already active"))).toBe(
      true,
    );
    // work on the worktree, then merge
    fs.writeFileSync(path.join(st!.path, "feature.txt"), "x\n");
    git(st!.path, "add", "feature.txt");
    git(st!.path, "commit", "-m", "feat");
    await handleInbound(pi, inbound("/merge-worktree", "m4"), ctx);
    const merged = posts().find((t) => t.includes("[ok] merged "));
    expect(merged).toBeDefined();
    expect(merged).toContain("into main (merge)");
    expect(fs.existsSync(path.join(tmp, "feature.txt"))).toBe(true);
    expect(fs.existsSync(st!.path)).toBe(false);
    expect(git(tmp, "branch", "--list", st!.branch)).toBe("");
    expect(loadWorktreeStateFile()).toBeNull();
  });

  test("/new-worktree: non-git repo is a [!] line; /merge-worktree with no state", async () => {
    // no git repo in tmp
    await handleInbound(pi, inbound("/new-worktree", "m1"), ctx);
    expect(posts().some((t) => t.includes("[!] not a git repo"))).toBe(true);
    await handleInbound(pi, inbound("/merge-worktree", "m2"), ctx);
    expect(posts().some((t) => t.includes("[!] no active worktree"))).toBe(
      true,
    );
  });

  function loadWorktreeStateFile() {
    const p = path.join(tmp, ".tmp", "worktree.json");
    if (!fs.existsSync(p)) return null;
    try {
      return JSON.parse(fs.readFileSync(p, "utf8"));
    } catch {
      return null;
    }
  }
});
