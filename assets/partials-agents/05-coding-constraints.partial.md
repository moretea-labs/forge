## Coding Constraints

### First Principles
- Prefer data modeling over branch-heavy conditionals and derivation over duplicated state.

### Single Source of Truth
- GitHub Issue/Project owns Forge source requirements, architecture decisions, progress, and acceptance.
- Source/public APIs/Git own implementation facts; tests and static checks own verification facts.
- Controller Home owns runtime execution facts and receipts, not a parallel source-development ledger.
- README/GitHub Pages are public documentation; tasks/todos.md and tasks/lessons.md remain narrow project artifacts.

### Quality Rules
- Keep functions intention-revealing; use the minimum sufficient existing verification.
- Replace obsolete paths instead of maintaining parallel authorities.
