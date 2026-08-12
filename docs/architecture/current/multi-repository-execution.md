# Multi-Repository Execution

> Status: **Runtime Authority**

## 1. Objective

Multi-repository execution allows unrelated projects to progress concurrently while preserving repository-local ownership, fair system capacity, explicit cross-repository dependencies, and failure isolation.

The core rule is:

> The Global Control Plane allocates capacity; each Repo Actor decides repository-local safety.

No global repository lock is permitted for ordinary work.

## 2. Repository Identity and Isolation

Every command resolves to:

```text
repoId
checkoutId when applicable
```

A repository has independent:

- Requirement and Work state;
- Jobs and Runs;
- Claims and Leases;
- Workspaces and Worktrees;
- check queues;
- integration queue;
- release freeze;
- GitHub mapping;
- runtime projections and evidence.

A repository-local failure MUST NOT mutate or block another repository's state.

## 3. Global Capacity Model

The Global Scheduler maintains configurable limits such as:

```text
maxConcurrentRepositories
maxWorkers
maxAgentProcesses
maxAgentProcessesByProvider
maxHeavyChecks
maxHeavyChecksByRepository
maxWritesByRepository
maxWorktreesByRepository
memoryBudget
cpuBudget
optional provider cost budget
```

Recommended defaults favor stability:

- at least one slot remains available for explicit user work when scheduled work is active;
- one Heavy Check per repository;
- a small global Heavy Check cap;
- one Workspace writer per Checkout;
- Worktree writers limited by repository and global Worker capacity.

These are policy defaults, not hard-coded architecture constants.

## 4. Scheduling Eligibility

A repository Job is globally eligible when:

1. its Repo Actor reports repository-local readiness;
2. dependencies are satisfied;
3. required Claims can eventually be granted;
4. no release barrier prohibits its class;
5. global quota is available or the Job may enter a fair queue;
6. the Job has not exceeded budget, deadline, or retry policy.

The Global Scheduler does not re-evaluate path conflicts. That remains the Repo Actor's responsibility.

## 5. Priority Classes

Recommended priority classes:

```text
P0 — Controller availability, data integrity, security, active incident
P1 — explicit user-requested work
P2 — continuation of current accepted Task or release-critical dependency
P3 — scheduled repair or confirmed maintenance
P4 — discovery, optimization candidate, background hygiene
```

Priority does not bypass safety, dependency, or authorization gates.

## 6. Fair Queueing

The target policy is aging weighted fair queueing across repositories.

A scheduling score may consider:

```text
priority class
wait duration
user initiated vs scheduled
critical dependency path
repository recent resource share
estimated execution cost
retry count
provider availability
deadline proximity
```

Fairness rules:

- one busy repository cannot consume all Workers indefinitely;
- low-priority Jobs age toward eligibility;
- a repository with a blocked Workspace may still run read-only or Worktree work;
- scheduled maintenance yields to explicit user work;
- capacity is not reserved for disabled or release-frozen repositories unless release policy requires it.

## 7. Failure Isolation

Repository A states that must not block Repository B include:

- dirty Workspace;
- path conflict;
- stale Job;
- orphaned Worker;
- failed Heavy Check;
- unresolved integration conflict;
- missing local Agent configuration;
- invalid GitHub mapping;
- release freeze;
- corrupted projection that can be rebuilt locally.

System-wide degradation is justified only for shared infrastructure failures such as:

- Controller Home unavailable;
- scheduler state cannot be persisted safely;
- global authentication boundary compromised;
- Worker pool unavailable;
- process-wide resource exhaustion.

## 8. Repository Backpressure

A Repo Actor may signal:

```text
ready
capacity_limited
workspace_blocked
integration_backlog
release_frozen
configuration_blocked
storage_blocked
disabled
```

Backpressure removes or limits that repository's dispatch eligibility without blocking status queries or unrelated repositories.

## 9. Cross-Repository Portfolio Workflow

Cross-repository intent is represented by a Portfolio Workflow, not by attaching foreign Tasks directly to one repository Issue.

Example:

```text
Portfolio: API v2 migration
  -> backend/schema Task in Repository A
  -> SDK generation Task in Repository B depends on A checkpoint
  -> client migration Task in Repository C depends on B
  -> documentation Task in Repository D independent after A
```

Each node contains:

```text
portfolioNodeId
repoId
issueId / taskId or creation template
dependsOn nodes
required checkpoint
failure policy
compensation metadata
```

The Portfolio coordinator observes repository node outcomes but cannot directly mutate repository-local execution state outside the owning Actor command path.

## 10. Saga Semantics

Cross-repository work uses Saga semantics rather than distributed atomic transactions.

```text
prepare node
  -> execute in repository
  -> verify repository checkpoint
  -> persist portfolio checkpoint
  -> unlock dependent nodes
```

On failure:

```text
stop dependents
  -> preserve successful checkpoints
  -> execute explicit compensation when safe
  -> or require human decision
```

Compensation examples:

- revert a generated SDK commit through a reviewed change;
- disable a feature flag;
- restore a prior configuration artifact;
- abandon an unmerged branch.

Unsafe compensation must not be inferred or executed automatically.

## 11. Checkpoint Contract

A cross-repository dependency is satisfied by an explicit checkpoint, not by another repository's raw process exit.

Checkpoint examples:

```text
Task accepted and verified
artifact published to a local staging path
schema hash recorded
commit SHA prepared
API contract generated
release candidate manifest approved
```

Each checkpoint records:

```text
repoId
source entity
revision or artifact hash
verification evidence
createdAt
validity or expiry conditions
```

If a checkpoint becomes stale, dependent nodes must pause or re-evaluate.

## 12. Cross-Repository Concurrency

Independent nodes may execute concurrently when:

- their repository-local Actors report readiness;
- global capacity exists;
- no shared external resource requires serialization;
- the Portfolio DAG has no dependency edge between them.

Cross-repository writes do not conflict merely because paths have the same name. Conflict keys include `repoId`.

Shared external resources may still require global Claims, for example:

```text
package-name:<registry>:<name>
deployment-environment:<name>
shared-database:<identifier>
shared-generated-artifact:<key>
remote-project:<provider>:<id>
```

## 13. Multi-Checkout Repositories

Multiple local Checkouts of one logical repository share:

- repository identity;
- Git ref mutation coordination;
- provider and release mapping;
- repository-wide Heavy Check or release policy when configured.

They have separate Workspace claims.

A Checkout cannot be treated as a separate repository solely to bypass repository-level ordering or release policy.

## 14. Git and Remote Mapping

Repository registry canonical remote and GitHub plugin mapping must be diagnosable separately.

A mismatch may mean:

- local fork with upstream remote;
- stale plugin configuration;
- repository transfer;
- duplicate registry record;
- intentionally different collaboration target.

The system must warn and require explicit reconciliation. It must not silently create a second active `repoId` or publish to an inferred remote.

## 15. Cross-Repository Release

A Portfolio release uses staged barriers:

```text
all required nodes verified
  -> each repository enters local release freeze
  -> validate checkpoints are current
  -> generate portfolio release manifest
  -> human authorization
  -> execute repository release actions in declared order
  -> record partial or complete outcome
```

A partial release is a first-class outcome. Recovery follows the declared rollout or compensation policy; it is not hidden as global success.

## 16. Scheduled Work Across Repositories

A global Schedule may select multiple repositories, but it creates one repository-scoped Occurrence per selected `repoId`, plus an optional parent portfolio occurrence.

This preserves:

- repository-local idempotency;
- independent failure and backoff;
- per-repository budget;
- fair scheduling;
- scoped notifications.

One failing repository does not force successful repository Occurrences to rerun.

## 17. Disable and Removal

A disabled repository:

- accepts read-only historical queries;
- does not admit new execution Jobs;
- retains durable state and audit history;
- may finish or explicitly cancel active work according to disable policy.

A soft-removed repository remains addressable with `include_removed` for audit and recovery. Removal does not delete evidence automatically.

## 18. Implemented Runtime

The current runtime provides:

- stable repository registry and multiple checkout records;
- repository-scoped Controller Home storage;
- explicit `repo_id` and `checkout_id` routing;
- one logical Repo Actor mailbox per repository;
- global Worker, Agent, provider, Heavy Check, CPU and memory budgets;
- persisted aging/fairness state across Daemon restart;
- repository-local Claims, renewable Leases and fencing tokens;
- Portfolio DAG dependencies with deterministic stop or Saga compensation;
- repository-scoped Schedule Occurrences;
- explicit repository identity and remote-mapping drift diagnostics;
- disabled/removed repository admission barriers while retaining audit reads.

## 19. Compatibility and Extension Rules

The legacy Umbrella entity remains readable for stored-state compatibility. New cross-repository execution ownership belongs to `PortfolioWorkflow`, not Umbrella mutation code.

New multi-repository features must:

- create repository-scoped durable Jobs;
- declare cross-repository dependencies explicitly;
- avoid global repository locks;
- preserve independent failure, retry, budget and evidence per repository;
- route external publication through verified repository/GitHub mapping;
- add an ADR before weakening fairness or repository isolation.

## 20. Runtime Verification

The architecture gate and process smokes verify that:

- Scheduler dispatch history is persisted;
- one repository can wait without blocking another repository's actor;
- Portfolio dependency cycles are rejected;
- external side effects are rejected in unattended Portfolio execution;
- Worker failure is reconciled through durable Job state rather than Gateway lifetime.
