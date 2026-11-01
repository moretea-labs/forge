# Forge Claude Code guidance

@AGENTS.md

Follow AGENTS.md as the single repository-wide development rule authority. Do not maintain a competing copy of its workflow or architecture policy here. GitHub Issues/Projects alone track development progress and manual issue completion review. Forge Controller retains only execution/effect mechanics; old Work/Plan/WorkHandle records are historical.

- Work directly in the assigned checkout. For bounded changes, use Read/Edit/Bash and focused checks rather than spawning extra agents or workflows.
- Use the model selected by the operator in CC Switch or the current CLI environment. Prefer a proven cost-effective model for routine implementation; escalate only for evidence-based harder reasoning or independent review. Do not hardcode credentials, endpoints, billing rates, or model aliases into shared repository rules.
- Evaluate model instruction adherence, source correctness and real-outcome evidence; a successful API response by itself is not acceptance.

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
- Development progress authority: GitHub Issue/Project; Forge owns only mechanical execution/effect evidence.
<!-- END ARCHITECTURE CONTRACT -->
