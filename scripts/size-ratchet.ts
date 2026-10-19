// Deterministic size gate. No inference. Fails on new bloat or growth.
// Usage: bun scripts/size-ratchet.ts [--update] [--base <git-ref>]
//   --base: enable the AST export gate, comparing top-level exports vs that ref
//   --update: rewrite size-ratchet.json from current state (run after a split)
//
// Base-ref contract (harden-repo, jarate 2026-10-20):
//   - empty --base (or a ref git cannot resolve, e.g. "origin/" on a push to
//     main where github.base_ref is empty) -> line ratchet only, export gate
//     skipped with a one-line note. The ratchet always runs.
//   - resolvable --base (PR base ref, HEAD, a sha) -> export gate compares
//     top-level exports of changed >2,000-line files against that ref.

import { execSync } from "node:child_process";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

const FLAG = 800,
  HARD = 2000,
  TEST_MULT = 3;
const RATCHET = "size-ratchet.json";
// templates/ = scaffold copy, not live code. .pi-bg-wt/ = kept dispatch
// worktrees (outside the repo in normal operation; excluded defensively).
const EXCLUDE = [
  /node_modules/,
  /(^|\/)dist\//,
  /(^|\/)build\//,
  /\.venv/,
  /templates\//,
  /\.pi-bg-wt\//,
];

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir)) {
    if (e === ".git") continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (/\.(ts|tsx|js|py)$/.test(e) && !EXCLUDE.some((r) => r.test(p)))
      out.push(p);
  }
  return out;
}
const count = (p: string) =>
  readFileSync(p, "utf8")
    .split("\n")
    .filter((l) => l.trim()).length;
function topExports(src: string): number {
  const sf = ts.createSourceFile("f.ts", src, ts.ScriptTarget.Latest, true);
  return sf.statements.filter((s) =>
    (s.modifiers ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword),
  ).length;
}
const sh = (c: string) =>
  execSync(c, { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });

const args = process.argv.slice(2);
const update = args.includes("--update");
const baseIdx = args.indexOf("--base");
let base = baseIdx >= 0 ? (args[baseIdx + 1] ?? "") : "";
// Normalize a missing/empty base and an unresolvable ref (CI push-to-main
// passes "origin/" when github.base_ref is empty) to "ratchet only".
if (base) {
  try {
    execSync(`git rev-parse --verify --quiet "${base}"^{commit}`, {
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch {
    console.log(
      `NOTE: base ref "${base}" not resolvable - running line ratchet only (export gate skipped)`,
    );
    base = "";
  }
}
const changed = base
  ? sh(`git diff --name-only ${base}...HEAD`).trim().split("\n")
  : [];
const ratchet: Record<string, number> = (() => {
  try {
    return JSON.parse(readFileSync(RATCHET, "utf8"));
  } catch {
    return {};
  }
})();

let fail = false;
for (const f of walk(".")) {
  const n = count(f);
  const mult = f.endsWith(".test.ts") || f.endsWith("_test.py") ? TEST_MULT : 1;
  if (n > FLAG * mult) {
    if (ratchet[f] === undefined) {
      if (update) ratchet[f] = n;
      else {
        fail = true;
        console.log(
          `NEW BLOAT ${f}: ${n} lines > ${FLAG * mult} - split, do not ratchet`,
        );
      }
    } else if (n > ratchet[f] * mult) {
      if (update) ratchet[f] = n;
      else {
        fail = true;
        console.log(`GROWTH    ${f}: ${n} > budget ${ratchet[f]}`);
      }
    }
  }
  if (base && n > HARD && changed.includes(f)) {
    let prev = 0;
    try {
      prev = topExports(sh(`git show ${base}:${f}`));
    } catch {
      prev = 0;
    } // new file
    const cur = topExports(readFileSync(f, "utf8"));
    if (cur > prev) {
      fail = true;
      console.log(
        `EXPORT GATE ${f}: ${cur} top-level exports (was ${prev}) - extract to a sibling module`,
      );
    }
  }
}
if (update) writeFileSync(RATCHET, `${JSON.stringify(ratchet, null, 2)}\n`);
console.log(
  fail
    ? "SIZE GATE: FAIL"
    : `SIZE GATE: OK (${Object.keys(ratchet).length} ratcheted)`,
);
process.exit(fail ? 1 : 0);
