/**
 * dispatch/pi-postcheck.sh — restart health check (C1 + C8, polish sweep).
 *
 * Runs the real bash script against a fake HOME with stubbed curl /
 * systemctl / journalctl. C1: the webhook heartbeat line is state-aware
 * ("[ok] healthy" / "[!] not healthy" - the failure path used to read
 * "[!] healthy", a lie). C8: a long token (URL) in the in-flight note is
 * chunked into 30-col pieces before word-wrap, so every frame line stays
 * inside the 40-col mobile budget with content preserved.
 */
import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "bun";

const POSTCHECK = path.join(import.meta.dir, "pi-postcheck.sh");
const TOKEN = "tok-pc-111";
const CHANNEL = "chan-pc-111";

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

interface Post {
  url: string;
  content: string;
}

interface Fixture {
  tmp: string;
  home: string;
  webhookUrl: string;
  env: Record<string, string>;
  setJournal: (lines: string[]) => void;
  setSystemd: (rc: number) => void;
  setInflight: (s: string | null) => void;
  run: () => Promise<{ code: number; out: string; err: string }>;
  posts: () => Post[];
}

function fixture(): Fixture {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pipostcheck-"));
  tmpDirs.push(tmp);
  const home = path.join(tmp, "home");
  const bin = path.join(tmp, "bin");
  const capture = path.join(tmp, "curl-capture.txt");
  const journal = path.join(tmp, "journal.txt");
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(bin, { recursive: true });
  fs.mkdirSync(path.join(home, ".pi", "agent"), { recursive: true });
  fs.mkdirSync(path.join(home, ".config", "pi-dispatch"), { recursive: true });
  fs.writeFileSync(
    path.join(home, ".pi", "agent", "settings.json"),
    JSON.stringify({
      channels: [
        { channel: CHANNEL, botToken: TOKEN, enabled: true, default: true },
      ],
    }),
  );
  fs.writeFileSync(path.join(journal), "");

  // stub curl: records (url, -d payload) per call
  fs.writeFileSync(
    path.join(bin, "curl"),
    `#!/bin/sh
url=""; data=""
while [ $# -gt 0 ]; do
  case "$1" in
    -d) data="$2"; shift 2;;
    -H) shift 2;;
    -m) shift 2;;
    -X) shift 2;;
    -s) shift;;
    *) url="$1"; shift;;
  esac
done
printf '%s\\n%s\\n--\\n' "$url" "$data" >> "$CURL_CAPTURE"
printf 'ok\\n'
`,
  );
  // stub systemctl: is-active rc from the env knob
  fs.writeFileSync(
    path.join(bin, "systemctl"),
    '#!/bin/sh\nif [ -n "$STUB_SYSTEMD_RC" ]; then exit "$STUB_SYSTEMD_RC"; fi\nexit 0\n',
  );
  // stub journalctl: emits the prepared journal lines
  fs.writeFileSync(
    path.join(bin, "journalctl"),
    `#!/bin/sh\ncat "$STUB_JOURNAL" 2>/dev/null || true\n`,
  );
  for (const f of ["curl", "systemctl", "journalctl"]) {
    fs.chmodSync(path.join(bin, f), 0o755);
  }

  const env = { ...process.env } as Record<string, string>;
  env.HOME = home;
  env.PATH = `${bin}:${env.PATH ?? ""}`;
  env.CURL_CAPTURE = capture;
  env.STUB_JOURNAL = journal;
  env.STUB_SYSTEMD_RC = "0";
  return {
    tmp,
    home,
    webhookUrl: "",
    env,
    setJournal: (lines: string[]) =>
      fs.writeFileSync(journal, lines.join("\n")),
    setSystemd: (rc: number) => {
      env.STUB_SYSTEMD_RC = String(rc);
    },
    setInflight: (s: string | null) => {
      const p = path.join(home, ".config", "pi-inflight.md");
      if (s === null) fs.rmSync(p, { force: true });
      else fs.writeFileSync(p, s);
    },
    run: async () => {
      const p = spawn(["bash", POSTCHECK], {
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
    },
    posts: () => {
      const raw = fs.existsSync(capture)
        ? fs.readFileSync(capture, "utf8")
        : "";
      return raw
        .split("--\n")
        .map((c) => c.trim())
        .filter(Boolean)
        .map((c) => {
          const [url, ...rest] = c.split("\n");
          const data = rest.join("\n");
          return {
            url: url ?? "",
            content: (JSON.parse(data) as { content: string }).content,
          };
        });
    },
  };
}

const webhookPost = (f: Fixture): Post => {
  const p = f.posts().find((x) => x.url.startsWith("http://127.0.0.1"));
  if (!p)
    throw new Error(`webhook post not captured: ${JSON.stringify(f.posts())}`);
  return p;
};

const channelPost = (f: Fixture): Post => {
  const p = f.posts().find((x) => x.url.includes(`channels/${CHANNEL}`));
  if (!p)
    throw new Error(`channel post not captured: ${JSON.stringify(f.posts())}`);
  return p;
};

describe("pi-postcheck C1: state-aware wording", () => {
  test("healthy: [ok] healthy 90s after restart (channel + webhook)", async () => {
    const f = fixture();
    fs.writeFileSync(
      path.join(f.home, ".config", "pi-dispatch", "webhook"),
      "http://127.0.0.1:1/hook\n",
    );
    try {
      const r = await f.run();
      expect(r.code).toBe(0);
      expect(channelPost(f).content).toBe(
        "`[ok] pi post-check: service healthy 90s after restart`",
      );
      const hb = webhookPost(f).content;
      expect(hb).toContain("[bg: pi-restart]");
      expect(hb).toContain("└ [ok] healthy 90s after restart");
      // the frame sits inside a code fence (STYLE.md 4.4)
      expect(hb.split("\n")[1]).toBe("```");
      expect(hb.endsWith("\n```")).toBe(true);
    } finally {
      f.setInflight(null);
    }
  });

  test("service down: [!] not healthy (not '[!] healthy')", async () => {
    const f = fixture();
    fs.writeFileSync(
      path.join(f.home, ".config", "pi-dispatch", "webhook"),
      "http://127.0.0.1:1/hook\n",
    );
    f.setSystemd(3);
    try {
      const r = await f.run();
      expect(r.code).toBe(0);
      expect(channelPost(f).content).toBe(
        "`[!] pi.service not active after restart`",
      );
      const hb = webhookPost(f).content;
      expect(hb).toContain("└ [!] not healthy 90s after restart");
      expect(hb).not.toContain("[!] healthy");
    } finally {
      f.setInflight(null);
    }
  });

  test("systemd error: channel posts the clipped error line; heartbeat [!]", async () => {
    const f = fixture();
    fs.writeFileSync(
      path.join(f.home, ".config", "pi-dispatch", "webhook"),
      "http://127.0.0.1:1/hook\n",
    );
    f.setJournal([
      "Sep 15 10:00:01 host systemd[1]: pi.service: Main process exited, code=killed, status=1/SEGV (Failed with result 'signal').",
      "Sep 15 10:00:03 host systemd[1]: pi.service: second failed line must not be quoted",
    ]);
    try {
      const r = await f.run();
      expect(r.code).toBe(0);
      const ch = channelPost(f).content;
      expect(ch).toContain("`[!] pi restarted, systemd error:`");
      expect(ch).toContain("Main process exited, code=killed, status=1/SEGV");
      expect(ch).not.toContain("second failed line"); // head -1 only
      expect(webhookPost(f).content).toContain(
        "└ [!] not healthy 90s after restart",
      );
    } finally {
      f.setInflight(null);
    }
  });
});

describe("pi-postcheck C8: long tokens chunked inside the frame", () => {
  test("80-char URL in the in-flight note: all lines <= 40, content preserved", async () => {
    const f = fixture();
    fs.writeFileSync(
      path.join(f.home, ".config", "pi-dispatch", "webhook"),
      "http://127.0.0.1:1/hook\n",
    );
    const url = `https://webdrop.example/file/${"a".repeat(60)}.png`;
    expect(url.length).toBeGreaterThan(40);
    f.setInflight(url);
    try {
      const r = await f.run();
      expect(r.code).toBe(0);
      const hb = webhookPost(f).content;
      for (const line of hb.split("\n")) {
        expect(line.length).toBeLessThanOrEqual(40);
      }
      // note rows are the lines after "├ in-flight:" up to the close fence
      const rows = hb
        .split("\n")
        .slice(hb.split("\n").indexOf("├ in-flight:") + 1)
        .filter((l) => l.startsWith("│ ") || l.startsWith("└ "));
      expect(rows.length).toBeGreaterThan(1); // really chunked
      const joined = rows.map((l) => l.slice(2)).join("");
      expect(joined).toBe(url); // no content lost
      // the healthy row is intact above the note
      expect(hb).toContain("├ [ok] healthy 90s after restart");
      expect(hb).toContain("├ in-flight:");
    } finally {
      f.setInflight(null);
    }
  });

  test("short in-flight note: plain word wrap, unchanged behavior", async () => {
    const f = fixture();
    fs.writeFileSync(
      path.join(f.home, ".config", "pi-dispatch", "webhook"),
      "http://127.0.0.1:1/hook\n",
    );
    f.setInflight("fix the pi restart loop");
    try {
      const r = await f.run();
      expect(r.code).toBe(0);
      const hb = webhookPost(f).content;
      for (const line of hb.split("\n")) {
        expect(line.length).toBeLessThanOrEqual(40);
      }
      expect(hb).toContain("├ in-flight:");
      // short single-line note ends the frame
      expect(hb).toContain("└ fix the pi restart loop");
    } finally {
      f.setInflight(null);
    }
  });
});
