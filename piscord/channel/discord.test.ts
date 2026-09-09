import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  allowedMentionsFor,
  connectDiscord,
  deferInteraction,
  disconnectDiscord,
  editInteractionMessage,
  ensurePresenceState,
  getDiscordStates,
  handleMessageCreate,
  isBgWebhook,
  loadPersistedCursors,
  mimeForFile,
  POLL_BACKFILL_MS,
  POLL_INTERVAL_MS,
  pollDiscord,
  registerDiscordCommands,
  resolveChannelId,
  respondToInteraction,
  sendDiscordMessage,
  sendFilesToDiscord,
  suppressAutoReact,
} from "./discord";

// ─── fetch mock plumbing ───────────────────────────────────────────────────

function jsonResp(status: number, data: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => data,
    text: async () => (data ? JSON.stringify(data) : ""),
  };
}

function setFetch(handler: (url: string, init?: any) => Promise<any>) {
  globalThis.fetch = (async (input: any, init?: any) => {
    return handler(String(input), init);
  }) as any;
}

const tick = (ms = 25) => new Promise((r) => setTimeout(r, ms));

const cfg = (id: string, extra: Record<string, unknown> = {}): any => ({
  id,
  name: id,
  type: "discord",
  enabled: true,
  channel: "999",
  botToken: `tok-${id}`,
  ...extra,
});

afterEach(() => {
  for (const id of [
    "m3",
    "l3",
    "react",
    "noack",
    "gw",
    "burst",
    "r1",
    "o1",
    "o2",
    "o3",
    "c1",
    "p1",
  ])
    disconnectDiscord(id);
});

// ─── M3: startup message gated on bot identity ─────────────────────────────

test("startup message waits until bot identity resolves (M3)", async () => {
  const posts: any[] = [];
  let meFail = true;
  setFetch(async (u, init) => {
    const method = init?.method || "GET";
    if (u.endsWith("/users/@me")) {
      return meFail ? jsonResp(404, {}) : jsonResp(200, { id: "bot-1" });
    }
    if (method === "POST" && u.includes("/messages")) {
      posts.push(JSON.parse(init.body));
      return jsonResp(200, { id: "posted-1" });
    }
    if (u.includes("/messages")) return jsonResp(200, []);
    return jsonResp(200, null);
  });

  const ok = await connectDiscord(cfg("m3", { startupMessage: "hello" }), {
    onMessage: () => {},
    onError: () => {},
  });
  expect(ok).toBe(true);
  // Identity unknown at connect → startup is queued, not posted.
  await tick();
  expect(posts).toEqual([]);

  // First poll resolves identity → startup posted exactly once.
  meFail = false;
  await pollDiscord("m3");
  await tick();
  expect(posts.length).toBe(1);
  expect(posts[0].content).toBe("hello");
  await pollDiscord("m3");
  await tick();
  expect(posts.length).toBe(1);
});

// ─── L3: channel id cache is per-token ─────────────────────────────────────

test("resolveChannelId cache is per-token (L3)", async () => {
  setFetch(async (u, init) => {
    const auth = init?.headers?.Authorization || "";
    if (u.endsWith("/users/@me/guilds")) return jsonResp(200, [{ id: "g1" }]);
    if (u.endsWith("/guilds/g1/channels")) {
      return jsonResp(200, [
        { id: auth.includes("tokA") ? "111" : "222", name: "general", type: 0 },
      ]);
    }
    return jsonResp(200, []);
  });

  const a = await resolveChannelId("tokA", "general");
  const b = await resolveChannelId("tokB", "general");
  expect(a).toBe("111");
  expect(b).toBe("222");
});

// ─── L6 + F2: poller auto-react, suppression, and ack: false ───────────────

const userMsg = (id: string, authorId: string) => ({
  id,
  author: { id: authorId, username: "user" },
  content: "hi",
  attachments: [],
  embeds: [],
  timestamp: new Date().toISOString(),
});

test("poller auto-reacts unless suppressed or ack disabled (L6, F2)", async () => {
  // Default channel (ack on): m1 reacts, m2 suppressed by handler,
  // m3 is the bot's own message and is skipped.
  let pollCount = 0;
  const puts: string[] = [];
  const seen: string[] = [];
  setFetch(async (u, init) => {
    const method = init?.method || "GET";
    if (u.endsWith("/users/@me")) return jsonResp(200, { id: "bot-9" });
    if (method === "PUT" && u.includes("/reactions/")) {
      puts.push(u.split("/messages/")[1]?.split("/")[0] || "?");
      return jsonResp(204, null);
    }
    if (u.includes("/messages?limit=1"))
      return jsonResp(200, [userMsg("m0", "u-1")]);
    if (u.includes("/messages")) {
      pollCount++;
      if (pollCount === 1) {
        // Discord returns oldest-first; the poller delivers in that order
        // so the shared cursor advances monotonically.
        return jsonResp(200, [
          userMsg("m1", "u-1"),
          userMsg("m2", "u-1"),
          userMsg("m3", "bot-9"),
        ]);
      }
      return jsonResp(200, []);
    }
    return jsonResp(200, null);
  });

  const ok = await connectDiscord(cfg("react"), {
    onMessage: (m) => {
      seen.push(m.messageId);
      if (m.messageId === "m2") suppressAutoReact(m.messageId);
    },
    onError: () => {},
  });
  expect(ok).toBe(true);

  await pollDiscord("react");
  await tick();
  expect(seen).toEqual(["m1", "m2"]); // bot's own m3 skipped
  expect(puts).toEqual(["m1"]); // m2 suppressed, m3 not reacted

  await pollDiscord("react");
  await tick();
  expect(puts).toEqual(["m1"]); // no duplicates on later polls
});

test("ack: false disables the auto-react (F2)", async () => {
  const puts: string[] = [];
  const seen: string[] = [];
  setFetch(async (u, init) => {
    const method = init?.method || "GET";
    if (u.endsWith("/users/@me")) return jsonResp(200, { id: "bot-8" });
    if (method === "PUT" && u.includes("/reactions/")) {
      puts.push(u.split("/messages/")[1]?.split("/")[0] || "?");
      return jsonResp(204, null);
    }
    if (u.includes("/messages?limit=1"))
      return jsonResp(200, [userMsg("n0", "u-2")]);
    if (u.includes("/messages")) {
      return seen.length
        ? jsonResp(200, [])
        : jsonResp(200, [userMsg("n1", "u-2")]);
    }
    return jsonResp(200, null);
  });

  const ok = await connectDiscord(cfg("noack", { ack: false }), {
    onMessage: (m) => seen.push(m.messageId),
    onError: () => {},
  });
  expect(ok).toBe(true);

  await pollDiscord("noack");
  await tick();
  expect(seen).toEqual(["n1"]); // message still delivered to the handler
  expect(puts).toEqual([]); // but no 👀
});

// ─── Gateway: MESSAGE_CREATE → shared pipeline, deduped against poll ─────

test("gateway MESSAGE_CREATE delivers once; duplicate dropped; poll backfill dedupes", async () => {
  const seen: any[] = [];
  setFetch(async (u) => {
    if (u.endsWith("/users/@me")) return jsonResp(200, { id: "bot-g" });
    if (u.includes("/messages?limit=1")) return jsonResp(200, []);
    if (u.includes("/messages")) {
      // Worst case: backfill re-sees the gateway-delivered g1 plus new g2
      // (oldest first, as Discord returns them).
      return jsonResp(200, [
        userMsg("9000000000000000001", "u-9"),
        userMsg("9000000000000000002", "u-9"),
      ]);
    }
    return jsonResp(200, null);
  });

  const ok = await connectDiscord(cfg("gw"), {
    onMessage: (m) => seen.push(m),
    onError: () => {},
  });
  expect(ok).toBe(true);

  // Simulate READY: bot identity from d.user.id, gateway connected.
  const st = ensurePresenceState("tok-gw");
  st.ready = true;
  st.botUserId = "bot-g";

  const d = (id: string, authorId = "u-9", channelId = "999") => ({
    id,
    channel_id: channelId,
    author: { id: authorId, username: "user" },
    content: "hi",
    attachments: [],
    embeds: [],
    timestamp: new Date().toISOString(),
  });

  // First dispatch delivers through the shared pipeline.
  handleMessageCreate(st, d("9000000000000000001"));
  expect(seen.map((m) => m.messageId)).toEqual(["9000000000000000001"]);
  expect(seen[0].fromId).toBe("u-9");
  expect(seen[0].body).toBe("hi");

  // Duplicate id → dropped (cursor already at/above it).
  handleMessageCreate(st, d("9000000000000000001"));
  expect(seen.length).toBe(1);

  // Own message (READY identity) → skipped.
  handleMessageCreate(st, d("9000000000000000003", "bot-g"));
  // Channel not in config → skipped.
  handleMessageCreate(st, d("9000000000000000004", "u-9", "424242"));
  expect(seen.length).toBe(1);

  // Poll backfill: g1 below cursor dropped, g2 delivered exactly once.
  await pollDiscord("gw");
  await tick();
  expect(seen.map((m) => m.messageId)).toEqual([
    "9000000000000000001",
    "9000000000000000002",
  ]);

  // Second backfill tick: everything at/below cursor → nothing new.
  await pollDiscord("gw");
  await tick();
  expect(seen.map((m) => m.messageId)).toEqual([
    "9000000000000000001",
    "9000000000000000002",
  ]);
});

test("backfill batch of 3 is delivered oldest-first; cursor ends at newest", async () => {
  const seen: string[] = [];
  const afters: string[] = [];
  setFetch(async (u) => {
    if (u.endsWith("/users/@me")) return jsonResp(200, { id: "bot-b" });
    if (u.includes("/messages?limit=1"))
      // connectDiscord seeds the cursor here (id 100, below the burst).
      return jsonResp(200, [userMsg("100", "u-3")]);
    if (u.includes("/messages")) {
      const m = u.match(/after=([^&]+)/);
      if (m) afters.push(m[1]);
      // Burst of 3, ascending ids, all above the cursor.
      return jsonResp(200, [
        userMsg("101", "u-3"),
        userMsg("102", "u-3"),
        userMsg("103", "u-3"),
      ]);
    }
    return jsonResp(200, null);
  });

  const ok = await connectDiscord(cfg("burst"), {
    onMessage: (msg) => seen.push(msg.messageId),
    onError: () => {},
  });
  expect(ok).toBe(true);

  // Backfill burst: every message must be delivered, in order.
  await pollDiscord("burst");
  await tick();
  expect(seen).toEqual(["101", "102", "103"]);
  // Cursor ends at the newest id.
  const st = getDiscordStates().get("burst");
  expect(st?.lastMessageId).toBe("103");

  // Next poll queries after the newest cursor and delivers nothing new.
  await pollDiscord("burst");
  await tick();
  expect(afters).toEqual(["100", "103"]);
  expect(seen).toEqual(["101", "102", "103"]);
});

test("poll interval constants: 5s fast, 60s backfill", () => {
  expect(POLL_INTERVAL_MS).toBe(5000);
  expect(POLL_BACKFILL_MS).toBe(60000);
});

// ─── T1: reply context (referenced_message) ─────────────────────────────

test("referenced_message → repliedMessage on inbound (T1)", async () => {
  const seen: any[] = [];
  setFetch(async (u) => {
    if (u.endsWith("/users/@me")) return jsonResp(200, { id: "bot-r" });
    if (u.includes("/messages?limit=1"))
      return jsonResp(200, [userMsg("500", "u-1")]);
    if (u.includes("/messages")) {
      return jsonResp(200, [
        {
          ...userMsg("501", "u-1"),
          referenced_message: {
            id: "500",
            content: "what is this about <@123> & stuff",
            author: {
              id: "u-2",
              global_name: "Ref Author",
              username: "refauthor",
            },
          },
        },
      ]);
    }
    return jsonResp(200, null);
  });
  await connectDiscord(cfg("r1"), {
    onMessage: (m) => seen.push(m),
    onError: () => {},
  });
  await pollDiscord("r1");
  await tick();
  expect(seen.length).toBe(1);
  expect(seen[0].repliedMessage).toEqual({
    author: "Ref Author",
    text: "what is this about <@123> & stuff",
  });
});

test("gateway reply carries repliedMessage too (T1)", () => {
  const st = ensurePresenceState("tok-r1");
  st.botUserId = "bot-r2";
  const states = getDiscordStates();
  // Reuse a live state if one exists from the poll test; else build minimal.
  const state =
    states.get("r1") ||
    ({
      config: cfg("r1") as any,
      channelId: "999",
      botUserId: "bot-r2",
      lastMessageId: null,
      stateDir: null,
      pollTimer: null,
      consecutiveErrors: 0,
      pollPauseUntil: 0,
      polling: false,
      callbacks: { onMessage: () => {}, onError: () => {} },
      startupPending: false,
    } as any);
  if (!states.has("r1")) states.set("r1", state);
  const seen: any[] = [];
  state.callbacks.onMessage = (m: any) => seen.push(m);
  state.lastMessageId = null;
  handleMessageCreate(st, {
    id: "510",
    channel_id: "999",
    author: { id: "u-1", username: "user" },
    content: "the thing you said",
    referenced_message: {
      id: "509",
      content: "original text",
      author: { id: "u-9", username: "other" },
    },
    attachments: [],
    embeds: [],
    timestamp: new Date().toISOString(),
  });
  expect(seen.length).toBe(1);
  expect(seen[0].repliedMessage).toEqual({
    author: "other",
    text: "original text",
  });
});

// ─── T3: other-bot filter ─────────────────────────────────────────────────

test("other bots are skipped; cursor still advances (T3)", async () => {
  const seen: string[] = [];
  setFetch(async (u) => {
    if (u.endsWith("/users/@me")) return jsonResp(200, { id: "bot-o" });
    if (u.includes("/messages")) {
      return jsonResp(200, [
        {
          ...userMsg("601", "bot-other"),
          author: { id: "bot-other", username: "otherbot", bot: true },
        },
        { ...userMsg("602", "u-1") },
      ]);
    }
    return jsonResp(200, null);
  });
  await connectDiscord(cfg("o1"), {
    onMessage: (m) => seen.push(m.messageId),
    onError: () => {},
  });
  await pollDiscord("o1");
  await tick();
  expect(seen).toEqual(["602"]);
  // Cursor advanced past the skipped bot message.
  expect(getDiscordStates().get("o1")?.lastMessageId).toBe("602");
});

test("pi-bg webhook ([bg:, author.bot, webhook_id) is delivered; plain bot msg skipped", async () => {
  const seen: any[] = [];
  setFetch(async (u) => {
    if (u.endsWith("/users/@me")) return jsonResp(200, { id: "bot-w" });
    if (u.includes("/messages?limit=1"))
      return jsonResp(200, [userMsg("600", "u-1")]);
    if (u.includes("/messages")) {
      return jsonResp(200, [
        // Realistic pi-bg dispatch webhook payload.
        {
          id: "611",
          author: { id: "1546765929298272346", username: "monky", bot: true },
          webhook_id: "1546765929298272346",
          content: "[bg:worker:OK] task 42 done",
          attachments: [],
          embeds: [],
          timestamp: new Date().toISOString(),
        },
        // Plain bot message (no [bg: prefix) — still skipped.
        {
          ...userMsg("612", "bot-other"),
          author: { id: "bot-other", username: "otherbot", bot: true },
        },
        // Webhook author id but human content — not a dispatch wake.
        {
          ...userMsg("613", "1546765929298272346"),
          author: { id: "1546765929298272346", username: "monky", bot: true },
          webhook_id: "1546765929298272346",
          content: "just a webhook note",
        },
      ]);
    }
    return jsonResp(200, null);
  });
  await connectDiscord(cfg("o2"), {
    onMessage: (m) => seen.push(m),
    onError: () => {},
  });
  await pollDiscord("o2");
  await tick();
  // Only the [bg: webhook message reached the handler — the dispatch wake.
  expect(seen.map((m) => m.messageId)).toEqual(["611"]);
  expect(seen[0].body).toBe("[bg:worker:OK] task 42 done");
  // Cursor advanced past all three.
  expect(getDiscordStates().get("o2")?.lastMessageId).toBe("613");
});

test("peer bot (author.id in peerBotIds) is delivered; other bots still skipped", async () => {
  const seen: string[] = [];
  setFetch(async (u) => {
    if (u.endsWith("/users/@me")) return jsonResp(200, { id: "bot-p" });
    if (u.includes("/messages?limit=1"))
      return jsonResp(200, [userMsg("700", "u-1")]);
    if (u.includes("/messages")) {
      return jsonResp(200, [
        // agent-say: peer agent posting as its own bot — allowed through.
        {
          ...userMsg("701", "peer-1"),
          author: { id: "peer-1", username: "frank", bot: true },
          content: "[from frank] check this",
        },
        // Bot not in peerBotIds — still filtered.
        {
          ...userMsg("702", "bot-other"),
          author: { id: "bot-other", username: "otherbot", bot: true },
        },
        // Human — always delivered.
        { ...userMsg("703", "u-1") },
      ]);
    }
    return jsonResp(200, null);
  });
  await connectDiscord(cfg("o3", { peerBotIds: ["peer-1"] }), {
    onMessage: (m) => seen.push(m.messageId),
    onError: () => {},
  });
  await pollDiscord("o3");
  await tick();
  expect(seen).toEqual(["701", "703"]);
  expect(getDiscordStates().get("o3")?.lastMessageId).toBe("703");
});

// ─── T4: cursor persistence ───────────────────────────────────────────────

test("cursor persists to channel-state.json and seeds the next connect (T4)", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "piscord-cursor-"));
  const seeds: string[] = [];
  const afters: string[] = [];
  try {
    setFetch(async (u) => {
      if (u.endsWith("/users/@me")) return jsonResp(200, { id: "bot-c" });
      if (u.includes("/messages?limit=1")) {
        seeds.push("seed");
        return jsonResp(200, [userMsg("700", "u-1")]);
      }
      if (u.includes("/messages")) {
        const m = u.match(/after=([^&]+)/);
        if (m) afters.push(m[1]);
        return jsonResp(200, [userMsg("701", "u-1")]);
      }
      return jsonResp(200, null);
    });

    // First run: no saved cursor → limit=1 seed (700); deliver 701.
    const seen: string[] = [];
    await connectDiscord(
      cfg("c1"),
      { onMessage: (m) => seen.push(m.messageId), onError: () => {} },
      dir,
    );
    await pollDiscord("c1");
    await tick();
    expect(seen).toEqual(["701"]);
    expect(seeds).toEqual(["seed"]);
    // Persisted to disk under the discord channel id.
    expect(loadPersistedCursors(dir)["999"]).toBe("701");
    // Atomic write left no temp file behind; the file itself is valid JSON.
    expect(fs.existsSync(path.join(dir, "channel-state.json.tmp"))).toBe(false);
    const onDisk = JSON.parse(
      fs.readFileSync(path.join(dir, "channel-state.json"), "utf-8"),
    );
    expect(onDisk["999"]).toBe("701");
    disconnectDiscord("c1");

    // Second run: cursor seeded from disk — no limit=1 reseed, and the
    // first poll queries after the persisted cursor.
    const seen2: string[] = [];
    await connectDiscord(
      cfg("c1"),
      { onMessage: (m) => seen2.push(m.messageId), onError: () => {} },
      dir,
    );
    expect(seeds).toEqual(["seed"]); // no reseed
    await pollDiscord("c1");
    await tick();
    expect(afters).toContain("701");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("loadPersistedCursors: missing/corrupt file → {} (T4)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "piscord-cursor2-"));
  try {
    expect(loadPersistedCursors(dir)).toEqual({});
    fs.writeFileSync(path.join(dir, "channel-state.json"), "{not json");
    expect(loadPersistedCursors(dir)).toEqual({});
    expect(loadPersistedCursors(null)).toEqual({});
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ─── T5: ping suppression on outbound ────────────────────────────────────

test("outbound: silent by default; real <@id> keeps users parse (T5)", async () => {
  const bodies: any[] = [];
  setFetch(async (u, init) => {
    if (init?.method === "POST" && u.includes("/messages")) {
      bodies.push(JSON.parse(init.body));
      return jsonResp(200, { id: "x" });
    }
    return jsonResp(200, null);
  });
  expect(allowedMentionsFor("plain text")).toEqual({ parse: [] });
  expect(allowedMentionsFor("hi <@5> and <@!9>")).toEqual({
    parse: ["users"],
    users: ["5", "9"],
  });

  await sendDiscordMessage(cfg("p1"), "echoed @everyone <@999> back");
  expect(bodies[0].allowed_mentions).toEqual({
    parse: ["users"],
    users: ["999"],
  });
  await sendDiscordMessage(cfg("p1"), "no mention here @everyone");
  expect(bodies[1].allowed_mentions).toEqual({ parse: [] });
});

// ─── T2: outbound file upload ─────────────────────────────────────────────

test("sendFilesToDiscord: multipart payload, MIME, 25 MB gate, missing file (T2)", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "piscord-files-"));
  let captured: { u: string; init: any } | null = null;
  try {
    const a = path.join(dir, "a.png");
    fs.writeFileSync(a, "png-bytes");
    const big = path.join(dir, "big.bin");
    const fd = fs.openSync(big, "w");
    fs.ftruncateSync(fd, 26 * 1024 * 1024);
    fs.closeSync(fd);

    setFetch(async (u, init) => {
      captured = { u, init };
      return jsonResp(200, { id: "sent" });
    });

    const r = await sendFilesToDiscord("999", [a], "tok");
    expect(r.success).toBe(true);
    expect(captured!.u).toContain("/channels/999/messages");
    expect(captured!.init.headers.Authorization).toBe("Bot tok");
    expect(captured!.init.body).toBeInstanceOf(FormData);
    const payload = JSON.parse(captured!.init.body.get("payload_json"));
    expect(payload.attachments).toEqual([{ id: 0, filename: "a.png" }]);
    const part = captured!.init.body.get("files[0]");
    expect((part as Blob).type).toBe("image/png");
    expect((part as File).name).toBe("a.png");

    // 25 MB gate fires before any network call.
    const r2 = await sendFilesToDiscord("999", [big], "tok");
    expect(r2.success).toBe(false);
    expect(r2.error).toContain("25 MB");

    // Missing file.
    const r3 = await sendFilesToDiscord(
      "999",
      [path.join(dir, "nope.txt")],
      "tok",
    );
    expect(r3.success).toBe(false);
    expect(r3.error).toContain("Cannot read file");

    // Unreadable file mid-loop (a directory passes the stat pre-check but
    // readFileSync throws): clear error, no throw, even though the first
    // file was already appended to the form.
    const sub = path.join(dir, "sub");
    fs.mkdirSync(sub);
    let threw = false;
    let r4: { success: boolean; error?: string } | null = null;
    try {
      r4 = await sendFilesToDiscord("999", [a, sub], "tok");
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
    expect(r4?.success).toBe(false);
    expect(r4?.error).toContain("Cannot read file");
    expect(r4?.error).toContain("sub");

    // Empty list is a no-op success.
    expect(await sendFilesToDiscord("999", [], "tok")).toEqual({
      success: true,
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("mimeForFile maps common types, defaults to octet-stream (T2)", () => {
  expect(mimeForFile("x.PNG")).toBe("image/png");
  expect(mimeForFile("x.mp4")).toBe("video/mp4");
  expect(mimeForFile("x.unknownext")).toBe("application/octet-stream");
});

// ─── Slash commands: guild-scoped registration + defer-first ack helpers ──

const interaction = { id: "i1", token: "tok123", application_id: "app1" };

test("registerDiscordCommands is per-guild, logs failures, keeps the rest (G1)", async () => {
  const puts: { url: string; body: any }[] = [];
  setFetch(async (u, init) => {
    const method = init?.method || "GET";
    if (u.endsWith("/applications/@me")) return jsonResp(200, { id: "app1" });
    if (u.endsWith("/users/@me/guilds")) {
      return jsonResp(200, [
        { id: "g1", name: "One" },
        { id: "g2", name: "Two" },
      ]);
    }
    if (method === "PUT" && u.includes("/guilds/g2/commands"))
      return jsonResp(403, { error: "nope" });
    if (method === "PUT" && u.endsWith("/guilds/g1/commands")) {
      puts.push({ url: u, body: JSON.parse(init.body) });
      return jsonResp(200, null);
    }
    return jsonResp(200, null);
  });

  await registerDiscordCommands("tok-reg"); // must not throw on the failing guild

  // Text-only mode: one empty PUT per guild (clears the slash menu);
  // the legacy global list is cleared too (no per-command names).
  expect(puts.length).toBe(1);
  expect(puts[0].url).toBe(
    "https://discord.com/api/v10/applications/app1/guilds/g1/commands",
  );
  expect(puts[0].body).toEqual([]);
});

test("registerDiscordCommands skips cleanly with no guilds", async () => {
  const seen: string[] = [];
  setFetch(async (u) => {
    seen.push(u);
    if (u.endsWith("/applications/@me")) return jsonResp(200, { id: "app1" });
    if (u.endsWith("/users/@me/guilds")) return jsonResp(200, []);
    return jsonResp(200, null);
  });
  await registerDiscordCommands("tok-dm");
  expect(seen.some((u) => u.includes("/commands"))).toBe(false);
});

test("deferInteraction posts callback type 5; editInteractionMessage PATCHes @original (P0)", async () => {
  const calls: { url: string; method: string; body: any }[] = [];
  setFetch(async (u, init) => {
    calls.push({
      url: u,
      method: init?.method ?? "GET",
      body: JSON.parse(init.body),
    });
    return jsonResp(200, { id: "m" });
  });

  await deferInteraction("tok-d", interaction);
  expect(calls[0].url).toBe(
    "https://discord.com/api/v10/interactions/i1/tok123/callback",
  );
  expect(calls[0].body).toEqual({ type: 5 });

  await editInteractionMessage("tok-d", interaction, "result");
  expect(calls[1].url).toBe(
    "https://discord.com/api/v10/webhooks/app1/tok123/messages/@original",
  );
  expect(calls[1].method).toBe("PATCH");
  expect(calls[1].body).toEqual({ content: "result" });

  await respondToInteraction("tok-d", interaction, "plain");
  expect(calls[2].body).toEqual({ type: 4, data: { content: "plain" } });
});

test("isBgWebhook exempts pi-bg dispatch callbacks (content prefix or embed-only)", () => {
  // legacy plain-text callback
  expect(
    isBgWebhook({
      webhook_id: "w1",
      content: "[bg:worker:OK] task...",
      author: { bot: true },
    }),
  ).toBe(true);
  // embed-only callback (Variant D): no top-level content, identified by embed author
  expect(
    isBgWebhook({
      webhook_id: "w1",
      content: "",
      author: { bot: true },
      embeds: [
        { author: { name: "pi-bg ticket \u00b7 20260909-023328-9001" } },
      ],
    }),
  ).toBe(true);
  // non-webhook bot message with [bg: text is not exempt
  expect(isBgWebhook({ content: "[bg:x]", author: { bot: true } })).toBe(false);
  // webhook without the pi-bg markers is not exempt
  expect(
    isBgWebhook({ webhook_id: "w1", content: "hello", author: { bot: true } }),
  ).toBe(false);
  expect(
    isBgWebhook({
      webhook_id: "w1",
      content: "",
      author: { bot: true },
      embeds: [{ author: { name: "other thing" } }],
    }),
  ).toBe(false);
  expect(isBgWebhook(null)).toBe(false);
});
