import { describe, expect, test } from "bun:test";
import {
  getVoiceAttachmentMatchReason,
  isVoiceAttachment,
  voiceNoteText,
} from "./voice";

describe("isVoiceAttachment", () => {
  test("audio content type", () => {
    expect(isVoiceAttachment({ contentType: "audio/ogg" })).toBe(true);
  });

  test("duration present", () => {
    expect(isVoiceAttachment({ duration: 12.5 })).toBe(true);
  });

  test("waveform present", () => {
    expect(isVoiceAttachment({ waveform: "1,2,3" })).toBe(true);
  });

  test("voice-like filename", () => {
    expect(isVoiceAttachment({ name: "clip.m4a" })).toBe(true);
    expect(isVoiceAttachment({ name: "REC-20260101.opus" })).toBe(true);
  });

  test("normal files rejected", () => {
    expect(
      isVoiceAttachment({ name: "photo.png", contentType: "image/png" }),
    ).toBe(false);
    expect(
      isVoiceAttachment({ name: "report.pdf", contentType: "application/pdf" }),
    ).toBe(false);
  });

  test("empty ref rejected", () => {
    expect(isVoiceAttachment({})).toBe(false);
  });
});

describe("getVoiceAttachmentMatchReason", () => {
  test("preference order: content type, duration, waveform, filename", () => {
    expect(
      getVoiceAttachmentMatchReason({
        contentType: "audio/mpeg",
        duration: 1,
        name: "x.txt",
      }),
    ).toBe("contentType:audio/mpeg");
    expect(getVoiceAttachmentMatchReason({ duration: 1, name: "x.txt" })).toBe(
      "duration:1",
    );
    expect(
      getVoiceAttachmentMatchReason({ waveform: "1", name: "x.txt" }),
    ).toBe("waveform");
    expect(getVoiceAttachmentMatchReason({ name: "clip.m4a" })).toBe(
      "extension:.m4a",
    );
    expect(getVoiceAttachmentMatchReason({ name: "x.txt" })).toBeNull();
  });
});

describe("voiceNoteText", () => {
  test("filename with duration", () => {
    expect(voiceNoteText({ filename: "clip.m4a", duration: 12.4 })).toBe(
      "[voice note: clip.m4a (12s)]",
    );
  });

  test("no filename falls back to generic label", () => {
    expect(voiceNoteText({ duration: 5 })).toBe(
      "[voice note: voice note (5s)]",
    );
  });

  test("no duration", () => {
    expect(voiceNoteText({ filename: "clip.ogg" })).toBe(
      "[voice note: clip.ogg]",
    );
  });

  test("empty ref", () => {
    expect(voiceNoteText({})).toBe("[voice note: voice note]");
  });

  test("discord formatting in filename is escaped", () => {
    expect(voiceNoteText({ filename: "a```b.mp3" })).toBe(
      "[voice note: a\\`\\`\\`b.mp3]",
    );
  });
});
