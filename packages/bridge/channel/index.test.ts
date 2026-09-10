import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import extension, {
  buildInteractionHandler,
  buildRepliedMessageBlock,
  chunkText,
  clearAllInterrupts,
  collectFinals,
  deliverDueWakes,
  earlySendText,
  failurePostText,
  fileOnlyPrompt,
  handleInbound,
  interruptStepTimeoutMs,
  matchCommand,
  midTurnQueues,
  parseJobsFromPs,
  parseReplyTo,
  pendingAttachments,
  pendingInterrupts,
  prunePendingBatches,
  REPEAT_WARNING,
  registerSleepTool,
  registerTodoTool,
  runShellPassthrough,
  setInterruptCtx,
  TODO_TOOL_DESCRIPTION,
} from "./index";
import {
  CLAIM_TTL_MS,
  cancelWake,
  loadWakes,
  markClaimed,
  scheduleWake,
} from "./sleep";
import { loadBoard, renderBoard, saveBoard, type TodoBoard } from "./todos";
import { type ChannelMessage, loadChannelConfig } from "./types";
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

describe("parseJobsFromPs (/jobs)", () => {
  test("parses wrapper lines: age, profile, task", () => {
    const ps = [
      "00:42 /usr/bin/bash /home/monky/scripts/pi-bg worker Resume the jarate migration stuff",
      "01:05:03 /usr/bin/bash /home/monky/scripts/pi-bg reviewer Check PR #15 for regressions",
      "",
    ].join("\n");
    expect(parseJobsFromPs(ps)).toEqual([
      {
        age: "00:42",
        profile: "worker",
        task: "Resume the jarate migration stuff",
      },
      {
        age: "01:05:03",
        profile: "reviewer",
        task: "Check PR #15 for regressions",
      },
    ]);
  });

  test("ignores non-wrapper lines (pi child mentioning the script path)", () => {
    const ps = [
      "00:10 pi -p --no-extensions the task mentions ~/scripts/pi-bg inside its text",
      "00:01 /usr/bin/bash -c ls scripts",
      "",
    ].join("\n");
    expect(parseJobsFromPs(ps)).toEqual([]);
  });

  test("empty input is empty", () => {
    expect(parseJobsFromPs("")).toEqual([]);
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
        String(JSON.parse(c.body).content).includes("┗ done · 1 call"),
    );
    expect(doneEdit).toBeDefined(); // block stays, shows the finished run
    const deleted = fetchCalls.find(
      (c) => c.method === "DELETE" && c.url.includes("/messages/out1"),
    );
    expect(deleted).toBeUndefined();
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
      "-" + tmp + "-",
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
      lines.map((l) => JSON.stringify(l)).join("\n") + "\n",
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
    handlers.agent_end?.({ messages: [] }, ctx); // clears typing timer; flushes any pending compact
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
    expect(channelPosts().some((t) => t === "[..] compacting...")).toBe(true);
    opts.onComplete({
      summary: "s",
      firstKeptEntryId: "e",
      tokensBefore: 219997,
      estimatedTokensAfter: 35000,
    });
    await tick();
    expect(
      channelPosts().some((t) => t === "[ok] compacted: 219997 → 35000 tokens"),
    ).toBe(true);
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
    // run ends → flush
    await handlers.agent_end({ messages: [] }, ctx);
    expect(opts?.customInstructions).toBe("keep the jarate");
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
    expect(content).toContain("▤ todos · 2 open");
  });

  test("/todos with an empty board says 'no open todos'", async () => {
    await handleInbound(pi, inbound("/todos", "m1"), ctx);
    expect(replyContent()).toBe("no open todos");
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
    expect(replyContent()).toContain("⬦ x");
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
    expect(content).toContain("▤ Test · 1 open");
    expect(content).toContain("⬦ a");
    expect(content).toContain("▤ ch2 · 0 open");
    expect(content).toContain("✓ ~~b~~");
  });

  test("/todos all with no boards says 'no open todos'", async () => {
    await handleInbound(pi, inbound("/todos all", "m1"), ctx);
    expect(replyContent()).toBe("no open todos");
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
    expect(content).toContain("<todo-board>\n⬥ **fix bug**\n</todo-board>");
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
    expect(JSON.parse(posts[0].body).content).toContain("▤ todos · 2 open");

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
    expect(r2.content[0].text).toContain("✓ ~~a~~");
    posts = fetchCalls.filter(
      (c) => c.method === "POST" && c.url.endsWith("/channels/ch1/messages"),
    );
    expect(posts.length).toBe(1);
    const patch = fetchCalls.find(
      (c) =>
        c.method === "PATCH" && c.url.endsWith("/channels/ch1/messages/out1"),
    );
    expect(patch).toBeDefined();
    expect(JSON.parse(patch!.body).content).toContain("✓ ~~a~~");
    expect(JSON.parse(patch!.body).content).toContain("▤ todos · 1 open");

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
    expect(r.content[0].text).toContain("✓ ~~a~~");
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
      "[bg: worker OK · r1]\n\n<embed>\nAuthor: pi-bg ticket · r1\nTitle: ✓ worker\nresult: done\nTODO: follow up on X\nTODO: verify the deploy\n</embed>";
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
    expect(JSON.parse(patch!.body).content).toContain("⬦ follow up on X");
    expect(JSON.parse(patch!.body).content).toContain("⬥ **alpha**");
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
    expect(replyContent()).toBe("no pending wakes");
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
    expect(replyContent()).toBe("usage: `/sleep cancel <id>`");
    await handleInbound(pi, inbound("/sleep xyz", "m3"), ctx);
    expect(replyContent()).toBe("usage: `/sleep [list | cancel <id>]`");
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
    const r = await tools["sleep"].execute(
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
    await tools["sleep"].execute(
      "1",
      { until: "2026-09-10T15:00:00Z" },
      undefined,
      undefined,
      ctx,
    );
    expect(loadWakes(tmp)[0].wakeAt).toBe(Date.parse("2026-09-10T15:00:00Z"));
  });

  test("sleep tool: bad params -> error, nothing scheduled", async () => {
    for (const params of [
      {},
      { minutes: 5, until: "2026-09-10T15:00:00Z" },
      { until: "yesterday" },
      { minutes: -1 },
      { until: "2036-01-01T00:00:00Z" },
    ]) {
      const r = await tools["sleep"].execute(
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
