/**
 * bin/agent-say — egress contract tests (issue #45 + 2026-09-20 gap fix).
 *
 * Runs the real bash script against a fake HOME with a stubbed curl
 * (captures the URL + payload) and a stubbed bun (censor pass-through),
 * and asserts the target-resolution + guard contract:
 *   - peer names resolve via ~/.config/agent-fleet/peers.json
 *   - unknown peers fail loudly (exit 2), never a silent curl 404
 *   - own channel is rejected (exit 3) — reply normally instead
 *   - numeric ids that are no known fleet peer are rejected (exit 4);
 *     AGENT_SAY_FORCE=1 bypasses (the 2026-09-20 mis-route vector: a
 *     channel id copied from context that is no agent's channel)
 *   - a message that does not name the target peer gets a [warn] on
 *     stderr (non-blocking nudge; human deliverables dropped into a peer
 *     channel usually do not address the peer)
 */
import { describe, expect, test } from "bun:test";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "bun";

const AGENT_SAY = path.join(import.meta.dir, "agent-say");

interface Fixture {
  tmp: string;
  home: string;
  bin: string;
  rt: string;
  capture: string;
  stdinCapture: string;
  env: Record<string, string>;
  setPeers: (obj: Record<string, string> | null) => void;
  run: (
    args: string[],
    stdin?: string,
    overrides?: Record<string, string>,
  ) => Promise<{ code: number; out: string; err: string }>;
}

function fixture(): Fixture {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agent-say-test-"));
  const home = path.join(tmp, "home");
  const bin = path.join(tmp, "bin");
  const capture = path.join(tmp, "curl-args.txt");
  const stdinCapture = path.join(tmp, "curl-stdin.txt");
  const rt = path.join(tmp, "rt"); // isolated XDG_RUNTIME_DIR (outbox home)
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(bin, { recursive: true });
  fs.mkdirSync(rt, { recursive: true });

  // bot token source — .channel is the caller's own Discord channel id
  // (used by the self-channel guard to reject agent-say to yourself)
  const agentDir = path.join(home, ".pi", "agent");
  fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(
    path.join(agentDir, "settings.json"),
    JSON.stringify({
      channels: [
        {
          type: "discord",
          id: "discord-test",
          channel: "111",
          botToken: "tok-111",
        },
      ],
    }),
  );

  // stub curl: record every arg (one per line) + the full stdin (issue #120:
  // the token now rides a curl config on stdin, not argv), answer with a msg id
  // that INCREMENTS per call (99, 100, ...): a dedupe test re-running agent-say
  // can tell a fresh POST (new id) from the receipt's id being re-echoed.
  // APPENDS to the capture so POSTs are countable across re-runs.
  // Failure injection (audit F5): CURL_FAIL_CALLS (space-separated call
  // numbers) makes those calls exit 3 like a real network failure;
  // CURL_RESP_FILE (if set) cats that file as the response body (for
  // Discord error JSONs without an .id).
  const curl = path.join(bin, "curl");
  fs.writeFileSync(
    curl,
    [
      "#!/bin/sh",
      '{ for a in "$@"; do printf \'%s\\n\' "$a"; done; } >> "$CURL_CAPTURE"',
      'cat > "$CURL_STDIN_CAPTURE"',
      'n=$(cat "$CURL_CALLS" 2>/dev/null || echo 0); n=$((n+1)); echo "$n" > "$CURL_CALLS"',
      'if [ -n "$CURL_FAIL_CALLS" ] && printf \'%s\\n\' $CURL_FAIL_CALLS | grep -qx "$n"; then',
      '  echo "curl: (7) Failed to connect" >&2',
      "  exit 3",
      "fi",
      'if [ -n "$CURL_RESP_FILE" ] && [ -f "$CURL_RESP_FILE" ]; then',
      '  cat "$CURL_RESP_FILE"',
      "  exit 0",
      "fi",
      'echo "{\\"id\\":\\"$((98+n))\\"}"',
      "",
    ].join("\n"),
  );
  fs.chmodSync(curl, 0o755);

  // stub bun: the censor is a pass-through (jarate-censor never blocks)
  const bunStub = path.join(bin, "bun");
  fs.writeFileSync(bunStub, "#!/bin/sh\ncat\n");
  fs.chmodSync(bunStub, 0o755);

  const env = { ...process.env } as Record<string, string>;
  // Ambient-env hygiene (audit F1): scrub the vars the script reads
  // (AGENT_SAY_*, JARATE_*, RAG_PROJECT) before the explicit fixture
  // values below, same explicit-scrub pattern as the dispatch #110
  // fixture. An ambient AGENT_SAY_FORCE=1 would bypass the allowlist
  // tests; PI_BOT_TOKEN is deleted below like the others.
  for (const k of Object.keys(env)) {
    if (
      k === "RAG_PROJECT" ||
      k.startsWith("JARATE_") ||
      k.startsWith("AGENT_SAY_")
    ) {
      delete env[k];
    }
  }
  env.HOME = home;
  env.PATH = `${bin}:${env.PATH ?? ""}`;
  env.CURL_CAPTURE = capture;
  env.CURL_STDIN_CAPTURE = stdinCapture;
  env.CURL_CALLS = path.join(tmp, "curl-calls.txt");
  env.XDG_RUNTIME_DIR = rt;
  delete env.PI_BOT_TOKEN;

  const peersFile = path.join(home, ".config", "agent-fleet", "peers.json");
  const setPeers = (obj: Record<string, string> | null) => {
    if (obj === null) {
      fs.rmSync(path.dirname(peersFile), { recursive: true, force: true });
      return;
    }
    fs.mkdirSync(path.dirname(peersFile), { recursive: true });
    fs.writeFileSync(peersFile, JSON.stringify(obj, null, 2));
  };

  const run = async (
    args: string[],
    stdin?: string,
    overrides?: Record<string, string>,
  ): Promise<{ code: number; out: string; err: string }> => {
    const p = spawn(["bash", AGENT_SAY, ...args], {
      env: { ...env, ...overrides },
      cwd: tmp,
      stdout: "pipe",
      stderr: "pipe",
      stdin: "pipe",
    });
    if (stdin !== undefined) {
      p.stdin?.write(stdin);
      p.stdin?.end();
    } else {
      p.stdin?.end();
    }
    const [out, err] = await Promise.all([
      new Response(p.stdout).text(),
      new Response(p.stderr).text(),
    ]);
    const code = await p.exited;
    return { code, out, err };
  };

  return { tmp, home, bin, rt, capture, stdinCapture, env, setPeers, run };
}

const curlUrl = (capture: string): string =>
  fs.existsSync(capture)
    ? (fs
        .readFileSync(capture, "utf8")
        .split("\n")
        .find((l) => l.startsWith("https://discord.com")) ?? "")
    : "";

// count of POST lines captured across (possibly) several agent-say runs —
// the dedupe tests' "was a second POST made" oracle
const postCount = (capture: string): number =>
  fs.existsSync(capture)
    ? fs
        .readFileSync(capture, "utf8")
        .split("\n")
        .filter((l) => l.startsWith("https://discord.com")).length
    : 0;

const outboxPath = (rt: string): string =>
  path.join(rt, "jarate", "agent-say-outbox.jsonl");

const readOutbox = (rt: string): Array<Record<string, unknown>> =>
  fs.existsSync(outboxPath(rt))
    ? fs
        .readFileSync(outboxPath(rt), "utf8")
        .trim()
        .split("\n")
        .filter((l) => l.length > 0)
        .map((l) => JSON.parse(l))
    : [];

const sha256 = (s: string): string =>
  crypto.createHash("sha256").update(s).digest("hex");

describe("agent-say peer resolution (#45)", () => {
  test("numeric channel id of a known peer sends", async () => {
    const f = fixture();
    f.setPeers({ monky: "1111111111111111111", frank: "2222222222222222222" });
    const r = await f.run(["1111111111111111111", "hello monky"]);
    expect(r.code).toBe(0);
    expect(r.out.trim()).toBe("sent 99");
    expect(curlUrl(f.capture)).toBe(
      "https://discord.com/api/v10/channels/1111111111111111111/messages",
    );
    // issue #120: the bot token from the fake settings.json is used, but it
    // rides curl's STDIN (a -K - config), NOT curl's argv (a bare `ps` used
    // to leak it)
    const argv = fs.readFileSync(f.capture, "utf8");
    expect(argv).not.toContain("tok-111");
    expect(argv).not.toContain("Authorization");
    expect(argv).toContain("-K");
    expect(argv).toContain("--max-time");
    expect(argv).toContain("15");
    expect(fs.readFileSync(f.stdinCapture, "utf8")).toContain(
      'header = "Authorization: Bot tok-111"',
    );
  });

  test("peer name resolves via ~/.config/agent-fleet/peers.json", async () => {
    const f = fixture();
    f.setPeers({ monky: "1111111111111111111", frank: "2222222222222222222" });
    const r = await f.run(["frank", "ping from monky"]);
    expect(r.code).toBe(0);
    expect(r.out.trim()).toBe("sent 99");
    expect(curlUrl(f.capture)).toBe(
      "https://discord.com/api/v10/channels/2222222222222222222/messages",
    );
  });

  test("unknown peer fails loudly with exit 2, no curl attempt", async () => {
    const f = fixture();
    f.setPeers({ monky: "1111111111111111111" });
    const r = await f.run(["jimmy", "hi"]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("unknown peer 'jimmy'");
    expect(r.err).toContain(".config/agent-fleet/peers.json");
    expect(fs.existsSync(f.capture)).toBe(false);
  });

  test("non-numeric target with no peers file -> exit 2", async () => {
    const f = fixture();
    f.setPeers(null);
    const r = await f.run(["frank", "hi"]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("unknown peer 'frank'");
  });

  test("peer mapped to a non-numeric value -> exit 2", async () => {
    const f = fixture();
    f.setPeers({ broken: "not-a-channel" });
    const r = await f.run(["broken", "hi"]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("unknown peer 'broken'");
  });

  test("- stdin form works with a peer name", async () => {
    const f = fixture();
    f.setPeers({ monky: "1111111111111111111" });
    const r = await f.run(["monky", "-"], "multi\nline msg");
    expect(r.code).toBe(0);
    expect(r.out.trim()).toBe("sent 99");
    expect(curlUrl(f.capture)).toContain("/channels/1111111111111111111/");
  });

  test("empty message still exits 2 (resolution happens before it)", async () => {
    const f = fixture();
    f.setPeers({ monky: "1111111111111111111" });
    const r = await f.run(["monky", ""]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("empty message");
  });

  test("missing token -> exit 1 with the token hint", async () => {
    const f = fixture();
    f.setPeers({ monky: "1111111111111111111" });
    fs.writeFileSync(
      path.join(f.home, ".pi", "agent", "settings.json"),
      JSON.stringify({ channels: [] }),
    );
    const r = await f.run(["1111111111111111111", "hi"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("no bot token");
  });

  test("own channel -> exit 3 with the reply-instead hint (2026-09-20 incident)", async () => {
    const f = fixture();
    // fixture settings.json has channel: "111" — send to 111 and expect the guard
    const r = await f.run(["111", "this should have been a normal reply"]);
    expect(r.code).toBe(3);
    expect(r.err).toContain("YOUR OWN channel");
    expect(r.err).toContain("normal reply");
    expect(r.err).toContain("agent-to-agent");
    // no curl attempt
    expect(fs.existsSync(f.capture)).toBe(false);
  });

  test("other agent channel -> passes the guard (exit 0)", async () => {
    const f = fixture();
    f.setPeers({ monky: "1111111111111111111", frank: "2222222222222222222" });
    // frank's channel is not the caller's own channel (111)
    const r = await f.run(["2222222222222222222", "ping frank"]);
    expect(r.code).toBe(0);
    expect(r.out.trim()).toBe("sent 99");
    expect(curlUrl(f.capture)).toBe(
      "https://discord.com/api/v10/channels/2222222222222222222/messages",
    );
  });
});

describe("agent-say peer allowlist (2026-09-20 gap)", () => {
  test("numeric id not in peers.json -> exit 4, no curl, known peers listed", async () => {
    const f = fixture();
    f.setPeers({ frank: "2222222222222222222" });
    const r = await f.run(["999000111222333444", "where does this go?"]);
    expect(r.code).toBe(4);
    expect(r.err).toContain("not a known fleet peer");
    expect(r.err).toContain("frank=2222222222222222222");
    expect(r.err).toContain("AGENT_SAY_FORCE=1");
    expect(fs.existsSync(f.capture)).toBe(false);
  });

  test("no peers file + numeric id -> exit 4 (fail closed)", async () => {
    const f = fixture();
    f.setPeers(null);
    const r = await f.run(["2222222222222222222", "hi"]);
    expect(r.code).toBe(4);
    expect(r.err).toContain("not a known fleet peer");
  });

  test("AGENT_SAY_FORCE=1 bypasses the allowlist (exit 0)", async () => {
    const f = fixture();
    f.setPeers({ frank: "2222222222222222222" });
    const r = await f.run(["999000111222333444", "one-off"], undefined, {
      AGENT_SAY_FORCE: "1",
    });
    expect(r.code).toBe(0);
    expect(curlUrl(f.capture)).toBe(
      "https://discord.com/api/v10/channels/999000111222333444/messages",
    );
  });

  test("own channel wins over the allowlist (exit 3, not exit 4)", async () => {
    const f = fixture();
    // caller's own channel (111) IS in peers.json — the more specific
    // own-channel guard must fire first with its reply-instead hint
    f.setPeers({ self: "111" });
    const r = await f.run(["111", "this should have been a normal reply"]);
    expect(r.code).toBe(3);
    expect(r.err).toContain("YOUR OWN channel");
    expect(fs.existsSync(f.capture)).toBe(false);
  });

  test("name target resolves and passes the allowlist", async () => {
    const f = fixture();
    f.setPeers({ frank: "2222222222222222222" });
    const r = await f.run(["frank", "frank, pull pi-dispatch"]);
    expect(r.code).toBe(0);
    expect(r.out.trim()).toBe("sent 99");
  });
});

describe("agent-say recipient reference nudge (2026-09-20 incident)", () => {
  test("message to a peer's numeric id that does not name the peer -> [warn], still sent", async () => {
    const f = fixture();
    f.setPeers({ frank: "2222222222222222222" });
    // regression: the 2026-09-19/20 incident — a human's deliverable
    // sent to a peer's channel, no recipient marker. AGENT_SAY_HUMANS
    // carries the (fake) human roster for the nudge guard.
    const r = await f.run(
      [
        "2222222222222222222",
        "sam asked me to rework their infographic. Done: https://drop.example/1",
      ],
      undefined,
      { AGENT_SAY_HUMANS: "sam" },
    );
    expect(r.code).toBe(0);
    expect(r.out.trim()).toBe("sent 99");
    expect(r.err).toContain("[warn]");
    expect(r.err).toContain("not frank");
    expect(r.err).toContain("Reply in your own channel");
    expect(curlUrl(f.capture)).toContain("/channels/2222222222222222222/");
  });

  test("message that names the peer -> no warning", async () => {
    const f = fixture();
    f.setPeers({ frank: "2222222222222222222" });
    const r = await f.run([
      "2222222222222222222",
      "frank: pull pi-dispatch when you get a sec",
    ]);
    expect(r.code).toBe(0);
    expect(r.err).not.toContain("[warn]");
    expect(r.out.trim()).toBe("sent 99");
  });

  test("recipient match is case-insensitive", async () => {
    const f = fixture();
    f.setPeers({ frank: "2222222222222222222" });
    const r = await f.run([
      "2222222222222222222",
      "FRANK — your pi is running stale",
    ]);
    expect(r.code).toBe(0);
    expect(r.err).not.toContain("[warn]");
  });

  test("name-specified target still warns when the body omits the peer", async () => {
    const f = fixture();
    f.setPeers({ frank: "2222222222222222222" });
    const r = await f.run(
      ["frank", "v2: https://drop.example/2 (for sam)"],
      undefined,
      { AGENT_SAY_HUMANS: "sam" },
    );
    expect(r.code).toBe(0);
    expect(r.err).toContain("[warn]");
  });
});

describe("agent-say outbox dedupe (2026-10-06 abort incident)", () => {
  const PEERS: Record<string, string> = {
    monky: "1111111111111111111",
    frank: "2222222222222222222",
  };

  test("t1: first post writes an outbox receipt {channel, text_sha256, id, ts}", async () => {
    const f = fixture();
    f.setPeers(PEERS);
    const r = await f.run(["1111111111111111111", "hello monky"]);
    expect(r.code).toBe(0);
    expect(r.out.trim()).toBe("sent 99");
    expect(fs.existsSync(outboxPath(f.rt))).toBe(true);
    const box = readOutbox(f.rt);
    expect(box.length).toBe(1);
    expect(box[0].channel).toBe("1111111111111111111");
    expect(box[0].id).toBe("99");
    expect(typeof box[0].ts).toBe("number");
    // hash of the exact text that was sent (post-censor; censor is a no-op stub)
    expect(box[0].text_sha256).toBe(sha256("hello monky"));
  });

  test("t2: identical channel+text within 60s -> no second POST, receipt id printed, rc 0", async () => {
    const f = fixture();
    f.setPeers(PEERS);
    const r1 = await f.run(["1111111111111111111", "hello monky"]);
    expect(r1.code).toBe(0);
    expect(r1.out.trim()).toBe("sent 99");
    expect(postCount(f.capture)).toBe(1);
    const r2 = await f.run(["1111111111111111111", "hello monky"]);
    expect(r2.code).toBe(0);
    // identical shape + the RECEIPT's id (99) — a fresh POST would have
    // answered 100, so this proves the receipt id was re-echoed, not a
    // second post
    expect(r2.out.trim()).toBe("sent 99");
    expect(postCount(f.capture)).toBe(1);
    // the dedupe path writes no second receipt
    expect(readOutbox(f.rt).length).toBe(1);
  });

  test("t3: different text within the window still posts", async () => {
    const f = fixture();
    f.setPeers(PEERS);
    expect((await f.run(["1111111111111111111", "hello monky"])).code).toBe(0);
    const r2 = await f.run(["1111111111111111111", "hello monky, round two"]);
    expect(r2.code).toBe(0);
    expect(r2.out.trim()).toBe("sent 100");
    expect(postCount(f.capture)).toBe(2);
    expect(readOutbox(f.rt).length).toBe(2);
  });

  test("t4: receipt older than 60s is stale -> posts again", async () => {
    const f = fixture();
    f.setPeers(PEERS);
    // seed a stale receipt (61s old) for the same channel + text
    const box = outboxPath(f.rt);
    fs.mkdirSync(path.dirname(box), { recursive: true });
    fs.writeFileSync(
      box,
      JSON.stringify({
        channel: "1111111111111111111",
        text_sha256: sha256("hello monky"),
        id: "77",
        ts: Math.floor(Date.now() / 1000) - 61,
      }) + "\n",
    );
    const r = await f.run(["1111111111111111111", "hello monky"]);
    expect(r.code).toBe(0);
    expect(r.out.trim()).toBe("sent 99"); // the fresh post, not the stale receipt (77)
    expect(postCount(f.capture)).toBe(1);
    // the fresh receipt was appended after the stale one
    expect(readOutbox(f.rt).length).toBe(2);
  });

  test("t5: same text to a DIFFERENT channel still posts (dedupe is per-channel)", async () => {
    const f = fixture();
    f.setPeers(PEERS);
    expect((await f.run(["1111111111111111111", "hello monky"])).code).toBe(0);
    const r2 = await f.run(["2222222222222222222", "hello monky"]);
    expect(r2.code).toBe(0);
    expect(r2.out.trim()).toBe("sent 100");
    expect(postCount(f.capture)).toBe(2);
  });
});

describe("agent-say failure paths + receipt ordering (audit F5)", () => {
  const PEERS: Record<string, string> = {
    monky: "1111111111111111111",
  };

  test("curl rc!=0 -> exit 1 'curl failed', no receipt written", async () => {
    const f = fixture();
    f.setPeers(PEERS);
    const r = await f.run(["1111111111111111111", "hello monky"], undefined, {
      CURL_FAIL_CALLS: "1",
    });
    expect(r.code).toBe(1);
    expect(r.err).toContain("curl failed");
    // the attempt still hit the endpoint, but a failed POST must not
    // leave a receipt behind
    expect(postCount(f.capture)).toBe(1);
    expect(fs.existsSync(outboxPath(f.rt))).toBe(false);
  });

  test("discord error JSON without .id -> exit 1 'discord error', no receipt", async () => {
    const f = fixture();
    f.setPeers(PEERS);
    const respFile = path.join(f.tmp, "resp.json");
    fs.writeFileSync(respFile, '{"code":10014,"message":"Unknown Channel"}');
    const r = await f.run(["1111111111111111111", "hello monky"], undefined, {
      CURL_RESP_FILE: respFile,
    });
    expect(r.code).toBe(1);
    expect(r.err).toContain("discord error");
    expect(r.err).toContain("Unknown Channel");
    expect(fs.existsSync(outboxPath(f.rt))).toBe(false);
  });

  test("failed POST writes no receipt; retry posts fresh (2026-10-06 semantics)", async () => {
    const f = fixture();
    f.setPeers(PEERS);
    // first attempt: POST call 1 fails. A receipt written before the POST
    // (the 2026-10-06 incident) would suppress this retry — it must not.
    const r1 = await f.run(["1111111111111111111", "hello monky"], undefined, {
      CURL_FAIL_CALLS: "1",
    });
    expect(r1.code).toBe(1);
    expect(r1.err).toContain("curl failed");
    expect(fs.existsSync(outboxPath(f.rt))).toBe(false);
    // retry: POST call 2 succeeds -> a FRESH post (id 100), not a dedupe
    // echo of a receipt
    const r2 = await f.run(["1111111111111111111", "hello monky"]);
    expect(r2.code).toBe(0);
    expect(r2.out.trim()).toBe("sent 100");
    expect(postCount(f.capture)).toBe(2);
    const box = readOutbox(f.rt);
    expect(box.length).toBe(1);
    expect(box[0].id).toBe("100");
    expect(box[0].text_sha256).toBe(sha256("hello monky"));
  });
});
