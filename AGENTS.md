# Forge AGENTS.md

This repository self-hosts the Forge contract. Retired project-skill and project-initializer staging paths are not supported or cleaned up by current tooling. Claude and Codex should follow the same Controller-first authority model; mutable workflow state is Controller-owned, not a repo-local file protocol.

## Forge execution runtime

Treat ChatGPT as the controller and Forge as its repository execution layer. ChatGPT chooses how to inspect, plan, edit, verify, or delegate. Forge provides deterministic repository tools and does not impose an Agent-first workflow.

- Direct Edit is the default for understood work. One session may accept many patch batches, keep revision history, create savepoints, run checks, roll back selected revisions, and finalize one aggregate localized diff.
- Tasks describe objectives, scope, checks, and acceptance criteria. They do not permanently bind Codex, Claude, or GitHub Copilot. The executor is selected when each Run starts.
- Agents are optional implementation tools for broad exploration, large refactors, or compile/test/fix loops. They receive a high-level implementation contract; ChatGPT still reviews the result and decides what happens next.
- Ordinary local risk levels are metadata, not permission gates. There is no approval queue and no `approve_risk` handshake. Only an explicitly destructive or irreversible operation requires authorization in the same request.
- The Controller UI is an auxiliary configuration/state utility behind ChatGPT: Overview, Work, Automations, Capabilities, Repositories, Settings, and System. It presents durable user-facing state and hides Issue/Task/Run internals unless diagnostics require them.
- Hard runtime boundaries remain for secrets, credentials, Git internals, concurrent write conflicts, out-of-scope writes when a scope is declared, and remote or irreversible side effects.

### Main checkout and worktree policy

- `main` is the canonical local integration and default development branch. Normal investigation, implementation, review fixes, and focused verification run in the canonical `main` checkout.
- Do not create a branch or managed worktree merely because work is durable, multi-step, recoverable, or represented by a WorkContract. Work lifecycle and Git workspace topology are separate concerns.
- Create an isolated worktree only when there is a concrete concurrent-write/dirty-ownership conflict, explicitly parallel independent writers, or a verification/release operation whose correctness requires a frozen isolated source identity. The reason for isolation must be observable in routing/Work evidence.
- When no such conflict exists, do not set `workspace_mode=isolated`, `require_worktree=true`, or `direct_main_prohibited=true`; prefer the current canonical checkout and serialize writes there.
- Integrate completed isolated work promptly back to `main` and remove its managed worktree/branch after containment and cleanup are proven. Do not accumulate completed worktrees as standing development environments.

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

## Kernel V2 Development Discipline

- Treat Kernel V2 as a domain/authority migration, not an issue-by-issue patch campaign. Before adding state, lifecycle logic, provider routing, compatibility code, or a new process, identify the single owning module and remove or retire competing owners.
- Prefer a modular monolith with explicit ports/adapters. Kernel/domain packages define semantics and ports; protocol packages define neutral contracts; adapters depend inward on those contracts; apps/composition roots wire implementations. Kernel and plugin-runtime packages must not depend on concrete adapters, MCP transport, CLI/UI implementations, or provider identities.
- Every domain has one public API and one mutable authority for each durable fact. Cross-module callers consume the public API/port instead of sibling internals. Duplicate enums, shadow state machines, mirrored persistence, and second lifecycle owners are architecture defects to merge or delete, not compatibility conveniences.
- During migration, legacy `src/cli` / `src/runtime` owners may survive only as bounded compatibility facades around the new owner. A compatibility shim must have a named replacement owner, a bounded consumer set, and an objective removal condition; new production consumers are forbidden. Compatibility is migration debt, not a permanent architecture layer.
- Do not use fallback-first, workaround-first, extra-daemon, duplicate-authority, or silent-degradation patches to make a failing path appear healthy. Repair the violated invariant or missing general capability. Fail-closed behavior remains appropriate only at genuine safety, authorization, ambiguous-mutation, or unsupported-contract boundaries; it is not a substitute for completing the architecture.
- Architecture enforcement preference is: TypeScript/compiler contracts -> package/public-API boundaries -> AST/import/dependency-graph rules -> focused semantic contract tests -> temporary migration assertions. Raw source-string/regex checks and source-line-count limits are not long-term architecture authorities when the invariant can be expressed structurally.
- Any temporary architecture assertion must explain the debt it fences and its removal trigger. Debt ledgers must only shrink: when the legacy edge/shim disappears, delete the assertion/allowlist entry in the same slice instead of preserving historical baggage.
- Work in coherent batches: batch factual reads -> centralized analysis -> one coherent implementation/patch -> batch architectural review -> focused validation. Avoid repetitive micro-checks after each file. Run broader multi-review and whole-candidate validation at Kernel V2 milestone/candidate boundaries before any runtime baseline activation.
- Keep Kernel V2 source development on its designated architecture branch until the integrated candidate is complete. Do not activate a partially migrated slice as the Runtime baseline merely because its local checks pass; baseline activation is a separate candidate-level decision after architecture review and validation.
- Forge-core additions should solve reusable system capabilities or preserve a Kernel invariant. Do not expand Forge with project-specific one-off machinery when an adapter/plugin or existing general primitive is the correct owner.

## Operating Rules

- Default to end-to-end execution and minimize avoidable human intervention. Continue reversible, policy-allowed implementation, verification, cleanup, and delivery; stop only at a genuine user-only identity/legal/financial/strong-confirmation/irreversible boundary.
- Work top-down: requirement/product intent -> product interaction when relevant -> architecture/authority -> implementation -> focused verification -> independent review -> delivery/terminal cleanup. Do not repeatedly patch symptoms while a higher-level contract remains wrong.
- Direct execution is preferred for bounded understood work. Create durable Plan/Work only for real decomposition, continuity, isolation, scheduling, recovery, independent delivery, or external effects.
- For authenticated browser work, preserve the user's explicitly selected/signed-in browser identity; never silently create a replacement authentication state.
- After a managed repository change is verified and committed/merged, push the delivered target branch promptly unless the user requested local-only delivery or a concrete safety/auth/branch-policy blocker exists.
- Treat unrelated dirty work as ownership/placement evidence. Isolate or reconcile it; never absorb it merely to make the tree look clean.
- Current Runtime hooks are central-first/package-owned. Modern `forge.config.json` repositories must not materialize repo-local `.ai/harness`, `.codegraph`, `.claude` session state, generated task lifecycle files, or mutable Plugin config from prompt routing. Legacy readers/hooks exist only to migrate older projects.
- `_ref/` is an ignored external-reference checkout cache; `_ops/` is ignored/private operational residue only while legacy/external tooling requires it. Neither is a source authority.
- `deploy/` is trackable deployment/runbook/submission/config-example source. Secrets, real environment state, provider state, logs, caches, and credentials stay outside Git.
- `/direct`, `/plan`, `/debug`, `/review`, `/release`, and `/scale` are user-facing routing concepts; correctness must not depend on optional Waza/gstack/gbrain/peer-review skills.
- When a concrete incident reveals a general gap, strengthen the existing general capability/authority rather than adding another helper, daemon, fallback, or state machine.

## Required Checks

For affected Forge-core changes, select focused checks from the registered Process Runtime surfaces. At architecture/runtime-boundary candidate points include at least:

```bash
bun run check:type
bun run check:repository-hygiene
bun run check:runtime-architecture
bun run check:architecture-sync
bun run check:bootstrap-files
bun run test
```

`bun run check:main` is the candidate-level governed gate after focused failures are resolved. Full-suite testing remains explicit through `bun run test:full`; do not substitute a huge suite for targeted diagnosis.

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
