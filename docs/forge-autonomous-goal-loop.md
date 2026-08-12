# Forge Goal Loop

Forge supports bounded goal progression through durable Goal, Work, Process, evidence, policy, and handoff records. The kernel does not recursively invent unlimited work, select arbitrary models, or bypass authorization. Semantic planning and provider selection belong to the external controller; deterministic repository and provider operations remain Forge-owned.

Every continuation must have a finite objective, resource scope, budget, stop condition, and reviewable evidence. Remote or destructive effects stay separately authorized. A Schedule can wake an external Controller for an existing bounded Work; ChatGPT wakeups reuse a saved Forge browser session or explicit conversation URL when available, so conversation continuity is a transport concern rather than Kernel reasoning.

See [Dispatch and Agent Strategy](architecture/current/dispatch-and-agent-strategy.md), [Schedule Engine](architecture/current/automation-and-schedule-engine.md), and [Governance](architecture/current/governance.md).
