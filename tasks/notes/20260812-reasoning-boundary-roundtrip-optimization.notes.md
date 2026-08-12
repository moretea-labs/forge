# Reasoning-Boundary / MCP Round-Trip Optimization

> **Status**: Implemented on isolated branch; canonical integration blocked by unrelated main-worktree conflict
> **Date**: 2026-08-12
> **Branch**: `perf/reasoning-boundary-20260812`

## Design principle

Forge should use one MCP call for one continuous deterministic phase that does not require a new ChatGPT semantic decision. ChatGPT remains the semantic reasoning authority; Forge owns bounded retrieval, deterministic execution, policy, revision identity, evidence, Process state, and recovery.

Reducing MCP round trips must not reduce output quality. In particular:

- Implementation retrieval returns current raw evidence but never claims the returned files are the complete semantic impact surface.
- Plan/Debug/Review may deliberately expand evidence.
- Cross-cutting impact dimensions are selected by ChatGPT and mechanically expanded by Forge in the same retrieval call.
- Intermediate edits do not automatically run expensive tests.
- Focused validation belongs after a coherent edit batch is stable; expensive full-suite checks belong at candidate/release or explicitly high-risk boundaries.
- Long checks run as revision-bound managed Processes. Independent read/review work may continue; the caller joins once when the check result becomes a real dependency.

## Implemented commits

- `49446f42` — `perf(runtime): reduce reasoning-boundary round trips`
  - mode-aware `rh_context` contract; implementation raw snippets no longer force a second read
  - semantic sufficiency authority explicitly belongs to ChatGPT
  - Scheduler background reconciliation for already-launched long Work validation Processes
  - SQLite validating-Work index prevents periodic historical Work scans
- `99a6127f` — `perf(mcp): return edit review evidence inline`
  - `repository_safe_patch_apply` returns bounded exact EditSession diff evidence inline
  - removes mandatory edit -> diff/status round trip
- `bfdc90da` — `perf(mcp): compose direct edit validation`
  - optional `check_ids` on Direct Edit; omitted during intermediate edits
  - resource-aware independent check lanes execute concurrently
  - long checks return managed Process handles instead of blocking MCP
  - `validation_only` joins existing validation without replaying the patch
- `8655b8d3` — `perf(context): expand explicit impact domains`
  - GPT-selected `persistence/scheduler/notification/timeline/events/cache/api/concurrency` evidence dimensions
  - one bounded retrieval pass returns impact coverage and explicit missing/omitted-domain signals
  - Forge does not infer business-semantic completeness

## Verification evidence

- Context/CodeGraph focused tests: 13 pass, including GPT-selected impact-domain coverage/gap behavior.
- MCP controller/schema tests: 38 pass, 0 fail, stable default tool surface preserved.
- Direct Edit managed-validation E2E: pass; proves edit -> managed validation -> validation-only join does not replay source mutation.
- Repository safe-patch focused tests: 22 pass.
- Work validation/reconciliation + runtime cleanup focused tests: 25 pass.
- Runtime architecture gate: `OK (46 required modules/documents checked)`.
- `git diff --check` passed for each committed batch.
- Filtered TypeScript output showed no errors in changed files. Full-repo `tsc` remains unusable in this isolated worktree because the reused dependency baseline lacks current React/JSX typings.

## Known baseline / unrelated blockers

- `test-governance affected` currently stops before affected tests because the repository baseline has an unregistered `tests/runtime/handoff-inbox-authority.test.ts` and exceeds the existing `maxTestLines` budget (`43019 > 42706`). This branch did not inflate the budget to hide that debt.
- The full Thin Harness gateway test file has one existing load-sensitive oversized diagnostic assertion: it assumes a read-only diagnostic always completes inside the interactive window before asserting `result.available=true`. The new Direct Edit validation E2E passes in the same file.
- The canonical `main` worktree currently has unrelated concurrent changes and an unresolved `THIRD_PARTY_NOTICES.md` conflict, so this branch cannot be safely fast-forwarded or cleaned yet.

## Residual optimization opportunities

1. **Conflict-lane background continuation**: independent checks already launch concurrently, but later checks in the same conflicting resource lane currently advance on a later join. A durable validation-batch queue/coordinator could continue that lane without ChatGPT, but should not be added until ownership and idempotency are explicit.
2. **Workloop transition collapse**: `verify -> continue -> finalize` still contains deterministic state transitions. Do not collapse semantic review or delivery authorization; only eliminate transitions that cannot change a ChatGPT decision.
3. **Standalone long-check joins**: `run_check` now instructs callers not to poll repeatedly; a single join remains necessary when the result becomes a real dependency.
4. **Live runtime activation**: current conversation remains bound to the previous Runtime schema. New facade fields must appear through the normal Runtime update path; no rollout was performed for this work.
