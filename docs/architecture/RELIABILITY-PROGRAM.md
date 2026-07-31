# Repo Harness Reliability and Context Convergence Program

Status: active program charter  
Program anchor: `ISS-20260730-AE1BCC`  
Public repository: `moretea-labs/matea` (select its registered Controller repository at runtime)  
Mandatory implementation gate: `ISS-20260729-BF2F89` (RC6 release closeout)  
Last structural update: 2026-07-30

## 1. Purpose

This document is the durable source of program intent for a multi-session effort to make Repo Harness more trustworthy, easier for a model to operate, and less likely to lose task context across interruptions.

The program has one total goal:

> Build a control plane whose goals survive session boundaries, whose completion claims are machine-verifiable, whose required context is resolved without unsafe guessing, and whose default model-facing tool surface is small without removing or permission-gating the underlying capabilities.

Chat history, temporary worktrees, agent prose, and stale Campaign projections are not sources of truth for the program.

## 2. Durable source-of-truth hierarchy

Use the following order when recovering or deciding work:

1. Repository revision and repository-tracked contracts/documentation.
2. Controller Issue and Task state.
3. WorkContract, exact-revision evidence, and Completion Receipt.
4. Current repository/plugin observations and verified ContextResolution.
5. Bounded handoff or continuation prompt.
6. Chat history only as non-authoritative background.

The deprecated Campaign automation must not become a parallel state model. `CMP-20260723-0FFA4F` is a stale paused App Store Connect projection that currently cannot be opened from its listed path. It may be inspected, migrated, or declared obsolete, but it must never be the sole source for Apple scope or completion.

## 3. Program map

### P0 — mandatory prerequisite

`ISS-20260729-BF2F89`: complete RC6 release closeout, merge the verified baseline, and clean its temporary workspaces.

Runtime implementation for the four result goals must not begin until the RC6 terminal revision is recorded. Planning, read-only audits, configuration inventory, and this documentation may occur before that gate, but must not mutate overlapping runtime files.

### Result Goal 1 — trustworthy execution evidence

Issue: `ISS-20260730-A1EA53`

Target outcomes:

- explicit `WorkKind`, `DispatchState`, and `EvidenceState` semantics;
- deterministic backward-compatible persistence migration;
- exact-revision validation evidence;
- a machine-readable Completion Receipt;
- distinct changed and `completed_no_change` completion paths;
- resumable commit, merge, cleanup, retry, and repair stages;
- bounded cross-session handoff that does not depend on chat memory.

This goal is the evidence foundation for context-aware remote effects and simplified Core work flows.

### Result Goal 2 — Apple context, capability, and release reliability

Issue: `ISS-20260730-84CE88`

The complete target is intentionally preserved. It has three layers.

#### A. Recover existing execution access

- App Store Connect typed plugin readiness and credential-provider references;
- Browser availability, Apple domain access, named browser profile, login, and 2FA handoff;
- Xcode selection and toolchain readiness;
- simulator and physical-device readiness;
- repository, nested project/workspace, scheme, Team, bundle, and ASC app identity.

#### B. Add durable context resolution

- versioned `ContextProfile` and `ContextBinding` records;
- repository-to-credential-provider, Team, app, Browser profile, project, scheme, device, and release-target bindings;
- additive/removable named Browser domain grants with deletion impact preview;
- bounded monorepo project discovery using `project_root`, `search_roots`, `max_depth`, and explicit ambiguity;
- action-level `ContextRequirement` declarations;
- bounded `ContextResolution` and transient redacted Context Capsule;
- independent claim kind, verification state, confidence, timestamps, validity, provenance, and verification inputs;
- field-, action-, and risk-specific precedence and conflict handling;
- targeted invalidation and last-known-good preservation.

`desired` intent is not an observed or verified fact. Explicit arguments do not automatically override conflicting repository bindings for high-risk remote writes or release actions. Simulator-only actions must not be blocked by absent App Store Connect context.

#### C. Complete typed Apple delivery

- capability inspection, preview, apply, and post-apply verification;
- entitlements reconciliation;
- Team and bundle signing verification;
- iCloud Containers and App Groups;
- Developer resources and certificate/profile preflight;
- archive and export;
- upload and processing wait;
- App Store assets;
- TestFlight and build assignment;
- metadata and readiness;
- resumable Apple Release Orchestrator;
- explicit human authorization immediately before irreversible production submission.

No private keys, passwords, cookies, login databases, session tokens, or other raw secrets may enter repository state, Context Capsules, logs, evidence, or receipts.

### Result Goal 3 — tool-surface convergence without capability loss

Issue: `ISS-20260730-B55445`

Tool-surface reduction is an architecture, schema, and model-attention optimization. It is not a permission model.

#### Core

A small ordinary-work facade, targeting five to seven tools and not exceeding ten without a documented exception. Candidate capabilities include access/status/inbox/context/work, explicit session binding, bounded search/read, and safe patching.

#### Advanced

All stable typed specialist tools remain exposed and callable, including repository, Git, Agent, legacy Campaign migration, Recovery, runtime, iOS, Browser, App Store Connect, and plugin actions.

#### Full

A superset that preserves compatibility and maintenance tools. Retired tools must be explicitly classified or migrated; they must not silently disappear.

#### Non-negotiable invariants

- Core omission is not `permission_denied`.
- Core must return structured `unsupported_in_core` guidance with required capability, reason, and Advanced route where applicable.
- Existing repository access, secret access, remote-write authorization, strong confirmation, and resource claims behave identically across exposure profiles.
- `Full >= Advanced > Core` and each profile has a deterministic distinct fingerprint.
- Presence in `tools/list` is insufficient: category-level invocation E2E must prove Advanced and Full capabilities are actually callable.
- Core facade E2E must prove ordinary work can start, inspect, patch, verify, finalize, merge, and clean with trustworthy evidence.
- Advanced remains the default during dual-connector Shadow. A Core default cutover occurs only after declared correctness, fallback, payload, latency, and capability-callability gates pass.

### Result Goal 4 — bounded bug-reduction Shadow

Issue: `ISS-20260730-CCF211`

The goal is earlier actionable defect discovery, not a claim that bugs can be eliminated.

The first validated mechanism must include:

- bounded verification packs for persistence, migration, retry/idempotency, uncertainty, contradictory evidence, and residual risk;
- structured Finding persistence with evidence, affected criterion, actionability, disposition, novelty, and timing;
- a cheap Risk Probe;
- selectively invoked, separately budgeted Challenge review;
- Baseline, Equal-budget Review, and Mechanism groups;
- precision, actionable rate, early-detection rate, escaped-defect rate where measurable, latency/cost overhead, and Harness self-failure rate;
- predeclared promotion and stop conditions;
- no production blocking while in Shadow;
- no Challenge conclusion as the sole rejection or completion authority.

This goal starts only after the evidence foundation, relevant context foundation, and tool-callability E2E are stable.

## 4. Dependency graph

The durable execution order is:

```text
ISS-20260729-BF2F89  RC6 clean terminal baseline
        |
        +--> ISS-20260730-A1EA53  execution evidence
        |
        +--> ISS-20260730-B55445 T1–T3  inventory/Core/routing
        |
        +--> ISS-20260730-84CE88 T1–T4  Apple inventory/bindings/browser/project

ISS-20260730-A1EA53 evidence baseline
        +--> ISS-20260730-84CE88 T5–T6 resolver/evidence integration
        +--> ISS-20260730-B55445 T4 Core rh_work convergence

Apple ContextRequirements + Core schema
        +--> ISS-20260730-B55445 T5–T7 E2E/Shadow/cutover
        +--> ISS-20260730-84CE88 T7–T9 capability/release delivery

Execution evidence + context foundation + tool-callability E2E
        +--> ISS-20260730-CCF211 bug-reduction experiment
```

Cross-Issue dependencies are architectural gates even when the current task store only enforces intra-Issue `dependsOn`. Every coordinator and worker must verify the external gates before launching a Task marked locally ready.

## 5. Execution unit and lifecycle

The unit of implementation is:

```text
one Task
  -> one WorkContract
  -> one isolated short-lived worktree and branch
  -> bounded implementation
  -> exact-revision checks
  -> commit
  -> integration
  -> cleanup
  -> Completion Receipt and Issue update
```

A result Issue is not one giant long-lived worktree. Program intent lives in this charter and Issue/Task state; deleting a completed worktree must not delete the objective or evidence.

Every implementation Task must state:

- repository and checkout/base revision;
- Issue ID and Task ID;
- objective and non-goals;
- allowed and forbidden paths;
- acceptance criteria and named checks;
- external dependencies and their verified revisions;
- risk, remote-write, secret-access, destructive, and approval requirements;
- expected output and cleanup conditions.

## 6. Parallelism policy

Initial maximum:

```text
2 code-changing worktrees
+ 1 read-only investigation or reversible configuration recovery
```

Increase concurrency only after execution evidence, integration, and cleanup are proven reliable.

Tasks may run in parallel only when:

- their external and internal dependencies are satisfied;
- their primary file ownership does not overlap;
- they do not concurrently change the same core type, schema, persistence record, or generated inventory;
- merge order and base-refresh policy are explicit;
- each Task has an independent WorkContract and checks;
- no worker relies on uncommitted changes in another worktree.

A reasonable first independent set after RC6 is:

- authoritative tool inventory (`ISS-20260730-B55445:T1`);
- Browser named domain/profile investigation or implementation after Apple profile persistence allows it;
- monorepo iOS discovery after Apple profile persistence allows it.

The following should not be developed concurrently against the same base without explicit ownership partitioning:

- Work evidence/Completion Receipt core types;
- Context Resolver/Context Capsule core types;
- Core `rh_work` schema and operation handlers.

## 7. Coordinator rules

At the start of every coordination session:

1. Start and bind a repo-harness session explicitly to the registered Controller repository for `moretea-labs/matea`.
2. Read this charter and `docs/runbooks/RELIABILITY-SESSION-PROTOCOL.md`.
3. Read `ISS-20260730-AE1BCC`, all four result Issues, the RC6 gate Issue, the project board, recent Work, active Runs, edit sessions, and repository status.
4. Treat controller state and repository state as authoritative even when the prompt contains older IDs or statuses.
5. Reconcile stale/duplicate/abandoned work before launching new work.
6. Verify cross-Issue gates manually before selecting a locally ready Task.
7. Prefer the smallest ready Task with a clear scope and complete acceptance criteria.
8. Record every completed revision, receipt, unresolved blocker, and next safe Task in durable state before ending the session.

Do not ask the user to restate known goals. Do not create duplicate Issues merely because a new chat lacks history.

## 8. Worker rules

A worker session handles one Task unless explicitly assigned a bounded non-overlapping set.

Before editing:

- read the Issue in full;
- inspect task readiness;
- verify external gates;
- inspect active Work, edit sessions, and file ownership;
- prepare or resume the exact WorkContract;
- use a new isolated worktree for code changes;
- refresh from the current integration base;
- stop on conflicting active ownership or contradictory evidence.

During work:

- stay within allowed paths and declared objective;
- do not silently broaden the architecture;
- update tests and documentation required by acceptance criteria;
- collect partial findings early;
- persist checkpoints before an interruption or risky transition;
- never place credentials or private data in tracked files or handoff text.

At completion:

- inspect the bounded diff;
- run named focused checks and required regression checks on the final revision;
- finalize through the WorkContract;
- commit and integrate using the declared target;
- delete the branch and worktree promptly;
- update the Issue/Task and related artifacts with the revision and evidence;
- distinguish completed changed work from verified already-satisfied/no-change work.

## 9. Program-wide acceptance gates

The program is complete only when all of the following are true:

1. RC6 and every result Issue have terminal, evidence-backed outcomes.
2. Changed and no-change completion are distinct and trustworthy.
3. Interrupted sessions can resume using stable IDs and repository/controller state only.
4. Context resolution is action-specific, provenance-rich, freshness-aware, redacted, and fail-closed for high-risk conflicts.
5. Apple stable identities do not need to be retyped every session, while temporary observations remain refreshable.
6. The complete Apple capability and release scope is delivered or an explicitly accepted non-goal supersedes it.
7. Core reduction has not changed permissions or removed stable capabilities.
8. Advanced and Full representative tools are invoked successfully in category-level E2E.
9. Core ordinary flows and Advanced fallback meet declared Shadow gates before any default cutover.
10. Bug-reduction mechanisms are promoted only by predeclared empirical gates.
11. No secrets are persisted in repository state, capsules, evidence, receipts, or prompts.
12. All completed task branches and worktrees are integrated and cleaned.

## 10. Stop and replan conditions

Stop the affected Task and persist a blocker when:

- RC6 is not actually terminal or its integration revision is unclear;
- another active Work owns overlapping files or core types;
- the repository base changes in a way that invalidates the Task contract;
- a required plugin, credential provider, browser profile, device, or remote service is unavailable and the Task cannot remain read-only;
- observed context conflicts with a durable binding for a high-risk action;
- validation evidence is stale, contradictory, or from another revision;
- implementation would require a new permission model, a second control plane, secret persistence, or capability deletion contrary to this charter;
- Shadow metrics do not meet declared promotion thresholds;
- worktree cleanup or integration cannot be proven.

Replan in the Issue and this charter when an architectural dependency changes. Do not hide the change in a worker prompt.
