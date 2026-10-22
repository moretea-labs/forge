## Coding Constraints

### First Principles
- Prefer data modeling over branch-heavy conditionals and derivation over duplicated state.

### Single Source of Truth
- Controller Home SQLite owns live Requirement, Plan, Work, execution state and evidence in forge.config.json projects.
- docs/spec.md, docs/researches/, tasks/todos.md, tasks/lessons.md and architecture docs are human-readable context; src/ contains implementation and tests/ contains checks.
- Legacy tasks/contracts/, tasks/reviews/, tasks/notes/ and .ai/harness/ never own current workflow state.

### Quality Rules
- Keep functions intention-revealing; use the minimum sufficient existing verification.
- Replace obsolete paths instead of maintaining parallel authorities.
