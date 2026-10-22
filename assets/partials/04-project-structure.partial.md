## Project Structure

Illustrative source/documentation layout only. Controller Home is authoritative for active Requirement/Plan/Work/receipts, regardless of directories appearing in a historical template.

```
{{PROJECT_STRUCTURE}}
```

### Tech Stack

| Layer | Technology |
|-------|------------|
{{TECH_STACK_TABLE}}

{{#IF WEBAPP_RENDERING_MODEL_ENABLED}}
### Webapp Rendering Model
{{WEBAPP_RENDERING_MODEL_SUMMARY}}
| Boundary | Default |
|----------|---------|
{{WEBAPP_RENDERING_TECH_STACK_TABLE}}
{{/IF}}
{{#IF AI_NATIVE_PROFILE_ENABLED}}
### AI-Native Profile
{{AI_NATIVE_PROFILE_SUMMARY}}
| Layer | Technology |
|-------|------------|
{{AI_NATIVE_TECH_STACK_TABLE}}
{{/IF}}
---

## Workflow Rules
- Prefer modifying existing files over adding new ones.
- Respect the selected {{RUNTIME_MODE}} runtime mode and user authorization.
- Keep product intent in docs/spec.md; tasks/todos.md and tasks/lessons.md are human notes.
- Keep live Requirement, Plan, Work, review decisions and verification receipts in Controller Home, not tasks/contracts/ or .ai/harness/.
- Use an isolated worktree when there is a real writer conflict; preserve unrelated dirty bytes.
- Commit deliberately after sufficient existing checks; choose integration separately from completing Work.
- _ref/ is only an ignored external source-comparison cache; cite exact revisions in research.
- deploy/ contains trackable runbooks and SQL; _ops/ is private local state and must not be committed.
- Optional host skills and gstack/Waza/gbrain do not define Forge lifecycle authority.
- For source discovery use ripgrep and explicit language-service navigation as appropriate.
- Do not run retired .ai/harness/ workflow scripts or regenerate a repo-local runtime controller.
