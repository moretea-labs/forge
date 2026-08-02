---
id: "ISS-20260731-0A6D9E"
kind: "bug"
status: "done"
updated_at: "2026-08-02T06:21:37.486Z"
source: "repo-harness-controller-v8"
---

# 让 Repo Harness 可靠连接用户 Chrome

已完成。Bun-hosted Gateway 通过受控 Node CDP bridge 可靠连接真实 Chrome，已验证现有 tab 复用、session 恢复、Gateway 重启后重连、stale endpoint fail-closed 和不关闭用户浏览器。旧 Task 仅缺历史 delivery receipt，不再视为未完成需求。

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

- `commit 546770877d7e046ccb3d89be7413ca867307b389`
- `ISS-20260731-6A7BB5 continuing user-Chrome default routing`
