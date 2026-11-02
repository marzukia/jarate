// inbox.test.ts — hermetic tests for the #254 wave-2 bridge leg: the HTTP leg is a mock (no live hall-monitor API in unit tests) that emulates the server contract (idempotent receive on (agent, source_ref); unread-only list, oldest first, limit clamped 1..200 with the total count; consume = unread -> consumed / unread -> actioned, plain re-ack of a consumed or actioned row = 200 no-op with the first-read time and note untouched).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  armInbox,
  consumeRecordedByRef,
  type InboxKind,
  type InboxRow,
  inboxConfigured,
  readKeyFile,
  recordChannelPost,
  recordInbox,
  redeliverOnCompact,
  redeliverUnread,
  renderRow,
  resetInboxConfigCache,
  setInboxConfigTtlForTests,
  setInboxDeliverer,
  setInboxHttp,
} from "./inbox";

// Mock of the hall-monitor inbox API (server semantics emulated, client-side behavior under test).
interface MockCall {
  url: string;
  method: string;
  body?: Record<string, unknown>;
}

interface MockState {
  rows: InboxRow[];
  nextId: number;
  calls: MockCall[];
  receiveResults: InboxRow[];
  consumeResults: { status: number; row: InboxRow | null }[];
  failGet: boolean;
  failConsume: boolean;
  failReceive: boolean;
  delayMs: number;
}

function mockFetch(state: MockState) {
  return async (
    url: string,
    init: RequestInit,
  ): Promise<{ ok: boolean; status: number; json(): Promise<unknown> }> => {
    const u = new URL(url);
    const method = (init.method ?? "GET").toUpperCase();
    const body = (init.body ? JSON.parse(String(init.body)) : undefined) as
      | Record<string, unknown>
      | undefined;
    state.calls.push({ url, method, body });
    if (state.delayMs > 0)
      await new Promise((r) => setTimeout(r, state.delayMs));
    const resp = (
      obj: unknown,
      status: number,
    ): { ok: boolean; status: number; json(): Promise<unknown> } => ({
      ok: status >= 200 && status < 300,
      status,
      json: async () => obj,
    });

    // POST /api/fleet/inbox/receive — idempotent on (agent, source_ref): a re-post returns the existing row (no field changes, no status reset); a null ref is a one-off (always created).
    if (method === "POST" && u.pathname === "/api/inbox/receive") {
      if (state.failReceive) return resp({ detail: "boom" }, 500);
      const ref = (body?.source_ref as string | undefined) ?? null;
      const existing = ref
        ? state.rows.find((r) => r.source_ref === ref)
        : undefined;
      const row: InboxRow = existing ?? {
        id: state.nextId++,
        kind: body!.kind as InboxKind,
        sender: body!.sender as string,
        body: body!.body as string,
        source_ref: ref,
        status: "unread",
        consumed_at: null,
        consumed_note: "",
        created_at: "2026-11-01T00:00:00Z",
      };
      if (!existing) state.rows.push(row);
      state.receiveResults.push(row);
      return resp(row, 200);
    }

    // GET /api/fleet/inbox?status=unread&limit=N — own rows only, oldest first, limit clamped 1..200, count = the whole status set (not the page).
    if (method === "GET" && u.pathname === "/api/inbox") {
      if (state.failGet) return resp({ detail: "boom" }, 500);
      const status = u.searchParams.get("status") ?? "unread";
      const limit = Math.max(
        1,
        Math.min(Number(u.searchParams.get("limit") ?? 50), 200),
      );
      const set = state.rows.filter((r) => r.status === status);
      return resp({ count: set.length, messages: set.slice(0, limit) }, 200);
    }

    // POST /api/fleet/inbox/consume — unread -> consumed (consumed_at = now, the first-read time) or -> actioned direct; a plain re-ack of a consumed or actioned row is a 200 no-op (the state, the first-read time, the note are untouched — byte-for-byte wave-1).
    if (method === "POST" && u.pathname === "/api/inbox/consume") {
      if (state.failConsume) return resp({ detail: "boom" }, 500);
      const row = state.rows.find((r) => r.id === body?.id);
      if (!row) return resp({ detail: "not found" }, 404);
      if (row.status === "unread") {
        row.status = body?.actioned ? "actioned" : "consumed";
        row.consumed_at = "first-read-t";
        if (body?.note) row.consumed_note = String(body.note).slice(0, 255);
      }
      state.consumeResults.push({ status: 200, row: { ...row } });
      return resp(row, 200);
    }

    return resp({ detail: "unmocked" }, 404);
  };
}

let state: MockState;
let delivererCalls: Array<{ row: InboxRow; line: string }>;
let delivererFail: boolean;

function installMock(): void {
  state = {
    rows: [],
    nextId: 1,
    calls: [],
    receiveResults: [],
    consumeResults: [],
    failGet: false,
    failConsume: false,
    failReceive: false,
    delayMs: 0,
  };
  delivererCalls = [];
  delivererFail = false;
  setInboxHttp(mockFetch(state));
  setInboxDeliverer(async (row, line) => {
    delivererCalls.push({ row, line });
    return !delivererFail;
  });
}

beforeEach(() => {
  process.env.JARATE_INBOX_URL = "http://mock.test/api";
  process.env.JARATE_INBOX_KEY = "mock-key";
  delete process.env.JARATE_INBOX_AGENT;
  resetInboxConfigCache();
  installMock();
});

afterEach(() => {
  setInboxHttp(null);
  setInboxDeliverer(null);
  setInboxConfigTtlForTests(5_000);
  delete process.env.JARATE_INBOX_URL;
  delete process.env.JARATE_INBOX_KEY;
  delete process.env.JARATE_INBOX_AGENT;
  resetInboxConfigCache();
});

// Capture console.warn for the duration of a test (restore() puts the original back).
function captureWarns(): { warns: string[]; restore(): void } {
  const warns: string[] = [];
  const orig = console.warn;
  console.warn = (m: unknown, ...rest: unknown[]) => {
    warns.push([m, ...rest].map(String).join(" "));
  };
  return {
    warns,
    restore: () => {
      console.warn = orig;
    },
  };
}

function seedRow(
  kind: InboxKind,
  sender: string,
  body: string,
  status: InboxRow["status"] = "unread",
): InboxRow {
  const row: InboxRow = {
    id: state.nextId++,
    kind,
    sender,
    body,
    source_ref: `${kind}-${state.nextId - 1}`,
    status,
    consumed_at: status === "unread" ? null : "first-read-t",
    consumed_note: status === "unread" ? "" : "earlier note",
    created_at: "2026-11-01T00:00:00Z",
  };
  state.rows.push(row);
  return row;
}

function flush(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

describe("config", () => {
  test("off without a URL: no HTTP, no delivery, configured false", async () => {
    delete process.env.JARATE_INBOX_URL;
    resetInboxConfigCache();
    expect(inboxConfigured()).toBe(false);
    recordInbox("channel_post", "op", "hi");
    await flush();
    expect(state.calls.length).toBe(0);
    expect(await redeliverUnread("startup")).toBe(0);
    expect(delivererCalls.length).toBe(0);
  });
});

describe("renderRow (kind-appropriate shapes)", () => {
  test("say row renders as a say wake with the recipient when the agent name is set", () => {
    const r: InboxRow = {
      id: 1,
      kind: "say",
      sender: "franky",
      body: "ping",
      source_ref: "say-1",
      status: "unread",
      consumed_at: null,
      consumed_note: "",
      created_at: "t",
    };
    expect(renderRow(r, "monky")).toBe("say franky -> monky: ping");
    expect(renderRow(r, "")).toBe("say franky: ping");
  });

  test("mail row renders as a mail wake (sender + body)", () => {
    const r: InboxRow = {
      id: 2,
      kind: "mail",
      sender: "warden",
      body: "subject\nbody",
      source_ref: "mail:1:2",
      status: "unread",
      consumed_at: null,
      consumed_note: "",
      created_at: "t",
    };
    expect(renderRow(r, "monky")).toBe("mail warden: subject\nbody");
  });

  test("channel post is re-posted verbatim", () => {
    const r: InboxRow = {
      id: 3,
      kind: "channel_post",
      sender: "op",
      body: "deploy the bridge",
      source_ref: "discord-123",
      status: "unread",
      consumed_at: null,
      consumed_note: "",
      created_at: "t",
    };
    expect(renderRow(r, "monky")).toBe("deploy the bridge");
  });
});

describe("recordInbox (intake at receipt)", () => {
  test("posts the row before delivery and carries the channel-post ref", async () => {
    process.env.JARATE_INBOX_AGENT = "monky";
    resetInboxConfigCache();
    recordInbox("channel_post", "op", "hi there", "discord-42");
    await flush();
    const call = state.calls.find(
      (c) => c.method === "POST" && c.url.endsWith("/inbox/receive"),
    );
    expect(call).toBeDefined();
    expect(call!.body).toEqual({
      kind: "channel_post",
      sender: "op",
      body: "hi there",
      source_ref: "discord-42",
    });
    expect(state.rows.length).toBe(1);
  });

  test("idempotent receive: a double-post of the same (agent, source_ref) is one row", async () => {
    recordInbox("channel_post", "op", "hi there", "discord-42");
    recordInbox("channel_post", "op", "hi there", "discord-42");
    await flush();
    const posts = state.calls.filter((c) => c.url.endsWith("/inbox/receive"));
    expect(posts.length).toBe(2);
    expect(state.rows.length).toBe(1);
    expect(state.receiveResults[0].id).toBe(state.receiveResults[1].id);
    expect(state.rows[0].status).toBe("unread");
  });

  test("a one-off (no source_ref) is never deduped", async () => {
    recordInbox("channel_post", "op", "a");
    recordInbox("channel_post", "op", "b");
    await flush();
    expect(state.rows.length).toBe(2);
  });
});

describe("redeliverUnread (startup)", () => {
  test("re-delivers the unread set in kind-appropriate shape, oldest first, and consumes each delivered row", async () => {
    process.env.JARATE_INBOX_AGENT = "monky";
    resetInboxConfigCache();
    const post = seedRow("channel_post", "op", "deploy the bridge");
    const say = seedRow("say", "franky", "ping");
    const mail = seedRow("mail", "warden", "subject\nbody");
    const consumed = seedRow("channel_post", "op", "old", "consumed");

    const n = await redeliverUnread("startup");

    expect(n).toBe(3);
    // Oldest first, only the unread set (the consumed row is not in the list).
    expect(delivererCalls.map((c) => c.row.id)).toEqual([
      post.id,
      say.id,
      mail.id,
    ]);
    expect(delivererCalls[0].line).toBe("deploy the bridge");
    expect(delivererCalls[1].line).toBe("say franky -> monky: ping");
    expect(delivererCalls[2].line).toBe("mail warden: subject\nbody");
    const consumedPosts = state.calls.filter(
      (c) => c.method === "POST" && c.url.endsWith("/inbox/consume"),
    );
    expect(consumedPosts.length).toBe(3);
    for (const c of consumedPosts) {
      expect(c.body!.actioned).toBeUndefined();
      expect(c.body!.note).toBe("bridge redelivered at startup");
    }
    expect(state.rows.filter((r) => r.status === "consumed").length).toBe(4);
    expect(consumed.consumed_at).toBe("first-read-t");
  });

  test("the GET is scoped to status=unread with a bounded limit and the count is the whole set", async () => {
    seedRow("channel_post", "op", "x");
    await redeliverUnread("startup");
    const get = state.calls.find((c) => c.method === "GET");
    expect(get).toBeDefined();
    expect(get!.url).toContain("status=unread");
    expect(get!.url).toContain("limit=200");
  });
});

describe("redeliverUnread (post-compaction)", () => {
  test("consumes with the compaction note and does not re-fire a consumed row on the next trigger", async () => {
    const row = seedRow("say", "franky", "ping");
    expect(await redeliverUnread("compaction")).toBe(1);
    expect(state.rows[0].status).toBe("consumed");
    expect(state.rows[0].consumed_note).toBe(
      "bridge redelivered at compaction",
    );

    // The next trigger (e.g. the next startup): the consumed row is not in the unread set, never re-delivers, and the server keeps the first-read time on the plain re-ack (wave-1 byte-for-byte).
    expect(await redeliverUnread("startup")).toBe(0);
    expect(delivererCalls.length).toBe(1);
    const firstRead = state.rows[0].consumed_at;
    const firstNote = state.rows[0].consumed_note;
    // A plain re-ack of the consumed row (a flaky double-ack) is a 200 no-op: state, first-read time, note untouched.
    const res = await mockFetch(state)("http://mock.test/api/inbox/consume", {
      method: "POST",
      body: JSON.stringify({ id: row.id, note: "again" }),
    });
    expect(res.status).toBe(200);
    expect(state.rows[0].status).toBe("consumed");
    expect(state.rows[0].consumed_at).toBe(firstRead);
    expect(state.rows[0].consumed_note).toBe(firstNote);
  });
});

describe("actioned terminal no-op", () => {
  test("a plain re-ack of an actioned row is a 200 no-op (terminal; the first-read time is kept)", async () => {
    const row = seedRow("say", "franky", "ping", "actioned");
    const res = await mockFetch(state)("http://mock.test/api/inbox/consume", {
      method: "POST",
      body: JSON.stringify({ id: row.id }),
    });
    expect(res.status).toBe(200);
    expect(state.rows[0].status).toBe("actioned");
    expect(state.rows[0].consumed_at).toBe("first-read-t");
    expect(state.rows[0].consumed_note).toBe("earlier note");
  });

  test("the bridge never posts actioned=true at delivery (delivered = consume; actioned is the agent's terminal state)", async () => {
    seedRow("channel_post", "op", "x");
    await redeliverUnread("startup");
    for (const c of state.calls) {
      if (c.method === "POST" && c.url.endsWith("/inbox/consume"))
        expect(c.body!.actioned).toBeFalsy();
    }
  });
});

describe("wiring (armInbox / redeliverOnCompact / recordChannelPost)", () => {
  test("armInbox registers the deliverer, fires the startup redelivery, and delivers through sendToPi", async () => {
    process.env.JARATE_INBOX_AGENT = "monky";
    resetInboxConfigCache();
    seedRow("say", "franky", "ping");
    const sent: string[] = [];
    const pi = {
      sendMessage: (m: { content: string }) => {
        sent.push(m.content);
      },
    } as unknown as ExtensionAPI;
    // A tokenless channel: the channel re-post no-ops (no network), the pi delivery is the delivery.
    armInbox(pi, {
      id: "ch1",
      name: "ch1",
      type: "discord",
      enabled: true,
      channel: "1",
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(sent).toEqual(["say franky -> monky: ping"]);
    expect(state.rows[0].status).toBe("consumed");
  });

  test("armInbox with a null channel leaves the rows unread (no deliverer yet)", async () => {
    seedRow("say", "franky", "ping");
    const pi = { sendMessage: () => {} } as unknown as ExtensionAPI;
    armInbox(pi, null);
    await new Promise((r) => setTimeout(r, 10));
    expect(state.rows[0].status).toBe("unread");
  });

  test("redeliverOnCompact fires only when ready (pi idle + no handoff restart armed + not a fleet run)", async () => {
    seedRow("channel_post", "op", "x");
    let ready = false;
    redeliverOnCompact(() => ready);
    await new Promise((r) => setTimeout(r, 20));
    expect(delivererCalls.length).toBe(0);
    ready = true;
    redeliverOnCompact(() => ready);
    await new Promise((r) => setTimeout(r, 20));
    expect(delivererCalls.length).toBe(1);
  });

  test("recordChannelPost records at receipt with the Discord message id ref (idempotent) and trims the body; a synthetic post without an id is a one-off", async () => {
    recordChannelPost({ from: "op", body: " hi ", messageId: "123" });
    recordChannelPost({ from: "op", body: " hi ", messageId: "123" });
    recordChannelPost({ from: "op", body: " no id " });
    await flush();
    expect(state.rows.length).toBe(2);
    expect(state.rows[0].body).toBe("hi");
    expect(state.rows[0].source_ref).toBe("discord-123");
    expect(state.rows[1].source_ref).toBeNull();
  });
});

describe("failure paths (a dead API never breaks delivery; a failed delivery never consumes)", () => {
  test("a failed delivery leaves the row unconsumed (it re-fires on the next trigger)", async () => {
    seedRow("channel_post", "op", "x");
    delivererFail = true;
    expect(await redeliverUnread("startup")).toBe(0);
    expect(state.rows[0].status).toBe("unread");
    expect(state.consumeResults.length).toBe(0);
  });

  test("a dead API (GET 500) leaves everything unread and does not throw", async () => {
    seedRow("channel_post", "op", "x");
    state.failGet = true;
    expect(await redeliverUnread("startup")).toBe(0);
    expect(state.rows[0].status).toBe("unread");
    expect(delivererCalls.length).toBe(0);
  });

  test("no deliverer registered: rows stay unread", async () => {
    seedRow("channel_post", "op", "x");
    setInboxDeliverer(null);
    expect(await redeliverUnread("startup")).toBe(0);
    expect(state.rows[0].status).toBe("unread");
  });

  test("a failed consume after a successful delivery leaves the row unread and is NOT in the return (at-least-once: it re-delivers next trigger; the honest counter is consumed, not delivered)", async () => {
    seedRow("channel_post", "op", "x");
    state.failConsume = true;
    expect(await redeliverUnread("startup")).toBe(0);
    expect(delivererCalls.length).toBe(1);
    expect(state.rows[0].status).toBe("unread");
  });

  test("a deliverer that throws leaves the row unread (catch branch; the row re-fires on the next trigger)", async () => {
    seedRow("channel_post", "op", "x");
    setInboxDeliverer(async () => {
      throw new Error("deliverer boom");
    });
    expect(await redeliverUnread("startup")).toBe(0);
    expect(state.rows[0].status).toBe("unread");
    expect(state.consumeResults.length).toBe(0);
  });

  test("an over-cap unread set (count > page) warns that the remainder re-fires on the next trigger", async () => {
    const { warns, restore } = captureWarns();
    try {
      for (let i = 0; i < 201; i++) seedRow("channel_post", "op", `m${i}`);
      expect(await redeliverUnread("startup")).toBe(200);
      expect(warns.some((w) => w.includes("beyond the 200 cap"))).toBe(true);
    } finally {
      restore();
    }
  });

  test("the in-flight guard serializes concurrent triggers", async () => {
    seedRow("channel_post", "op", "x");
    let release: () => void;
    const gate = new Promise<void>((r) => (release = r));
    setInboxDeliverer(async () => {
      await gate;
      return true;
    });
    const p1 = redeliverUnread("startup");
    const p2 = redeliverUnread("compaction"); // overlaps p1
    expect(await p2).toBe(0);
    release!();
    expect(await p1).toBe(1);
  });
});

describe("live-delivery consume (delivered = read; review #321 f1)", () => {
  test("a live-delivered row is consumed and never redelivered on the next trigger", async () => {
    const rec = recordChannelPost({
      from: "op",
      body: "deploy",
      messageId: "900",
    });
    await flush();
    expect(state.rows.length).toBe(1);
    expect(state.rows[0].status).toBe("unread");
    rec.consume("live: delivered to pi");
    await flush();
    const consume = state.calls.find((c) => c.url.endsWith("/inbox/consume"));
    expect(consume).toBeDefined();
    expect(consume!.body!.note).toBe("live: delivered to pi");
    expect(state.rows[0].status).toBe("consumed");
    // The next trigger (e.g. the next startup): the consumed row is not in the unread set, never re-delivers.
    expect(await redeliverUnread("startup")).toBe(0);
  });

  test("a one-off (no id) row is consumed by its row id", async () => {
    const rec = recordChannelPost({ from: "op", body: "no id" });
    rec.consume("live: delivered to pi");
    await flush();
    expect(state.rows.length).toBe(1);
    expect(state.rows[0].source_ref).toBeNull();
    expect(state.rows[0].status).toBe("consumed");
  });

  test("a live-delivered row is skipped by a redelivery trigger in the same window (the compaction drain / post-compaction redelivery race)", async () => {
    state.delayMs = 20; // the receive is still in flight when the trigger fires
    const rec = recordChannelPost({ from: "op", body: "x", messageId: "91" });
    rec.consume("live: delivered to pi");
    // The redelivery fires while the receive is in flight (or its consume is): the row is marked live-delivered, so the redelivery skips it.
    expect(await redeliverUnread("compaction")).toBe(0);
    await new Promise((r) => setTimeout(r, 100));
    expect(delivererCalls.length).toBe(0); // no redelivery
    expect(state.rows[0].status).toBe("consumed"); // the live path owns the consume
  });

  test("consumeRecordedByRef consumes the row even when the receive is still in flight (the mid-run interrupt path)", async () => {
    state.delayMs = 20;
    recordChannelPost({ from: "op", body: "x", messageId: "77" });
    consumeRecordedByRef("77", "live: mid-run interrupt delivered");
    await new Promise((r) => setTimeout(r, 100));
    expect(state.rows.length).toBe(1);
    expect(state.rows[0].status).toBe("consumed");
    expect(state.rows[0].consumed_note).toBe(
      "live: mid-run interrupt delivered",
    );
  });

  test("consumeRecordedByRef is a no-op for a message this process never recorded", async () => {
    seedRow("channel_post", "op", "x");
    consumeRecordedByRef("never-recorded", "live");
    await flush();
    expect(state.rows[0].status).toBe("unread");
    expect(state.consumeResults.length).toBe(0);
  });

  test("a double consume is a server 200 no-op (the row keeps its first note)", async () => {
    const rec = recordChannelPost({ from: "op", body: "x", messageId: "92" });
    rec.consume("first");
    rec.consume("second");
    await flush();
    expect(state.rows[0].status).toBe("consumed");
    expect(state.rows[0].consumed_note).toBe("first");
  });

  test("an intake failure (API 500) warn-logs (the at-most-once leg is observable) and the consume is a no-op", async () => {
    const { warns, restore } = captureWarns();
    try {
      state.failReceive = true;
      const rec = recordChannelPost({ from: "op", body: "x", messageId: "81" });
      rec.consume("live: delivered to pi");
      await flush();
      expect(warns.some((w) => w.includes("intake failed"))).toBe(true);
      expect(state.rows.length).toBe(0);
    } finally {
      restore();
    }
  });

  test("a live consume failure (API 500 on consume) warns and leaves the row unread (at-least-once: it re-delivers on the next trigger)", async () => {
    const { warns, restore } = captureWarns();
    try {
      const rec = recordChannelPost({ from: "op", body: "x", messageId: "83" });
      await flush();
      state.failConsume = true;
      rec.consume("live: delivered to pi");
      await flush();
      expect(warns.some((w) => w.includes("live consume failed"))).toBe(true);
      expect(state.rows[0].status).toBe("unread");
    } finally {
      restore();
    }
  });

  test("an over-cap receive body is truncated client-side with a warn (the server-side payload limit is the backstop)", async () => {
    const { warns, restore } = captureWarns();
    try {
      recordChannelPost({
        from: "op",
        body: "x".repeat(20_000),
        messageId: "82",
      });
      await flush();
      const post = state.calls.find((c) => c.url.endsWith("/inbox/receive"))!;
      const body = post.body!.body as string;
      expect(body.endsWith("… (truncated)")).toBe(true);
      expect(body.length).toBe(16_000 + "… (truncated)".length);
      expect(warns.some((w) => w.includes("char cap"))).toBe(true);
    } finally {
      restore();
    }
  });
});

describe("config: key file fallback + TTL", () => {
  test("readKeyFile: the first non-comment, non-blank line; missing file = empty", () => {
    const file = path.join(os.tmpdir(), `inbox-key-test-${process.pid}.txt`);
    fs.writeFileSync(file, "# a comment\n\n   file-key-123  \nother-line\n");
    expect(readKeyFile(file)).toBe("file-key-123");
    expect(
      readKeyFile(path.join(os.tmpdir(), "inbox-key-missing-never.txt")),
    ).toBe("");
    fs.unlinkSync(file);
  });

  test("the config is cached for the TTL and re-read after expiry (5s default, injectable for tests)", async () => {
    setInboxConfigTtlForTests(20);
    resetInboxConfigCache();
    expect(inboxConfigured()).toBe(true);
    delete process.env.JARATE_INBOX_URL;
    expect(inboxConfigured()).toBe(true); // still within the TTL: the stale config is served
    await new Promise((r) => setTimeout(r, 40));
    expect(inboxConfigured()).toBe(false); // the cache expired: the env is re-read (URL gone = off)
  });
});
