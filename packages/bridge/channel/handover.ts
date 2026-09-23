/**
 * Handover compaction — mechanism A (design v2, PR1).
 *
 * On a qualifying compaction (auto at the handoff threshold, manual
 * /compact or /handover) the bridge returns a durable handover doc as pi's
 * CUSTOM compaction result: `{ compaction: { summary: doc, ... } }` —
 * no cancel, no restart, the op-window flow is untouched (review F1/F3).
 *
 * The doc is a fixed 10-section template:
 *   1-2, 4-6, 8 (Mission, In-flight, Blockers, Decisions, Follow-ups,
 *   Gotchas) + Done (condensed)        → LLM prose over the filled skeleton
 *   3 Done is LLM prose (retirement)
 *   7 References, 9 State, 10 Last 3 user asks → deterministic (no LLM)
 *   plus <read-files>/<modified-files> tags   → deterministic, CUMULATIVE:
 *   prior doc tags ∪ current span fileOps (review F9)
 *
 * Cumulative: the prior doc (latest.md pointer) is the LLM's base (F6), so
 * context compaction never shrinks the doc — it only retires done work.
 * The doc is written to <storeDir>/<YYYYMMDD-HHMM>-<slug>.md BEFORE
 * compaction returns; on disk before the compact is the failure-handling
 * invariant (doc already on disk → restart picks it up in PR2).
 */

import fs from "node:fs";
import path from "node:path";
import type {
  AssistantMessage,
  Context as PiAiContext,
  UserMessage,
} from "@earendil-works/pi-ai";
import { completeSimple } from "@earendil-works/pi-ai/compat";
import type {
  ContextUsage,
  ExtensionAPI,
  ExtensionContext,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { fmtTokensLC } from "./ctxwatch";
import { sendDiscordMessage } from "./discord";
import { jobsView } from "./jobs";
import { sanitizeUnknownValue } from "./sanitize";
import { defaultHome, loadBoard, renderBoardPlain } from "./todos";
import { getDefaultChannel, loadChannelConfig } from "./types";

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

/** LLM call seam: tests inject a stub; default = completeSimple on the
 *  session model with the session's own auth (ctx.modelRegistry). */
export type HandoverComplete = (
  system: string,
  user: string,
  opts?: { signal?: AbortSignal },
) => Promise<string>;

/** Resolved handoff settings (defaults → ~/.pi/agent → <cwd>/.pi → env). */
export interface HandoffSettings {
  /** PR1 default FALSE — the handoff path is opt-in until PR2. */
  enabled: boolean;
  /** Fraction (0..1) of the TOTAL context window where the handoff kicks
   *  in for threshold compactions. Env: HANDOFF_THRESHOLD. */
  threshold: number;
  /** Session-file size that forces the restart-class op. Env:
   *  HANDOFF_RESTART_FILE_CAP. */
  restartFileCap: number;
  /** sizeGuard hard cap for the doc, in tokens. */
  sizeGuardTokens: number;
  /** Store dir. "~" expands to $HOME. */
  storeDir: string;
}

export const HANDOFF_DEFAULTS: HandoffSettings = {
  enabled: false,
  threshold: 0.8,
  restartFileCap: 64_000_000,
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
}

/** LLM prose sections of the doc (markers, not markdown headers). */
export interface LlmProse {
  mission: string;
  inFlight: string;
  done: string;
  blockers: string;
  decisions: string;
  followups: string;
  gotchas: string;
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
  contextLine: string;
  modelLabel: string;
  sessionStats: string;
  lastUserAsks: string[];
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
  todoText?: string | null;
}

// ─── Settings resolution ───────────────────────────────────────────────────

/** Resolve handoff settings: defaults, then ~/.pi/agent/settings.json,
 *  then <cwd>/.pi/settings.json (project wins), then env overrides
 *  (HANDOFF_THRESHOLD / HANDOFF_RESTART_FILE_CAP keep per-box tuning out
 *  of settings). Invalid values fall back to defaults with a warning. */
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
    if (o.restartFileCap !== undefined) {
      const c = Number(o.restartFileCap);
      if (Number.isFinite(c) && c > 0) s.restartFileCap = Math.floor(c);
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
  const envC = Number(env.HANDOFF_RESTART_FILE_CAP ?? "");
  if (Number.isFinite(envC) && envC > 0) s.restartFileCap = Math.floor(envC);
  return s;
}

/** Pure gate: should this compaction produce a handover?
 *  manual → yes (when enabled, not in-flight); threshold → only at/over
 *  the fraction of the total window; overflow/other → no (built-in). */
export function shouldHandoff(
  event: { reason: string },
  flags: ShouldHandoffFlags,
): boolean {
  if (!flags.enabled) return false;
  if (flags.inFlight) return false;
  if (event.reason === "manual") return true;
  if (event.reason === "threshold") {
    if (flags.percent == null) return true; // pi already picked the point
    return flags.percent >= flags.threshold * 100;
  }
  return false;
}

// ─── Message text ───────────────────────────────────────────────────────────

/** Text of one pi message (string or content blocks); custom messages
 *  contribute their serialized content. */
export function msgText(m: HandoverMessage | null | undefined): string {
  if (!m) return "";
  const c = m.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) {
    return c
      .map((b) => {
        if (typeof b === "string") return b;
        if (b && typeof b === "object" && "text" in b)
          return String((b as { text: unknown }).text ?? "");
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return "";
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
 *  per line; missing/empty blocks → empty arrays. */
export function parsePriorTags(doc: string | null): {
  readFiles: string[];
  modifiedFiles: string[];
} {
  const pick = (tag: string): string[] => {
    const m = (doc ?? "").match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
    if (!m) return [];
    return m[1]
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && l !== "(none)");
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

/** Deterministic extraction (pure): file tags (cumulative), PR/issue/
 *  ticket refs, worktree paths + branches, links, last-3 user asks,
 *  context/model/session lines. No LLM anywhere in here. */
export function extractDeterministic(
  preparation: HandoverPreparation,
  branchEntries: SessionEntry[],
  ctxState: ExtractCtxState,
): ParsedState {
  // File tags: prior doc ∪ current span (F9) — fileOps alone only covers
  // the NEW span and would drop the cumulative list.
  const prior = parsePriorTags(ctxState.priorDoc);
  const read = new Set<string>([
    ...prior.readFiles,
    ...preparation.fileOps.read,
  ]);
  const modified = new Set<string>([
    ...prior.modifiedFiles,
    ...preparation.fileOps.written,
    ...preparation.fileOps.edited,
  ]);
  for (const f of modified) read.delete(f); // pi convention: read = read-only

  // Reference corpus: the summarization span + the asks.
  const corpus: string[] = [
    ...preparation.messagesToSummarize.map(msgText),
    ...preparation.turnPrefixMessages.map(msgText),
  ];
  for (const e of branchEntries) {
    if (e.type === "custom_message") {
      const body = inboundBody(e);
      if (body) corpus.push(body);
    }
  }
  const text = corpus.join("\n");

  // Last 3 user asks: channel-inbound custom entries (details.body),
  // fallback to user-role messages in the summarization span.
  const asks: string[] = [];
  for (const e of branchEntries) {
    if (e.type === "custom_message" && e.customType === "channel-inbound") {
      const body = stripPromptFraming(inboundBody(e));
      if (body) asks.push(body);
    }
  }
  if (asks.length === 0) {
    for (const m of [
      ...preparation.messagesToSummarize,
      ...preparation.turnPrefixMessages,
    ]) {
      if (m?.role !== "user") continue;
      const body = stripPromptFraming(msgText(m));
      if (body) asks.push(body);
    }
  }

  return {
    readFiles: [...read].sort(),
    modifiedFiles: [...modified].sort(),
    refs: extractRefs(text),
    worktrees: extractWorktrees(text),
    links: extractLinks(text),
    todoBoard: (ctxState.todoText ?? "").trim(),
    dispatchState: (ctxState.dispatchText ?? "").trim(),
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
      .slice(-3)
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
  let sizeMB = "";
  try {
    const size = fs.statSync(sessionFile).size;
    sizeMB = ` (${(size / (1024 * 1024)).toFixed(1)}MB`;
  } catch {
    sizeMB = "";
  }
  const entries = entryCount != null ? `, ${entryCount} entries` : "";
  return `${sessionFile}${sizeMB}${entries})`;
}

// ─── Transcript + LLM prompt ────────────────────────────────────────────────

const MSG_CAP = 4_000;
const TRANSCRIPT_CAP = 60_000;

/** Serialize the about-to-be-summarized span for the LLM (deterministic,
 *  role-labelled, capped). */
export function serializeTranscript(p: HandoverPreparation): string {
  const msgs = [
    ...(p.messagesToSummarize ?? []),
    ...(p.turnPrefixMessages ?? []),
  ];
  const lines: string[] = [];
  let total = 0;
  for (const m of msgs) {
    const text = msgText(m).trim();
    if (!text) continue;
    const role =
      m?.role === "assistant"
        ? "assistant"
        : m?.role === "toolResult"
          ? "tool"
          : "user";
    let body = text;
    if (body.length > MSG_CAP) body = `${body.slice(0, MSG_CAP)}\n…[truncated]`;
    const line = `[${role}] ${body}`;
    if (total + line.length > TRANSCRIPT_CAP) {
      lines.push("…[transcript truncated]");
      break;
    }
    lines.push(line);
    total += line.length;
  }
  return lines.join("\n");
}

export const HANDOVER_SYSTEM_PROMPT = `You write the handover doc sections for an AI agent session that is being compacted.
The deterministic sections (References, State, Last 3 user asks, file tags) are already filled and EXACT — never restate or correct them.

Write ONLY these sections. Each starts with its marker alone on one line:
[MISSION] What the agent works toward overall. 1-3 terse lines.
[IN_FLIGHT] What is happening NOW: active task, exact next steps. Terse lines.
[DONE] What finished since the prior handover. Condensed — one line per item, retired work.
[BLOCKERS] What is stuck and why. One line each, or (none).
[DECISIONS] Decisions made with their rationale. One line each, or (none).
[FOLLOWUPS] Open follow-ups and recurring tasks. One line each, or (none).
[GOTCHAS] Gotchas, constraints, environment quirks the next session must know. One line each, or (none).

Rules:
- Preserve every prior-doc section that is still true. Retire an item to DONE only when the transcript shows it explicitly finished; keep the reason on the DONE line.
- Terse, factual, no hedging, no markdown headers, no preamble, no commentary.
- If you lack information for a section, write (none).`;

/** Build the user-side prompt: prior doc (cumulative base, F6), the
 *  deterministic skeleton (context, not to be restated), the transcript. */
export function buildLlmPrompt(args: {
  prior: string | null;
  skeleton: string;
  transcript: string;
  instructions?: string;
}): string {
  const parts = [
    "PRIOR HANDOVER DOC (cumulative base — preserve what is still true):",
    "<<<",
    args.prior?.trim() || "(none — first handover)",
    ">>>",
    "",
    "DETERMINISTIC SKELETON (already in the doc — do not restate):",
    "<<<",
    args.skeleton,
    ">>>",
    "",
    "TRANSCRIPT (messages about to be summarized):",
    "<<<",
    args.transcript || "(empty)",
    ">>>",
  ];
  if (args.instructions?.trim())
    parts.push("", `OPERATOR INSTRUCTIONS: ${args.instructions.trim()}`);
  parts.push("", "Return the seven marked sections now.");
  return parts.join("\n");
}

/** Skeleton shown to the LLM: the deterministic facts, so prose does not
 *  duplicate or contradict them. */
export function renderLlmSkeleton(state: ParsedState): string {
  return [
    `refs: ${state.refs.join(", ") || "(none)"}`,
    `worktrees: ${state.worktrees.join(", ") || "(none)"}`,
    `links: ${state.links.join(", ") || "(none)"}`,
    `context: ${state.contextLine}`,
    `last user asks: ${state.lastUserAsks.join(" | ") || "(none)"}`,
    `read files: ${state.readFiles.length}`,
    `modified files: ${state.modifiedFiles.length}`,
  ].join("\n");
}

const PROSE_MARKER_RE =
  /^\s*\[(MISSION|IN_FLIGHT|DONE|BLOCKERS|DECISIONS|FOLLOWUPS|GOTCHAS)\]:?\s*(.*)$/i;

function markerToKey(marker: string): keyof LlmProse {
  switch (marker.toUpperCase()) {
    case "MISSION":
      return "mission";
    case "IN_FLIGHT":
      return "inFlight";
    case "DONE":
      return "done";
    case "BLOCKERS":
      return "blockers";
    case "DECISIONS":
      return "decisions";
    case "FOLLOWUPS":
      return "followups";
    default:
      return "gotchas";
  }
}

/** Parse LLM output into the seven prose sections. Marker lines may
 *  carry inline text ("[DONE] x"); text before the first marker is
 *  dropped (preamble). Missing sections → "". */
export function parseLlmProse(text: string): LlmProse {
  const out: LlmProse = {
    mission: "",
    inFlight: "",
    done: "",
    blockers: "",
    decisions: "",
    followups: "",
    gotchas: "",
  };
  const bodies: Partial<Record<keyof LlmProse, string[]>> = {};
  let current: keyof LlmProse | null = null;
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\s+$/, "");
    const m = line.match(PROSE_MARKER_RE);
    if (m) {
      current = markerToKey(m[1]);
      bodies[current] = [];
      if (m[2].trim()) bodies[current]!.push(m[2]);
      continue;
    }
    if (current) bodies[current]!.push(raw);
  }
  for (const k of Object.keys(out) as (keyof LlmProse)[]) {
    out[k] = (bodies[k] ?? []).join("\n").trim();
  }
  return out;
}

// ─── Doc assembly ───────────────────────────────────────────────────────────

const SECTION_TITLES = [
  "1 · Mission",
  "2 · In-flight (NOW)",
  "3 · Done (condensed)",
  "4 · Blockers",
  "5 · Decisions & Rationale",
  "6 · Open follow-ups",
  "7 · References",
  "8 · Gotchas & Constraints",
  "9 · State (machine)",
  "10 · Last 3 user asks",
] as const;

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
    "- todos:",
    s.todoBoard ? s.todoBoard : "  (none)",
  ];
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

/** Assemble the final doc from deterministic state + LLM prose. */
export function renderTemplate(
  state: ParsedState,
  prose: LlmProse,
  header: string,
): string {
  const or = (s: string) => (s.trim() ? s.trim() : NONE);
  return [
    header,
    `## ${SECTION_TITLES[0]}\n${or(prose.mission)}`,
    `## ${SECTION_TITLES[1]}\n${or(prose.inFlight)}`,
    `## ${SECTION_TITLES[2]}\n${or(prose.done)}`,
    `## ${SECTION_TITLES[3]}\n${or(prose.blockers)}`,
    `## ${SECTION_TITLES[4]}\n${or(prose.decisions)}`,
    `## ${SECTION_TITLES[5]}\n${or(prose.followups)}`,
    `## ${SECTION_TITLES[6]}\n${renderReferences(state)}`,
    `## ${SECTION_TITLES[7]}\n${or(prose.gotchas)}`,
    `## ${SECTION_TITLES[8]}\n${renderState(state)}`,
    `## ${SECTION_TITLES[9]}\n${renderLastAsks(state)}`,
    renderFileTags(state),
  ].join("\n\n");
}

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
    return nl === -1
      ? { title: c.trim(), body: "" }
      : { title: c.slice(0, nl).trim(), body: c.slice(nl + 1).trim() };
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
/** Condense order: retired/cheap-to-lose content first. */
const GUARD_CONDENSE_ORDER = [
  "Done",
  "Open follow-ups",
  "Blockers",
  "Decisions & Rationale",
  "Mission",
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

/** 3-line digest of a doc for a future seed message (PR2 mechanism B).
 *  PR1 does not seed — this is groundwork. */
export function parseKickoff(doc: string): string {
  const { sections } = splitDoc(doc);
  const pick = (match: (title: string) => boolean): string => {
    const s = sections.find((x) => match(x.title));
    if (!s) return NONE;
    for (const line of s.body.split("\n")) {
      const t = line.trim();
      if (t && t !== NONE) return t.length > 160 ? `${t.slice(0, 157)}...` : t;
    }
    return NONE;
  };
  return (
    `Mission: ${pick((t) => t.includes("Mission"))}\n` +
    `In-flight: ${pick((t) => t.includes("In-flight"))}\n` +
    `Last ask: ${pick((t) => t.includes("user asks"))}`
  );
}

// ─── buildHandover (the orchestrator) ──────────────────────────────────────

export interface BuildHandoverArgs {
  preparation: HandoverPreparation;
  branchEntries: SessionEntry[];
  ctx: ExtensionContext;
  pi: ExtensionAPI;
  settings: HandoffSettings;
  /** Injectable LLM call (tests stub it). Default: completeSimple on
   *  ctx.model with the session's own auth. */
  complete?: HandoverComplete;
  /** Override the prior doc (tests). Default: loadPreviousHandover. */
  priorDoc?: string | null;
  /** Operator /compact instructions, forwarded to the LLM. */
  instructions?: string;
  /** Upstream abort signal (event.signal) — combined with the timeout. */
  signal?: AbortSignal;
  /** Injectable clock (tests). */
  now?: Date;
}

/** LLM generation budget; a hang must not wedge the compaction window. */
export const HANDOVER_GEN_TIMEOUT_MS = 120_000;

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
function defaultTodoText(cwd: string): string {
  try {
    const cfg = loadChannelConfig(cwd);
    const ch = cfg ? getDefaultChannel(cfg) : null;
    if (!ch) return "";
    const board = loadBoard(ch.id);
    if (!board || board.todos.length === 0) return "";
    return renderBoardPlain(board.todos);
  } catch {
    return "";
  }
}

/** Default LLM call: the SAME session model, the session's own auth.
 *  Auth via ctx.modelRegistry.getApiKeyAndHeaders(ctx.model) — the bridge
 *  process does not otherwise resolve provider auth. */
/** process.env → ProviderEnv (Record<string, string>, no undefined). */
function toProviderEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined) out[k] = v;
  return out;
}

export function makeDefaultComplete(ctx: ExtensionContext): HandoverComplete {
  return async (system, user, opts) => {
    const model = ctx.model;
    if (!model)
      throw new Error("no session model available for handover generation");
    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
    if (!auth.ok)
      throw new Error(`no API key for handover generation: ${auth.error}`);
    const effective = auth.baseUrl
      ? { ...model, baseUrl: auth.baseUrl }
      : model;
    const messages: UserMessage[] = [
      {
        role: "user",
        content: [{ type: "text", text: user }],
        timestamp: Date.now(),
      },
    ];
    const context: PiAiContext = { systemPrompt: system, messages };
    const res: AssistantMessage = await completeSimple(effective, context, {
      apiKey: auth.apiKey,
      headers: auth.headers,
      env: auth.env ?? toProviderEnv(process.env),
      signal: opts?.signal,
    });
    // MAJOR-1 (review): a "length" stop = output cap hit = partial prose.
    // Accepting it makes a truncated doc the cumulative base, so every later
    // handover inherits the hole. pi's own compaction rejects length stops for
    // the same reason (compaction.js getSummarizationFailure). Fall back to the
    // built-in compact instead (no doc written, latest.md untouched).
    if (
      res.stopReason === "error" ||
      res.stopReason === "aborted" ||
      res.stopReason === "length"
    )
      throw new Error(
        res.errorMessage || `handover generation stopped: ${res.stopReason}`,
      );
    return res.content
      .filter((c): c is { type: "text"; text: string } => c.type === "text")
      .map((c) => c.text)
      .join("\n");
  };
}

/** Post a sanitized one-liner to the default channel when generation
 *  fails (the wiring still returns undefined → built-in compact). */
function postHandoverFail(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  e: unknown,
): void {
  console.error(
    "[handover] gen failed - falling back to built-in compact:",
    sanitizeUnknownValue(e),
  );
  try {
    const cfg = loadChannelConfig(ctx.cwd);
    const ch = cfg ? getDefaultChannel(cfg) : null;
    if (ch)
      void sendDiscordMessage(
        ch,
        "[!] handover gen failed - used standard compact",
      );
    void pi; // pi reserved for future channel routing (F10 surface)
  } catch (e2) {
    console.error(
      "[handover] fail notice post failed:",
      sanitizeUnknownValue(e2),
    );
  }
}

/** Build the handover doc: deterministic extraction (pure) → LLM prose
 *  over the filled skeleton (stubbed in tests) → template → sizeGuard →
 *  write to the store. Returns the doc string; the wiring wraps it into
 *  the CompactionResult. Throws on LLM failure AFTER posting the
 *  sanitized channel notice. */
export async function buildHandover(args: BuildHandoverArgs): Promise<string> {
  const { preparation, branchEntries, ctx, pi, settings } = args;
  const priorDoc =
    args.priorDoc ?? loadPreviousHandover({ storeDir: settings.storeDir });
  const state = extractDeterministic(preparation, branchEntries, {
    priorDoc,
    sessionFile: safeGetSessionFile(ctx),
    sessionEntryCount: safeEntryCount(ctx),
    contextUsage: safeContextUsage(ctx),
    modelLabel: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : null,
    dispatchText: safeJobsView(),
    todoText: defaultTodoText(ctx.cwd),
  });
  const now = args.now ?? new Date();
  const header = buildHeader(now, safeSessionId(ctx), preparation.tokensBefore);
  const skeleton = renderLlmSkeleton(state);
  const transcript = serializeTranscript(preparation);
  const complete = args.complete ?? makeDefaultComplete(ctx);
  const signal = args.signal
    ? AbortSignal.any([
        args.signal,
        AbortSignal.timeout(HANDOVER_GEN_TIMEOUT_MS),
      ])
    : AbortSignal.timeout(HANDOVER_GEN_TIMEOUT_MS);
  let prose: LlmProse;
  try {
    const text = await complete(
      HANDOVER_SYSTEM_PROMPT,
      buildLlmPrompt({
        prior: priorDoc,
        skeleton,
        transcript,
        instructions: args.instructions,
      }),
      { signal },
    );
    prose = parseLlmProse(text);
  } catch (e) {
    postHandoverFail(pi, ctx, e);
    throw e;
  }
  let doc = renderTemplate(state, prose, header);
  doc = sizeGuard(doc, settings.sizeGuardTokens);
  writeHandover(doc, { storeDir: settings.storeDir, now });
  return doc;
}
