## Work Management Protocol

```yaml
AUTHORED_REPO_SOURCES:
  - docs/spec.md
  - docs/researches/
  - tasks/todos.md
  - tasks/lessons.md
  - forge.config.json

DURABLE_RUNTIME_AUTHORITY:
  - Controller Home Requirement / Plan / Work / ControllerRound
  - Process / Schedule / resource claims / authorization / evidence / review

PHASES: understand -> design -> implement -> verify -> review -> cleanup
```

Rules:

- Do not recreate `tasks/contracts`, `tasks/reviews`, `tasks/current.md`, `tasks/workstreams`, or `.ai/harness` as current machine authority. They are legacy migration inputs only.
- Plan is a late semantic commitment, not ceremony for every non-trivial edit.
- High-risk/cross-cutting work must have current Context Closure and Engineering Design evidence before mutation.
- Successor Plans cannot silently drop unresolved predecessor objectives, acceptance criteria, non-goals, decisions, stop conditions, or replan conditions.
- Work completion is bound to exact implementation review and verification evidence; a chat or Markdown status claim is never enough.
