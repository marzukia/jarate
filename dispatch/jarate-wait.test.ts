/**
 * dispatch/jarate-wait — rc contract + issue #120 (bot token off curl's argv).
 *
 * Runs the real bash script against a fake HOME (settings.json bot token +
 * channel, webhook_author) with a stub curl that records every call's argv
 * AND stdin. Since #120 the token rides a curl config on stdin (`curl -K -`),
 * never argv; every curl carries --max-time 15.
 */
import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "bun";

const PI_WAIT = path.join(import.meta.dir, "jarate-wait");
const TOKEN = "tok-wait-111";
const CHANNEL = "chan-111";
const BOT_ID = "bot-1";
const WA_ID = "wa-111";

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

interface Fixture {
  tmp: string;
  capture: string;
  stdinCapture: string;
  msgsFile: string;
  env: Record<string, string>;
  setMsgs: (json: string) => void;
  run: (args: string[]) => Promise<{ code: number; out: string; err: string }>;
}

function fixture(): Fixture {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "piwait-test-"));
  tmpDirs.push(tmp);
  const home = path.join(tmp, "home");
  const bin = path.join(tmp, "bin");
  const capture = path.join(tmp, "curl-args.txt");
  const stdinCapture = path.join(tmp, "curl-stdin.txt");
  const msgsFile = path.join(tmp, "msgs.json");
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(bin, { recursive: true });
  fs.mkdirSync(path.join(home, ".pi", "agent"), { recursive: true });
  fs.mkdirSync(path.join(home, ".config", "pi-dispatch"), { recursive: true });
  fs.writeFileSync(
    path.join(home, ".pi", "agent", "settings.json"),
    JSON.stringify({ channels: [{ botToken: TOKEN, channel: CHANNEL }] }),
  );
  fs.writeFileSync(
    path.join(home, ".config", "pi-dispatch", "webhook_author"),
    `${WA_ID}\n`,
  );
  fs.writeFileSync(msgsFile, "[]\n");

  // stub curl: appends each call's argv (one per line) + stdin to the
  // captures; answers /users/@me with the bot id, messages with the file.
  const curl = path.join(bin, "curl");
  fs.writeFileSync(
    curl,
    `#!/bin/sh
{
  printf -- '--call--\\n'
  for a in "$@"; do printf '%s\\n' "$a"; done
} >> "$CURL_CAPTURE"
cat >> "$CURL_STDIN_CAPTURE"
last=""
for a in "$@"; do last="$a"; done
case "$last" in
  *"/users/@me"*) printf '{"id":"%s"}\\n' "${BOT_ID}" ;;
  *) cat "$CURL_MSGS" 2>/dev/null || true ;;
esac
`,
  );
  fs.chmodSync(curl, 0o755);

  const env = { ...process.env } as Record<string, string>;
  env.HOME = home;
  env.PATH = `${bin}:${env.PATH ?? ""}`;
  env.CURL_CAPTURE = capture;
  env.CURL_STDIN_CAPTURE = stdinCapture;
  env.CURL_MSGS = msgsFile;

  const run = async (
    args: string[],
  ): Promise<{ code: number; out: string; err: string }> => {
    const p = spawn(["bash", PI_WAIT, ...args], {
      env,
      cwd: tmp,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, err] = await Promise.all([
      new Response(p.stdout).text(),
      new Response(p.stderr).text(),
    ]);
    const code = await p.exited;
    return { code, out, err };
  };

  return {
    tmp,
    capture,
    stdinCapture,
    msgsFile,
    env,
    setMsgs: (j) => fs.writeFileSync(msgsFile, j),
    run,
  };
}

const calls = (capture: string): string[] =>
  fs
    .readFileSync(capture, "utf8")
    .split("--call--")
    .map((c) => c.trim())
    .filter(Boolean);

describe("jarate-wait rc contract", () => {
  test("webhook callback message -> rc 0, prints CALLBACK + content", async () => {
    const f = fixture();
    f.setMsgs(
      JSON.stringify([
        {
          id: "m-cb",
          webhook_id: "wh-1",
          author: { id: WA_ID },
          content: "worker done: all green",
        },
      ]),
    );
    const r = await f.run(["--since", "100", "--timeout", "5", "--check", "1"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("CALLBACK m-cb");
    expect(r.out).toContain("worker done: all green");
  });

  test("own bot message is skipped, next human message -> rc 2", async () => {
    const f = fixture();
    f.setMsgs(
      JSON.stringify([
        { id: "m-own", author: { id: BOT_ID }, content: "self talk" },
        { id: "m-h", author: { id: "user-9", global_name: "Andryo" } },
      ]),
    );
    const r = await f.run(["--since", "100", "--timeout", "5", "--check", "1"]);
    expect(r.code).toBe(2);
    expect(r.out).toContain("HUMAN m-h: Andryo");
  });

  test("no events before the deadline -> rc 3 timeout", async () => {
    const f = fixture();
    const r = await f.run(["--since", "100", "--timeout", "2", "--check", "1"]);
    expect(r.code).toBe(3);
    expect(r.out).toContain("timeout");
  });

  test("--since required: missing -> rc 2 usage error", async () => {
    const f = fixture();
    const r = await f.run(["--timeout", "2"]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("--since <message-id> required");
  });
});

describe("jarate-wait #120: token off curl's argv", () => {
  test("token in curl stdin config on every call, never in any argv", async () => {
    const f = fixture();
    f.setMsgs(
      JSON.stringify([
        { id: "m-cb", webhook_id: "wh", author: { id: WA_ID }, content: "cb" },
      ]),
    );
    const r = await f.run(["--since", "100", "--timeout", "5", "--check", "1"]);
    expect(r.code).toBe(0);
    const argvCalls = calls(f.capture);
    // both the @me lookup and the messages poll went through curl
    expect(argvCalls.length).toBeGreaterThanOrEqual(2);
    for (const call of argvCalls) {
      expect(call).not.toContain(TOKEN);
      expect(call).not.toContain("Authorization");
      // bounded call + config-on-stdin form
      expect(call).toContain("--max-time");
      expect(call).toContain("15");
      expect(call).toContain("-K");
    }
    // the header actually reached curl on stdin
    const stdin = fs.readFileSync(f.stdinCapture, "utf8");
    expect(stdin).toContain(`header = "Authorization: Bot ${TOKEN}"`);
  });

  test("messages URL is still passed as the final curl arg", async () => {
    const f = fixture();
    f.setMsgs("[]\n");
    const r = await f.run(["--since", "42", "--timeout", "2", "--check", "1"]);
    expect(r.code).toBe(3);
    const argvCalls = calls(f.capture);
    const msgCall = argvCalls.find((c) => c.includes("/channels/"));
    expect(msgCall).toBeDefined();
    expect(msgCall).toContain(
      `https://discord.com/api/v10/channels/${CHANNEL}/messages?after=42&limit=50`,
    );
  });
});
