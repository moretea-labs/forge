# Forge Goal Loop

Forge supports bounded goal progression through durable Goal, Work, Process, evidence, policy, and handoff records. The kernel does not recursively invent unlimited work, select arbitrary models, or bypass authorization. Semantic planning and provider selection belong to the external controller; deterministic repository and provider operations remain Forge-owned.

Every continuation must have a finite objective, resource scope, budget, stop condition, and reviewable evidence. Remote or destructive effects stay separately authorized. A Schedule can wake an external Controller for an existing bounded Work; ChatGPT wakeups reuse a saved Forge browser session or explicit conversation URL when available, so conversation continuity is a transport concern rather than Kernel reasoning.
The stable configuration path is `rh_work.schedule_*`: create one continuation policy for an already accepted Work, inspect it, pause/resume it, or trigger one bounded Occurrence. The engine re-checks Work terminality before launch and automatically disables the Schedule when the Work is complete, so users do not need to keep sending “continue” and Forge does not keep waking a model after acceptance is satisfied.
A scheduled wake uses a short launch reservation rather than a fake Controller lease. The external model becomes owner only after its own authenticated MCP session calls `rh_work continue`; this is the identity handoff boundary between deterministic scheduling and semantic control.

See [Dispatch and Agent Strategy](architecture/CURRENT.md), [Schedule Engine](architecture/CURRENT.md), and [Governance](architecture/CURRENT.md).
