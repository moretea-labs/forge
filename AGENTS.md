# Forge AGENTS.md

This repository self-hosts the Forge contract. Retired project-skill and project-initializer staging paths are not supported or cleaned up by current tooling. Claude and Codex should follow the same Controller-first authority model; mutable workflow state is Controller-owned, not a repo-local file protocol.

## Forge execution runtime

Treat ChatGPT as the controller and Forge as its repository execution layer. ChatGPT chooses how to inspect, plan, edit, verify, or delegate. Forge provides deterministic repository tools and does not impose an Agent-first workflow.

- **Verification & Test Strategy (2026-10-29):** Use acceptance-test-driven development for regression-prone behavior: identify previous real success and current failure; reproduce RED; implement the smallest GREEN fix; preserve old safety/liveness tests and then verify the real behavior before claiming a live fix. New focused tests are allowed; the temporary no-new-tests freeze is retired. Mocks/ledgers cannot replace actual Browser→ChatGPT→Supervisor continuation receipts. Follow `docs/architecture/CURRENT.md` for automatic continuation.

- Scheduling, explicit workspace placement choice, integration timing, baseline activation, delivery, and acceptance are model decisions made from the user's current objective and live repository evidence. Forge supplies callable execution primitives and fixed mechanical compatibility mappings only; it must not infer, gate, override, or auto-advance semantic workflow decisions from a Work transition, executor completion, risk classification, policy, or heuristic. Repository rules guide the model; they are not a Forge workflow state machine.

- **Progressive code discovery / goal coverage (2026-10-29):** For migrations, API retirement or architecture-wide behavior changes, begin from the original Requirement acceptance and current HEAD; discover entry points broadly, read exact owners, then follow discovered callers, indirect scheduler/transport/adapter paths, tests and documentation. When a bounded search reports omitted, truncated, denied or uninspected candidates, assess which relationships materially affect the goal and use focused `rg -l`, exact reads or explicit language-server references to close them. Revise the implementation scope when new evidence or failing tests expose more callers, and repeat reverse-reference checks after removing the old path. This is a model-owned evidence loop, **not** a fixed search quota, new Agent, state machine or mutation gate. Straightforward local edits retain their short path.
- Direct Edit is the default for understood work. One session may accept many patch batches, keep revision history, create savepoints, run checks, roll back selected revisions, and finalize one aggregate localized diff.
- Tasks describe objectives, scope, checks, and acceptance criteria. They do not permanently bind Codex, Claude, or GitHub Copilot. The executor is selected when each Run starts.
- Agents are optional implementation tools for broad exploration, large refactors, or compile/test/fix loops. They receive a high-level implementation contract; ChatGPT still reviews the result and decides what happens next.
- Ordinary local risk levels are metadata, not permission gates. There is no approval queue and no `approve_risk` handshake. Only an explicitly destructive or irreversible operation requires authorization in the same request.
- The Controller UI is an auxiliary configuration/state utility behind ChatGPT: Overview, Work, Automations, Capabilities, Repositories, Settings, and System. It presents durable user-facing state and hides Issue/Task/Run internals unless diagnostics require them.
- Hard runtime boundaries remain for secrets, credentials, Git internals, concurrent write conflicts, out-of-scope writes when a scope is declared, and remote or irreversible side effects.

### Development Environment & Execution Model (2026-10-27)

- **Multi-platform development.** Both macOS and Windows WSL2 are authorized source development environments. The same branch/worktree/Work must have only one active Writer at any time; multiple checkouts can work on independent scopes/branches in parallel but cannot concurrently mutate the same integration target or effect. Respect existing Work ownership—do not take over another environment's active Work.

- **Lightweight execution path.** For bounded, understood changes: inspect source → edit → run targeted checks → review diff → commit/report. Do **not** create Requirement/Plan/Work/Supervisor/approval machinery merely because a task touches multiple files. Save complex orchestration for genuinely cross-cutting architecture, multi-stage delivery, or long-running autonomous continuation.

- **Complexity threshold.** Use Plan/Supervisor for: substantive cross-cutting architecture decisions, unresolved design trade-offs, multi-stage dependent delivery, or work requiring continuation across sessions. Reuse existing Requirement/Plan/Work/Supervisor lineage. A finite complex change completable in one session does not automatically need durable Work.

- **Independent review at boundaries.** For complex work, obtain independent design/acceptance review by default unless an explicit current user/project decision defines a narrower acceptance boundary for that work. A waived independent review never waives verification: the active Writer must perform a complete exact-candidate diff review and proportionate automated/live validation, and record the evidence. Do not create a Reviewer lifecycle merely to satisfy process when the active acceptance policy explicitly waives it.

### Forge-source PR continuation (repository-local model guidance)

These rules apply **only when developing this Forge repository**. They are not Forge Runtime policy or generic project requirements.

- **Smallest delivery path.** Keep bounded changes on Direct Edit with proportionate verification and diff review. For materially cross-cutting changes or multi-stage delivery, the model may choose one isolated branch and one reviewable PR when isolation is needed, preserving any already selected checkout. Reuse existing Requirement/Plan/Work/Supervisor.
- **Use existing continuation owner.** GitHub owns remote PR/CI/review facts; Forge Requirement owns the semantic goal and remaining acceptance gaps, while Work/Plan are optional working context; Git/Forge own branch/CAS and sole Writer. On an actual continuation, check latest HEAD, CI, blockers, any review verdict required by the active acceptance policy, and the original effect receipt, then perform only the next useful action. Never start a second Supervisor or retry a send whose outcome is unknown. First reconcile the exact effect read-only; transfer the sole future-send right only after evidence and explicit ownership handoff. No global polling or PR lifecycle engine.
- **One PR, exact-candidate review and independent goal coverage.** Review the pinned HEAD, cumulative diff, original Requirement obligations, unchanged but relevant entry points, reverse callers and test/CI evidence on the existing PR/Work. Independent review is required when the active user/project acceptance policy requires it; an explicit no-third-party-review decision instead uses the established Writer's complete exact-candidate review plus the declared automated/live evidence. Material fixes require a new exact-candidate review under the same policy.
- **GitHub Issue auto-close safety.** Intermediate PR descriptions and commit messages reference issues as `Refs #123` or `Issue #123 remains OPEN`. GitHub closing keywords directly before issue numbers can auto-complete an issue even in a negation; check `closingIssuesReferences` before merge. Final Issue closure follows independent original-goal acceptance, not a partial PR merge.
- **Integration after acceptance.** Only the established Writer may merge after the acceptance evidence required by the active user/project policy, required CI, Git CAS, and Work obligations are satisfied. Confirm the actual merged commit and post-merge Runtime behavior before marking DONE. Accepted PR is not proof of runtime activation or migration completion.

### Starting checkout and worktree policy

- `main` is the canonical local integration branch. Bounded Direct Edit/investigation that does not need durable Work normally runs in the selected current checkout.
- Work lifecycle and Git topology remain separate decisions: Forge never creates durable Work merely to obtain a branch. Placement is a fixed mechanical contract: the default (`auto`, and its explicit spelling `reuse`) shares the selected registered current checkout, including a legitimately dirty one (the pre-Work dirty baseline is recorded on the WorkHandle for later attribution); only an explicit `new_worktree` freezes a fresh managed isolated checkout with the Work start revision frozen.
- Forge must not infer or rewrite placement from task size, risk text, dirty paths, parallel relations, recovery state, or other semantic context. `auto -> current` is the fixed mechanical placement contract, not a semantic heuristic; isolated placement is an explicit model choice reserved for cases that genuinely need a frozen base or write isolation.
- During implementation, a Work may advance only through its own checkout changes/commits. Target-branch advancement is considered only at the delivery/finalization boundary; if an explicitly reused current checkout drifts, return the WorkHandle/Git conflict instead of adopting, rebasing, merging, or switching topology.
- An isolated worktree is containment, not a semantic integration authority. After successful delivery, remove its managed worktree/branch only after containment and cleanup are proven. Do not accumulate completed worktrees as standing development environments.
- Worktree convergence is a named retention policy, not a semantic workflow step: (1) abandoned open Works are surfaced by maintenance discovery, but semantic closure stays an explicit controller action — the `discard_work` capability action cancels an open Work through explicit semantic CAS (refusing on revision conflict), then converges its resources; (2) a dirty retained managed worktree keeps its bytes in place but has the same explicit exit — `discard_work` archives the tracked diff and untracked files (plus a branch bundle for unique commits) and then removes the worktree/branch; (3) managed-storage worktree directories referenced by no WorkHandle, WorkContract, or registered checkout are swept as orphan crash residue after an age grace period. Maintenance never auto-cancels semantic Work, and adding new cleanup blockers without adding one of these exits is an architecture defect.
- Do not inspect, activate, switch, certify, or otherwise mutate a source/runtime baseline merely because a Work changes phase or an executor exits. Baseline activation remains a separate model decision after the coherent candidate is reviewed and verified.

### Dirty checkout and cross-Work integration policy

- A Work may freely keep uncommitted changes in its selected checkout while it is implementing, reviewing, or repairing its own candidate. A dirty checkout is normal development state and is not itself a Forge error, lifecycle state, or reason to switch topology.
- **User-directed conflict-based integration rule (2026-10-15):** A receiving checkout's staged, unstaged, or untracked changes are **not by themselves a merge gate** and do not require the receiving Work to commit first. Inspect exact source and target revisions, merge base, candidate changes, receiving dirty paths and contents, and Git's actual merge result. When the reviewed changes can be integrated without overwriting existing work or changing its index state, proceed through an authorized safe Git path. A coarse `WORK_DELIVERY_TARGET_DIRTY` tool rejection is not evidence of an actual Git merge conflict.
- If source and receiving changes overlap or Git reports a real conflict, inspect both implementations and resolve the specific semantic difference. Preserve concurrent-writer ownership and mutation leases; those are separate from merely having uncommitted changes. Never repeat a branch whose equivalent changes are already integrated under other commit IDs.
- Do not auto-stash, auto-reset, auto-clean, silently commit, or discard receiving changes merely to complete integration. Verify that original uncommitted bytes, staged/unstaged distinctions, and untracked files are preserved after a merge. If a primitive cannot preserve them safely, identify the mechanical limitation and choose another authorized, non-destructive integration path.
- When committed histories conflict, resolve semantically from the merge base, both sides' commits/diffs, and the current Requirement/Plan/Work objective. Preserve the current architecture and replay the other Work's intent onto it when implementation shape has changed; never use `ours`/`theirs`, timestamp, or commit order as a general semantic authority.
- These are Controller/model workflow rules, not new Forge Kernel policy. Do not add merge lifecycle states, automatic integration policy, or repository guards merely to encode this procedure; Forge should expose the Git/worktree/diff/commit primitives and report real Git or concurrent-writer conflicts mechanically.

## Root-Cause-First Learning Discipline

- Treat a newly observed failure or inefficiency as evidence, not an automatic patch trigger. Accumulate and cluster related symptoms by violated invariant, semantic owner, authority, and lifecycle before changing source.
- Default learning loop: `observe -> cluster -> identify common root cause -> one coherent correction -> whole-diff review -> focused verification -> institutionalize the reusable rule/capability`. This is the **Root-Cause-First / Batch-Convergence** default; do not turn every symptom into its own patch/Work/validation cycle.
- **Learn early, trust gradually.** The model decides whether an observation is reusable, how abstract it should be, and the narrowest justified scope. Repetition/evidence may change the model's confidence or support a broader abstraction, but Forge must not use fixed counts, kinds, keywords, scores, or failure frequency as semantic admission/generalization gates.
- Project observations normally become Project lessons; when the model explicitly judges a distilled principle genuinely cross-project it may record portable Workspace advisory memory. Workspace scope is a semantic choice by the model, not an automatic promotion rule and not restricted to human-authored wording. Neither scope silently overrides product/domain contracts, architecture authority, authorization, Requirement/Plan/Work, acceptance, or verification gates.
- Emergency containment is narrow: active security exposure, data corruption/loss, production-wide outage, or a foundational blocker that prevents safe investigation may receive the smallest reversible containment first. Containment must be recorded as such and followed by root-cause closure; it is never the final architecture.
- When a learned pattern can recur, prefer strengthening the existing typed contract, workflow, architecture rule, or gate over retaining a prose-only lesson. Do not create a second learning store, policy authority, lifecycle owner, fallback, or project-specific helper.

## Mandatory Delivery Transaction

### Current Task Lineage Isolation

- The current task is selected by explicit user intent and the exact current Work/Requirement/Plan lineage. Repository-wide active Work is not a task queue.
- `rh_status`, Plan listings, scheduler inventories, and other global projections may be consulted only to detect path conflicts, writer/authority ownership, blockers, or release admission conditions. They must not cause unrelated Work to enter discovery, implementation, validation, review, release, cleanup, or completion decisions for the current task.
- Do not switch to another active Work because it looks urgent, is nearby in the repository, shares a broad Requirement, or appears in a global status response. A task switch requires explicit user intent or an explicit typed lineage transition from the current Work/Requirement.
- When global state contains unrelated active Work, ignore its objectives and evidence unless they directly conflict with the current Work's files/authority or block the current delivery boundary. Record the conflict narrowly; do not absorb the unrelated Work.
- When reporting progress, count only the current lineage. Repository-wide active counts must be labeled as unrelated inventory and never presented as remaining work for the current task.

For Kernel V2 and other architecture migrations, optimize for one coherent delivery transaction rather than issue-by-issue lifecycle churn.

- Default execution shape: `read actual source/goal -> choose smallest complete vertical slice -> coherent edit -> real-outcome verification -> whole-diff review -> deliver`. Existing Work/Plan and required candidate/release checks remain available; routine changes must not pay a mandatory lifecycle or gate sequence.
- Do not create a new Work, commit, validation cycle, or release merely because a new symptom, file, or same-root-cause path is discovered. Extend the current candidate when the architecture invariant and delivery objective remain the same.
- During implementation, do not repeatedly re-check baseline, run broad gates, stage Candidate releases, or activate Runtime baselines. Early checks are reserved for facts that can invalidate the architecture/design or for safety-critical ambiguity.
- Git commits are delivery/history boundaries, not Work/lifecycle boundaries or scratch savepoints. Preserve intermediate state with the Work/edit-session/savepoint mechanisms and keep related implementation, review fixes, verification repairs, and same-goal Works in the same checkout without committing between them. Default to one semantic commit for the coherent delivery transaction; create additional commits only when they represent genuinely independent, reviewable delivery units. Never create commits whose subject is merely a lifecycle transition such as `Complete work-*`; commit subjects describe the product/architecture/source change, not Forge record ids.
- Release is a Requirement/candidate boundary, not a per-Work boundary. Use one identified source/target/candidate and the receiving branch policy, reuse valid evidence tied to exact inputs, and separate source merged, Runtime activated, and user-visible outcome confirmed. Do not start Candidate/canary/cutover while the source is still moving; do not label a release complete just because tests or a PR passed.
- A failed focused/canonical check returns to the same candidate and reruns only the affected check set after repair unless the failure invalidates the architecture. Do not restart the entire lifecycle by default.
- Accept the original user goal, not a proxy milestone: implementation, documentation, tests, PR merge, and Work completion are evidence, not interchangeable with a functioning product. Before saying done, verify the actual end-to-end behavior on the relevant target, or explicitly state the unverified boundary and keep the goal open. For a UI task this includes observing the rendered interaction; for release it includes the delivered target; for architecture cleanup it includes retired callers/writers and preserved behavior.
- A change adding a module, compatibility branch, fallback, writer, state, or Gate must identify the concrete current requirement and explain why modifying/removing an existing owner cannot satisfy it. Complete migration by removing the retired path and its obsolete checks in the same coherent delivery when technically possible; no hypothetical long-term compatibility.
- Before opening another Work for an observed defect, cluster symptoms by root cause and owner. If the new fact belongs to the same invariant, keep it in the current Work; only a genuinely independent authority, delivery, security boundary, or architecture decision justifies a sibling Work.
- Superseded, covered, or delivery-complete Work/Plan records must be reconciled and retired promptly so active lifecycle state represents real remaining work.
- If lifecycle machinery itself is inefficient but the current V2 candidate can still converge safely, record a bounded post-V2 Plan and defer the machinery refactor. Do not expand the current release scope to fix the workflow that is executing it.
## Canonical Workflow Authority

- Root `forge.config.json` is the modern declarative opt-in marker. It selects Controller Home Runtime authority; it is not a mirror of mutable state.
- Mutable Requirement/Plan/Work/ControllerRound, Process/Job, Schedule, lease/resource, authorization, verification, Plugin config, session/binding, evidence and recovery state belongs in Controller Home.
- Repository-authored durable surfaces include source/tests, `docs/spec.md`, `docs/researches/`, `tasks/todos.md`, `tasks/lessons.md`, architecture docs, and intentional human-authored project plans/config.
- `tasks/current.md`, `tasks/contracts/`, `tasks/reviews/`, `tasks/notes/`, `tasks/workstreams/`, `.ai/harness/**`, repo-local Plugin mutable config, and repo-local cache/session state are legacy migration inputs, not current machine authority and must not be recreated by new producers.
- Git history is the repository source-history archive. Runtime history/receipts use Controller Home retention policy rather than repository archive directories.
- `.ai/context/capabilities.json` may remain declarative capability/context metadata while it is still part of the source contract; it must not point at retired runtime workstream directories.
- `docs/architecture/CURRENT.md` is maintained architecture authority; executable code and persisted schemas remain authoritative implementation evidence.
- Host/global prompt files explain working behavior but do not authorize mutation, own lifecycle, or declare completion.

## Runtime Architecture Guardrails

- Treat Forge as one local MCP application, one active Runtime, one deployable release, and one in-process lifecycle owner. Gateway, MCP transport, Controller, and Scheduler may be modules; they are not independently deployable generations by default.
- Bounded restart downtime is acceptable. Prefer `stop -> switch complete release -> start -> verify -> full rollback`; do not add ingress, blue/green slots, adoption, or mixed generations without an explicit product requirement.
- Do not respond to an incident by adding a second status authority, daemon, proxy, KeepAlive wrapper, watchdog, recovery owner, or fallback path; extend the canonical Runtime or standalone Recovery owner instead. First identify the violated invariant and remove, merge, or correct the existing cause.
- When a concrete scenario exposes a missing capability, strengthen an existing general capability and reuse its authority/lifecycle first. Add a specialized plugin, module, script, or helper only when an independent authority, security, protocol, persistence, or lifecycle boundary is proven; incident-specific helpers are temporary debt otherwise.
- Readiness is one derived whole-system conclusion. Multiple diagnostic checks and reason codes are allowed, but they must not become independent durable readiness state machines.
- Keep lifecycle, readiness, liveness, capability, authorization, release identity, and diagnostics separate. Do not create composite states such as `status=ready` with `degraded=true`.
- Only one component may perform lifecycle or recovery side effects. Observers and probes are read-only and submit typed requests to that owner.
- Autonomous execution is **single-attempt-first**. A normal external mutation should succeed once; retry exists only for a mechanically classified transient failure with preserved causal identity. The same external mutation may have at most **3 total provider attempts** (initial attempt plus at most 2 retries), with exponential backoff and provider Retry-After/cooldown respected.
- Outcome-unknown observation and provider re-dispatch are different mechanisms. Unknown observation is read-only, must never authorize resend by itself, must have its own durable spacing/budget, and must not poll an unchanged Browser/Computer surface at active tick rate. Prefer event-driven wakeups or materially new evidence; repeated identical unknown observations are diagnostic noise, not progress.
- Recovery must reduce uncertainty, not create activity. If bounded retries/observations are exhausted, expose one durable blocker/diagnostic fact and stop. Never add an infinite retry loop, watchdog cascade, replacement tab/session, or second recovery owner to make autonomous continuation appear live.
- Release and rollback scope is the complete compatible Runtime, configuration, entrypoint, and SQLite schema/backup state; component-level rollback is forbidden.
- Any new process, persistent state, enum value, health mode, authority file, or compatibility fallback requires an explicit architecture decision, transition owner, cleanup/removal criterion, and failure-injection tests.
- Follow `docs/reference-configs/runtime-architecture-guardrails.md` for the normative review gates and target topology.

## Architecture Completeness & Drift Control

- Prompt instructions improve reasoning attention but are advisory. High-risk correctness is enforced by Context Closure, Engineering Design receipts, Plan/Work authority, scoped authorization/resource fences, verification evidence, and implementation review.
- Before high/critical-risk, architecture-changing, persistence, authorization, concurrency, external-effect, migration, release, or shared-contract mutation, explicitly close the cross-cutting design areas: semantic identity/scope, authority/single writer, authorization/trust, resource fencing, lifecycle/retention/GC, persistence/schema/integrity/backup/restore, idempotency/replay/outcome-unknown reconciliation, evidence/audit/redaction, recovery/failure domain, deployment topology, capacity/backpressure/fairness, time, performance, security/privacy, portability, release/rollback, and migration retirement.
- A successor Plan must reconcile every unresolved predecessor obligation as `KEEP`, `CHANGE`, `DEFER`, or `DROP`. `CHANGE`/`DEFER`/`DROP` require Controller rationale; `KEEP`/`CHANGE` must point to the successor location carrying the obligation. Silent scope or acceptance loss blocks approval.
- Every persistent writer must name semantic owner/scope, single-writer rule, schema/version policy, mutation authority, terminal condition, retention/GC, recovery behavior, and sensitive-data policy. Directory placement is not ownership proof.
- Implementation review must compare the exact candidate against the same accepted product/design/Plan obligations. Passing tests cannot legalize architecture drift, and architecture prose cannot legalize failing behavior.
- Prefer enforcing invariants in typed contracts/domain APIs/AST or focused semantic tests. Regex/source-string fences are temporary migration assertions with explicit removal triggers.

## Enforceable Module Boundaries (All Development)

- Every source change must respect [module ownership, import boundaries and Rust migration rules](docs/architecture/CURRENT.md#module-boundaries-and-language-evolution). The existing `check:task` gate executes the structural `check-module-boundaries.mjs` check.
- New kernel-to-legacy imports and private sibling-domain imports are forbidden. Existing exact legacy edges are shrinking migration debt, never a new dependency allowance.
- Architecture decisions change owners only after migrating callers and retiring old writers/paths; ordinary refactors do not need extra lifecycle or ADR bureaucracy.

## Kernel V2 Development Discipline

- Treat Kernel V2 as a domain/authority migration, not an issue-by-issue patch campaign. Before adding state, lifecycle logic, provider routing, compatibility code, or a new process, identify the single owning module and remove or retire competing owners.
- Prefer a modular monolith with explicit ports/adapters. Kernel/domain packages define semantics and ports; protocol packages define neutral contracts; adapters depend inward on those contracts; apps/composition roots wire implementations. Kernel and plugin-runtime packages must not depend on concrete adapters, MCP transport, CLI/UI implementations, or provider identities.
- Every domain has one public API and one mutable authority for each durable fact. Cross-module callers consume the public API/port instead of sibling internals. Duplicate enums, shadow state machines, mirrored persistence, and second lifecycle owners are architecture defects to merge or delete, not compatibility conveniences.
- During migration, legacy `src/cli` / `src/runtime` owners may survive only as bounded compatibility facades around the new owner. A compatibility shim must have a named replacement owner, a bounded consumer set, and an objective removal condition; new production consumers are forbidden. Compatibility is migration debt, not a permanent architecture layer.
- Do not use fallback-first, workaround-first, extra-daemon, duplicate-authority, or silent-degradation patches to make a failing path appear healthy. Repair the violated invariant or missing general capability. Fail-closed behavior remains appropriate only at genuine safety, authorization, ambiguous-mutation, or unsupported-contract boundaries; it is not a substitute for completing the architecture.
- Architecture enforcement preference is: TypeScript/compiler contracts -> package/public-API boundaries -> AST/import/dependency-graph rules -> focused semantic contract tests -> temporary migration assertions. Raw source-string/regex checks and source-line-count limits are not long-term architecture authorities when the invariant can be expressed structurally.
- Any temporary architecture assertion must explain the debt it fences and its removal trigger. Debt ledgers must only shrink: when the legacy edge/shim disappears, delete the assertion/allowlist entry in the same slice instead of preserving historical baggage.
- Work in coherent batches: batch factual reads -> centralized analysis -> one coherent implementation/patch -> batch architectural review -> focused validation. Avoid repetitive micro-checks after each file. Run broader multi-review and whole-candidate validation at Kernel V2 milestone/candidate boundaries before any runtime baseline activation.
- Keep Kernel V2 source development on the designated integration/main branch until the integrated candidate is complete. A clean current mainline checkout is the default source-development placement; do not create an isolated branch/worktree merely because a Plan or Work exists. Do not activate a partially migrated slice as the Runtime baseline merely because its local checks pass; baseline activation is a separate candidate-level decision after architecture review and validation.
- Forge-core additions should solve reusable system capabilities or preserve a Kernel invariant. Do not expand Forge with project-specific one-off machinery when an adapter/plugin or existing general primitive is the correct owner.

### Verification & Test Value Discipline (2026-10-27)

- **Behavior-first, not test-first.** A failing historical test is evidence to inspect, not an instruction to preserve old implementation. When test conflicts with current architecture, decide the intended contract first; update or delete the stale test.
- **Write tests for value.** Keep tests only when failure would indicate a realistic product defect that static contracts cannot prove. High-value: stale-CAS no-write, non-idempotent effect dedupe, authorization boundaries, Process/Git/worktree ownership, crash/restart recovery, Runtime reconnect, release/rollback integrity, real end-to-end continuation.
- **Delete low-value tests.** Remove tests asserting retired implementation shape, internal fields, legacy lifecycle ordering, obsolete error strings, deprecated gates, or compatibility behavior the current architecture explicitly removes. Do not keep tests merely for coverage.
- **Cheapest proof wins.** Prefer TypeScript/compiler contracts → architecture/import/AST fences → focused behavior/E2E scenario → broader regression suite. Do not duplicate structural invariants with expensive Runtime tests.
- **Regression proof for reproduced bugs.** For a concrete regression, use the cheapest focused check that demonstrably fails before the fix and passes after it; add a valuable automated regression test when appropriate. Where the failure crosses Browser/Computer/Runtime, separately prove that real chain. Do not inflate mock suites or require full E2E for pure static invariants.
- **Real verification and measurable improvement.** Green unit tests alone do not prove delivery. For autonomous CONTINUE→CONTINUE→DONE, verify actual Browser/ChatGPT/Supervisor/Runtime behavior across reconnect/crash/unknown-result cases; require zero duplicate external effects and zero false DONE. Record an actual baseline, measure first effective edit, avoidable prelude, full delivery and success rate; target at least 30% time reduction without success-rate regression, never assert success without measured evidence. Mock/ledger tests cannot substitute for this proof.
- **Production architecture wins.** Never restore or retain a production API, shim, state, branch, or provider path solely to satisfy an existing test. When architecture and historical test disagree, the accepted architecture wins and the stale test is deleted.

## Operating Rules

- **End-to-end execution default.** Continue reversible, policy-allowed implementation, verification, cleanup, and delivery. Stop only at genuine user-only identity/legal/financial/strong-confirmation/irreversible boundaries.
- **Top-down workflow.** Requirement/product intent → product interaction when relevant → architecture/authority → implementation → focused verification → independent review → delivery/terminal cleanup. Do not patch symptoms while higher-level contract remains wrong.
- **Direct execution for bounded work.** Create durable Plan/Work only for real decomposition, continuity, scheduling, recovery, independent delivery, or external effects. Durable Work/Plan does not automatically require isolated checkout or create Git commit boundary.
- **Sticky placement.** Once selected for coherent delivery, keep the same checkout. Direct execution reuses explicitly selected current checkout; durable repository Work defaults through `auto` to same selected current checkout (with recorded dirty baseline). Never switch placement mid-Work because target state changes.
- **Topology selection.** For mutating durable repository Work, `auto` (and `reuse`) are the fixed current-checkout default; `new_worktree` is explicit isolated/frozen-base choice. Do not infer topology from task size, risk text, dirty-path heuristics, parallel relations, recovery, or semantic context. Actual occupancy and Git conflicts reported mechanically at execution time.
- **Cleanup after isolated delivery.** After isolated delivery validated, integrate/reconcile at delivery boundary and delete temporary branch/worktree after containment/cleanup proven. Do not accumulate completed managed worktrees.
- **Authentication preservation.** For authenticated browser work, preserve user's explicitly selected/signed-in browser identity; never silently create replacement authentication state.
- **Prompt delivery.** After managed repository change verified and committed/merged, push delivered target branch promptly unless user requested local-only delivery or concrete safety/auth/branch-policy blocker exists.
- **Respect unrelated work.** Treat unrelated dirty work as ownership/placement evidence. Isolate or reconcile it; never absorb it merely to make tree look clean.
- **Modern config authority.** Modern `forge.config.json` repositories must not materialize repo-local `.ai/harness`, `.codegraph`, `.claude` session state, generated task lifecycle files, or mutable Plugin config from prompt routing. Legacy readers/hooks exist only to migrate older projects.
- **Directory conventions.** `_ref/` is ignored external-reference checkout cache; `_ops/` is ignored/private operational residue only while legacy/external tooling requires it. Neither is source authority. `deploy/` is trackable deployment/runbook/submission/config-example source. Secrets, real environment state, provider state, logs, caches, credentials stay outside Git.
- **Routing concepts.** `/direct`, `/plan`, `/debug`, `/review`, `/release`, `/scale` are user-facing routing concepts; correctness must not depend on optional Waza/gstack/gbrain/peer-review skills.
- **Strengthen general capabilities.** When concrete incident reveals general gap, strengthen existing general capability/authority rather than adding another helper, daemon, fallback, or state machine.

## Required Checks

For affected Forge-core changes, select the smallest verification set that proves changed architecture and real safety boundaries. At architecture/runtime-boundary candidate points:

```bash
bun run check:type
bun run check:repository-hygiene
bun run check:runtime-architecture
bun run check:architecture-sync
bun run check:bootstrap-files
```

Add focused behavior/E2E tests only for concrete risk being changed. `bun run test` is not mandatory inner-loop prerequisite by itself; run only when its curated cases materially cover the candidate. `bun run check:main` remains candidate-level governed gate, but obsolete tests/contracts must be deleted or removed from that gate rather than forcing production code to preserve retired architecture. Full-suite testing remains explicit through `bun run test:full`; do not substitute huge suite for targeted diagnosis.

<!-- BEGIN ARCHITECTURE CONTRACT -->
## Architecture Contract

- Functional block: `.ai/hooks`
- Capability ID: `runtime-harness-hook-adapters`
- Matched prefix: `.ai/hooks`
- Architecture domain: `runtime-harness`
- Architecture capability: `hook-adapters`
- Architecture module: `docs/architecture/modules/runtime-harness/hook-adapters.md`
- Last architecture event: 2026-05-29T09:44:46+0800
- Last changed path: `.ai/hooks/session-start-context.sh`
- Severity: high
- Change type: workflow-surface
- Module responsibility: Keep this block aligned with the local boundary described by surrounding human-owned context.
- Entrypoints: `.ai/hooks`
- Allowed dependencies: Follow root `AGENTS.md` / `CLAUDE.md` and this local contract.
- Forbidden dependencies: Do not cross sibling app/service/package boundaries without an architecture snapshot or explicit plan.
- Runtime path: `.ai/hooks`
- LSP/tooling profile: `typescript-lsp`
- Verification: Use root required checks plus local commands recorded in this capability contract.
- Latest snapshot: `(none yet)`
- Semantic diagram source: `docs/architecture/modules/runtime-harness/hook-adapters.md`
- Latest human diagram: `(none yet)`
- Pending architecture request: `(none)`
- Runtime progress authority: Forge Controller Home Requirement/Plan/Work/Evidence; this repository block contains authored architecture context only.
<!-- END ARCHITECTURE CONTRACT -->
