## Operating Mode

- Default to **{{RUNTIME_MODE}}**.
- Runtime profile: {{RUNTIME_PROFILE}}; recovery: {{RECOVERY_PROFILE}}; state: {{STATE_PROFILE}}; context: {{CONTEXT_PROFILE}}.
- Claude runtime expectation: {{CLAUDE_POLICY}}.
- Codex runtime expectation: {{CODEX_POLICY}}.
- Do not implement until the user requests implementation. After authorization, execute non-blocked work without unnecessary human handoffs.
- For authenticated browser work, reuse the user's signed-in Chrome session; preserve cookies and tokens, and do not switch profiles without authorization.

### Current Authority
- For Forge source development, the tracked GitHub Issue/Project owns requirements, architecture decisions, priority, progress, and acceptance.
- Current source, public APIs, Git state, static checks, and focused tests own executable implementation facts.
- Controller Home owns runtime facts such as Process/Schedule/resource claims/authorization/evidence; optional Requirement/Plan semantic records do not replace the source Issue/Project.
- tasks/todos.md holds deferred goals; tasks/lessons.md holds reusable corrections; task-local research may live in tasks/notes/.
- Do not recreate repo-local spec/research/architecture/workstream ledgers as parallel authority.
- Choose checkout isolation only for real writer/resource conflicts.

### Other Context
- README and GitHub Pages are the maintained public documentation surfaces.
- deploy/ may hold versioned deployment assets; _ops/ is private local scratch/secret state and must not become project authority.
- Source navigation: bounded ripgrep then explicit symbol navigation as needed.
- Third-party host skills are optional and must not change Forge workflow correctness.
