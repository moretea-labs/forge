# Thin semantic working context and revision authority

Status: accepted architecture; canonical cutover is implemented in current source with final verification pending. Frozen-client compatibility projections remain where required.

## Decision

Forge exposes only three cross-domain model-authored semantic records: Requirement, Plan, and optional Work. Requirement is stable intent, Plan is model-authored strategy/decisions/progress, and Work is an independently resumable semantic unit. Workflow, Schedule, Connection/Grant, Process, ControllerRound, repository state, and domain handles remain operational, security, execution, or domain facts rather than additional working-memory authorities.

Each semantic record has one stable identity, one portable semantic scope and one monotonic semantic revision. ForgeInstance is the root authority; repository/checkout identity is execution placement or optional domain context, never synthetic semantic ownership. Model-facing writes use expected-revision compare-and-swap. A stale write fails with the current semantic record/revision and never silently merges. The append-only requirement_revision, plan_semantic_revision, and work_semantic_revision records are immutable history evidence, not independently mutable authorities; Controller storage revisions remain internal persistence concurrency metadata.

Plan semanticContext is the model-facing semantic authority once present. Legacy PlanContract goal/step/lifecycle fields remain migration/execution compatibility data and cannot implicitly rewrite semanticContext. Requirement/source basis revisions are provenance and staleness hints only. Source movement is observed at concrete mutation boundaries and does not make Plan working memory an execution gate. Thin Plan `scopeKey` is descriptive discovery/lineage metadata only, never an ownership mutex; current model-facing replanning revises the same stable Plan id rather than superseding it.

New Work records materialize semanticState from creation. Mechanical Work status, phase, verification, review, delivery, cleanup, provider, recovery, and completion receipts do not rewrite semanticState. Pre-semantic legacy Work may infer an initial semantic state from its historical terminal status until its first semantic revision; that revision materializes the state and ends the fallback. Work resultRefs are model/user-selected references only. Mechanical completion and check receipts are exposed separately.

ResumeContext is a derived read bundle assembled on demand from the latest relevant semantic records plus current source/resource facts, unresolved human requests, active durable handles, and pertinent receipts. It is never persisted as a fourth aggregate, and conversation text or projection caches are never authority.

## Concurrency and migration boundary

Semantic CAS protects authored context. Git/worktree, Process/resource leases, authorization grants, effect identities, and other concrete fences protect the resources they actually own. Verification is Work-bound evidence and is never gated by a Work-wide ControllerSession claim; durable checks are admitted by the Work's declared check set and then fenced by immutable execution identity plus Process Runtime resource claims. A semantic revision must be applied to the latest persisted aggregate inside the same storage transaction so a concurrent mechanical update cannot be overwritten merely because the semantic revision did not change.

The source still contains legacy Requirement waiting/continue, Plan approval/PlanStep/supersession data, Work finalization, and ControllerRound machinery for frozen-client compatibility and historical delivery continuity. These mechanisms are not current model-facing semantic authorities and cannot be consulted as semantic-write gates. `plan_approve` and `plan_accept_step` are compatibility no-ops; Work completion, verification, review, and terminal state never claim, complete, release, or reopen Plan item state. ControllerRound identity may fence the frozen transport/resume envelope but cannot authorize Requirement/Plan/Work semantic writes, and a frozen client may carry that exact authority through the bounded `session_id` compatibility carrier as long as the canonical principal/Work/round comparison still decides the claim.

The frozen Plan item still carries a bounded Work-link projection while its own admission and progression gates exist: starting Work for an explicit Plan item records that link, and the explicit `plan.step.retry:<workId>` compatibility operation releases it before restoring the item. Both are named migration debt owned by the legacy PlanStep plane, must not grow new consumers, and are deleted together with that plane; no other active path may write Plan state on a Work's behalf.

No Runtime/Recovery release transition is part of this decision.

## Thin capability substrate consolidation (2026-09-24)

### 1. Mode-free capability surface
- Capabilities (`read`, `search`, `edit`, `command`, `process`, `git`, `workspace`, `browser`, `computer`, `plugin`, `API`, `agent`, `schedule`, `release`, `recovery`) remain domain-shaped public capabilities and compose without mandatory Requirement, Plan, Work, task-size thresholds, or mode tokens.
- Shared invocation conventions are deliberately small: principal/target, typed arguments, optional expected revision, timeout/cancellation, idempotency token, and result or typed handle.
- A direct task may acquire Work durability later by attaching existing semantic refs/handles/receipts without replaying prior effects.

### 2. Mechanical authority consolidation
- Canonical `Grant` is the single authorization fact for principal + capability/action set + target/resource scope + constraints + expiry/revocation. Plugin authorization reads/revokes/reconciles canonical Grant first; the old plugin grant JSON is migration seed/compatibility projection only. Repository ID is optional locator metadata, not mandatory scope.
- `OwnedResource` records Forge-created worktrees/branches and cleanup provenance. Creating/recovering a managed workspace records ownership; cleanup receipts settle that ownership idempotently.
- Optimistic CAS and native Git/OS conflict semantics are default; short exclusive claims exist only for concrete shared mutable resources (Git refs/index, release promotion, physical input, mutable provider target).
- Work is not a mutex. ControllerSession/ControllerRound remains only where transport, external-effect, or destructive resource fencing needs an exact mechanical identity; it is not a semantic mutation lock.

### 3. Continuity, schedule, and user requests
- Open Work is durable context, not an autonomous execution loop instruction.
- `ScheduleDefinition` (authored trigger, target, policy, action, stop conditions, enabled) is split from `ScheduleRuntimeState` (lastTriggeredAt, consecutiveFailures, nextEligibleAt, occurrences, observation data). Scheduler records triggers, timing, bounded backoff and dispatch facts; internal watcher/provider failures do not manufacture human Handoffs.
- `UserActionRequest` / `UserDecisionRequest` is the canonical person-only blocker/decision authority and coalesces repeated occurrences by rootCauseKey. Legacy Handoff is written only as a compatibility/UI projection after the UserRequest exists.
- A Schedule occurrence is continuation input, not a human blocker: semantic/model-owned schedules record trigger, decision and occurrence identity without manufacturing Handoff/UserRequest state.
- Workflow Supervisor observes outstanding external-turn effects and may reserve one exactly-once provider resume for an applied-but-uncompleted effect. It does not own recursive provider retry depth or Scheduler retry policy.

### 4. Completion vs release/recovery
- `work_complete` records only the model/user semantic decision and result references. Source integration, git merge, publication, release activation, and resource cleanup are separate capabilities/effects.
- Legacy `finalize` must not manufacture a completion/delivery receipt from semantic completion. For a semantically completed Work with no delivery receipt it is a compatibility no-op.
- Periodic cleanup does not treat semantic `completed`/`cancelled` as deletion authorization. A dirty managed worktree is retained in place; cleanup never auto-commits, archives, discards, or force-removes uncommitted bytes merely because Work became terminal.
- Cleanup debt is derived from owned-resource facts, acts only on resources proven Forge-owned, and is retryable/idempotent independently of Work completion.

### 5. Compatibility surface and projections
- Frozen clients may carry `requirement_get`, `requirement_revise`, `plan_revise`, `work_get`, `work_revise`, and `work_complete` through the single bounded `semantic.v1` transport envelope. Stable IDs remain explicit, and semantic mutation still lands in the same canonical CAS handlers.
- Deprecated route/work-mode/operational-plan surfaces are compatibility projections only. They may report concrete continuity/placement needs and available capabilities, but must not prescribe task-size modes, worker choice, validation policy, review lifecycle, or next engineering method.
- Activity/status/Handoff/legacy PlanStep data are derived or compatibility views. A stale projection is repairable cache debt, never a reason to reject a canonical semantic CAS or concrete resource/effect operation.
