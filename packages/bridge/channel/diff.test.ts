import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  DEFAULT_TTL,
  diffStats,
  extractFencedDiff,
  gitDiff,
  highlightLine,
  loadWebdropConfig,
  looksLikeDiff,
  parseDiff,
  publishDiff,
  publishHtml,
  renderDiffHtml,
  resolveDiffSource,
  type WebdropConfig,
} from "./diff";

const SAMPLE = `diff --git a/src/foo.ts b/src/foo.ts
index 1111111..2222222 100644
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -1,3 +1,4 @@
 const a = 1;
-const b = 2;
+const b = 22;
+const c = "hi";
 const d = 4;
diff --git a/README.md b/README.md
new file mode 100644
index 0000000..3333333
--- /dev/null
+++ b/README.md
@@ -0,0 +1,2 @@
+# Title
+line two
diff --git a/img.png b/img.png
index 4444444..5555555 100644
Binary files a/img.png and b/img.png differ
`;

describe("parseDiff", () => {
  test("git diff: files, statuses, adds/dels, line numbers", () => {
    const files = parseDiff(SAMPLE);
    expect(files).toHaveLength(3);
    expect(files[0].name).toBe("src/foo.ts");
    expect(files[0].status).toBe("modified");
    expect(files[0].adds).toBe(2);
    expect(files[0].dels).toBe(1);
    const h = files[0].hunks[1]; // hunks[0] = header meta (index line)
    expect(h.header).toBe("@@ -1,3 +1,4 @@");
    expect(h.lines.map((l) => l.kind)).toEqual([
      "ctx",
      "del",
      "add",
      "add",
      "ctx",
    ]);
    expect(h.lines[1].oldNo).toBe(2);
    expect(h.lines[2].newNo).toBe(2);
    expect(h.lines[3].newNo).toBe(3);
    expect(h.lines[4].oldNo).toBe(3);
    expect(h.lines[4].newNo).toBe(4);
    // content is the text without the marker
    expect(h.lines[3].text).toBe('const c = "hi";');

    expect(files[1].name).toBe("README.md");
    expect(files[1].status).toBe("added");
    expect(files[1].adds).toBe(2);

    expect(files[2].name).toBe("img.png");
    expect(files[2].binary).toBe(true);
  });

  test("deleted file via /dev/null", () => {
    const files = parseDiff(
      "diff --git a/gone.txt b/gone.txt\n" +
        "deleted file mode 100644\n" +
        "index 123..000\n" +
        "--- a/gone.txt\n" +
        "+++ /dev/null\n" +
        "@@ -1 +0,0 @@\n" +
        "-bye\n",
    );
    expect(files).toHaveLength(1);
    expect(files[0].status).toBe("deleted");
    expect(files[0].dels).toBe(1);
    expect(files[0].name).toBe("gone.txt");
  });

  test("rename keeps both names", () => {
    const files = parseDiff(
      "diff --git a/old/name.ts b/new/name.ts\n" +
        "similarity index 90%\n" +
        "rename from old/name.ts\n" +
        "rename to new/name.ts\n" +
        "index 1..2 100644\n" +
        "--- a/old/name.ts\n" +
        "+++ b/new/name.ts\n" +
        "@@ -1 +1 @@\n" +
        "-a\n" +
        "+b\n",
    );
    expect(files[0].status).toBe("renamed");
    expect(files[0].oldName).toBe("old/name.ts");
    expect(files[0].name).toBe("new/name.ts");
  });

  test("plain diff -u (no git header) still parses", () => {
    const files = parseDiff(
      "--- a/x.txt\n+++ b/x.txt\n@@ -1 +1 @@\n-old\n+new\n",
    );
    expect(files).toHaveLength(1);
    expect(files[0].name).toBe("x.txt");
    expect(files[0].adds).toBe(1);
  });

  test("\\ No newline at end of file is a meta line", () => {
    const files = parseDiff(
      "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n\\ No newline at end of file\n",
    );
    const h = files[0].hunks[0];
    expect(h.lines.at(-1)).toEqual({
      kind: "meta",
      text: "\\ No newline at end of file",
    });
  });

  test("hunk without counts defaults to one line", () => {
    const files = parseDiff("@@ -1 +1 @@\n-old\n+new\n");
    expect(files[0].hunks[0].lines).toHaveLength(2);
  });

  test("empty input", () => {
    expect(parseDiff("")).toEqual([]);
  });

  test("stats sum across files", () => {
    const s = diffStats(parseDiff(SAMPLE));
    expect(s).toEqual({ files: 3, adds: 4, dels: 1 });
  });
});

describe("diff source heuristics", () => {
  test("looksLikeDiff", () => {
    expect(looksLikeDiff(SAMPLE)).toBe(true);
    expect(looksLikeDiff("--- a/x\n+++ b/x\n@@ -1 +1 @@\n")).toBe(true);
    expect(looksLikeDiff("just some prose\nabout a change\n")).toBe(false);
    expect(looksLikeDiff("diff --git a/b b/c\n")).toBe(true);
  });

  test("extractFencedDiff", () => {
    expect(extractFencedDiff("here:\n```\n+add\n-del\n```\ndone")).toBe(
      "+add\n-del",
    );
    expect(extractFencedDiff("```\n+add\n```\nand\n```diff\n-x\n-y\n```")).toBe(
      "+add",
    );
    expect(extractFencedDiff("no fence here")).toBeNull();
  });

  test("resolveDiffSource", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "diff-src-"));
    fs.writeFileSync(path.join(tmp, "patch.diff"), SAMPLE);
    expect(resolveDiffSource(undefined, tmp)).toEqual({
      kind: "worktree",
      label: "working tree",
    });
    expect(resolveDiffSource("main..HEAD", tmp)?.kind).toBe("range");
    expect(resolveDiffSource("HEAD~3", tmp)?.kind).toBe("range");
    expect(resolveDiffSource("patch.diff", tmp)).toMatchObject({
      kind: "file",
      label: "patch.diff",
    });
    expect(resolveDiffSource("```diff\n+a\n-b\n```", tmp)).toMatchObject({
      kind: "text",
      label: "pasted diff",
    });
    expect(
      resolveDiffSource(
        "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b",
        tmp,
      ),
    ).toMatchObject({ kind: "text" });
    // multi-line but not diff-like
    expect(resolveDiffSource("hello\nworld", tmp)).toBeNull();
    // two tokens, no file
    expect(resolveDiffSource("not a file", tmp)).toBeNull();
    // single token that is neither a file nor a git-arg shape
    expect(resolveDiffSource("has spaces here", tmp)).toBeNull();
    // option-shaped git args (--stat, --cached) are not ranges
    expect(resolveDiffSource("--stat", tmp)).toBeNull();
    expect(resolveDiffSource("--cached", tmp)).toBeNull();
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});

describe("highlightLine", () => {
  test("html-escapes content", () => {
    expect(highlightLine("a < b && c > d", "generic")).toBe(
      "a &lt; b &amp;&amp; c &gt; d",
    );
  });

  test("colors js keywords, strings, comments", () => {
    const h = highlightLine('const x = "hi"; // note <3', "clike");
    expect(h).toContain('<span class="kw">const</span>');
    expect(h).toContain('<span class="str">"hi"</span>');
    expect(h).toContain('<span class="cmt">// note &lt;3</span>');
  });

  test("py comment + string", () => {
    const h = highlightLine("# top\ns = 'x'", "py");
    expect(h).toContain('<span class="cmt"># top</span>');
    expect(h).toContain(
      '<span class="str">&#39;x&#39;</span>'.replace(/&#39;/g, "'"),
    );
  });

  test("json keys distinct from values", () => {
    const h = highlightLine('{ "name": "x" }', "json");
    expect(h).toContain('<span class="key">"name"</span>');
    expect(h).toContain('<span class="str">"x"</span>');
  });

  test("never throws on odd input", () => {
    expect(() =>
      highlightLine(
        "]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]",
        "generic",
      ),
    ).not.toThrow();
    expect(highlightLine("", "clike")).toBe("");
    expect(highlightLine("a", "no-such-lang")).toBe("a");
  });
});

describe("renderDiffHtml", () => {
  test("self-contained: no external requests", () => {
    const html = renderDiffHtml(SAMPLE, "working tree", DEFAULT_TTL);
    expect(html).toContain('<meta name="color-scheme" content="dark">');
    expect(html).toContain("#0d1117");
    // no CDN / external asset
    expect(html).not.toMatch(/src=["']http/i);
    expect(html).not.toMatch(/href=["']http/i);
    expect(html).not.toContain("@import");
    expect(html).not.toMatch(/link rel=["']stylesheet/i);
  });

  test("embeds data so no raw </script> can break out of the page script", () => {
    const tricky =
      "diff --git a/x.html b/x.html\n--- a/x.html\n+++ b/x.html\n@@ -1 +1 @@\n-</script>\n+<script>alert(1)</script>\n";
    const html = renderDiffHtml(tricky, "t", "7d");
    const jsonSlice = html.slice(
      html.indexOf("const D = ") + "const D = ".length,
      html.indexOf(";\nconst esc"),
    );
    // A raw </script> in the payload would end the page's <script> block
    // early; every raw < is emitted as \u003c and diff text is escaped.
    expect(jsonSlice).not.toContain("</script>");
    // The diff content itself survives as escaped text.
    expect(jsonSlice).toContain("&lt;/script&gt;");
  });

  test("title, stats, ttl land in the page", () => {
    const html = renderDiffHtml(SAMPLE, "main..HEAD", "7d");
    expect(html).toContain("diff · main..HEAD");
    expect(html).toContain('"t":"main..HEAD"');
    expect(html).toContain('"ttl":"7d"');
    expect(html).toContain('"a":4');
    expect(html).toContain('"d":1');
    // file names render
    expect(html).toContain("src/foo.ts");
  });

  test("binary file marked", () => {
    const html = renderDiffHtml(SAMPLE, "t", "7d");
    expect(html).toContain('"st":"binary"');
  });
});

describe("loadWebdropConfig", () => {
  const realEnv: Record<string, string | undefined> = {};
  let tmpHome: string;

  beforeEach(() => {
    for (const k of ["WEBDROP_SERVER", "WEBDROP_TOKEN"]) {
      realEnv[k] = process.env[k];
      delete process.env[k];
    }
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "diff-home-"));
    fs.mkdirSync(path.join(tmpHome, ".config", "webdrop"), { recursive: true });
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(realEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  test("env wins over file", () => {
    fs.writeFileSync(
      path.join(tmpHome, ".config", "webdrop", "config.toml"),
      'server = "https://file.example"\ntoken = "file-token"\n',
    );
    process.env.WEBDROP_SERVER = "https://env.example/";
    process.env.WEBDROP_TOKEN = "env-token";
    expect(loadWebdropConfig(tmpHome)).toEqual({
      server: "https://env.example",
      token: "env-token",
    });
  });

  test("config.toml fallback", () => {
    fs.writeFileSync(
      path.join(tmpHome, ".config", "webdrop", "config.toml"),
      'server = "https://file.example"\ntoken = "file-token"\n',
    );
    expect(loadWebdropConfig(tmpHome)).toEqual({
      server: "https://file.example",
      token: "file-token",
    });
  });

  test("missing everywhere -> null", () => {
    expect(loadWebdropConfig(tmpHome)).toBeNull();
  });

  test("partial config (server only) -> null", () => {
    fs.writeFileSync(
      path.join(tmpHome, ".config", "webdrop", "config.toml"),
      'server = "https://file.example"\n',
    );
    expect(loadWebdropConfig(tmpHome)).toBeNull();
  });
});

describe("publishHtml", () => {
  const cfg: WebdropConfig = {
    server: "https://drop.test",
    token: "tok",
  };
  let realFetch: typeof fetch;
  const calls: { url: string; init?: RequestInit }[] = [];

  beforeEach(() => {
    realFetch = globalThis.fetch;
    calls.length = 0;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test("posts with bearer + handle + ttl, returns url", async () => {
    globalThis.fetch = (async (url: any, init?: any) => {
      calls.push({ url: String(url), init });
      return {
        ok: true,
        status: 201,
        json: async () => ({ url: "https://drop.test/abc123.html" }),
      };
    }) as any;
    const r = await publishHtml("<html></html>", cfg, "7d");
    expect(r.url).toBe("https://drop.test/abc123.html");
    expect(calls[0].url).toBe("https://drop.test/api/v1/files");
    const h = calls[0].init!.headers as Record<string, string>;
    expect(h.Authorization).toBe("Bearer tok");
    expect(h["X-Webdrop-TTL"]).toBe("7d");
    expect(h["X-Webdrop-Handle"]).toMatch(/^diff-.*\.html$/);
    expect(calls[0].init!.body).toBe("<html></html>");
  });

  test("http error -> error string without leaking status body", async () => {
    globalThis.fetch = (async () => ({
      ok: false,
      status: 401,
      text: async () => "secret detail",
    })) as any;
    const r = await publishHtml("<html></html>", cfg);
    expect(r.url).toBeUndefined();
    expect(r.error).toBe("webdrop upload failed (401)");
  });

  test("network failure -> unreachable", async () => {
    globalThis.fetch = (async () => {
      throw new Error("ECONNREFUSED");
    }) as any;
    const r = await publishHtml("<html></html>", cfg);
    expect(r.error).toBe("webdrop unreachable: ECONNREFUSED");
  });

  test("ok but no url -> bad response", async () => {
    globalThis.fetch = (async () => ({
      ok: true,
      status: 201,
      json: async () => ({}),
    })) as any;
    const r = await publishHtml("<html></html>", cfg);
    expect(r.error).toBe("webdrop upload: bad response");
  });
});

describe("gitDiff", () => {
  let tmp: string;
  const git = (args: string) => {
    const { spawnSync } = require("node:child_process");
    return spawnSync("git", args.split(" "), {
      cwd: tmp,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "t",
        GIT_AUTHOR_EMAIL: "t@t",
        GIT_COMMITTER_NAME: "t",
        GIT_COMMITTER_EMAIL: "t@t",
      },
    });
  };

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "diff-git-"));
    expect(git("init -q").status).toBe(0);
    fs.writeFileSync(path.join(tmp, "a.txt"), "one\ntwo\n");
    git("add a.txt");
    expect(git('commit -q -m "base"').status).toBe(0);
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  test("worktree diff (git diff HEAD)", async () => {
    fs.writeFileSync(path.join(tmp, "a.txt"), "one\nTWO\n");
    const r = await gitDiff(tmp);
    expect(r.code).toBe(0);
    expect(r.out).toContain("-two");
    expect(r.out).toContain("+TWO");
  });

  test("range diff", async () => {
    fs.writeFileSync(path.join(tmp, "a.txt"), "one\nthree\n");
    git("add a.txt");
    git('commit -q -m "next"');
    const r = await gitDiff(tmp, "HEAD~1..HEAD");
    expect(r.code).toBe(0);
    expect(r.out).toContain("+three");
  });

  test("non-repo fails with git stderr", async () => {
    const bare = fs.mkdtempSync(path.join(os.tmpdir(), "diff-nongit-"));
    try {
      const r = await gitDiff(bare);
      expect(r.code).not.toBe(0);
      expect(r.err).toBeTruthy();
    } finally {
      fs.rmSync(bare, { recursive: true, force: true });
    }
  });
});

describe("publishDiff (pipeline)", () => {
  let tmp: string;
  let tmpHome: string;
  let realFetch: typeof fetch;
  let realEnv: Record<string, string | undefined>;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "diff-pipe-"));
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "diff-pipe-home-"));
    realFetch = globalThis.fetch;
    realEnv = {};
    for (const k of ["WEBDROP_SERVER", "WEBDROP_TOKEN"]) {
      realEnv[k] = process.env[k];
      delete process.env[k];
    }
    globalThis.fetch = (async (url: any) => ({
      ok: true,
      status: 201,
      json: async () => ({
        url: `https://drop.junkyard.sh/test-${String(url).includes("api") ? "ok" : "x"}.html`,
      }),
      text: async () => "",
    })) as any;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    for (const [k, v] of Object.entries(realEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  const cfgToml = () => {
    fs.mkdirSync(path.join(tmpHome, ".config", "webdrop"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpHome, ".config", "webdrop", "config.toml"),
      'server = "https://drop.junkyard.sh"\ntoken = "t"\n',
    );
  };

  test("no webdrop config -> clear error, no crash", async () => {
    const r = await publishDiff(tmp, undefined, tmpHome);
    expect(r).toBe(
      "[!] webdrop not configured (need WEBDROP_SERVER + WEBDROP_TOKEN or ~/.config/webdrop/config.toml)",
    );
  });

  test("clean worktree in non-repo -> git error", async () => {
    cfgToml();
    const r = await publishDiff(tmp, undefined, tmpHome);
    expect(r).toMatch(/^\[!\] git diff failed: /);
  });

  test("clean worktree in repo -> no diff", async () => {
    cfgToml();
    const { spawnSync } = require("node:child_process");
    const env = {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t",
    };
    expect(spawnSync("git", ["init", "-q"], { cwd: tmp, env }).status).toBe(0);
    fs.writeFileSync(path.join(tmp, "a.txt"), "x\n");
    spawnSync("git", ["add", "a.txt"], { cwd: tmp, env });
    expect(
      spawnSync("git", ["commit", "-q", "-m", "b"], { cwd: tmp, env }).status,
    ).toBe(0);
    const r = await publishDiff(tmp, undefined, tmpHome);
    expect(r).toBe("[!] no diff (nothing changed)");
  });

  test("worktree diff publishes and reports stats + url", async () => {
    cfgToml();
    const { spawnSync } = require("node:child_process");
    const env = {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t",
    };
    spawnSync("git", ["init", "-q"], { cwd: tmp, env });
    fs.writeFileSync(path.join(tmp, "a.txt"), "x\n");
    spawnSync("git", ["add", "a.txt"], { cwd: tmp, env });
    spawnSync("git", ["commit", "-q", "-m", "b"], { cwd: tmp, env });
    fs.writeFileSync(path.join(tmp, "a.txt"), "x\ny\n");
    const r = await publishDiff(tmp, undefined, tmpHome);
    expect(r).toBe(
      "[ok] working tree · 1 file +1 -0 · ttl 7d\nhttps://drop.junkyard.sh/test-ok.html",
    );
  });

  test("file source: patch file publishes", async () => {
    cfgToml();
    fs.writeFileSync(path.join(tmp, "p.diff"), SAMPLE);
    const r = await publishDiff(tmp, "p.diff", tmpHome);
    expect(r).toBe(
      "[ok] p.diff · 3 files +4 -1 · ttl 7d\nhttps://drop.junkyard.sh/test-ok.html",
    );
  });

  test("file source: not a diff -> rejected", async () => {
    cfgToml();
    fs.writeFileSync(path.join(tmp, "p.txt"), "just words\nno markers\n");
    const r = await publishDiff(tmp, "p.txt", tmpHome);
    expect(r).toBe("[!] p.txt does not look like a diff");
  });

  test("range: bad rev -> git error surfaced", async () => {
    cfgToml();
    const { spawnSync } = require("node:child_process");
    const env = {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t",
    };
    spawnSync("git", ["init", "-q"], { cwd: tmp, env });
    fs.writeFileSync(path.join(tmp, "a.txt"), "x\n");
    spawnSync("git", ["add", "a.txt"], { cwd: tmp, env });
    spawnSync("git", ["commit", "-q", "-m", "b"], { cwd: tmp, env });
    const r = await publishDiff(tmp, "nope..nope", tmpHome);
    expect(r).toMatch(/^\[!\] git diff failed: /);
  });

  test("pasted diff (fenced) publishes without git", async () => {
    cfgToml();
    const r = await publishDiff(
      tmp,
      "```diff\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n```",
      tmpHome,
    );
    expect(r).toBe(
      "[ok] pasted diff · 1 file +1 -1 · ttl 7d\nhttps://drop.junkyard.sh/test-ok.html",
    );
  });

  test("unresolvable arg -> usage line", async () => {
    cfgToml();
    const r = await publishDiff(tmp, "hello\nworld", tmpHome);
    expect(r).toBe(
      "[!] usage: /diff [git-range | file | diff-paste] (default: working tree)",
    );
  });
});

describe("jarate-diff CLI (bin/jarate-diff: stdin -> publish -> url)", () => {
  const BIN = path.resolve(import.meta.dir, "../../../bin/jarate-diff");
  let server: ReturnType<typeof Bun.serve>;
  let port = 0;
  let tmpHome: string;
  let uploads: { auth?: string; ttl?: string; body?: string }[];

  // Async spawn: a sync spawn would block this process's event loop, and
  // the child's fetch needs the Bun.serve below to answer — deadlock.
  const run = (input: string) =>
    new Promise<{ code: number; out: string; err: string }>((resolve) => {
      const child = cp.spawn("bun", [BIN, "-"], {
        cwd: tmpHome,
        env: {
          ...process.env,
          HOME: tmpHome,
          WEBDROP_SERVER: `http://127.0.0.1:${port}`,
          WEBDROP_TOKEN: "cli-test",
        },
      });
      let out = "";
      let err = "";
      child.stdout?.on("data", (d: Buffer) => {
        out += String(d);
      });
      child.stderr?.on("data", (d: Buffer) => {
        err += String(d);
      });
      child.on("close", (code) => resolve({ code: code ?? 1, out, err }));
      child.stdin?.write(input);
      child.stdin?.end();
    });

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "diff-cli-"));
    uploads = [];
    server = Bun.serve({
      port: 0,
      fetch: async (req) => {
        if (
          req.method === "POST" &&
          new URL(req.url).pathname === "/api/v1/files"
        ) {
          uploads.push({
            auth: req.headers.get("authorization") ?? undefined,
            ttl: req.headers.get("x-webdrop-ttl") ?? undefined,
            body: await req.text(),
          });
          return Response.json(
            { url: `http://127.0.0.1:${port}/cli-diff.html` },
            { status: 201 },
          );
        }
        return Response.json({}, { status: 404 });
      },
    });
    port = server.port!;
  });

  afterEach(() => {
    server.stop(true);
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  test("piped diff publishes, exits 0, prints [ok] + url", async () => {
    const r = await run("--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new\n");
    expect(r.code).toBe(0);
    expect(r.out).toBe(
      `[ok] pasted diff · 1 file +1 -1 · ttl 7d\nhttp://127.0.0.1:${port}/cli-diff.html\n`,
    );
    // uploaded payload is the self-contained viewer page, bearer auth, ttl
    expect(uploads).toHaveLength(1);
    expect(uploads[0].auth).toBe("Bearer cli-test");
    expect(uploads[0].ttl).toBe("7d");
    expect(uploads[0].body).toContain("<!DOCTYPE html>");
    // rendered page stores the parsed rows, not raw markers
    expect(uploads[0].body).toContain('"del","old"');
    expect(uploads[0].body).toContain('"add","new"');
  });

  test("empty stdin -> exit 1, nothing published", async () => {
    const r = await run("  \n");
    expect(r.code).toBe(1);
    expect(r.err).toContain("empty stdin");
    expect(uploads).toHaveLength(0);
  });
});
