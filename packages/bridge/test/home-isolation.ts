/**
 * #380 review t3452 (FAIL, root-cause verified): the non-HOME-isolated
 * handleInbound fixtures (and the direct ledger appendInbound / ackUpTo
 * fixtures) append to the instruction ledger via
 * recordInboundInstruction -> appendInbound(defaultHome()), writing
 * ch1.jsonl / ch2.jsonl into the REAL $HOME/.jarate/instructions/.
 * The handover.test.ts buildSeedKickoff digest test (a hardcoded home)
 * then reads those <30m entries into the seed and breaks its digest
 * assertion when $HOME equals that home (order-dependent flake: base
 * green / PR not green).
 *
 * Call `isolateHomeForTests()` at module scope in a test file to give every
 * test in it a fresh tmp $HOME (restored in afterEach). This keeps the
 * ledger appends — and the undo store + settings read, all keyed off
 * defaultHome() (= process.env.HOME) — away from the real $HOME. Nested
 * describes that set their own HOME still work: they capture this tmp HOME
 * and restore to it; this hook then restores the real one.
 */
import { afterEach, beforeEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Per-module-instance (bun test runs each file in its own worker); set in
// beforeEach, cleared in afterEach, so it is safe per-test.
let iso: { real: string; tmp: string } | null = null;

export function isolateHomeForTests(): void {
  beforeEach(() => {
    iso = {
      real: process.env.HOME || "",
      tmp: mkdtempSync(join(tmpdir(), "jarate-home-")),
    };
    process.env.HOME = join(iso.tmp, "home");
    mkdirSync(process.env.HOME, { recursive: true });
  });
  afterEach(() => {
    if (iso) {
      process.env.HOME = iso.real;
      rmSync(iso.tmp, { recursive: true, force: true });
      iso = null;
    }
  });
}
