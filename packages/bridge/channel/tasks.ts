/**
 * Scheduled tasks: durable one-shot + cron prompts for this agent's pi session.
 *
 * The `task` tool records a prompt that fires at a later time (one-shot:
 * minutes from now or an ISO time; recurring: 5-field cron, optional IANA
 * timezone). Delivery is EXTERNAL to the run: the bridge checks due tasks on
 * session_start (so a restart or reboot catches up) and via a 30s poller
 * while alive. The prompt is injected through the same channel-inbound path
 * as human messages, so a firing starts a fresh turn in the SAME session.
 *
 * State: ~/.pi/agent/tasks/tasks.json (atomic tmp+rename write, the same
 * storage pattern as the sleep tool). The `home` parameter on every fs
 * function exists for test isolation.
 *
 * Delivery is at-least-once (the sleep tool's invariant, reused): a task is
 * marked `claimed` before it is injected; after injection succeeds it is
 * COMPLETED — a one-shot is removed from the file, a cron advances
 * nextFireAt to the next slot strictly after now. A `claimed` task older
 * than CLAIM_TTL_MS (process died between claim and completion) is stale and
 * re-delivered exactly once. The claim is a crash guard, not a lock.
 *
 * Cron semantics: 5 fields (minute hour day-of-month month day-of-week),
 * values `*`, `a`, `a-b`, with optional `/step` after `*` or a range, comma
 * lists, 3-letter month names (jan..dec) and dow names (sun..sat). dow is
 * 0-7 with 7 = Sunday. When BOTH day-of-month and day-of-week are restricted
 * (not `*`), a day matches if EITHER matches (standard cron OR rule).
 * Times are evaluated in the task's IANA timezone (default: server local).
 * Minute resolution; no seconds field.
 *
 * Single-writer assumption: same as the sleep tool — one pi process per
 * HOME, read-modify-write without a lock.
 */
import * as fs from "node:fs";
import * as path from "node:path";

import { CLAIM_TTL_MS, formatDurationMs, MAX_WAKE_MS } from "./sleep";
import { defaultHome } from "./todos";

export interface ScheduledTask {
  /** Short id (e.g. "m3x2k9-ab12") — the /tasks cancel target. */
  id: string;
  channelId: string;
  channelName?: string;
  /** Prompt injected as a channel-inbound message at fire time. */
  prompt: string;
  kind: "at" | "cron";
  /** One-shot: fire time, epoch ms. */
  atMs?: number;
  /** Cron: 5-field expression. */
  cron?: string;
  /** Cron: IANA timezone (e.g. "Australia/Melbourne"); absent = system. */
  tz?: string;
  /** Epoch ms the task was scheduled. */
  createdAt: number;
  /** Epoch ms of the last completed fire (cron tasks). */
  lastFiredAt?: number;
  /** Epoch ms of the next fire (for "at" tasks this equals atMs). */
  nextFireAt: number;
  status: "pending" | "claimed";
  /** Epoch ms of the delivery claim (stale claims are re-delivered). */
  claimedAt?: number;
}

// ─── State file ────────────────────────────────────────────────────────────

export function tasksDir(home = defaultHome()): string {
  return path.join(home, ".pi", "agent", "tasks");
}

export function tasksPath(home = defaultHome()): string {
  return path.join(tasksDir(home), "tasks.json");
}

/** All tasks on disk; missing/corrupt file -> empty list. */
export function loadTasks(home = defaultHome()): ScheduledTask[] {
  let raw: string;
  try {
    raw = fs.readFileSync(tasksPath(home), "utf8");
  } catch {
    return [];
  }
  try {
    const data = JSON.parse(raw);
    if (!data || !Array.isArray(data.tasks)) return [];
    const out: ScheduledTask[] = [];
    for (const t of data.tasks) {
      if (typeof t?.id !== "string" || !t.id) continue;
      if (typeof t?.channelId !== "string" || !t.channelId) continue;
      if (typeof t?.prompt !== "string" || !t.prompt) continue;
      if (typeof t?.nextFireAt !== "number" || !Number.isFinite(t.nextFireAt))
        continue;
      if (t.kind !== "at" && t.kind !== "cron") continue;
      const task: ScheduledTask = {
        id: t.id,
        channelId: t.channelId,
        prompt: t.prompt,
        kind: t.kind,
        createdAt: typeof t.createdAt === "number" ? t.createdAt : t.nextFireAt,
        nextFireAt: t.nextFireAt,
        status: t.status === "claimed" ? "claimed" : "pending",
      };
      if (typeof t.channelName === "string" && t.channelName)
        task.channelName = t.channelName;
      if (t.kind === "at" && typeof t.atMs === "number") task.atMs = t.atMs;
      if (t.kind === "cron" && typeof t.cron === "string" && t.cron)
        task.cron = t.cron;
      if (t.kind === "cron" && typeof t.tz === "string" && t.tz) task.tz = t.tz;
      if (typeof t.lastFiredAt === "number") task.lastFiredAt = t.lastFiredAt;
      if (t.status === "claimed" && typeof t.claimedAt === "number")
        task.claimedAt = t.claimedAt;
      out.push(task);
    }
    return out;
  } catch {
    return [];
  }
}

/** Save all tasks atomically (tmp file in the same dir, rename over). */
export function saveTasks(tasks: ScheduledTask[], home = defaultHome()): void {
  const dir = tasksDir(home);
  fs.mkdirSync(dir, { recursive: true });
  const target = tasksPath(home);
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ tasks }, null, 2));
  fs.renameSync(tmp, target);
}

/**
 * Collect orphan tmp files (crash between tmp write and rename). Best-effort:
 * never throws, called once per process start. Files are tasks.json.*.tmp.
 */
export function collectOrphanTaskTmpFiles(home = defaultHome()): number {
  const dir = tasksDir(home);
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return 0; // no dir yet — nothing to collect
  }
  const target = path.basename(tasksPath(home));
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

// ─── Cron ──────────────────────────────────────────────────────────────────

const MONTH_NAMES: Record<string, number> = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  oct: 10,
  nov: 11,
  dec: 12,
};
const DOW_NAMES: Record<string, number> = {
  sun: 0,
  mon: 1,
  tue: 2,
  wed: 3,
  thu: 4,
  fri: 5,
  sat: 6,
};

interface FieldSpec {
  name: string;
  min: number;
  max: number;
  names?: Record<string, number>;
  /** Accept 7 as an alias for 0 (Sunday). */
  wrap7?: boolean;
}

const CRON_FIELD_SPECS: FieldSpec[] = [
  { name: "minute", min: 0, max: 59 },
  { name: "hour", min: 0, max: 23 },
  { name: "day-of-month", min: 1, max: 31 },
  { name: "month", min: 1, max: 12, names: MONTH_NAMES },
  { name: "day-of-week", min: 0, max: 7, names: DOW_NAMES, wrap7: true },
];

export interface CronFields {
  minute: Set<number>;
  hour: Set<number>;
  dom: Set<number>;
  month: Set<number>;
  dow: Set<number>;
  /** Literal `*` in the field — drives the dom/dow OR rule. */
  domAny: boolean;
  dowAny: boolean;
}

export type CronParse = { fields?: CronFields; error?: string };

/** Parse one cron field into its value set; a string is the error. */
function parseCronField(expr: string, spec: FieldSpec): Set<number> | string {
  const value = (tok: string): number | string => {
    const low = tok.toLowerCase();
    if (spec.names && low in spec.names) return spec.names[low]!;
    if (!/^\d+$/.test(tok)) return `not a number: "${tok}"`;
    const n = Number(tok);
    if (n < spec.min || n > spec.max)
      return `${spec.name} out of range ${spec.min}-${spec.max}: ${n}`;
    return n;
  };
  const values = new Set<number>();
  for (const part of expr.split(",")) {
    if (!part) return `empty ${spec.name} list item in "${expr}"`;
    const m = part.match(/^(.+?)(?:\/(\d+))?$/);
    if (!m) return `bad ${spec.name} term "${part}"`;
    const base = m[1];
    const step = m[2] !== undefined ? Number(m[2]) : 1;
    if (!Number.isInteger(step) || step < 1)
      return `bad step in ${spec.name} "${part}"`;
    let lo: number;
    let hi: number;
    if (base === "*") {
      lo = spec.min;
      hi = spec.max;
    } else if (base.includes("-")) {
      const [a, b] = base.split("-");
      const av = value(a);
      if (typeof av === "string") return av;
      const bv = value(b);
      if (typeof bv === "string") return bv;
      if (av > bv) return `${spec.name} range is backwards: "${part}"`;
      lo = av;
      hi = bv;
    } else {
      const av = value(base);
      if (typeof av === "string") return av;
      if (m[2] !== undefined)
        return `${spec.name} step needs * or a range: "${part}"`;
      lo = av;
      hi = av;
    }
    for (let v = lo; v <= hi; v += step)
      values.add(spec.wrap7 && v === 7 ? 0 : v);
  }
  return values;
}

/**
 * Parse a 5-field cron expression. Returns { fields } or { error }.
 * `domAny`/`dowAny` are true only for a literal `*` (standard cron OR rule).
 */
export function parseCron(expr: string): CronParse {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5)
    return {
      error: `expected 5 fields (minute hour day-of-month month day-of-week), got ${parts.length}`,
    };
  const sets = parts.map((p, i) => parseCronField(p, CRON_FIELD_SPECS[i]));
  for (const s of sets) if (typeof s === "string") return { error: s };
  return {
    fields: {
      minute: sets[0] as Set<number>,
      hour: sets[1] as Set<number>,
      dom: sets[2] as Set<number>,
      month: sets[3] as Set<number>,
      dow: sets[4] as Set<number>,
      domAny: parts[2] === "*",
      dowAny: parts[4] === "*",
    },
  };
}

/** Search horizon for nextCronFire: 5 years of minutes. */
export const CRON_CAP_MINUTES = 5 * 366 * 1440;

const DOW_ABBR: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

/**
 * Next fire time (epoch ms, minute-aligned) STRICTLY AFTER afterMs for the
 * cron expression, evaluated in `tz` (absent = system local). Returns null
 * when nothing fires within capMinutes (e.g. "0 0 31 4 *" — April 31).
 */
export function nextCronFire(
  cron: string,
  afterMs: number,
  tz?: string,
  capMinutes: number = CRON_CAP_MINUTES,
): number | null {
  const parsed = parseCron(cron);
  if (!parsed.fields) return null;
  const f = parsed.fields;
  const opts: Intl.DateTimeFormatOptions = {
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
  };
  if (tz) opts.timeZone = tz;
  let fmt: Intl.DateTimeFormat;
  try {
    fmt = new Intl.DateTimeFormat("en-US", opts);
  } catch {
    return null; // unknown IANA tz
  }
  let t = Math.floor(afterMs / 60000) * 60000 + 60000;
  const end = t + capMinutes * 60000;
  while (t < end) {
    const parts = fmt.formatToParts(new Date(t));
    const get = (type: string) =>
      parts.find((p) => p.type === type)?.value ?? "";
    const minute = Number(get("minute"));
    if (!f.minute.has(minute)) {
      t += 60000;
      continue;
    }
    const hour = Number(get("hour"));
    // Wall-clock hour and month are constant within an hour, so an
    // hour/month mismatch jumps to the next wall-clock hour boundary
    // instead of scanning all 60 minutes. DST-safe for every IANA
    // transition in use today (forward jumps land on the next hour, so
    // the skipped span only covers the current wall-clock hour or
    // non-existent gap minutes).
    if (!f.hour.has(hour) || !f.month.has(Number(get("month")))) {
      t += (60 - minute) * 60000;
      continue;
    }
    const domOk = f.dom.has(Number(get("day")));
    const dowOk = f.dow.has(DOW_ABBR[get("weekday")] ?? 0);
    const dayOk =
      f.domAny && f.dowAny
        ? true
        : f.domAny
          ? dowOk
          : f.dowAny
            ? domOk
            : domOk || dowOk;
    if (dayOk) return t;
    t += 60000;
  }
  return null;
}

// ─── Spec validation ───────────────────────────────────────────────────────

export interface TaskSpec {
  kind: "at" | "cron";
  atMs?: number;
  cron?: string;
  tz?: string;
  /** First fire (computed at schedule time; persisted on the task). */
  nextFireAt: number;
}

/**
 * Validate a task spec from tool params: a prompt plus EXACTLY ONE of
 * `at` (ISO, future, <= 30d), `minutes` (> 0, <= 30d) or `cron` (5-field,
 * must fire within 5 years). `tz` is optional (IANA name) and only applies
 * to cron. Returns the spec or an error.
 */
export function parseTaskSpec(
  params: {
    prompt?: string;
    at?: string;
    minutes?: number | string;
    cron?: string;
    tz?: string;
  },
  now = Date.now(),
): { spec?: TaskSpec; error?: string } {
  const prompt = typeof params.prompt === "string" ? params.prompt.trim() : "";
  if (!prompt) return { error: "prompt is required" };
  const hasAt =
    params.at !== undefined && params.at !== null && params.at !== "";
  const hasMinutes =
    params.minutes !== undefined &&
    params.minutes !== null &&
    params.minutes !== "";
  const hasCron =
    params.cron !== undefined && params.cron !== null && params.cron !== "";
  const given = [hasAt, hasMinutes, hasCron].filter(Boolean).length;
  if (given !== 1) return { error: "pass exactly one of: minutes, at, cron" };

  const tz = params.tz?.trim() || undefined;
  if (tz) {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: tz });
    } catch {
      return {
        error: `unknown timezone "${params.tz}" (IANA name, e.g. Australia/Melbourne)`,
      };
    }
  }

  if (hasCron) {
    const expr = String(params.cron).trim();
    const parsed = parseCron(expr);
    if (parsed.error)
      return { error: `invalid cron "${expr}": ${parsed.error}` };
    const next = nextCronFire(expr, now, tz);
    if (next === null)
      return { error: `cron "${expr}" does not fire within 5 years` };
    return { spec: { kind: "cron", cron: expr, tz, nextFireAt: next } };
  }

  if (hasAt) {
    const t = Date.parse(String(params.at));
    if (Number.isNaN(t))
      return {
        error: `invalid at: "${params.at}" (ISO time, e.g. 2026-09-10T15:00:00Z)`,
      };
    if (t <= now) return { error: `at must be in the future: ${params.at}` };
    if (t - now > MAX_WAKE_MS)
      return { error: "at too far out (max 30d from now)" };
    return { spec: { kind: "at", atMs: t, nextFireAt: t } };
  }

  const minutes =
    typeof params.minutes === "number"
      ? params.minutes
      : Number(params.minutes);
  if (!Number.isFinite(minutes))
    return { error: `minutes must be a number, got "${params.minutes}"` };
  if (minutes <= 0) return { error: "minutes must be greater than 0" };
  const ms = minutes * 60000;
  if (ms > MAX_WAKE_MS) return { error: `minutes too large (max 43200 = 30d)` };
  return { spec: { kind: "at", atMs: now + ms, nextFireAt: now + ms } };
}

// ─── Scheduling / lifecycle ────────────────────────────────────────────────

/** Record a task. `nextFireAt` must come from parseTaskSpec. */
export function scheduleTask(opts: {
  channelId: string;
  channelName?: string;
  prompt: string;
  spec: TaskSpec;
  home?: string;
  now?: number;
}): ScheduledTask {
  const home = opts.home;
  const now = opts.now ?? Date.now();
  const id = `${now.toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const task: ScheduledTask = {
    id,
    channelId: opts.channelId,
    prompt: opts.prompt,
    kind: opts.spec.kind,
    createdAt: now,
    nextFireAt: opts.spec.nextFireAt,
    status: "pending",
  };
  if (opts.channelName) task.channelName = opts.channelName;
  if (opts.spec.kind === "at" && opts.spec.atMs !== undefined)
    task.atMs = opts.spec.atMs;
  if (opts.spec.kind === "cron" && opts.spec.cron) task.cron = opts.spec.cron;
  if (opts.spec.kind === "cron" && opts.spec.tz) task.tz = opts.spec.tz;
  saveTasks([...loadTasks(home), task], home);
  return task;
}

/** Remove a task by id (pending or claimed). True when something was removed. */
export function cancelTask(id: string, home = defaultHome()): boolean {
  const tasks = loadTasks(home);
  const next = tasks.filter((t) => t.id !== id);
  if (next.length === tasks.length) return false;
  saveTasks(next, home);
  return true;
}

/** Mark a task claimed (before injection). No-op when the id is gone. */
export function markTaskClaimed(
  id: string,
  now = Date.now(),
  home = defaultHome(),
): void {
  const tasks = loadTasks(home);
  let changed = false;
  const next = tasks.map((t) => {
    if (t.id !== id) return t;
    changed = true;
    return { ...t, status: "claimed" as const, claimedAt: now };
  });
  if (changed) saveTasks(next, home);
}

/**
 * Complete a delivered task, called AFTER injection succeeded.
 * - one-shot: removed from the file (bounded store, honest /tasks list).
 * - cron: status back to pending, lastFiredAt = the slot just fired,
 *   nextFireAt = the next slot STRICTLY AFTER now (no immediate re-fire,
 *   and a fire missed while the process was down is skipped, not replayed).
 * True when something was updated or removed.
 */
export function completeTask(
  id: string,
  now = Date.now(),
  home = defaultHome(),
): boolean {
  const tasks = loadTasks(home);
  const t = tasks.find((x) => x.id === id);
  if (!t) return false;
  if (t.kind === "at") return cancelTask(id, home);
  const next =
    nextCronFire(t.cron!, now, t.tz) ?? now + CRON_CAP_MINUTES * 60000;
  const nextTasks = tasks.map((x) =>
    x.id === id
      ? {
          ...x,
          status: "pending" as const,
          claimedAt: undefined,
          lastFiredAt: x.nextFireAt, // the slot that just fired
          nextFireAt: next,
        }
      : x,
  );
  saveTasks(nextTasks, home);
  return true;
}

/**
 * Tasks that should be delivered now: pending ones at/after nextFireAt, plus
 * claimed ones whose claim has gone stale (crash between claim and
 * completion — at-least-once).
 */
export function dueTasks(
  channelId: string,
  now = Date.now(),
  home = defaultHome(),
): ScheduledTask[] {
  return loadTasks(home).filter((t) => {
    if (t.channelId !== channelId) return false;
    if (t.status === "pending") return t.nextFireAt <= now;
    return now - (t.claimedAt ?? t.nextFireAt) > CLAIM_TTL_MS;
  });
}

// ─── Rendering ─────────────────────────────────────────────────────────────

/** How a task's schedule is shown in /tasks list. */
export function taskScheduleLabel(task: ScheduledTask): string {
  if (task.kind === "cron")
    return `cron "${task.cron}"${task.tz ? ` (${task.tz})` : " (system tz)"}`;
  return `at ${new Date(task.atMs ?? task.nextFireAt).toISOString()}`;
}

/**
 * The fire message body. Injected as a channel-inbound message at fire time
 * — the agent sees it as a normal message in its own session.
 */
export function formatTaskPrompt(task: ScheduledTask): string {
  const due = new Date(task.nextFireAt)
    .toISOString()
    .slice(0, 16)
    .replace("T", " ");
  const label =
    task.kind === "cron"
      ? `recurring task "${task.cron}"${task.tz ? ` (${task.tz})` : ""}`
      : "one-shot task";
  return `[task] ${label} due ${due} UTC: ${task.prompt}`;
}

/** One line per task for /tasks list. */
export function formatTaskLine(
  task: ScheduledTask,
  channelName: string | undefined,
  now = Date.now(),
): string {
  const m = Math.round((task.nextFireAt - now) / 60000);
  const state =
    task.status === "claimed"
      ? "claimed"
      : m > 0
        ? `in ${formatDurationMs(m * 60000)}`
        : "due";
  const prompt =
    task.prompt.length > 60 ? `${task.prompt.slice(0, 60)}…` : task.prompt;
  return (
    `- ${task.id} · ${channelName || task.channelName || task.channelId} · ` +
    `${taskScheduleLabel(task)} · next ${new Date(task.nextFireAt).toISOString()} ` +
    `(${state}) · ${prompt}`
  );
}
