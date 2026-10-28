/**
 * Durable store: the shared JSON-file lifecycle for the sleep and task
 * schedulers (issue #258 — sleep.ts and tasks.ts were structural twins),
 * plus the shared atomic-write contract every JSON state file in the
 * bridge uses: atomicWriteJson / atomicTmpName (ONE tmp naming scheme,
 * `<target>.<pid>.<ts>.tmp`) and sweepOrphanTmpFiles (the orphan-sweep
 * contract). Consumers: sleep + tasks (via the store), todos boards,
 * rewake queues (restart-queue), worktree state; undo's session rewrite
 * reuses the naming scheme for its raw JSONL write.
 *
 * Both tools persist a list of pending/claimed records under
 * ~/.pi/agent/<tool>/ and share one storage contract:
 *
 * - the file is `{ "<wrapperKey>": [...] }`, 2-space-indented JSON;
 * - saves are atomic: write `${file}.${pid}.${ts}.tmp` in the same dir,
 *   then rename over the target — a crash leaves only the tmp file;
 * - a missing or corrupt file loads as an empty list; entries failing
 *   per-entry validation are dropped individually, the rest survive;
 * - orphan tmp files (crash between write and rename) are swept at
 *   process start — best-effort, never throws;
 * - delivery is at-least-once: a record is `claimed` before injection and
 *   completed after. A claimed record older than CLAIM_TTL_MS (process
 *   died between claim and completion) is stale and re-delivered exactly
 *   once. The claim is a crash guard, not a lock — a double delivery is
 *   one extra turn, a lost delivery is the bug we protect against.
 *
 * sleep.ts and tasks.ts are the thin domain layers on top: they own the
 * entry shape, per-entry validation, scheduling rules, and rendering.
 * Single-writer assumption unchanged: one pi process per HOME,
 * read-modify-write without a lock.
 */
import * as fs from "node:fs";
import * as path from "node:path";

/** A claimed record is re-delivered after this long (crash between claim
 *  and completion). */
export const CLAIM_TTL_MS = 10 * 60 * 1000;

/** Fields every durable-store record carries (wakes and tasks both). */
export interface DurableEntry {
  id: string;
  channelId: string;
  status: "pending" | "claimed";
  /** Epoch ms of the delivery claim (stale claims are re-delivered). */
  claimedAt?: number;
}

export interface DurableStoreConfig<T extends DurableEntry> {
  /** State dir (created on save). */
  dir: (home: string) => string;
  /** State file, inside the dir. */
  file: (home: string) => string;
  /** Top-level key of the JSON file ("wakes" / "tasks"). */
  wrapperKey: string;
  /** Per-entry validation; return null to drop the entry. */
  validate: (raw: unknown) => T | null;
  /** The record's delivery time (wakeAt / nextFireAt). */
  dueAt: (entry: T) => number;
}

export interface DurableStore<T extends DurableEntry> {
  /** All records on disk; missing/corrupt file -> empty list. */
  load(home: string): T[];
  /** Save all records atomically (tmp file in the same dir, rename over). */
  save(records: T[], home: string): void;
  /**
   * Collect orphan tmp files (crash between tmp write and rename).
   * Best-effort: never throws, called once per process start. Files are
   * `<file>.<pid>.<ts>.tmp`.
   */
  collectOrphans(home: string): number;
  /** Remove a record by id (pending or claimed). True when removed. */
  removeById(id: string, home: string): boolean;
  /** Mark a record claimed (before injection). No-op when the id is gone. */
  claim(id: string, now: number, home: string): void;
  /**
   * Records due for delivery now: pending ones at/after their due time,
   * plus claimed ones whose claim has gone stale (at-least-once).
   */
  due(channelId: string, now: number, home: string): T[];
}

/** Shared record id: base36 timestamp + 4 random chars. */
export function generateStoreId(now: number): string {
  return `${now.toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * The ONE tmp naming scheme for every atomic write in the bridge:
 * `<target>.<pid>.<ts>.tmp`. A crash mid-write leaves only the tmp file,
 * and the orphan sweep below recognizes exactly that shape.
 */
export function atomicTmpName(target: string): string {
  return `${target}.${process.pid}.${Date.now()}.tmp`;
}

/**
 * Atomic JSON write: mkdir the target's dir, write the tmp file in the
 * same dir, rename over the target. Throws on I/O failure (the tmp file
 * is left for the orphan sweep). The one save primitive for the bridge's
 * JSON state files — 2-space-indented, no trailing newline.
 */
export function atomicWriteJson(target: string, value: unknown): void {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = atomicTmpName(target);
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, target);
}

/**
 * Sweep orphan tmp files for one target (crash between tmp write and
 * rename). Best-effort: never throws, returns the count removed. Only
 * `<target>.<pid>.<ts>.tmp` shapes are touched — other state files and
 * unrelated .tmp files in the dir are left alone.
 */
export function sweepOrphanTmpFiles(dir: string, target: string): number {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return 0; // no dir yet — nothing to collect
  }
  let removed = 0;
  for (const n of names) {
    if (!n.startsWith(`${target}.`) || !n.endsWith(".tmp")) continue;
    try {
      fs.unlinkSync(path.join(dir, n));
      removed++;
    } catch {
      // best-effort; a locked/dead tmp file can stay, it is harmless
    }
  }
  return removed;
}

/**
 * Validate a future-ISO parameter, shared by parseWakeAt ("until") and
 * parseTaskSpec ("at"). `label` keeps the error wording per tool.
 */
export function parseFutureIsoParam(
  value: string,
  label: "until" | "at",
  now: number,
  maxMs: number,
): { ms?: number; error?: string } {
  const t = Date.parse(value);
  if (Number.isNaN(t))
    return {
      error: `invalid ${label}: "${value}" (ISO time, e.g. 2026-09-10T15:00:00Z)`,
    };
  if (t <= now) return { error: `${label} must be in the future: ${value}` };
  if (t - now > maxMs)
    return {
      error: `${label} too far out (max ${Math.round(maxMs / 86400000)}d from now)`,
    };
  return { ms: t };
}

/**
 * Validate a minutes parameter, shared by parseWakeAt and parseTaskSpec.
 * `maxMs` drives the cap message (43200 minutes = 30d at MAX_WAKE_MS).
 */
export function parseMinutesParam(
  minutes: number | string,
  maxMs: number,
): { ms?: number; error?: string } {
  const value = typeof minutes === "number" ? minutes : Number(minutes);
  if (!Number.isFinite(value))
    return { error: `minutes must be a number, got "${minutes}"` };
  if (value <= 0) return { error: "minutes must be greater than 0" };
  const ms = value * 60000;
  if (ms > maxMs)
    return {
      error: `minutes too large (max ${Math.round(maxMs / 60000)} = ${Math.round(maxMs / 86400000)}d)`,
    };
  return { ms };
}

/** Build the load/save/orphan/lifecycle ops over one JSON state file. */
export function createDurableStore<T extends DurableEntry>(
  cfg: DurableStoreConfig<T>,
): DurableStore<T> {
  const load = (home: string): T[] => {
    let raw: string;
    try {
      raw = fs.readFileSync(cfg.file(home), "utf8");
    } catch {
      return [];
    }
    try {
      const data = JSON.parse(raw);
      if (!data || !Array.isArray(data[cfg.wrapperKey])) return [];
      const out: T[] = [];
      for (const entry of data[cfg.wrapperKey]) {
        const rec = cfg.validate(entry);
        if (rec) out.push(rec);
      }
      return out;
    } catch {
      return [];
    }
  };

  const save = (records: T[], home: string): void => {
    atomicWriteJson(cfg.file(home), { [cfg.wrapperKey]: records });
  };

  const collectOrphans = (home: string): number => {
    return sweepOrphanTmpFiles(
      cfg.dir(home),
      path.basename(cfg.file(home)),
    );
  };

  const removeById = (id: string, home: string): boolean => {
    const records = load(home);
    const next = records.filter((x) => x.id !== id);
    if (next.length === records.length) return false;
    save(next, home);
    return true;
  };

  const claim = (id: string, now: number, home: string): void => {
    const records = load(home);
    let changed = false;
    const next = records.map((x) => {
      if (x.id !== id) return x;
      changed = true;
      return { ...x, status: "claimed" as const, claimedAt: now };
    });
    if (changed) save(next, home);
  };

  const due = (channelId: string, now: number, home: string): T[] => {
    return load(home).filter((x) => {
      if (x.channelId !== channelId) return false;
      if (x.status === "pending") return cfg.dueAt(x) <= now;
      return now - (x.claimedAt ?? cfg.dueAt(x)) > CLAIM_TTL_MS;
    });
  };

  return { load, save, collectOrphans, removeById, claim, due };
}
