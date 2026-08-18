# Forge Supervised Automation Philosophy

Forge is a local-first execution kernel, not an unbounded autonomous agent. External controllers decide semantic goals; Forge persists Requirement/Plan/Work authority, enforces policy and resource ownership, executes bounded operations, and returns evidence. Every loop has a finite budget, stop condition, and explicit external-effect boundary.

## Authority-first routing

Normal execution follows **Resolve → Route → Admit → Execute**. It must not create a lifecycle object, discover that it chose the wrong lane, and then rely on a blocker or maintenance repair as routine control flow.

- **Resolve intent first.** Before a repository mutation, inspect current primary Work authority plus exact Requirement/Plan bindings. The external semantic controller decides whether a request is `continue`, `extend`, `parallel`, or `new_goal`; Forge supplies deterministic candidates and never guesses semantic equality from fuzzy text similarity.
- **Route before topology.** Intent resolution precedes Direct-vs-Durable and current-vs-isolated workspace selection. A small edit that belongs to an active Work continues that Work; a genuinely independent concurrent task is routed to an isolated sibling Work. Simple unrelated work keeps the Direct fast path.
- **Origin is policy input.** User/ChatGPT-originated work may explicitly create a new goal or parallel sibling. Scheduler-originated execution is continuation-only: a Workflow wakes its bound Work and must not invent a new Work from its prompt.
- **One authority, many executions.** Requirement owns business lifecycle; a primary Work owns one objective-level execution lane; `work_submit` operations are execution children and do not participate in business-goal matching. A primary Work has one authoritative continuation Schedule; changing cadence or prompt updates that Schedule rather than creating another Workflow.
- **Extend deliberately.** Unplanned serial Work may absorb bounded additional acceptance/path/check scope. Plan-governed Work must extend the authoritative Requirement/Plan first instead of silently widening an approved step.
- **Maintenance is not authority.** Age, inactivity, missing recent logs, and similar observations are diagnostic signals. They cannot terminate Work while an active Plan, Requirement, Schedule, or Controller still owns it.

Fail-closed guards remain necessary for facts that can only be known at execution time: real merge conflicts, mixed Git index ownership, secret/destructive authorization, PID/resource leases, and invariant violations. These guards are the last line of safety, not the mechanism used to discover the normal route.

See [Dispatch and Agent Strategy](architecture/CURRENT.md) and [Governance](architecture/CURRENT.md).
