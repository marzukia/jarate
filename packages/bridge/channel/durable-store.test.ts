import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  CLAIM_TTL_MS,
  atomicTmpName,
  atomicWriteJson,
  createDurableStore,
  generateStoreId,
  parseFutureIsoParam,
  parseMinutesParam,
  sweepOrphanTmpFiles,
} from "./durable-store";

// 2026-09-10 is a Thursday.
const NOW = Date.parse("2026-09-10T12:00:00Z");

interface Rec {
  id: string;
  channelId: string;
  at: number;
  status: "pending" | "claimed";
  claimedAt?: number;
  note?: string;
}

const dir = (home: string) => path.join(home, ".pi", "agent", "teststore");
const file = (home: string) => path.join(dir(home), "recs.json");

function makeStore() {
  return createDurableStore<Rec>({
    dir,
    file,
    wrapperKey: "recs",
    validate(raw: unknown): Rec | null {
      const r = raw as any;
      if (typeof r?.id !== "string" || !r.id) return null;
      if (typeof r?.channelId !== "string" || !r.channelId) return null;
      if (typeof r?.at !== "number" || !Number.isFinite(r.at)) return null;
      const rec: Rec = {
        id: r.id,
        channelId: r.channelId,
        at: r.at,
        status: r.status === "claimed" ? "claimed" : "pending",
      };
      if (typeof r.note === "string" && r.note) rec.note = r.note;
      if (r.status === "claimed" && typeof r.claimedAt === "number")
        rec.claimedAt = r.claimedAt;
      return rec;
    },
    dueAt: (r) => r.at,
  });
}

describe("durable-store: file contract", () => {
  let tmp = "";
  const store = makeStore();

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "piscord-store-"));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test("save writes { recs: [...] } 2-space JSON, no tmp residue", () => {
    const rec: Rec = {
      id: "a",
      channelId: "c1",
      at: NOW,
      status: "pending",
      note: "n",
    };
    store.save([rec], tmp);
    expect(fs.readFileSync(file(tmp), "utf8")).toBe(
      JSON.stringify({ recs: [rec] }, null, 2),
    );
    expect(
      fs.readdirSync(dir(tmp)).filter((n) => n.endsWith(".tmp")),
    ).toHaveLength(0);
  });

  test("load roundtrips; missing/corrupt file and wrong wrapper -> []", () => {
    expect(store.load(tmp)).toHaveLength(0);
    store.save([{ id: "a", channelId: "c1", at: NOW, status: "pending" }], tmp);
    expect(store.load(tmp)).toEqual([
      { id: "a", channelId: "c1", at: NOW, status: "pending" },
    ]);
    fs.writeFileSync(file(tmp), "{ not json");
    expect(store.load(tmp)).toHaveLength(0);
    fs.writeFileSync(file(tmp), JSON.stringify({ other: [] }));
    expect(store.load(tmp)).toHaveLength(0);
  });

  test("load drops entries missing required fields, keeps the rest", () => {
    fs.mkdirSync(dir(tmp), { recursive: true });
    fs.writeFileSync(
      file(tmp),
      JSON.stringify({
        recs: [
          { id: "ok", channelId: "c", at: NOW, status: "pending" },
          { id: "" },
          { id: 5, channelId: "c", at: NOW, status: "pending" },
        ],
      }),
    );
    expect(store.load(tmp)).toEqual([
      { id: "ok", channelId: "c", at: NOW, status: "pending" },
    ]);
  });

  test("orphan sweep removes <file>.<pid>.<ts>.tmp only", () => {
    store.save([], tmp);
    const orphan = `${file(tmp)}.${process.pid}.123.tmp`;
    fs.writeFileSync(orphan, "stale");
    const unrelated = path.join(dir(tmp), "unrelated.tmp");
    fs.writeFileSync(unrelated, "keep");
    expect(store.collectOrphans(tmp)).toBe(1);
    expect(fs.existsSync(orphan)).toBe(false);
    expect(fs.existsSync(unrelated)).toBe(true);
    expect(store.collectOrphans(tmp)).toBe(0);
  });

  test("collectOrphans: no dir yet -> 0, no throw", () => {
    expect(store.collectOrphans(tmp)).toBe(0);
  });
});

describe("durable-store: lifecycle (fake clock, tmp home)", () => {
  let tmp = "";
  const store = makeStore();

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "piscord-store-"));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test("removeById: true when removed, false for unknown", () => {
    store.save(
      [
        { id: "a", channelId: "c1", at: NOW, status: "pending" },
        { id: "b", channelId: "c1", at: NOW, status: "pending" },
      ],
      tmp,
    );
    expect(store.removeById("nope", tmp)).toBe(false);
    expect(store.removeById("a", tmp)).toBe(true);
    expect(store.load(tmp).map((r) => r.id)).toEqual(["b"]);
    expect(store.removeById("a", tmp)).toBe(false);
  });

  test("claim sets status + claimedAt; no file rewrite when the id is gone", () => {
    store.save(
      [
        { id: "a", channelId: "c1", at: NOW - 1000, status: "pending" },
        { id: "b", channelId: "c1", at: NOW + 60000, status: "pending" },
      ],
      tmp,
    );
    const before = fs.readFileSync(file(tmp), "utf8");
    store.claim("nope", NOW, tmp);
    expect(fs.readFileSync(file(tmp), "utf8")).toBe(before);
    store.claim("a", NOW, tmp);
    expect(store.load(tmp).find((r) => r.id === "a")).toMatchObject({
      status: "claimed",
      claimedAt: NOW,
    });
  });

  test("due: pending at/after, claimed stale only after CLAIM_TTL_MS, channel-scoped", () => {
    store.save(
      [
        { id: "due", channelId: "c1", at: NOW - 1000, status: "pending" },
        { id: "later", channelId: "c1", at: NOW + 60000, status: "pending" },
        { id: "other", channelId: "c2", at: NOW - 1000, status: "pending" },
      ],
      tmp,
    );
    expect(store.due("c1", NOW, tmp).map((r) => r.id)).toEqual(["due"]);
    store.claim("due", NOW, tmp);
    // claimed: not due while the claim is fresh (only "later" is naturally
    // due by then)
    expect(store.due("c1", NOW, tmp)).toHaveLength(0);
    expect(store.due("c1", NOW + CLAIM_TTL_MS, tmp).map((r) => r.id)).toEqual([
      "later",
    ]);
    // crash between claim and completion: stale claim re-due after TTL
    // ("later" is due too by then - 60s < 10min)
    expect(
      store.due("c1", NOW + CLAIM_TTL_MS + 1, tmp).map((r) => r.id),
    ).toEqual(["due", "later"]);
    expect(store.due("c2", NOW + CLAIM_TTL_MS + 1, tmp)).toHaveLength(1);
  });
});

describe("durable-store: shared atomic write (one tmp scheme + sweep)", () => {
  let tmp = "";

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "piscord-store-"));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test("atomicTmpName: the one scheme <target>.<pid>.<ts>.tmp", () => {
    const name = atomicTmpName(`${tmp}/x.json`);
    expect(name).toMatch(new RegExp(`^${tmp.replace(/[/\\.^+\[$\]()|*=]/g, "\\$&")}/x\.json\\.\\d+\\.\\d+\\.tmp$`));
  });

  test("atomicWriteJson: mkdirs the dir, 2-space JSON, no tmp residue", () => {
    const target = path.join(tmp, "nested", "dir", "x.json");
    atomicWriteJson(target, { a: 1, b: [1, 2] });
    expect(fs.readFileSync(target, "utf8")).toBe(
      JSON.stringify({ a: 1, b: [1, 2] }, null, 2),
    );
    expect(
      fs.readdirSync(path.dirname(target)).filter((n) => n.endsWith(".tmp")),
    ).toHaveLength(0);
  });

  test("atomicWriteJson: rename failure throws and leaves the tmp for the sweep", () => {
    const target = path.join(tmp, "x.json");
    fs.mkdirSync(target); // rename over a dir fails (ENOTDIR)
    expect(() => atomicWriteJson(target, { a: 1 })).toThrow();
    const residue = fs
      .readdirSync(tmp)
      .filter((n) => n.startsWith("x.json.") && n.endsWith(".tmp"));
    expect(residue).toHaveLength(1);
    expect(sweepOrphanTmpFiles(tmp, "x.json")).toBe(1);
    expect(fs.readdirSync(tmp).filter((n) => n.endsWith(".tmp"))).toHaveLength(0);
  });

  test("sweepOrphanTmpFiles: only <target>.<pid>.<ts>.tmp, never throws", () => {
    fs.writeFileSync(path.join(tmp, "x.json"), "{}");
    fs.writeFileSync(path.join(tmp, "x.json.42.1234.tmp"), "stale");
    fs.writeFileSync(path.join(tmp, "x.json.other.tmp"), "stale");
    fs.writeFileSync(path.join(tmp, "unrelated.tmp"), "keep");
    fs.writeFileSync(path.join(tmp, "y.json.42.1234.tmp"), "other target");
    expect(sweepOrphanTmpFiles(tmp, "x.json")).toBe(2);
    expect(fs.existsSync(path.join(tmp, "x.json.42.1234.tmp"))).toBe(false);
    expect(fs.existsSync(path.join(tmp, "x.json.other.tmp"))).toBe(false);
    expect(fs.existsSync(path.join(tmp, "unrelated.tmp"))).toBe(true);
    expect(fs.existsSync(path.join(tmp, "y.json.42.1234.tmp"))).toBe(true);
    expect(fs.existsSync(path.join(tmp, "x.json"))).toBe(true);
    expect(sweepOrphanTmpFiles(path.join(tmp, "no-such-dir"), "x.json")).toBe(0);
  });
});

describe("durable-store: id + spec helpers", () => {
  test("generateStoreId: base36 timestamp + 4 random chars, unique", () => {
    const a = generateStoreId(NOW);
    const b = generateStoreId(NOW);
    expect(a).toMatch(/^[0-9a-z]+-[0-9a-z]{4}$/);
    expect(a.split("-")[0]).toBe(NOW.toString(36));
    expect(a).not.toBe(b);
  });

  test("parseMinutesParam: the shared error strings", () => {
    const MAX = 30 * 24 * 60 * 60 * 1000;
    expect(parseMinutesParam("abc", MAX).error).toBe(
      'minutes must be a number, got "abc"',
    );
    expect(parseMinutesParam(0, MAX).error).toBe(
      "minutes must be greater than 0",
    );
    expect(parseMinutesParam(MAX / 60000 + 1, MAX).error).toBe(
      "minutes too large (max 43200 = 30d)",
    );
    expect(parseMinutesParam(30, MAX)).toEqual({ ms: 30 * 60000 });
    expect(parseMinutesParam("45", MAX)).toEqual({ ms: 45 * 60000 });
  });

  test("parseFutureIsoParam: the shared error strings keep the per-tool label", () => {
    const MAX = 30 * 24 * 60 * 60 * 1000;
    expect(parseFutureIsoParam("tomorrow", "until", NOW, MAX).error).toBe(
      'invalid until: "tomorrow" (ISO time, e.g. 2026-09-10T15:00:00Z)',
    );
    expect(parseFutureIsoParam("tomorrow", "at", NOW, MAX).error).toBe(
      'invalid at: "tomorrow" (ISO time, e.g. 2026-09-10T15:00:00Z)',
    );
    expect(
      parseFutureIsoParam("2026-09-09T15:00:00Z", "until", NOW, MAX).error,
    ).toBe("until must be in the future: 2026-09-09T15:00:00Z");
    expect(
      parseFutureIsoParam("2026-09-09T15:00:00Z", "at", NOW, MAX).error,
    ).toBe("at must be in the future: 2026-09-09T15:00:00Z");
    expect(
      parseFutureIsoParam(
        new Date(NOW + MAX + 1000).toISOString(),
        "at",
        NOW,
        MAX,
      ).error,
    ).toBe("at too far out (max 30d from now)");
    expect(
      parseFutureIsoParam("2026-09-10T15:00:00Z", "until", NOW, MAX),
    ).toEqual({ ms: Date.parse("2026-09-10T15:00:00Z") });
  });
});
