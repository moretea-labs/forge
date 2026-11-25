## Workflow Orchestration

### Controller-owned state
For modern forge.config.json projects, Forge Controller Home SQLite is the only live authority for Requirement, Plan, Work, ControllerRound, Process, Schedule, permissions and effect/check receipts.

### Practical flow
- Inspect relevant source and current project Requirement/Issue context directly.
- The model selects scope and approach, implements a coherent batch, chooses sufficient existing checks, reviews evidence and decides when Work is complete.
- Keep one source writer per overlap and respect exact Git state; isolate only when needed.
- Resume from Forge Requirement/Plan/Work and source revisions/receipts, not .ai/harness/active-plan or session files.
- tasks/todos.md holds deferred goals and tasks/lessons.md readable lessons. plans/, tasks/contracts/, tasks/reviews/ and .ai/harness/ are legacy only, never workflow gates.
