# Controller reliability and automation runbook

Use this runbook when forge processes are running but tasks do not move, the UI reports readiness that does not match actual execution, or one repository affects another repository's controller resources.

## Interpret readiness in layers

Do not treat a single `ready` value as proof that autonomous delivery is active.

| Layer | What it proves | Typical evidence |
| --- | --- | --- |
| Runtime readiness | The complete Canonical Runtime passed release coherence, SQLite, in-process Scheduler, and authenticated MCP end-to-end checks. | `controller_ready.ready` plus diagnostic reason codes |
| Execution readiness | A suitable executor is authenticated, enabled, and able to start bounded work. | executor preflight and recent run classification |
| Delivery readiness | The task can be integrated, verified, accepted, and committed without unresolved repository conflicts. | clean selected paths, checks, integration evidence |
| Automation readiness | At least one enabled **live** schedule or live goal can create execution work. | schedule policy, occurrence status, budget and cooldown |

A shadow schedule is observation-only. It may emit `would_execute` or `shadowed`, but it does not queue or start an Execution Job. A configured provider is also not proof that work is currently running.

## First response sequence

1. Read `controller_ready` and note reason codes, source coherence, queue depth, running workers, active leases, current attention, and plugin summary.
2. Run `capability_recovery_probe` (and `capability_recovery_plan` when needed) to classify the blocker without mutating state.
3. If runtime metadata or projection state is degraded, inspect `runtime_maintenance_status` before requesting any external lifecycle action.
4. Apply `runtime_maintenance_apply` only for a reviewed bounded metadata candidate. It may reconcile local jobs or rebuild projections; it must not perform Runtime lifecycle changes or source-code repair.
5. Re-run `controller_ready` and `rh_status`, then retry the original operation with the same intent. If source coherence is blocked, follow the external lifecycle handoff for the existing single `forge-runtime`; do not attempt an in-process restart, component restart, second Runtime, or rollout.

## Schedule diagnosis

Use `list_schedules` with occurrences enabled and classify each enabled schedule:

- **shadow**: `policy.shadowMode` is true; no execution should be expected.
- **live but idle**: live schedule exists, but no occurrence is `created`, `queued`, or `running`.
- **live and active**: a live schedule has an occurrence in one of those active states.
- **blocked by policy**: occurrence is suppressed by cooldown, failure threshold, daily budget, dependency, or stop condition.

Do not turn every schedule live. Health snapshots and cleanup previews should normally remain shadow/read-only. Enable live execution only for a bounded action with explicit budget, cooldown, failure limit, and stop conditions.

## Failed-run classification

Classify the last failure before retrying:

- `auth_required`: authenticate the named executor or plugin; do not retry in a loop.
- `usage_limit` or provider capacity: select an allowed fallback or wait for the provider boundary to clear.
- interactive stdin / startup timeout: fail fast and relaunch with a non-interactive invocation.
- canonical Runtime process disappeared: reconcile the run as `unknown`, then inspect Runtime ownership and standalone Recovery evidence before retrying.
- patch precondition failed: refresh file fingerprints and reapply only selected paths. Never overwrite unrelated dirty work.
- check failure: separate failures introduced by the current diff from known baseline failures and retain both evidence sets.

A stale health label must not override live run evidence. A run that is producing heartbeats, edits, and test output is active even if an old executor snapshot still says `auth_required`; fix the stale status projection rather than discarding the run.

## Multi-repository resource isolation

High CPU must be attributed to a repository before action. Record the process command, repository root, PID, CPU, and owner controller. A busy MCP process from another repository is a peer-repository incident, not proof that the current repository is unhealthy.

Recommended policy:

- one controller-home repository namespace per registered repository;
- repository-scoped leases, schedules, local jobs, and cleanup candidates;
- per-repository CPU/memory diagnostics and watchdog thresholds;
- no cross-repository process termination from a repository-scoped repair action;
- explicit operator authorization before terminating a peer repository process.

## Whole-Runtime restart and reconnect contract

`CanonicalForgeRuntime` is the only core lifecycle owner. Repository tools, MCP handlers, Workers, Local Bridge, diagnostics, and tunnels cannot start, stop, restart, adopt, roll out, or roll back a core component. The repository no longer contains Supervisor, KeepAlive, restart-coordinator, or component lifecycle shell entrypoints.

A release change is performed only as an explicitly authorized whole-Runtime operation:

1. validate one immutable release manifest, configuration, database compatibility range, and Worker protocol;
2. quiesce admission and stop the complete Runtime;
3. atomically select the candidate as the one active whole release;
4. let the single Forge Runtime service start `forge-runtime` from that complete release;
5. require binary whole-Runtime readiness;
6. on failure, stop the service, restore the previous release and its bound local SQLite backup, then start and verify the complete previous Runtime.

There is no blue-green pair, fixed alternate port, slot adoption, mixed-generation traffic, or component rollback. Release safety comes from pre-activation canaries, immutable artifacts, one atomic active/previous authority, whole-Runtime readiness, and previous-release recovery.

A whole-Runtime restart closes in-flight MCP sockets. Continuity comes from durable request, Work, Job, and evidence identifiers, not from a traffic router or component adoption. Retry the same idempotent request after the endpoint is healthy and continue reading the existing durable state. Recreate or rescan the ChatGPT Connector only after an authentication/schema change or an explicit connector-staleness result.

The standalone Recovery watchdog uses the same service and release contracts. It first attempts a bounded whole-Runtime service restart. After the configured attempts are exhausted, it permits automatic previous-release recovery only with sustained independent failure evidence and an attested previous release. One Recovery lock prevents concurrent restart or rollback storms.

After a restart or automatic recovery, confirm:

1. `controller_ready.ready` is true and all diagnostic evidence belongs to the same Runtime instance and release.
2. `controller_capabilities` reports the expected tool fingerprint.
3. The public `/health` and OAuth protected-resource endpoint return valid responses.
4. Previously accepted Work/Job identifiers remain readable and no mutation was blindly replayed.
5. No old Worker can renew Leases or commit results under the new Runtime/release fence.

## Cleanup

Run cleanup as preview-first work:

1. Inspect `runtime_cleanup` or the cleanup preview from performance diagnostics.
2. Select only forge-owned, repo-scoped candidates.
3. Exclude active worktrees, active local jobs, pending approvals, and processes whose ownership is uncertain.
4. Apply `runtime_cleanup_apply` with an age threshold and bounded candidate count.
5. Confirm that the repository projection and active work remain intact.

Temporary directories should have a TTL, but age alone is not sufficient: current leases and worktree registration remain authoritative.

## Plugin degraded states

Distinguish lifecycle from action readiness:

- `enabled + ready`: configured actions can run, subject to confirmation policy.
- `enabled + degraded`: plugin is selected but missing auth, permission, or provider availability.
- `disabled`: not part of the current capability set.
- `ready but not applicable`: tooling exists, but the repository has no matching project or artifact.

For Google Workspace plugins, resolve the specific credential source and required scope. Do not report the whole controller as delivery-ready when a task requires a degraded plugin.

## Board governance

A healthy runtime can still have an unhealthy delivery board. Regularly:

- select one current focus when focus is required;
- review completed tasks and accept verified work;
- retry or explicitly unblock failed attempts;
- archive terminal issues after evidence is retained;
- keep generated runtime metadata out of long-lived source diffs;
- clean merged worktrees and delete merged branches.

Do not create more automation work while review, acceptance, and failed-run queues are growing unchecked.

## Exit criteria

Reliability work is complete only when:

- runtime and projection report a coherent state;
- automation reporting distinguishes shadow, live-idle, and live-active states;
- targeted checks pass or remaining baseline failures are explicitly documented;
- selected-path changes are committed without absorbing unrelated work;
- the feature branch is merged and its worktree is removed;
- no destructive cleanup or peer-repository process action occurred without authorization.
