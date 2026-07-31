# Execution Evidence and Trustworthy Completion Contract Audit

Status: frozen audit contract for `ISS-20260730-A1EA53:T1`  
Audited source through revision: `d69aaac9fafe8f21e7b65b0d7a6b34ccca4667a2`  
RC6 prerequisite: released at `2a48486b7b8c3395d05e4f30201e968ee88f9779`  
Public repository: `moretea-labs/matea`  
Audit Work: `work_e5d51a9ff4734329ae460cbbaba66e7f`

## 1. Decision

Repo Harness already has most of the required building blocks, but completion is split across three independently persisted authorities:

1. `WorkContract` records objective, policy, checks, evidence references, and a coarse lifecycle.
2. `WorkHandle` binds execution to an exact repository/workspace and records Git finalization stages.
3. Task verification and `CompletionReceipt` control durable Task acceptance.

The next implementation must not add a fourth control plane. It must add an explicit, backward-compatible join between these three authorities.

The frozen design direction is:

- retain the existing entities and stores;
- add explicit work kind, dispatch state, evidence state, and completion outcome;
- bind check evidence and result evidence to exact revisions and inputs;
- derive one machine-readable completion candidate from WorkContract + WorkHandle + evidence;
- generate an idempotent Completion Receipt from that candidate;
- keep Task acceptance as a separate policy/human decision over the receipt;
- support both changed and `completed_no_change` outcomes;
- make stale, contradictory, manually integrated, and cleanup-pending states resumable instead of terminally ambiguous.

## 2. Scope and source facts

The audit examined the current implementations in:

- `src/runtime/control-plane/facade/types.ts`
- `src/runtime/control-plane/facade/work-contract-store.ts`
- `src/runtime/control-plane/facade/goal-workloop.ts`
- `src/runtime/control-plane/execution/work-handle-store.ts`
- `src/runtime/control-plane/execution/work-task-receipt.ts`
- `src/runtime/gateway/mcp/execution-tools.ts`
- `src/cli/controller/types.ts`
- `src/cli/controller/execution-policy.ts`
- the persisted fixture `work_2705c12349124ed2b9b94950a427c31a`

This is an audit and contract-freezing Task. It does not authorize broad runtime implementation.

## 3. Current entity model

### 3.1 WorkContract

The current `WorkContract` is schema version 1 and contains:

- objective and acceptance criteria;
- allowed and forbidden paths;
- declared checks;
- execution mode and driver policy;
- worktree, approval, evidence, and recovery policies;
- optional PlanContract provenance;
- evidence, check, handoff, worker, and worktree references;
- a coarse status:
  - `open`
  - `running`
  - `blocked`
  - `ready`
  - `completed`
  - `failed`
  - `cancelled`

This status combines dispatch, execution, evidence, and final completion concerns. It cannot reliably distinguish:

- created but not dispatched;
- claimed but not started;
- execution running;
- implementation complete but unverified;
- verification complete but Git finalization pending;
- physically integrated but receipt recovery pending;
- completed changed;
- completed with no change.

### 3.2 WorkHandle

`WorkHandle` is correctly modeled as an execution binding rather than another Task lifecycle. It stores:

- repository and checkout identity;
- workspace/worktree and branch;
- base commit and expected head;
- session, principal, Goal, and permission revision;
- whether the workspace is managed;
- a state:
  - `prepared`
  - `editing`
  - `validating`
  - `committed`
  - `merged`
  - `cleaned`
  - `failed`
- independent finalization stages:
  - validation;
  - commit;
  - merge;
  - branch cleanup;
  - worktree cleanup.

This staged model is useful and should be preserved.

Revision `d69aaac9fafe8f21e7b65b0d7a6b34ccca4667a2` also adds an additive `validationRun` record containing a fingerprint, exact head, requested checks, resume state, and Process references. That repair closes the specific race where managed checks were treated as failed before their terminal receipt arrived. It is a useful precedent for the broader exact-input evidence contract, but it covers validation execution only; it does not join mutation, integration, cleanup, receipt, and Task acceptance.

### 3.3 Verification records

Facade verification distinguishes:

- `valid_pass`
- `valid_fail`
- `invalid_check_id`
- `infrastructure_failure`
- `skipped`
- `superseded`

This classification is correct in principle. In particular:

> `infrastructure_failure` is not an acceptance failure.

However, `VerificationRecord` does not itself bind a check result to a source revision, diff, configuration fingerprint, or other verification input identity.

### 3.4 CompletionReceipt

Task-level `CompletionReceipt` already supports several delivery concepts:

- source kinds including direct edit, Controller Work, isolated/workspace Run, and remote no-change execution;
- delivery kinds including commit, no-change, remote, and superseded;
- target/source/base revisions;
- changed paths;
- integration reachability;
- cleanup warnings and blockers.

The type is broader than the current Controller Work receipt producer.

## 4. Current completion paths

### 4.1 Goal Workloop finalize

`finalizeGoalWorkloop()` decides WorkContract completion from:

- declared checks having current `valid_pass` history;
- absence of acceptance failures, infrastructure issues, and invalid check IDs;
- or, for a no-check WorkContract, at least one durable `evidenceId` or `artifactId`.

It intentionally ignores weak `workerRef` and `worktreeRef` references.

When the evidence evaluator says complete, it sets `WorkContract.status = completed`.

It does not prove:

- that a mutation occurred;
- that a no-change conclusion is objective-specific;
- that check inputs match the current revision;
- that commit, merge, or cleanup occurred;
- that a Task-level Completion Receipt exists.

### 4.2 Composite work_finalize

`work_finalize` advances the WorkHandle through independently recorded stages:

1. revalidate the bound workspace;
2. commit selected current changes when requested;
3. merge through structured Git when requested;
4. clean a managed worktree when requested;
5. delete the feature branch after merge when requested;
6. mark the WorkContract completed when all selected stages are non-pending/non-failed.

This path is resumable after failed stages and is substantially stronger than prose-only completion.

Its main limitations are:

- skipped stages may still make finalization complete when callers did not request them;
- stage records do not carry typed evidence IDs, revisions, blockers, or reconciliation provenance;
- completion of WorkHandle/WorkContract still does not generate a Task receipt;
- the path does not represent an explicit no-change outcome.

### 4.3 Controller Work to Task receipt bridge

`acceptVerifiedTaskFromControllerWork()` is a separate bridge. It requires all of the following:

- the Task is already `verified`;
- the WorkHandle exists and belongs to the repository;
- the WorkContract is exactly `completed`;
- the WorkHandle is exactly `cleaned`;
- validation, commit, merge, branch cleanup, and worktree cleanup are all exactly `done`;
- WorkHandle expected head equals Task integrated revision;
- the target revision is reachable from the completion target branch;
- the Work has not already been bound to another Task.

It then creates a commit/integrated/complete receipt and accepts the Task.

This bridge is intentionally strict, but currently supports only one happy path: a changed, committed, merged, fully cleaned Work whose original WorkHandle remained authoritative through every stage.

## 5. Required regression fixture

### 5.1 Fixture identity

`work_2705c12349124ed2b9b94950a427c31a` attempted to publish the Reliability Program Charter and Session Protocol.

Its durable record currently says:

- mode: Goal Workloop;
- status: `failed`;
- intended isolated worktree;
- allowed paths limited to the two Program documents;
- no declared checks;
- one polluted blank check record classified as `invalid_check_id`;
- no complete finalization or receipt projection.

### 5.2 Physical repository history

The original document commit was `25f40004c9f229b935fc649daaf68498eb4d4f06`.

The work's first merge attempt correctly refused a dirty RC6 source checkout. The document change was later integrated outside the original Work finalization path and its temporary workspace was removed. RC6 sequencing subsequently rewrote the local integration order. The same document content was later reintroduced on the current main line as patch-equivalent commit `b20ed381b3fa7ef47bf7d4cba497bef92446c7d8` and sanitized in `d42fe4b7d839e1b8a4aad29c115f70c008659951`.

Therefore, the fixture now contains deliberately contradictory but useful facts:

- the original Work says failed;
- its original exact revision is not the current integrated revision;
- the intended content is integrated through a later equivalent lineage;
- the original worktree/branch were removed;
- the Task has verification evidence but no Controller Work receipt.

### 5.3 Why current recovery cannot accept it

The current receipt bridge cannot recover this fixture because it requires the original Work to be completed and cleaned with all stages exactly `done`, and requires exact equality between Work expected head and Task integrated revision.

Blindly changing the old Work to completed would be unsafe. Blindly treating patch equivalence as exact revision identity would also be unsafe.

The correct future behavior is an explicit reconciliation record that says what was observed, what was equivalent, who reviewed it, and which original lifecycle facts remain unrecoverable.

## 6. Confirmed gaps

### G1. No explicit WorkKind

The system cannot durably distinguish:

- repository change;
- already-satisfied/no-change verification;
- read-only investigation;
- remote effect;
- reconciliation/supersession.

### G2. No explicit DispatchState

`running` may mean a Work exists, a Controller owns it, a launcher started, or actual execution is underway. These are materially different facts.

### G3. No explicit EvidenceState

Evidence completeness is recomputed from heterogeneous references. There is no durable projection for:

- none;
- partial;
- valid;
- stale;
- contradictory;
- failed.

### G4. WorkContract completion and Git finalization are independent

Goal Workloop can mark a WorkContract completed from check/artifact evidence without WorkHandle Git finalization. Composite finalization can complete Git stages without producing Task receipt evidence.

### G5. Effective check evidence is not yet fully joined to completion identity

The new WorkHandle `validationRun` binds in-flight validation to an exact head and request fingerprint, which fixes managed validation resumption. Persisted facade `VerificationRecord` and Task verification still need bounded source/input identity that participates in completion-candidate derivation. A later repository or relevant configuration change must make previous evidence stale rather than silently reusable.

### G6. No first-class completed_no_change path

The CompletionReceipt type permits no-change, but Controller Work receipt generation requires commit, merge, and both cleanups to be `done`.

### G7. No safe manually integrated reconciliation

The cleanup reconciliation helper is narrowly scoped to retained cancelled Work. There is no general reviewed path for an old failed/blocked Work whose commit or equivalent change was integrated independently.

### G8. Finalization stages lack typed evidence

Stage strings record `done/failed/skipped`, but do not reference:

- exact before/after revisions;
- diff hash and changed paths;
- integration strategy;
- cleanup warnings/blockers;
- reconciliation evidence;
- the actor and timestamp for each stage.

### G9. Invalid check metadata can poison completion

A blank or obsolete check ID is correctly not an acceptance failure, but it can still leave the Work incomplete or failed indefinitely without a controlled supersession/migration path.

### G10. Schema migration is implicit

WorkContract and WorkHandle are both schema version 1. New semantics need deterministic additive normalization and must not destructively rewrite known-good legacy records before validation succeeds.

## 7. Frozen compatible contract

### 7.1 Additive semantic axes

Introduce additive fields while retaining current `status` as a compatibility projection.

```text
WorkKind
  repository_change
  completed_no_change
  investigation
  remote_effect
  reconciliation
  superseded

DispatchState
  not_dispatched
  claimed
  launching
  running
  blocked
  terminal

EvidenceState
  none
  partial
  valid
  stale
  contradictory
  failed

CompletionOutcome
  completed_changed
  completed_no_change
  completed_remote
  superseded
```

Impossible combinations must fail closed. Examples:

- `completed_changed` without mutation/integration evidence;
- `completed_no_change` with owned dirty paths;
- `valid` evidence whose source revision differs from the current required revision;
- terminal dispatch with a live owned process unless it is explicitly detached and tracked.

### 7.2 Exact-revision VerificationRecord

Extend verification records additively with:

```text
sourceRevision
verificationInputFingerprint
commandFingerprint
resultArtifactId
startedAt
completedAt
supersedes
staleReason
```

The effective check history is selected by check ID and current required fingerprint. Old evidence remains auditable but is projected as stale or superseded.

### 7.3 Completion candidate

Create one derived, persisted `CompletionCandidate` or equivalent additive record joining:

- WorkContract identity and objective;
- WorkKind and CompletionOutcome;
- WorkHandle/workspace identity;
- base, source, result, and target revisions;
- mutation/no-change/remote evidence;
- declared checks and effective verification records;
- finalization stage evidence;
- cleanup warnings and blockers;
- reconciliation evidence;
- residual risks;
- candidate state: incomplete, ready, stale, contradictory, accepted, rejected.

This record is not a new control plane. It is a deterministic join/projection of existing authorities and must reference their durable IDs.

### 7.4 Changed completion

A changed repository result requires:

- exact base and result revisions;
- non-empty changed paths or reviewed mutation evidence;
- reviewed diff hash;
- declared checks valid for the result revision;
- integration reachable from the target branch;
- no cleanup blockers;
- no active owned mutating process, lease, edit session, or dirty owned path.

### 7.5 completed_no_change

A no-change result requires:

- an explicit no-change WorkKind/outcome selected before receipt generation;
- exact source revision and verification-input fingerprint;
- objective-specific evidence that the requested state is already satisfied;
- no owned dirty diff;
- declared checks valid for that exact state when checks are required;
- no fabricated commit or merge stage;
- cleanup evidence proving no temporary resources remain or were created.

The receipt delivery kind and strategy must both be `no_change`.

### 7.6 Reconciliation of manual or equivalent integration

Reconciliation must never silently mutate legacy history. It may produce a receipt candidate only when all of the following are recorded:

- original Work and expected revision;
- observed target revision;
- exact reachability result;
- equivalence method, such as exact commit, tree equality for owned paths, or reviewed patch identity;
- bounded changed-path comparison;
- reviewer and timestamp;
- unrecoverable original stage facts;
- cleanup ownership proof;
- explicit outcome: accepted equivalence, rejected equivalence, or superseded.

Exact revision remains preferred. Patch/tree equivalence is a reviewed exception, not automatic identity.

### 7.7 Finalization stages

Retain the current five stages but attach typed evidence to each:

```text
validation
commit
merge
branch_cleanup
worktree_cleanup
receipt
```

Each stage records state, actor, timestamps, evidence references, exact revisions where relevant, warnings, blockers, and last error. Retry resumes from the last proven stage and is idempotent.

Receipt generation becomes its own finalization stage. Task acceptance remains after receipt generation.

### 7.8 Compatibility projection

Legacy readers continue to see current WorkContract status. New readers use the additive axes.

Suggested projection:

- open + not_dispatched -> `open`
- claimed/launching/running -> `running`
- incomplete/stale/contradictory -> `blocked` or `ready` with reason
- accepted completion candidate -> `completed`
- real acceptance failure -> `failed`
- explicit stop -> `cancelled`

Infrastructure failure and invalid check metadata must not project to acceptance failure.

## 8. Migration rules

1. Read schema version 1 records without rewriting them.
2. Normalize missing semantic axes in memory using conservative inference.
3. Persist version 2 only on the next legitimate state mutation or explicit migration.
4. Write to a temporary/atomic target and validate before replacing durable state.
5. Preserve original evidence/check records; add supersession/staleness metadata rather than deleting history.
6. Never infer `completed_changed` from worktree existence, worker existence, or check existence alone.
7. Never infer `completed_no_change` from an empty diff alone.
8. Legacy terminal ambiguity becomes reconciliation-required, not silently completed or failed.

## 9. Stop and fail-closed conditions

Completion must stop when:

- current source revision no longer matches verification inputs;
- required checks are missing or stale;
- an acceptance check has `valid_fail`;
- evidence conflicts about revision, workspace, target branch, or Task binding;
- owned paths remain dirty;
- an owned mutating process, lease, or edit session remains active;
- target revision is unreachable;
- cleanup ownership is unknown;
- no-change proof is generic rather than objective-specific;
- reconciliation equivalence is ambiguous or unreviewed.

## 10. Implementation sequence for T2–T6

### T2 — state semantics and migration

- Add WorkKind, DispatchState, EvidenceState, CompletionOutcome.
- Add deterministic schema-v1 normalization and guarded schema-v2 persistence.
- Add transition validation and impossible-state tests.
- Keep current status as a compatibility projection.

### T3 — exact-revision evidence and receipt candidate

- Bind VerificationRecord to source/input fingerprints.
- Implement effective evidence selection and stale detection.
- Add CompletionCandidate derivation.
- Generate idempotent changed/no-change receipts.

### T4 — finalize gating and reconciliation

- Attach evidence to finalization stages.
- Add receipt as a finalization stage.
- Implement changed and no-change gates.
- Implement reviewed manual/equivalent integration reconciliation.
- Add `work_2705c12349124ed2b9b94950a427c31a` as the primary regression fixture.

### T5 — cross-session continuation

- Expose semantic axes, stage evidence, stale reasons, reconciliation requirements, and next safe action through `work_get`, `work_inspect`, status digests, and handoff packets.
- Keep payloads bounded and redacted.

### T6 — regression and failure injection

Cover at minimum:

- changed success;
- completed_no_change success;
- source revision drift;
- check input drift;
- acceptance failure versus infrastructure failure;
- invalid check supersession;
- failed commit and retry;
- failed merge and externally completed exact integration;
- reviewed patch-equivalent integration;
- dirty cleanup blocker;
- active process/lease/edit-session blocker;
- restart during every finalization stage;
- legacy schema-v1 read and guarded migration;
- receipt idempotency and cross-Task binding rejection;
- unrelated main advancement during a current-workspace audit, proving non-overlapping source drift can be reviewed and resumed without silently rebinding exact-revision mutation evidence.

## 11. Acceptance traceability for T1

- RC6 prerequisite and current audited revision are recorded at the top of this document.
- Existing WorkContract, WorkHandle, Evidence Plane, and Task receipt types are reused.
- Current changed/no-change, exact-revision, stale, failed check, failed merge, cleanup, and continuation semantics are mapped.
- `work_2705c12349124ed2b9b94950a427c31a` is preserved and analyzed without mutation.
- The additive compatibility contract and bounded T2–T6 implementation sequence are explicit.

## 12. T1 outcome

The evidence contract is frozen sufficiently to begin T2. The key implementation rule is:

> No single coarse status, check reference, Work existence, or agent statement may prove completion. Completion is an idempotent, exact-state join of objective, result, verification, integration, cleanup, and receipt evidence, with an explicit no-change path and a reviewed reconciliation path for legacy/manual integration.
