import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  formatJobsView,
  type JobHistoryEntry,
  jobsView,
  scanJobHistory,
} from "./jobs";

// /jobs is history-only since the drain (#279): the dispatch lane is
// retired (zero in-flight runs fleet-wide), so the in-flight ps view and
// the kill/tail wrapper tests died with the removed dispatch scripts.
// What remains pinned here: the ~/.pi-bg-art artifact scan (states,
// webhook codes, ordering) and the view rendering (text + json).

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jobs-test-"));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function touch(name: string, mtimeSec: number, content = "x\n"): void {
  const p = path.join(tmp, name);
  fs.writeFileSync(p, content);
  const t = new Date(mtimeSec * 1000);
  fs.utimesSync(p, t, t);
}

describe("scanJobHistory", () => {
  test("assembles state + webhook from artifacts, newest first", () => {
    const now = 1_790_000_000;
    // A: completed, webhook delivered (2xx code recorded)
    touch("pi-bg-20260910-100000-1-raw.out", now - 300);
    touch("pi-bg-20260910-100000-1-out.md", now - 290, "done work\n");
    touch(
      "pi-bg-20260910-100000-1-wb-status",
      now - 280,
      "200 2026-09-10T10:00Z\n",
    );
    // B: completed but callback dead-lettered (http 502)
    touch("pi-bg-20260910-101000-2-raw.out", now - 250);
    touch("pi-bg-20260910-101000-2-out.md", now - 240, "work\n");
    touch(
      "pi-bg-20260910-101000-2-webhook-failed",
      now - 200,
      "ticket   : 20260910-101000-2\nhttp     : 502 (3 attempts)\n",
    );
    // C: killed on purpose
    touch("pi-bg-20260910-102000-3-raw.out", now - 150);
    touch(
      "pi-bg-20260910-102000-3-killed",
      now - 100,
      "2026-09-10T10:05:00Z 20260910-102000-3 killed by monky after 0s; pids: 42\n",
    );
    // D: started, no report (raw.out only)
    touch("pi-bg-20260910-103000-4-raw.out", now - 10);
    // non-ticket files: ignored
    touch("pi-bg-notaticket-raw.out", now - 5);
    touch("unrelated.txt", now - 5);

    const h = scanJobHistory(tmp);
    expect(h.map((e) => e.id)).toEqual([
      "20260910-103000-4",
      "20260910-102000-3",
      "20260910-101000-2",
      "20260910-100000-1",
    ]);
    expect(h).toEqual([
      {
        id: "20260910-103000-4",
        state: "lost",
        mtime: now - 10,
        webhook: null,
      },
      {
        id: "20260910-102000-3",
        state: "killed",
        mtime: now - 100,
        webhook: null,
      },
      {
        id: "20260910-101000-2",
        state: "webhook-failed",
        mtime: now - 200,
        webhook: "502",
      },
      {
        id: "20260910-100000-1",
        state: "done",
        mtime: now - 280,
        webhook: "200",
      },
    ]);
  });

  test("empty dir -> empty history; missing dir -> empty (no throw)", () => {
    expect(scanJobHistory(tmp)).toEqual([]);
    expect(scanJobHistory(path.join(tmp, "nope"))).toEqual([]);
  });

  test("ticket with only a non-empty out.md counts as done", () => {
    touch("pi-bg-20260910-110000-9-out.md", 1_790_000_000, "result\n");
    const h = scanJobHistory(tmp);
    expect(h).toEqual([
      {
        id: "20260910-110000-9",
        state: "done",
        mtime: 1_790_000_000,
        webhook: null,
      },
    ]);
  });
});

// ─── formatJobsView (history only) ────────────────────────────────────────

describe("formatJobsView", () => {
  const history: JobHistoryEntry[] = [
    {
      id: "20260910-103000-4",
      state: "lost",
      mtime: 1_790_000_000,
      webhook: null,
    },
    {
      id: "20260910-100000-1",
      state: "done",
      mtime: 1_789_999_700,
      webhook: "200",
    },
    {
      id: "20260910-090000-7",
      state: "webhook-failed",
      mtime: 1_789_996_400,
      webhook: "502",
    },
  ];

  test("text: markdown list, recent raw states", () => {
    const out = formatJobsView(history, "text", 1_790_000_000);
    expect(out).toBe(
      [
        "**recent (newest first) · 3**",
        "",
        "- lost · 0s · 20260910-103000-4",
        "- done · 5m · 20260910-100000-1",
        "- webhook-failed · 1h0m · 20260910-090000-7",
      ].join("\n"),
    );
  });

  test("text: recent rows keep raw states, no width budget", () => {
    const worst: JobHistoryEntry[] = [
      {
        id: "20260910-103000-4",
        state: "webhook-failed",
        mtime: 1_789_992_850,
        webhook: "502",
      },
    ];
    const out = formatJobsView(worst, "text", 1_790_000_000);
    expect(out).toContain("- webhook-failed · 1h59m · 20260910-103000-4");
  });

  test("text: no history is a closed empty frame", () => {
    expect(formatJobsView([], "text")).toBe("**jobs · none**");
  });

  test("json: machine-readable object", () => {
    const parsed = JSON.parse(formatJobsView(history, "json"));
    expect(parsed.history).toEqual(history);
  });

  test("json caps history at 10 entries", () => {
    const big: JobHistoryEntry[] = Array.from({ length: 15 }, (_, i) => ({
      id: `20260910-00000${i % 10}-${i}`,
      state: "lost" as const,
      mtime: 1_790_000_000 - i * 100,
      webhook: null,
    }));
    const parsed = JSON.parse(formatJobsView(big, "json"));
    expect(parsed.history).toHaveLength(10);
    expect(parsed.history[0].id).toBe(big[0].id);
  });
});

// ─── jobsView (history passthrough) ──────────────────────────────────────

describe("jobsView", () => {
  const history: JobHistoryEntry[] = [
    {
      id: "20260916-044537-3530347",
      state: "done",
      mtime: 1_789_999_700,
      webhook: "200",
    },
  ];

  test("text: history renders via the recent section", () => {
    const out = jobsView("text", { history });
    // age is relative to the real clock: pin state + id, not the age
    expect(out).toContain("- done ");
    expect(out).toContain("20260916-044537-3530347");
  });

  test("json: the history object, capped at 10", () => {
    const big: JobHistoryEntry[] = Array.from({ length: 15 }, (_, i) => ({
      id: `20260910-00000${i % 10}-${i}`,
      state: "lost" as const,
      mtime: 1_790_000_000 - i * 100,
      webhook: null,
    }));
    const parsed = JSON.parse(jobsView("json", { history: big }));
    expect(parsed.history).toHaveLength(10);
  });

  test("no history override -> artifact scan", () => {
    const out = jobsView("text");
    // environment-dependent: the legacy /tmp scan may find real artifacts
    // on a dispatch host (CI is clean). Both shapes start with **jobs /
    // **recent - never a throw, never an in-flight frame.
    expect(out).toMatch(/^\*\*(jobs · none|recent \(newest first)/);
  });
});
