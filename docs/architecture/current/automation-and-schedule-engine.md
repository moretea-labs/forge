# Automation and Schedule Engine

> Status: **Runtime Authority**

## 1. Objective

The Schedule Engine enables recurring discovery, repair, verification, reporting, and release-readiness workflows without creating an unbounded autonomous Agent.

The central rule is:

> A Schedule is policy. An Occurrence is one bounded execution window.

The system must be able to conclude that nothing should be done.

## 2. Non-Goals

The Schedule Engine is not:

- a forever-running Agent process;
- permission to bypass repository conflict rules;
- permission to create unlimited Issues;
- permission to auto-publish or deploy;
- a replacement for repository-owned CI;
- an excuse to retry external failures indefinitely;
- a global lock across selected repositories.

## 3. Schedule Entity

A Schedule stores:

```text
scheduleId
title
enabled
repositorySelector or portfolioSelector
trigger
workTemplate
triagePolicy
executionPolicy
budget
retryPolicy
backoffPolicy
notificationPolicy
stopConditions
createdBy
createdAt
updatedAt
```

### Trigger Types

Implemented trigger classes:

- fixed interval;
- cron/calendar expression;
- condition watch;
- repository event;
- dependency checkpoint;
- manual run-now.

Trigger delivery creates an Occurrence request. It does not directly start an Agent.

## 4. Occurrence Identity

One trigger window produces at most one Occurrence per repository.

```text
occurrenceKey = scheduleId + repoId + normalizedWindow
requestId = occurrenceKey
```

The normalized window is deterministic for the trigger type. Repeated delivery, reconnect, or scheduler restart returns the same Occurrence.

## 5. Occurrence State Machine

```text
created
  -> triaging
  -> nothing_to_do
  -> candidate_recorded
  -> waiting_for_resource
  -> work_dispatched
  -> verifying
  -> completed

created/triaging/waiting_for_resource/work_dispatched/verifying
  -> failed
  -> timed_out
  -> budget_exhausted
  -> human_attention_required
  -> external_blocker
  -> cancelled
```

An Occurrence reaches terminal state. A later trigger creates a new Occurrence rather than reviving the old one.

## 6. Trigger Processing

```text
1. receive trigger delivery
2. resolve selected repositories
3. deduplicate occurrence window
4. acquire short Schedule admission lock
5. persist Occurrence
6. submit repository-scoped triage command to Repo Actor
7. release admission lock
8. triage from compact snapshot
9. persist Decision
10. dispatch bounded Jobs or finish with no-op outcome
```

The trigger handler must return quickly and must not wait for implementation or checks.

## 7. Triage Before Execution

Every automated Occurrence begins with triage.

Triage inputs should be bounded:

```text
repository health
active Jobs and Runs
current Requirement/Work queue
recent failed checks
recent accepted work
Git summary and dirty ownership
release state
existing Candidate Findings
Schedule history and budget
```

Triage produces one normalized Decision:

```text
nothing_to_do
continue_existing_task
retry_infrastructure_failure
create_candidate_finding
promote_existing_finding
run_readonly_check
run_repair_task
release_ready
external_blocker
human_attention_required
```

The Decision and evidence are persisted before any write Job is dispatched.

## 8. Deterministic vs Agent Triage

Deterministic rules are preferred for:

- active conflict detection;
- known failed checks;
- stale/orphan reconciliation;
- duplicate Issue or Finding detection;
- budget and cooldown enforcement;
- release gate status;
- repository disabled/frozen state.

Semantic analysis remains external-controller-owned. Forge does not invent the next product or code decision inside the Schedule Engine. A Schedule may use the deterministic `external_controller_wake` action to resume an already bounded Work through Thin Launcher. The wake operation only transports the persisted Work/Handoff context to an external Controller; it does not interpret the model response inside the Kernel.

`external_controller_wake` accepts a `work_id`, `controller_type`, and optional launcher/session metadata. For ChatGPT, Thin Launcher prefers a saved Forge browser session (`browser_session_id`), then an explicit `https://chatgpt.com/...` conversation URL, then a new browser consult. Codex/Claude remain external CLI controllers. If the Work already has an active Controller lease, the Occurrence is a deterministic no-op rather than spawning a competing controller.

The stable ChatGPT tool surface manages this policy through `rh_work` rather than exposing another Schedule tool. `rh_work.schedule_create/list/get/pause/resume/trigger` binds only an existing non-terminal Work to `external_controller_wake`; callers cannot use the facade to schedule an arbitrary MCP or repository operation. Creation is idempotent by a stable schedule request identity, defaults to `shadow_mode=true`, limits active occurrences to one, and carries explicit failure/cooldown/daily-budget/backoff policy.

A Work continuation Schedule is acceptance-driven, not perpetual. Before every wake, Forge re-reads the bound Work. A missing Work pauses the Schedule; a terminal Work (`completed`, `cancelled`, or another terminal Work state) deterministically disables the Schedule and returns `nothing_to_do`. An active Controller lease also returns `nothing_to_do`. Therefore the recurring trigger is only a wake policy for unfinished bounded Work, never a forever-running agent.

Thin Launcher does not pre-claim Controller ownership. It records a short Controller-Home launch reservation (configured with `launch_reservation_ms`) only to fence duplicate spawns while the provider starts. The external provider must connect to Forge MCP and call `rh_work continue` with its authenticated transport identity; that authenticated principal/session becomes the Work owner. This separation prevents the scheduler from impersonating ChatGPT/Codex/Claude and preserves the Controller-session identity fence. Detached CLI providers also use their non-interactive execution contracts (`codex ... exec` and `claude --print`) instead of launching interactive TUIs with ignored stdio.

For Codex, Thin Launcher injects the currently ready Canonical Runtime MCP endpoint per invocation instead of mutating `~/.codex/config.toml`. The Runtime bearer token is passed only through the child environment (`FORGE_RUNTIME_MCP_TOKEN`); the temporary Codex MCP configuration references that environment variable and sends non-secret forwarded principal/session headers derived from the launch reservation. This makes a scheduled Codex self-contained while keeping authentication material out of argv, logs, and durable provider config. CLI providers without a safe Forge MCP bootstrap must fail closed rather than launch detached work that cannot report ownership/evidence back to Runtime.

## 9. Candidate Finding Governance

Automation does not immediately convert every observation into an Issue.

A Candidate Finding records:

```text
semanticKey
category
evidence
confidence
firstSeenAt
lastSeenAt
occurrenceCount
existingIssueIds
recommendedAction
status
```

Promotion policy may require one or more:

- reproducible failure;
- named check failure;
- explicit policy violation;
- repeated observation across multiple Occurrences;
- high-confidence static diagnosis with evidence;
- user-configured auto-promotion category;
- human approval.

Speculative “could be improved” observations remain candidates and deduplicate by semantic key.

## 10. Existing Work First

Before creating new work, triage checks:

1. Is an equivalent Issue active?
2. Is an equivalent Task ready, running, under review, or blocked?
3. Is an equivalent Job active?
4. Did a recent terminal attempt fail and require explicit retry?
5. Is the finding already resolved by the current Revision?
6. Is another Schedule responsible for the same semantic key?

Default priority is to continue or repair existing accepted work rather than create duplicates.

## 11. Budget Contract

Each Schedule defines bounded budgets, for example:

```text
maxActiveOccurrences
maxJobsPerOccurrence
maxAgentRunsPerOccurrence
maxRetriesPerOccurrence
maxWallClockPerOccurrence
maxDailyWallClock
maxDailyAgentRuns
maxChangedFiles
maxChangedLines
optional token/cost budget
```

Budget is reserved before dispatch and settled from actual usage.

Budget exhaustion is a valid terminal outcome. It may notify or defer to the next eligible window; it must not silently expand.

## 12. Concurrency Policy

Default:

```text
maxActiveOccurrences per schedule + repo = 1
```

If a trigger arrives while one is active:

- return the existing Occurrence;
- coalesce the trigger into a pending signal;
- or skip according to Schedule policy.

It must not create parallel duplicate loops.

Cross-repository Schedules create independent repository Occurrences and use Global Scheduler fairness.

## 13. Backoff and Cooldown

Retry policy distinguishes failure classes.

### Infrastructure failure

May retry with bounded exponential backoff:

```text
baseDelay * 2^attempt, capped by maxDelay
```

### Scope or resource conflict

Waits for resource or next eligibility; does not consume implementation retry count unless deadline expires.

### Implementation or acceptance failure

Creates or updates durable Task state and normally stops the Occurrence for review or a separately authorized retry.

### External blocker

Enters cooldown and notifies only when meaningful state changes or the configured reminder interval passes.

### Repeated no-op

May reduce frequency through quiet backoff when the Schedule repeatedly returns `nothing_to_do`.

## 14. Stop Conditions

A Schedule or Occurrence stops dispatching mutation work when any configured condition is true:

```text
release_ready
human_review_required
external_blocker
budget_exhausted
maximum_failures_reached
repository_disabled
release_freeze
user_paused
end_date or occurrence_count reached
```

A stop condition may disable the Schedule, pause it, or only terminate the current Occurrence according to policy.

## 15. Dirty Workspace Policy

Automation must not treat a dirty Workspace as disposable.

Before mutation:

- identify whether changes belong to an active Controller entity;
- preserve unrelated user changes;
- use a Worktree when isolation is safe;
- otherwise record `human_attention_required` or wait.

Automatic `git reset`, `git clean`, stash mutation, or overwrite is forbidden.

## 16. Release Freeze Policy

During Release Freeze:

- read-only triage may run;
- release checks may run;
- Candidate Findings may be recorded;
- new mutation Jobs are not dispatched;
- existing approved release workflow continues according to the release contract.

## 17. Notification Policy

Schedules should be quiet by default.

Notify on:

- material progress;
- new confirmed failure;
- external blocker requiring action;
- human review requirement;
- release readiness;
- budget exhaustion that changes expected outcome;
- newly promoted Requirement/Work.

Do not notify repeatedly for unchanged no-op or unchanged blocker state.

Every notification links to durable Occurrence, Job, Task, or Finding identities.

## 18. Shadow Mode

New mutation-capable Schedule policies should first run in Shadow Mode.

Shadow Mode:

- performs trigger, snapshot, triage, deduplication, budget, and policy decisions;
- records what Jobs it would have dispatched;
- does not create mutation Jobs;
- may run explicitly safe read-only checks;
- produces divergence and usefulness reports.

Recommended graduation evidence:

- sufficient number of Occurrences or time window;
- no critical unsafe dispatch decisions;
- acceptable duplicate and false-positive rate;
- useful human adoption of findings;
- bounded cost and latency;
- explicit user enablement.

## 19. Schedule Types

### Health and Availability Watch

Checks Controller/Gateway/Worker health and creates incidents only for confirmed changes.

### Repair Loop

Continues a known Issue through one bounded Task or retry per Occurrence until release-ready, blocked, or budget-exhausted.

### Bug Discovery

Runs deterministic scans and creates Candidate Findings. Promotion threshold should be strict.

### Dependency or Release Watch

Monitors an external condition and notifies or unlocks a Task when it changes.

### Report Schedule

Builds compact summaries without mutation.

Each type uses the same Occurrence and Job model rather than a custom forever loop.

## 20. Self-Improvement Limits

A Schedule may propose changes to its own policy only as a Candidate Finding or Governance Issue. It cannot silently:

- increase its budget;
- shorten its interval;
- broaden repository selection;
- broaden write scope;
- remove human stop conditions;
- enable destructive or remote actions;
- modify acceptance criteria to make itself pass.

## 21. Recovery

After Controller restart:

1. reload enabled Schedules;
2. rebuild active Occurrence index;
3. deduplicate due trigger windows;
4. reconcile active child Jobs;
5. terminalize expired or orphaned Occurrences when appropriate;
6. preserve completed Decisions and outcomes;
7. resume only from durable boundaries.

In-memory timers are delivery optimizations, not Schedule truth.

## 22. Audit and Metrics

Track:

```text
occurrences by outcome
no-op rate
candidate promotion rate
duplicate suppression
jobs and runs per occurrence
retry classifications
budget usage
mean wait and execution time
human adoption rate
false-positive or rollback rate
```

The purpose is to remove unhelpful automation, not merely prove it is active.

## 23. Current Implementation

The runtime implements first-class `RepositorySchedule`, `ScheduleDecision` and `ScheduleOccurrence` records under `src/runtime/workflow/schedules/`. Supported triggers are interval, manual, five-field UTC cron, one-shot calendar timestamp, condition watch, repository event and dependency checkpoint.

Every due trigger uses a deterministic window or event identity. The Decision is persisted before executable work is admitted. Occurrences are indexed, Shadow Mode defaults on, one Occurrence creates at most one durable Job, and repeated trigger delivery returns the existing Occurrence.

Budgets, cooldown, maximum active Occurrences, consecutive-failure circuit breaking and exponential backoff are persisted. Dirty Workspaces, release barriers, repository disablement, human-attention state and recent external/infrastructure failures suppress unattended writes. Candidate Findings deduplicate observations and require explicit human promotion before Issue creation.

The in-process Scheduler owned by the Canonical Runtime ticks timer/condition/dependency triggers and resumes from durable state after a whole-Runtime restart. Repository events and manual triggers enter through the same idempotent path. Worker and Reconciler settlement keep Job, Occurrence and Schedule failure state consistent.

## 24. Safety Boundary

Schedules may perform bounded repository work but cannot push, merge, publish, deploy, close remote Issues, remove repositories, or run arbitrary repository commands. The policy is checked at creation and again in the Worker.

## 25. Rollout Rule

New mutation Schedules begin in Shadow Mode until their decisions are reviewed. This is an operational rollout rule, not an implementation gap.

### Deferred activation across a natural Runtime restart

A continuation Schedule may be deliberately created with `shadowMode=true` while the currently running immutable Runtime predates the Controller-wake implementation required by that Schedule. Forge can persist a one-time pending continuation activation marker in Controller Home. Old Runtime releases do not read this marker. The first naturally restarted Runtime containing the pending-activation implementation consumes the marker before starting its sole Scheduler, verifies that the Schedule is still enabled and still targets the same `external_controller_wake` Work, flips only `shadowMode` to `false`, and removes the marker. If the Schedule was explicitly disabled in the meantime, the marker is cancelled instead. This preserves one Scheduler authority and avoids introducing a second cron/LaunchAgent or forcing a rollout solely to enable continuation.
