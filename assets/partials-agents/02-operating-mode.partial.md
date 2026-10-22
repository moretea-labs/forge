## Operating Mode

- Default to **{{RUNTIME_MODE}}**.
- Runtime profile: {{RUNTIME_PROFILE}}; recovery: {{RECOVERY_PROFILE}}; state: {{STATE_PROFILE}}; context: {{CONTEXT_PROFILE}}.
- Claude runtime expectation: {{CLAUDE_POLICY}}.
- Codex runtime expectation: {{CODEX_POLICY}}.
- Do not implement until the user requests implementation. After authorization, execute non-blocked work without unnecessary human handoffs.
- For authenticated browser work, reuse the user's signed-in Chrome session; preserve cookies and tokens, and do not switch profiles without authorization.

### Current Authority
- In a modern forge.config.json project, **Controller Home SQLite is the sole durable machine authority** for Requirement, Plan, Work, ControllerRound, Process, Schedule, permissions and evidence. Read/update it through Forge tools.
- docs/spec.md and docs/researches/ are human product and research context. tasks/todos.md holds deferred goals; tasks/lessons.md holds human-readable corrections.
- plans/, tasks/contracts/, tasks/reviews/, tasks/notes/, tasks/workstreams/, and .ai/harness/ are legacy migration/history, not live plan, completion, checks or session authorities. Do not create or revive them.
- Use current Controller Home Work/Plan, Git and real receipts to resume. Choose checkout isolation on actual writer conflicts, not retired worktree-policy scripts.
- The model decides which existing checks/review to run and when to complete; Git delivery is a separate explicit decision.

### Other Context
- docs/reference-configs/agentic-development-flow.md and external-tooling.md describe optional tool routing, not workflow authority.
- deploy/ holds versioned operational runbooks; _ops/ is private local scratch/secret state, never commit or edit it as a project artifact.
- Source navigation: bounded ripgrep then explicit symbol navigation as needed.
- Third-party host skills are optional and must not change Forge workflow correctness.
