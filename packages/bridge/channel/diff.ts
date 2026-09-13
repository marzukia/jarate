/**
 * /diff — publish a diff to a shareable, self-hosted viewer URL.
 *
 * Issue #7: read the working tree diff in a real syntax-highlighted viewer
 * from the phone. Kimaki's critique.work uploads the raw patch to a
 * CodeRabbit-run server (7-day retention) — rejected as code exfil. Ours:
 * render the diff into a single self-contained dark mobile HTML page
 * (no CDN, no external requests) and publish it to webdrop (drop.sh is
 * our own host). Zero third-party code exposure.
 *
 * Sources, in /diff resolution order:
 *   /diff               git diff HEAD in the working dir (worktree)
 *   /diff <fenced text> paste (first ``` block of the message)
 *   /diff <file>        a .patch/.diff/.txt file in the working dir
 *   /diff <git range>   git diff <range|rev> (e.g. main..HEAD, HEAD~3)
 *   /diff <raw diff>    multi-line paste that looks like a unified diff
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { defaultHome } from "./todos";

// ─── Parsing ─────────────────────────────────────────────────────────────

export interface DiffLine {
  kind: "add" | "del" | "ctx" | "meta";
  /** Line content without the leading +/−/space marker. */
  text: string;
  oldNo?: number;
  newNo?: number;
}

export interface DiffHunk {
  /** Raw hunk header, e.g. "@@ -1,3 +1,4 @@". */
  header: string;
  lines: DiffLine[];
}

export interface DiffFile {
  name: string;
  oldName?: string;
  status: "added" | "deleted" | "renamed" | "modified" | "other";
  binary: boolean;
  hunks: DiffHunk[];
  adds: number;
  dels: number;
}

export interface DiffStats {
  files: number;
  adds: number;
  dels: number;
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;

/** Parse a path out of `diff --git a/X b/Y` (unquotes "..." paths). */
function unquote(p: string): string {
  const m = p.match(/^"(.*)"$/);
  return m ? m[1]! : p;
}

/**
 * Lenient unified-diff parser. Tolerates `git diff --git` headers,
 * plain `diff -u` (--- / +++ pairs), renames, mode changes, and binary
 * markers. Unrecognized lines land in the current hunk as `meta` so
 * nothing is ever silently dropped.
 */
export function parseDiff(diff: string): DiffFile[] {
  const files: DiffFile[] = [];
  // Parser state lives in one object: property access narrows stay valid
  // across the helper calls below (bare let-closures do not).
  const st: {
    cur: DiffFile | null;
    hunk: DiffHunk | null;
    oldNo: number;
    newNo: number;
    /** Header-level noise (index/mode lines) seen before the first hunk. */
    preMeta: string[];
  } = { cur: null, hunk: null, oldNo: 0, newNo: 0, preMeta: [] };

  const flushPreMeta = () => {
    if (st.preMeta.length && st.cur) {
      st.cur.hunks.push({
        header: "",
        lines: st.preMeta.map((t) => ({ kind: "meta" as const, text: t })),
      });
    }
    st.preMeta = [];
  };

  const finalizeFile = () => {
    flushPreMeta();
    st.hunk = null;
    st.cur = null;
  };

  const startFile = (name: string): DiffFile => {
    finalizeFile();
    const f: DiffFile = {
      name,
      status: "modified",
      binary: false,
      hunks: [],
      adds: 0,
      dels: 0,
    };
    st.cur = f;
    files.push(f);
    return f;
  };

  const pushMeta = (text: string) => {
    if (st.hunk) {
      st.hunk.lines.push({ kind: "meta", text });
    } else if (st.cur) {
      // Header-level noise (index lines, mode lines) — buffered until the
      // first hunk (or file end) so it never shadows a real hunk header.
      st.preMeta.push(text);
    }
  };

  const rawLines = diff.split("\n");
  // A trailing newline is an input artifact, not a blank context line.
  if (rawLines.length > 0 && rawLines[rawLines.length - 1] === "")
    rawLines.pop();

  for (const rawLine of rawLines) {
    const line = rawLine.replace(/\t/g, "  ");

    if (line.startsWith("diff --git ")) {
      const m = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
      startFile(unquote(m ? m[2]! : line.slice("diff --git ".length)));
      continue;
    }

    if (!st.cur) {
      // No file header yet: plain `diff -u` style starts with `--- file`,
      // or a bare hunk opens a synthetic nameless file.
      if (/^--- /.test(line)) {
        startFile(line.slice(4).trim());
        continue;
      }
      if (!HUNK_RE.test(line)) continue;
      // fall through: the @@ line below opens the first hunk
      startFile("(unknown)");
    }

    const cur = st.cur;
    if (cur === null) continue;
    let hunk = st.hunk;

    if (line.startsWith("rename from ")) {
      cur.oldName = unquote(line.slice("rename from ".length));
      cur.status = "renamed";
      continue;
    }
    if (line.startsWith("rename to ")) {
      cur.name = unquote(line.slice("rename to ".length));
      continue;
    }
    if (line.startsWith("--- ")) {
      const p = unquote(line.slice(4).trim());
      if (p !== "/dev/null") cur.oldName = p.replace(/^a\//, "");
      continue;
    }
    if (line.startsWith("+++ ")) {
      const p = unquote(line.slice(4).trim());
      if (p !== "/dev/null") cur.name = p.replace(/^b\//, "");
      continue;
    }
    if (line.startsWith("new file mode")) {
      cur.status = "added";
      pushMeta(line);
      continue;
    }
    if (line.startsWith("deleted file mode")) {
      cur.status = "deleted";
      pushMeta(line);
      continue;
    }
    if (line.startsWith("Binary files ")) {
      cur.binary = true;
      pushMeta(line);
      continue;
    }
    if (
      /^(index |old mode |new mode |similarity index |dissimilarity index |copy from |copy to |extended header |new mode )/.test(
        line,
      )
    ) {
      pushMeta(line);
      continue;
    }

    const hm = hunk === null ? HUNK_RE.exec(line) : null;
    if (hm) {
      flushPreMeta();
      st.oldNo = Number(hm[1]);
      st.newNo = Number(hm[3]);
      hunk = { header: line, lines: [] };
      st.hunk = hunk;
      cur.hunks.push(hunk);
      continue;
    }

    if (hunk === null) {
      // Anything else before a hunk: keep it, do not drop it.
      if (line !== "") pushMeta(line);
      continue;
    }

    const marker = line.charAt(0);
    if (marker === "+" || marker === "-" || marker === " " || line === "") {
      const text = line.slice(1);
      if (marker === "+") {
        hunk.lines.push({ kind: "add", text, newNo: st.newNo++ });
        cur.adds++;
      } else if (marker === "-") {
        hunk.lines.push({ kind: "del", text, oldNo: st.oldNo++ });
        cur.dels++;
      } else {
        hunk.lines.push({
          kind: "ctx",
          text,
          oldNo: st.oldNo++,
          newNo: st.newNo++,
        });
      }
    } else {
      hunk.lines.push({ kind: "meta", text: line });
    }
  }
  finalizeFile();
  return files;
}

export function diffStats(files: DiffFile[]): DiffStats {
  return {
    files: files.length,
    adds: files.reduce((s, f) => s + f.adds, 0),
    dels: files.reduce((s, f) => s + f.dels, 0),
  };
}

// ─── Syntax highlighting (self-contained, no CDN) ────────────────────────

type Spec = { parts: [cls: string, src: string][]; flags?: string };

const JS_TS_KEYWORDS =
  "const|let|var|function|return|if|else|for|while|do|switch|case|break|continue|new|class|extends|super|import|export|from|default|async|await|try|catch|finally|throw|type|interface|enum|implements|readonly|public|private|protected|static|void|as|in|of|instanceof|delete|yield|undefined|true|false|null|this|fn|mut|impl|pub|match|move|struct|where";
const PY_KEYWORDS =
  "def|return|if|elif|else|for|while|in|not|and|or|is|None|True|False|class|import|from|as|with|try|except|finally|raise|yield|lambda|pass|break|continue|global|nonlocal|assert|del|async|await|self";
const SH_KEYWORDS =
  "if|then|else|elif|fi|for|do|done|while|until|case|esac|function|return|export|local|echo|cd|set|unset|source|alias|read|printf|exit|trap";
const SQL_KEYWORDS =
  "SELECT|FROM|WHERE|INSERT|INTO|VALUES|UPDATE|SET|DELETE|CREATE|TABLE|DROP|ALTER|ADD|COLUMN|INDEX|JOIN|LEFT|RIGHT|INNER|OUTER|ON|GROUP|BY|ORDER|HAVING|LIMIT|OFFSET|UNION|ALL|DISTINCT|AS|AND|OR|NOT|NULL|PRIMARY|KEY|FOREIGN|REFERENCES|DEFAULT|UNIQUE|CHECK|CONSTRAINT";

const SPECS: Record<string, Spec> = {
  clike: {
    parts: [
      ["cmt", "(?://.*|/\\*[\\s\\S]*?\\*/|/\\*[\\s\\S]*$)"],
      [
        "str",
        "(?:\"(?:\\\\.|[^\"\\\\\n])*\"?|'(?:\\\\.|[^'\\\\\n])*'?|`(?:\\\\.|[^`\\\\\n])*`?)",
      ],
      [
        "num",
        "\\b(?:0[xX][\\da-fA-F_]+|\\d[\\d_]*(?:\\.\\d[\\d_]*)?(?:[eE][+-]?\\d+)?)\\b",
      ],
      ["kw", `\\b(?:${JS_TS_KEYWORDS})\\b`],
    ],
  },
  py: {
    parts: [
      ["cmt", "#.*"],
      ["str", "(?:\"(?:\\\\.|[^\"\\\\\n])*\"?|'(?:\\\\.|[^'\\\\\n])*'?)"],
      ["num", "\\b\\d[\\d_]*(?:\\.\\d[\\d_]*)?(?:[eE][+-]?\\d+)?\\b"],
      ["kw", `\\b(?:${PY_KEYWORDS})\\b`],
    ],
  },
  sh: {
    parts: [
      ["cmt", "#.*"],
      ["str", "(?:\"(?:\\\\.|[^\"\\\\\n])*\"?|'(?:\\\\.|[^'\\\\\n])*'?)"],
      ["num", "\\b\\d[\\d_]*(?:\\.\\d[\\d_]*)?\\b"],
      ["kw", `\\b(?:${SH_KEYWORDS})\\b`],
    ],
  },
  json: {
    parts: [
      ["key", '"(?:\\\\.|[^"\\\\\n])*"(?=\\s*:)'],
      ["str", '"(?:\\\\.|[^"\\\\\n])*"'],
      ["num", "-?\\b\\d[\\d_]*(?:\\.\\d+)?(?:[eE][+-]?\\d+)?\\b"],
      ["kw", "\\b(?:true|false|null)\\b"],
    ],
  },
  yaml: {
    parts: [
      ["cmt", "#.*"],
      ["key", "^[\\t -]*(?:[\\w./-]+|\"[^\"]*\"|'[^']*')(?=\\s*:(?:\\s|$))"],
      ["str", "(?:\"(?:\\\\.|[^\"\\\\\n])*\"?|'(?:\\\\.|[^'\\\\\n])*'?)"],
      ["num", "\\b\\d[\\d_]*(?:\\.\\d+)?\\b"],
      ["kw", "\\b(?:true|false|null|yes|no|on|off)\\b"],
    ],
  },
  md: {
    parts: [
      ["hdg", "^#{1,6} .*$"],
      ["str", "`(?:[^`\\\\]|\\\\.)*`"],
      ["kw", "\\*\\*[^*\\n]+\\*\\*"],
      ["tag", "\\[[^\\]\n]*\\]\\([^)\n]*\\)"],
    ],
  },
  ini: {
    parts: [
      ["cmt", "[#;].*"],
      ["key", "^[\\t ]*[\\w.-]+(?=[\\t ]*[=:])"],
      ["str", "(?:\"(?:\\\\.|[^\"\\\\\n])*\"?|'(?:\\\\.|[^'\\\\\n])*'?)"],
      ["num", "\\b\\d[\\d_]*(?:\\.\\d+)?\\b"],
      ["kw", "\\b(?:true|false)\\b"],
    ],
  },
  sql: {
    parts: [
      ["cmt", "(?:--.*|/\\*[\\s\\S]*?\\*/|/\\*[\\s\\S]*$)"],
      ["str", "'(?:''|[^'\n])*'?"],
      ["num", "\\b\\d[\\d_]*(?:\\.\\d+)?\\b"],
      ["kw", `\\b(?:${SQL_KEYWORDS})\\b`],
    ],
    flags: "i",
  },
  html: {
    parts: [
      ["cmt", "(?:<!--[\\s\\S]*?-->|<!--[\\s\\S]*$)"],
      ["str", "(?:\"(?:\\\\.|[^\"\\\\\n])*\"?|'(?:\\\\.|[^'\\\\\n])*'?)"],
      ["tag", "</?[a-zA-Z][\\w:-]*(?:[\\s\\S]*?)>?"],
      ["num", "\\b\\d[\\d_]*(?:\\.\\d+)?(?:px|em|rem|%)?\\b"],
    ],
  },
  css: {
    parts: [
      ["cmt", "(?:/\\*[\\s\\S]*?\\*/|/\\*[\\s\\S]*$)"],
      ["str", "(?:\"(?:\\\\.|[^\"\\\\\n])*\"?|'(?:\\\\.|[^'\\\\\n])*'?)"],
      ["key", "@[\\w-]+|[a-zA-Z-]+(?=\\s*:)"],
      ["num", "\\b\\d[\\d.]*(?:px|em|rem|%|vh|vw|s|ms|deg)?\\b"],
    ],
  },
  generic: {
    parts: [
      ["cmt", "(?://.*|/\\*[\\s\\S]*?\\*/|/\\*[\\s\\S]*$|#.*)"],
      [
        "str",
        "(?:\"(?:\\\\.|[^\"\\\\\n])*\"?|'(?:\\\\.|[^'\\\\\n])*'?|`(?:\\\\.|[^`\\\\\n])*`?)",
      ],
      ["num", "\\b\\d[\\d_]*(?:\\.\\d+)?\\b"],
    ],
  },
};

const CLASSES = ["cmt", "str", "num", "kw", "key", "hdg", "tag"];

const specCache = new Map<string, { re: RegExp; order: string[] } | null>();

function compiledSpec(name: string): { re: RegExp; order: string[] } | null {
  const cached = specCache.get(name);
  if (cached !== undefined) return cached;
  const spec = SPECS[name] ?? SPECS.generic;
  let built: { re: RegExp; order: string[] } | null = null;
  try {
    const src = spec.parts.map(([cls, s]) => `(?<${cls}>${s})`).join("|");
    built = { re: new RegExp(src, `g${spec.flags ?? ""}`), order: CLASSES };
  } catch {
    built = null;
  }
  specCache.set(name, built);
  return built;
}

function escHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Tokenize one line of code into escaped HTML with span classes.
 * Heuristic, per-line — good enough for mobile diff reading; never throws.
 */
export function highlightLine(raw: string, lang: string): string {
  const c = compiledSpec(lang);
  if (!c) return escHtml(raw);
  const { re, order } = c;
  re.lastIndex = 0;
  let out = "";
  let last = 0;
  let m: RegExpExecArray | null = re.exec(raw);
  while (m !== null) {
    const match = m;
    if (match[0] === "") {
      re.lastIndex++;
    } else {
      if (match.index > last) out += escHtml(raw.slice(last, match.index));
      const groups = match.groups ?? {};
      const cls = order.find((k) => groups[k] !== undefined);
      if (cls) out += `<span class="${cls}">${escHtml(match[0])}</span>`;
      else out += escHtml(match[0]);
      last = match.index + match[0].length;
    }
    m = re.exec(raw);
  }
  out += escHtml(raw.slice(last));
  return out;
}

function langFor(name: string): string {
  const ext = name.includes(".")
    ? name.slice(name.lastIndexOf(".") + 1).toLowerCase()
    : "";
  const map: Record<string, string> = {
    ts: "clike",
    tsx: "clike",
    js: "clike",
    jsx: "clike",
    mjs: "clike",
    cjs: "clike",
    go: "clike",
    rs: "clike",
    java: "clike",
    c: "clike",
    cc: "clike",
    cpp: "clike",
    h: "clike",
    hh: "clike",
    hpp: "clike",
    cs: "clike",
    cu: "clike",
    py: "py",
    sh: "sh",
    bash: "sh",
    zsh: "sh",
    fish: "sh",
    json: "json",
    yml: "yaml",
    yaml: "yaml",
    md: "md",
    markdown: "md",
    toml: "ini",
    ini: "ini",
    cfg: "ini",
    conf: "ini",
    env: "ini",
    properties: "ini",
    sql: "sql",
    html: "html",
    htm: "html",
    xml: "html",
    svg: "html",
    vue: "html",
    svelte: "html",
    css: "css",
    scss: "css",
  };
  return map[ext] ?? "generic";
}

// ─── HTML page ───────────────────────────────────────────────────────────

/** Compact row: [oldNo|0, newNo|0, class, lineHtml]. */
type Row = [number, number, string, string];

interface PreFile {
  n: string;
  st: string;
  a: number;
  d: number;
  b: boolean;
  h: { t: string; r: Row[] }[];
}

/**
 * Build the self-contained viewer page: dark, mobile-first, zero external
 * requests (no CDN, system fonts). The diff is pre-parsed and
 * pre-highlighted here; the embedded JSON is rendered into the DOM by a
 * few lines of client JS.
 */
export function renderDiffHtml(
  diff: string,
  title: string,
  ttl: string,
): string {
  const files = parseDiff(diff);
  const stats = diffStats(files);

  const pre: PreFile[] = files.map((f) => ({
    n: f.name,
    st: f.binary ? "binary" : f.status,
    a: f.adds,
    d: f.dels,
    b: f.binary,
    h: f.hunks.map((h) => ({
      t: h.header,
      r: h.lines.map((l): Row => {
        if (l.kind === "add" || l.kind === "del") {
          return [
            l.oldNo ?? 0,
            l.newNo ?? 0,
            l.kind,
            highlightLine(l.text, langFor(f.name)),
          ];
        }
        if (l.kind === "ctx") {
          return [
            l.oldNo ?? 0,
            l.newNo ?? 0,
            "ctx",
            highlightLine(l.text, langFor(f.name)),
          ];
        }
        return [0, 0, "meta", escHtml(l.text)];
      }),
    })),
  }));

  const data = {
    t: title,
    d: `${new Date().toISOString().replace("T", " ").slice(0, 16)} UTC`,
    ttl,
    s: { f: stats.files, a: stats.adds, d: stats.dels },
    files: pre,
  };
  // `<` -> \u003c keeps the embedded JSON out of the parser's way.
  const json = JSON.stringify(data).replace(/</g, "\\u003c");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark">
<title>diff · ${escHtml(title)}</title>
<style>
:root{--bg:#0d1117;--card:#161b22;--border:#30363d;--text:#e6edf3;--dim:#8b949e;--acc:#58a6ff;--good:#3fb950;--bad:#f85149}
*{box-sizing:border-box;margin:0}
html{color-scheme:dark}
body{background:var(--bg);color:var(--text);font:13.5px/1.45 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
header{padding:12px 14px 9px;border-bottom:1px solid var(--border);position:sticky;top:0;background:var(--bg);z-index:9}
header .t{font-size:15px}
header .t b{color:#fff}
header .m{color:var(--dim);font-size:11.5px;margin-top:3px}
.chip{font-weight:700}
.chip.a{color:var(--good)}
.chip.d{color:var(--bad)}
details{border-bottom:1px solid var(--border)}
summary{padding:9px 12px;background:var(--card);cursor:pointer;list-style:none;display:flex;gap:8px;align-items:center;font-size:12.5px;border-left:3px solid var(--border)}
summary::-webkit-details-marker{display:none}
summary::before{content:"\\25B8";color:var(--dim)}
details[open]>summary::before{content:"\\25BE"}
summary .fname{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.filetag{font-size:10.5px;color:var(--dim);border:1px solid var(--border);border-radius:4px;padding:0 5px;text-transform:uppercase;letter-spacing:.04em}
.wrap{overflow-x:auto}
.hunkhead{background:#1c2128;color:var(--acc);padding:2px 10px;font-size:11.5px;white-space:pre;margin-top:4px}
.row{display:grid;grid-template-columns:3.4em 3.4em 1fr}
.row .no{text-align:right;padding:0 6px 0 0;color:var(--dim);user-select:none;font-size:12px}
.row pre{white-space:pre;padding:0 10px 0 8px}
.row.add{background:rgba(63,185,80,.13)}
.row.add .no{background:rgba(63,185,80,.22);color:#7ee787}
.row.del{background:rgba(248,81,73,.13)}
.row.del .no{background:rgba(248,81,73,.22);color:#ffa198}
.row.meta{color:var(--dim);font-size:11.5px}
.row.ctx .no{color:#484f58}
.kw{color:#ff7b72}
.str{color:#a5d6ff}
.num{color:#79c0ff}
.cmt{color:#8b949e}
.key{color:#7ee787}
.hdg{color:#ffa657}
.tag{color:#7ee787}
</style>
</head>
<body>
<header>
<div class="t">diff · <b id="title"></b></div>
<div class="m" id="meta"></div>
</header>
<div id="files"></div>
<script>
const D = ${json};
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
document.getElementById("title").textContent = D.t;
document.getElementById("meta").innerHTML =
  D.d + " · expires in " + esc(D.ttl) + " · " + D.s.f +
  " file" + (D.s.f === 1 ? "" : "s") +
  ' <span class="chip a">+' + D.s.a + '</span> ' +
  '<span class="chip d">-' + D.s.d + "</span>";
const root = document.getElementById("files");
for (const f of D.files) {
  const det = document.createElement("details");
  det.open = true;
  const sum = document.createElement("summary");
  sum.innerHTML =
    '<span class="fname">' + esc(f.n) + "</span>" +
    (f.st && f.st !== "modified" ? '<span class="filetag">' + esc(f.st) + "</span>" : "") +
    ' <span class="chip a">+' + f.a + '</span> <span class="chip d">-' + f.d + "</span>";
  det.appendChild(sum);
  const wrap = document.createElement("div");
  wrap.className = "wrap";
  for (const h of f.h) {
    if (h.t) {
      const hh = document.createElement("div");
      hh.className = "hunkhead";
      hh.textContent = h.t;
      wrap.appendChild(hh);
    }
    for (const r of h.r) {
      const row = document.createElement("div");
      row.className = "row " + r[2];
      row.innerHTML =
        '<span class="no">' + (r[0] || "") + "</span>" +
        '<span class="no">' + (r[1] || "") + "</span>" +
        "<pre>" + r[3] + "</pre>";
      wrap.appendChild(row);
    }
  }
  det.appendChild(wrap);
  root.appendChild(det);
}
</script>
</body>
</html>
`;
}

// ─── Source resolution ───────────────────────────────────────────────────

export interface DiffSource {
  kind: "worktree" | "range" | "file" | "text";
  value?: string;
  label: string;
}

/** First fenced code block of a message, or null. */
export function extractFencedDiff(text: string): string | null {
  const m = text.match(/```[a-zA-Z0-9_-]*\n([\s\S]*?)\n?```/);
  return m ? m[1]! : null;
}

/** Heuristic: does this text look like a unified diff? */
export function looksLikeDiff(text: string): boolean {
  const head = text.slice(0, 4000);
  if (/^diff --git /m.test(head)) return true;
  if (/^@@ .+ @@$/m.test(head)) return true;
  if (/^--- /m.test(head) && /^\+\+\+ /m.test(head)) return true;
  return false;
}

const GIT_ARG_RE = /^[A-Za-z0-9._/~^:-]+$/;

/**
 * Resolve a /diff argument to a source. Returns null when the argument
 * matches no form (caller prints the usage line).
 */
export function resolveDiffSource(
  arg: string | undefined,
  cwd: string,
): DiffSource | null {
  const a = (arg ?? "").trim();
  if (!a) return { kind: "worktree", label: "working tree" };

  const fenced = extractFencedDiff(a);
  if (fenced !== null && fenced.trim() !== "")
    return { kind: "text", value: fenced, label: "pasted diff" };

  if (a.includes("\n")) {
    if (looksLikeDiff(a))
      return { kind: "text", value: a, label: "pasted diff" };
    return null;
  }

  const tokens = a.split(/\s+/);
  if (tokens.length === 1) {
    try {
      const st = fs.statSync(path.resolve(cwd, a));
      if (st.isFile())
        return {
          kind: "file",
          value: path.resolve(cwd, a),
          label: path.basename(a),
        };
    } catch {
      // not a file — try git below
    }
    if (GIT_ARG_RE.test(a)) return { kind: "range", value: a, label: a };
  }
  return null;
}

// ─── git ─────────────────────────────────────────────────────────────────

export interface GitDiffResult {
  out: string;
  code: number;
  err: string;
}

const GIT_TIMEOUT_MS = 60_000;
const GIT_OUTPUT_CAP = 4_000_000;

/** Run `git diff [range|HEAD]` in cwd. Never throws. */
export function gitDiff(cwd: string, range?: string): Promise<GitDiffResult> {
  return new Promise((resolve) => {
    const p = spawn("git", range ? ["diff", range] : ["diff", "HEAD"], {
      cwd,
      env: process.env,
    });
    let out = "";
    let err = "";
    const cap = (cur: string, s: string) =>
      cur.length >= GIT_OUTPUT_CAP
        ? cur
        : cur + s.slice(0, GIT_OUTPUT_CAP - cur.length);
    const t = setTimeout(() => {
      try {
        p.kill("SIGKILL");
      } catch {}
    }, GIT_TIMEOUT_MS);
    p.stdout?.on("data", (d) => {
      out = cap(out, String(d));
    });
    p.stderr?.on("data", (d) => {
      err = cap(err, String(d));
    });
    p.on("error", (e) => {
      clearTimeout(t);
      resolve({ out: "", code: 1, err: e.message });
    });
    p.on("close", (code) => {
      clearTimeout(t);
      resolve({ out, code: code ?? 1, err });
    });
  });
}

// ─── webdrop ─────────────────────────────────────────────────────────────

export interface WebdropConfig {
  server: string;
  token: string;
}

export const DEFAULT_TTL = "7d";
export const MAX_DIFF_BYTES = 2 * 1024 * 1024;

/**
 * webdrop credentials: env (WEBDROP_SERVER + WEBDROP_TOKEN) wins, then
 * ~/.config/webdrop/config.toml (same file the webdrop CLI reads).
 * `home` is injectable for tests.
 */
export function loadWebdropConfig(
  home: string = defaultHome(),
): WebdropConfig | null {
  const envServer = (process.env.WEBDROP_SERVER ?? "").trim();
  const envToken = (process.env.WEBDROP_TOKEN ?? "").trim();
  if (envServer && envToken)
    return { server: envServer.replace(/\/+$/, ""), token: envToken };
  try {
    const raw = fs.readFileSync(
      path.join(home, ".config", "webdrop", "config.toml"),
      "utf-8",
    );
    const get = (k: string) =>
      raw.match(new RegExp(`^\\s*${k}\\s*=\\s*"([^"]*)"`, "m"))?.[1] ?? "";
    const server = get("server");
    const token = get("token");
    if (server && token) return { server: server.replace(/\/+$/, ""), token };
  } catch {
    // no config file
  }
  return null;
}

const PUBLISH_TIMEOUT_MS = 60_000;

/**
 * Upload HTML to webdrop, return the public URL. webdrop assigns a
 * random 24-hex object key to .html (a "doc" type), so URLs are
 * unguessable. Never throws.
 */
export async function publishHtml(
  html: string,
  cfg: WebdropConfig,
  ttl: string = DEFAULT_TTL,
): Promise<{ url?: string; error?: string }> {
  const handle = `diff-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 8)}.html`;
  let res: Response;
  try {
    res = await fetch(`${cfg.server}/api/v1/files`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${cfg.token}`,
        "X-Webdrop-Handle": handle,
        "X-Webdrop-TTL": ttl,
        "Content-Type": "text/html; charset=utf-8",
      },
      body: html,
      signal: AbortSignal.timeout(PUBLISH_TIMEOUT_MS),
    });
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e);
    return { error: `webdrop unreachable: ${m}` };
  }
  if (!res.ok) {
    await res.text().catch(() => {}); // drain the body
    return { error: `webdrop upload failed (${res.status})` };
  }
  const j = (await res.json().catch(() => null)) as { url?: string } | null;
  if (j?.url) return { url: j.url };
  return { error: "webdrop upload: bad response" };
}

// ─── Top level ───────────────────────────────────────────────────────────

const firstLine = (s: string) =>
  (s.split("\n").find((l) => l.trim()) ?? "").trim();
const mb = (b: number) => (b / 1024 / 1024).toFixed(1);

/**
 * Full /diff pipeline: resolve source -> read diff -> render -> publish.
 * Returns the final user-facing line(s) (tagged, no emoji).
 */
export async function publishDiff(
  cwd: string,
  arg: string | undefined,
  home: string = defaultHome(),
): Promise<string> {
  const src = resolveDiffSource(arg, cwd);
  if (!src) {
    return "[!] usage: /diff [git-range | file | diff-paste] (default: working tree)";
  }

  // Fail fast on missing config: without a shelf, no source can publish.
  const cfg = loadWebdropConfig(home);
  if (!cfg)
    return "[!] webdrop not configured (need WEBDROP_SERVER + WEBDROP_TOKEN or ~/.config/webdrop/config.toml)";

  let diffText: string;
  if (src.kind === "worktree" || src.kind === "range") {
    const r = await gitDiff(cwd, src.kind === "range" ? src.value : undefined);
    if (r.code !== 0)
      return `[!] git diff failed: ${firstLine(r.err) || `exit ${r.code}`}`;
    if (!r.out.trim())
      return `[!] no diff${src.kind === "range" ? ` for ${src.value}` : ""} (nothing changed)`;
    diffText = r.out;
  } else if (src.kind === "file") {
    try {
      const st = fs.statSync(src.value!);
      if (st.size > MAX_DIFF_BYTES)
        return `[!] ${src.label} too large (${mb(st.size)} MB, max 2 MB)`;
      diffText = fs.readFileSync(src.value!, "utf-8");
    } catch (e) {
      return `[!] cannot read ${src.label}: ${firstLine(String(e))}`;
    }
    if (!looksLikeDiff(diffText))
      return `[!] ${src.label} does not look like a diff`;
  } else {
    diffText = src.value!;
  }

  if (Buffer.byteLength(diffText, "utf-8") > MAX_DIFF_BYTES)
    return `[!] diff too large (${mb(Buffer.byteLength(diffText, "utf-8"))} MB, max 2 MB)`;

  const stats = diffStats(parseDiff(diffText));
  const html = renderDiffHtml(diffText, src.label, DEFAULT_TTL);
  const r = await publishHtml(html, cfg);
  if (r.error) return `[!] ${r.error}`;
  return (
    `[ok] ${src.label} · ${stats.files} file${stats.files === 1 ? "" : "s"} ` +
    `+${stats.adds} -${stats.dels} · ttl ${DEFAULT_TTL}\n${r.url}`
  );
}
