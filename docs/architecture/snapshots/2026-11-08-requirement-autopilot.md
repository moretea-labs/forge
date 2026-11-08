# Requirement-optional Planning and Runtime Autopilot

Date: 2026-11-08

## Decision

Forge does **not** require a Requirement or Plan for ordinary Agent, repository, Git,
Runtime, or recovery use. A selected repository/checkout is sufficient.

Requirement and Plan remain optional durable semantic records:

- Requirement is a durable outcome/acceptance root when the user chooses requirement-driven planning.
- Plan is an authored implementation path and may exist without a Requirement.
- `parentPlanId` is an immutable Plan-refinement edge used to project a tree.
- Requirement/Plan do not own execution progress, scheduler state, Git facts, or approval state.

The native client projects this as one Planning workspace. Agent conversations may optionally
attach a Requirement/Plan identity; the attachment enriches semantic context but never gates
ordinary conversation or execution.

## Autopilot authority

Autopilot is available only when the user explicitly chooses a Requirement and explicitly
authorizes unattended execution.

Approval is **not** a Requirement field. It is a canonical Identity `AuthorizationGrant`
scoped to the exact repository + Requirement and constrained to:

- exact Requirement revision,
- exact checkout,
- provider/model,
- token/turn/tool-call budgets,
- optional human-checkpoint Plan IDs,
- `workspace_write` risk ceiling,
- grant expiry/revocation.

A Requirement semantic revision therefore invalidates the previous Autopilot approval without
adding an `approved` lifecycle to Requirement.

The Runtime-owned Autopilot record stores execution facts only: run identity/status, bounded
provider usage, current reported Plan, summaries, stop reason, and evidence references.

## Execution boundary

Autopilot does not introduce another repository/Git/process writer.

The Runtime loop delegates reads/writes to existing bounded Repository/Git/Process capability
owners. Its direct tool surface is intentionally small:

- repository file read,
- Git status/diff,
- safe patch apply,
- local Git commit,
- bounded repository command execution.

Repository commands classified above `workspace_write` are rejected before they reach the
existing executor. Autopilot cannot push, publish, deploy, release, switch/activate/rollback
Runtime, or perform destructive commands through this authority.

A structured Autopilot decision can continue, pause, report blocked, or finish the autonomous
run. Finishing an Autopilot run does **not** complete the Requirement; Requirement completion
still requires its own semantic acceptance/evidence decision.

## Lifecycle and recovery

Autopilot is self-managed by the long-lived Forge Runtime. Closing the Forge Client does not
stop an active run.

Persisted run state and canonical grants allow a `running` run with no live in-memory loop
(for example after Runtime restart) to be explicitly resumed without creating another Work,
Supervisor, task ledger, or execution authority.

Existing observe-only `schedule_*`, retired Supervisor/CONTINUE behavior,
`launcher_start` continuation, `quick_agent_session`, and historical Work are not Autopilot
execution paths.

## Source-progress authority

GitHub Issue/Project remains the visible source-delivery progress authority for Forge itself.
Run/Process/Check/Git remain their existing mechanical evidence owners. This snapshot adds no
parallel project-progress ledger.
