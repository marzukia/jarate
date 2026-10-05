/**
 * shellWords — the ONE shared argv splitter for the jarate fleet (#148;
 * doctrine rule 3 of #149: one flag grammar, one quoting grammar).
 *
 * Splits a pre-joined command string back into argv: unquoted whitespace
 * splits; single quotes preserve everything literally (no escapes inside);
 * double quotes honor \" and \\; a backslash outside quotes escapes the
 * next character. NO expansion: $var, backticks, globs stay literal.
 * Unterminated quote or trailing backslash -> throw (the caller maps the
 * message into its own usage error / JSON doc).
 *
 * Users: bin/jarate-pat (N4), bin/jarate-vault (N4), and the bridge
 * `jarate` tool (packages/bridge/channel/jarate.ts), which re-splits the
 * tool's single `args` string with this parser before spawning bin/jarate.
 * Do not fork this implementation — import it.
 */
export function shellWords(s: string): string[] {
  const words: string[] = [];
  let cur = "";
  let has = false;
  let i = 0;
  const push = (): void => {
    if (has) words.push(cur);
    cur = "";
    has = false;
  };
  while (i < s.length) {
    const c = s[i];
    if (c === " " || c === "\t") {
      push();
      i++;
      continue;
    }
    if (c === "'") {
      const end = s.indexOf("'", i + 1);
      if (end === -1) throw new Error("unterminated single quote");
      cur += s.slice(i + 1, end);
      has = true;
      i = end + 1;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      let part = "";
      while (j < s.length) {
        const cj = s[j];
        if (cj === "\\") {
          if (j + 1 >= s.length) throw new Error("trailing backslash");
          const nx = s[j + 1];
          if (nx === '"' || nx === "\\") part += nx;
          else part += `\\${nx}`; // other escapes stay literal (backslash + char)
          j += 2;
          continue;
        }
        if (cj === '"') break;
        part += cj;
        j++;
      }
      if (j >= s.length) throw new Error("unterminated double quote");
      cur += part;
      has = true;
      i = j + 1;
      continue;
    }
    if (c === "\\") {
      if (i + 1 >= s.length) throw new Error("trailing backslash");
      cur += s[i + 1];
      has = true;
      i += 2;
      continue;
    }
    cur += c;
    has = true;
    i++;
  }
  push();
  return words;
}
