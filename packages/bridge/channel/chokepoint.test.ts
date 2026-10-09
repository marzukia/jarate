/**
 * Egress choke-point test (source level): every text-bearing send path in
 * discord.ts must route through egressText → censor. A new Discord send
 * function that forgets it fails here. See docs/secret-censor.md.
 */
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

const SRC = fs.readFileSync(path.join(import.meta.dir, "discord.ts"), "utf-8");

/** Extract the body of `function NAME(` via brace matching (string +
 *  comment aware enough for this file). Skips the signature's `)` and any
 *  return-type generics (e.g. Promise<{...}>) before finding the body `{`. */
function functionBody(name: string): string {
  const start = SRC.search(new RegExp(`function ${name}\\s*\\(`));
  expect(start, `function ${name} not found`).toBeGreaterThanOrEqual(0);
  // 1) match the parameter list closing paren
  let i = SRC.indexOf("(", start);
  let paren = 0;
  let inStr: string | null = null;
  while (i < SRC.length) {
    const c = SRC[i];
    if (inStr) {
      if (c === "\\") i++;
      else if (c === inStr) inStr = null;
      i++;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      inStr = c;
      i++;
      continue;
    }
    if (c === "(") paren++;
    if (c === ")") paren--;
    if (paren === 0 && c === ")") break;
    i++;
  }
  // 2) skip return-type generics until angle depth is 0, then find body {
  let angle = 0;
  inStr = null;
  while (i < SRC.length) {
    const c = SRC[i];
    if (inStr) {
      if (c === "\\") i++;
      else if (c === inStr) inStr = null;
      i++;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      inStr = c;
      i++;
      continue;
    }
    if (angle === 0 && c === "{") break;
    if (c === "<") angle++;
    if (c === ">") angle--;
    i++;
  }
  // 3) match body braces
  let depth = 0;
  inStr = null;
  for (; i < SRC.length; i++) {
    const c = SRC[i];
    const next = SRC[i + 1];
    if (inStr) {
      if (c === "\\") i++;
      else if (c === inStr) inStr = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      inStr = c;
      continue;
    }
    if (c === "/" && next === "/") {
      i = SRC.indexOf("\n", i);
      continue;
    }
    if (c === "/" && next === "*") {
      i = SRC.indexOf("*/", i + 2) + 1;
      continue;
    }
    if (c === "{") depth++;
    if (c === "}") depth--;
    if (depth === 0) return SRC.slice(start, i + 1);
  }
  throw new Error(`unbalanced braces in function ${name}`);
}

describe("egress choke point", () => {
  test("egressText exists and applies censor", () => {
    const body = functionBody("egressText");
    expect(body).toContain("censor(");
    expect(SRC).toContain('import { censor } from "./censor"');
  });

  test("every text-bearing send function routes through egressText", () => {
    const senders = [
      "sendDiscordMessage",
      "editDiscordMessage",
      "sendDiscordMessageWithFiles",
      "sendFilesToDiscord",
      "respondToInteraction",
      "editInteractionMessage",
    ];
    for (const fn of senders) {
      expect(functionBody(fn), `${fn} must call egressText`).toContain(
        "egressText(",
      );
    }
  });

  test("no bypass: every function that POSTs/PATCHes a content body calls egressText", () => {
    // Find ALL top-level function declarations (exported AND unexported)
    // and flag any that send a message body with user-visible text or
    // filenames but skip egressText.
    const fnNames = [
      ...SRC.matchAll(/^(?:export )?(?:async )?function (\w+)/gm),
    ].map((m) => m[1]);
    const textSenders = fnNames.filter((name) => {
      const body = (() => {
        try {
          return functionBody(name);
        } catch {
          return "";
        }
      })();
      // (1) content senders: a `content:` field going out a Discord POST
      const postsContent =
        /content\s*:/.test(body) &&
        /method:\s*["'](?:POST|PATCH)["']|discordFetch\(|fetch\(/.test(body);
      // (2) filename-only senders: multipart uploads where the visible
      //    text is the payload_json attachments[].filename field
      const postsFilenames =
        /new FormData\(\)/.test(body) && /payload_json/.test(body);
      return postsContent || postsFilenames;
    });
    for (const fn of textSenders) {
      expect(
        functionBody(fn),
        `${fn} bypasses the egress choke point`,
      ).toContain("egressText(");
    }
    // Floor: the 5 content senders + sendFilesToDiscord (filenames only).
    // A mutation that adds a NEW sender (exported or not, content: or
    // payload_json filenames) with raw text must FAIL the loop above.
    expect(textSenders.length).toBeGreaterThanOrEqual(6);
  });
});
