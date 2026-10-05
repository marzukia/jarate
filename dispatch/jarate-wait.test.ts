/**
 * dispatch/jarate-wait — rc contract (#117) + issue #120 (token off argv).
 *
 * Runs the real bash script against a fake HOME (settings.json bot token +
 * channel, webhook_author) with a stub curl that records every call's argv
 * AND stdin and can be told to fail (CURL_FAIL_ME / CURL_FAIL_MSGS).
 * Since #120 the token rides a curl config on stdin (`curl -K -`), never
 * argv; every curl carries --max-time 15 --connect-timeout 5. #117: curl
 * failures must not end the wait with an arbitrary rc — the contract
 * (0 = callback, 2 = human, 3 = timeout) holds.
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
  run: (
    args: string[],
    overrides?: Record<string, string>,
  ) => Promise<{ code: number; out: string; err: string }>;
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
  const msgsCount = path.join(tmp, "curl-msgs-count");
  fs.writeFileSync(msgsCount, "0\n");

  // stub curl: appends each call's argv (one per line) + stdin to the
  // captures; answers /users/@me with the bot id, messages with the file.
  // Failure injection (issue #117): CURL_FAIL_ME makes every /users/@me
  // call exit 7; CURL_FAIL_MSGS=<n> makes the first n messages polls exit 7.
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
  *"/users/@me"*)
    if [ -n "\${CURL_FAIL_ME:-}" ]; then exit 7; fi
    printf '{"id":"%s"}\\n' "${BOT_ID}"
    ;;
  *)
    if [ -n "\${CURL_FAIL_MSGS:-}" ]; then
      n=$(cat "$CURL_MSGS_COUNT" 2>/dev/null || printf 0)
      n=$((n + 1))
      printf '%s\\n' "$n" > "$CURL_MSGS_COUNT"
      if [ "$n" -le "$CURL_FAIL_MSGS" ]; then exit 7; fi
    fi
    cat "$CURL_MSGS" 2>/dev/null || true
    ;;
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
  env.CURL_MSGS_COUNT = msgsCount;

  const run = async (
    args: string[],
    overrides?: Record<string, string>,
  ): Promise<{ code: number; out: string; err: string }> => {
    const p = spawn(["bash", PI_WAIT, ...args], {
      env: { ...env, ...overrides },
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

  test("B1: embed-only callback (no content) -> serialized embed detail, rc 0", async () => {
    const f = fixture();
    f.setMsgs(
      JSON.stringify([
        {
          id: "m-emb",
          webhook_id: "wh-1",
          author: { id: WA_ID },
          // pi-bg Variant D payload: no top-level content, framed result
          // lives in the embed
          embeds: [
            {
              title: "done \u00b7 20991231-235959-1",
              description: "```\nok: 12 pass, 0 fail\n```",
              fields: [{ name: "result", value: "all green" }],
            },
          ],
        },
      ]),
    );
    const r = await f.run(["--since", "100", "--timeout", "5", "--check", "1"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("CALLBACK m-emb");
    // serialization order: title, description, fields (name: value)
    const detail = r.out.split("CALLBACK m-emb\n")[1];
    expect(detail).toContain("done \u00b7 20991231-235959-1");
    expect(detail).toContain("ok: 12 pass, 0 fail");
    expect(detail).toContain("result: all green");
  });

  test("B1: content + embeds -> content wins (no double print)", async () => {
    const f = fixture();
    f.setMsgs(
      JSON.stringify([
        {
          id: "m-both",
          webhook_id: "wh-1",
          author: { id: WA_ID },
          content: "plain body",
          embeds: [{ title: "emb", description: "desc" }],
        },
      ]),
    );
    const r = await f.run(["--since", "100", "--timeout", "5", "--check", "1"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("plain body");
    expect(r.out).not.toContain("desc");
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
      // bounded call + config-on-stdin form (#117: connect bounded too)
      expect(call).toContain("--max-time");
      expect(call).toContain("15");
      expect(call).toContain("--connect-timeout");
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

describe("jarate-wait #117: rc contract holds when curl fails", () => {
  test("every poll fails -> rc 3 timeout (not curl's rc 7/28)", async () => {
    const f = fixture();
    const r = await f.run(
      ["--since", "100", "--timeout", "2", "--check", "1"],
      { CURL_FAIL_MSGS: "99" },
    );
    expect(r.code).toBe(3);
    expect(r.out).toContain("timeout");
  });

  test("transient poll failures then callback -> rc 0 (loop survives)", async () => {
    const f = fixture();
    f.setMsgs(
      JSON.stringify([
        {
          id: "m-cb",
          webhook_id: "wh",
          author: { id: WA_ID },
          content: "late cb",
        },
      ]),
    );
    // first two polls exit 7; the third must find the callback
    const r = await f.run(
      ["--since", "100", "--timeout", "20", "--check", "1"],
      { CURL_FAIL_MSGS: "2" },
    );
    expect(r.code).toBe(0);
    expect(r.out).toContain("CALLBACK m-cb");
    expect(r.out).toContain("late cb");
  });

  test("startup bot-id fetch keeps failing -> rc 3 + stderr diagnostic", async () => {
    const f = fixture();
    const r = await f.run(
      ["--since", "100", "--timeout", "30", "--check", "1"],
      { CURL_FAIL_ME: "1" },
    );
    expect(r.code).toBe(3);
    expect(r.out).toContain("timeout");
    expect(r.err).toContain("cannot fetch bot id");
  });
});
