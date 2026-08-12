# Agentic Development Flow

Use this reference when choosing the daily agentic development mode. Keep the
root prompt concise; this file owns the detailed routing.

## Task Routing

Forge owns the stable user-facing routing vocabulary. External host skills are optional accelerators and never prerequisites.

| Work type | Stable Forge route | Optional enhancement |
|-----------|--------------------|----------------------|
| Small, bounded implementation | `/direct` or automatic Direct | none |
| Planning only | `/plan` | Waza `/think` for a compact second pass; gstack `plan-eng-review` for unusually broad architecture |
| Bug, regression, crash, failing test | `/debug` | Waza `/hunt` when installed |
| Diff / acceptance review | `/review` | Waza `/check` or cross-review when installed |
| Release readiness / activation | `/release` | external acceptance when configured |
| Concurrency / large-load benchmark | `/scale` | none |

Product-discovery and UI-review helpers such as gstack `office-hours` and `plan-design-review` may be invoked by the host model when installed, but Forge must produce a valid plan/review without them. Hooks and schedules must never instruct a user to install or invoke these helpers merely to continue normal work.

## forge Command Surface

Use these CLI-backed command facades when the work is about installing,
migrating, repairing, or verifying this repo-local harness:

| Work type | Command | Boundary |
|-----------|---------|----------|
| Decision-complete harness plan | `forge-plan` | Plans only; no repo mutation by default |
| Review an existing harness plan | `forge-review` | Product, engineering, design, and DevEx review dimensions |
| Automatic workflow pipeline | `forge-autoplan` | Plan -> two self-review passes -> implementation -> `/review` + focused checks -> `forge-ship` |
| Ship finished work | `forge-ship` | Validates finished worktrees, pushes branches, and creates PRs by default |
| Add harness to an existing repo | `forge-init` | Uses inspector and migration engine; does not create an app stack |
| Create a new app or module scaffold | `forge-scaffold` | Uses plan catalog A-K, then attaches the harness |
| Convert legacy workflow surfaces | `forge-migrate` | Archives or preserves user-authored legacy docs |
| Refresh an installed harness | `forge-upgrade` | Runs manifest-owned upgrade actions only |
| Add selected capability boundaries | `forge-capability` | Updates capability registry and local contracts without full init/migrate/upgrade |
| Resolve architecture docs or diagrams | `forge-architecture` | Handles architecture drift requests without full harness refresh |
| Prepare or resume handoff | `forge-handoff` | Refreshes Codex handoff packets without running full checks |
| Check deploy and ops config | `forge-deploy` | Read-only deploy/_ops readiness check without publishing |
| Fix broken current harness behavior | `forge-repair` | Task sync, hook routing, handoff, context, policy, or helper drift |
| Verify readiness | `forge-check` | Workflow gates, task sync, inspector, migration dry-run, and readiness yellow flags |
| Generate an upper-layer PRD | `forge-prd` | `$geju` direction pass, Claude-first `claude -p --model opus` drafting, Codex fallback only when needed, PRD in `plans/prds/*.prd.md` |
| Plan and run a program-level sprint | `forge-sprint` | Upper-layer PRD in `plans/prds/`, sprint backlog in `plans/sprints/`; each row expands through `$think` before plan -> contract -> worktree |
| Prepare a bounded native goal session | `forge-goal` / `forge:goal` | Codex/Claude `/goal` prompt from detailed PRD or Sprint artifacts; stops to request those documents when missing |
| Configure GPT Pro local bridge | `forge-gptpro-setup` / `forge:gptpro_setup` | Separates `gptpro_browser` local ChatGPT Web browser/session consults from `gptpro_mcp` ChatGPT Connector MCP sidecar setup; preserves auth, tunnel, and API-billing boundaries |
| Consult GPT Pro through browser session | `forge-gptpro` / `forge:gptpro` | Uses `gptpro consult/read/continue/open` wording while mapping to `browser-consult`, `browser-session`, `browser-followup`, and `browser-open` engine commands |

`hooks-init`, `docs-init`, and `create-project-dirs` are not public commands.
They are implementation steps behind `init`, `scaffold`, `migrate`, and
`upgrade`.

## Due Diligence Levels

P1/P2/P3 is the shared due-diligence protocol underneath the routing.

- `P1_GLOBAL_ARCHITECTURE`: identify real boundaries, entrypoints, owners, authoritative files, dependencies, and out-of-scope areas.
- `P2_DATA_FLOW_TRACE`: walk one concrete route through requests, UI events, jobs, config, messages, or database values to the final output.
- `P3_DESIGN_DECISION`: explain why the current shape exists, which invariant must stay true, and why the chosen change is the smallest coherent one.

For small tasks, keep P1/P2/P3 internal and report only the result. For
`plan-eng-review`, `/hunt`, risky refactors, deployments, auth/payment/data
work, or shared contracts, report the P1/P2/P3 evidence explicitly.

## Daily Flow

| Agent reads first | Human reviews first |
|-----------|---------|
| Current user prompt and referenced files | Human Review Card in `tasks/reviews/<task>.review.md` |
| `AGENTS.md` / `CLAUDE.md` and active plan | Changed files and active contract scope |
| Active contract, notes, latest checks, and handoff | Latest trace/checks, residual risk, rollback |
| `tasks/current.md` only for orientation | External acceptance or manual override |

1. Route the request by intent before reading broadly.
2. Read the repo-local contract first: `AGENTS.md` or `CLAUDE.md`, `tasks/todos.md`, `tasks/lessons.md`, and `.ai/harness/policy.json`.
3. Use the selected skill or mode to produce either an approved plan, a root cause, or a review verdict.
4. When Forge `/plan`, Codex Plan mode, or an optional external planner produces a decision-complete plan, capture it into `plans/` with `.ai/harness/scripts/capture-plan.sh --slug <slug> --title <title>` and the plan text on stdin.
5. Approved plans must include `## Evidence Contract` with state/progress path, verification evidence, evaluator rubric, stop condition, and rollback surface before execution. `capture-plan.sh` supplies this contract for captured planning output.
6. Convert approved plans to execution scaffolding with `.ai/harness/scripts/plan-to-todo.sh --plan <plan>`; if approval is already explicit, use `.ai/harness/scripts/capture-plan.sh --status Approved --execute ...`. The plan's own `## Task Breakdown` remains the execution checklist; `tasks/todos.md` remains a deferred-goal ledger. Contract-level plans are projected into a linked `codex/<slug>` worktree when the policy enables it.
7. For Sprint execution, treat each row in `plans/sprints/*.sprint.md` as a long-task waypoint. Use Forge `/plan` to expand the row into a decision-complete `plans/plan-*.md` before coding; do not treat the sprint row itself as an implementation plan.
8. Use `.ai/harness/scripts/refresh-current-status.sh` for an explicit `tasks/current.md` preview or `--write` snapshot. In non-target worktrees, `git show <target>:tasks/current.md` reads the mainline snapshot, but it never replaces source artifacts.
9. After substantive changes, run project checks and record evidence in `tasks/`. For contract worktrees, run Forge `/review` plus focused checks, and start host-aware external acceptance in parallel when configured, fill the review artifact from both verdicts, then use `forge-ship` for default PR closeout. It calls `.ai/harness/scripts/contract-worktree.sh finish --no-merge`, pushes the `codex/<slug>` branch, and opens a draft PR. Use `forge-ship --local-merge` only when an explicit maintainer workflow wants the older fast-forward merge and cleanup path.

## Passive Plan Capture

- Forge `/plan` and Codex Plan mode do not require the user to remember `new-sprint` or `plan-to-todo`.
- The agent should capture decision-complete planning output with `.ai/harness/scripts/capture-plan.sh`; the script sets `.ai/harness/active-plan`, writes `.ai/harness/active-worktree`, mirrors `.claude/.active-plan`, and writes a timestamped `plans/plan-*.md` artifact.
- Planning capture is allowed before implementation. Contract, review, notes, and worktree artifacts are generated only after explicit implementation approval; `tasks/todos.md` is not a duplicate of plan tasks.
- Current-status capture is separate from planning capture: `tasks/current.md` is regenerated from artifacts for orientation, not edited as a plan or task list.

## Boundaries

- Do not make optional Waza/gstack skills a correctness dependency. Large architecture still uses Forge `/plan`; routine local edits stay Direct.
- Hooks emit only Forge route hints on prompt submit. Review/release prompts emit a host-aware `[ExternalAcceptance]` prompt telling the main agent to run the peer reviewer in parallel and paste `## External Acceptance Advice` into the review file; done/finish gates block only on that recorded evidence. Hooks must not mutate files or auto-run peer CLIs based on semantic intent. `[CrossReview]` remains a lightweight debug/spec/test advisory. Plan capture is an agent action after a planning mode produces a concrete plan.
- When installed, `office-hours` and `plan-eng-review` are optional second-opinion helpers, not primary routing authorities.
- Treat subagent and parallel-agent execution as a main-agent decision based on task breadth, context impact, raw-log volume, and callable tools. Do not ask the user for spawn confirmation; if no runner is callable or spawning is not worth the context cost, complete the same P1/P2/P3 trace in the main thread and persist evidence-backed conclusions in `docs/researches/`.
- Do not turn `tasks/current.md` into a hand-written kanban or memo. Use plans, workstreams, notes, reviews, checks, and handoff files as the authoritative surfaces.
