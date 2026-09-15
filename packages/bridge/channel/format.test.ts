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

// ─── wrapFenceLines (STYLE.md 2.3, 32-col budget) ───────────────────────────

describe("wrapFenceLines", () => {
  test("43-col frame line wraps to <=32 with 2-space continuation", () => {
    const line43 = "├ frank : active, 418a56c2, restarted 17:43";
    expect(line43.length).toBe(43);
    const input = `\`\`\`bash\n${line43}\n└\n\`\`\``;
    expect(wrapFenceLines(input)).toBe(
      "```bash\n├ frank : active, 418a56c2,\n  restarted 17:43\n└\n```",
    );
  });

  test("fence lines at or under 32 are untouched", () => {
    const line32 = `┌ ok · ${"1".repeat(25)}`;
    expect(line32.length).toBe(32);
    const input = `\`\`\`\n${line32}\nshort\n\`\`\``;
    expect(wrapFenceLines(input)).toBe(input);
  });

  test("prose outside fences is never wrapped", () => {
    const prose =
      "this is a plain prose line that is definitely longer than 32";
    expect(prose.length).toBeGreaterThan(32);
    const input = `${prose}\n\`\`\`\n${prose}\n\`\`\`\n${prose}`;
    expect(wrapFenceLines(input)).toBe(
      prose +
        "\n```\n" +
        "this is a plain prose line that\n" +
        "  is definitely longer than 32\n" +
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
      "x".repeat(32),
      `  ${"x".repeat(18)}`,
      "```",
    ]);
  });

  test("multi-wrap: a 92-col line takes four fence lines, all <= 32", () => {
    const line =
      "aaaaaaaaaa bbbbbbbbbb cccccccccc dddddddddd eeeeeeeeee ffffffffff gggggggggg hhhhhhhhhh iiii";
    expect(line.length).toBe(92);
    const lines = wrapFenceLines(`\`\`\`\n${line}\n\`\`\``).split("\n");
    expect(lines[0]).toBe("```");
    expect(lines.at(-1)).toBe("```");
    const body = lines.slice(1, -1);
    expect(body).toEqual([
      "aaaaaaaaaa bbbbbbbbbb cccccccccc",
      "  dddddddddd eeeeeeeeee",
      "  ffffffffff gggggggggg",
      "  hhhhhhhhhh iiii",
    ]);
    for (const l of body) expect(l.length).toBeLessThanOrEqual(32);
    // no chars lost: unwrapping (drop indent + join) gives the original
    expect(body.map((l, i) => (i === 0 ? l : l.slice(2))).join(" ")).toBe(line);
  });

  test("mdToDiscord end-to-end: long fence line wraps, prose survives", () => {
    const prose =
      "a prose sentence that runs well past the thirty two col budget";
    const md = `\`\`\`\n┌ fail · ${"9".repeat(30)}\n\`\`\`\n\n${prose}`;
    const out = mdToDiscord(md).split("\n");
    // prose line intact, single line, still over 32 (Discord wraps it)
    expect(out).toContain(prose);
    for (const l of out.slice(1, out.length - 2))
      expect(l.length).toBeLessThanOrEqual(32);
  });

  test("idempotent: an already-wrapped fence is unchanged", () => {
    const input =
      "```bash\n├ frank : active, 418a56c2,\n  restarted 17:43\n└\n```";
    expect(wrapFenceLines(input)).toBe(input);
  });
});
