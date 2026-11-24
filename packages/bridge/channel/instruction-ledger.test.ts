import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beginCompacting, clearAllCompacting, opWindowLabel } from "./index";
import {
  ackUpTo,
  appendInbound,
  capBody,
  readEntries,
  recordInboundInstruction,
} from "./instruction-ledger";
import type { ChannelMessage } from "./types";

describe("#380 (I1): instruction-ledger (per-channel append-only jsonl)", () => {
  let tmp = "";
  let oldHome = "";
  let storeDir = "";
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "instr-ledger-380-"));
    oldHome = process.env.HOME || "";
    process.env.HOME = tmp;
    storeDir = path.join(tmp, "handovers");
  });
  afterEach(() => {
    process.env.HOME = oldHome;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const msg = (over: Partial<ChannelMessage> = {}): ChannelMessage => ({
    channelId: "ch1",
    channelName: "n",
    channelType: "discord",
    messageId: "m1",
    from: "op",
    fromId: "op1",
    body: "helium stays as is, the upgrade option is off the table",
    timestamp: new Date().toISOString(),
    attachments: [],
    isRoom: false,
    ...over,
  });

  test("append on a human inbound while compacting (isCompacting true; the hook is before the queue decision)", () => {
    beginCompacting({} as any, { id: "ch1" } as any, {} as any);
    expect(opWindowLabel("ch1")).toBe("compacting");
    try {
      const m = msg();
      expect(recordInboundInstruction("ch1", storeDir, m)).toBe(true);
    } finally {
      clearAllCompacting();
    }
    const e = readEntries("ch1", storeDir);
    expect(e).toHaveLength(1);
    expect(e[0].msgId).toBe("m1");
    expect(e[0].authorId).toBe("op1");
    expect(e[0].ackedTs).toBeNull();
  });

  test("a bot-relay/webhook inbound is NOT recorded (beepy author or fromWebhook)", () => {
    expect(
      recordInboundInstruction(
        "ch1",
        storeDir,
        msg({ from: "Beepy", fromId: "b1" }),
      ),
    ).toBe(false);
    expect(
      recordInboundInstruction(
        "ch1",
        storeDir,
        msg({ fromWebhook: true, from: "wake" }),
      ),
    ).toBe(false);
    expect(readEntries("ch1", storeDir)).toHaveLength(0);
  });

  test("a redelivered message (same messageId) appends exactly once", () => {
    appendInbound("ch1", storeDir, {
      msgId: "m1",
      ts: Date.now(),
      authorId: "op1",
      body: "b",
    });
    appendInbound("ch1", storeDir, {
      msgId: "m1",
      ts: Date.now() + 1,
      authorId: "op1",
      body: "b",
    });
    const e = readEntries("ch1", storeDir);
    expect(e).toHaveLength(1);
    expect(e[0].ts).toBeLessThanOrEqual(Date.now());
  });

  test("ackUpTo stamps ackedTs on every unacked entry (the I1 ack call)", () => {
    const t = Date.now();
    appendInbound("ch1", storeDir, {
      msgId: "m1",
      ts: t - 60_000,
      authorId: "op1",
      body: "b1",
    });
    appendInbound("ch1", storeDir, {
      msgId: "m2",
      ts: t - 5_000,
      authorId: "op1",
      body: "b2",
    });
    ackUpTo("ch1", storeDir, t + 1000);
    const e = readEntries("ch1", storeDir);
    expect(e).toHaveLength(2);
    expect(
      e.every((x) => typeof x.ackedTs === "number" && x.ackedTs >= t),
    ).toBe(true);
  });

  test("capBody truncates over-280-char bodies (the ledger cap)", () => {
    const long = "y".repeat(400);
    const c = capBody(long);
    expect(c.length).toBe(280);
    expect(capBody("short")).toBe("short");
  });
});
