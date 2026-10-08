import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { WebSocketServer } from "ws";
import { clearRegistryCache } from "./censor";
import {
  allowedMentionsFor,
  clearDiscordStatesForTest,
  connectDiscord,
  connectDiscordPresence,
  deferInteraction,
  deleteDeferredAck,
  disconnectDiscord,
  discordFetch,
  editInteractionMessage,
  ensurePresenceState,
  getChannelCursor,
  getDiscordStates,
  handleMessageCreate,
  handleMessageDelete,
  handleMessageUpdate,
  interactionUserId,
  interactionUserName,
  isBgWebhook,
  loadChannelStateFile,
  loadPersistedCursors,
  mimeForFile,
  POLL_BACKFILL_MS,
  POLL_INTERVAL_MS,
  parseGatewayPayload,
  patchChannelState,
  persistChannelCursor,
  pollDiscord,
  quoteLongIntegers,
  registerDiscordCommands,
  replyInteraction,
  resolveChannelId,
  respondToInteraction,
  SLASH_COMMANDS,
  seedChannelStateForTest,
  sendDiscordMessage,
  sendFilesToDiscord,
  sendInteractionFollowup,
  setChannelCursor,
  setDiscordInteractionHandler,
  stopDiscordPresence,
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
    "qu",
    "ip",
    "cs",
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
  // Let the connect-time immediate first poll finish before we simulate
  // gateway traffic (the per-channel polling guard would otherwise make
  // the explicit pollDiscord calls below no-ops racing it).
  await tick();

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
    // Persisted to disk under the discord channel id (cursors section).
    expect(loadPersistedCursors(dir)["999"]).toBe("701");
    // Atomic write left no temp file behind; the file itself is valid JSON.
    expect(fs.existsSync(path.join(dir, "channel-state.json.tmp"))).toBe(false);
    const onDisk = JSON.parse(
      fs.readFileSync(path.join(dir, "channel-state.json"), "utf-8"),
    );
    expect(onDisk.cursors["999"]).toBe("701");
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

// ─── Per-channel state file: cursors + runtime flags share one store ───

test("legacy flat cursor file still loads (T4 compat)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "piscord-cursor3-"));
  try {
    fs.writeFileSync(
      path.join(dir, "channel-state.json"),
      JSON.stringify({ "999": "701", "888": "600" }),
    );
    const st = loadChannelStateFile(dir);
    expect(st.cursors).toEqual({ "999": "701", "888": "600" });
    expect(st.channels).toEqual({});
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("patchChannelState + persistChannelCursor preserve each other (T4)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "piscord-cursor4-"));
  try {
    // Flag first, then a cursor write must not clobber it.
    patchChannelState(dir, "discord-monky", { hold: true });
    patchChannelState(dir, "discord-monky", { hold: false });
    patchChannelState(dir, "discord-monky", { verbose: 1 });
    seedChannelStateForTest("c1", "999", dir);
    const s: any = getDiscordStates().get("c1");
    s.lastMessageId = "701";
    persistChannelCursor(s);
    const st = loadChannelStateFile(dir);
    expect(st.cursors["999"]).toBe("701");
    expect(st.channels["discord-monky"]).toEqual({ hold: false, verbose: 1 });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("patchChannelState: corrupt file starts fresh, keeps nothing (T4)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "piscord-cursor5-"));
  try {
    fs.writeFileSync(path.join(dir, "channel-state.json"), "{not json");
    patchChannelState(dir, "discord-monky", { hold: true });
    const st = loadChannelStateFile(dir);
    expect(st.channels["discord-monky"]?.hold).toBe(true);
    expect(st.cursors).toEqual({});
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
    users: ["5", "9"],
  });

  await sendDiscordMessage(cfg("p1"), "echoed @everyone <@999> back");
  expect(bodies[0].allowed_mentions).toEqual({
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
    expect(r4!.success).toBe(false);
    expect(r4!.error).toContain("Cannot read file");
    expect(r4!.error).toContain("sub");

    // Empty list is a no-op success.
    expect(await sendFilesToDiscord("999", [], "tok")).toEqual({
      success: true,
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("sendFilesToDiscord: registry-literal filename is redacted in the API-facing payload_json (secret censor)", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "piscord-censor-"));
  const reg = path.join(dir, "secrets.txt");
  fs.writeFileSync(reg, "trailsecret.txt\n");
  const file = path.join(dir, "trailsecret.txt");
  fs.writeFileSync(file, "bytes");
  const prevEnv = process.env.JARATE_SECRETS_FILE;
  let captured: { init: any } | null = null;
  try {
    process.env.JARATE_SECRETS_FILE = reg;
    clearRegistryCache();
    setFetch(async (_u, init) => {
      captured = { init };
      return jsonResp(200, { id: "sent" });
    });
    const r = await sendFilesToDiscord("999", [file], "tok");
    expect(r.success).toBe(true);
    expect(captured!.init.body).toBeInstanceOf(FormData);
    // payload_json carries the API-facing name — the Discord API returns
    // it as attachments[].filename, so the raw literal must be gone.
    const payload = JSON.parse(captured!.init.body.get("payload_json"));
    expect(payload.attachments[0].filename).toBe("[REDACTED:secret#1]");
    expect(JSON.stringify(payload)).not.toContain("trailsecret");
    // and the multipart file part name is redacted too
    expect((captured!.init.body.get("files[0]") as File).name).toBe(
      "[REDACTED:secret#1]",
    );
  } finally {
    if (prevEnv === undefined) delete process.env.JARATE_SECRETS_FILE;
    else process.env.JARATE_SECRETS_FILE = prevEnv;
    clearRegistryCache();
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
    if (method === "PUT" && u.endsWith("/applications/app1/commands")) {
      puts.push({ url: u, body: JSON.parse(init.body) });
      return jsonResp(200, null);
    }
    return jsonResp(200, null);
  });

  await registerDiscordCommands("tok-reg"); // must not throw on the failing guild

  // Native slash menu re-enabled (#169): the healthy guild's PUT carries
  // the FULL command list (guild-scoped = instant); the failing guild is
  // skipped, the rest keep going.
  expect(puts.length).toBe(2);
  expect(puts[0].url).toBe(
    "https://discord.com/api/v10/applications/app1/guilds/g1/commands",
  );
  expect(puts[0].body).toEqual(SLASH_COMMANDS);
  // Legacy global list stays cleared: guild scope is the only source.
  expect(puts[1].url).toBe(
    "https://discord.com/api/v10/applications/app1/commands",
  );
  expect(puts[1].body).toEqual([]);

  // Idempotent on every boot: a second run PUTs the identical list.
  puts.length = 0;
  await registerDiscordCommands("tok-reg");
  expect(puts.length).toBe(2);
  expect(puts[0].body).toEqual(SLASH_COMMANDS);
  expect(puts[1].body).toEqual([]);
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

// issue #169 — the socket/handler seam, hermetically: a fake gateway
// WebSocketServer stands in for Discord. Proves (1) IDENTIFY requests the
// INTERACTIONS intent (the original parking bug: without it, the server
// never sends INTERACTION_CREATE frames) and (2) a type-1
// INTERACTION_CREATE frame on the wire reaches the handler registered via
// setDiscordInteractionHandler. This test fails against the pre-5431caed
// code (missing intent bit + event name INTERACTIONS_CREATE, plural).
test("gateway seam: IDENTIFY has INTERACTIONS intent; type-1 frame reaches the handler (#169)", async () => {
  const token = "tok-seam-169";
  const wss = new WebSocketServer({ port: 0 });
  const port = (wss.address() as { port: number }).port;
  const identified: any[] = [];
  const frames: any[] = [];
  wss.on("connection", (sock) => {
    sock.on("message", (data: any) => {
      const m = JSON.parse(String(data));
      frames.push(m);
      if (m.op === 2) {
        identified.push(m.d);
        sock.send(
          JSON.stringify({ op: 10, d: { heartbeat_interval: 41000, seq: 1 } }),
        );
        sock.send(
          JSON.stringify({
            op: 0,
            s: 2,
            t: "READY",
            d: { user: { id: "bot9" }, session_id: "sess9" },
          }),
        );
        sock.send(
          JSON.stringify({
            op: 0,
            s: 3,
            t: "INTERACTION_CREATE",
            d: {
              type: 1,
              id: "ix9",
              token: "ixtok",
              application_id: "app9",
              channel_id: "888",
              guild_id: "g9",
              user: { id: "u9" },
              data: { id: "cmd9", name: "help" },
            },
          }),
        );
      } else if (m.op === 11) {
        sock.send(JSON.stringify({ op: 1, d: m.d }));
      }
    });
  });

  const received: any[] = [];
  setDiscordInteractionHandler(token, (d) => received.push(d));
  const savedGateway = process.env.DISCORD_GATEWAY_URL;
  process.env.DISCORD_GATEWAY_URL = `ws://127.0.0.1:${port}`;

  try {
    await connectDiscordPresence(token);
    // poll: the frame lands right after READY
    const t0 = Date.now();
    while (received.length === 0 && Date.now() - t0 < 5000) await tick(25);

    expect(identified.length).toBe(1);
    expect(identified[0].intents & 0x2, "INTERACTIONS intent bit").toBe(0x2);
    expect(received.length).toBe(1);
    expect(received[0].data.name).toBe("help");
    expect(received[0].type).toBe(1);
    expect(received[0].channel_id).toBe("888");
  } finally {
    if (savedGateway === undefined) delete process.env.DISCORD_GATEWAY_URL;
    else process.env.DISCORD_GATEWAY_URL = savedGateway;
    stopDiscordPresence(token);
    wss.close();
  }
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
  // flags 64: ephemeral loading state — the "Thinking" ack is tapper-only
  // (was channel-visible; #207). One-line update to the pinned body.
  expect(calls[0].body).toEqual({ type: 5, flags: 64 });

  await editInteractionMessage("tok-d", interaction, "result");
  expect(calls[1].url).toBe(
    "https://discord.com/api/v10/webhooks/app1/tok123/messages/@original",
  );
  expect(calls[1].method).toBe("PATCH");
  expect(calls[1].body).toEqual({ content: "result" });

  await respondToInteraction("tok-d", interaction, "plain");
  expect(calls[2].body).toEqual({ type: 4, data: { content: "plain" } });
});

// ─── Interaction followup + gateway snowflake precision (RCA 2026-10-08) ──

test("sendInteractionFollowup POSTs the webhook ROOT (Create Followup), not /messages (RCA 2026-10-08)", async () => {
  const calls: { url: string; method: string; body: any }[] = [];
  setFetch(async (u, init) => {
    calls.push({
      url: u,
      method: init?.method ?? "GET",
      body: JSON.parse(init.body),
    });
    return jsonResp(200, { id: "m" });
  });
  await sendInteractionFollowup("tok-d", interaction, "done", {
    ephemeral: true,
  });
  expect(calls.length).toBe(1);
  // The /webhooks/{app}/{token}/messages form is the INCOMING-webhook
  // "Execute Webhook" route; interaction tokens reject it with 400 50035.
  expect(calls[0].url).toBe("https://discord.com/api/v10/webhooks/app1/tok123");
  expect(calls[0].method).toBe("POST");
  expect(calls[0].body).toEqual({ content: "done", flags: 64 });
});

test("replyInteraction PATCHes @original, visible by default (RCA 2026-10-08)", async () => {
  const calls: { url: string; method: string; body: any }[] = [];
  setFetch(async (u, init) => {
    calls.push({
      url: u,
      method: init?.method ?? "GET",
      body: JSON.parse(init.body),
    });
    return jsonResp(204, null);
  });
  await replyInteraction("tok-d", interaction, "[!] tap rejected: mismatch");
  expect(calls.length).toBe(1);
  expect(calls[0].url).toBe(
    "https://discord.com/api/v10/webhooks/app1/tok123/messages/@original",
  );
  expect(calls[0].method).toBe("PATCH");
  expect(calls[0].body).toEqual({ content: "[!] tap rejected: mismatch" });
  // Visible to the whole channel: no ephemeral flag.
  expect(calls[0].body.flags).toBeUndefined();

  await replyInteraction("tok-d", interaction, "secret", { ephemeral: true });
  expect(calls[1].body.flags).toBe(64);
});

test("replyInteraction falls back to webhook-ROOT followup when @original is gone (RCA 2026-10-08)", async () => {
  const calls: { url: string; method: string }[] = [];
  setFetch(async (u, init) => {
    calls.push({ url: u, method: init?.method ?? "GET" });
    if (u.endsWith("/messages/@original"))
      return jsonResp(404, { message: "Unknown Message" });
    return jsonResp(200, { id: "m" });
  });
  await replyInteraction("tok-d", interaction, "still visible");
  expect(calls.length).toBe(2);
  expect(calls[0].method).toBe("PATCH");
  expect(calls[1].url).toBe("https://discord.com/api/v10/webhooks/app1/tok123");
  expect(calls[1].method).toBe("POST");
});

test("parseGatewayPayload: bare 16+ digit ints -> exact strings; everything else untouched (RCA 2026-10-08)", () => {
  const raw =
    '{"op":0,"s":1,"d":{"id":1557766848009994272,"channel_id":1557766848009994272},"n":42,"f":1.5e18,"neg":-1557766848009994272,"str":"1557766848009994272 and 1557766848009994273","arr":[1234567890123456789]}';
  const p = parseGatewayPayload(raw);
  expect(p.d.id).toBe("1557766848009994272");
  expect(p.d.channel_id).toBe("1557766848009994272");
  expect(p.n).toBe(42); // short ints untouched
  expect(p.f).toBe(1.5e18); // floats untouched
  expect(p.neg).toBe("-1557766848009994272"); // sign folded into the string
  expect(p.str).toBe("1557766848009994272 and 1557766848009994273"); // string contents untouched
  expect(p.arr[0]).toBe("1234567890123456789");
  // plain JSON.parse rounds the same text — that is the bug this prevents
  expect(JSON.parse(raw).d.id).not.toBe("1557766848009994272");
});

test("interactionUserId/interactionUserName: member.user fallback (live guild capture 2026-10-08)", () => {
  // live shape: guild INTERACTION_CREATE has NO top-level user
  expect(interactionUserId({ member: { user: { id: "u2" } } })).toBe("u2");
  expect(interactionUserId({ user: { id: "u1" } })).toBe("u1");
  expect(
    interactionUserId({ user: { id: "u1" }, member: { user: { id: "u2" } } }),
  ).toBe("u1"); // top-level wins when both present
  expect(interactionUserId({})).toBe("");
  expect(interactionUserId(undefined)).toBe("");
  expect(interactionUserName({ member: { user: { username: "x" } } })).toBe(
    "x",
  );
  expect(interactionUserName({})).toBeUndefined();
});

test("parseGatewayPayload fast path: no 16+ digit run -> plain JSON.parse (RCA 2026-10-08)", () => {
  const raw = '{"op":0,"s":1,"d":{"id":"1557766848009994272","n":42}}';
  const p = parseGatewayPayload(raw);
  expect(p.d.id).toBe("1557766848009994272"); // already a string
  expect(p.d.n).toBe(42);
  expect(quoteLongIntegers('{"a":123}')).toBe('{"a":123}');
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

// ─── Queue control: MESSAGE_UPDATE / MESSAGE_DELETE gateway dispatch ─────

test("MESSAGE_UPDATE/DELETE dispatch routes to the channel callbacks", async () => {
  setFetch(async (u) => {
    if (u.endsWith("/users/@me")) return jsonResp(200, { id: "bot-qu" });
    if (u.includes("/messages")) return jsonResp(200, []);
    return jsonResp(200, null);
  });

  const updates: unknown[][] = [];
  const deletes: string[][] = [];
  const ok = await connectDiscord(cfg("qu"), {
    onMessage: () => {},
    onError: () => {},
    onMessageUpdate: (chId, msgId, content, atts, authorId) =>
      updates.push([chId, msgId, content, atts, authorId]),
    onMessageDelete: (chId, msgId) => deletes.push([chId, msgId]),
  });
  expect(ok).toBe(true);

  const st = ensurePresenceState("tok-qu");
  st.ready = true;
  st.botUserId = "bot-qu";

  // User edit: content + attachments + author forwarded.
  handleMessageUpdate(st, {
    id: "9100000000000000001",
    channel_id: "999",
    content: "edited text",
    attachments: [
      { id: "a1", filename: "f.txt", content_type: "text/plain", size: 1 },
    ],
    author: { id: "u-9", username: "user" },
  });
  expect(updates).toEqual([
    [
      "qu",
      "9100000000000000001",
      "edited text",
      [
        {
          id: "a1",
          filename: "f.txt",
          contentType: "text/plain",
          size: 1,
          url: undefined,
          duration: undefined,
          waveform: undefined,
        },
      ],
      "u-9",
    ],
  ]);

  // Edit without attachments → empty list.
  handleMessageUpdate(st, {
    id: "9100000000000000002",
    channel_id: "999",
    content: "plain edit",
    author: { id: "u-9", username: "user" },
  });
  expect(updates.length).toBe(2);
  expect(updates[1]?.[3]).toEqual([]);

  // Bot's own message (the bridge edits its status line) → skipped.
  handleMessageUpdate(st, {
    id: "9100000000000000003",
    channel_id: "999",
    content: "self edit",
    author: { id: "bot-qu", username: "bot" },
  });
  expect(updates.length).toBe(2);

  // Channel not in config → skipped.
  handleMessageUpdate(st, {
    id: "9100000000000000004",
    channel_id: "424242",
    content: "other channel",
    author: { id: "u-9", username: "user" },
  });
  expect(updates.length).toBe(2);

  // Delete: id + channel only (no author in the payload).
  handleMessageDelete(st, { id: "9100000000000000005", channel_id: "999" });
  expect(deletes).toEqual([["qu", "9100000000000000005"]]);
  handleMessageDelete(st, { id: "9100000000000000006", channel_id: "424242" });
  expect(deletes.length).toBe(1);
});

test("callbacks without update/delete handlers are no-ops", async () => {
  setFetch(async (u) => {
    if (u.endsWith("/users/@me")) return jsonResp(200, { id: "bot-qu" });
    if (u.includes("/messages")) return jsonResp(200, []);
    return jsonResp(200, null);
  });
  const ok = await connectDiscord(cfg("qu"), {
    onMessage: () => {},
    onError: () => {},
  });
  expect(ok).toBe(true);
  const st = ensurePresenceState("tok-qu");
  st.botUserId = "bot-qu";
  // No throw when the optional callbacks are absent.
  expect(() =>
    handleMessageUpdate(st, {
      id: "9200000000000000001",
      channel_id: "999",
      content: "x",
      author: { id: "u-9" },
    }),
  ).not.toThrow();
  expect(() =>
    handleMessageDelete(st, { id: "9200000000000000002", channel_id: "999" }),
  ).not.toThrow();
});

test("connectDiscord fires an immediate first backfill poll (restart replay path)", async () => {
  const urls: string[] = [];
  setFetch(async (u) => {
    urls.push(String(u));
    if (u.endsWith("/users/@me")) return jsonResp(200, { id: "bot-ip" });
    if (u.includes("/messages")) return jsonResp(200, []);
    return jsonResp(200, null);
  });
  const ok = await connectDiscord(cfg("ip"), {
    onMessage: () => {},
    onError: () => {},
  });
  expect(ok).toBe(true);
  // flush the fire-and-forget poll
  await tick();
  // a real backfill fetch happened without waiting for the 5s interval:
  // either the fresh-seed ?limit=1 (no persisted cursor) or a ranged poll
  const backfill = urls.find((u) => u.includes("/messages") && u.includes("?"));
  expect(backfill).toBeDefined();
  disconnectDiscord("ip");
});

test("getChannelCursor / setChannelCursor round-trip and persist", async () => {
  seedChannelStateForTest("cs", "777", null);
  expect(getChannelCursor("cs")).toBeNull();
  setChannelCursor("cs", "42");
  expect(getChannelCursor("cs")).toBe("42");
  clearDiscordStatesForTest();
  expect(getChannelCursor("cs")).toBeNull();
});

// ─── Tap-outcome observability (#204 / #207 / #210) ────────────────────────

test("deferInteraction body carries flags 64 — ephemeral loading state, tapper-only (#207)", async () => {
  const calls: { url: string; method: string; body: any }[] = [];
  setFetch(async (u, init) => {
    calls.push({
      url: u,
      method: init?.method ?? "GET",
      body: JSON.parse(init.body),
    });
    return jsonResp(204, null);
  });
  await deferInteraction("tok-d", interaction);
  expect(calls.length).toBe(1);
  expect(calls[0].method).toBe("POST");
  expect(calls[0].url).toBe(
    "https://discord.com/api/v10/interactions/i1/tok123/callback",
  );
  // flags 64 on a type-5 defer = ephemeral loading state. Callback
  // consumption is unchanged: still exactly one callback POST.
  expect(calls[0].body).toEqual({ type: 5, flags: 64 });
});

test("sendInteractionFollowup / replyInteraction report delivery; false on transport failure (#204)", async () => {
  setFetch(async () => jsonResp(200, { id: "m" }));
  expect(await sendInteractionFollowup("tok-d", interaction, "ok")).toBe(true);
  expect(await replyInteraction("tok-d", interaction, "ok")).toBe(true);

  setFetch(async () => jsonResp(503, { message: "stubbed outage" }));
  expect(await sendInteractionFollowup("tok-d", interaction, "x")).toBe(false);
  expect(await replyInteraction("tok-d", interaction, "x")).toBe(false);
});

test("discordFetch: 4xx body truncated to 200 by default, full with fullError (#210)", async () => {
  const body = {
    message: "Invalid Form Body",
    code: 50035,
    errors: {
      webhook_service: {
        _errors: [
          {
            code: "ENUM_TYPE_COERCE",
            message: `Value "${"m".repeat(350)}" is not a valid enum value.`,
          },
        ],
      },
    },
  };
  const full = JSON.stringify(body);
  expect(full.length).toBeGreaterThan(200);
  setFetch(async () => jsonResp(400, body));

  const errDefault = await discordFetch("tok-d", "/x", {
    method: "POST",
    body: {},
  }).catch((e: unknown) => e);
  expect(String(errDefault)).toContain(
    `Discord API 400: ${full.slice(0, 200)}`,
  );
  expect(String(errDefault)).not.toContain(full); // truncated

  const errFull = await discordFetch("tok-d", "/x", {
    method: "POST",
    body: {},
    fullError: true,
  }).catch((e: unknown) => e);
  expect(String(errFull)).toContain(full); // whole body kept
});

test("deferInteraction logs the FULL 4xx body on failure (interaction call site, #210)", async () => {
  const body = { message: "x".repeat(400), code: 50035 };
  const full = JSON.stringify(body);
  expect(full.length).toBeGreaterThan(200);
  setFetch(async () => jsonResp(400, body));
  const orig = console.error;
  const errs: string[] = [];
  console.error = (...a: unknown[]) => {
    errs.push(a.map((x) => String(x)).join(" "));
  };
  try {
    await deferInteraction("tok-d", interaction); // swallows the throw
  } finally {
    console.error = orig;
  }
  expect(errs.some((s) => s.includes(full))).toBe(true);
});

// ─── URL contract (issue #211, D4) ─────────────────────────────────────────
// Pinned routes the bridge must use for interaction traffic. Sources:
// developers/discord-api-docs:
//  - "Create Interaction Response" (receiving-and-responding)
//      POST   /interactions/{interaction.id}/{token}/callback
//  - "Create Followup Message" (webhooks) — the interaction webhook
//      POST   /webhooks/{application.id}/{token}
//    (the webhook ROOT — NOT .../messages, which is the Incoming Webhooks
//    route and 404s for interaction tokens; RCA 2026-10-08)
//  - "Edit Webhook Message" (webhooks)
//      PATCH  /webhooks/{application.id}/{token}/messages/{message.id}
//  - "Delete Webhook Message" (webhooks)
//      DELETE /webhooks/{application.id}/{token}/messages/{message.id}
// {message.id} is "@original" for the deferred ack created by
// deferInteraction. If a future edit changes any URL below, update the
// constant to match the current Discord docs — that is the point of
// pinning it.
const EXPECTED_ROUTES = {
  createInteractionResponse: "/interactions/{id}/{token}/callback",
  createFollowup: "/webhooks/{application_id}/{token}",
  editWebhookMessage:
    "/webhooks/{application_id}/{token}/messages/{message_id}",
  deleteWebhookMessage:
    "/webhooks/{application_id}/{token}/messages/{message_id}",
} as const;

function renderRoute(
  route: string,
  d: { id: string; token: string; application_id: string },
): string {
  return route
    .replaceAll("{id}", d.id)
    .replaceAll("{token}", d.token)
    .replaceAll("{application_id}", d.application_id)
    .replaceAll("{message_id}", "@original");
}

describe("URL contract (#211): interaction endpoints vs pinned Discord routes", () => {
  const realFetch = globalThis.fetch;
  const BASE = "https://discord.com/api/v10";

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test("callback + followup + edit + delete all match the pinned routes (no network)", async () => {
    const d = {
      id: "int-1",
      token: "tok-1",
      application_id: "app-1",
    } as any;
    const calls: Array<{ method: string; url: string }> = [];
    setFetch(async (url, init) => {
      calls.push({ method: init?.method ?? "GET", url });
      return jsonResp(204, null);
    });

    // The full interaction lifecycle, in order:
    await respondToInteraction("bot-tok", d, "ack"); // 1. ACK (type-6 reply)
    await deferInteraction("bot-tok", d); // 2. ACK (type-5 defer)
    await sendInteractionFollowup("bot-tok", d, "hello"); // 3. Create Followup
    await editInteractionMessage("bot-tok", d, "world"); // 4. Edit Webhook Message
    await deleteDeferredAck("bot-tok", d); // 5. Delete Webhook Message
    await replyInteraction("bot-tok", d, "final"); // 6. Edit Webhook Message

    expect(calls.map((c) => `${c.method} ${c.url.replace(BASE, "")}`)).toEqual([
      `POST ${renderRoute(EXPECTED_ROUTES.createInteractionResponse, d)}`,
      `POST ${renderRoute(EXPECTED_ROUTES.createInteractionResponse, d)}`,
      `POST ${renderRoute(EXPECTED_ROUTES.createFollowup, d)}`,
      `PATCH ${renderRoute(EXPECTED_ROUTES.editWebhookMessage, d)}`,
      `DELETE ${renderRoute(EXPECTED_ROUTES.deleteWebhookMessage, d)}`,
      `PATCH ${renderRoute(EXPECTED_ROUTES.editWebhookMessage, d)}`,
    ]);
  });

  test("Create Followup is the webhook ROOT — never the incoming-webhook .../messages route", async () => {
    const d = {
      id: "int-2",
      token: "tok-2",
      application_id: "app-2",
    } as any;
    const urls: string[] = [];
    setFetch(async (url) => {
      urls.push(url);
      return jsonResp(200, { id: "m1" });
    });

    await sendInteractionFollowup("bot-tok", d, "hello");

    expect(urls).toEqual([`${BASE}/webhooks/app-2/tok-2`]);
    // The RCA incident: POST .../webhooks/{app}/{token}/messages is the
    // Incoming Webhooks route — 404 "Unknown Webhook Message" for
    // interaction tokens.
    expect(urls[0].endsWith("/messages")).toBe(false);
  });
});
