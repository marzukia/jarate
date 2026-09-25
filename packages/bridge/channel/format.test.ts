import { describe, expect, test } from "bun:test";
import {
  collapseFenceTrailingBlankLines,
  convertInlineForDiscord,
  escapeBackticksInCodeBlocks,
  escapeDiscordFormatting,
  formatMarkdownTables,
  limitHeadingDepth,
  mdToDiscord,
  serializeEmbeds,
  styleGuard,
  unnestCodeBlocksFromLists,
  wrapFenceLines,
} from "./format";
import type { DiscordEmbed } from "./types";

// ─── limitHeadingDepth ─────────────────────────────────────────────────────

describe("limitHeadingDepth", () => {
  test("deeper than h3 becomes h3", () => {
    expect(limitHeadingDepth("#### deep")).toBe("### deep\n");
    expect(limitHeadingDepth("###### six")).toBe("### six\n");
  });
  test("h1-h3 untouched", () => {
    expect(limitHeadingDepth("# one")).toBe("# one");
    expect(limitHeadingDepth("## two")).toBe("## two");
    expect(limitHeadingDepth("### three")).toBe("### three");
  });
  test("headings inside code blocks untouched", () => {
    const input = "```\n#### not a heading\n```";
    expect(limitHeadingDepth(input)).toBe(input);
  });
});

// ─── unnestCodeBlocksFromLists ─────────────────────────────────────────────

describe("unnestCodeBlocksFromLists", () => {
  test("single item with code block", () => {
    const input = `- Item 1
  \`\`\`js
  const x = 1
  \`\`\``;
    expect(unnestCodeBlocksFromLists(input)).toBe(
      "- Item 1\n\n```js\nconst x = 1\n```",
    );
  });

  test("code in middle item only", () => {
    const input = `- Item 1
- Item 2
  \`\`\`js
  const x = 1
  \`\`\`
- Item 3`;
    expect(unnestCodeBlocksFromLists(input)).toBe(
      "- Item 1\n- Item 2\n\n```js\nconst x = 1\n```\n- Item 3",
    );
  });

  test("ordered list preserves numbering", () => {
    const input = `1. First item
   \`\`\`js
   const a = 1
   \`\`\`
2. Second item
3. Third item`;
    expect(unnestCodeBlocksFromLists(input)).toBe(
      "1. First item\n\n```js\nconst a = 1\n```\n2. Second item\n3. Third item",
    );
  });

  test("list without code blocks unchanged", () => {
    const input = `- Item 1
- Item 2
- Item 3`;
    expect(unnestCodeBlocksFromLists(input)).toBe(input);
  });

  test("text before and after code in same item", () => {
    const input = `- Start text
  \`\`\`js
  const x = 1
  \`\`\`
  End text`;
    expect(unnestCodeBlocksFromLists(input)).toBe(
      "- Start text\n\n```js\nconst x = 1\n```\n- End text",
    );
  });

  test("code block at root level unchanged", () => {
    const input = "```js\nconst x = 1\n```";
    expect(unnestCodeBlocksFromLists(input)).toBe(input);
  });

  test("content outside lists preserved", () => {
    const input = `# Heading

Some paragraph text.

- List item
  \`\`\`js
  const x = 1
  \`\`\`

More text after.`;
    const result = unnestCodeBlocksFromLists(input);
    expect(result).toContain("# Heading");
    expect(result).toContain("Some paragraph text.");
    expect(result).toContain("- List item");
    expect(result).toContain("```js\nconst x = 1\n```");
    expect(result).toContain("More text after.");
  });
});

// ─── formatMarkdownTables ──────────────────────────────────────────────────

describe("formatMarkdownTables", () => {
  test("table becomes key-value lines", () => {
    const input = `| Name | Age |
| ---- | --- |
| Bob  | 40  |
| Ann  | 30  |`;
    expect(formatMarkdownTables(input)).toBe(
      "**Name** Bob\n**Age** 40\n**Name** Ann\n**Age** 30",
    );
  });

  test("non-table content untouched", () => {
    expect(formatMarkdownTables("hello\n\nworld")).toBe("hello\n\nworld");
  });
});

// ─── escapes ───────────────────────────────────────────────────────────────

describe("escapeBackticksInCodeBlocks", () => {
  test("backticks inside code are escaped", () => {
    expect(escapeBackticksInCodeBlocks("```\nconst a = `x`\n```")).toBe(
      "```\nconst a = \\`x\\`\n```\n",
    );
  });
  test("backticks outside code untouched", () => {
    expect(escapeBackticksInCodeBlocks("use `x` here")).toBe("use `x` here");
  });
});

describe("escapeDiscordFormatting", () => {
  test("triple backticks escaped", () => {
    expect(escapeDiscordFormatting("a ``` b")).toBe("a \\`\\`\\` b");
  });
  test("plain text untouched", () => {
    expect(escapeDiscordFormatting("hello")).toBe("hello");
  });
});

// ─── serializeEmbeds ───────────────────────────────────────────────────────

describe("serializeEmbeds", () => {
  test("empty list", () => {
    expect(serializeEmbeds([])).toBe("");
  });

  test("full embed", () => {
    const embeds: DiscordEmbed[] = [
      {
        title: "T",
        description: "D",
        url: "https://x.test",
        author: { name: "A" },
        footer: { text: "F" },
        fields: [{ name: "f1", value: "v1" }],
      },
    ];
    expect(serializeEmbeds(embeds)).toBe(
      "<embed>\nAuthor: A\nTitle: T\nURL: https://x.test\nD\nf1: v1\nFooter: F\n</embed>",
    );
  });

  test("multiple embeds joined with blank line", () => {
    const embeds: DiscordEmbed[] = [{ title: "1" }, { title: "2" }];
    expect(serializeEmbeds(embeds)).toBe(
      "<embed>\nTitle: 1\n</embed>\n\n<embed>\nTitle: 2\n</embed>",
    );
  });
});

// ─── convertInlineForDiscord ───────────────────────────────────────────────

describe("convertInlineForDiscord", () => {
  test("headings become bold", () => {
    expect(convertInlineForDiscord("## Title")).toBe("**Title**");
  });
  test("links become text (<url>)", () => {
    expect(convertInlineForDiscord("see [docs](https://x.test) now")).toBe(
      "see docs (<https://x.test>) now",
    );
  });
  test("image refs untouched", () => {
    expect(convertInlineForDiscord("![alt](https://x.test/i.png)")).toBe(
      "![alt](https://x.test/i.png)",
    );
  });
  test("links inside code spans untouched", () => {
    expect(convertInlineForDiscord("code `[a](b)` here")).toBe(
      "code `[a](b)` here",
    );
  });
  test("code block content untouched", () => {
    const input = "```\n# not a heading\n[a](b)\n```";
    expect(convertInlineForDiscord(input)).toBe(input);
  });
  test("backticked bare URL becomes clickable <url>", () => {
    expect(convertInlineForDiscord("see `https://github.com/x/y` now")).toBe(
      "see <https://github.com/x/y> now",
    );
  });
  test("backticked http (no s) URL becomes clickable", () => {
    expect(convertInlineForDiscord("`http://100.64.0.1:1313/x/`")).toBe(
      "<http://100.64.0.1:1313/x/>",
    );
  });
  test("code span with non-URL content is left alone", () => {
    expect(convertInlineForDiscord("run `pip install x` here")).toBe(
      "run `pip install x` here",
    );
  });
  test("code span that is a URL plus trailing text is left alone", () => {
    // not a pure-URL span, so it stays a code span
    expect(convertInlineForDiscord("`https://x.test and more`")).toBe(
      "`https://x.test and more`",
    );
  });
  test("bare (unbackticked) URL stays a Discord autolink as-is", () => {
    expect(convertInlineForDiscord("see https://x.test now")).toBe(
      "see https://x.test now",
    );
  });
  test("URL inside a code block is NOT unwrapped", () => {
    const input = "```\n`https://x.test`\n```";
    expect(convertInlineForDiscord(input)).toBe(input);
  });
});

// ─── mdToDiscord pipeline ──────────────────────────────────────────────────

describe("mdToDiscord", () => {
  test("combined pipeline", () => {
    const input = [
      "#### Deep heading",
      "",
      "Some [link](https://x.test) text.",
      "",
      "| K | V |",
      "| - | - |",
      "| a | b |",
      "",
      "```js",
      "const s = `t`",
      "```",
    ].join("\n");
    const out = mdToDiscord(input);
    expect(out).toContain("**Deep heading**");
    expect(out).toContain("link (<https://x.test>) text.");
    expect(out).toContain("**K** a");
    expect(out).toContain("**V** b");
    expect(out).toContain("const s = \\`t\\`");
  });

  test("bare ordered-list marker is not dropped (F1)", () => {
    // marked parses "42." as an ordered list with an empty item; the list
    // branch used to render empty segments and the whole text vanished.
    expect(mdToDiscord("42.")).toBe("42.");
  });
});

// ─── collapseFenceTrailingBlankLines (STYLE.md 2.5) ────────────────────────

describe("collapseFenceTrailingBlankLines", () => {
  test("2 blank lines after closing fence + trailing text -> 0", () => {
    const input =
      "text:\n\n```\n┌ fleet\n└ monky : active\n```\n\n\nAll three on the new jarate.";
    expect(collapseFenceTrailingBlankLines(input)).toBe(
      "text:\n\n```\n┌ fleet\n└ monky : active\n```\nAll three on the new jarate.",
    );
  });

  test("message ending in a fence -> trailing newlines trimmed", () => {
    expect(collapseFenceTrailingBlankLines("```\nbox\n```\n\n")).toBe(
      "```\nbox\n```",
    );
  });

  test("blank lines INSIDE a fence are untouched", () => {
    const input = "```\na\n\nb\n```\n\ntext";
    expect(collapseFenceTrailingBlankLines(input)).toBe(
      "```\na\n\nb\n```\ntext",
    );
  });

  test("fenced block with lang tag toggles correctly", () => {
    const input = "```bash\necho hi\n```\n\n\nnext";
    expect(collapseFenceTrailingBlankLines(input)).toBe(
      "```bash\necho hi\n```\nnext",
    );
  });

  test("blank line between fence and following fence is kept (two blocks)", () => {
    const input = "```\na\n```\n\n```\nb\n```";
    // second block: its opening fence is NOT blank-line-separated anymore,
    // but both blocks stay intact
    expect(collapseFenceTrailingBlankLines(input)).toBe(
      "```\na\n```\n```\nb\n```",
    );
  });
});

// ─── wrapFenceLines (STYLE.md 2.3, 40-col budget) ───────────────────────────

describe("wrapFenceLines", () => {
  test("43-col frame line wraps to <=40 with pipe gutter continuation", () => {
    const line43 = "├ frank : active, 418a56c2, restarted 17:43";
    expect(line43.length).toBe(43);
    // frames ship UNtagged (fence() = bare ```); tagged = code, not wrapped
    const input = `\`\`\`\n${line43}\n└\n\`\`\``;
    expect(wrapFenceLines(input)).toBe(
      "```\n├ frank : active, 418a56c2, restarted\n│ 17:43\n└\n```",
    );
  });

  test("continuation gutter: ├/┣/│ rows keep the pipe, ┌/└/plain get 2 spaces", () => {
    const mk = (l: string) => `\`\`\`\n${l}\n└\n\`\`\``;
    for (const lead of ["├ x : ", "┣ x : ", "│ ├ "]) {
      const out = wrapFenceLines(mk(lead + "y".repeat(50))).split("\n");
      // first continuation line (out[2]) must carry the pipe gutter
      expect(out[2].startsWith("│ ")).toBe(true);
      expect(out[2].length).toBeLessThanOrEqual(40);
    }
    for (const lead of ["┌ x : ", "└ x : ", "plain "]) {
      const out = wrapFenceLines(mk(lead + "y".repeat(50))).split("\n");
      expect(out[2].startsWith("  ")).toBe(true);
      expect(out[2].startsWith("│ ")).toBe(false);
    }
  });

  test("language-tagged fences (code) are never wrapped", () => {
    // 2026-09-15 incident: a 54-col python snippet got frame-style wrapping
    // (mangled indentation) + mid-identifier client splits on mobile.
    const py = "        cached_tokens=num_cached_tokens,"; // 38 cols, one 30-char token
    const input = `\`\`\`python\ndef f(\n    enable_prompt_tokens_details: bool, ...):\n    if not enable_prompt_tokens_details:\n${py}\n\`\`\``;
    expect(
      input.split("\n").filter((l) => l.length > 40).length,
    ).toBeGreaterThan(0);
    expect(wrapFenceLines(input)).toBe(input);
  });

  test("fence lines at or under 40 are untouched", () => {
    const line40 = `┌ ok · ${"1".repeat(33)}`;
    expect(line40.length).toBe(40);
    const input = `\`\`\`\n${line40}\nshort\n\`\`\``;
    expect(wrapFenceLines(input)).toBe(input);
  });

  test("prose outside fences is never wrapped", () => {
    const prose =
      "this is a plain prose line that is definitely longer than 40";
    expect(prose.length).toBeGreaterThan(40);
    const input = `${prose}\n\`\`\`\n${prose}\n\`\`\`\n${prose}`;
    expect(wrapFenceLines(input)).toBe(
      prose +
        "\n```\n" +
        "this is a plain prose line that is\n" +
        "  definitely longer than 40\n" +
        "```\n" +
        prose,
    );
  });

  test("unbreakable word hard-breaks at the budget", () => {
    const word = "x".repeat(50);
    const input = `\`\`\`\n${word}\n\`\`\``;
    const lines = wrapFenceLines(input).split("\n");
    expect(lines).toEqual([
      "```",
      "x".repeat(40),
      `  ${"x".repeat(10)}`,
      "```",
    ]);
  });

  test("multi-wrap: a 92-col line takes three fence lines, all <= 40", () => {
    const line =
      "aaaaaaaaaa bbbbbbbbbb cccccccccc dddddddddd eeeeeeeeee ffffffffff gggggggggg hhhhhhhhhh iiii";
    expect(line.length).toBe(92);
    const lines = wrapFenceLines(`\`\`\`\n${line}\n\`\`\``).split("\n");
    expect(lines[0]).toBe("```");
    expect(lines.at(-1)).toBe("```");
    const body = lines.slice(1, -1);
    expect(body).toEqual([
      "aaaaaaaaaa bbbbbbbbbb cccccccccc",
      "  dddddddddd eeeeeeeeee ffffffffff",
      "  gggggggggg hhhhhhhhhh iiii",
    ]);
    for (const l of body) expect(l.length).toBeLessThanOrEqual(40);
    // no chars lost: unwrapping (drop indent + join) gives the original
    expect(body.map((l, i) => (i === 0 ? l : l.slice(2))).join(" ")).toBe(line);
  });

  test("mdToDiscord end-to-end: long fence line wraps, prose survives", () => {
    const prose =
      "a prose sentence that runs well past the forty col budget now";
    const md = `\`\`\`\n├ frank : active, 418a56c2, restarted 17:43\n\`\`\`\n\n${prose}`;
    const out = mdToDiscord(md).split("\n");
    // prose line intact, single line, still over 40 (Discord wraps it)
    expect(out).toContain(prose);
    for (const l of out.slice(1, out.length - 2))
      expect(l.length).toBeLessThanOrEqual(40);
  });

  test("idempotent: an already-wrapped fence is unchanged", () => {
    const input = "```\n├ frank : active, 418a56c2, restarted\n  17:43\n└\n```";
    expect(wrapFenceLines(input)).toBe(input);
  });
});

describe("hoistFencedUrls", () => {
  test("bare url in fence -> hoisted to plain line after fence", () => {
    const out = mdToDiscord(
      "Dev link:\n\n```\nhttp://100.64.0.1:1313/posts/x/\n```\n\nMore text.",
    );
    // url must NOT be inside a fence; it appears as a bare line
    expect(out).toContain("http://100.64.0.1:1313/posts/x/");
    // and the fence is gone (urls-only fence dropped)
    const urlIdx = out.indexOf("http://100.64.0.1:1313/posts/x/");
    expect(out.slice(0, urlIdx)).not.toContain("```");
  });
  test("url mixed with code -> code kept in fence, url after", () => {
    const out = mdToDiscord("```\nport 1313\nhttp://x.test:1313/\n```");
    expect(out).toContain("port 1313");
    const urlIdx = out.indexOf("http://x.test:1313/");
    // url is after the closing fence
    const fenceClose = out.lastIndexOf("```");
    expect(urlIdx).toBeGreaterThan(fenceClose);
  });
  test("no url in fence -> unchanged", () => {
    const out = mdToDiscord("```\njust code here\n```");
    expect(out).toContain("```\njust code here\n```");
  });
});

// ─── styleGuard (STYLE.md 2.7 / 3.1 / 4.4) ─────────────────────────────────

describe("styleGuard", () => {
  const F = (s: string) => `\`\`\`\n${s}\n\`\`\``;

  test("bare [ok] tag line -> fenced (the /compact bug)", () => {
    expect(styleGuard("[ok] compacted: 153k -> 36k")).toBe(
      F("[ok] compacted: 153k -> 36k"),
    );
    expect(styleGuard("[!] compact failed: timeout")).toBe(
      F("[!] compact failed: timeout"),
    );
    expect(styleGuard("[queued] 2 in line")).toBe(F("[queued] 2 in line"));
    expect(styleGuard("[-] stopped")).toBe(F("[-] stopped"));
    expect(styleGuard("[..] resetting...")).toBe(F("[..] resetting..."));
    expect(styleGuard("[new] session (context cleared)")).toBe(
      F("[new] session (context cleared)"),
    );
  });

  test("bare box frame -> one fence, not double-fenced", () => {
    const frame = "┌ ok · 20260923-092222-670483\n│ 1 call · 5s\n└";
    const once = styleGuard(frame);
    expect(once).toBe(F(frame));
    // second pass: content is inside the fence now - untouched
    expect(styleGuard(once)).toBe(once);
    // exactly two fence delimiters, nothing else
    expect(once.split("\n").filter((l) => l.trim() === "```")).toHaveLength(2);
  });

  test("consecutive [ok] + [!] lines share ONE fence", () => {
    const block = "[ok] step 1\n[!] step 2\n[-] step 3";
    const out = styleGuard(block);
    expect(out).toBe(F(block));
    expect(out.split("\n").filter((l) => l.trim() === "```")).toHaveLength(2);
  });

  test("plain prose with no markers -> unchanged", () => {
    const prose =
      "All good. The deploy is done and the tests pass.\n\nShip it when ready.";
    expect(styleGuard(prose)).toBe(prose);
  });

  test("already-fenced content -> unchanged (no double fence)", () => {
    const fenced = "```\n[ok] compacted: 153k -> 36k\n```";
    expect(styleGuard(fenced)).toBe(fenced);
    const frame = "```\n┌ ok · run\n└\n```";
    expect(styleGuard(frame)).toBe(frame);
  });

  test("idempotent: styleGuard(styleGuard(x)) === styleGuard(x)", () => {
    const inputs = [
      "[ok] compacted: 153k -> 36k",
      "┌ ok · run\n│ 1 call\n└",
      "[ok] a\n[!] b",
      "plain prose line",
      "```\n[ok] x\n```",
      '{"a": 1, "b": [2, 3]}',
      "/home/monky/projects/jarate",
      "ERROR: unit failed",
      "prose before\n[!] bare mid\nprose after",
      "```\n└\n```\n\n[!] bare after fence",
    ];
    for (const input of inputs) {
      const once = styleGuard(input);
      expect(styleGuard(once)).toBe(once);
    }
  });

  test("JSON object lines -> fenced (single and multi-line)", () => {
    expect(styleGuard('{"a": 1, "b": [2, 3]}')).toBe(
      F('{"a": 1, "b": [2, 3]}'),
    );
    const multi = '{\n  "a": 1\n  "b": 2\n}';
    const out = styleGuard(multi);
    expect(out).toBe(F(multi));
  });

  test("bare path line -> fenced; prose mentioning a path stays", () => {
    expect(styleGuard("/home/monky/projects/jarate")).toBe(
      F("/home/monky/projects/jarate"),
    );
    expect(styleGuard("~/scripts/pi-bg")).toBe(F("~/scripts/pi-bg"));
    // a >40-col path wraps to the fence budget, stays fenced
    const longPath = "/home/monky/projects/jarate/packages/bridge";
    const wrapped = styleGuard(longPath).split("\n");
    expect(wrapped[0]).toBe("```");
    expect(wrapped.at(-1)).toBe("```");
    for (const l of wrapped.slice(1, -1))
      expect(l.length).toBeLessThanOrEqual(40);
    expect(styleGuard("wrote /tmp/x.ts for you")).toBe(
      "wrote /tmp/x.ts for you",
    );
  });

  test("log line shapes -> fenced", () => {
    expect(styleGuard("2026-09-23 09:22:22 ERROR boom")).toBe(
      F("2026-09-23 09:22:22 ERROR boom"),
    );
    expect(styleGuard("ERROR: unit failed")).toBe(F("ERROR: unit failed"));
    // a >40-col error line is wrapped to the fence budget (STYLE.md 2.3)
    const longErr = "ERROR: Failed to start transient timer unit";
    const wrapped = styleGuard(longErr).split("\n");
    expect(wrapped[0]).toBe("```");
    expect(wrapped.at(-1)).toBe("```");
    for (const l of wrapped.slice(1, -1))
      expect(l.length).toBeLessThanOrEqual(40);
    expect(styleGuard("Sep 23 09:22:22 host pi.service: msg")).toBe(
      F("Sep 23 09:22:22 host pi.service: msg"),
    );
    expect(styleGuard("2026-09-23 was a good day")).toBe(
      "2026-09-23 was a good day",
    );
  });

  test("machine line between prose -> fenced, prose untouched", () => {
    const out = styleGuard("a\n[ok] b\nc");
    expect(out).toBe(`a\n${F("[ok] b")}\nc`);
  });

  test("list items, headings, blockquotes, inline code -> untouched", () => {
    expect(styleGuard("- [ok] item in list")).toBe("- [ok] item in list");
    expect(styleGuard("1. [!] numbered item")).toBe("1. [!] numbered item");
    expect(styleGuard("# [ok] heading")).toBe("# [ok] heading");
    expect(styleGuard("> [!] quoted")).toBe("> [!] quoted");
    expect(styleGuard("`error: x` inline")).toBe("`error: x` inline");
    // markdown link is not a state tag
    expect(styleGuard("[text](https://x.test) stays")).toBe(
      "[text](https://x.test) stays",
    );
  });

  test("fenced lines kept to the 40-col budget", () => {
    const long = `├ ${"a".repeat(60)}`;
    const out = styleGuard(long).split("\n");
    expect(out[0]).toBe("```");
    expect(out.at(-1)).toBe("```");
    for (const l of out.slice(1, -1)) expect(l.length).toBeLessThanOrEqual(40);
  });

  test("unclosed existing fence -> left alone (conservative)", () => {
    const input = "```\n[ok] still inside";
    expect(styleGuard(input)).toBe(input);
  });

  test("mdToDiscord: bare frame in LLM text gets fenced as last step", () => {
    const out = mdToDiscord("Done.\n\n┌ ok · 1 call · 5s\n└");
    expect(out).toContain(F("┌ ok · 1 call · 5s\n└"));
    // idempotent through the full pipeline
    expect(mdToDiscord(out)).toBe(out);
  });
});

// ─── styleGuard URL hoisting (issue #87) ─────────────────────────────────

describe("styleGuard: URLs on machine lines stay clickable (#87)", () => {
  const F = (s: string) => `\`\`\`
${s}
\`\`\``;

  test("tag+URL line through mdToDiscord ends with a bare URL outside any fence", () => {
    const url = "https://webdrop.example/f/abc123";
    const out = mdToDiscord(`[ok] uploaded: ${url}`);
    const lines = out.split("\n");
    // last line is the bare URL; nothing after it
    expect(lines.at(-1)).toBe(url);
    // the URL appears exactly once and no fence delimiter follows it
    expect(out.split(url)).toHaveLength(2);
    expect(out.slice(out.indexOf(url))).not.toContain("```");
    // the line's remainder stayed fenced
    expect(out).toContain("[ok] uploaded:");
  });

  test("autolink <url> and backticked url on a tag line hoist bare", () => {
    const out = styleGuard("[ok] see <https://x.test/file> for details");
    const lines = out.split("\n");
    expect(lines.at(-1)).toBe("https://x.test/file");
    expect(lines[0]).toBe("```");
    expect(lines.at(-2)).toBe("```");
    expect(lines.slice(1, -2)).toEqual(["[ok] see for details"]);
    // the pipeline already turns `url` spans into <url> (autolink form)
    const out2 = mdToDiscord("[ok] see `https://x.test/file` for details");
    expect(out2.split("\n").at(-1)).toBe("https://x.test/file");
  });

  test("remainder empty or punctuation-only -> fence dropped, URL bare", () => {
    // [!] carries no word char: nothing left to fence
    expect(styleGuard("[!] https://x.test/a")).toBe("https://x.test/a");
  });

  test("URL inside a quoted JSON value stays fenced, untouched", () => {
    const input = '{\n  "url": "https://x.test/a"\n}';
    expect(styleGuard(input)).toBe(F(input));
  });

  test("trailing sentence punctuation is not part of the hoisted URL", () => {
    const out = styleGuard("[ok] got it: https://x.test/a.");
    expect(out.split("\n").at(-1)).toBe("https://x.test/a");
  });

  test("machine block: url lines hoist after the shared fence", () => {
    const out = styleGuard(
      "[ok] built https://x.test/a\n[!] log https://x.test/b",
    );
    const lines = out.split("\n");
    expect(lines.at(-1)).toBe("https://x.test/b");
    expect(lines.at(-2)).toBe("https://x.test/a");
    expect(lines.at(-3)).toBe("```");
    expect(lines[0]).toBe("```");
  });

  test("idempotent: styleGuard(styleGuard(x)) === styleGuard(x)", () => {
    const inputs = [
      "[ok] uploaded: https://x.test/a",
      "[ok] see <https://x.test/file> for details",
      "[!] https://x.test/a",
      '{\n  "url": "https://x.test/a"\n}',
      "```\n[ok] x\n```\nhttps://x.test/a",
    ];
    for (const input of inputs) {
      const once = styleGuard(input);
      expect(styleGuard(once)).toBe(once);
    }
  });

  test("mdToDiscord: /diff shape keeps the URL bare after the fence", () => {
    const status = "[ok] working tree · 3 files +12 -3 · ttl 7d";
    const url = "https://drop.junkyard.sh/abc123";
    // what the /diff case now posts: fenced status, bare URL after
    const posted = `\`\`\`
${status}
\`\`\`
${url}`;
    const out = mdToDiscord(posted);
    expect(out.split("\n").at(-1)).toBe(url);
    expect(out.slice(out.indexOf(url))).not.toContain("```");
    // the unfenced two-line /diff text lands the same way
    const out2 = mdToDiscord(`${status}\n${url}`);
    expect(out2.split("\n").at(-1)).toBe(url);
    expect(out2.slice(out2.indexOf(url))).not.toContain("```");
  });
});
