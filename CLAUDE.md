# Forge Claude Code guidance

@AGENTS.md

Follow AGENTS.md as the single repository-wide development rule authority. Do not maintain a competing copy of its workflow or architecture policy here. GitHub Issues/Projects alone track development progress and manual issue completion review. Forge Controller retains only execution/effect mechanics; retired Work/WorkHandle records are removed rather than exposed as historical compatibility state. Optional Requirement/Plan context is not a progress ledger.

- Work directly in the assigned checkout. For bounded changes, use Read/Edit/Bash and focused checks rather than spawning extra agents or workflows.
- Use the model selected by the operator in CC Switch or the current CLI environment. Prefer a proven cost-effective model for routine implementation; escalate only for evidence-based harder reasoning. Independent review is optional, not an automatic delivery gate. Do not hardcode credentials, endpoints, billing rates, or model aliases into shared repository rules.
- Evaluate model instruction adherence, source correctness and real-outcome evidence; a successful API response by itself is not acceptance.
