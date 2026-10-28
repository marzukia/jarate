/**
 * Handover compaction — mechanism A (design v2, PR1).
 *
 * On a qualifying compaction (auto at the handoff threshold, manual
 * /compact or /handover) the bridge returns a durable handover doc as pi's
 * CUSTOM compaction result: `{ compaction: { summary: doc, ... } }` —
 * no cancel, no restart, the op-window flow is untouched (review F1/F3).
 *
 * The doc is a deterministic template (NO LLM call): the raw transcript
 * span (current state first) + References, State, Last user asks
 * extracted from the session, plus <read-files>/<modified-files> tags →
 * deterministic, CUMULATIVE: prior doc tags ∪ current span fileOps
 * (review F9). /compact operator focus instructions are rendered as ONE
 * line in the State section (absent when none passed).
 *
 * Cumulative: the prior doc (latest.md pointer) is the base (F6), so
 * context compaction never shrinks the doc — it only retires done work.
 * The doc is written to <storeDir>/<YYYYMMDD-HHMM>-<slug>.md BEFORE
 * compaction returns; on disk before the compact is the failure-handling
 * invariant (doc already on disk → restart picks it up in PR2).
 */

import fs from "node:fs";
import path from "node:path";
import type {
  ContextUsage,
  ExtensionContext,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { fmtTokensLC } from "./format";
import { jobsView } from "./jobs";
import { formatTaskLine, loadTasks } from "./tasks";
import { defaultHome, loadBoard, renderBoard } from "./todos";
import { keptTailMessages, msgText, serializeTranscript } from "./transcript";
import { getDefaultChannel, loadChannelConfig } from "./types";

// re-exported for the tests + existing importers
export {
  keptTailMessages,
  msgText,
  serializeTranscript,
} from "./transcript";

// ─── Types ──────────────────────────────────────────────────────────────────

/** Minimal structural shape of pi's CompactionPreparation (the main
 *  pi-coding-agent entry does not re-export the type name). */
export interface HandoverPreparation {
  firstKeptEntryId: string;
  messagesToSummarize: HandoverMessage[];
  turnPrefixMessages: HandoverMessage[];
  isSplitTurn: boolean;
  tokensBefore: number;
  previousSummary?: string;
  fileOps: {
    read: ReadonlySet<string>;
    written: ReadonlySet<string>;
    edited: ReadonlySet<string>;
  };
}

/** Minimal structural shape of pi's AgentMessage (not re-exported).
 *  No index signature: pi's message interfaces are closed, and the
 *  structural subset must stay assignable from all of them. */
export interface HandoverMessage {
  role?: string;
  content?: unknown;
  customType?: string;
  details?: unknown;
}

/** Resolved handoff settings (defaults → ~/.pi/agent → <cwd>/.pi → env). */
export interface HandoffSettings {
  /** Default TRUE (operator 2026-09-23: handoff is the default behaviour,
   *  not a flag to flip). Opt out with `handoff: { enabled: false }` in
   *  settings.json or HANDOFF_ENABLED=0 in the service env. */
  enabled: boolean;
  /** Fraction (0..1) of the TOTAL context window where the handoff kicks
   *  in for threshold compactions. Env: HANDOFF_THRESHOLD. */
  threshold: number;
  /** sizeGuard hard cap for the doc, in tokens. */
  sizeGuardTokens: number;
  /** Store dir. "~" expands to $HOME. */
  storeDir: string;
}

export const HANDOFF_DEFAULTS: HandoffSettings = {
  enabled: true,
  threshold: 0.8,
  sizeGuardTokens: 12_000,
  storeDir: "~/.jarate/handovers",
};

/** Flags the wiring evaluates per compaction (pure, testable). */
export interface ShouldHandoffFlags {
  enabled: boolean;
  threshold: number;
  /** A handoff is already being built (set synchronously at handler entry,
   *  review F10). */
  inFlight: boolean;
  /** 0..100 from ctx.getContextUsage().percent; null when unavailable. */
  percent: number | null;
  /** A handover doc was written within HANDOFF_FRESH_WINDOW_MS: the
   *  (possibly just-seeded) session is not yet handoff-eligible. */
  freshWindow: boolean;
}

/** Deterministic state extracted from the session (no LLM). */
export interface ParsedState {
  readFiles: string[];
  modifiedFiles: string[];
  refs: string[];
  worktrees: string[];
  links: string[];
  /** Rendered todo board ("" when empty/unknown). */
  todoBoard: string;
  /** Rendered dispatch state ("" when unknown). */
  dispatchState: string;
  /** Rendered scheduled-task lines ("" when none/unknown). */
  scheduledTasks: string;
  contextLine: string;
  modelLabel: string;
  sessionStats: string;
  lastUserAsks: string[];
  /** /compact operator focus instructions (absent when none passed). */
  operatorFocus?: string;
}

/** Context inputs extractDeterministic needs from the live ctx. */
export interface ExtractCtxState {
  /** Previous handover doc (cumulative base), null when none. */
  priorDoc: string | null;
  sessionFile?: string | null;
  sessionEntryCount?: number | null;
  contextUsage?: ContextUsage | null;
  modelLabel?: string | null;
  dispatchText?: string | null;
  /** Rendered scheduled-task lines ("" or null when none/unknown). */
  scheduledText?: string | null;
  todoText?: string | null;
}

// ─── Settings resolution ───────────────────────────────────────────────────

/** Resolve handoff settings: defaults, then ~/.pi/agent/settings.json,
 *  then <cwd>/.pi/settings.json (project wins), then env overrides
 *  (HANDOFF_THRESHOLD / HANDOFF_ENABLED keep per-box tuning out of
 *  settings). Invalid values fall back to defaults with a warning. */
export function resolveHandoffSettings(
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): HandoffSettings {
  const s: HandoffSettings = { ...HANDOFF_DEFAULTS };
  const sources = [
    path.join(defaultHome(), ".pi", "agent", "settings.json"),
    path.join(cwd, ".pi", "settings.json"),
  ];
  for (const file of sources) {
    let data: unknown;
    try {
      data = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      continue; // missing/unreadable source
    }
    const h = (data as { handoff?: unknown })?.handoff;
    if (!h || typeof h !== "object") continue;
    const o = h as Record<string, unknown>;
    if (typeof o.enabled === "boolean") s.enabled = o.enabled;
    if (o.threshold !== undefined) {
      const t = Number(o.threshold);
      if (Number.isFinite(t) && t > 0 && t <= 1) s.threshold = t;
      else
        console.warn(
          `[handover] invalid handoff.threshold (${String(o.threshold)}) - using ${s.threshold}`,
        );
    }
    if (o.sizeGuardTokens !== undefined) {
      const g = Number(o.sizeGuardTokens);
      if (Number.isFinite(g) && g > 0) s.sizeGuardTokens = Math.floor(g);
    }
    if (typeof o.storeDir === "string" && o.storeDir.length > 0)
      s.storeDir = o.storeDir;
  }
  const envT = Number(env.HANDOFF_THRESHOLD ?? "");
  if (Number.isFinite(envT) && envT > 0 && envT <= 1) s.threshold = envT;
  // Env override of the flag itself (1/0, true/false) — same precedence as
  // the other env knobs: env beats settings.json beats default.
  const envE = env.HANDOFF_ENABLED?.trim().toLowerCase();
  if (envE === "1" || envE === "true") s.enabled = true;
  else if (envE === "0" || envE === "false") s.enabled = false;
  return s;
}

/** Pure gate: should this compaction produce a handover?
 *  off / in-flight / fresh-window → no; manual → yes; threshold → only
 *  at/over the fraction of the total window; overflow/other → no (built-in). */
export function shouldHandoff(
  event: { reason: string },
  flags: ShouldHandoffFlags,
): boolean {
  if (!flags.enabled) return false;
  if (flags.inFlight) return false;
  if (flags.freshWindow) return false;
  if (event.reason === "manual") return true;
  if (event.reason === "threshold") {
    // MINOR-1 (PR1 review; operator resolved with option a): the threshold is
    // a fraction of the TOTAL context window, NOT the remaining space —
    // INTENTIONAL, do not change the math. Pi's auto compaction fires at
    // window - reserveTokens (~94% of a 262k window), always above the 80%
    // gate, so auto compactions ALWAYS hand off. The gate has visible
    // effect only for manual /compact or /handover well under the window
    // (and on small windows where reserve pushes the auto point down).
    if (flags.percent == null) return true; // pi already picked the point
    return flags.percent >= flags.threshold * 100;
  }
  return false;
}

/** Strip LLM-only framing (channel-ctx, todo-board) from an inbound body
 *  so user asks read as the user wrote them. */
export function stripPromptFraming(s: string): string {
  return s
    .replace(/<channel-ctx[\s\S]*?<\/channel-ctx>/g, "")
    .replace(/<todo-board>[\s\S]*?<\/todo-board>/g, "")
    .replace(/<replied-message[\s\S]*?<\/replied-message>/g, "")
    .trim();
}

// ─── Prior doc + file tags (cumulative, F9) ────────────────────────────────

/** Parse <read-files>/<modified-files> tags out of a prior doc. One path
 *  per line; missing/empty blocks → empty arrays.
 *
 *  Anchors each tag to its LAST occurrence — the doc's own footer is always
 *  the last block — so a transcript scrape of handover.ts source mid-doc
 *  cannot win (RCA F4a: an old doc's footer contained the literal
 *  `\n${list(s.readFiles)}` text from such a scrape, and the first-match
 *  parse re-rendered it, self-perpetuating). Uninterpolated template lines
 *  are dropped as paths. */
export function parsePriorTags(doc: string | null): {
  readFiles: string[];
  modifiedFiles: string[];
} {
  const pick = (tag: string): string[] => {
    const text = doc ?? "";
    const re = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "g");
    let last: string | null = null;
    for (const m of text.matchAll(re)) last = m[1];
    if (last == null) return [];
    return last
      .split("\n")
      .map((l) => l.trim())
      .filter(
        (l) =>
          l.length > 0 &&
          l !== "(none)" &&
          !l.includes("${") &&
          !l.startsWith("\\"),
      );
  };
  return {
    readFiles: pick("read-files"),
    modifiedFiles: pick("modified-files"),
  };
}

// ─── Deterministic extraction ───────────────────────────────────────────────

const LINK_RE = /https?:\/\/[^\s"'<>)\]`,;]+/g;
const PR_RE = /#(\d{1,8})\b/g;
const TICKET_RE = /\b(\d{8}-\d{6}-\d+)\b/g;
const WORKTREE_PATH_RE = /(?:~|\/[\w.-]+)+\/\.pi-bg-wt\/[^\s"'<>)\]`,;]+/g;
const WORKTREE_BRANCH_RE = /\bpi-bg\/(\d{8}-\d{6}-\d+)/g;

/** File-tag list cap (RCA F4a): ~10 paths per tag, newest first. */
const FILE_TAG_CAP = 10;

/** Deterministic extraction (pure): file tags (cumulative, capped, newest
 *  first), PR/issue/ticket refs, worktree paths + branches, links, last
 *  user asks (human only), context/model/session lines. No LLM in here. */
export function extractDeterministic(
  preparation: HandoverPreparation,
  branchEntries: SessionEntry[],
  ctxState: ExtractCtxState,
): ParsedState {
  // File tags: prior doc ∪ current span (F9), NEWEST FIRST, capped (RCA
  // F4a) — fileOps alone only covers the NEW span and would drop the
  // cumulative list; the cap keeps the footer small, newest paths win.
  const prior = parsePriorTags(ctxState.priorDoc);
  const spanRead = [...preparation.fileOps.read];
  const spanModified = [
    ...preparation.fileOps.written,
    ...preparation.fileOps.edited,
  ];
  const modifiedSet = new Set<string>([
    ...spanModified,
    ...prior.modifiedFiles,
  ]);
  const uniq = (items: string[]): string[] => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const it of items) {
      if (!it || seen.has(it)) continue;
      seen.add(it);
      out.push(it);
    }
    return out;
  };
  // fileOps Set iteration is first-seen (oldest) order → reverse for
  // newest-first; span files are newer than prior-doc files.
  // read=read-only invariant (PR #156 F4a): a prior-doc read that is
  // MODIFIED in the current span leaves the read list entirely.
  const spanModSet = new Set<string>(spanModified);
  const readFiles = uniq([
    ...spanRead.reverse().filter((f) => !modifiedSet.has(f)),
    ...prior.readFiles.filter((f) => !spanModSet.has(f)),
  ]).slice(0, FILE_TAG_CAP);
  const modifiedFiles = uniq([
    ...spanModified.reverse(),
    ...prior.modifiedFiles,
  ]).slice(0, FILE_TAG_CAP);

  // Reference windows (RCA F4b): the old full-span corpus kept refs and
  // worktrees cited by work the session had already moved on from. refs +
  // links come from the LAST ~50% of the span; worktree paths from the
  // LAST ~20 messages. Empty span falls back to the inbound bodies.
  const spanTexts = [
    ...preparation.messagesToSummarize.map(msgText),
    ...preparation.turnPrefixMessages.map(msgText),
  ];
  const inboundCorpus = branchEntries
    .filter((e) => e.type === "custom_message")
    .map((e) => inboundBody(e))
    .filter(Boolean)
    .join("\n");
  const refText = spanTexts.length
    ? spanTexts.slice(Math.floor(spanTexts.length / 2)).join("\n")
    : inboundCorpus;
  const wtText = spanTexts.length
    ? spanTexts.slice(-20).join("\n")
    : inboundCorpus;

  // Last user asks (RCA F3): HUMAN channel inbounds only, last 2 — the old
  // list read like a pi-bg server log (Beepy <embed> webhooks, machine-wake
  // cards, bridge-injected wakes). #291: an ask is PENDING only when NO
  // assistant answer landed after it in the captured range (the snapshot) —
  // the old list pointed at handled items (the answer landed moments before
  // the snapshot) and the resumed agent re-answered them. Fallback:
  // user-role span messages (same answer check; the kept tail is entirely
  // newer than the span, so any assistant in it answers every span ask).
  const isAssistantEntry = (e: SessionEntry): boolean =>
    e.type === "message" &&
    (e as { message?: { role?: string } }).message?.role === "assistant";
  let lastAssistantIdx = -1;
  for (let i = branchEntries.length - 1; i >= 0; i--) {
    if (isAssistantEntry(branchEntries[i])) {
      lastAssistantIdx = i;
      break;
    }
  }
  const asks: string[] = [];
  for (let i = 0; i < branchEntries.length; i++) {
    const e = branchEntries[i];
    if (e.type !== "custom_message" || e.customType !== "channel-inbound")
      continue;
    if (!isHumanInbound(e)) continue;
    if (lastAssistantIdx > i) continue; // an assistant answer landed after it
    const body = stripPromptFraming(inboundBody(e));
    if (body) asks.push(body);
  }
  if (asks.length === 0) {
    const spanMsgs = [
      ...preparation.messagesToSummarize,
      ...preparation.turnPrefixMessages,
    ];
    let spanLastAssistant = -1;
    for (let i = spanMsgs.length - 1; i >= 0; i--) {
      if (spanMsgs[i]?.role === "assistant") {
        spanLastAssistant = i;
        break;
      }
    }
    const keptIdx = branchEntries.findIndex(
      (e) => e.id === preparation.firstKeptEntryId,
    );
    const tailHasAssistant =
      keptIdx >= 0 && branchEntries.slice(keptIdx).some(isAssistantEntry);
    for (let i = 0; i < spanMsgs.length; i++) {
      const m = spanMsgs[i];
      if (m?.role !== "user") continue;
      if (spanLastAssistant > i || tailHasAssistant) continue;
      const body = stripPromptFraming(msgText(m));
      if (body) asks.push(body);
    }
  }

  return {
    readFiles,
    modifiedFiles,
    refs: extractRefs(refText),
    worktrees: extractWorktrees(wtText),
    links: extractLinks(refText),
    todoBoard: (ctxState.todoText ?? "").trim(),
    dispatchState: (ctxState.dispatchText ?? "").trim(),
    scheduledTasks: (ctxState.scheduledText ?? "").trim(),
    contextLine: formatContextLine(
      ctxState.contextUsage ?? null,
      preparation.tokensBefore,
    ),
    modelLabel: ctxState.modelLabel ?? "",
    sessionStats: formatSessionStats(
      ctxState.sessionFile ?? null,
      ctxState.sessionEntryCount ?? null,
    ),
    lastUserAsks: asks
      .slice(-2)
      .map((a) => (a.length > 280 ? `${a.slice(0, 277)}...` : a)),
  };
}

/** Body of a channel-inbound custom entry: details.body (clean),
 *  fallback to the serialized content. */
function inboundBody(e: SessionEntry): string {
  if (e.type !== "custom_message") return "";
  const d = (e as { details?: { body?: unknown } }).details;
  if (typeof d?.body === "string" && d.body.trim()) return d.body;
  return msgText(e as unknown as HandoverMessage);
}

function dedupe(items: string[], cap: number): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const it of items) {
    const k = it.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(it);
    if (out.length >= cap) break;
  }
  return out;
}

/** PR/issue #ids + pi-bg ticket ids found in the corpus. */
export function extractRefs(text: string): string[] {
  const refs: string[] = [];
  for (const m of text.matchAll(PR_RE)) refs.push(`#${m[1]}`);
  for (const m of text.matchAll(TICKET_RE)) refs.push(m[1]);
  return dedupe(refs, 40);
}

/** Worktree paths and pi-bg/<id> branches. */
export function extractWorktrees(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(WORKTREE_PATH_RE)) out.push(m[0]);
  for (const m of text.matchAll(WORKTREE_BRANCH_RE)) out.push(`pi-bg/${m[1]}`);
  return dedupe(out, 20);
}

/** URLs (trailing sentence punctuation stripped), capped. */
export function extractLinks(text: string): string[] {
  return dedupe(
    (text.match(LINK_RE) ?? []).map((l) => l.replace(/[.,;:!?]+$/, "")),
    20,
  );
}

export function formatContextLine(
  usage: ContextUsage | null,
  tokensBefore: number,
): string {
  if (usage && Number.isFinite(usage.contextWindow)) {
    const t = usage.tokens != null ? fmtTokensLC(usage.tokens) : "?";
    const p = usage.percent != null ? `${Math.round(usage.percent)}%` : "?";
    return `${t} / ${fmtTokensLC(usage.contextWindow)} tokens (${p})`;
  }
  return `${fmtTokensLC(tokensBefore)} tokens before compaction`;
}

export function formatSessionStats(
  sessionFile: string | null,
  entryCount: number | null,
): string {
  if (!sessionFile) return "unknown";
  // C5 (polish sweep): build each stat as a self-contained paren group.
  // The old form left a stray ")" when statSync failed ("/path)" or
  // "/path, 123 entries)") - the close paren belonged to the size group
  // but the group was absent.
  let stats = "";
  try {
    const size = fs.statSync(sessionFile).size;
    stats = ` (${(size / (1024 * 1024)).toFixed(1)}MB)`;
  } catch {
    // stat failed: omit the size, keep the path clean
  }
  const entries = entryCount != null ? ` (${entryCount} entries)` : "";
  return `${sessionFile}${stats}${entries}`;
}

/**
 * Sender of a channel-inbound entry (RCA F3): the `sender=` (rooms) or
 * `from=` (1:1) attribute of the <channel-ctx> block, which is always the
 * FIRST line of the entry's content. null when the entry carries no
 * channel-ctx — bridge-injected prompts (sleep wakes, task fires, restart
 * wakes) are sent as plain text.
 */
export function inboundSender(e: SessionEntry): string | null {
  const content = msgText(e as unknown as HandoverMessage);
  const firstLine = content.split("\n", 1)[0];
  if (!firstLine.startsWith("<channel-ctx")) return null;
  const m =
    firstLine.match(/\bsender="([^"]*)"/) ??
    firstLine.match(/\bfrom="([^"]*)"/);
  return m ? m[1].trim() : null;
}

/** Non-human senders on channel inbounds: the Beepy relay webhook (pi-bg
 *  callbacks, machine-wake cards). Case-insensitive. */
const NON_HUMAN_SENDERS = new Set(["beepy"]);

/**
 * True when a channel-inbound entry is a HUMAN ask (RCA F3 — the "Last user
 * asks" list used to read like a pi-bg server log):
 *  - carries a <channel-ctx> sender (bridge-injected wakes don't)
 *  - the sender is not the bot relay (Beepy)
 *  - the body has free text: not empty, not a pi-bg <embed>, not a legacy
 *    [bg: line (one release), not a bare <todo-board> (stripped already).
 */
export function isHumanInbound(e: SessionEntry): boolean {
  const sender = inboundSender(e);
  if (sender == null) return false;
  if (NON_HUMAN_SENDERS.has(sender.toLowerCase())) return false;
  const body = stripPromptFraming(inboundBody(e));
  if (!body || body === "(empty)") return false;
  if (body.startsWith("<embed>")) return false;
  if (body.startsWith("[bg:")) return false;
  return true;
}

// ─── Doc assembly ───────────────────────────────────────────────────────────

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

export function buildHeader(
  now: Date,
  sessionId: string,
  tokensBefore: number,
): string {
  const d = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
  return `# Handover - ${d} · session ${sessionId} · ${fmtTokensLC(tokensBefore)} tokens → handoff`;
}

function renderReferences(s: ParsedState): string {
  const lines: string[] = [];
  if (s.refs.length) lines.push(`- PR/issues/tickets: ${s.refs.join(", ")}`);
  for (const w of s.worktrees) lines.push(`- worktree: ${w}`);
  for (const l of s.links) lines.push(`- link: ${l}`);
  return lines.length ? lines.join("\n") : "(none)";
}

function renderState(s: ParsedState): string {
  const lines = [
    `- context: ${s.contextLine || "unknown"}`,
    `- model: ${s.modelLabel || "unknown"}`,
    `- session: ${s.sessionStats || "unknown"}`,
    "- dispatch:",
    s.dispatchState ? s.dispatchState : "  (none)",
    "- scheduled:",
    s.scheduledTasks ? s.scheduledTasks : "  (none)",
    "- todos:",
    s.todoBoard ? s.todoBoard : "  (none)",
  ];
  // /compact operator focus: ONE line, only when instructions were passed
  // (the line is absent otherwise — tests pin both cases).
  if (s.operatorFocus) lines.push(`- Operator focus: ${s.operatorFocus}`);
  return lines.join("\n");
}

function renderLastAsks(s: ParsedState): string {
  if (!s.lastUserAsks.length) return "(none)";
  return s.lastUserAsks.map((a, i) => `${i + 1}. ${a}`).join("\n");
}

export function renderFileTags(s: ParsedState): string {
  // Machine tags: an empty set renders a TIGHT empty block (no blank
  // line, no "(none)") so parsePriorTags round-trips to [] and the
  // cumulative base stays clean.
  const list = (files: string[]) =>
    files.length ? `${files.join("\n")}\n` : "";
  return `<read-files>\n${list(s.readFiles)}</read-files>\n<modified-files>\n${list(s.modifiedFiles)}</modified-files>`;
}

const NONE = "(none)";

// ─── sizeGuard ──────────────────────────────────────────────────────────────

/** Conservative token estimate: 4 chars/token (same basis as pi's
 *  estimateTokens). */
export const estTokens = (s: string): number => Math.ceil(s.length / 4);

export interface DocSection {
  title: string;
  body: string;
}
export interface DocParts {
  header: string;
  sections: DocSection[];
  tags: string;
}

const TAGS_RE =
  /<read-files>[\s\S]*?<\/read-files>\s*<modified-files>[\s\S]*?<\/modified-files>\s*$/;

/** Split a rendered doc into header / sections / file-tag footer. */
export function splitDoc(doc: string): DocParts {
  const m = doc.match(TAGS_RE);
  const tags = m ? m[0] : "";
  const body = m ? doc.slice(0, m.index ?? 0) : doc;
  const chunks = body.split(/^(?=## )/m);
  const sections: DocSection[] = chunks.slice(1).map((c) => {
    const nl = c.indexOf("\n");
    const line = nl === -1 ? c : c.slice(0, nl);
    // The split keeps the "## " prefix in the chunk; strip it so
    // assembleDoc's `## ${title}` round-trips to a SINGLE "## " (issue
    // #134: every guarded doc rendered "## ## X" headers).
    return {
      title: line.replace(/^## /, "").trim(),
      body: nl === -1 ? "" : c.slice(nl + 1).trim(),
    };
  });
  return { header: (chunks[0] ?? "").trimEnd(), sections, tags };
}

export function assembleDoc(parts: DocParts): string {
  const out: string[] = [parts.header];
  for (const s of parts.sections) out.push(`## ${s.title}\n${s.body}`);
  if (parts.tags) out.push(parts.tags.trimEnd());
  return out.join("\n\n");
}

/** Never condensed: the sections that must survive any size cut. */
const GUARD_PROTECTED = [
  "In-flight",
  "References",
  "Gotchas",
  "State (machine)",
  "user asks",
];
/** Condense order: retired/cheap-to-lose content first. Transcript is LAST
 *  (B2, polish sweep): it is the raw conversation content, not prose
 *  metadata - only the actual exchange gets condensed, and only after
 *  every LLM section is already at its 40% floor. */
const GUARD_CONDENSE_ORDER = [
  "Done",
  "Open follow-ups",
  "Blockers",
  "Decisions & Rationale",
  "Mission",
  "Transcript",
];

function condenseBody(body: string): string {
  const lines = body.split("\n");
  if (lines.length <= 2) return body;
  const keep = Math.max(1, Math.floor(lines.length * 0.4));
  const kept = lines
    .slice(0, keep)
    .map((l) => (l.length > 200 ? `${l.slice(0, 197)}...` : l));
  kept.push("… (condensed by size guard)");
  return kept.join("\n");
}

/** Cap the doc at maxTokens (default 12k). Deterministic sections and the
 *  protected prose sections are never touched first: condense
 *  Done → Follow-ups → Blockers → Decisions → Mission, one section per
 *  pass until under budget. Idempotent under repeated passes. */
export function sizeGuard(
  doc: string,
  maxTokens: number = HANDOFF_DEFAULTS.sizeGuardTokens,
): string {
  if (estTokens(doc) <= maxTokens) return doc;
  const parts = splitDoc(doc);
  const isProtected = (t: string) => GUARD_PROTECTED.some((p) => t.includes(p));
  for (let pass = 0; pass < 200; pass++) {
    if (estTokens(assembleDoc(parts)) <= maxTokens) break;
    const target = GUARD_CONDENSE_ORDER.map((name) =>
      parts.sections.find(
        (s) => s.title.includes(name) && !isProtected(s.title),
      ),
    ).find((s) => s && s.body.length > 80);
    if (!target) break;
    target.body = condenseBody(target.body);
  }
  return assembleDoc(parts);
}

// ─── Store ─────────────────────────────────────────────────────────────────

function djb2(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h;
}

const hashSlug = (s: string): string =>
  djb2(s).toString(36).padStart(8, "0").slice(0, 8);
const hashFingerprint = (s: string): string =>
  `${djb2(s).toString(36)}${djb2(`${s.length}:${s}`).toString(36)}`
    .padStart(12, "0")
    .slice(0, 12);

function expandHome(p: string, home: string): string {
  return p === "~" || p.startsWith("~/") ? path.join(home, p.slice(1)) : p;
}

const stamp = (d: Date): string =>
  `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}-${pad2(d.getHours())}${pad2(d.getMinutes())}`;

export interface WriteHandoverOpts {
  storeDir?: string;
  home?: string;
  now?: Date;
  slug?: string;
}

/** Write the doc to <storeDir>/<YYYYMMDD-HHMM>-<slug>.md (atomic) and
 *  refresh the latest.md pointer (path + fingerprint). */
export function writeHandover(
  doc: string,
  opts: WriteHandoverOpts = {},
): { path: string; latest: string } {
  const home = opts.home ?? defaultHome();
  const storeDir = expandHome(opts.storeDir ?? HANDOFF_DEFAULTS.storeDir, home);
  const now = opts.now ?? new Date();
  fs.mkdirSync(storeDir, { recursive: true });
  const file = path.join(
    storeDir,
    `${stamp(now)}-${opts.slug ?? hashSlug(doc)}.md`,
  );
  fs.writeFileSync(`${file}.tmp`, doc);
  fs.renameSync(`${file}.tmp`, file);
  const latest = path.join(storeDir, "latest.md");
  const latestBody = [
    "# Handover pointer",
    `path: ${file}`,
    `fingerprint: ${hashFingerprint(doc)}`,
    `updated: ${now.toISOString()}`,
    "",
  ].join("\n");
  fs.writeFileSync(`${latest}.tmp`, latestBody);
  fs.renameSync(`${latest}.tmp`, latest);
  return { path: file, latest };
}

/** Load the previous handover doc via the latest.md pointer; null when
 *  missing or unreadable (first handover). */
export function loadPreviousHandover(
  opts: { storeDir?: string; home?: string } = {},
): string | null {
  const home = opts.home ?? defaultHome();
  const storeDir = expandHome(opts.storeDir ?? HANDOFF_DEFAULTS.storeDir, home);
  let raw: string;
  try {
    raw = fs.readFileSync(path.join(storeDir, "latest.md"), "utf8");
  } catch {
    return null;
  }
  const m = raw.match(/^path:\s*(\S.*)$/m);
  if (!m) return null;
  try {
    return fs.readFileSync(m[1].trim(), "utf8");
  } catch {
    return null;
  }
}

// ─── buildHandover (the orchestrator) ──────────────────────────────────────

export interface BuildHandoverArgs {
  preparation: HandoverPreparation;
  branchEntries: SessionEntry[];
  ctx: ExtensionContext;
  settings: HandoffSettings;
  /** Override the prior doc (tests). Default: loadPreviousHandover. */
  priorDoc?: string | null;
  /** /compact operator focus instructions; rendered as ONE line in the
   *  doc's State section (absent when none). */
  instructions?: string;
  /** Injectable clock (tests). */
  now?: Date;
}

function safeGetSessionFile(ctx: ExtensionContext): string | null {
  try {
    return ctx.sessionManager?.getSessionFile?.() ?? null;
  } catch {
    return null;
  }
}
function safeSessionId(ctx: ExtensionContext): string {
  try {
    return ctx.sessionManager?.getSessionId?.() ?? "unknown";
  } catch {
    return "unknown";
  }
}
function safeEntryCount(ctx: ExtensionContext): number | null {
  try {
    return ctx.sessionManager?.getEntries?.().length ?? null;
  } catch {
    return null;
  }
}
function safeContextUsage(ctx: ExtensionContext): ContextUsage | null {
  try {
    return ctx.getContextUsage?.() ?? null;
  } catch {
    return null;
  }
}
function safeJobsView(): string {
  try {
    return jobsView("text");
  } catch {
    return "";
  }
}
/** The bridge's live todo state in ONE board load: the rendered board
 *  text (the doc's State section) + the open items as structured data
 *  (count = pending | in_progress, items = their content in board order).
 *  liveKickoffState needs both and must not read the board twice. The
 *  structured half exists as the PRODUCTION Mission source; the rendered
 *  text is the doc's State section + the fallback parse. null/null when
 *  there is no channel, no board, or the load fails — a broken board must
 *  not break compaction or the seed. */
function liveTodoState(cwd: string): {
  text: string | null;
  openTodos: { count: number; items: string[] } | null;
} {
  try {
    const cfg = loadChannelConfig(cwd);
    const ch = cfg ? getDefaultChannel(cfg) : null;
    if (!ch) return { text: null, openTodos: null };
    const board = loadBoard(ch.id);
    if (!board || board.todos.length === 0)
      return { text: null, openTodos: null };
    const open = board.todos.filter(
      (t) => t.status === "pending" || t.status === "in_progress",
    );
    return {
      text: renderBoard(board.todos),
      openTodos: { count: open.length, items: open.map((t) => t.content) },
    };
  } catch {
    return { text: null, openTodos: null };
  }
}

/** Rendered board for the doc's State section; "" when none. */
function defaultTodoText(cwd: string): string {
  return liveTodoState(cwd).text ?? "";
}
/** issue #140: rendered scheduled-task lines (pending + claimed) from the
 *  bridge's task store — the THIRD durable state the old seed and doc
 *  never read. Cap 5 lines (full prompt text - no width budget); null when
 *  there are none or the store is unreadable — a missing file must not
 *  break compaction.
 *  NOT channel-scoped: loadTasks lists EVERY channel's tasks. Safe under
 *  the one-agent-per-HOME invariant (one channel per bridge process); would
 *  need channelId scoping if that invariant changes (review F3, #141). */
function safeScheduledTasks(): string | null {
  try {
    const lines = loadTasks()
      .filter((t) => t.status === "pending" || t.status === "claimed")
      .slice(0, 5)
      .map((t) => formatTaskLine(t, t.channelName));
    return lines.length ? lines.join("\n") : null;
  } catch {
    return null;
  }
}

/** Deterministic handover doc (NO LLM call). The agent already has all the
 *  state - references, worktrees, todos, dispatch, machine state, transcript.
 *  We extract it and write the doc. No model call means no 400/500, no
 *  headers, no reverse-proxy quirks. The LLM prose sections (Mission /
 *  In-Flight / Done / Blockers / Decisions / Follow-ups / Gotchas) are
 *  replaced by the raw transcript span, which carries the actual content;
 *  the next session reads that. */
export function renderDeterministic(
  state: ParsedState,
  transcript: string,
  header: string,
): string {
  const or = (s: string) => (s.trim() ? s.trim() : "(none)");
  return [
    header,
    `## Transcript (current state first)\n${or(transcript)}`,
    `## References\n${renderReferences(state)}`,
    `## State\n${renderState(state)}`,
    `## Last user asks\n${renderLastAsks(state)}`,
    renderFileTags(state),
  ].join("\n\n");
}

/** Build the handover doc: deterministic extraction (pure) →
 *  renderDeterministic → sizeGuard → write to the store. NO LLM call.
 *  Returns the doc string; the wiring wraps it into the CompactionResult. */
export async function buildHandover(args: BuildHandoverArgs): Promise<string> {
  const { preparation, branchEntries, ctx, settings } = args;
  const priorDoc =
    args.priorDoc ?? loadPreviousHandover({ storeDir: settings.storeDir });
  const state = extractDeterministic(preparation, branchEntries, {
    priorDoc,
    sessionFile: safeGetSessionFile(ctx),
    sessionEntryCount: safeEntryCount(ctx),
    contextUsage: safeContextUsage(ctx),
    modelLabel: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : null,
    dispatchText: safeJobsView(),
    scheduledText: safeScheduledTasks(),
    todoText: defaultTodoText(ctx.cwd),
  });
  // /compact operator focus instructions: render as ONE line in the State
  // section (absent when none passed).
  const focus = args.instructions?.trim();
  if (focus) state.operatorFocus = focus;
  const now = args.now ?? new Date();
  const header = buildHeader(now, safeSessionId(ctx), preparation.tokensBefore);
  const transcript = serializeTranscript(
    preparation,
    keptTailMessages(preparation, branchEntries),
  );
  let doc = renderDeterministic(state, transcript, header);
  doc = sizeGuard(doc, settings.sizeGuardTokens);
  writeHandover(doc, { storeDir: settings.storeDir, now });
  return doc;
}

// ─── Fresh window + boot seed (mechanism B, PR2) ──────────────────────────

/** Short window after a handover during which the (possibly just-seeded)
 *  session is NOT handoff-eligible. The seed reads the 12k-token doc into
 *  a fresh session — well under the threshold — but on a small window (or
 *  back-to-back compactions) a second handoff could re-run the LLM over a
 *  tiny span using the just-written doc as its own base. Keyed on the
 *  latest.md `updated` stamp: the same signal mechanism B leaves behind
 *  (the doc is written in the very compaction that triggers the restart),
 *  so a just-seeded session is covered without extra persisted state. */
export const HANDOFF_FRESH_WINDOW_MS = 5 * 60 * 1000;

/** When the latest handover doc was written (ms epoch; 0 = none). */
export function lastHandoffAt(
  storeDir: string,
  home: string = defaultHome(),
): number {
  try {
    const raw = fs.readFileSync(
      path.join(expandHome(storeDir, home), "latest.md"),
      "utf8",
    );
    const m = raw.match(/^updated:\s*(\S+)/m);
    if (!m) return 0;
    const t = Date.parse(m[1]);
    return Number.isFinite(t) ? t : 0;
  } catch {
    return 0;
  }
}

/** True when a handover doc was written less than HANDOFF_FRESH_WINDOW_MS
 *  ago (feeds shouldHandoff's `freshWindow` flag). */
export function isHandoffFreshWindow(
  storeDir: string,
  now: number = Date.now(),
  home: string = defaultHome(),
): boolean {
  const at = lastHandoffAt(storeDir, home);
  return at > 0 && now - at < HANDOFF_FRESH_WINDOW_MS;
}

/**
 * The boot-seed message (F4/F8): a 5-line digest (mission, in-flight,
 * last ask, scheduled, orchestrator priming) + a forced read of latest.md + the
 * pending-question instruction. The wiring sends it via pi.sendUserMessage.
 * The path is the EXPANDED absolute storeDir so the agent's read tool
 * takes it as-is. Pass `live` for fresh dispatch/board state at restart
 * time (see KickoffLiveState); without it the digest falls back to
 * doc-scraping (pre-deterministic docs only).
 */
export function buildSeedKickoff(
  doc: string,
  storeDir: string,
  home: string = defaultHome(),
  live?: KickoffLiveState,
): string {
  const latest = path.join(expandHome(storeDir, home), "latest.md");
  return [
    "Context handed off: the previous session was compacted and the process restarted with a fresh, small context.",
    parseKickoff(doc, live),
    `Read ${latest} before continuing. Answer the last pending user question if any.`,
  ].join("\n");
}

// ─── Live seed state (issue #134: post-compact worker amnesia) ─────────────

/**
 * Live state the boot seed uses INSTEAD of doc-scraping for Mission /
 * In-flight. The deterministic doc (renderDeterministic) has no Mission /
 * In-flight prose sections — the LLM pass was retired — so scraping them
 * always yielded (none) and the fresh session was told nothing was in
 * flight, with an instruction pushing it straight to inline work.
 * The seed therefore reads the SAME sources the doc's State section
 * renders (jobsView text + the open todo board), fresh at restart time.
 */
export interface KickoffLiveState {
  /** jobsView("text"); null/"" when unknown. */
  dispatchText?: string | null;
  /** formatTaskLine rows (pending + claimed, cap 5); null when none. */
  scheduledText?: string | null;
  /** renderBoard of the board; null/"" when empty/unknown. */
  todoBoard?: string | null;
  /** Open todos (status pending | in_progress): count + content in board
   *  order. The PRODUCTION source for the Mission line (issue #140,
   *  review F1): built from live board data, never string-parsed. null
   *  when empty/unknown. */
  openTodos?: { count: number; items: string[] } | null;
}

/** Orchestrator priming: the fresh session must re-learn its role
 *  (issue #134). Pinned by test. */
export const ORCHESTRATOR_PRIME_LINE =
  "ORCHESTRATOR: the pi-bg dispatch lane is drained (#279) - new dispatches go to the fleet control plane (hall-monitor). Hand off context-hungry work - do not do it inline.";

/** Live sources for the boot seed: the SAME calls buildHandover uses for
 *  the doc's State section (safeJobsView / safeScheduledTasks / liveTodoState).
 *  The todo board is loaded ONCE (review F1, #141): the rendered text and
 *  the structured open items must agree. */
export function liveKickoffState(cwd: string): KickoffLiveState {
  const todos = liveTodoState(cwd);
  return {
    dispatchText: safeJobsView() || null,
    scheduledText: safeScheduledTasks(),
    todoBoard: todos.text,
    openTodos: todos.openTodos,
  };
}

/** One-line summary of a rendered todo board — FALLBACK only (the
 *  production Mission path is openTodosLine, structured data). The open
 *  count from the header + the first 3 open items (+N more). The board
 *  IS the mission. Markdown board (renderBoard, Andryo 2026-10-18):
 *  `**todos · N open**` header, then `- ` bullets — `- **x**` (in
 *  progress, open), `- x` (pending, open), `- ~~x~~` (completed /
 *  cancelled, closed). The strikethrough marks closed items, so the
 *  shown list is genuinely open-only — the old plain-gutter known limit
 *  (completed shared the pending ┤/├ row and could not be excluded)
 *  is gone. issue #140: '(+N more)' counts OPEN items only. */
function boardSummaryLine(board: string): string {
  const items: string[] = [];
  let open = -1;
  for (const raw of board.split("\n")) {
    const t = raw.trim();
    const h = t.match(/^\*\*todos · (\d+) open\*\*$/);
    if (h) {
      open = Number(h[1]);
      continue;
    }
    if (!t) continue;
    const m = t.match(/^- (.+)$/);
    if (!m) continue;
    // ~~x~~ = completed/cancelled, never open. **x** = in progress, open.
    if (m[1].startsWith("~~")) continue;
    items.push(m[1].replace(/\*\*/g, ""));
  }
  const shown = items.slice(0, 3);
  const extra =
    open >= 0 ? Math.max(0, open - shown.length) : items.length - shown.length;
  const head = open >= 0 ? `${open} open` : `${items.length} todos`;
  let line = shown.length ? `${head}: ${shown.join("; ")}` : head;
  if (extra > 0) line += ` (+${extra} more)`;
  return line.length > 200 ? `${line.slice(0, 197)}...` : line;
}

/** Mission line from STRUCTURED open-todo state — the production path
 *  (issue #140, review F1): `${count} open` + the first 3 open items +
 *  `(+N more)` for the hidden open ones. Built from live board data,
 *  never from string parsing, so the shown list is genuinely open-only. */
function openTodosLine(ot: { count: number; items: string[] }): string {
  const shown = ot.items.slice(0, 3);
  const extra = Math.max(0, ot.count - shown.length);
  let line = shown.length
    ? `${ot.count} open: ${shown.join("; ")}`
    : `${ot.count} open`;
  if (extra > 0) line += ` (+${extra} more)`;
  return line.length > 200 ? `${line.slice(0, 197)}...` : line;
}

/** In-flight line from a live jobsView("text") markdown list: the `- `
 *  bullets under the `**jobs · N in flight**` header (id + profile + age,
 *  task detail dropped to keep the digest compact). null = no live data
 *  (caller falls back to doc-scraping); NONE = truly zero. */
function liveInFlightLine(dispatchText?: string | null): string | null {
  const t = (dispatchText ?? "").trim();
  if (!t) return null;
  const rows: string[] = [];
  let inInflight = false;
  for (const raw of t.split("\n")) {
    const l = raw.trim();
    if (l.startsWith("**jobs · ")) {
      inInflight = l.endsWith("in flight**");
      continue;
    }
    if (l.startsWith("**")) inInflight = false; // next section header
    if (!inInflight || !l.startsWith("- ")) continue;
    // `- <id> <profile> · <age> · <task>`: keep id/profile + age.
    const parts = l.slice(2).split(" · ");
    rows.push(parts.slice(0, 2).join(" · "));
  }
  return rows.length ? rows.join("; ") : NONE;
}

/**
 * The boot-seed digest: 5 lines — Mission, In-flight, Last ask,
 * Scheduled, ORCHESTRATOR. Mission/In-flight come from LIVE state when
 * available (fresh data beats doc-scraping, issue #134); doc-scraping
 * remains the fallback for pre-deterministic docs that still carry the
 * LLM-era '1 · Mission' / '2 · In-flight (NOW)' sections. "last ask" is
 * the NEWEST (highest-numbered) entry - the pending question the agent
 * must answer is the last one, not the first (MINOR-1). "Scheduled" is
 * PIPED from the live task store, never doc-scraped (issue #140): a task
 * the session itself scheduled is an outbound tool call, so it never
 * appears in the inbound-only "Last 3 user asks" section, and pre-fix
 * docs have no scheduled section at all — scraping could only fake data.
 */
export function parseKickoff(doc: string, live?: KickoffLiveState): string {
  const { sections } = splitDoc(doc);
  const firstLine = (match: (title: string) => boolean): string => {
    const s = sections.find((x) => match(x.title));
    if (!s) return NONE;
    for (const line of s.body.split("\n")) {
      const t = line.trim();
      if (t && t !== NONE) return t.length > 160 ? `${t.slice(0, 157)}...` : t;
    }
    return NONE;
  };
  const lastAsk = (): string => {
    const s = sections.find((x) => x.title.includes("user asks"));
    if (!s) return NONE;
    const numbered: string[] = [];
    for (const line of s.body.split("\n")) {
      const t = line.trim();
      if (/^\d+\./.test(t))
        numbered.push(t.length > 160 ? `${t.slice(0, 157)}...` : t);
    }
    return numbered.length ? numbered[numbered.length - 1] : NONE;
  };
  const board = (live?.todoBoard ?? "").trim();
  const openTodos = live?.openTodos ?? null;
  // Structured first (the production path): openTodos from liveKickoffState
  // is genuinely open-only. The rendered-text fallback serves doc-scraping /
  // no-live calls and may surface completed items (pinned by test).
  const mission = openTodos
    ? openTodosLine(openTodos)
    : board
      ? boardSummaryLine(board)
      : firstLine((t) => t.includes("Mission"));
  const inFlight = liveInFlightLine(live?.dispatchText);
  const scheduled = (live?.scheduledText ?? "").trim();
  return (
    `Mission: ${mission}\n` +
    `In-flight: ${inFlight ?? firstLine((t) => t.includes("In-flight"))}\n` +
    `Last ask: ${lastAsk()}\n` +
    `Scheduled: ${scheduled || NONE}\n` +
    ORCHESTRATOR_PRIME_LINE
  );
}
