# Forge Cloud Windows Post-1.7.1 Handoff

> **Date**: 2026-08-30
> **Portable authority**: Git-tracked handoff for a fresh Forge Cloud Windows checkout
> **Published baseline**: `1ba073f5fa78dc69202f349afadab785f97d48f9`
> **Published version**: `v1.7.1` / `@moretea-labs/forge@1.7.1`
> **Execution policy**: all subsequent Forge source optimization runs in Forge Cloud Windows

## 1. Baseline That Must Not Be Rewritten

Forge 1.7.1 is already publicly released and independently verified:

- `origin/main` reached `1ba073f5fa78dc69202f349afadab785f97d48f9` at publication.
- immutable `v1.7.1` dereferences to the exact same commit.
- GitHub `Release package` succeeded using Trusted Publishing.
- npm `latest` is `1.7.1`.
- `package:check:release-published` passed with registry, dist-tag, tarball, Git tag, and version files agreeing.

Never move, recreate, force-push, or retarget `v1.7.1`. All fixes below advance `main` and, if release-worthy, become a later patch release.

## 2. Windows Cloud Bootstrap Contract

At the beginning of the next Forge Cloud Windows session:

1. Fetch `origin` and verify `main` is clean before mutation.
2. Verify the checked-out baseline is at least `1ba073f5fa78dc69202f349afadab785f97d48f9`; if `origin/main` is newer, inspect the intervening commits instead of resetting them away.
3. Register/use the Windows checkout through Forge Cloud and read `AGENTS.md` plus this handoff before creating Work.
4. Do **not** import macOS Controller SQLite state, leases, MCP sessions, browser sessions, worktrees, or release locks as authoritative Windows state.
5. Keep a single primary Forge optimization Work/lane. Create isolated Work only when Forge requires isolation; merge and clean it promptly.
6. Before changing a historical defect, reproduce it against current Windows `main` or prove from source/tests that it remains open.
7. Commit coherent verified slices and push `main` promptly after delivery.

## 3. P0 — Immediate Windows Tasks

### P0.1 Fix the real GitHub Windows smoke failure — completed

Observed on exact 1.7.1 publication commit in GitHub Actions Windows smoke:

- `tests/cli/install.test.ts`: passed.
- `tests/windows-paths.test.ts`: passed.
- almost all `tests/runtime/process-environment.test.ts`: passed.
- the only failure was `captures Scheduler worker stderr with a bounded persisted diagnostic`.
- failing assertion hard-codes POSIX suffix `worker-stderr/job-a-attempt-2.log`; Windows returns native backslash separators.

Required repair:

- make the assertion/path contract platform-correct (`path.join`, normalization, or segment/basename comparison as semantically appropriate);
- do not change production path behavior merely to satisfy the test;
- run the exact GitHub Windows smoke command locally on Windows:
  `bun test tests/cli/install.test.ts tests/runtime/process-environment.test.ts tests/windows-paths.test.ts`;
- require the GitHub Windows smoke workflow to become green after push.

Closure evidence from Forge Cloud Windows on 2026-08-30:

- delivered commit: `3572c78137e65e45857da3e5b8acde18d92548a7` (`test: make worker stderr path assertion portable`);
- source delta is test-only: the hard-coded POSIX suffix now uses existing `path.join`; production Scheduler stderr path behavior was not changed;
- WSL focused smoke: `34 pass / 0 fail` across the exact three requested test files;
- `package:check:task`: PASS after normalizing this checkout's inherited `umask 0002` working-tree permissions back to Git/index modes; generated authority verified 67 projections and all selected affected tests passed;
- native Windows execution exercised the exact three-file smoke command with Bun 1.4.0; the repaired `process-environment` Windows assertion passed. The local workstation also exposed unrelated default-5s Bun test scheduling contention in two CLI subprocess integration tests under the combined run; direct CLI timings remained ~0.65-0.70s, so no production behavior or unrelated timeout gate was weakened;
- GitHub Windows smoke run `33295425501` / #290 completed `success`: dependency install, PowerShell installer dry run, platform contract, installer/Windows policy tests, and Node portable smoke all passed;
- `origin/main` independently confirmed to contain the exact delivered commit and the main checkout was clean before advancing to P0.2.

### P0.2 Effect Work -> source delta terminalization authority

Durable handoff: `hnd-1788067200203`.

Live post-release reproduction:

- `work-publish-forge-1-7-1-from-exact-r-6cf1f181` began as `remote_effect`.
- it later acquired and delivered repository source delta, ending at exact commit `1ba073f5` on `main/origin`.
- npm/GitHub publication and `package:check:release-published` succeeded.
- normal finalize correctly failed closed with `WORK_EFFECT_REPOSITORY_DELIVERY_HANDLE_REQUIRED` because no physical WorkHandle existed.
- historical delivery reconciliation then failed with `DIRECT_EDIT_WORK_RECONCILIATION_WORK_NOT_ELIGIBLE` because that reconciliation only accepts Direct Edit Work.

Required architecture:

- keep one source-delivery authority; do not add a parallel completion store;
- ideally promote an effect-only Work to repository-change authority when the first governed source mutation is attempted, before source delta can exist without a WorkHandle;
- provide a narrowly reviewed compatibility/reconciliation path for already-delivered historical effect Work when exact target revision, complete compared paths, validation receipts, remote containment, and cleanup proof are available;
- never permit effect-only completion while unresolved source delta exists;
- add regression coverage for the exact release scenario and use the repaired path to close the historical Work without rewriting `v1.7.1`.

Windows source closure evidence:

- `35915d4bed240fd5e6d5221e11ef81d98a73cc9c` promotes effect Work to repository-change authority before the first governed source mutation and materializes the existing physical WorkHandle authority;
- the same slice extends the reviewed historical reconciliation path with exact revision/path, validation, branch/remote containment, cleanup, and unresolved-delta fencing instead of adding a second completion store;
- focused terminalization coverage, typecheck, `check:task`, and `check:main` passed;
- the historical macOS Controller Work still requires reconciliation on its original non-portable Controller authority and is not falsely reported closed from Windows.

### P0.3 Controller claim continuity across MCP transport rollover

Relevant pending handoffs:

- `hnd-1788053655071` — exact claim cannot survive real MCP transport rollover.
- `hnd-1788053631194` — finalizer rejects explicit claim after MCP session rotation.

Cross-conversation isolation must remain strict, but terminal lifecycle authority must not depend on an incidental short-lived MCP transport session.

Acceptance requirements:

- an explicitly claimed Work remains terminalizable by the same durable controller authority across a legitimate transport reconnect/Runtime handoff;
- another conversation/controller cannot stop/finalize it merely because the authenticated principal is the same;
- use existing controller id/type, principal, controller instance/round/claim generation authorities rather than creating a second opaque ownership system unless evidence proves the model is insufficient;
- add multi-session and cross-conversation regression tests plus a live Windows MCP rollover canary.

Windows source closure evidence:

- `810b69170d8a6c5a1bab28f61c04e1ebd4670c4c` admits only an authenticated explicit opaque Controller session when an incidental transport session is absent;
- `2cf73466e57959b7c1172635a173352b32a7c190` keeps that explicit Controller capability stable across per-call transport rotation while preserving distinct same-principal conversation scopes;
- focused tests cover transport rotation, concurrent same-principal conversations, stale generations, Runtime handoff fencing, and terminalization; the combined Runtime/route/systemd suite passed 81/81 before the final shutdown regression was added.

### P0.3a Linux/WSL package Runtime activation convergence

Live WSL reproduction proved that package activation advanced release authority while `systemctl enable --now` left an already-active old Runtime process running. The old process then failed every write fence with `release_authority_revision_fenced` until manually restarted.

The patch release repair:

- uses `daemon-reload -> enable -> restart` so both first install and in-place immutable-release activation converge on the newly written unit;
- keeps systemd as the sole lifecycle owner and does not add another watchdog or release authority;
- avoids forwarding a second shutdown signal when Linux systemd already signals the entire service cgroup, allowing the Canonical Runtime to complete its own signal-driven stop path;
- includes a real process-group SIGTERM regression plus a live package upgrade canary in which the active PID/release changed, readiness passed, and no writer-fence recurrence was observed.

Release closure:

- `v1.7.2` is an immutable annotated tag peeled to `c873cfeb11a223ced342e7101c016261b4a93b38`;
- GitHub Main gate, Windows smoke, and tag-only OIDC Release package workflows passed;
- npm `@moretea-labs/forge@1.7.2` is `latest`, and the GitHub Release is published (not draft or prerelease);
- `package:check:release-published` passed registry, dist-tag, tarball, tag, and local-version agreement.

### P0.4 Supported standalone Recovery self-upgrade/cutover authority

1.7.1 fixed Watchdog interference during Runtime staging, but publication exposed a bootstrap-control gap:

- standalone Recovery MCP owns Runtime/Connector lifecycle operations;
- it has no supported self-upgrade action;
- primary Runtime correctly refuses to execute `forge recovery install` as its child because that would violate lifecycle ownership.

Design an official, transactional Recovery upgrade path that can be initiated without bypassing ownership. It must:

- stage immutable Recovery binaries from an authorized source identity;
- canary them before cutover;
- fence Watchdog/Gateway mutation during activation;
- preserve rollback to the previous attested Recovery release;
- never require raw `launchctl`/manual process surgery as the normal automation path;
- have Windows-compatible architecture even if launchd-specific installation remains macOS implementation detail.

## 4. P1 — Control-Plane Convergence

### P1.1 Stable business-goal identity backed by Requirement authority

Move the previously deferred `goalKey` work into the active Windows lane.

- reuse/evolve Requirement as the durable business-goal authority rather than adding a new portfolio manager;
- explicit same `goalKey` across isolated Work must bind/reuse the same Requirement authority;
- `done`/`cancelled` Requirement must prevent stale continuation/scheduler logic from silently recreating the goal;
- reopening/new-goal semantics must be explicit and durable, never inferred by lexical similarity;
- distinct keys remain independent;
- preserve cross-conversation isolation.

Historical signal: `hnd-1788050979308` recorded unrelated Work being cancelled from another conversation before controller isolation repairs. Reproduce current behavior first; treat this handoff as evidence, not proof that current source is still broken.

### P1.2 Codex late-claim settlement race

Pending handoff: `hnd-1788048690395`.

Observed behavior: expected Codex Work claim arrived roughly 790 ms after nominal launcher claim timeout, after the scheduler had already persisted failure.

Required behavior:

- bounded post-deadline settlement grace on the same launch occurrence/reservation;
- preserve fencing and duplicate-spawn protection during grace;
- exact owner re-read at settlement end;
- matching late claim follows normal startup-stability confirmation;
- mismatch fails closed immediately;
- only a genuinely absent exact claim after grace becomes `LAUNCHER_CLAIM_TIMEOUT`.

### P1.3 Browser/external-controller continuation resilience

Triage these historical/pending items against current source before editing:

- `hnd-1787884069199` — successor release Work dispatch blocked.
- `hnd-1787883580872` — stale saved-tab identity recurrence.
- `schedule-failure-36ee7908ded1b69bfb6d` — browser load timeout.
- `schedule-failure-7f4ae6c9ba810cab13dc` — send selector missing.
- `schedule-failure-2927c0ef78bea839c909` — mutation outcome unknown; automatic replay correctly refused.
- `hnd-1788047879044` — browser human handoff host missing in active Runtime.
- `hnd-1788051669425` — stable Desktop Operator broker healthy, Chrome DOM verification blocked by JavaScript-from-Apple-Events permission.

Windows Cloud should repair platform-neutral continuation/session/packaging logic and add deterministic tests. macOS TCC/Chrome live acceptance stays deferred to the macOS host and must not be falsely closed from Windows.

## 5. P2 — Historical Handoff and Plan Reconciliation

The following are likely source-fixed or partly fixed historical defects, but are still pending because live closure evidence was never recorded. Do **not** blindly reimplement them:

- `hnd-1788049947131` — repository-change finalize emitted local_effect and deleted unmerged worktree.
- `hnd-1788049841239` — checkout mismatch diagnostic hid expected Work checkout.
- `hnd-1788047872747` — governed git-push receipt rejected for remote-effect completion.

For each item:

1. inspect current source and focused regression coverage;
2. reproduce only if necessary;
3. if fixed, run a Windows live/functional canary and resolve with exact evidence;
4. if still broken, promote it into P0/P1 with a fresh minimal reproduction.

Three old local PlanContracts predate the published 1.7.1 source and must be considered superseded rather than re-executed step-by-step:

- `PLAN-forge-work-checkout-routing-20260829-r3`
- `plan-architecture-simplification-release-20260829-r2`
- `PLAN-forge-pre-stable-whole-repo-convergence-20260829-r1`

The Windows tracked handoff is the new planning baseline.

## 6. Explicitly Out of Scope for Forge Source Optimization

Do not import or mutate these merely because they appear in the macOS Controller inbox:

- Devpost account/profile Work and related eligibility/auth handoffs;
- survey/microtask/revenue Work;
- historical logged-out ChatGPT account recovery, unless the user separately requests account/history recovery.

They are separate business/user workflows, not Forge source backlog.

## 7. Verification and Delivery Contract

For every source slice:

1. focused tests for the changed authority/bug;
2. `package:check:task` when a Work-bound source candidate is ready;
3. `package:check:main` before merging/pushing a control-plane or runtime change;
4. `package:check:mcp-compatibility` whenever MCP/facade/tool semantics may change;
5. Windows GitHub smoke must be green for Windows-sensitive changes;
6. `package:check:release` only at a real release boundary, not for every patch;
7. after verified integration, push `main` promptly and confirm remote containment;
8. clean temporary worktrees/branches after containment proof.

Do not claim a historical handoff closed from source inspection alone when its acceptance criterion requires deployed/live evidence.

## 8. First Windows Cloud Execution Sequence

Use this order unless new reproduction evidence changes priority:

1. fix P0.1 Windows smoke path assertion and push a green Windows CI result;
2. repair P0.2 effect-Work/source-delta terminalization, then close the stranded 1.7.1 release Work through the new legal path;
3. repair P0.3 controller claim continuity across MCP transport rollover;
4. implement P0.4 supported Recovery self-upgrade/cutover authority;
5. implement P1.1 Requirement-backed stable goal identity;
6. repair/prove P1.2 Codex late claim grace;
7. converge P1.3 browser/external-controller source behavior;
8. triage/resolve P2 historical handoffs and retire stale Plans;
9. run final whole-repo Windows/main gates and leave `origin/main` clean and synchronized.

## 9. Definition of Done for This Handoff

The post-1.7.1 optimization program is considered converged when:

- GitHub Windows smoke is green;
- no active Forge technical Work is stranded by lifecycle authority gaps;
- controller ownership survives legitimate transport rotation without cross-conversation leakage;
- Recovery can upgrade through a supported transactional authority path;
- stale continuations cannot revive terminal business goals;
- late launcher claims settle correctly;
- platform-neutral browser continuation is deterministic and fail-closed;
- historical source-fixed handoffs are resolved with evidence instead of remaining pending forever;
- obsolete Plans are superseded;
- `main` is clean, all temporary worktrees are cleaned, and every verified source delivery is on GitHub.
