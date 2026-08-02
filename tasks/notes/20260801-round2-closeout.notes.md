# Round-two controller hot-path closeout (2026-08-01)

Branched from `codex/round2-supervisor-recovery` (58749d108) into
`codex/round2-closeout`; merges the working-tree thin-harness work with the
branch's rich projection/SWR implementation and closes P0-P5 findings.

## Scope decisions

- Base = branch `58749d108` (rich `controller-context.ts` with variant/source
  identity/refresh-state machine, phase-timed `controller_context`,
  session-cache lifecycle, idle repository scan throttling).
- Working-tree thin-harness changes applied on top: core/advanced/full toolset
  tiers, `unsupported_in_core` routing, search inventory cache, git identity
  cache, process streaming + bounded-child check bridge, scheduler
  active-jobs-aware fallback poll, issue/plugin invalidation wiring.
- The working-tree simplified `controller-context.ts` (no variant separation,
  silent refresh failure, `.git/index` mtime in source revision) was discarded
  in favor of the branch's rich implementation + fixes.

## P0 runtime identity

- `runtimeIdentitySnapshot(ctx)` in `runtime-tools.ts`: releaseId (release dir
  basename), runtimeCommit (runtime generation source commit), buildCommit
  (supervisor releaseRevision), startedAt, controllerInstanceId, toolset,
  profile, activeSlot, previousKnownGood (previous slot release), generation.
- Exposed on `/health` (`runtimeIdentity`), `controller_ready`
  (full + compact summary), `runtime_performance_diagnostics`.
- Readiness tool surface counts: uncomputed exposure reports `null` +
  `toolSurfaceState: 'unknown'` instead of a fabricated 0/0.

## P1 identity/routing hot path

- Root cause of the 114-126ms identity phase: per-call git subprocesses
  (`gitSnapshot` 4 + `computeWorkingTreeFingerprint` 3) before the cache read.
- `cachedGitIdentity(repoRoot)` in `inspector.ts`: samples HEAD/branch/
  working-tree fingerprint from the same moment, once per 3s TTL per repo
  (content-based fingerprint is stable across reads; real mutations
  invalidate through markers). Hot reads now run zero git subprocesses.
- Phase timings in `responseMeta.phaseTimingsMs`: repositoryRouting,
  gitIdentity, invalidation, cacheRead, refreshQueue, build, serialize.
- Caches bounded: gitIdentityCache/gitSnapshotCache (128), static exposure
  cache (64), refresh generation ledger (1024 + per-flight cleanup).

## P2 projection freshness

- TTL raised 5s -> 300s default (`REPO_HARNESS_CONTEXT_PROJECTION_REFRESH_MS`);
  freshness is event-driven: source identity (repo/checkout/head/fingerprint/
  variant/toolset/profile), view revision, invalidation marker nonce.
- Materialized-view `stale` flag is reported, not acted on (daemon-down view
  staleness no longer forces endless context rebuilds) -> consecutive reads
  stay fresh; benchmark cache-hit rate 100%, hot P50 ~0.3ms.
- `markControllerContextProjectionDirty` wired into issue writes and plugin
  sync; `invalidationNonce` persisted with the record and compared per read.
- Refresh success atomically updates generatedAt/sourceRevision/
  contentFingerprint/invalidationNonce/refreshState/lastSuccessfulBuildAt;
  failure records lastRefreshError + exponential backoff (retry_deferred);
  stale-owner recovery clears permanent `refreshing` after restart.
- Superseded generations never publish (generation ledger with safe fallback);
  same base-key concurrent flights publish at most once.
- Keyed projection files pruned on write (same repo/checkout/variant), so HEAD
  changes no longer accumulate disk files.

## P3 summary

- Strict compact summary (~7.5KB vs 32KB): repository, focus, health,
  attention (5), readyTasks (5), execution, runtime, detailPointers, plugins
  counts, checks counts, git (branch/head/dirty/changedFileCount).
- Removed from default: full checks, plugin actions, recent jobs, history
  incidents >3, taskLedger issues/readyTasks/recentEvents/suggestedNextActions,
  operationalPlan diffProjection/taskRecovery, git status/diffStat text.
- Detail unchanged (full live payload). `currentIssueId` retained as deprecated
  compatibility; `contextProjection` carries projection freshness fields.

## P4 toolset

- core=17 (model-facing), advanced=133 (stable typed), full=262 (exhaustive);
  counts are real and verified by tests.
- `unsupported_in_core` includes missingCapability, currentToolset,
  suggestedProfile, facadeCanComplete; capability classification order fixed.
- Old tests asserting core==advanced were updated to the intended tiers.

## P5 cleanup

- Release bundle: supervised-check bridge resolves through the release
  manifest's sourceRoot (bundled `import.meta.dir` no longer reaches
  `scripts/run-supervised-command.ts`).
- Process runtime: streaming replaces 100ms disk polling; `logPollerCount`
  semantics updated; `processRuntimeResourceDiagnostics` restored.
- bluegreen level-2 test adapted to the authoritative-repoRoot release policy
  (release source must resolve to the controller's repoRoot).
- New env vars (documented here): REPO_HARNESS_CONTEXT_PROJECTION_REFRESH_MS,
  REPO_HARNESS_GIT_IDENTITY_SAMPLE_TTL_MS.

## Verification

- `bun x tsc --noEmit` clean; full suite 2260 pass / 0 fail (3 runs);
  runtime-architecture, mcp-compatibility, controller-v8, deploy-sql,
  architecture-sync, task-sync, task-workflow, release-readiness,
  check:release all green; both hot-path benchmarks run.

## Known deferred items

- Formal performance acceptance (p50/p95 gates) is a follow-up session per the
  task contract; this session only verified correctness + the measured
  structural improvements (hot P50 0.31ms, summary 7.5KB, cache 100%).
- Recovery entry point fixes were out of scope and remain tracked as a later
  item; the switch must not break existing recovery config.
- Check-config changes (user-authored `checks.json`) have no programmatic write
  path; they invalidate through the bounded TTL fallback.
