# Agentic Development Flow

Forge owns the workflow contract. External host skills may improve reasoning quality, but they are never required for correctness or lifecycle progress.

## Primary Modes

| Work type | Forge route | Optional enhancement |
|---|---|---|
| Understood bounded edit | `/direct` | none required |
| Plan-only or architecture decision | `/plan` | gstack `plan-eng-review` / `plan-design-review`, Waza `/think` |
| Bug, regression, failing test, tooling failure | `/debug` | Waza `/hunt` |
| Diff, acceptance, pre-merge review | `/review` | Waza `/check`, peer `codex-review` / `claude-review` |
| Release readiness and publication | `/release` | provider-specific release tooling |
| Concurrency, load, performance, scale verification | `/scale` | benchmark-specific tooling |
| Product discovery | `/plan` | gstack `office-hours` |

Missing external skills must degrade only the named enhancement. Hooks may suggest Forge modes, but must not route correctness through a third-party skill.

## Public CLI Boundary

The user-facing CLI is intentionally smaller than the implementation surface:

- install/configure: `forge install`, `forge update`, `forge setup`, `forge uninstall`;
- repository/runtime: `forge adopt`, `forge repo`, `forge runtime`, `forge recovery`;
- integrations: `forge plugin`, `forge chatgpt`, `forge mcp`, `forge tools`;
- diagnostics/docs: `forge status`, `forge doctor`, `forge security`, `forge docs`.

Host-dispatch and compatibility machinery such as `hook`, `run`, legacy `controller`, migration helpers, brain sync, and capability-context internals may remain callable for managed workflows but are not normal top-level product entrypoints.

## Due Diligence

P1/P2/P3 remains the shared reasoning protocol:

- `P1_GLOBAL_ARCHITECTURE`: identify real boundaries, entrypoints, owners, authoritative state, dependencies, and out-of-scope areas.
- `P2_DATA_FLOW_TRACE`: walk one concrete request/event/job/config/data path to the final output.
- `P3_DESIGN_DECISION`: state the invariant, why the current shape exists, and why the proposed change is the smallest coherent one.

For small work keep this internal. For architecture, debugging, risky refactors, deployment, auth/payment/data, or shared contracts, persist the relevant evidence.

## Daily Flow

1. Read the current user request and current Canonical Runtime state first.
2. Use `/direct`, `/plan`, `/debug`, `/review`, `/release`, or `/scale` according to intent.
3. Use `rh_context`; request CodeGraph structural context when callers, dependencies, or impact matter.
4. If a decision-complete plan is useful, capture it into `plans/` as a durable business/engineering artifact. It is not a second Runtime lifecycle authority.
5. Execute bounded work through Forge repository/Process/Work primitives and collect verification evidence.
6. Use `/review` plus focused checks before closeout. Optional peer or Waza reviews may add evidence but may not become the only pass condition.
7. `.ai/harness/session/continuation.md` and `.ai/harness/session/resume.md` are ignored, rebuildable host-session caches only. They never override SQLite/Runtime state, Git source, current user input, or recorded evidence.
8. A decision that actually requires ChatGPT/user judgement is a Runtime `HandoffItem` surfaced through `rh_inbox`; do not encode it as a session-cache file.

## Boundaries

- Do not create a new workflow entity because an old RepoHarness skill once had a command for it.
- Do not auto-install Waza, gstack, gbrain, or other unrelated third-party skills during ordinary execution.
- Do not treat session continuation files, `tasks/current.md`, or generated projections as mutable lifecycle authorities.
- Do not make an Agent process, browser session, hook, or external skill the owner of long-running work. Forge owns durable state; external models provide reasoning and implementation work.
- Keep compatibility readers isolated and read-only. New writes target the current Forge authority only.
