import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  DEFAULT_TRANSCRIBE_TIMEOUT_S,
  isVoiceAudio,
  transcribeConfig,
  transcribeVoice,
} from "./transcribe";

describe("isVoiceAudio (#42 transcription trigger)", () => {
  test("audio/* mime", () => {
    expect(isVoiceAudio({ contentType: "audio/mp4" })).toBe(true);
    expect(isVoiceAudio({ contentType: "audio/ogg" })).toBe(true);
    expect(isVoiceAudio({ contentType: "AUDIO/WAV" })).toBe(true);
  });

  test("voice-note extensions without mime", () => {
    expect(isVoiceAudio({ filename: "recording.m4a" })).toBe(true);
    expect(isVoiceAudio({ filename: "clip.ogg" })).toBe(true);
    expect(isVoiceAudio({ filename: "note.OPUS" })).toBe(true);
  });

  test("non-voice rejected", () => {
    expect(isVoiceAudio({ contentType: "text/plain", filename: "a.txt" })).toBe(
      false,
    );
    expect(
      isVoiceAudio({ contentType: "image/png", filename: "photo.png" }),
    ).toBe(false);
    expect(isVoiceAudio({ filename: "report.pdf" })).toBe(false);
    expect(isVoiceAudio({})).toBe(false);
  });

  test("marker-only heuristics (duration/waveform) do not trigger", () => {
    // isVoiceAttachment would call these voice; the #42 trigger is
    // mime/extension-based, so they skip transcription and keep the marker.
    expect(isVoiceAudio({ filename: "mystery.bin" })).toBe(false);
    expect(isVoiceAudio({ contentType: "application/octet-stream" })).toBe(
      false,
    );
  });
});

describe("transcribeConfig (#42 env)", () => {
  test("timeout env override in seconds", () => {
    const cfg = transcribeConfig({
      JB_TRANSCRIBE_TIMEOUT_S: "5",
    } as NodeJS.ProcessEnv);
    expect(cfg.timeoutMs).toBe(5000);
  });

  test("bad timeout env falls back to default", () => {
    for (const bad of ["", "0", "-3", "abc"]) {
      const cfg = transcribeConfig({
        JB_TRANSCRIBE_TIMEOUT_S: bad,
      } as NodeJS.ProcessEnv);
      expect(cfg.timeoutMs).toBe(DEFAULT_TRANSCRIBE_TIMEOUT_S * 1000);
    }
  });

  test("default timeout is 120s", () => {
    expect(transcribeConfig({} as NodeJS.ProcessEnv).timeoutMs).toBe(120_000);
  });

  test("threads env override", () => {
    expect(
      transcribeConfig({ JB_TRANSCRIBE_THREADS: "8" } as NodeJS.ProcessEnv)
        .threads,
    ).toBe(8);
    expect(
      transcribeConfig({ JB_TRANSCRIBE_THREADS: "0" } as NodeJS.ProcessEnv)
        .threads,
    ).toBe(4);
  });

  test("bin: explicit env wins", () => {
    const cfg = transcribeConfig({
      JB_TRANSCRIBE_BIN: "/tmp/x/whisper-cli",
    } as NodeJS.ProcessEnv);
    expect(cfg.bin).toBe("/tmp/x/whisper-cli");
  });

  test("bin: PATH lookup finds an executable", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tc-path-"));
    try {
      const p = path.join(dir, "whisper-cli");
      fs.writeFileSync(p, "#!/bin/sh\n");
      fs.chmodSync(p, 0o755);
      expect(transcribeConfig({ PATH: dir } as NodeJS.ProcessEnv).bin).toBe(p);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("transcribeVoice (#42)", () => {
  let tmp: string;
  let scriptsDir: string;
  let sentinel: string;

  function stub(name: string, body: string): void {
    const p = path.join(scriptsDir, name);
    fs.writeFileSync(p, body);
    fs.chmodSync(p, 0o755);
  }

  function fixture(name: string): string {
    const p = path.join(tmp, name);
    fs.writeFileSync(p, Buffer.from("RIFF-fake-audio", "ascii"));
    return p;
  }

  function envWith(): Record<string, string> {
    return {
      ...process.env,
      PATH: `${scriptsDir}${path.delimiter}${process.env.PATH ?? ""}`,
    } as unknown as Record<string, string>;
  }

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "transcribe-42-"));
    scriptsDir = path.join(tmp, "scripts");
    fs.mkdirSync(scriptsDir, { recursive: true });
    sentinel = path.join(tmp, "called");
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  test("wav + stub whisper-cli -> fixed transcript", async () => {
    stub("whisper-cli", '#!/bin/sh\necho "hello from the whisper stub"\n');
    const r = await transcribeVoice(fixture("note.wav"), {
      mime: "audio/wav",
      env: envWith(),
    });
    expect(r).toBe("hello from the whisper stub");
  });

  test("stub exits 1 -> null (marker fallback path)", async () => {
    stub("whisper-cli", "#!/bin/sh\nexit 1\n");
    const r = await transcribeVoice(fixture("note.wav"), {
      mime: "audio/wav",
      env: envWith(),
    });
    expect(r).toBeNull();
  });

  test("stub prints nothing -> null (empty transcript)", async () => {
    stub("whisper-cli", "#!/bin/sh\nexit 0\n");
    const r = await transcribeVoice(fixture("note.wav"), {
      mime: "audio/wav",
      env: envWith(),
    });
    expect(r).toBeNull();
  });

  test("stub timeout -> null, well under the 120s default", async () => {
    stub("whisper-cli", "#!/bin/sh\nsleep 5\n");
    const env = { ...envWith(), JB_TRANSCRIBE_TIMEOUT_S: "1" };
    const t0 = Date.now();
    const r = await transcribeVoice(fixture("note.wav"), { env });
    expect(r).toBeNull();
    expect(Date.now() - t0).toBeLessThan(4000);
  });

  test("missing binary -> null, never spawns", async () => {
    stub("whisper-cli", `#!/bin/sh\necho x >> ${sentinel}\n`);
    const env = { ...envWith(), JB_TRANSCRIBE_BIN: "/nonexistent/whisper-cli" };
    const r = await transcribeVoice(fixture("note.wav"), { env });
    expect(r).toBeNull();
    expect(fs.existsSync(sentinel)).toBe(false);
  });

  test("missing input file -> null", async () => {
    stub("whisper-cli", "#!/bin/sh\necho x\n");
    const r = await transcribeVoice(path.join(tmp, "nope.wav"), {
      env: envWith(),
    });
    expect(r).toBeNull();
  });

  // ── m4a decode path: ffmpeg converts, whisper stub transcribes ──────

  const FFMPEG_STUB = `#!/bin/sh
out=""
for a in "$@"; do out="$a"; done
printf RIFF > "$out"
echo "ffmpeg $out" >> ${"__SENTINEL__"}
exit 0
`;

  test("m4a -> ffmpeg convert -> transcript; temp wav cleaned up", async () => {
    stub("ffmpeg", FFMPEG_STUB.replace("__SENTINEL__", sentinel));
    stub("whisper-cli", `#!/bin/sh\necho "converted words"\n`);
    const f = fixture("recording.m4a");
    const r = await transcribeVoice(f, {
      mime: "audio/mp4",
      env: envWith(),
    });
    expect(r).toBe("converted words");
    expect(fs.readFileSync(sentinel, "utf-8")).toContain(
      "recording.m4a.16k.wav",
    );
    expect(fs.existsSync(`${f}.16k.wav`)).toBe(false);
  });

  test("m4a + ffmpeg stub exits 1 -> null", async () => {
    stub("ffmpeg", "#!/bin/sh\nexit 1\n");
    stub("whisper-cli", `#!/bin/sh\necho x >> ${sentinel}\n`);
    const r = await transcribeVoice(fixture("recording.m4a"), {
      mime: "audio/mp4",
      env: envWith(),
    });
    expect(r).toBeNull();
    // whisper was never reached
    expect(fs.existsSync(sentinel)).toBe(false);
  });

  test("opus route (extension only, no audio mime) also converts", async () => {
    stub("ffmpeg", FFMPEG_STUB.replace("__SENTINEL__", sentinel));
    stub("whisper-cli", "#!/bin/sh\necho ok\n");
    const r = await transcribeVoice(fixture("voice.opus"), {
      env: envWith(),
    });
    expect(r).toBe("ok");
  });
});
