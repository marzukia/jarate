import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { clearDiscordStatesForTest } from "./discord";
import extension, {
  deliverDueTasks,
  deliverDueWakes,
  handleInbound,
} from "./index";
import { fence } from "./live";
import { CLAIM_TTL_MS, loadWakes, markClaimed, scheduleWake } from "./sleep";
import { loadTasks, markTaskClaimed, scheduleTask } from "./tasks";
import { loadBoard, renderBoard, saveBoard } from "./todos";
import {
  registerSleepTool,
  registerTaskTool,
  registerTodoTool,
  TODO_TOOL_DESCRIPTION,
} from "./tools";
import { type ChannelMessage, loadChannelConfig } from "./types";

const unwarped = (s: string) => s.replace(/\n +/g, " ");

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
            ownerUserId: "uid",
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
      renderBoard([
        { content: "fix bug", status: "in_progress" },
        { content: "tests", status: "pending" },
      ]),
    );
    expect(content).toContain("**todos · 2 open**");
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
    expect(replyContent()).toContain("- x");
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
    expect(content).toContain("**Test · 1 open**");
    expect(content).toContain("- a");
    expect(content).toContain("**ch2 · 0 open**");
    expect(content).toContain("- ~~b~~");
    // each board = bold header line, blank line, bullet list
    const blocks = content.split("\n\n");
    expect(blocks.length).toBe(4);
    expect(blocks[0].startsWith("**")).toBe(true);
    expect(blocks[2].startsWith("**")).toBe(true);
    expect(blocks[1].startsWith("- ")).toBe(true);
    expect(blocks[3].startsWith("- ")).toBe(true);
  });

  test("/todos all with no boards says 'no open todos'", async () => {
    await handleInbound(pi, inbound("/todos all", "m1"), ctx);
    expect(replyContent()).toBe(fence("[todos] no open todos"));
  });

  test("/todos all ships the full channel name - no 40-col clip (2026-10-18)", async () => {
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
      .find((l) => l.startsWith("**"))!;
    // no width budget: the full channel name ships, however long
    expect(header).toBe(`**${longName} · 1 open**`);
    expect(header.length).toBeGreaterThan(40);
    expect(header).not.toContain("…");
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
    expect(content).toContain("<todo-board>\n- **fix bug**\n</todo-board>");
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
    expect(JSON.parse(posts[0].body).content).toContain("**todos · 2 open**");

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
    expect(r2.content[0].text).toContain("- ~~a~~");
    posts = fetchCalls.filter(
      (c) => c.method === "POST" && c.url.endsWith("/channels/ch1/messages"),
    );
    expect(posts.length).toBe(1);
    const patch = fetchCalls.find(
      (c) =>
        c.method === "PATCH" && c.url.endsWith("/channels/ch1/messages/out1"),
    );
    expect(patch).toBeDefined();
    expect(JSON.parse(patch!.body).content).toContain("- ~~a~~");
    expect(JSON.parse(patch!.body).content).toContain("**todos · 1 open**");

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
    expect(r.content[0].text).toContain("- ~~a~~");
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
    expect(JSON.parse(patch!.body).content).toContain("- follow up on X");
    expect(JSON.parse(patch!.body).content).toContain("- **alpha**");
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
            ownerUserId: "uid",
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
    expect(content).toContain("**[wake] 1 pending wake (of 1 total)**");
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
    expect(replyContent()).toBe(fence(`[ok] cancelled wake ${w.id}`));
    expect(loadWakes(tmp)).toHaveLength(0);
  });

  test("/sleep cancel: unknown id, missing id, bogus subcommand", async () => {
    await handleInbound(pi, inbound("/sleep cancel nope", "m1"), ctx);
    expect(replyContent()).toBe(fence("[!] no wake with id nope"));
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
    expect(content).toContain("**[wake] 1 pending wake (of 2 total)**");
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
            ownerUserId: "uid",
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

  test("fence rule: machine replies fenced; summaries are markdown (2026-09-16 + 2026-10-18)", async () => {
    // /command replies ship in a code block (operator 2026-09-16) - still
    // true for machine one-liners, /help, and add/cancel results.
    const fencedCmds = [
      "/help",
      "/tasks add",
      "/tasks reschedule",
      "/tasks cancel",
      "/sleep cancel",
      "/model",
    ];
    for (let i = 0; i < fencedCmds.length; i++) {
      await handleInbound(pi, inbound(fencedCmds[i], `m${i}`), ctx);
      const c = replyContent();
      expect(c.startsWith("```"), `${fencedCmds[i]} -> ${c.slice(0, 50)}`).toBe(
        true,
      );
    }
    // Summary lists (Andryo 2026-10-18): normal markdown - no fence, no
    // box characters, no width budget. Empty-state one-liners stay fenced.
    const summaryCmds = ["/jobs", "/todos", "/tasks", "/sleep"];
    for (let i = 0; i < summaryCmds.length; i++) {
      await handleInbound(pi, inbound(summaryCmds[i], `s${i}`), ctx);
      const c = replyContent();
      if (c.startsWith("```")) {
        const body = c.replace(/^```\n/, "").replace(/\n```$/, "");
        expect(body).not.toContain("\n"); // empty/error one-liner
      } else {
        expect(c).not.toMatch(/[┌┐└┘├┤┣│─]/);
      }
    }
    // /context + /usage (PR #242 review F4): §2.3 summaries too. With a
    // session file present the success path ships unfenced markdown;
    // with none, the error path is a fenced one-liner.
    const sessions = path.join(tmp, ".pi", "agent", "sessions", "2026-09-10");
    fs.mkdirSync(sessions, { recursive: true });
    const sessFile = path.join(
      sessions,
      "2026-09-10T08-00-00-000Z_00000000-0000-0000-0000-000000000001.jsonl",
    );
    fs.writeFileSync(
      sessFile,
      [
        JSON.stringify({
          type: "session",
          version: 3,
          id: "sess",
          timestamp: "2026-09-10T08:00:00.000Z",
          cwd: "/cwd",
        }),
        JSON.stringify({
          type: "message",
          id: "cm1",
          parentId: "p-cm1",
          timestamp: "2026-09-10T08:00:01.000Z",
          message: {
            role: "user",
            content: [{ type: "text", text: "do the thing" }],
          },
        }),
        JSON.stringify({
          type: "message",
          id: "am1",
          parentId: "cm1",
          timestamp: "2026-09-10T08:00:02.000Z",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "done" }],
          },
        }),
        "", // trailing blank: join gives the final newline
      ].join("\n"),
    );
    await handleInbound(pi, inbound("/context", "cx1"), ctx);
    let c = replyContent();
    expect(c.startsWith("```")).toBe(false); // success = unfenced markdown
    expect(c).not.toMatch(/[┌┐└┘├┤┣│─]/);
    await handleInbound(pi, inbound("/usage", "us1"), ctx);
    c = replyContent();
    expect(c.startsWith("```")).toBe(false);
    expect(c).not.toMatch(/[┌┐└┘├┤┣│─]/);
    // error path (no session file): fenced one-liner
    fs.rmSync(sessFile);
    await handleInbound(pi, inbound("/context", "cx2"), ctx);
    expect(replyContent()).toBe(fence("[!] no session file found"));
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
    const content = unwarped(replyContent());
    expect(content).toContain("**[tasks] 2 pending tasks (of 2 total)**");
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
    expect(replyContent()).toBe(fence(`[ok] cancelled task ${t.id}`));
    expect(loadTasks(tmp)).toHaveLength(0);
  });

  test("/tasks cancel: unknown id, missing id, bogus subcommand", async () => {
    await handleInbound(pi, inbound("/tasks cancel nope", "m1"), ctx);
    expect(replyContent()).toBe(fence("[!] no task with id nope"));
    await handleInbound(pi, inbound("/tasks cancel", "m2"), ctx);
    expect(replyContent()).toBe(fence("[!] usage: /tasks cancel <id>"));
    await handleInbound(pi, inbound("/tasks xyz", "m3"), ctx);
    expect(unwarped(replyContent())).toBe(
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
    expect(unwarped(replyContent())).toContain("cancel with /tasks cancel");
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
    expect(unwarped(replyContent())).toContain('cron "0 6 * * *" (UTC)');
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

  test("/tasks add: minutes suffix (30m) + quoted cron/ISO issue forms", async () => {
    // "30m" -> minutes (issue example form)
    await handleInbound(pi, inbound('/tasks add "fleet check" 30m', "m1"), ctx);
    expect(replyContent()).toContain("[ok] task");
    expect(loadTasks(tmp)[0]).toMatchObject({
      prompt: "fleet check",
      kind: "at",
    });
    // quoted 5-field cron (issue example form) -> system-tz recurring
    await handleInbound(
      pi,
      inbound('/tasks add "daily 06:00 fleet check" "0 6 * * *"', "m2"),
      ctx,
    );
    const cron = loadTasks(tmp)[1];
    expect(cron).toMatchObject({
      prompt: "daily 06:00 fleet check",
      kind: "cron",
      cron: "0 6 * * *",
    });
    expect(cron.tz).toBeUndefined();
    expect(unwarped(replyContent())).toContain('cron "0 6 * * *" (system tz)');
    // quoted ISO -> exact fire time
    const iso = new Date(Date.now() + 3600000).toISOString();
    await handleInbound(
      pi,
      inbound(`/tasks add "quoted iso" "${iso}"`, "m3"),
      ctx,
    );
    expect(loadTasks(tmp)[2]).toMatchObject({
      prompt: "quoted iso",
      kind: "at",
      atMs: Date.parse(iso),
    });
  });

  test("/tasks reschedule: swaps the spec, keeps id + prompt", async () => {
    const atMs = Date.now() + 30 * 60000;
    const t = scheduleTask({
      channelId: "ch1",
      channelName: "Test",
      prompt: "check the build",
      spec: { kind: "at", atMs, nextFireAt: atMs },
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
    // old spec -> new spec, then the new next fire
    expect(unwarped(replyContent())).toContain(
      `at ${new Date(atMs).toISOString()} -> cron "0 9 * * 1-5" (Australia/Melbourne)`,
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

  test("/tasks reschedule: recurring -> one-shot (reverse direction)", async () => {
    const t = scheduleTask({
      channelId: "ch1",
      prompt: "daily check",
      spec: {
        kind: "cron",
        cron: "0 6 * * *",
        nextFireAt: Date.now() + 3600000,
      },
      home: tmp,
    });
    await handleInbound(pi, inbound(`/tasks reschedule ${t.id} 45`, "m1"), ctx);
    expect(replyContent()).toContain("[ok] rescheduled");
    expect(unwarped(replyContent())).toContain(
      'cron "0 6 * * *" (system tz) -> at ',
    );
    const after = loadTasks(tmp)[0];
    expect(after).toMatchObject({
      id: t.id,
      prompt: "daily check",
      kind: "at",
      status: "pending",
    });
    expect(after.cron).toBeUndefined();
    expect(after.atMs).toBeGreaterThanOrEqual(Date.now() + 44 * 60000);
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
    expect(replyContent()).toBe(fence("[!] no task with id nope"));
    // same id shape on another channel is not THIS session's task
    await handleInbound(
      pi,
      inbound(`/tasks reschedule ${other.id} 30`, "m2"),
      ctx,
    );
    expect(replyContent()).toBe(fence(`[!] no task with id ${other.id}`));
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
    expect(unwarped(replyContent())).toBe(addUsage);
    await handleInbound(
      pi,
      inbound("/tasks add check the build 30", "m2"), // unquoted prompt
      ctx,
    );
    expect(unwarped(replyContent())).toBe(addUsage);
    await handleInbound(pi, inbound('/tasks add "x"', "m3"), ctx); // no spec
    expect(unwarped(replyContent())).toBe(addUsage);
    await handleInbound(pi, inbound('/tasks add "x" 30 UTC', "m4"), ctx);
    expect(unwarped(replyContent())).toBe(addUsage); // 2 tokens: not any form
    await handleInbound(pi, inbound("/tasks reschedule", "m5"), ctx);
    expect(unwarped(replyContent())).toBe(resUsage);
    await handleInbound(pi, inbound(`/tasks reschedule ${t.id}`, "m6"), ctx);
    expect(unwarped(replyContent())).toBe(resUsage); // missing spec
    // content errors -> one [!] line (from parseTaskSpec / rescheduleTask)
    await handleInbound(pi, inbound('/tasks add "" 30', "m7"), ctx);
    expect(unwarped(replyContent())).toBe(fence("[!] prompt is required"));
    await handleInbound(pi, inbound('/tasks add "x" 0', "m8"), ctx);
    expect(unwarped(replyContent())).toBe(
      fence("[!] minutes must be greater than 0"),
    );
    await handleInbound(pi, inbound('/tasks add "x" 99999', "m9"), ctx);
    expect(unwarped(replyContent())).toBe(
      fence("[!] minutes too large (max 43200 = 30d)"),
    );
    await handleInbound(pi, inbound('/tasks add "x" yesterday', "m10"), ctx);
    expect(unwarped(replyContent())).toBe(
      fence(
        '[!] invalid at: "yesterday" (ISO time, e.g. 2026-09-10T15:00:00Z)',
      ),
    );
    await handleInbound(pi, inbound('/tasks add "x" 99 * * * *', "m11"), ctx);
    expect(unwarped(replyContent())).toBe(
      fence('[!] invalid cron "99 * * * *": minute out of range 0-59: 99'),
    );
    await handleInbound(
      pi,
      inbound('/tasks add "x" 0 6 * * * Not/AZone', "m12"),
      ctx,
    );
    expect(unwarped(replyContent())).toBe(
      fence(
        '[!] unknown timezone "Not/AZone" (IANA name, e.g. Australia/Melbourne)',
      ),
    );
    await handleInbound(
      pi,
      inbound(`/tasks reschedule ${t.id} 99 * * * *`, "m13"),
      ctx,
    );
    expect(unwarped(replyContent())).toBe(
      fence('[!] invalid cron "99 * * * *": minute out of range 0-59: 99'),
    );
    await handleInbound(
      pi,
      inbound(`/tasks reschedule ${t.id} not-a-time`, "m14"),
      ctx,
    );
    expect(unwarped(replyContent())).toBe(
      fence(
        '[!] invalid at: "not-a-time" (ISO time, e.g. 2026-09-10T15:00:00Z)',
      ),
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
    expect(content).toContain("**[tasks] 1 pending task (of 1 total)**");
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
