# Thin semantic working context and revision authority

Status: accepted migration direction; implementation is staged.

## Decision

Forge exposes only three cross-domain model-authored semantic records: Requirement, Plan, and optional Work. Requirement is stable intent, Plan is model-authored strategy/decisions/progress, and Work is an independently resumable semantic unit. Workflow, Schedule, Connection/Grant, Process, ControllerRound, repository state, and domain handles remain operational, security, execution, or domain facts rather than additional working-memory authorities.

Each semantic record has one stable identity, one portable semantic scope and one monotonic semantic revision. ForgeInstance is the root authority; repository/checkout identity is execution placement or optional domain context, never synthetic semantic ownership. Model-facing writes use expected-revision compare-and-swap. A stale write fails with the current semantic record/revision and never silently merges. The append-only requirement_revision, plan_semantic_revision, and work_semantic_revision records are immutable history evidence, not independently mutable authorities; Controller storage revisions remain internal persistence concurrency metadata.

Plan semanticContext is the model-facing semantic authority once present. Legacy PlanContract goal/step/lifecycle fields remain migration/execution compatibility data and cannot implicitly rewrite semanticContext. Requirement/source basis revisions are provenance and staleness hints only. Source movement is observed at concrete mutation boundaries and does not make Plan working memory an execution gate. Thin Plan `scopeKey` is descriptive discovery/lineage metadata only, never an ownership mutex; current model-facing replanning revises the same stable Plan id rather than superseding it.

New Work records materialize semanticState from creation. Mechanical Work status, phase, verification, review, delivery, cleanup, provider, recovery, and completion receipts do not rewrite semanticState. Pre-semantic legacy Work may infer an initial semantic state from its historical terminal status until its first semantic revision; that revision materializes the state and ends the fallback. Work resultRefs are model/user-selected references only. Mechanical completion and check receipts are exposed separately.

ResumeContext is a derived read bundle assembled on demand from the latest relevant semantic records plus current source/resource facts, unresolved human requests, active durable handles, and pertinent receipts. It is never persisted as a fourth aggregate, and conversation text or projection caches are never authority.

## Concurrency and migration boundary

Semantic CAS protects authored context. Git/worktree, Process/resource leases, authorization grants, effect identities, and other concrete fences protect the resources they actually own. Verification is Work-bound evidence and is never gated by a Work-wide ControllerSession claim; durable checks are admitted by the Work's declared check set and then fenced by immutable execution identity plus Process Runtime resource claims. A semantic revision must be applied to the latest persisted aggregate inside the same storage transaction so a concurrent mechanical update cannot be overwritten merely because the semantic revision did not change.

The current runtime still contains legacy Requirement waiting/continue, Plan approval/PlanStep/supersession execution, and Work/Controller claim machinery for frozen-client compatibility and delivery continuity. Those mechanisms are not current model-facing semantic operations, are not semantic revision authorities, and must not be consulted as semantic-write gates. Their retirement is a separate migration step required before the thin-model target can be considered fully converged; this decision does not create a fallback path or a duplicate lifecycle authority.

No Runtime/Recovery release transition is part of this decision.

## Thin capability substrate consolidation (2026-09-24)

### 1. Mode-free capability surface
- Capabilities (`read`, `search`, `edit`, `command`, `process`, `git`, `workspace`, `browser`, `computer`, `plugin`, `API`, `agent`, `schedule`, `release`, `recovery`) remain domain-shaped public capabilities and compose without mandatory Requirement, Plan, Work, task-size thresholds, or mode tokens.
- Shared invocation conventions are deliberately small: principal/target, typed arguments, optional expected revision, timeout/cancellation, idempotency token, and result or typed handle.
- A direct task may acquire Work durability later by attaching existing semantic refs/handles/receipts without replaying prior effects.

### 2. Mechanical authority consolidation
- Canonical `Grant` is the single authorization fact for principal + capability/action set + target/resource scope + constraints + expiry/revocation. Generic and plugin-specific grants converge into this canonical authority; repository ID is optional locator metadata, not mandatory scope.
- Optimistic CAS and native Git/OS conflict semantics are default; short exclusive claims exist only for concrete shared mutable resources (Git refs/index, release promotion, physical input, mutable provider target).
- Work is not a mutex. General Work/controller claim/lease locks are retired in favor of concrete resource fences.

### 3. Continuity, schedule, and user requests
- Open Work is durable context, not an autonomous execution loop instruction.
- `ScheduleDefinition` (authored trigger, target, policy, action, stop conditions, enabled) is split from `ScheduleRuntimeState` (lastTriggeredAt, consecutiveFailures, nextEligibleAt, occurrences, observation data).
- `UserActionRequest` / `UserDecisionRequest` is created only for unproxyable human actions/judgments and coalesces repeated occurrences by rootCauseKey.

### 4. Completion vs release/recovery
- `work_complete` records only the model/user semantic decision and result references. Source integration, git merge, publication, and resource cleanup are separate capabilities/effects.
- Cleanup debt is derived from owned-resource facts, acts only on resources proven Forge-owned, and is retryable/idempotent independently of Work completion.
