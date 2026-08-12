# Architecture Governance Contract

> Status: **Runtime Authority**

## 1. Objective

Architecture governance keeps implementation, execution policy, durable schemas, and documentation from evolving as independent stories.

The goal is not to maximize documentation. The goal is to maintain one reviewable answer to each of these questions:

- What owns a decision?
- What owns the durable state?
- What may run concurrently?
- What must be serialized?
- What can recover after disconnection or restart?
- What evidence is required before completion?
- Which statements describe current code and which describe the approved target?

## 2. Authority Hierarchy

Architecture sources are ordered as follows:

1. `docs/architecture/current/` — approved Runtime Authority.
2. Accepted ADRs — temporary binding amendments until merged into the current set.
3. Executable code, schemas, and tests — evidence of Current Implementation.
4. Issues, plans, and architecture requests — proposed or in-progress change.
5. Historical version documents and snapshots — migration evidence.
6. Research reports — hypotheses and supporting evidence.
7. Diagrams and UI projections — explanatory views only.

Code cannot silently redefine the Target Architecture. A code/document mismatch must be recorded as one of:

- implementation defect;
- intentional migration gap;
- architecture change awaiting ADR;
- obsolete target rule requiring explicit supersession.

## 3. Normative Language

The current set uses these keywords:

- **MUST / MUST NOT** — architecture invariant or safety boundary.
- **SHOULD / SHOULD NOT** — default policy; deviations require recorded rationale.
- **MAY** — supported option without default authority.

Normative rules must identify their state:

- **Current Implementation**
- **Target Architecture**
- **Migration Rule**

A paragraph may include more than one state only when the gap is explicit.

## 4. Document Ownership

| Document | Owns |
| --- | --- |
| `system-overview.md` | System boundary, layer responsibilities, process topology |
| `architecture-invariants.md` | Non-negotiable cross-cutting rules |
| `entity-model.md` | Entity meanings, identity, ownership, durable relationships |
| `job-and-run-lifecycle.md` | Execution state machines and terminal semantics |
| `dispatch-and-agent-strategy.md` | Work-mode and Agent-role selection |
| `scheduler-and-resource-claims.md` | Claims, leases, conflicts, queues, workspace/worktree rules |
| `multi-repository-execution.md` | Global quotas, fairness, portfolio workflows, repository isolation |
| `automation-and-schedule-engine.md` | Schedule, occurrence, deduplication, budget and stop conditions |
| `failure-recovery.md` | Process failure, orphan, stale, timeout, reconciliation and fencing |
| `verification-and-release-gates.md` | Verification, acceptance, release freeze and human authorization |
| `migration-roadmap.md` | Ordered convergence plan and evidence gates |
| `governance.md` | Authority, terminology, change process and drift management |

A rule must live in its owning document. Other documents should link to it instead of copying a second normative version.

## 5. Architecture Decision Records

An ADR is required before intentionally changing:

- the Thin Gateway / Controller / Worker boundary;
- the single-owner semantics of a Per-Repository Actor;
- Job, Run, Task, Edit Session, Verification, Schedule, Occurrence, Claim, or Lease identity;
- request idempotency or retry behavior;
- workspace or worktree conflict rules;
- cross-repository ordering or failure isolation;
- release and destructive-operation authority;
- compatibility behavior of persisted runtime state.

ADRs should be stored under `docs/architecture/decisions/` and contain:

```text
Status
Context
Decision
Alternatives
Consequences
Migration
Verification
Supersedes / Superseded by
```

An accepted ADR must name the current documents it amends. The amended rules must be merged into the current set before the ADR is considered fully incorporated.

## 6. Architecture Drift

Architecture drift exists when executable behavior and a current normative rule differ.

Every drift item must record:

```text
rule
observed implementation
risk
temporary behavior
owner Requirement/Work item or ADR
target closure condition
verification
```

Drift is acceptable only when it is:

- explicit;
- bounded;
- owned;
- observable;
- scheduled for closure or deliberate architecture revision.

An unlabeled mismatch is a defect, not a migration strategy.

## 7. Historical Document Policy

Versioned V5–V8 documents, old controller guides, migration snapshots, and retired workflow designs must remain available for audit, but they must begin with a visible notice:

```text
Historical Design
Not Runtime Authority
Current architecture: docs/architecture/current/README.md
```

Historical documents must not be incrementally edited to carry new target rules. New target rules belong in `current/`; historical documents may receive only:

- the historical notice;
- corrected links;
- factual errata that do not make them appear current.

## 8. Diagram Policy

The semantic Markdown text is authoritative. Mermaid or HTML diagrams are projections.

A diagram:

- MUST link to its semantic source;
- MUST NOT introduce an entity, state, dependency, or boundary absent from the source;
- SHOULD be regenerated when the source topology changes;
- MAY omit detail for readability if the omission is explicit.

## 9. Change Procedure

For an architecture-sensitive change:

1. Classify the change and locate the owning current document.
2. Create an Issue, architecture request, or ADR with scope and acceptance evidence.
3. Update the current architecture before or with implementation.
4. Define Migration Rules where implementation cannot move atomically.
5. Implement in bounded Tasks.
6. Run focused checks and architecture consistency checks.
7. Verify exact links between the implementation Task, ADR/request, current document, and evidence.
8. Archive or supersede historical guidance that would otherwise conflict.

For an urgent incident fix:

1. Restore safety or availability with the smallest reversible change.
2. Record the behavior as temporary drift.
3. Create the architecture follow-up before declaring the incident fully closed.

## 10. Review Checklist

An architecture review must verify:

- one component owns each mutable decision;
- durable truth is not held only in memory or chat;
- long operations are not bound to request lifetime;
- concurrency rules identify explicit resources;
- unknown write scope is treated conservatively;
- retries preserve history and do not mutate prior attempts;
- evidence binds to the exact repository revision;
- multi-repository behavior has failure isolation and fair resource limits;
- scheduled work has bounded occurrences and stop conditions;
- destructive and externally visible actions remain explicitly authorized;
- the target does not claim to be already implemented without evidence.

## 11. Automated Governance Gate

The architecture check must eventually enforce at least:

- presence of the required current document set;
- the Runtime Authority declaration in this directory and the architecture index;
- required Historical Design notices on versioned documents;
- valid internal links;
- stable terminology for core entities;
- presence of key invariants such as durable-job execution and exact-revision verification.

The automated gate protects structure and explicit contracts. It does not replace human review of architecture quality.

## 12. Baseline Freeze

A current architecture baseline may be declared frozen when:

- all required documents exist;
- the architecture consistency gate passes;
- known implementation gaps are listed in `migration-roadmap.md`;
- every P0 gap has an owner;
- versioned documents are marked historical;
- the baseline has been reviewed against current source and persisted schemas.

After baseline freeze, new architecture-sensitive implementation Tasks must cite the affected current document or an accepted ADR.
