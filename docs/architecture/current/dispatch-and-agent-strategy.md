# Dispatch and Agent Strategy

> Status: **Runtime Authority**

## 1. Objective

Dispatch converts a user or automation objective into the smallest safe execution mechanism. The goal is not to maximize Agent use. The goal is to select the least expensive mechanism that can produce reviewable evidence without losing recoverability.

The Controller owns dispatch decisions. Workers and Agents execute scoped contracts; they do not decide whether the system should have used Direct Edit, a durable Task, or another repository.

## 2. Work Assessment

Every change request is assessed before execution using:

```text
objective clarity
known paths
expected files
expected changed lines
investigation depth
runtime or environment dependencies
parallelism need
dependency graph need
verification duration
risk
external side effects
repository count
```

The assessment produces:

```text
recommendedMode
confidence
reasons
requiredScope
requiredClaims
verificationClass
humanBoundary
```

Repository search is an information-gathering step, not by itself a reason to start an Agent or create a durable Issue.

## 3. Execution Modes

### 3.1 Direct Edit

Direct Edit is the default when the Controller understands the implementation and can bound the change precisely.

Preferred characteristics:

- objective and behavior are understood;
- target paths can be found with bounded search;
- approximately eight or fewer files;
- approximately one thousand or fewer changed lines;
- no autonomous compile/fix loop is required;
- risk is not destructive;
- focused verification exists.

Flow:

```text
search/read
  -> begin Edit Session
  -> bounded revisions
  -> inspect aggregate diff
  -> focused checks
  -> finalize or rollback
  -> Work verification when linked
```

Direct Edit MUST use the same Workspace single-writer resource boundary as a Workspace Agent.

### 3.2 Quick Agent

Quick Agent is used when the objective is clear but implementation requires meaningful exploration or repeated local edit/test cycles, without needing a durable multi-Work dependency graph.

Preferred characteristics:

- one coherent objective;
- one reviewable result;
- bounded path scope;
- no long-lived cross-session product workflow;
- retry can replace the whole attempt;
- Agent autonomy provides clear value over Direct Edit.

Quick Agent work may carry ephemeral diagnostic metadata, but Job and Run evidence remain durable.

### 3.3 Requirement, Plan, and Work

A durable Requirement/Plan/Work graph is required when work has one or more of:

- multiple independently verifiable objectives;
- dependencies or ordered migration phases;
- parallel implementation opportunities;
- high or destructive risk;
- protected or release-sensitive surfaces;
- cross-repository work;
- long-running verification or environment dependencies;
- schedule-driven recurrence;
- a need for review and recovery across multiple sessions;
- release or rollout coordination.

A durable Work contract is not ceremony. It owns bounded execution scope, dependencies, evidence, retry history, and completion receipts; Requirement owns user-visible intent and acceptance outcome.

## 4. Decision Order

The Controller applies this order:

```text
1. Is the request read-only?
2. Can bounded Direct Edit safely satisfy it?
3. Is one scoped Agent attempt sufficient?
4. Does the work require durable Requirement/Plan/Work state?
5. Does it cross repositories or require a Schedule?
6. Does any external or destructive boundary require human authorization?
```

The system MUST NOT default to Agent execution merely because an Agent is available.

## 5. Agent Roles

Agent roles describe responsibility, not permanent products.

### Controller / Architect

Normally ChatGPT or a human-guided controller.

Owns:

- problem understanding;
- architecture decisions;
- Task decomposition;
- acceptance criteria;
- scope and resource declarations;
- Agent and execution-mode selection;
- review and acceptance.

The Controller SHOULD remain runtime-light and MUST NOT become the hidden owner of a long Worker process.

### Explorer

A read-only role used for:

- root-cause investigation;
- architecture mapping;
- candidate path discovery;
- dependency analysis;
- risk assessment.

Explorer output is evidence or a proposed plan. It does not authorize writes.

### Implementer

A scoped worker role used for:

- code or document changes;
- local compile/test/fix loops;
- producing a reviewable diff;
- reporting limitations and unresolved blockers.

An Implementer cannot accept its own Task.

### Verifier

An optional independent role for high-risk, safety-sensitive, or ambiguity-prone work.

The Verifier MUST use the Task's declared checks and acceptance criteria as its rubric. It MUST NOT invent a competing quality standard or replace authoritative repository tests.

Independent verification is not a default for every Task because extra evaluators can add cost and drift without improving acceptance alignment.

### Integrator

Integration is a deterministic system role, not an LLM role.

It validates source evidence, base revisions, target state, supported file operations, conflicts, and cleanup. An Agent may explain a conflict, but must not silently decide to overwrite it.

### Release Steward

The Release Steward evaluates the release gate, produces the release manifest, and identifies unresolved human boundaries. It cannot silently push, merge, publish, or deploy.

## 6. Runtime Agent Selection

Tasks remain executor-neutral. At dispatch time the Controller chooses among enabled providers based on capability and constraints.

General policy:

| Work characteristic | Preferred executor |
| --- | --- |
| Small understood change | Direct Edit |
| Broad repository exploration and repeated code/test loop | Codex or Claude local Agent |
| Architecture, policy, documentation, semantic cross-module review | ChatGPT, Claude, or Direct Edit after analysis |
| GitHub-native collaboration and draft PR | GitHub Copilot session |
| Deterministic check, command, integration, or release gate | Non-Agent Worker |
| Read-only root-cause map | Explorer role |

Agent choice considers:

```text
required tools
repository language
context size
expected autonomy
local availability
provider health
cost budget
past failure classification
need for GitHub collaboration
```

A Task does not permanently bind to one Agent. However, switching Agents after failure requires a reason, not reflex.

## 7. Failure Classification Before Retry

Before retry or Agent switching, classify the failure:

- `infrastructure_failure` — transport, process launch, authentication, unavailable provider;
- `scope_conflict` — resource or allowed-path collision;
- `environment_failure` — missing dependency, build service, credentials, external system;
- `implementation_failure` — produced change does not compile or satisfy checks;
- `acceptance_failure` — implementation works locally but misses declared criteria;
- `integration_failure` — reviewed change cannot be integrated safely;
- `agent_capability_mismatch` — execution requires capabilities unavailable to the selected Agent;
- `controller_contract_failure` — Task scope, acceptance, or prompt was insufficient or contradictory.

Response policy:

| Classification | Default response |
| --- | --- |
| Infrastructure | Retry same contract after recovery |
| Scope conflict | Wait, re-scope, or isolate |
| Environment | Block with external dependency evidence |
| Implementation | Request focused changes or retry same Agent |
| Acceptance | Refine implementation, not the criteria unless product intent changed |
| Integration | Preserve Worktree; repair from current target state |
| Capability mismatch | Select a more suitable Agent/provider |
| Controller contract | Re-plan Work before another Run |

## 8. Work Execution Contract

Every Agent Run receives a generated contract containing:

```text
repository and checkout identity
Requirement and Work objective
current implementation context
allowed and forbidden paths
required outputs
acceptance criteria
named checks
risk and destructive boundary
resource placement
base revision
budget and deadline
result and artifact paths
completion and stop conditions
```

The prompt MUST state that:

- unrelated changes are forbidden;
- repository state is authoritative over chat memory;
- the Agent must not commit, merge, push, publish, deploy, reset, rebase, or remove Worktrees unless the explicit contract permits it;
- test failure must be reported honestly;
- a successful self-report does not complete the Task;
- user modifications outside scope must be preserved.

## 9. Budget Model

Every Agent or scheduled execution SHOULD declare bounded budgets:

```text
wall-clock timeout
maximum retries
maximum parallel children
maximum changed files
maximum changed lines
maximum output bytes
optional token or provider cost budget
```

Budget exhaustion produces a durable outcome. It must not silently extend itself indefinitely.

## 10. Placement Decision

Placement is separate from Agent selection.

### Workspace

Use when:

- no other write owner exists;
- work is serial;
- fast local iteration is valuable;
- the user expects changes in the visible working tree.

### Worktree

Use when:

- another writer is active;
- independent Tasks should run concurrently;
- isolation is explicitly requested;
- the main Workspace is dirty and safe direct ownership cannot be established;
- implementation should be reviewed before integration.

### GitHub branch/provider

Use when:

- remote collaboration is requested;
- the provider requires a remote branch;
- a draft PR is a desired artifact;
- local execution is unavailable.

The default `auto` placement policy chooses Workspace for one local serial writer and Worktree when concurrency exists. It MUST still honor explicit claims and dirty-state safety.

## 11. Review and Continuation

After execution:

```text
read Run/Job outcome
  -> inspect diff and evidence
  -> classify defects or blockers
  -> integrate when isolated
  -> verify exact Revision
  -> accept or request changes
  -> unlock dependents
```

The Controller may use Direct Edit for a small correction after an Agent Run. This creates separate, reviewable evidence rather than asking the Agent to rerun the entire task unnecessarily.

## 12. Anti-Patterns

The dispatch layer MUST avoid:

- starting an Agent for a deterministic one-file edit;
- creating a durable Issue solely because file discovery is needed;
- binding every Task permanently to Codex;
- launching multiple Agents with overlapping unknown write scopes;
- using a Verifier with criteria different from Task acceptance;
- retrying on every network error without idempotency lookup;
- treating a successful process exit as product acceptance;
- allowing an automation Agent to recursively create unlimited work;
- using the Controller conversation as the only execution state.

## 13. Current Implementation

The repository implements Direct Edit, Quick Agent and Requirement/Work assessment; runtime Agent selection; bounded Task scope; persistent Runs; Workspace/Worktree placement; and risk-adaptive verification.

The Thin Gateway keeps deterministic local commands on Direct Edit or Process Runtime paths. Agent dispatch is now an explicit external-Controller handoff; the Kernel no longer creates Execution Jobs for ordinary Agent launches. Work ownership, repository placement, and resource claims remain durable Controller state, while provider selection and model execution belong to the claimed external Controller.

Failure outcomes are retained on Work, Process, Handoff, or legacy read-only Job evidence as applicable; retries preserve the failed attempt and create a new explicit continuation attempt rather than falling back to implicit Job creation.
