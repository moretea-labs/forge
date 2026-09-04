### Forge Workflow Protocol

```yaml
FORGE_WORKFLOW:
  STATE: {{STATE_PROFILE}}
  PHASES: understand -> design -> execute -> verify -> review -> terminalize
  REPO_AUTHORED:
    - docs/spec.md
    - docs/researches/
    - tasks/todos.md
    - tasks/lessons.md
    - forge.config.json
  RUNTIME_AUTHORITY: Controller Home
```

Rules:

- Prompt/agent files explain intent; they are not execution, authorization, lifecycle, or completion authority.
- Use direct execution for bounded understood work. Create durable Requirement/Plan/Work only when decomposition, continuity, isolation, scheduling, recovery, or external effects justify it.
- Before high-risk or architecture-changing mutation, close the cross-cutting Engineering Design contract instead of reviewing only the touched module.
- A successor Plan must explicitly reconcile every unfinished predecessor obligation as KEEP/CHANGE/DEFER/DROP.
- Mutable checks, sessions, leases, Work/Plan state, Plugin config, run receipts, and caches belong to Controller Home, never new repo-local `.ai/harness` or generated `tasks/*` lifecycle files.
- Human-authored research, stable product intent, deferred goals, lessons, and intentionally maintained planning documents may remain in Git.
- Completion requires exact verification/review evidence and terminal cleanup; no prompt text or generated status Markdown may declare semantic success.
