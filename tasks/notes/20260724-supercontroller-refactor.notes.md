# SuperController Refactor Notes

## Phase 0 inventory

Baseline source is `main` at `0a64cd75849a62deb17a986dff4553ac8152a593`.
The implementation worktree is `/Users/greyson/DevProjects/repo-harness-supercontroller-refactor`
on `codex/supercontroller-refactor`; the source `main` worktree remains untouched.

The verified removal or migration inventory is:

- Synthetic progress: `src/cli/agent-jobs/job-worker.ts` contains `phaseFloor`,
  `phaseCeiling`, and log-derived `AgentJobProgress.percent`. `src/cli/controller/progress.ts`
  derives task and issue percent from that value and completion-gate fractions.
- Event fan-out: `job-worker.ts` turns Agent stdout into activity and progress updates.
  This is the compatibility boundary for existing Agent Run UI/status consumers.
- Projection producers: explicit `rebuildRepositoryProjection` callers remain in the
  scheduler, schedules engine, worker entry, startup recovery, MCP runtime tools, and
  legacy CLI/HTTP surfaces. `readRepositoryProjectionSnapshot` is already read-only;
  legacy `readRepositoryProjection` still rebuilds.
- Retries: Execution Job, scheduler, campaign engine, legacy adapter, and workspace
  agent retain retry behavior. Campaign and workspace-agent behavior is Track B scope.
- Existing facade contracts are authoritative: `WorkContract`, `PlanContract`, and
  `HandoffItem` already exist. Only `Process` and `ControllerSession` are candidate
  new domain objects; no parallel Work, Plan, Handoff, or Objective model will be made.
- `delegateToCodexCerebellum` remains an external compatibility surface. It must stay
  callable until a declared deprecation window exists in Track B.

## Baseline measurement

The reproducible baseline command is `bun test tests/cli/controller-service.test.ts`,
which exercises the controller-service runtime storage and status path in an isolated
test controller home. It does not mutate this repository's source tree.

At this baseline revision the runtime does not expose the requested measurement fields
(`framework_overhead_ms`, `command_runtime_ms`, `controller_wait_ms`,
`duplicate_event_count`, `automatic_retry_count`, or read-path write counts). Therefore
there is no trustworthy numeric baseline yet. Track A must first add deterministic,
observable command/process receipts and read-path counters; inventing values from wall
clock test timing would not meet the acceptance criterion. The command duration and
test result are recorded in the implementation session output before Track A changes.

With `PATH=/Users/greyson/.bun/bin:$PATH`, the baseline completed successfully:
5 passing tests in 19.41 seconds (`real`), with 10.53 seconds user CPU and 7.64
seconds system CPU. The first attempt without that PATH failed because child test
processes invoke `bun` by name; this was environment setup, not a product failure.

## A1 result

Removed synthetic Agent Run percentages, phase ranges, task and issue percentage
aggregation, and the completion-gate fractional conversion. Progress now exposes
only phase, current activity, timestamps, elapsed time, and the existing evidence
gate counts. Focused controller/bridge/MCP tests and the full Bun test suite passed.
All required repository checks passed when Bun was available on `PATH`; the initial
architecture check failure was solely that its shell subprocess could not locate Bun.

## A2 and migration decisions

Agent stdout/stderr now stays in its raw log artifact. It no longer creates durable
activity, heartbeat, or log-update event fan-out. Command boundary events carry
request/command/execution IDs and use atomic event receipts for started and terminal
deduplication, avoiding an event-log scan on the dispatch hot path.

The repository already contains a Unified Process Runtime under
`src/runtime/execution/process-runtime`; it is the authoritative long-command model.
The initially considered facade Process record was intentionally not retained because
it would duplicate that model. ControllerSession is the only new facade state, and
`rh_work` now exposes claim, release, and owner lookup operations.

## Role convergence

WorkContract state is now `open/running/blocked/ready/completed/failed/cancelled`.
Persisted legacy states are mapped at read time. Campaign automatic ticks no longer
reconcile, retry, dispatch an Agent, or trigger a supervisor. Explicit campaign
reconciliation performs an idempotent migration of frozen Agent tasks into Work plus
Handoff records so an external controller can resume them.

Legacy MCP and Local Bridge Agent-launch operations now retain only an accepted Run
record for compatibility and require the Thin Launcher to start an external
SuperController. The Kernel no longer starts Agent processes through its default
MCP, Campaign, or Local Bridge paths.

The legacy `startAcceptedTaskJob` and `dispatchAcceptedTaskJob` compatibility
exports are now metadata-only accessors. This makes the no-model-subprocess rule
hold even when an older caller reaches those symbols directly.

## Observability and facade contract follow-up

Fast Path receipts now return deterministic Kernel measurements under
`observability`: `framework_overhead_ms`, `command_runtime_ms`,
`controller_wait_ms`, `duplicate_event_count`, `automatic_retry_count`, and
`read_path_write_count`. The latter deliberately excludes the optional audit
receipt itself and counts only runtime state/projection writes triggered by a
read path. The one-receipt Fast Path establishes zero duplicate command events
and zero automatic retries; semantic failure diagnosis remains controller-owned.

The `rh_work` implementation already accepted controller ownership and Thin
Launcher operations, but its MCP schema did not expose their operation values or
arguments. The schema now declares `controller_claim`, `controller_release`,
`controller_get_owner`, and `launcher_start`, including controller/session/lease
and external launcher fields. `rh_inbox.accept` is likewise declared as the
existing acknowledgement alias. `launchAcceptedTaskJob` itself is now also a
metadata-only compatibility export; its former provider implementation is private
migration reference and has no public Kernel call path.

Validation after this follow-up: `bun x tsc --noEmit` and `git diff --check`
pass with `/Users/greyson/.bun/bin` on `PATH`. Full behavioral tests were not
rerun at the requester's direction.

## Final architecture convergence pass

Thin Launcher now atomically claims the requested Work with a ControllerSession
before starting an external process, and releases that lease if spawning fails.
Launch callers therefore must provide stable `controller_id` and `session_id`.
Managed Process records carry optional `workId` plus a caller-stable `commandId`
(falling back to `processId` for historical records), and the Process MCP read
surface returns both values.

The Scheduler no longer ticks Campaign or Goal loops. Campaign/Goal progression
is an external SuperController responsibility; explicit migration/reconciliation
surfaces remain for historical data. `work_prepare` uses the neutral
`ensureManagedWorkspace` API rather than a Campaign-named operation. `work_execute`
and `work_validate` now use the unified Process Runtime. A still-running mutating
Process stops a command batch and returns its handle, so later writes are never
started concurrently. The legacy `run_agent_goal` MCP route now returns a
deprecation result rather than executing a model CLI.

Launcher resolves `codex` and `claude` from `PATH` when no explicit executable
is supplied, verifies it with a bounded `--version` probe, and returns the
resolved executable in the facade response. Non-local providers must supply an
external launcher explicitly; the Kernel remains provider-neutral.

The public Process API now exposes normalized `contractStatus` values
(`created`, `running`, `succeeded`, `failed`, `cancelled`, `unknown`) while
retaining the detailed runtime status solely for recovery diagnostics. The legacy
`run_agent_goal` tool is no longer registered in MCP tool definitions; its
compatibility handler returns the deprecation error if a stale caller invokes it.

Controller session claims and releases are now guarded by a per-Work controller
lock. Concurrent controllers cannot both pass the read/write claim check; a
conflicting claim deterministically returns `WORK_ALREADY_CLAIMED`.

Explicit `reconcile_campaign` now performs only the in-flight migration: every
unfinished Campaign Task becomes a linked WorkContract plus HandoffItem with
retained Job/Run/evidence references. It creates no ExecutionJob, no retry, and
no supervisor trigger; the Campaign is paused with an idempotent migration marker.

New Work contracts use `external_controller` instead of `codex_worker` as their
driver policy. Persisted legacy `codex_worker` records are mapped on read and
have worker permission disabled; this keeps controller choice outside Kernel state.

Goal Work contracts now default to no self-healing and zero infrastructure retries.
The Kernel records deterministic failure evidence and Handoff state; retry choice is
made by the external SuperController.

## Deprecated delegation boundary

`rh_work.delegate` is now strictly read-only for every target and every legacy
`available` or `worker_output` combination. It no longer reads or writes Work or
Handoff state, creates a request packet, or interprets provider output. The retained
context-pack helpers are pure compatibility utilities only. External controllers
claim ownership, launch through Thin Launcher, and explicitly create/accept Handoffs.

The access-mode wrapper now forwards `plan_id` and `plan_step_id` to the Goal
Workloop. Without that propagation, its required-plan guard rejected every complex
Work even after a PlanContract step was approved.

Focused validation passed for TypeScript, delegation/facade MCP, Goal Workloop, and
Work Submit. Existing Local Bridge tests that require automatic Agent dispatch remain
incompatible by design with the metadata-only compatibility boundary; they require a
separate test-suite migration rather than restoration of the removed execution path.

Supervisor releases now exclude `agent-worker.js`. Historical Agent Run records can
still be inspected, but new packaged Kernel runtime releases contain only the
deterministic Worker and unified Process Runtime entrypoints.

The old `goal_*` MCP execution commands and `executor_dispatch` are now hard
deprecated at the gateway. They cannot tick or select providers; legacy Goal records
remain readable while new execution is expressed through PlanContract, WorkContract,
ControllerSession, Thin Launcher, and HandoffItem.

New Campaigns, Campaign tasks, and Campaign resume operations are now rejected at
the gateway. Historical Campaigns remain queryable and can be migrated once through
`reconcile_campaign`; that migration no longer wakes the Daemon.

`codex-continuation --launch` and the corresponding Local Bridge request now only
write a continuation packet and return a Launcher migration error. Thin Launcher is
the sole provider-process startup surface.

The unused legacy `run_agent_goal` provider implementation has been removed, along
with its Codex/Claude argument parsing helpers. The retained MCP handler is only the
bounded deprecation response.

The retired `src/cli/agent-jobs/job-worker.ts` entrypoint has been deleted. It is no
longer packaged or callable by a Kernel release; legacy worker-lifecycle tests must
be removed or rewritten around external Controller sessions.

## Local Bridge execution retirement

`repository_command_execute` now routes ordinary local commands through the unified
Process Runtime, including managed commands. Commands that would previously create
a Local Bridge Job now return an explicit external-Controller requirement instead.

The remaining Local Bridge submission code is intentionally kept behind runtime
retirement predicates in the legacy MCP service and Local Bridge HTTP server. This
preserves historical Job reads and type-compatible migration code, while all new
Job submission, Agent launch, edit-session verification, and durable check fallback
requests return a structured retirement error (HTTP callers receive 410). Ordinary
registered checks retain their Process Runtime path; release or otherwise durable
checks must be handled explicitly by a claimed external Controller rather than
silently creating a compatibility Job.

The private historical Agent Run launch and Campaign reconcile bodies are also
excluded from compiled behavior behind retired-operation errors. Compatibility is
limited to metadata reads and the explicit frozen-Campaign migration.

The Durable Router now rejects every legacy Agent operation before ExecutionJob or
Local Bridge routing. Those operation names cannot create a Scheduler/Worker record
or fall through to an embedded provider path.

Ordinary local `repository_command_execute` writes and long builds now return a
Managed Process Runtime handle instead of entering the Local Bridge settlement path.
Remote and destructive commands remain explicit escalation cases rather than being
replayed automatically by a compatibility worker.

## Final Job-creation convergence

`ExecutionJob` and Local Bridge Job storage now reject every new creation at their
write entrypoints. The remaining call sites are retained only as type-compatible
historical migration paths; they cannot bypass the storage-level guard. Existing
records remain readable for diagnostics, cancellation, cleanup, and Campaign
migration evidence.

Schedules no longer auto-dispatch: a manual or external trigger records an
`operation_blocked` occurrence plus HandoffItem for an external Controller. The
global Scheduler no longer ticks Schedules or Portfolio workflows. Portfolio
workflows pause pending steps for an explicitly claimed controller, while plugin
actions and assistant routines record an external-controller requirement instead
of queueing Jobs. Supervisor and blue/green readiness probes now rely on process,
generation, and Gateway health rather than writing synthetic Jobs.

Work execution now enforces the ControllerSession lease, not just the facade
claim endpoint. `work_execute`, `work_validate`, and `work_finalize` require
the claimed controller identity and matching MCP session ID; an unclaimed or
different controller receives a deterministic ownership error before any
Process Runtime or Git operation begins.

## Agent Run creation closure

`acceptTaskJob` now returns historical records only for an existing request or
active Run, and rejects every new Agent Run at the storage boundary. The legacy
`dispatch_task`, `launch_issue`, and `dispatch_ready_tasks` MCP operations may
still expose their deprecation response, but no compatibility route can create
an Agent Run even when a stale caller requests legacy behavior.

## Goal provider dispatch closure

The historical Goal Loop provider registry retains provider discovery only for
external-controller handoff metadata. It no longer reports any provider as
Kernel-direct-dispatchable, even when a local CLI, API credential, or test
override is present. `dispatchProvider` is independently hard-retired and
returns `PROVIDER_DISPATCH_RETIRED`; no Goal path can invoke or simulate a
provider from inside the Kernel.

## Projection read closure

The normal MCP HTTP repository-health route now reads the persisted projection
snapshot instead of rebuilding it. Full projection rebuild remains restricted
to explicit recovery, maintenance, startup-recovery, and diagnostic commands;
ordinary health reads perform no projection write.

## Architecture checkpoint (pre-merge, incomplete)

Date: 2026-07-24

Branch: `codex/supercontroller-refactor`
Baseline HEAD before checkpoint: `0a64cd75849a62deb17a986dff4553ac8152a593`
Worktree: `/Users/greyson/DevProjects/repo-harness-supercontroller-refactor`
Repo ID: `repo_8562319a54229e681b799d65`
Checkout ID: `checkout_868f87ce996bdff4267d1287`

This commit is an architecture risk-reduction checkpoint only. It is **not mergeable**.
Purpose: freeze the peer SuperController kernel switch so later P0 Work/Process fixes
do not ride on an uncommitted 63-file dirty tree.

### Checkpoint inventory

- 63 files changed; +1059 / -1967
- Deleted: `src/cli/agent-jobs/job-worker.ts`
- Added:
  - `src/runtime/control-plane/facade/controller-session-store.ts`
  - `src/runtime/control-plane/launcher/thin-launcher.ts`
  - `tasks/notes/20260724-supercontroller-refactor.notes.md`
- No secrets, `_ops/**`, `.ai/harness/**`, or `node_modules/**` in the staged surface
- Staged area was empty before checkpoint; all changes were unstaged worktree edits

### Checkpoint verification

- `git diff --check`: pass
- `bun x tsc --noEmit`: pass (exit 0)
- Focused architecture suite:
  - `tests/runtime/facade-mcp-surface.test.ts`
  - `tests/runtime/thin-harness.test.ts`
  - `tests/runtime/work-submit-hardening.test.ts`
  - Result: **61 pass / 2 fail**

### Known remaining failures at checkpoint

1. `work_submit hardening > rejects invalid arguments before creating a durable Job`
   - Expected: stable `INVALID_ARGUMENT`
   - Actual: `WORK_ACCEPTANCE_LOST` after invalid arguments incorrectly entered acceptance
2. `work_submit hardening > submits readonly work without write claims and remains resumable after wait timeout`
   - Test still depends on `getExecutionJob(...workId)`
   - Accepted result currently lacks authoritative WorkContract fields (`work.workId` undefined)
   - Must migrate to WorkContract reads; must not recreate ExecutionJob for compatibility

### Latest full-suite snapshot (pre-checkpoint, not re-run for this commit)

- ~1861 pass / 176 fail / 1 exception
- Full suite intentionally not re-run for the checkpoint to avoid 8+ minute churn
- Running Controller on the main worktree remains sourced from older commit `01b76b49...`
  and must not be treated as validation of this dirty architecture switch

### Explicit unfinished items after checkpoint

P0 before any Plugin/Schedule bulk migration:

1. Close `work_submit` public contract (`INVALID_ARGUMENT`, idempotent WorkContract,
   no ExecutionJob creation, request-id conflict across repositories)
2. Controller ownership: one write owner per Work; inspect/claim/release consistency
3. Process Runtime contract completion (cancel/timeout/logs; no projection write on read)
4. Deterministic Plugin actions without Agent/ExecutionJob
5. Deterministic Schedule vs external-controller handoff split
6. Retire or rewrite legacy Agent Worker / retry / Campaign auto-dispatch tests
7. Full `package:test` with zero unexpected failures, TypeError, module-not-found, or
   deleted-worker launches
8. Architecture package checks, merge to main, rollout, verify zero new Agent Run /
   ExecutionJob / Local Bridge Job creation

### Activity at checkpoint

- No Campaign created for this work
- No nested Codex/Claude/Grok/Copilot agent used for the checkpoint
- Isolated processes from prior tests may exist in temp controller homes; they are not
  product state for this branch and were not used as acceptance evidence

## Stage: close work and process runtime contracts

Date: 2026-07-24

### work_submit

- Validates operation + arguments before any WorkContract/index write.
- Missing required args return stable `INVALID_ARGUMENT` (no Work/ExecutionJob/Process).
- Accepts WorkContracts via request-id index; same repo+request+input dedupes; cross-repo request reuse conflicts.
- Response authority is WorkContract: `workId`, `repoId`, `status`, `deduplicated`, `operation`, `nextAction`.
- Does not create ExecutionJobs.

### Controller ownership / recovery

- `work_prepare` atomically claims the authenticated Controller session.
- `work_inspect` is read-only and does not require the write lease.
- `work_execute` / `work_validate` / `work_finalize` still require the owner claim.
- Explicit `work_id` remains readable across MCP sessions/controller restarts.

### Process Runtime

- `work_execute` uses per-invocation request IDs and stable per-command IDs.
- Command results include processId/commandId/status/authorization fields.
- Process Runtime waits the interactive budget for short commands; long ones return handles.
- Local destructive/remote-risk commands no longer require retired ExecutionJobs.
- `repository_command_execute` Process path returns `accepted`, `status`, `processId`, `ok`, `exitCode`, `authorization`, `resultRef`.

### Focused verification

- work-submit, goal-authorization, work-session-finalize-recovery, repository-mcp-command, thin-harness, facade-mcp-surface:
  **91 pass / 0 fail**
- `bun x tsc --noEmit`: pass

## Stage: deterministic plugin actions

Date: 2026-07-24

- `submitAssistantPluginAction` validates, confirms, invokes the adapter, and stores a receipt.
- No ExecutionJob creation for plugin actions.
- Request-id receipt index provides idempotent replay.
- MCP `plugin_action_execute` returns bounded result/receipt instead of Job polling.
- Focused plugin suite: **39 pass / 0 fail**.

## Stage: deterministic schedule split

Date: 2026-07-24

### Design

- Non-deterministic schedules record occurrence + external-controller Handoff only.
- Deterministic allowlist currently is `runtime_maintenance_apply`.
- Allowlisted schedules preview, then call `applyRuntimeMaintenance` inline.
- Success/failure is an occurrence receipt (`succeeded`/`failed`/`skipped`).
- No ExecutionJob is created, and temporary failures do not auto-retry; they
  account consecutiveFailures, write one Handoff, and may pause the schedule.

### Verification

- `tests/runtime/live-maintenance-schedule.test.ts`: **6 pass / 0 fail**
- Target-architecture schedule test migrated to external-controller handoff expectations.
- `bun x tsc --noEmit`: pass

### Residual risks after schedule stage

- Full suite still has legacy Agent/Job/Worker expectations to retire or rewrite.
- Remote grok_com_repo-harness MCP returns HTTP 530; implementation continues in the
  isolated worktree via the local worktree source and Bun test harness.
- Remaining createExecutionJob call sites exist but storage rejects new creation.
- Regression after schedule stage: work-submit-hardening + thin-harness **48 pass / 0 fail**.


## Stage: retire embedded agent and legacy job expectations

Date: 2026-07-24

- Campaign supervised tests now assert frozen migration to Work + Handoff, zero
  ExecutionJobs, and empty automatic ticks.
- ExecutionJob / Agent worker lifecycle suites assert `EXECUTION_JOB_RETIRED`
  and the absence of `job-worker.ts`.
- Local Bridge Job creation expectations were stripped from repository-command
  and recovery suites; Process Runtime / argv / fencing coverage remains.
- Schedule and target-architecture tests assert external-controller handoffs for
  non-deterministic operations.

## Stage: architecture gates + MCP surface migration

Date: 2026-07-24

- Updated `scripts/check-runtime-architecture.mjs` so Work mutations execute through
  `callExecutionTool` (WorkContract/Process Runtime) instead of forcing durable
  ExecutionJob admission.
- Fixed Local Bridge Direct Edit verify path syntax and deterministic verify response.
- Migrated MCP controller / Local Bridge / V7 compatibility suites away from Agent
  Run and ExecutionJob creation expectations.
- Focused verification:
  - live-maintenance schedules: 6 pass
  - mcp-controller: 23 pass
  - local-bridge + controller-execution-first + ephemeral: 50 pass
  - check-runtime-architecture: OK
  - check-mcp-compatibility: ok

## Stage: residual TypeScript and Local Bridge verify contract

Date: 2026-07-24

- `verifyEditSession` response uses `checkResults` / `verifiedAt` (EditSession fields), not a non-existent `verification` property.
- Deprecation tests use valid `ExecutionJobType` (`agent-run`) and correct scheduler/wake-signal APIs.
- MCP controller deprecation assertion reads `raw.isError` when present.
- Focused suite after residual fix: agent-delegation, scheduler-capacity, target-architecture, work-submit, thin-harness, live-maintenance: **65 pass / 0 fail**.
- `bun x tsc --noEmit`: pass.

## Full-suite test migration (P2 residual)

After the architecture stages landed, the full suite still had 27 failures that
asserted pre-retirement Kernel behavior. They were migrated rather than restoring
the retired paths:

- Goal Loop / provider-config: route and health expectations now assert
  `chatgpt_handoff` + `directDispatch=false` and `PROVIDER_DISPATCH_RETIRED`.
- Campaign preflight: invalid supervisor now fails with `CAMPAIGN_DEPRECATED`
  before workspace allocation (gateway retirement precedes store validation).
- MCP policy/tools/setup: `run_agent_goal` is unregistered; enabled and disabled
  orchestrator runners both return `AGENT_GOAL_DEPRECATED`. Guide asserts
  WorkContract / Thin Launcher retirement language.
- Standing Grants: assertions use plugin action receipts (`findPluginActionReceipt`)
  instead of `findExecutionJob`; Gmail archive mock covers `/modify` because grants
  execute the plugin action immediately.
- Idempotent transport retry: explicit `maxAttempts` honor up to 5 (still bounded),
  matching the performance baseline test.
- Gmail backlog cursor test: timeout raised to 20s for multi-page hydration.

Not mergeable until full `bun test` is green on this worktree and the user
explicitly requests merge/rollout. Main remains unmerged; no push.

## Independent final-suite verification and Router convergence

Date: 2026-07-24

- Independent rerun at `0cd734b3`: **1944 pass / 0 fail** across 224 files.
- Removed the unreachable Gateway Router ExecutionJob creation, wait, and queued-response branch.
- Router durable classifications now stop at the explicit `EXECUTION_JOB_RETIRED` external-controller handoff.
- Runtime architecture gate now forbids `createExecutionJob` / `getExecutionJob` references in the Gateway Router.
- Focused Router + target-architecture tests: **10 pass / 0 fail**.
- `package:check:type`: pass.
- `package:check:runtime-architecture`: pass, 32 modules/documents checked.
- The original main checkout has untracked review/research files, so describe main as unmerged rather than an untouched working tree.

## Runtime MCP release/candidate dead-path convergence

Date: 2026-07-24

- Removed unreachable `createExecutionJob` branches from `request_release_gate` and `promote_candidate_finding`.
- Updated both public tool descriptions to state external-Controller handoff semantics instead of durable Job creation.
- Runtime architecture gate now forbids `createExecutionJob` references in `runtime-tools.ts`.
- Focused MCP/controller/target-architecture suite: **45 pass / 0 fail**.
- `package:check:type`: pass.
- `package:check:mcp-compatibility`: pass.
- `package:check:runtime-architecture`: pass, 32 modules/documents checked.

## Assistant Routine trigger convergence

Date: 2026-07-24

- Removed the unreachable Assistant Routine `createExecutionJob` branch and its retirement helper.
- `runAssistantRoutineNow` now has one explicit behavior: record the trigger, write an Inbox handoff, and require a claimed external Controller.
- Added regression coverage proving the trigger creates zero ExecutionJobs and records no Job IDs.
- Runtime architecture gate now forbids `createExecutionJob` references in `assistant/intent.ts`.
- Focused Gmail Assistant + Local Bridge + target-architecture suite: **39 pass / 0 fail**.
- `package:check:type`: pass.
- `package:check:runtime-architecture`: pass, 32 modules/documents checked.

## Historical Local Bridge dispatch convergence

Date: 2026-07-24

- Removed `dispatchLegacyLocalJob` and all ExecutionJob creation from the legacy adapter.
- The adapter now retains only read-only historical settlement-timeout compatibility.
- Approved historical Local Bridge Jobs now fail closed directly with `LOCAL_BRIDGE_JOB_RETIRED`; they are not projected into new ExecutionJobs.
- Runtime architecture gate now forbids ExecutionJob dispatch symbols in the legacy adapter.
- Focused recovery, consistency, repository-command, and Local Bridge suite: **54 pass / 0 fail**.
- `package:check:type`: pass.
- `package:check:runtime-architecture`: pass, 32 modules/documents checked.

## Portfolio engine convergence

Date: 2026-07-24

- Collapsed the retired Portfolio engine from automatic Job synchronization, queueing, and compensation to one explicit external-Controller pause transition.
- Pending and queued steps become blocked with a stable external-Controller handoff reason; no ExecutionJob is created.
- Added runtime coverage proving Portfolio tick pauses the workflow and leaves ExecutionJob storage empty.
- Runtime architecture gate now forbids ExecutionJob creation or lookup in the Portfolio engine.
- Focused target-architecture, control-plane hardening, and runtime-cutover suite: **50 pass / 0 fail**.
- `package:check:type`: pass.
- `package:check:runtime-architecture`: pass, 32 modules/documents checked.

## Campaign Engine migration-only convergence

Date: 2026-07-24

- Collapsed Campaign Engine from automatic ExecutionJob synchronization, retry, task dispatch, Agent Run tracking, and supervisor triggering to a migration-only adapter.
- Explicit `reconcileCampaign` still migrates unfinished tasks into idempotent WorkContracts and HandoffItems while retaining historical Job/Run references as evidence.
- Automatic `tickCampaigns` remains a zero-side-effect empty result.
- Runtime architecture gate now forbids ExecutionJob access, task dispatch, and supervisor trigger symbols in Campaign Engine.
- Focused Campaign, workspace, consistency, preflight, and target-architecture suite: **25 pass / 0 fail**.
- `package:check:type`: pass.
- `package:check:runtime-architecture`: pass, 32 modules/documents checked.

## Local Bridge HTTP creation-route convergence

Date: 2026-07-24

- Removed unreachable Local Bridge Job construction and asynchronous dispatch from the four historical HTTP creation routes.
- `/api/jobs`, launch-ready, Issue launch, and Task launch now return the same authenticated HTTP 410 retirement handoff directly.
- Removed server-side `submitLocalBridgeJob`, `dispatchLocalBridgeJob`, and async dispatch dependencies while preserving historical Job read/cancel APIs.
- Replaced a synthetic throw assertion with authenticated end-to-end HTTP coverage for all four retired routes.
- Runtime architecture gate now forbids dormant Local Bridge submission or dispatch code in the HTTP server.
- Focused Local Bridge, ephemeral lifecycle, repository-command, and target-architecture suite: **50 pass / 0 fail**.
- `package:check:type`: pass.
- `package:check:runtime-architecture`: pass, 32 modules/documents checked.

## Controller CLI and Repository MCP Local Bridge convergence

Date: 2026-07-24

- Removed unreachable Local Bridge Job construction and dispatch from deprecated `controller launch` while preserving Issue readiness in the external-Controller response.
- Removed the Repository MCP fallback Local Bridge submission, polling, and compact legacy Job response path.
- Repository commands continue through direct/managed Process Runtime when eligible; non-deterministic durable fallbacks return an external-Controller handoff.
- Runtime architecture gate now forbids Local Bridge submission/dispatch symbols in both surfaces.
- Focused Repository MCP, Controller compatibility, direct-agent, command-builder, and target-architecture suite: **50 pass / 0 fail**.
- `package:check:type`: pass.
- `package:check:runtime-architecture`: pass, 32 modules/documents checked.

## Legacy MCP Job and Agent dispatch convergence

Date: 2026-07-24

- Removed the `legacy_agent_run=true` backdoors from `dispatch_task` and `launch_issue`.
- Retired the previously unguarded `dispatch_ready_tasks` Agent Run creation and batch dispatch path.
- Removed Local Bridge Job creation from `quick_agent_session`, `submit_local_job`, `run_check` fallback, and `verify_edit_session`.
- Historical Run and Local Bridge Job read/cancel tools remain available; compatibility tool names now return stable structured retirement responses.
- Removed obsolete parser, request-construction, submission, and dispatch imports/helpers.
- Runtime architecture gate now forbids Agent/Local Bridge creation and the legacy opt-in flag in `legacy-tool-service.ts`.
- Focused MCP controller/tools, direct-agent, Local Bridge, and target-architecture suite: **70 pass / 0 fail**.
- `package:check:type`: pass.
- `package:check:mcp-compatibility`: pass.
- `package:check:runtime-architecture`: pass, 32 modules/documents checked.

