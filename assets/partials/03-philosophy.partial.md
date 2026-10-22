### 7. Development Protocol

> The model decides the workflow; Forge provides capabilities and Controller Home persists durable facts.

#### Sources of Truth
- **Product**: docs/spec.md, docs/researches/ and architecture docs are human-authored context.
- **Execution**: for forge.config.json projects, Controller Home SQLite exclusively owns Requirement, Plan, Work, status and verification receipts.
- **Human notes**: tasks/todos.md and tasks/lessons.md do not override Controller Home.
- **Implementation**: src/, tests/ and Git record source and evidence, not a second workflow lifecycle.
- **Legacy**: plans/, tasks/contracts/, tasks/reviews/ and .ai/harness/ are migration/history inputs only.

Inspect source, implement a coherent change, run appropriate existing checks, review and record the outcome. Do not impose mandatory repo-local plan/sprint gates.

---
