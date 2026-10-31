/**
 * channel/commands.test.ts — god-file split 1/5 (2026-10-19).
 *
 * Moved verbatim from index.test.ts: command-surface tests (matchCommand,
 * owner checks, ! shell passthrough, error text, #39 /hold, the
 * INTERACTIONS_CREATE handler, /compact, /diff, wave 2c dispatch).
 */

import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  buildInteractionHandler,
  channelError,
  failurePostText,
  hasOwnerConfigured,
  isOwnerUser,
  matchCommand,
  runShellPassthrough,
} from "./commands";
import { clearDiscordStatesForTest } from "./discord";
import extension, {
  clearAllCompacting,
  clearAllInterrupts,
  handleInbound,
  heldChannels,
  isHeld,
  lastRunUsage,
  pendingAttachments,
  pendingInterrupts,
  resetRuntimeStateForTest,
  runFrame,
  runUsageLine,
  setInterruptCtx,
  setRuntimeStateDir,
  verboseOverride,
} from "./index";
import { machine, stopAllCompactTicks } from "./live";
import {
  clearQueuedInbound,
  midTurnQueues,
  popChannelQueuedInbound,
  queuedAcks,
} from "./queue";
import { type ChannelMessage, loadChannelConfig } from "./types";
import { clearWorktreeState } from "./worktree";

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
const interactionUrlViolation = (
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
    expect(matchCommand("/model vllm/qwen3.8-27b")).toEqual({
      name: "model",
      arg: "vllm/qwen3.8-27b",
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
    expect(failurePostText([failure("error", "boom")], false)).toBe("boom");
  });

  test("error without errorMessage posts a fallback", () => {
    expect(failurePostText([failure("error")], false)).toBe("run failed");
  });

  test("aborted with errorMessage posts when the run was not user-stopped", () => {
    expect(failurePostText([failure("aborted", "interrupted")], false)).toBe(
      "interrupted",
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
    ).toBe("boom line1");
  });

  test("run-level timeout posts the short marker", () => {
    expect(
      failurePostText(
        [failure("error", "request timed out after 30000ms")],
        false,
      ),
    ).toBe("timed out");
  });

  test("run-level rate limit posts the short marker", () => {
    expect(
      failurePostText([failure("error", "429 Too Many Requests")], false),
    ).toBe("rate limited, retrying");
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

describe("#39 /hold", () => {
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
    verboseOverride.set("ch1", 1); // verbose 1: the [queued] ack posts
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
    // text-form command from a non-owner: not executed, and refused
    // explicitly. A recognised command must never fall through to pi as
    // plain text — the agent then answers the command as a prompt, which
    // reads as "the bridge is ignoring my commands" (2026-09-23).
    expect(isHeld(loadChannelConfig(ctx.cwd)[0]!)).toBe(false);
    expect(posts().some((t) => t.includes("[!] owner only"))).toBe(true);
    expect(sent).toHaveLength(0);
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

describe("buildInteractionHandler (defer-first ack)", () => {
  const realFetch = globalThis.fetch;
  const ch: any = {
    id: "ich",
    name: "IntTest",
    type: "discord",
    botToken: "tok-i",
    channel: "888",
    ownerUserId: "owner1",
  };
  let pi: any;
  let ctx: any;
  let calls: { url: string; method: string; body?: any }[];
  let urlViolations: string[];

  const d = (name: string, extra: Record<string, any> = {}) => ({
    id: "i1",
    token: "tok123",
    application_id: "app1",
    channel_id: "888",
    // Live guild shape (capture 2026-10-08): the actor lives at
    // member.user; guild INTERACTION_CREATE payloads carry NO top-level
    // user. The top-level-only DM/older shape is kept by exactly one test
    // in this file (see the #206 block, "status (owner)").
    member: { user: { id: "owner1", username: "OwnerOne" } },
    data: { name, options: extra.options },
    ...extra,
  });

  beforeEach(() => {
    calls = [];
    urlViolations = [];
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
      // F2: pin the interaction URL contract — record every call that is
      // not one of the allowed (method, route) pairs; asserted clean at
      // test end (afterEach).
      const v = interactionUrlViolation(String(url), init?.method ?? "GET");
      if (v) urlViolations.push(v);
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
    // F2: no interaction call may land outside the allowed routes.
    expect(urlViolations).toEqual([]);
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
    expect(JSON.parse(calls[1].body).content).toContain("Commands");
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

  test("command path with a missing name fails readable, not TypeError", async () => {
    const h = buildInteractionHandler(pi, ctx, ch, "tok-i");
    await h({
      id: "i4",
      token: "t",
      application_id: "app1",
      channel_id: "888",
      member: { user: { id: "owner1", username: "OwnerOne" } },
      type: 2,
      data: {},
    }); // must not throw
    const edit = calls.find((c) =>
      c.url.endsWith("/webhooks/app1/t/messages/@original"),
    );
    expect(edit).toBeDefined();
    expect(JSON.parse(edit!.body).content).toContain("unknown command");
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
        { id: "qwen3.8-27b", name: "Qwen", provider: "vllm" },
        { id: "other-123", name: "Other", provider: "vllm" },
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
    expect(JSON.parse(modelEdit!.body).content).toContain("vllm/qwen3.8-27b");

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

  test("owner-only command from a non-owner is refused on the interaction path (#169)", async () => {
    const h = buildInteractionHandler(pi, ctx, ch, "tok-i");
    // live guild shape: the non-owner actor is at member.user
    await h(
      d("status", {
        member: { user: { id: "not-owner", username: "NotOwner" } },
      }),
    );
    // defer first, then the refusal edits the deferred message
    expect(JSON.parse(calls[0].body).type).toBe(5);
    const edit = calls.find((c) => c.url.endsWith("/messages/@original"));
    expect(edit).toBeDefined();
    const content = JSON.parse(edit!.body).content;
    expect(content).toContain("[!] owner only");
    expect(content).not.toContain("ctx "); // no session state leaked
  });

  test("no owner configured: the interaction refusal names the misconfiguration (#169)", async () => {
    const chNoOwner = { ...ch, ownerUserId: undefined };
    const h = buildInteractionHandler(pi, ctx, chNoOwner, "tok-i");
    // live guild shape: actor at member.user (uid "u1", not the owner)
    await h(
      d("status", { member: { user: { id: "u1", username: "Someone" } } }),
    );
    const edit = calls.find((c) => c.url.endsWith("/messages/@original"));
    expect(JSON.parse(edit!.body).content).toContain("no owner configured");
  });

  test("raw command lines pass the same machine sweep as text replies (#169)", async () => {
    // /usage last with no completed run returns a bare line (no fence, no tag
    // in the command) — the interaction edit carries exactly what the
    // sweep produces: v4 (operator 2026-10-19) tag lines are prose, so
    // it ships unfenced, same as the text path.
    const raw = "no completed run yet (run one first)";
    const saved = (lastRunUsage as { value: any }).value;
    (lastRunUsage as { value: any }).value = null;
    try {
      const h = buildInteractionHandler(pi, ctx, ch, "tok-i");
      await h(d("usage", { options: [{ name: "scope", value: "last" }] }));
      const edit = calls.find((c) => c.url.endsWith("/messages/@original"));
      const content = JSON.parse(edit!.body).content;
      expect(content).toBe(machine(raw));
      expect(content.startsWith("*")).toBe(true);
    } finally {
      (lastRunUsage as { value: any }).value = saved;
    }
  });
});

describe("buildInteractionHandler: registered slash commands route to their dispatch case", () => {
  const realFetch = globalThis.fetch;
  const ch: any = {
    id: "ich-r",
    name: "IntRoute",
    type: "discord",
    botToken: "tok-r",
    channel: "777",
    ownerUserId: "owner1",
  };
  let pi: any;
  let ctx: any;
  let calls: { url: string; method: string; body?: any }[];

  const d = (name: string, extra: Record<string, any> = {}) => ({
    id: "ir1",
    token: "tokr123",
    application_id: "appr",
    channel_id: "777",
    user: { id: "owner1" },
    data: { name, options: extra.options ?? [] },
    ...extra,
  });

  function deferredTexts(): string[] {
    return calls
      .filter(
        (c) =>
          c.method === "PATCH" &&
          c.url.includes("/webhooks/appr/tokr123/messages/@original"),
      )
      .map((c) => String(JSON.parse(c.body as string).content ?? ""));
  }

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
    clearDiscordStatesForTest();
    globalThis.fetch = realFetch;
  });

  test("/usage last: scope choice reaches renderUsage via the usage case", async () => {
    const saved = (lastRunUsage as { value: any }).value;
    (lastRunUsage as { value: any }).value = {
      stats: {
        turns: 3,
        input: 100,
        output: 50,
        cacheRead: 80,
        cacheWrite: 5,
      },
      at: new Date("2026-10-09T00:00:00Z"),
    };
    try {
      const h = buildInteractionHandler(pi, ctx, ch, "tok-r");
      await h(
        d("usage", {
          options: [{ type: 3, name: "scope", value: "last" }],
        }) as any,
      );
      expect(deferredTexts().at(-1)).toContain("usage · last run");
    } finally {
      (lastRunUsage as { value: any }).value = saved;
    }
  });

  test("/context: count option passes the allowlist into renderContext", async () => {
    const h = buildInteractionHandler(pi, ctx, ch, "tok-r");
    await h(
      d("context", {
        options: [{ type: 3, name: "count", value: "12x" }],
      }) as any,
    );
    expect(deferredTexts().at(-1)).toContain("[!] usage: /context [1-40]");
  });

  test("/diff: source option passes the allowlist into publishDiff", async () => {
    const h = buildInteractionHandler(pi, ctx, ch, "tok-r");
    await h(
      d("diff", {
        options: [{ type: 3, name: "source", value: "two words" }],
      }) as any,
    );
    // assert a substring of the usage line (only resolveDiffSource's null
    // path emits it); fence bodies ship verbatim - no 40-col wrap.
    expect(deferredTexts().at(-1)).toContain("usage: /diff [git-range");
  });

  test("/hold: mode option passes the allowlist into the hold case", async () => {
    const h = buildInteractionHandler(pi, ctx, ch, "tok-r");
    await h(
      d("hold", {
        options: [{ type: 3, name: "mode", value: "bogus" }],
      }) as any,
    );
    expect(deferredTexts().at(-1)).toContain("[!] usage: /hold on|off");
  });

  test("/tasks: action option passes the allowlist into the tasks case", async () => {
    const h = buildInteractionHandler(pi, ctx, ch, "tok-r");
    await h(
      d("tasks", {
        options: [{ type: 3, name: "action", value: "cancel" }],
      }) as any,
    );
    expect(deferredTexts().at(-1)).toContain("[!] usage: /tasks cancel <id>");
  });

  test("/new-worktree: ref option passes the allowlist into newWorktree", async () => {
    // Real scratch repo (worktree.test.ts pattern): in a plain tmp dir
    // newWorktree bails with "not a git repo" BEFORE the ref is read, so
    // the allowlist entry was never discriminated by this test.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ich-wt-"));
    const repo = path.join(tmp, "live");
    fs.mkdirSync(repo, { recursive: true });
    const git = (...args: string[]) =>
      execFileSync("git", args, {
        cwd: repo,
        encoding: "utf8",
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: "t",
          GIT_AUTHOR_EMAIL: "t@t",
          GIT_COMMITTER_NAME: "t",
          GIT_COMMITTER_EMAIL: "t@t",
        },
      });
    git("init", "-b", "main");
    fs.writeFileSync(path.join(repo, "base.txt"), "base\n");
    git("add", "base.txt");
    git("commit", "-m", "base commit");
    const oldWtDir = process.env.PI_BG_WT_DIR;
    process.env.PI_BG_WT_DIR = path.join(tmp, "wt");
    ctx.cwd = repo;
    try {
      const h = buildInteractionHandler(pi, ctx, ch, "tok-r");
      // Existing ref: honored end-to-end. Dropping "ref" from the
      // allowlist makes it "from HEAD" -> this line fails.
      await h(
        d("new-worktree", {
          options: [{ type: 3, name: "ref", value: "main" }],
        }) as any,
      );
      const ok = unwarped(deferredTexts().at(-1) ?? "");
      expect(ok).toContain("[ok] worktree ");
      expect(ok).toContain("from main");
      // Ref-specific failure: a ref that does not exist in the repo makes
      // `git worktree add` fail - only reachable when the ref string
      // actually reached newWorktree through the allowlist.
      clearWorktreeState(repo);
      await h(
        d("new-worktree", {
          options: [{ type: 3, name: "ref", value: "nosuchref" }],
        }) as any,
      );
      const bad = unwarped(deferredTexts().at(-1) ?? "");
      expect(bad).toContain("[!] worktree add failed");
      expect(bad.replace(/ /g, "")).toContain("nosuchref");
    } finally {
      if (oldWtDir === undefined) delete process.env.PI_BG_WT_DIR;
      else process.env.PI_BG_WT_DIR = oldWtDir;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("/merge-worktree: routes to the worktree case (no active state)", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ich-mw-"));
    ctx.cwd = tmp;
    try {
      const h = buildInteractionHandler(pi, ctx, ch, "tok-r");
      await h(
        d("merge-worktree", {
          options: [{ type: 3, name: "mode", value: "squash" }],
        }) as any,
      );
      expect(deferredTexts().at(-1)).toContain("[!] no active worktree");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("/handover: instructions option reaches startCompact via the handover case", async () => {
    let compacted: any = null;
    ctx.compact = (o?: any) => {
      compacted = o;
    };
    const h = buildInteractionHandler(pi, ctx, ch, "tok-r");
    await h(
      d("handover", {
        options: [{ type: 3, name: "instructions", value: "focus on X" }],
      }) as any,
    );
    expect(compacted?.customInstructions).toBe("focus on X");
    expect(deferredTexts().at(-1)).toContain("compacting...");
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
            ownerUserId: "uid",
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
    expect(channelPosts().some((t) => t.includes("*[..] compacting..."))).toBe(
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
    const reportText = machine("compacted: 220k -> 35k");
    const edits = fetchCalls.filter(
      (c) => c.method === "PATCH" && c.url.includes("/messages/"),
    );
    // Settle ships the bare line — op status is prose, no fence (v4 §2.3).
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
    expect(channelPosts().some((t) => t.includes("*[..] compacting..."))).toBe(
      true,
    );

    // No edit before the first 5s tick
    jest.advanceTimersByTime(4999);
    expect(edits().length).toBe(0);
    jest.advanceTimersByTime(1);
    expect(edits()).toEqual(["*[..] compacting… 5s*"]);
    // subsequent ticks keep updating the SAME message in place
    jest.advanceTimersByTime(5000);
    expect(edits()).toEqual([
      "*[..] compacting… 5s*",
      "*[..] compacting… 10s*",
    ]);
    jest.advanceTimersByTime(5000);
    expect(edits()).toEqual([
      "*[..] compacting… 5s*",
      "*[..] compacting… 10s*",
      "*[..] compacting… 15s*",
    ]);

    // Settle: the report replaces the placeholder in place, tick stops.
    // Bare line, same form as the fresh-post fallback (v4 §2.3).
    opts.onComplete({ tokensBefore: 100, estimatedTokensAfter: 10 });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(edits().at(-1)).toBe(machine("compacted: 100 -> 10"));
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
    expect(channelPosts().some((t) => t.includes("*[..] compacting..."))).toBe(
      true,
    );
    opts.onError(new Error("model down"));
    await tick();
    const failText = machine("compact failed: model down");
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

  test("v4: compact op posts placeholder + ticks + settle BARE (no fence)", async () => {
    jest.useFakeTimers();
    let opts: any = null;
    ctx.compact = (o?: any) => {
      opts = o;
    };
    await handleInbound(pi, inbound("/compact", "m1"), ctx);
    // settle the fire-and-forget placeholder post (microtasks, no timers)
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    const edits = () =>
      fetchCalls
        .filter((c) => c.method === "PATCH" && c.url.includes("/messages/"))
        .map(
          (c) =>
            (typeof c.body === "string" ? JSON.parse(c.body) : c.body).content,
        );
    // the placeholder POST is the bare one-liner — status is prose (§2.3)
    expect(channelPosts()).toContain("*[..] compacting...*");
    // the 5s tick edits the SAME message in place, bare
    jest.advanceTimersByTime(5000);
    expect(edits()).toEqual(["*[..] compacting… 5s*"]);
    // the settle replaces it in place, bare — the fresh-post fallback form
    opts.onComplete({ tokensBefore: 220000, estimatedTokensAfter: 35000 });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(edits().at(-1)).toBe(machine("compacted: 220k -> 35k"));
    jest.advanceTimersByTime(60000);
    // nothing in the whole op window (posts + in-place edits) carries a fence
    for (const t of [...channelPosts(), ...edits()])
      expect(t).not.toContain("```");
  });

  test("v4: settle before the placeholder post lands -> fresh post is BARE, same text as the tick settle", async () => {
    // Hold the placeholder POST open so onComplete runs before the tick is
    // armed — the settle must fall back to a fresh post that carries the
    // SAME bare line the tick settle would have posted (the old race shipped
    // fenced via tick, bare via fallback).
    const baseFetch = globalThis.fetch as any;
    let plainPosts = 0;
    const release: { fn?: () => void } = {};
    globalThis.fetch = (async (url: any, init?: any) => {
      const u = String(url);
      if (init?.method === "POST" && u.endsWith("/channels/ch1/messages")) {
        plainPosts += 1;
        if (plainPosts === 1) await new Promise<void>((r) => (release.fn = r));
      }
      return baseFetch(url, init);
    }) as any;
    let opts: any = null;
    ctx.compact = (o?: any) => {
      opts = o;
    };
    await handleInbound(pi, inbound("/compact", "m1"), ctx);
    // POST still in flight -> tick not armed. Settle now.
    const settleText = machine("compacted: 220k -> 35k");
    opts.onComplete({ tokensBefore: 220000, estimatedTokensAfter: 35000 });
    await tick();
    // the fallback fresh post is bare and identical to the tick-settle form
    expect(channelPosts().filter((t) => t === settleText)).toEqual([
      settleText,
    ]);
    expect(settleText).not.toContain("```");
    // release the placeholder: it lands bare; the tick then arms onto an
    // already-closed window and renders null (no edit, no double post)
    release.fn?.();
    await tick();
    await tick();
    expect(channelPosts().filter((t) => t === "*[..] compacting...*")).toEqual([
      "*[..] compacting...*",
    ]);
    const editContents = fetchCalls
      .filter((c) => c.method === "PATCH")
      .map(
        (c) =>
          (typeof c.body === "string" ? JSON.parse(c.body) : c.body).content,
      );
    for (const t of editContents) expect(t).not.toContain("```");
    expect(channelPosts().filter((t) => t === settleText)).toHaveLength(1);
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
          t ===
          machine("compact failed: Nothing to compact (session too small)"),
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
      channelPosts().some((t) => t.includes("compact failed: boom-ctx")),
    ).toBe(true);
    expect(channelPosts().some((t) => t.includes("*[..] compacting..."))).toBe(
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
    expect(channelPosts().some((t) => t.includes("*[..] compacting..."))).toBe(
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
        unwarped(t).includes(
          "[queued] compact (run in progress), replaces earlier",
        ),
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
        unwarped(t).includes("[queued] compact (compact already in progress)"),
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
    // #87: the viewer URL ships bare after the status line (clickable),
    // the status line is a short italic machine line (2026-10-31)
    expect(unwarped(replyContent())).toBe(
      `${machine("[ok] working tree · 1 file +1 -1 · ttl 7d")}\nhttps://drop.test/feedd00d.html`,
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
    // #87: bare URL after the status line, same split as the worktree
    // path (status is now a short italic machine line, 2026-10-31)
    expect(replyContent()).toBe(
      `${machine("[ok] pasted diff · 1 file +1 -1 · ttl 7d")}\nhttps://drop.test/feedd00d.html`,
    );
  });

  test("/diff with unresolvable arg replies usage", async () => {
    await handleInbound(pi, inbound("/diff hello\nworld", "dm3"), ctx);
    expect(unwarped(replyContent())).toBe(
      machine(
        "[!] usage: /diff [git-range | file | diff-paste] (default: working tree)",
      ),
    );
  });

  test("/diff without webdrop config reports the gap", async () => {
    fs.rmSync(path.join(tmp, ".config"), { recursive: true, force: true });
    await handleInbound(pi, inbound("/diff", "dm4"), ctx);
    expect(unwarped(replyContent())).toBe(
      machine(
        "[!] webdrop not configured (need WEBDROP_SERVER + WEBDROP_TOKEN or ~/.config/webdrop/config.toml)",
      ),
    );
  });
});

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

  const OWNER = "1000000000000000001";
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

  test("runFrame: trailing line sits before the closing bar, <= 40 cols", () => {
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
    for (const l of lines) expect([...l].length).toBeLessThanOrEqual(40);
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
    const lines = String(JSON.parse(patch!).content).trimEnd().split("\n");
    // fence-less frame: box lines with the trailing usage line right
    // before the closing bar (2026-10-31: no code fence)
    expect(lines.at(-1)).toBe("└");
    expect(lines.at(-2)).toBe("│ ~219.4k tok · ~$0.096");
    for (const l of lines.slice(1, -1))
      expect([...l].length).toBeLessThanOrEqual(32);
  });

  test("/usage last: empty before any run, then the last run's line (#40)", async () => {
    await handleInbound(pi, inbound("/usage last", "m1"), ctx);
    expect(posts().some((t) => t.includes("no completed run yet"))).toBe(true);
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
    const last = posts().find((t) => t.includes("usage · last run"));
    expect(last).toBeDefined();
    expect(last).toContain("- in: 1K");
    expect(last).toContain("- out: 100");
    expect(last).toContain("- est: $0.00");
    // markdown list, unfenced (Andryo 2026-10-18): summaries are normal
    // Discord markdown, no code fence, no width budget
    expect(last!.startsWith("```")).toBe(false);
  });

  test("/jobs: history-only view (drain declared, #279)", async () => {
    const home = path.join(tmp, "home");
    const art = path.join(home, ".pi-bg-art");
    fs.mkdirSync(art, { recursive: true });
    // fresh mtime: the fixture entry is the NEWEST and renders first
    fs.writeFileSync(
      path.join(art, "pi-bg-20260914-091714-3097-out.md"),
      "result\n",
    );
    const oldHome = process.env.HOME;
    const oldTmpDir = process.env.PI_BG_TMPDIR;
    process.env.HOME = home;
    process.env.PI_BG_TMPDIR = art; // jobTmpDir() reads the env var live
    try {
      // history is informational: open to any channel member
      await handleInbound(pi, otherInbound("/jobs", "m1"), ctx);
      const post = posts().find((t) => t.includes("20260914-091714-3097"));
      expect(post).toBeDefined();
      expect(post).toContain("- done ");
      // markdown list, unfenced (Andryo 2026-10-18)
      expect(post!.startsWith("```")).toBe(false);
      // json = machine output: plain text, no fence (2026-10-31)
      await handleInbound(pi, inbound("/jobs json", "m2"), ctx);
      const jsonPost = posts().find((t) => t.includes('"history"'));
      expect(jsonPost).toBeDefined();
      expect(jsonPost!.startsWith("```")).toBe(false);
      // kill/tail died with the completion side: no wrapper output, the
      // arg is just ignored and the view renders
      await handleInbound(
        pi,
        inbound("/jobs kill 20260914-091714-3097", "m3"),
        ctx,
      );
      expect(posts().some((t) => t.includes("[ok] killed"))).toBe(false);
    } finally {
      process.env.HOME = oldHome;
      if (oldTmpDir === undefined) delete process.env.PI_BG_TMPDIR;
      else process.env.PI_BG_TMPDIR = oldTmpDir;
    }
  });

  test("/new-worktree + /merge-worktree: owner-only full cycle (#12)", async () => {
    initRepo(tmp);
    // non-owner: refused, never handed to pi as plain text
    await handleInbound(pi, otherInbound("/new-worktree", "m1"), ctx);
    expect(sent).toHaveLength(0);
    expect(loadWorktreeStateFile()).toBeNull();
    // owner: creates the worktree
    await handleInbound(pi, inbound("/new-worktree", "m2"), ctx);
    const ok = posts().find((t) => unwarped(t).includes("[ok] worktree "));
    expect(ok).toBeDefined();
    expect(ok!.startsWith("*")).toBe(true); // italic machine line (2026-10-31)
    expect(unwarped(ok!)).toContain("branch pi-bg/");
    expect(unwarped(ok!).replace(/ /g, "")).toContain(path.join(tmp, "wt"));
    const st = loadWorktreeStateFile();
    expect(st).not.toBeNull();
    expect(st!.branch).toMatch(/^pi-bg\/\d{8}-\d{6}-\d{4}$/);
    expect(st!.path).toBe(path.join(tmp, "wt", path.basename(tmp), st!.id));
    // a second /new-worktree while one is active: refused
    await handleInbound(pi, inbound("/new-worktree", "m3"), ctx);
    expect(
      posts().some((t) => unwarped(t).includes("[!] worktree already active")),
    ).toBe(true);
    // work on the worktree, then merge
    fs.writeFileSync(path.join(st!.path, "feature.txt"), "x\n");
    git(st!.path, "add", "feature.txt");
    git(st!.path, "commit", "-m", "feat");
    await handleInbound(pi, inbound("/merge-worktree", "m4"), ctx);
    const merged = posts().find((t) => unwarped(t).includes("[ok] merged "));
    expect(merged).toBeDefined();
    expect(unwarped(merged!)).toContain("into main (merge)");
    expect(fs.existsSync(path.join(tmp, "feature.txt"))).toBe(true);
    expect(fs.existsSync(st!.path)).toBe(false);
    expect(git(tmp, "branch", "--list", st!.branch)).toBe("");
    expect(loadWorktreeStateFile()).toBeNull();
  });

  test("/new-worktree: non-git repo is a [!] line; /merge-worktree with no state", async () => {
    // no git repo in tmp
    await handleInbound(pi, inbound("/new-worktree", "m1"), ctx);
    expect(
      posts().some((t) => unwarped(t).includes("[!] not a git repo")),
    ).toBe(true);
    await handleInbound(pi, inbound("/merge-worktree", "m2"), ctx);
    expect(
      posts().some((t) => unwarped(t).includes("[!] no active worktree")),
    ).toBe(true);
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

  describe("owner config: ownerUserIds list + no-owner detection", () => {
    test("ownerUserIds admits any listed user; legacy ownerUserId still works", () => {
      expect(isOwnerUser({ ownerUserIds: ["a", "b"] }, "b")).toBe(true);
      expect(isOwnerUser({ ownerUserIds: ["a"] }, "c")).toBe(false);
      // legacy single field keeps working (existing configs unaffected)
      expect(isOwnerUser({ ownerUserId: "uid" }, "uid")).toBe(true);
      expect(isOwnerUser({ ownerUserId: "uid" }, "other")).toBe(false);
      // both fields together: either matches
      expect(
        isOwnerUser({ ownerUserId: "uid", ownerUserIds: ["a"] }, "a"),
      ).toBe(true);
      // no owner configured (or no sender) admits nobody
      expect(isOwnerUser({}, "anyone")).toBe(false);
      expect(isOwnerUser({ ownerUserId: "uid" }, undefined)).toBe(false);
    });

    test("hasOwnerConfigured distinguishes absent from empty", () => {
      expect(hasOwnerConfigured({})).toBe(false);
      expect(hasOwnerConfigured({ ownerUserIds: [] })).toBe(false);
      expect(hasOwnerConfigured({ ownerUserIds: ["a"] })).toBe(true);
      expect(hasOwnerConfigured({ ownerUserId: "uid" })).toBe(true);
    });
  });
});
