/**
 * #384 guard C — the handover doc write cap.
 *
 * MAX_HANDOVER_BYTES = K_bytes (derived from the runtime context
 * window, size-caps.ts). Per-section budgets are enforced at WRITE
 * time (the existing sizeGuard/condense runs after assembly and did
 * not bound the file — the 2026-11-25 incident wrote ~388 KB docs):
 *
 *   Operator instructions (recent) — the 12 NEWEST entries, each
 *       <= 400 chars
 *   todos (the board block)        — the guard-B block (<= K_bytes;
 *       applied upstream by the doc's liveTodoState)
 *   state fields (dispatch /
 *       scheduled)                 — <= 4 lines each, <= 500 chars
 *       per line
 *   transcript                     — the remaining budget, run through
 *       the existing condense
 *
 * If the doc still exceeds the cap: the transcript condense is a
 * fixed-point (a 2-content-line body), so the oldest operator
 * instructions are dropped one by one; the last resort is a
 * structurally valid doc carrying the `… doc over cap` marker.
 * Property (tested): the doc written to disk <= MAX_HANDOVER_BYTES.
 */
import { assembleDoc, condenseBody, splitDoc } from "./handover";

/** Max operator-instruction entries (the 12 newest). */
export const HANDOVER_OPS_MAX_ENTRIES = 12;
/** Max chars per operator-instruction entry. */
export const HANDOVER_OPS_LINE_MAX = 400;
/** Max continuation lines per state field (dispatch / scheduled). */
export const HANDOVER_STATE_FIELD_MAX_LINES = 4;
/** Max chars per state-field line. */
export const HANDOVER_STATE_LINE_MAX = 500;
/** The last-resort marker. */
export const HANDOVER_OVER_CAP_MARKER = "… doc over cap";
/** The state fields with the line budget (jobs ride on dispatch). */
const STATE_FIELDS = ["- dispatch:", "- scheduled:"];

const bytes = (s: string): number => Buffer.byteLength(s, "utf8");

const fitChars = (s: string, max: number): string =>
  s.length <= max ? s : `${s.slice(0, max - 1)}…`;

/** Cap the "Operator instructions (recent)" section: the 12 newest
 *  entries, each <= 400 chars. "(none)" survives as-is. */
function capOpsSection(body: string): string {
  const lines = body.split("\n");
  const entries = lines.filter((l) => l.trim() !== "" && l !== "(none)");
  if (entries.length === 0) return body;
  const kept = entries
    .slice(-HANDOVER_OPS_MAX_ENTRIES)
    .map((l) => fitChars(l, HANDOVER_OPS_LINE_MAX));
  return kept.join("\n");
}

/** Cap one state field's continuation block: <= 4 lines, <= 500 chars
 *  per line. The marker line ("- dispatch:" / "- scheduled:") stays;
 *  the "(none)" fallback stays. */
function capStateBlock(lines: string[], marker: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    if (lines[i] !== marker) {
      out.push(lines[i]);
      i++;
      continue;
    }
    out.push(marker);
    i++;
    let count = 0;
    while (
      i < lines.length &&
      !lines[i]!.startsWith("- ") &&
      count < HANDOVER_STATE_FIELD_MAX_LINES
    ) {
      out.push(fitChars(lines[i]!, HANDOVER_STATE_LINE_MAX));
      i++;
      count++;
    }
    // Over-budget continuation lines: dropped (the line budget is hard;
    // passing them through would silently exceed it).
    while (i < lines.length && !lines[i]!.startsWith("- ")) i++;
    if (count === 0) out.push("  (none)");
  }
  return out;
}

/** Cap the State section's line-budgeted fields. */
function capStateSection(body: string): string {
  const lines = body.split("\n");
  let out = lines;
  for (const marker of STATE_FIELDS) out = capStateBlock(out, marker);
  return out.join("\n");
}

/**
 * Enforce the write-time cap. Returns the doc (unchanged when already
 * under the cap). Deterministic; idempotent.
 */
export function applyHandoverCap(doc: string, capBytes: number): string {
  if (bytes(doc) <= capBytes) return doc;
  const parts = splitDoc(doc);
  for (const s of parts.sections) {
    if (s.title.includes("Operator instructions"))
      s.body = capOpsSection(s.body);
    else if (s.title === "State") s.body = capStateSection(s.body);
  }
  const transcript = parts.sections.find((s) => s.title.includes("Transcript"));
  // The transcript takes the remaining budget: condense (the existing
  // deterministic pass, human lines preserved) until the whole doc
  // fits or the condense hits its fixed point.
  for (let pass = 0; pass < 200; pass++) {
    if (bytes(assembleDoc(parts)) <= capBytes) return assembleDoc(parts);
    if (!transcript) break;
    const next = condenseBody(transcript.body);
    if (next === transcript.body) break;
    transcript.body = next;
  }
  if (bytes(assembleDoc(parts)) <= capBytes) return assembleDoc(parts);
  // Condense fixed point, still over: drop the OLDEST operator
  // instructions one by one (the section keeps its newest).
  const ops = parts.sections.find((s) =>
    s.title.includes("Operator instructions"),
  );
  while (
    bytes(assembleDoc(parts)) > capBytes &&
    ops &&
    ops.body.split("\n").length > 1
  ) {
    ops.body = ops.body.split("\n").slice(1).join("\n");
  }
  if (bytes(assembleDoc(parts)) <= capBytes) return assembleDoc(parts);
  // Last resort: a structurally valid doc (header + parseable sections,
  // no file tags) with the over-cap marker.
  return [
    parts.header,
    `## Operator instructions (recent)\n${HANDOVER_OVER_CAP_MARKER}`,
    `## State\n${HANDOVER_OVER_CAP_MARKER}`,
  ].join("\n\n");
}
