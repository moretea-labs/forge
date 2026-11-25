## Work Management Protocol

```yaml
SOURCE_DEVELOPMENT_AUTHORITY:
  - GitHub Issue / Project: requirements, decisions, priority, progress, acceptance
  - source / public APIs / Git: implementation facts
  - tests / static checks: verification facts
  - tasks/todos.md: explicitly deferred goals
  - tasks/lessons.md: reusable corrections

RUNTIME_AUTHORITY:
  - Process / Schedule / resource claims / authorization / runtime evidence
  - optional Requirement / Plan semantic context

PHASES: understand -> design -> implement -> verify -> review -> cleanup
```

Rules:

- Do not recreate repo-local spec, research, architecture, contract, review, workstream, or harness-state trees as current authority.
- Plan is optional semantic context, not ceremony or write authorization.
- High-risk/cross-cutting work must establish enough current context and design evidence before mutation.
- Successor work cannot silently drop unresolved acceptance criteria, decisions, stop conditions, or replan conditions from the tracked Issue/Project.
- Completion is bound to exact implementation review and verification evidence; a chat or Markdown status claim is never enough.
