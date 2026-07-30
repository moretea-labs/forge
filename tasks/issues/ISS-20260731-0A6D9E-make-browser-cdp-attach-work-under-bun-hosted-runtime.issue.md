---
id: "ISS-20260731-0A6D9E"
kind: "bug"
status: "in_progress"
updated_at: "2026-07-30T21:14:20.568Z"
source: "repo-harness-controller-v8"
---

# Make Browser CDP attach work under Bun-hosted runtime

Live Browser Attach verification proved Chrome 150 CDP is reachable and Node + Playwright connectOverCDP succeeds immediately, while the same installed Playwright call under Bun 1.3.14 times out during the DevTools WebSocket connection. The production Gateway is Bun-hosted, so attach_preferred cannot yet attach despite correct schema, endpoint discovery and Chrome configuration.

## Goals

- Implement a bounded production-safe Node execution boundary for CDP attach while keeping existing managed_persistent behavior unchanged.
- Preserve session metadata, tab discovery/reuse, disconnect-without-closing semantics, allowed-domain policy and redacted diagnostics.
- Prove real Chrome attach, duplicate-tab avoidance, session reuse after Gateway restart, stale endpoint fail-closed and managed fallback.

## Non-goals

- Do not weaken loopback endpoint validation or domain policy.
- Do not switch the entire Controller runtime from Bun to Node.
- Do not automate credentials, MFA, purchases or destructive browser actions.

## Acceptance Criteria

- [ ] Node + Playwright and the Browser plugin both attach to the same loopback Chrome CDP endpoint.
- [ ] An existing GitHub tab is reused without creating a duplicate tab.
- [ ] An explicit new session_id is persisted and can be resumed after Gateway restart.
- [ ] Disconnecting the plugin does not terminate the attached Chrome process.
- [ ] Stale endpoint diagnostics pass in fail_closed mode and managed_persistent fallback remains available.
- [ ] Focused browser tests, typecheck, runtime architecture and controller-v8 checks pass.

## GitHub

- Not published.

## Tasks

### T1 — Implement Node CDP bridge and complete live Browser Attach proof

- Status: `verified`
- Objective: Starting from clean main 0bcf2f984415a90af09345dd274f95efc7cb0872, inspect the current Browser adapter and existing process/runtime boundaries. Implement the smallest explicit Node-hosted bridge required only for CDP-attached Browser operations because Bun Playwright WebSocket attach times out while Node succeeds. Keep managed persistent/isolated execution in-process. The bridge must use a resolved trusted Node executable, no shell, bounded startup/action/idle timeouts, bounded JSON messages, no cookies/storage/secrets in logs or durable state, exact loopback endpoint validation, domain route enforcement, clean child termination, and disconnect rather than browser close. Preserve generic action coverage and session/tab metadata. Add focused unit/integration tests and a live smoke path. Run browser tests, package:check:type, package:check:runtime-architecture and package:check:controller-v8. Commit in an isolated worktree; do not push or publish.
- Depends on: none
- Allowed paths: `src/runtime/plugins/**`, `tests/runtime/browser-plugin.test.ts`, `tests/runtime/**`, `scripts/**`, `docs/operations/controller-browser-plugin.md`, `docs/architecture/current/human-interaction-plane.md`, `package.json`, `tasks/issues/**`
- Checks: `package:check:type`, `package:check:runtime-architecture`, `package:check:controller-v8`
- Execution hint: agent / codex

## Related Artifacts

- `commit:29f05087112de251c999424044a8bfd15fb77664`
- `commit:0bcf2f984415a90af09345dd274f95efc7cb0872`
- `live-proof: Node connectOverCDP succeeds; Bun connectOverCDP times out at ws://127.0.0.1:9222/devtools/browser/...`
