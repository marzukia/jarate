# jarate open-issue staleness audit (2026-10-26)

Operator order 2026-10-26: "make sure they're still up to date and not stale."
READ-ONLY audit (no issue/PR edits). Baseline: `github/main` @ d1895d36
(= worktree HEAD; #272 gut + #35 + #277 bg-strip + #283/#285/#286/#287/#288/#289/#290
merged since the order was written). Method: `git log --all --grep` + merged-PR
references per issue, claim verification against current code on main.

Context respected: #262's hold (PR #285) is LIFTED — #285 merged 2026-10-23
(5f2e5e0a), #288 (badceeac) then landed the fix. PR #246 (ZOMBIE cap slot, #243)
parked on operator call. The pi-bg lane is RETIRED (#277 bg-strip; centralised
jarate-bg lane drained per #279/#286; watchdog removed per #280/#290) — issues
touching pi-bg/~/scripts/pi-bg judged against that.

## Issues (39)

#291 | VALID | new 2026-10-25; last-ask derivation (handover.ts:383-404) + keptTailMessages (firstKeptEntryId tail) unchanged since the confirmed instances; newest main commit 2026-10-24 (d1895d36) predates the filing | keep
#284 | STALE | superseded by #280/#290 (d1895d36): dispatch/jarate-bg-watchdog removed from the repo; the 15-min liveness sweep centralised to hall-monitor#59 (dispatch/lib.sh:119, install.sh:165, docs/DISPATCH.md:29); fresh boxes no longer need a per-box timer — only deploy/pi timers remain (docs/SETUP.md:122,223) | close
#282 | STALE | fixed 374130af (PR #287, in main); bin/ now holds only jarate/jarate.test.ts/shell-words.ts — pi, webdrop, jarate-censor, jarate-diff all gone | close
#281 | STALE | fixed d27a64c7 (PR #289, in main); AGENTS.md:24/65 + CONTRIBUTING.md:21 now say "1087 pass" (exact current count); docs/DISPATCH.md is the pointer page with the retirement banner | close
#266 | PARTIAL | index.ts is 6955 lines on main (was 6969 at filing); the 5-module pure move is in flight as open PR #273 (4 merge conflicts vs main, bridge CI failing); issue tracks the remainder, size ratchet is the permanent guard | keep (re-baseline after #273 lands)
#265 | VALID | every cited dead export still present on main: types.ts:56 ChannelSettings, types.ts:126 ChannelStatus, discord.ts:1198 interactionUserName, :1695 replyInteraction, :1736 deleteDeferredAck, :493 restartPollTimer, :1145 getDiscordChannelName, format.ts:517 STYLE_BOX_RE, :590 extractMachineUrls | keep
#264 | VALID | discord.ts still 2100 lines on main, one module, six concerns intact (REST client :99, gateway, SLASH_COMMANDS metadata, state Maps) | keep
#263 | VALID | mcp-tools collision guard still 4 builtins (extensions/mcp-tools.ts:182 `["bash","read","write","edit"]`); handover markdown scraping still there (handover.ts:1392 boardSummaryLine, :1436 liveInFlightLine); HOME variants still 5-way (index.ts:4727, undo.ts:56/625, worktree.ts:117, jarate.ts:44) | keep
#262 | STALE | fixed badceeac (PR #288, in main): single-sourced ticket-id regex + jrate_resolve_ticket + cgroup root in dispatch/lib.sh:11-111; HOLD condition LIFTED — #285 merged 2026-10-23 (5f2e5e0a) before #288 landed | close
#260 | VALID | dispatch/pi-restart absent from main (ls-tree: no dispatch/pi-restart); install.sh link list is only jarate-bg + pi-postcheck.sh (install.sh:157-160); pi-postcheck.sh:20 still references ~/scripts/pi-restart; fix pending in open PR #271 | keep (fix rides PR #271)
#259 | PARTIAL | #270 (3b02d43e, in main) dropped the keyword filter — isBgWebhook is now `webhook_id != null` only (discord.ts:589-590); remaining divergence: isBgCallbackBody [bg:/Author: pi-bg (todos.ts:267-268), isHumanInbound [bg: arm (handover.ts:654-665), WAKE_TAG "pi-bg restart-wake" (restart-wake.ts:155) — 3 content-classifiers still re-derive the marker | re-scope (raw-payload half done; narrow to the content-based classifiers)
#258 | STALE | fixed 42851c77 (PR #276, in main): channel/durable-store.ts exists with the shared lifecycle (atomic tmp+rename, orphan sweep, claim TTL); sleep.ts:36 + tasks.ts:40 import it | close
#257 | STALE | superseded by the drain: #286 (56d5781b) removed the /jobs kill|tail wrappers (jobs.ts:7-8 "removed with the completion side") AND the jarate-bg-kill/-tail scripts — the deprecation banner and the exit-127 risk both gone | close
#256 | PARTIAL | drift guard e9f2af6b (in main) pins SLASH_COMMANDS 1:1 to the switch (discord.test.ts:860-885 exact-ordered-list test); but the matchCommand text-path regex (index.ts, 23 hardcoded names) is still a 4th unpinned copy — no set-equality test vs SLASH_COMMANDS | re-scope (pin the text-path regex; 3 of 4 copies already guarded)
#255 | VALID | all 7 dead exports still present (handover.ts:118 LlmProse, :665 HANDOVER_SYSTEM_PROMPT, :684 buildLlmPrompt, :714 renderLlmSkeleton, :751 parseLlmProse, :848 renderTemplate, :1176 makeDefaultComplete); buildHandover (handover.ts:1247) still destructures only preparation/branchEntries/ctx/settings — instructions still swallowed (index.ts:3743) | keep
#245 | VALID | all 3 latent sites still present: index.ts:4806 `void maybeHandoffRestart(pi, ctx)`, :4653 `void (async () => {...})()` in scheduleOpShutdown, :3687 `setTimeout(() => drainQueuedAfterCompact(pi, ctx), 0)` — none guarded | keep
#243 | STALE | lane drained: jarate-bg launcher is a stub (rc 10, #272 293c0722), zero state=running records (#279), completion side removed (#286), watchdog gone (#290); the ZOMBIE fix (PR #246) is entirely in the now-deleted jarate-bg-watchdog; parked on operator call | close (operator call on PR #246: merge-as-history or close)
#236 | STALE | the marker producer jarate-wait was removed in #286 (56d5781b); index.ts:448-449 states it explicitly: "The #231 P3 in-turn-consumed marker drop is gone with jarate-wait, the only marker producer — #279 drain" — the hole closed with the mechanism | close
#235 | STALE | fixed 69c8720c (PR #238, in main): TimeoutStartSec=1800 (deploy/jarate-deploy.service:12) + SIGTERM record_fail (deploy/deploy.sh:217-222) + 3-fail backoff; #285 (5f2e5e0a) additionally moved the dispatch suite out of the gate (CI-only) | close
#231 | STALE | all four parts merged: P1+P4 in 33eaca6f (PR #234), P2+P3 in cc8612a4 (PR #233) — both in main | close
#225 | STALE | the dual-lookup /tmp tests are gone: dispatch/jarate-bg is a 290-line stub (grep: no "dual lookup"/LEGACY_TMP in jarate-bg.test.ts); the watchdog that read LEGACY_TMP was removed in #290 | close
#223 | STALE | bg_session_file/bg_arm_resume gone from the gutted jarate-bg stub (grep: no hits; the script is 290 lines vs the 1631+ cited) — the mtime race path no longer exists | close
#219 | STALE | bin/jarate-pat removed in 2b1ceb5a (2026-10-17, "hall-monitor owns it now"); bin/ has no pat-run surface left — the trailing-newline 401 class left with the client | close
#217 | STALE | the requested wake was implemented (91e93c61 #218 "wake agent on approval", a79088eb #221 "owner-tap wake (rewake on approve/deny/revoke)"), then the whole pat/vault surface was gutted to hall-monitor (1d0c2fb3, 2026-10-17) — requirement satisfied, surface relocated | close
#211 | STALE | fixed 51235f35 (PR #213 b87f9563, in main): interaction fixtures to live guild shape + URL contract tests; the vault test files were then gutted in 1d0c2fb3 | close
#210 | STALE | fixed fc394fc8 (in main): discordFetch has the `fullError` option (discord.ts:75, :105 cap 1000) used by the interaction endpoints (:1624, :1650) | close
#209 | STALE | pat-vault.ts (1713 L) + pat-vault.test.ts removed entirely in 1d0c2fb3 (2026-10-17) — full removal supersedes the deprecation ask | close
#208 | STALE | fixed 2a3f822c (via 8db58e23, in main: "quiet sweep"), then the code was gutted in 1d0c2fb3 | close
#207 | STALE | fixed fc394fc8 (in main): deferInteraction posts `body: { type: 5, flags: 64 }` with the `#207: ephemeral loading state` comment (discord.ts) | close
#206 | STALE | fixed 2a3f822c + e9f2af6b (in main: /vault in the 23-command registration), then the /vault slash command was gutted in 64edaa18 (2026-10-17, "dead /vault slash command") — hall-monitor owns approval now | close
#205 | STALE | fixed c01a689d (in main: "#205 default grant 30m time-box"), then the jarate-vault surface was gutted in 2b1ceb5a/1d0c2fb3 | close
#204 | STALE | fixed fc394fc8 (in main: "tap-outcome observability — every outcome visible + audited"), then the code was gutted in 1d0c2fb3 | close
#203 | STALE | fixed c01a689d (in main: "#203 pending has no default TTL (blocking; revoke kill switch)"), then the code was gutted in 1d0c2fb3 | close
#202 | STALE | fixed in the vault-wave (b87f9563 PR #213, in main: tap-path fixes V1-V7/D1-D6 83ad767c + member.user actor 7c2a989a), then both files gutted in 1d0c2fb3 | close
#200 | PARTIAL | livelock fixed: 69c8720c (#238: TimeoutStartSec=1800 + SIGTERM record_fail + backoff) + 5f2e5e0a (#285: dispatch suite out of the gate) + flock against overlapping ticks (deploy.sh:162-166); NOT implemented: fast-path state sync without full suite (proposal 1) and stagger (proposal 3 — timer still 30s OnUnitActiveSec) | re-scope (livelock part done; fast path is an optional improvement)
#197 | PARTIAL | F1/F2 (settle windows) still live: settleWorkingFrame persists before the REST settles (index.ts:3253-3255, `persistLivePlaceholders()` after `.catch(() => {})` fire) and shutdown clears before `await Promise.allSettled(shutdownDeletes)` (index.ts:3010-3012 vs :3027); the rc3-doc and (out)-test sub-items are stale — the launcher is a stub (rc 10, no empty-cgroup rc 3) and the watchdog's (out) marker left with #290 | re-scope (keep the two settle-window items; drop rc3 doc + (out) test)
#193 | VALID | the styleGuard machine-line splice is still forward-order (format.ts:722 `for (const u of urls) r = r.slice(0, u.start) + r.slice(u.end);`) while the hoistFencedUrls copy is reverse-order (format.ts:469-471, the #190 fix) — the 2nd-URL duplication bug is still there | keep
#191 | STALE | M1 (00d931ee, PR #196) + M2 (7a0f465e, PR #199) both in main; #290 (d1895d36) then centralised the M2 sweep to hall-monitor#59 — liveness paging now runs on the control plane, live markers stay (install.sh:165, dispatch/lib.sh:21) | close
#57 | STALE | open question answered: RCA 29c35c8e (root cause = pi 600s LLM_IDLE_TIMEOUT, not vLLM; issues/rca-57-silent-deaths.md + rca-57-class-b-degenerate.md); mitigations merged (61fd6893/62081cd3 silent-death retry1 + SILENT class, cd656193 degenerate rc=0); the pi-bg lane the deaths occurred in is retired (#272/#279/#286/#290) | close

## Open PRs (4)

#273 | PARTIAL | 4 merge conflicts vs main (packages/bridge/channel/index.ts, size-ratchet.json, issues/rca-57-class-b-degenerate.md); CI: bridge FAILURE (40s), biome/size/bin/test pass; still relevant — index.ts is 6955 lines on main, the 5-module split (commands 1295 L, live 478, queue 458, restart-ops 675, tools 457) is unlanded | rebase onto main + fix the bridge CI job
#271 | PARTIAL | 4 merge conflicts (install.sh, index.ts, jobs.ts); CI: all 5 checks pass; the /jobs kill|tail part is STALE (the wrappers + jarate-bg-kill/-tail were removed in #286, so the direct-call fix has nothing to point at) but the pi-restart tracking part (#260) is still needed (dispatch/pi-restart absent from main) | re-scope: drop the /jobs part, keep dispatch/pi-restart + install.sh link + tests
#246 | STALE | 2 merge conflicts, both modify/delete: dispatch/jarate-bg-watchdog + .test.ts deleted in #290 (d1895d36) while the PR modifies them; CI: test FAILURE (3m36s); the entire ZOMBIE-cap fix lives in the retired watchdog and the lane is drained (no runs to hang) | close (parked on operator call — merge-as-history or close)
#241 | VALID | 1 merge conflict (install.sh); CI: all checks pass (biome/bridge/bin/test); the bug is still live on main — install.sh:198 still runs `env -i PATH="$UNIT_PATH" command -v "$tool"` (Debian/Ubuntu: `command` is a builtin, lookup returns empty, install hard-fails); the PR predates the drain (its FAMILY_TOOLS lists 11 retired names) so the fix re-applies as a 1-line change to the current 2-name list | rebase (trivial) and merge

## Summary

Counts (issues): VALID 8 · PARTIAL 5 · STALE 26 · LIVE-STATE 0
Counts (PRs): still-relevant 2 (#241, #273) · partial 1 (#271) · stale 1 (#246)

Close candidates (26 issues, all fixed/superseded with the fix or the mechanism in main):
#284, #282, #281, #262, #258, #257, #243, #236, #235, #231, #225, #223,
#219, #217, #211, #210, #209, #208, #207, #206, #205, #204, #203, #202, #191, #57

Re-scope candidates (5): #266 (re-baseline after #273), #259 (narrow to
content-based classifiers), #256 (pin the text-path regex), #200 (fast path only),
#197 (settle windows only).

Keep (8): #291, #265, #264, #263, #260, #255, #245, #193.

No LIVE-STATE items: every claim settled against repo state on main; the only
operator-dependent item is PR #246 (merge-as-history vs close), which is a PR
call, not a live-system check.
