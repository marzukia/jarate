import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import extension, {
  buildInteractionHandler,
  buildRepliedMessageBlock,
  chunkText,
  collectFinals,
  earlySendText,
  failurePostText,
  fileOnlyPrompt,
  handleInbound,
  matchCommand,
  parseJobsFromPs,
  parseReplyTo,
  pendingAttachments,
  prunePendingBatches,
  REPEAT_WARNING,
  runShellPassthrough,
} from "./index";
import type { ChannelMessage } from "./types";

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
    expect(failurePostText([failure("error", "boom")], false)).toBe("⚠️ boom");
  });

  test("error without errorMessage posts a fallback", () => {
    expect(failurePostText([failure("error")], false)).toBe("⚠️ run failed");
  });

  test("aborted with errorMessage posts when the run was not user-stopped", () => {
    expect(failurePostText([failure("aborted", "interrupted")], false)).toBe(
      "⚠️ interrupted",
    );
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
    fetchCalls = [];
    pi = {
      registerMessageRenderer: () => {},
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

  afterEach(() => {
    jest.useRealTimers();
    handlers.agent_end?.({ messages: [] }, ctx); // clears any typing interval
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
    const body = JSON.parse(post?.body);
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
    const body = JSON.parse(post?.body);
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
    const body = JSON.parse(post?.body);
    expect(body.message_reference?.message_id).toBe("111");
  });

  test("A2: agent_end posts ⚠️ + errorMessage on a failed run", async () => {
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
    expect(JSON.parse(post?.body).content).toBe("⚠️ boom");
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
        String(JSON.parse(c.body).content).startsWith("⚠️"),
    );
    expect(errors.length).toBe(0);
  });

  test("A4: /stop drops the channel's buffered burst parts", async () => {
    jest.useFakeTimers();
    ctx.isIdle = () => false; // inbounds while a run is active get buffered
    await handleInbound(pi, inbound("followup", "m1"), ctx);
    expect(sent.length).toBe(0); // buffered, not sent yet

    await handleInbound(pi, inbound("/stop", "m2"), ctx);
    jest.advanceTimersByTime(4000); // past the 2500ms burst window
    expect(sent.length).toBe(0); // without the fix the timer would fire sendToPi
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
    expect(JSON.parse(edit?.body).content).toContain("boom");
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
    expect(JSON.parse(modelEdit?.body).content).toContain(
      "hydrogen/qwen3.8-27b",
    );

    await h(
      d("compact", {
        options: [{ name: "instructions", value: "focus on X" }],
      }),
    );
    expect(compacted).toEqual({ customInstructions: "focus on X" });
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
    const content = JSON.parse(edit?.body).content;
    expect(content).toContain("p/m1");
    expect(content).toContain("p/m2");
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
