/**
 * Markdown → Discord formatting pipeline.
 *
 * Ported from kimaki (limit-heading-depth, unnest-code-blocks,
 * format-tables key-value rendering, discord-utils escapes,
 * message-formatting embed serialization).
 *
 * Pipeline (mdToDiscord):
 *   1. limitHeadingDepth        — #### and deeper become ###
 *   2. unnestCodeBlocksFromLists — code blocks hoisted out of list items
 *   3. formatMarkdownTables     — tables become **header** value key-value lines
 *   4. escapeBackticksInCodeBlocks — stray backticks in code escaped
 *   5. convertInlineForDiscord  — headings → bold, [text](url) → text (<url>)
 */
import { Lexer, type Token, type Tokens } from "marked";
import type { DiscordEmbed } from "./types";

// ─── Heading depth ─────────────────────────────────────────────────────────

/**
 * Discord only supports headings up to ### (h3). Convert ####, #####, etc.
 * to ### to maintain consistent rendering.
 */
export function limitHeadingDepth(markdown: string, maxDepth = 3): string {
  const lexer = new Lexer();
  const tokens = lexer.lex(markdown);

  let result = "";
  for (const token of tokens) {
    if (token.type === "heading") {
      const heading = token as Tokens.Heading;
      if (heading.depth > maxDepth) {
        const hashes = "#".repeat(maxDepth);
        result += hashes + " " + heading.text + "\n";
      } else {
        result += token.raw;
      }
    } else {
      result += token.raw;
    }
  }
  return result;
}

// ─── Unnest code blocks from lists ─────────────────────────────────────────

type Segment =
  | { type: "list-item"; prefix: string; content: string }
  | { type: "code"; content: string };

/**
 * Discord doesn't render code blocks inside list items. Hoist them to root
 * level while preserving the list structure around them.
 */
export function unnestCodeBlocksFromLists(markdown: string): string {
  const lexer = new Lexer();
  const tokens = lexer.lex(markdown);

  const result: string[] = [];

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    const next = tokens[i + 1];

    const chunk = (() => {
      if (token.type === "list") {
        const segments = processListToken(token as Tokens.List);
        // Empty segments (e.g. a bare "42." item with no content) — fall
        // back to the raw token so the text is not dropped.
        return renderSegments(segments) || token.raw;
      }
      return token.raw;
    })();

    if (!chunk) {
      continue;
    }

    const nextRaw = next?.raw ?? "";
    const needsNewline =
      nextRaw &&
      !chunk.endsWith("\n") &&
      typeof nextRaw === "string" &&
      !nextRaw.startsWith("\n");

    result.push(needsNewline ? chunk + "\n" : chunk);
  }
  return result.join("");
}

function processListToken(list: Tokens.List): Segment[] {
  const segments: Segment[] = [];
  const start =
    typeof list.start === "number" ? list.start : parseInt(list.start, 10) || 1;
  const prefix = list.ordered ? (i: number) => `${start + i}. ` : () => "- ";

  for (let i = 0; i < list.items.length; i++) {
    const item = list.items[i]!;
    const itemSegments = processListItem(item, prefix(i));
    segments.push(...itemSegments);
  }

  return segments;
}

function processListItem(item: Tokens.ListItem, prefix: string): Segment[] {
  const segments: Segment[] = [];
  let currentText: string[] = [];
  // Track if we've seen a code block - text after code uses continuation prefix
  let seenCodeBlock = false;

  const taskMarker = item.task ? (item.checked ? "[x] " : "[ ] ") : "";
  let wroteFirstListItem = false;

  const flushText = (): void => {
    const rawText = currentText.join("");
    const text = rawText.trimEnd();
    if (text.trim()) {
      // After a code block, use '-' as continuation prefix to avoid repeating numbers
      const effectivePrefix = seenCodeBlock ? "- " : prefix;
      const marker = !wroteFirstListItem ? taskMarker : "";
      const normalizedText = normalizeListItemText({
        text,
        isTaskItem: item.task,
      });
      segments.push({
        type: "list-item",
        prefix: effectivePrefix,
        content: marker + normalizedText,
      });
      wroteFirstListItem = true;
    }
    currentText = [];
  };

  for (const token of item.tokens) {
    if (token.type === "code") {
      flushText();
      const codeToken = token as Tokens.Code;
      const lang = codeToken.lang || "";
      segments.push({
        type: "code",
        content: "```" + lang + "\n" + codeToken.text + "\n```\n",
      });
      seenCodeBlock = true;
      continue;
    }

    if (token.type === "list") {
      flushText();
      // Recursively process nested list - segments bubble up
      const nestedSegments = processListToken(token as Tokens.List);
      segments.push(...nestedSegments);
      continue;
    }

    currentText.push(extractText(token));
  }

  flushText();

  // If no segments were created (empty item), return empty
  if (segments.length === 0) {
    return [];
  }

  // If item had no code blocks (all segments are list-items from this level),
  // return original raw to preserve formatting
  const hasCode = segments.some((s) => s.type === "code");
  if (!hasCode) {
    return [{ type: "list-item", prefix: "", content: item.raw }];
  }

  return segments;
}

function extractText(token: Token): string {
  // Prefer raw to preserve newlines and markdown markers.
  if (typeof token.raw === "string") {
    return token.raw;
  }

  if (token.type === "text") {
    return (token as Tokens.Text).text;
  }

  return "";
}

function normalizeListItemText({
  text,
  isTaskItem,
}: {
  text: string;
  isTaskItem: boolean;
}): string {
  const withoutIndent = text.replace(/^\s+/, "");
  if (!isTaskItem) {
    return withoutIndent;
  }
  return withoutIndent.replace(/^\[(?: |x|X)\]\s+/, "");
}

function renderSegments(segments: Segment[]): string {
  const result: string[] = [];

  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i]!;
    const prev = segments[i - 1];

    if (segment.type === "code") {
      // Add newline before code if previous was a list item
      if (prev && prev.type === "list-item") {
        result.push("\n");
      }
      result.push(segment.content);
    } else {
      // list-item
      if (segment.prefix) {
        result.push(segment.prefix + segment.content + "\n");
      } else {
        // Raw content (no prefix means it's original raw)
        // Ensure raw ends with newline for proper separation from next segment
        const raw = segment.content.trimEnd();
        result.push(raw + "\n");
      }
    }
  }

  return result.join("").trimEnd();
}

// ─── Tables → key-value lines ──────────────────────────────────────────────

function isTableToken(token: Token): token is Tokens.Table {
  return (
    token.type === "table" &&
    Object.hasOwn(token, "header") &&
    Object.hasOwn(token, "rows")
  );
}

/**
 * Discord has no table rendering. Convert each table row into
 * `**header** value` key-value lines, one pair per cell.
 */
export function formatMarkdownTables(markdown: string): string {
  const tokens = new Lexer().lex(markdown);
  let result = "";
  for (const token of tokens) {
    if (isTableToken(token)) {
      // Preserve the table's trailing newlines so following paragraphs keep
      // their separation.
      const tail = token.raw.match(/\n{0,2}$/)![0];
      result += tableToKeyValue(token) + tail;
    } else {
      result += token.raw;
    }
  }
  return result;
}

function tableToKeyValue(table: Tokens.Table): string {
  const headers = table.header.map((cell, i) => {
    return extractCellText(cell.tokens) || `col ${i + 1}`;
  });
  const lines: string[] = [];
  for (const row of table.rows) {
    for (let i = 0; i < row.length; i++) {
      const cell = row[i]!;
      lines.push(`**${headers[i] || `col ${i + 1}`}** ${extractCellText(cell.tokens)}`);
    }
  }
  return lines.join("\n");
}

function extractCellText(tokens: Token[]): string {
  const parts: string[] = [];
  for (const token of tokens) {
    parts.push(extractTokenText(token));
  }
  return parts.join("").trim();
}

function extractTokenText(token: Token): string {
  switch (token.type) {
    case "text":
    case "codespan":
    case "escape":
      return token.text;
    case "link":
      return token.href;
    case "image":
      return token.href;
    case "strong":
    case "em":
    case "del":
      return token.tokens ? extractCellText(token.tokens) : token.text;
    case "br":
      return " ";
    default: {
      const nestedTokens = Reflect.get(token, "tokens");
      if (Array.isArray(nestedTokens)) {
        return extractCellText(
          nestedTokens.filter((value): value is Token => {
            return (
              typeof value === "object" &&
              value !== null &&
              typeof Reflect.get(value, "type") === "string"
            );
          }),
        );
      }
      const text = Reflect.get(token, "text");
      if (typeof text === "string") {
        return text;
      }
      return "";
    }
  }
}

// ─── Escapes ───────────────────────────────────────────────────────────────

/**
 * Escape backticks inside code blocks so Discord doesn't mangle them.
 * Code fences are re-emitted with ``` (indented/tilde normalized).
 */
export function escapeBackticksInCodeBlocks(markdown: string): string {
  const lexer = new Lexer();
  const tokens = lexer.lex(markdown);

  let result = "";
  for (const token of tokens) {
    if (token.type === "code") {
      const escapedCode = token.text.replace(/`/g, "\\`");
      result += "```" + (token.lang || "") + "\n" + escapedCode + "\n```\n";
    } else {
      result += token.raw;
    }
  }

  return result;
}

/**
 * Escape triple backticks in free text so it doesn't open a code block
 * when inserted into a Discord message.
 */
export function escapeDiscordFormatting(text: string): string {
  return text.replace(/```/g, "\\`\\`\\`").replace(/````/g, "\\`\\`\\`\\`");
}

// ─── Embed serialization ───────────────────────────────────────────────────

/**
 * Serialize Discord embeds into plain text so the LLM can read them.
 * Each embed becomes an <embed> block with author, title, URL, description,
 * fields, and footer when present.
 */
export function serializeEmbeds(embeds: DiscordEmbed[]): string {
  if (embeds.length === 0) return "";
  const parts: string[] = [];
  for (const embed of embeds) {
    const lines: string[] = [];
    if (embed.author?.name) {
      lines.push(`Author: ${embed.author.name}`);
    }
    if (embed.title) {
      lines.push(`Title: ${embed.title}`);
    }
    if (embed.url) {
      lines.push(`URL: ${embed.url}`);
    }
    if (embed.description) {
      lines.push(embed.description);
    }
    for (const field of embed.fields ?? []) {
      lines.push(`${field.name}: ${field.value}`);
    }
    if (embed.footer?.text) {
      lines.push(`Footer: ${embed.footer.text}`);
    }
    if (lines.length > 0) {
      parts.push(`<embed>\n${lines.join("\n")}\n</embed>`);
    }
  }
  return parts.join("\n\n");
}

// ─── Inline conversion ─────────────────────────────────────────────────────

/**
 * Line-based inline conversion, fence-aware (a ``` block is never touched):
 * - `# heading` → `**heading**`
 * - `[text](url)` → `text (<url>)`, skipped inside inline code spans
 */
export function convertInlineForDiscord(md: string): string {
  const lines = md.split("\n");
  let inCodeBlock = false;
  const out: string[] = [];
  for (const line of lines) {
    if (line.trimStart().startsWith("```")) {
      inCodeBlock = !inCodeBlock;
      out.push(line);
      continue;
    }
    if (inCodeBlock) {
      out.push(line);
      continue;
    }
    // # heading → **heading**
    let converted = line.replace(/^(#{1,6})\s+(.+)$/, (_m, _hashes: string, text: string) => `**${text}**`);
    // [text](url) → text (<url>) — skip image refs ![alt](url) and code spans
    converted = codeSpans(converted, (part) =>
      part.replace(/(?<!!)\[([^\]]+)\]\(([^)]+)\)/g, (_m, text: string, url: string) => `${text} (<${url}>)`),
    );
    out.push(converted);
  }
  return out.join("\n");
}

/** Split a line into code-span / non-code-span parts and map the non-code parts. */
function codeSpans(line: string, map: (part: string) => string): string {
  return line
    .split(/(`+[^`]*`+)/g)
    .map((part, i) => (i % 2 === 1 ? part : map(part)))
    .join("");
}

// ─── Pipeline ──────────────────────────────────────────────────────────────

/** Convert LLM markdown to Discord-friendly formatting. */
export function mdToDiscord(md: string): string {
  let out = limitHeadingDepth(md);
  out = unnestCodeBlocksFromLists(out);
  out = formatMarkdownTables(out);
  out = escapeBackticksInCodeBlocks(out);
  out = convertInlineForDiscord(out);
  return out;
}
