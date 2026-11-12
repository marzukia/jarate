/**
 * channel/rotation-stale.ts — #315 P0 guard: rotation-stale + live-size
 * watch (deterministic). Split out of restart-ops.ts (size gate, 2026-11).
 *
 * Per-agent tick (armed at session_start, cleared at session_shutdown). Unit-managed pi only (jarate#337, 2026-11-03): without XDG_RUNTIME_DIR the rotation the watch guards can never fire (one-shot worker run), and the shared handoff store makes a foreign session's doc a cross-session false positive - the tick is skipped there.
 * EXACT conditions from issue #315 - nothing else: ROTATION-STALE = a
 * handoff doc written in the last 2 h AND the live session file mtime
 * OLDER than the newest doc mtime (numeric compare, no inference); the
 * size flag = live session file above 1.5 MB (independent). Log line +
 * say to the responsible lane (the default channel, the existing
 * machine() one-liner say path). The say is latched once per episode
 * (resets when the condition clears) so the 5-min tick does not
 * re-post; the log line lands every tick.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import { resolveHandoffSettings } from "./handover";
import { lastActiveChannel } from "./index";
import { machine } from "./live";
import { sendLivenessEvent } from "./liveness-event";
import { sanitizeUnknownValue } from "./sanitize";
import { defaultHome } from "./todos";
import { getDefaultChannel, loadChannelConfig } from "./types";

/** #315: a handoff doc newer than this is "recent" (2 h). */
export const ROTATION_STALE_DOC_WINDOW_MS = 2 * 60 * 60 * 1000;
export const ROTATION_STALE_SIZE_BYTES = 1.5 * 1024 * 1024;
export const ROTATION_STALE_TICK_MS = 5 * 60 * 1000;

export interface RotationStaleInput {
  now: number;
  /** Newest handoff doc mtime (ms epoch); null when none in the store. */
  newestDocMtimeMs: number | null;
  /** Live session file mtime (ms epoch); null when it is gone. */
  liveMtimeMs: number | null;
  /** Live session file size (bytes); null when it is gone. */
  liveSizeBytes: number | null;
}

/** #315 P0, the exact conditions. ROTATION-STALE: newest doc written in
 *  the last 2 h AND live mtime STRICTLY older than the newest doc
 *  mtime (numeric compare). Oversized: live size above 1.5 MB. The two
 *  flags are independent. */
export function checkRotationStale(i: RotationStaleInput): {
  stale: boolean;
  oversized: boolean;
} {
  const stale =
    i.newestDocMtimeMs != null &&
    i.liveMtimeMs != null &&
    i.now - i.newestDocMtimeMs < ROTATION_STALE_DOC_WINDOW_MS &&
    i.liveMtimeMs < i.newestDocMtimeMs;
  const oversized =
    i.liveSizeBytes != null && i.liveSizeBytes > ROTATION_STALE_SIZE_BYTES;
  return { stale, oversized };
}

/** Newest mtime over the handoff store's doc files (*.md; latest.md is
 *  the pointer, not a doc); null when the store is missing/empty. */
export function newestHandoffDocMtime(
  storeDir: string,
  home: string = defaultHome(),
): number | null {
  let dir = storeDir;
  if (dir === "~" || dir.startsWith("~/"))
    dir = path.join(home, dir.slice(dir === "~" ? 1 : 2));
  let files: string[];
  try {
    files = fs.readdirSync(dir);
  } catch {
    return null;
  }
  let newest: number | null = null;
  for (const f of files) {
    if (!f.endsWith(".md") || f === "latest.md") continue;
    try {
      const t = fs.statSync(path.join(dir, f)).mtimeMs;
      if (newest == null || t > newest) newest = t;
    } catch {
      /* unreadable doc: skip */
    }
  }
  return newest;
}

let rotationStaleTimer: ReturnType<typeof setInterval> | null = null;
let rotationStaleNotified = false;
let rotationStaleSizeNotified = false;

/** One tick: read the live session file + newest doc mtime, evaluate the
 *  exact #315 conditions, log + say (latched once per episode). */
function rotationStaleTick(ctx: ExtensionContext): void {
  // jarate#337: non-unit pi (one-shot worker run) - the rotation can never fire here, and the shared store cross-session-false-positives. Skip.
  if (!process.env.XDG_RUNTIME_DIR) return;
  const settings = resolveHandoffSettings(ctx.cwd);
  let live: string | null = null;
  try {
    live = ctx.sessionManager?.getSessionFile?.() ?? null;
  } catch {
    live = null;
  }
  let liveMtimeMs: number | null = null;
  let liveSizeBytes: number | null = null;
  if (live) {
    try {
      const st = fs.statSync(live);
      liveMtimeMs = st.mtimeMs;
      liveSizeBytes = st.size;
    } catch {
      /* file gone: both null */
    }
  }
  const { stale, oversized } = checkRotationStale({
    now: Date.now(),
    newestDocMtimeMs: newestHandoffDocMtime(settings.storeDir),
    liveMtimeMs,
    liveSizeBytes,
  });
  const ch = lastActiveChannel ?? getDefaultChannel(loadChannelConfig(ctx.cwd));
  // op order 2026-11-12 (piboy channel): the #315 alert fires through the
  // hall-monitor webhook leg (liveness event, the #370 leg-B pattern) - the
  // line lands under the WEBHOOK identity (post_channel_line), never the
  // agent's own bot. Fire-and-forget, log-only on failure (a dead
  // hall-monitor degrades to the console log + the sweep, the #370 posture).
  // ch is kept for the discord-type gate only.
  const say = (line: string): void => {
    if (ch?.type === "discord")
      void sendLivenessEvent("rotation_stale", machine(line));
  };
  if (stale) {
    console.log(
      "[handoff] ROTATION-STALE: newest handoff doc mtime is newer than the live session file mtime - the rotation never fired",
    );
    if (!rotationStaleNotified) {
      rotationStaleNotified = true;
      say(
        "ROTATION-STALE: a handoff doc was written in the last 2 h but the live session file is older than it - the session rotation never fired (issue #315)",
      );
    }
  } else {
    rotationStaleNotified = false;
  }
  if (oversized && liveSizeBytes != null) {
    const mb = (liveSizeBytes / (1024 * 1024)).toFixed(1);
    console.log(`[handoff] live session file ${mb} MB (above 1.5 MB)`);
    if (!rotationStaleSizeNotified) {
      rotationStaleSizeNotified = true;
      say(`live session file ${mb} MB (above 1.5 MB - issue #315)`);
    }
  } else {
    rotationStaleSizeNotified = false;
  }
}

/** Arm the per-agent watch (session_start); the check also runs on
 *  arm (a stalled rotation is deep into its 2 h window by boot).
 *  Unref'd; one process = one agent. */
export function armRotationStaleWatch(ctx: ExtensionContext): void {
  if (rotationStaleTimer) clearInterval(rotationStaleTimer);
  const tick = (): void => {
    try {
      rotationStaleTick(ctx);
    } catch (e) {
      console.error(
        "[handoff] rotation-stale tick failed:",
        sanitizeUnknownValue(e),
      );
    }
  };
  rotationStaleTimer = setInterval(tick, ROTATION_STALE_TICK_MS);
  (rotationStaleTimer as { unref?: () => void }).unref?.();
  tick();
}

/** Clear the watch (session_shutdown). */
export function clearRotationStaleWatch(): void {
  if (rotationStaleTimer) clearInterval(rotationStaleTimer);
  rotationStaleTimer = null;
  rotationStaleNotified = false;
  rotationStaleSizeNotified = false;
}
