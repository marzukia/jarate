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
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "bun";

const AGENT_SAY = path.join(import.meta.dir, "agent-say");

interface Fixture {
  tmp: string;
  home: string;
  bin: string;
  capture: string;
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
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(bin, { recursive: true });

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

  // stub curl: record every arg (one per line), answer with a message id
  const curl = path.join(bin, "curl");
  fs.writeFileSync(
    curl,
    `#!/bin/sh\n{ for a in "$@"; do printf '%s\\n' "$a"; done; } > "$CURL_CAPTURE"\necho '{"id":"99"}'\n`,
  );
  fs.chmodSync(curl, 0o755);

  // stub bun: the censor is a pass-through (jarate-censor never blocks)
  const bunStub = path.join(bin, "bun");
  fs.writeFileSync(bunStub, "#!/bin/sh\ncat\n");
  fs.chmodSync(bunStub, 0o755);

  const env = { ...process.env } as Record<string, string>;
  env.HOME = home;
  env.PATH = `${bin}:${env.PATH ?? ""}`;
  env.CURL_CAPTURE = capture;
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

  return { tmp, home, bin, capture, env, setPeers, run };
}

const curlUrl = (capture: string): string =>
  fs.existsSync(capture)
    ? (fs
        .readFileSync(capture, "utf8")
        .split("\n")
        .find((l) => l.startsWith("https://discord.com")) ?? "")
    : "";

describe("agent-say peer resolution (#45)", () => {
  test("numeric channel id of a known peer sends", async () => {
    const f = fixture();
    f.setPeers({ monky: "<channel-id-1>", frank: "<channel-id-2>" });
    const r = await f.run(["<channel-id-1>", "hello monky"]);
    expect(r.code).toBe(0);
    expect(r.out.trim()).toBe("sent 99");
    expect(curlUrl(f.capture)).toBe(
      "https://discord.com/api/v10/channels/<channel-id-1>/messages",
    );
    // the bot token from the fake settings.json was used
    expect(fs.readFileSync(f.capture, "utf8")).toContain(
      "Authorization: Bot tok-111",
    );
  });

  test("peer name resolves via ~/.config/agent-fleet/peers.json", async () => {
    const f = fixture();
    f.setPeers({ monky: "<channel-id-1>", frank: "<channel-id-2>" });
    const r = await f.run(["frank", "ping from monky"]);
    expect(r.code).toBe(0);
    expect(r.out.trim()).toBe("sent 99");
    expect(curlUrl(f.capture)).toBe(
      "https://discord.com/api/v10/channels/<channel-id-2>/messages",
    );
  });

  test("unknown peer fails loudly with exit 2, no curl attempt", async () => {
    const f = fixture();
    f.setPeers({ monky: "<channel-id-1>" });
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
    f.setPeers({ monky: "<channel-id-1>" });
    const r = await f.run(["monky", "-"], "multi\nline msg");
    expect(r.code).toBe(0);
    expect(r.out.trim()).toBe("sent 99");
    expect(curlUrl(f.capture)).toContain("/channels/<channel-id-1>/");
  });

  test("empty message still exits 2 (resolution happens before it)", async () => {
    const f = fixture();
    f.setPeers({ monky: "<channel-id-1>" });
    const r = await f.run(["monky", ""]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("empty message");
  });

  test("missing token -> exit 1 with the token hint", async () => {
    const f = fixture();
    f.setPeers({ monky: "<channel-id-1>" });
    fs.writeFileSync(
      path.join(f.home, ".pi", "agent", "settings.json"),
      JSON.stringify({ channels: [] }),
    );
    const r = await f.run(["<channel-id-1>", "hi"]);
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
    f.setPeers({ monky: "<channel-id-1>", frank: "<channel-id-2>" });
    // frank's channel is not the caller's own channel (111)
    const r = await f.run(["<channel-id-2>", "ping frank"]);
    expect(r.code).toBe(0);
    expect(r.out.trim()).toBe("sent 99");
    expect(curlUrl(f.capture)).toBe(
      "https://discord.com/api/v10/channels/<channel-id-2>/messages",
    );
  });
});

describe("agent-say peer allowlist (2026-09-20 gap)", () => {
  test("numeric id not in peers.json -> exit 4, no curl, known peers listed", async () => {
    const f = fixture();
    f.setPeers({ frank: "<channel-id-2>" });
    const r = await f.run(["999000111222333444", "where does this go?"]);
    expect(r.code).toBe(4);
    expect(r.err).toContain("not a known fleet peer");
    expect(r.err).toContain("frank=<channel-id-2>");
    expect(r.err).toContain("AGENT_SAY_FORCE=1");
    expect(fs.existsSync(f.capture)).toBe(false);
  });

  test("no peers file + numeric id -> exit 4 (fail closed)", async () => {
    const f = fixture();
    f.setPeers(null);
    const r = await f.run(["<channel-id-2>", "hi"]);
    expect(r.code).toBe(4);
    expect(r.err).toContain("not a known fleet peer");
  });

  test("AGENT_SAY_FORCE=1 bypasses the allowlist (exit 0)", async () => {
    const f = fixture();
    f.setPeers({ frank: "<channel-id-2>" });
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
    f.setPeers({ frank: "<channel-id-2>" });
    const r = await f.run(["frank", "frank, pull pi-dispatch"]);
    expect(r.code).toBe(0);
    expect(r.out.trim()).toBe("sent 99");
  });
});

describe("agent-say recipient reference nudge (2026-09-20 incident)", () => {
  test("message to a peer's numeric id that does not name the peer -> [warn], still sent", async () => {
    const f = fixture();
    f.setPeers({ frank: "<channel-id-2>" });
    // regression: the 2026-09-19/20 incident — Cain's infographic
    // (a human deliverable) sent to frank's channel, no recipient marker
    const r = await f.run([
      "<channel-id-2>",
      "Cain asked me to rework his infographic. Done: https://drop.example/1",
    ]);
    expect(r.code).toBe(0);
    expect(r.out.trim()).toBe("sent 99");
    expect(r.err).toContain("[warn]");
    expect(r.err).toContain("does not name frank");
    expect(r.err).toContain("reply in your own channel");
    expect(curlUrl(f.capture)).toContain("/channels/<channel-id-2>/");
  });

  test("message that names the peer -> no warning", async () => {
    const f = fixture();
    f.setPeers({ frank: "<channel-id-2>" });
    const r = await f.run([
      "<channel-id-2>",
      "frank: pull pi-dispatch when you get a sec",
    ]);
    expect(r.code).toBe(0);
    expect(r.err).not.toContain("[warn]");
    expect(r.out.trim()).toBe("sent 99");
  });

  test("recipient match is case-insensitive", async () => {
    const f = fixture();
    f.setPeers({ frank: "<channel-id-2>" });
    const r = await f.run([
      "<channel-id-2>",
      "FRANK — your pi is running stale",
    ]);
    expect(r.code).toBe(0);
    expect(r.err).not.toContain("[warn]");
  });

  test("name-specified target still warns when the body omits the peer", async () => {
    const f = fixture();
    f.setPeers({ frank: "<channel-id-2>" });
    const r = await f.run(["frank", "v2: https://drop.example/2 (for Cain)"]);
    expect(r.code).toBe(0);
    expect(r.err).toContain("[warn]");
  });
});
