# Reliability Program Cross-Session Protocol

Program anchor: `ISS-20260730-AE1BCC`  
Public repository: `moretea-labs/matea`  
Controller repository: select the registered repository identity at runtime  
Canonical charter: `docs/architecture/RELIABILITY-PROGRAM.md`

## 1. Why this protocol exists

A ChatGPT session is disposable. Program state is not.

A future session must be able to continue after truncation, model change, browser closure, local restart, or handoff to another worker without asking the user to reconstruct the plan. The minimum recovery key is the repository ID plus the program Issue ID. Task, Work, Run, checkout, branch, revision, and evidence IDs refine the recovery but do not replace reading durable state.

## 2. Stable IDs

- Program: `ISS-20260730-AE1BCC`
- Prerequisite RC6: `ISS-20260729-BF2F89`
- Execution evidence: `ISS-20260730-A1EA53`
- Apple reliability: `ISS-20260730-84CE88`
- Tool-surface convergence: `ISS-20260730-B55445`
- Bug-reduction Shadow: `ISS-20260730-CCF211`
- Stale legacy ASC Campaign projection: `CMP-20260723-0FFA4F`

Never infer that the stale Campaign is healthy merely because it appears in a list. Its record must be opened or migrated successfully before relying on it.

## 3. Universal session startup

Every new session performing repository work must execute the equivalent of:

```text
1. session_start
2. session_bind_repository(<REGISTERED_REPOSITORY_ID>, explicit checkout when known)
3. controller_context for the requested scope
4. read docs/architecture/RELIABILITY-PROGRAM.md
5. read this protocol
6. get_issue(ISS-20260730-AE1BCC, full)
7. get_issue(ISS-20260729-BF2F89, full)
8. get the relevant result Issue in full
9. get_project_board
10. work_list and active edit/run inspection
11. repository status and current base revision
```

Then reconcile the prompt with durable facts. The prompt may be stale; controller and repository state win.

## 4. Coordinator session algorithm

A coordinator advances the program, not a single code patch.

```text
A. Recover all stable state.
B. Verify the RC6 gate and record its terminal integrated revision.
C. Identify active, interrupted, blocked, integration-pending, and cleanup-pending Work.
D. Resume or repair existing Work before creating a duplicate.
E. Evaluate external cross-Issue gates for locally ready Tasks.
F. Select at most the allowed parallel set with non-overlapping ownership.
G. For each selected Task, produce a complete WorkContract and worker handoff.
H. Review outcomes, exact-revision evidence, integration, and cleanup.
I. Update Issues/artifacts with receipts, blockers, and next safe Tasks.
J. End with a session checkpoint or bounded continuation prompt.
```

The coordinator must not launch runtime implementation while RC6 remains non-terminal. A locally ready Task is not globally ready when its external gate is unmet.

## 5. Worker session algorithm

A worker receives an Issue ID and Task ID.

```text
A. Start/bind the session and read the charter, protocol, Issue, and Task.
B. Inspect task readiness and manually verify cross-Issue gates.
C. Search for existing Work by Task/goal/request ID.
D. Resume that Work if valid; otherwise prepare exactly one isolated worktree.
E. Inspect current files and tests before editing.
F. Implement only the Task objective inside allowed paths.
G. Keep acceptance-criterion-to-change/test traceability.
H. Inspect diff and run checks on the final revision.
I. Finalize: commit -> merge/integrate -> branch cleanup -> worktree cleanup.
J. Persist the Completion Receipt, integrated revision, residual risk, and next dependency state.
```

Do not create a new Issue because implementation is difficult. Amend or split the existing Issue only when the durable objective or ownership boundary truly requires it.

## 6. Interruption recovery

When a session is interrupted before finalization, the next session must not start a replacement Work immediately.

Recovery sequence:

```text
1. work_get(work_id) when supplied.
2. work_list(repo_id) when the ID is missing.
3. Match goal_id / Issue:Task / request_id / branch / worktree.
4. work_inspect(detail) and inspect repository status/diff.
5. Classify the state:
   - prepared, no changes;
   - changing, uncommitted;
   - validation pending/failed/stale;
   - commit pending/failed;
   - integration pending/blocked;
   - branch cleanup pending;
   - worktree cleanup pending;
   - completed changed;
   - completed_no_change;
   - abandoned/stale and safe to discard.
6. Resume from the last proven stage.
7. Never repeat a remote or irreversible effect without idempotency/evidence checks.
```

If the supplied Work ID belongs to another repository, revision, or Task, stop and report the mismatch rather than rebinding it silently.

## 7. Handoff packet

Before a session ends with unfinished work, persist or output this bounded packet:

```text
Repository ID:
Checkout ID / worktree path:
Program Issue:
Result Issue:
Task ID:
Work ID:
Run/Edit Session IDs:
Base revision:
Current HEAD:
Branch:
Objective:
Non-goals:
Allowed/forbidden paths:
Acceptance criteria:
Completed changes:
Current diff/status:
Checks run and exact revisions:
Open blocker or stale evidence:
Remote/secret/destructive effects already performed:
Next single safe action:
Finalize/merge/cleanup state:
```

Do not include credentials, raw cookies, private keys, unbounded logs, or hidden reasoning.

## 8. Parallel session rules

A coordinator may assign parallel workers only when file and semantic ownership are independent.

Before launch, record:

- Task IDs and Work IDs;
- base revision for each worker;
- primary owned paths/types;
- prohibited overlap;
- merge order;
- which worker must refresh after another merge;
- common checks that run after integration.

Maximum initial concurrency is two code-changing workers plus one read-only/configuration worker.

Do not parallelize Work evidence core types, Context Resolver core types, and Core `rh_work` schema against the same integration base unless the plan explicitly partitions interfaces first.

## 9. Tool-surface invariant for every session

Core, Advanced, and Full are exposure profiles, not permission tiers.

A session must reject any implementation that:

- maps a Core-hidden capability to permission denial;
- removes a stable typed Advanced/Full tool to reduce Core size;
- changes authorization merely because a profile changed;
- lets a generic facade bypass specialist typed schemas and confirmation gates;
- declares capability preservation based only on `tools/list` without invocation E2E.

When Core cannot perform a specialist task, route to Advanced and preserve the same repository, Work, context, evidence, and authorization identities.

## 10. Apple safety invariant for every session

- Reuse credential providers; never copy secrets into repo state.
- Use opaque profile/binding references.
- Verify Team, app, project, scheme, bundle, signing, and target identities before remote writes.
- Treat explicit-input versus binding conflict as a stop for high-risk actions.
- Keep simulator-only work independent from ASC and physical-device readiness.
- Reverify stale observations rather than deleting durable identity.
- Require explicit authorization at the final irreversible production boundary.

## 11. Completion and cleanup

A worker is not done after writing code or obtaining a passing test once.

Completion requires the Task-specific subset of:

- objective and acceptance traceability;
- exact-revision focused checks;
- required regression checks;
- mutation evidence or verified already-satisfied evidence;
- commit evidence;
- integration evidence;
- branch deletion;
- worktree cleanup;
- updated Issue/Task state and Completion Receipt.

If merge or cleanup fails, the Work remains resumable and non-terminal. The next session continues that stage; it does not create a new implementation Work.

## 12. Copyable coordinator prompt contract

Use this contract in a new ChatGPT session. It intentionally tells the session to recover current state instead of trusting embedded status.

```text
Use repo-harness6 to continue the Repo Harness Reliability and Context Convergence Program.

Repository ID: <REGISTERED_REPOSITORY_ID>
Program Issue: ISS-20260730-AE1BCC
Mandatory RC6 gate: ISS-20260729-BF2F89
Result Issues:
- ISS-20260730-A1EA53 execution evidence
- ISS-20260730-84CE88 Apple context/capability/release
- ISS-20260730-B55445 Core/Advanced/Full tool-surface convergence
- ISS-20260730-CCF211 bug-reduction Shadow

Start with session_start and explicit session_bind_repository. Read the program charter and cross-session protocol, then read the program Issue, RC6 Issue, all result Issues, project board, recent Work, active Runs/edit sessions, and repository status. Treat repository/controller state as authoritative and do not create duplicate Issues or Work.

First reconcile interrupted, integration-pending, cleanup-pending, or stale Work. Do not modify runtime code until RC6 is terminal, merged, and its revision is recorded. Select the next globally ready Task by checking both intra-Issue dependencies and the cross-Issue gates in the charter.

Tool-surface reduction is architecture/exposure optimization only, never a permission change. Core must stay small, Advanced must retain every stable typed capability, Full must retain compatibility/maintenance capability, and representative tools must remain actually callable through category-level E2E.

Preserve the complete Apple scope: credential/profile and repository bindings, Browser domain/profile handling, monorepo project discovery, action ContextRequirements, resolver/capsule/evidence integration, Xcode capabilities, signing, iCloud/App Groups, archive/export/upload/processing, assets, TestFlight, metadata, and release orchestration. Never persist secrets.

For implementation, use one Task -> one WorkContract -> one isolated worktree. Inspect before editing, stay within scope, validate the exact final revision, commit, merge, delete branch, clean worktree, and persist the Completion Receipt. Parallelize only non-overlapping globally ready Tasks, initially no more than two code Worktrees plus one read-only/configuration task.

Advance as much as safely possible in this session. At the end, report stable IDs, integrated revisions, evidence, unresolved blockers, and the next executable Task.
```

## 13. Copyable worker prompt contract

Replace only the bracketed fields.

```text
Use repo-harness6 to execute exactly one Task in the Repo Harness Reliability and Context Convergence Program.

Repository ID: <REGISTERED_REPOSITORY_ID>
Program Issue: ISS-20260730-AE1BCC
Result Issue: [ISSUE_ID]
Task: [TASK_ID]
Existing Work ID, if any: [WORK_ID_OR_NONE]

Start with session_start and explicit session_bind_repository. Read docs/architecture/RELIABILITY-PROGRAM.md, docs/runbooks/RELIABILITY-SESSION-PROTOCOL.md, the program Issue, RC6 issue ISS-20260729-BF2F89, and the full Result Issue. Inspect task readiness, recent Work, active Runs/edit sessions, repository status, and external cross-Issue gates. Durable state overrides this prompt.

If an existing valid Work exists, resume it instead of creating another. Do not start runtime implementation unless RC6 is terminal and merged. Prepare one isolated worktree, bind a complete WorkContract to [ISSUE_ID]:[TASK_ID], and remain inside its allowed paths, objective, non-goals, checks, and acceptance criteria.

Do not create a second control plane, persist secrets, weaken authorization, interpret Core exposure as permissions, or remove stable Advanced/Full capability. For high-risk Apple actions, stop on unresolved identity/context conflict and preserve explicit human authorization gates.

Implement and test the Task fully. Inspect the final diff, run exact-revision checks, then finalize through commit, merge, branch deletion, worktree cleanup, Completion Receipt, and Issue/Task update. If interrupted or blocked, persist a bounded handoff with the Work ID and next single safe action rather than creating replacement work.
```
