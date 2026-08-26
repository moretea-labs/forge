# Forge AGENTS.md

This repository self-hosts the Forge contract. Retired project-skill and project-initializer staging paths are not supported or cleaned up by current tooling. Claude and Codex should follow the same repo-local workflow surface.

## Forge execution runtime

Treat ChatGPT as the controller and Forge as its repository execution layer. ChatGPT chooses how to inspect, plan, edit, verify, or delegate. Forge provides deterministic repository tools and does not impose an Agent-first workflow.

- Direct Edit is the default for understood work. One session may accept many patch batches, keep revision history, create savepoints, run checks, roll back selected revisions, and finalize one aggregate localized diff.
- Tasks describe objectives, scope, checks, and acceptance criteria. They do not permanently bind Codex, Claude, or GitHub Copilot. The executor is selected when each Run starts.
- Agents are optional implementation tools for broad exploration, large refactors, or compile/test/fix loops. They receive a high-level implementation contract; ChatGPT still reviews the result and decides what happens next.
- Ordinary local risk levels are metadata, not permission gates. There is no approval queue and no `approve_risk` handshake. Only an explicitly destructive or irreversible operation requires authorization in the same request.
- The Controller UI is an auxiliary configuration/state utility behind ChatGPT: Overview, Work, Automations, Capabilities, Repositories, Settings, and System. It presents durable user-facing state and hides Issue/Task/Run internals unless diagnostics require them.
- Hard runtime boundaries remain for secrets, credentials, Git internals, concurrent write conflicts, out-of-scope writes when a scope is declared, and remote or irreversible side effects.
## Canonical Workflow Files

- `tasks/current.md` for the tracked current-status snapshot derived from workflow artifacts
- `tasks/todos.md` for deferred medium/long-term goals, not active execution checklists
- `plans/prds/` for upper-layer PRDs; `plans/sprints/` for ordered sprint backlogs operated through `scripts/sprint-backlog.sh` (installed implementations live under `.ai/harness/scripts/`; task contracts stay the execution slices)
- `.ai/context/capabilities.json` for the capability registry and longest-prefix context boundaries
- `tasks/workstreams/` for capability long-running workstreams that project durable progress into local contracts
- `tasks/lessons.md` for correction-derived rules
- `docs/researches/` for deep repo knowledge
- `tasks/notes/` for task-local implementation decisions, deviations, tradeoffs, and open questions
- `plans/` for timestamped plans, with `plans/archive/` for history
- `.ai/harness/workflow-contract.json` for the installed workflow contract manifest
- `.ai/harness/policy.json` for the machine-readable workflow contract
- `.ai/context/context-map.json` for progressive context loading
- `docs/architecture/index.md` for umbrella architecture status, drift requests, snapshots, and diagram links
- `docs/reference-configs/agentic-development-flow.md` for Forge task routing and optional host-skill enhancements

## Runtime Architecture Guardrails

- Treat Forge as one local MCP application, one active Runtime, one deployable release, and one in-process lifecycle owner. Gateway, MCP transport, Controller, and Scheduler may be modules; they are not independently deployable generations by default.
- Bounded restart downtime is acceptable. Prefer `stop -> switch complete release -> start -> verify -> full rollback`; do not add ingress, blue/green slots, adoption, or mixed generations without an explicit product requirement.
- Do not respond to an incident by adding a second status authority, daemon, proxy, KeepAlive wrapper, watchdog, recovery owner, or fallback path; extend the canonical Runtime or standalone Recovery owner instead. First identify the violated invariant and remove, merge, or correct the existing cause.
- Readiness is one derived whole-system conclusion. Multiple diagnostic checks and reason codes are allowed, but they must not become independent durable readiness state machines.
- Keep lifecycle, readiness, liveness, capability, authorization, release identity, and diagnostics separate. Do not create composite states such as `status=ready` with `degraded=true`.
- Only one component may perform lifecycle or recovery side effects. Observers and probes are read-only and submit typed requests to that owner.
- Release and rollback scope is the complete compatible Runtime, configuration, entrypoint, and SQLite schema/backup state; component-level rollback is forbidden.
- Any new process, persistent state, enum value, health mode, authority file, or compatibility fallback requires an explicit architecture decision, transition owner, cleanup/removal criterion, and failure-injection tests.
- Follow `docs/reference-configs/runtime-architecture-guardrails.md` for the normative review gates and target topology.

## Operating Rules

- After a managed repository change is verified and committed/merged, push the delivered target branch to its configured remote promptly. Do not leave a successfully delivered commit only on local refs unless the user explicitly requested local-only delivery or the push is blocked by safety, permissions, authentication, or branch policy; surface the exact blocker when a push cannot complete.
- Sync `tasks/` whenever substantive repo changes are made.
- Use `tasks/notes/<plan-stem>.notes.md` only for non-obvious slice decisions, deviations, tradeoffs, and open questions; `<plan-stem>` is the active plan filename without `plan-` and `.md` (for example `20260531-0045-governance-workflow`). Do not use notes as durable memory or a task log, and archive/promote them deliberately when the slice closes.
- Treat hook execution as central-first: trusted repos run `~/.forge/hooks/` (bash shim) or the packaged CLI copy; this self-host repo pins `"hook_source": "repo"` in `.ai/harness/policy.json` so `.ai/hooks/` stays the live development runtime, with `assets/hooks/` as the product source mirrored on install. User-level `~/.claude/settings.json` and `~/.codex/hooks.json` are the host adapters.
- Keep the umbrella hierarchy explicit: architecture owns stable truth, capability contracts own local agent context, `tasks/workstreams/<domain>/<capability>/` owns durable progress, and `tasks/todos.md` owns only deferred medium/long-term goals with tradeoff and revisit trigger.
- Treat `.ai/context/capabilities.json` as the source of truth for capability prefixes; `agent-context-blocks.txt` and nested agent files are compatibility inputs only.
- Keep architecture drift handling split: `architecture-queue.sh` writes architecture requests/events, `workstream-sync.sh` maintains durable capability workstreams, and `context-contract-sync.sh` only updates controlled local `CLAUDE.md`/`AGENTS.md` architecture blocks.
- Keep `assets/workflow-contract.v1.json` and `.ai/harness/workflow-contract.json` in sync.
- Keep `CLAUDE.md` and `AGENTS.md` short; put detailed guidance in `docs/reference-configs/`.
- Treat Codex auto-compact as a fallback only; use `.ai/harness/session/continuation.md` and `.ai/harness/session/resume.md` for long-task rollover.
- Treat `_ref/` as an occasional ignored external reference checkout cache, not a commit surface or daily workflow. Agents may read or refresh it for comparison; when it influences a decision, cite the source repo plus commit/tag and path in `tasks/notes/` or `docs/researches/`.
- Treat `deploy/` as the trackable deployment and operations surface for runbooks, submission materials, release checklists, helper scripts, ordered SQL files under `deploy/sql/`, and env examples.
- Treat `_ops/` as ignored local operations state for secrets, real env files, provider state, artifacts, logs, and scratch files; do not commit or agent-edit `_ops/*`.
- Treat contract-level task execution as worktree-first when policy requires isolation: `scripts/plan-to-todo.sh --plan <approved-plan>` may start `scripts/contract-worktree.sh start --plan <approved-plan>`; finish through Forge `/review`, focused checks, and `scripts/contract-worktree.sh finish`.
- Forge task directives are the stable user-facing routing surface: `/direct`, `/plan`, `/debug`, `/review`, `/release`, and `/scale`. Do not require users or automation to remember third-party skill commands.
- After Forge `/plan`, Codex Plan mode, or an optional external planning skill produces a decision-complete plan, capture it with `scripts/capture-plan.sh --slug <slug> --title <title>` so `plans/` becomes the file-backed source of truth; if implementation is already approved, capture with `--status Approved --execute` or run `scripts/plan-to-todo.sh --plan <active-plan>`.
- If current repo state conflicts with the task, isolate the work, finish there, run Forge `/review`-style validation plus focused checks, then merge back without absorbing unrelated dirty changes.
- Waza, gstack, Mermaid, gbrain, and cross-review skills are optional host enhancements. Use them only when already installed or explicitly requested; their absence must never block Forge planning, debugging, review, or execution.
- Register valuable repo-authored docs in `.ai/harness/brain-manifest.json` with `sync.direction=repo-to-brain`; `scripts/sync-brain-docs.sh` and the PostEdit hook mirror only those explicit entries into the default brain vault.
- Use `docs/reference-configs/external-tooling.md` and `bash scripts/check-agent-tooling.sh --host both --check-updates` for optional host-tool diagnostics. Forge structural retrieval uses its bundled CodeGraph read backend; a global CodeGraph CLI/MCP is an optional developer integration, not Runtime readiness.
- When changing `scripts/migrate-project-template.sh` or `scripts/lib/project-init-lib.sh`, verify self-migration of this repo still works.
- Treat repo-local `.claude/settings.json` and `.codex/hooks.json` hook adapters as retired legacy config; migration may back them up locally, but they are not product deliverables.

## Required Checks

```bash
bun run check:task
bash scripts/check-deploy-sql-order.sh
bash scripts/check-architecture-sync.sh
bash scripts/check-task-sync.sh
bash scripts/check-task-workflow.sh --strict
bun scripts/inspect-project-state.ts --repo . --format text
bash scripts/migrate-project-template.sh --repo . --dry-run
```

`bun run test` is the affected gate. `bun run check:main` reuses the focused
task receipt and never expands to the full suite. Full testing is manual and
explicit through `bun run test:full`; it is not a task, CI, or release gate.

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

## Active Workstreams

- (none yet)

## Current Session Projection

- Durable progress lives under `tasks/workstreams/runtime-harness/hook-adapters`.
- `tasks/current.md` is the tracked derived status snapshot; it is not a live lock or task source.
- `tasks/todos.md` is the deferred-goal ledger; current execution slices stay in the active plan's `## Task Breakdown`.
<!-- END ARCHITECTURE CONTRACT -->
