// Voice-note transcription via whisper.cpp (#42).
//
// Spawns the pinned whisper-cli binary with the multilingual base model
// (ggml-base) and language auto-detect. Formats whisper.cpp cannot decode
// natively (m4a, opus, ogg-opus, ...) are pre-converted to 16 kHz mono wav
// with the system ffmpeg first — Discord voice notes arrive as m4a.
//
// Binary resolution (first hit wins):
//   1. env JB_TRANSCRIBE_BIN (explicit path, used by tests/overrides)
//   2. whisper-cli found on $PATH (test stubs, or a user-installed copy)
//   3. ~/.local/share/jarate/whisper.cpp/whisper-cli (the pinned prebuilt)
//
// Every failure (missing binary/model, ffmpeg error, non-zero exit, timeout,
// empty output) returns null — the caller degrades to the existing
// [voice note: …] marker line.

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";

/** Default per-note transcription budget, seconds. */
export const DEFAULT_TRANSCRIBE_TIMEOUT_S = 120;

/** Default thread count for whisper-cli (4 of 6 cores on hydrogen). */
const DEFAULT_THREADS = 4;

/** Extensions whisper-cli decodes natively (flac/mp3/ogg/wav). ogg is
 *  routed through ffmpeg anyway: Discord voice .ogg is opus, which the
 *  bundled stb_vorbis decoder may reject. */
const NATIVE_EXTS = new Set([".wav", ".flac", ".mp3"]);

/** Voice-audio trigger for transcription (#42 contract): audio/* mime or a
 *  canonical voice-note extension. */
const VOICE_AUDIO_EXTS = new Set([".m4a", ".ogg", ".opus"]);

/** True when the attachment is voice audio worth transcribing (audio/*
 *  mime or .m4a/.ogg/.opus extension). Broader marker heuristics
 *  (duration/waveform) do NOT trigger transcription. */
export function isVoiceAudio(att: {
  contentType?: string | null;
  filename?: string | null;
}): boolean {
  const ct = (att.contentType || "").trim().toLowerCase();
  if (ct.startsWith("audio/")) return true;
  return VOICE_AUDIO_EXTS.has(path.extname(att.filename || "").toLowerCase());
}

export interface TranscribeOptions {
  /** Audio mime type (logged; the extension drives the decode path). */
  mime?: string;
  /** Override environment (default process.env). Tests point PATH at a
   *  stub directory. */
  env?: NodeJS.ProcessEnv;
}

interface TranscribeConfig {
  bin: string;
  model: string;
  ffmpeg: string;
  threads: number;
  timeoutMs: number;
}

function findOnPath(name: string, env: NodeJS.ProcessEnv): string | null {
  const dirs = (env.PATH || "").split(path.delimiter);
  for (const dir of dirs) {
    if (!dir) continue;
    const p = path.join(dir, name);
    try {
      const st = fs.statSync(p);
      if (st.isFile() && (st.mode & 0o111) !== 0) return p;
    } catch {
      /* keep looking */
    }
  }
  return null;
}

function readTimeoutMs(env: NodeJS.ProcessEnv): number {
  const raw = env.JB_TRANSCRIBE_TIMEOUT_S;
  if (raw === undefined || raw === "")
    return DEFAULT_TRANSCRIBE_TIMEOUT_S * 1000;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_TRANSCRIBE_TIMEOUT_S * 1000;
  return Math.round(n * 1000);
}

function readThreads(env: NodeJS.ProcessEnv): number {
  const n = Number(env.JB_TRANSCRIBE_THREADS);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : DEFAULT_THREADS;
}

/** Resolve the transcription runtime config from the environment. */
export function transcribeConfig(
  env: NodeJS.ProcessEnv = process.env,
): TranscribeConfig {
  const base = path.join(homedir(), ".local", "share", "jarate", "whisper.cpp");
  const binEnv = (env.JB_TRANSCRIBE_BIN || "").trim();
  const bin =
    binEnv || findOnPath("whisper-cli", env) || path.join(base, "whisper-cli");
  return {
    bin,
    model: env.JB_TRANSCRIBE_MODEL || path.join(base, "ggml-base.bin"),
    ffmpeg: env.JB_TRANSCRIBE_FFMPEG || "ffmpeg",
    threads: readThreads(env),
    timeoutMs: readTimeoutMs(env),
  };
}

/** Run one command to completion or timeout. Resolves with the exit code
 *  (null on spawn error or timeout) plus the captured stdout. */
function runCmd(
  cmd: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<{ code: number | null; stdout: string }> {
  return new Promise((resolve) => {
    let p: ReturnType<typeof spawn>;
    try {
      p = spawn(cmd, args, { env });
    } catch (e) {
      console.error(`[transcribe] spawn ${cmd} failed: ${String(e)}`);
      resolve({ code: null, stdout: "" });
      return;
    }
    let stdout = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      p.kill("SIGKILL");
      console.error(
        `[transcribe] ${path.basename(cmd)} timed out after ${Math.round(
          timeoutMs / 1000,
        )}s`,
      );
      resolve({ code: null, stdout: "" });
    }, timeoutMs);
    p.stdout?.on("data", (d: Buffer) => {
      stdout += d.toString("utf-8");
    });
    p.stderr?.on("data", () => {}); // whisper logs model-load noise here
    p.on("error", (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      console.error(`[transcribe] ${path.basename(cmd)} error: ${String(e)}`);
      resolve({ code: null, stdout: "" });
    });
    p.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout });
    });
  });
}

/** Transcribe a local audio file to text. Returns null on ANY failure —
 *  the caller keeps the [voice note: …] marker line instead. */
export async function transcribeVoice(
  filePath: string,
  opts: TranscribeOptions = {},
): Promise<string | null> {
  const env = opts.env ?? process.env;
  const cfg = transcribeConfig(env);
  const who = `transcribe(${path.basename(filePath)}, ${opts.mime || "unknown"})`;

  if (!fs.existsSync(cfg.bin) || !fs.existsSync(cfg.model)) {
    console.error(
      `[transcribe] missing binary or model — bin=${cfg.bin} model=${cfg.model}`,
    );
    return null;
  }
  if (!fs.existsSync(filePath)) {
    console.error(`[transcribe] ${who}: file missing: ${filePath}`);
    return null;
  }

  // whisper-cli decodes wav/flac/mp3 natively; everything else (the m4a
  // Discord voice notes use, opus, ogg-opus) is pre-converted to 16 kHz
  // mono wav with ffmpeg.
  let audio = filePath;
  let tmpWav: string | null = null;
  const ext = path.extname(filePath).toLowerCase();
  try {
    if (!NATIVE_EXTS.has(ext)) {
      tmpWav = `${filePath}.16k.wav`;
      const conv = await runCmd(
        cfg.ffmpeg,
        [
          "-hide_banner",
          "-loglevel",
          "error",
          "-y",
          "-i",
          filePath,
          "-ar",
          "16000",
          "-ac",
          "1",
          "-f",
          "wav",
          tmpWav,
        ],
        env,
        cfg.timeoutMs,
      );
      if (conv.code !== 0 || !fs.existsSync(tmpWav)) {
        console.error(
          `[transcribe] ${who}: ffmpeg convert failed (code=${conv.code})`,
        );
        return null;
      }
      audio = tmpWav;
    }
    const r = await runCmd(
      cfg.bin,
      [
        "-m",
        cfg.model,
        "-l",
        "auto",
        "-nt",
        "-np",
        "-t",
        String(cfg.threads),
        "-f",
        audio,
      ],
      env,
      cfg.timeoutMs,
    );
    if (r.code !== 0) {
      console.error(
        `[transcribe] ${who}: whisper exit ${r.code} (bin=${cfg.bin})`,
      );
      return null;
    }
    const text = r.stdout.trim();
    if (text === "") {
      console.error(`[transcribe] ${who}: empty transcript`);
      return null;
    }
    return text;
  } finally {
    if (tmpWav) fs.rmSync(tmpWav, { force: true });
  }
}
