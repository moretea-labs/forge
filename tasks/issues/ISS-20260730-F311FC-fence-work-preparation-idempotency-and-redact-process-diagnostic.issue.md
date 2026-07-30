---
id: "ISS-20260730-F311FC"
kind: "bug"
status: "done"
updated_at: "2026-07-30T06:12:34.040Z"
source: "repo-harness-controller-v8"
---

# Fence Work preparation idempotency and redact process diagnostics

Two production stability/security defects were reproduced during independent Recovery verification: repeated work_prepare calls with the same request_id created multiple WorkContracts and isolated worktrees instead of returning the original durable result; and repository command diagnostics returned launchctl-style inherited environment output without reliably redacting credential-shaped values. These defects create duplicate execution state, cleanup accumulation, and potential secret exposure through tool responses or stored process evidence.

## Goals

- Make work_prepare atomically idempotent for repository/session/request identity and fail closed on request fingerprint conflicts.
- Apply centralized redaction to process stdout/stderr, result references, summaries, logs and evidence before any user-visible or persisted diagnostic surface.
- Add regression and race tests reproducing the exact duplicate WorkContract/worktree and launchctl-style secret-output failures.
- Safely reconcile the duplicate cancelled Recovery WorkContracts/worktrees created by the reproduction without deleting unrelated work.

## Non-goals

- Do not expose, recover or repeat any credential value observed during reproduction.
- Do not weaken command authorization, repository scoping, secret access or destructive cleanup gates.
- Do not redesign all WorkContract or Process Runtime schemas.
- Do not push, publish or rotate credentials automatically.

## Acceptance Criteria

- [ ] Concurrent and sequential identical work_prepare requests with the same request_id return exactly one WorkContract, checkout, branch and worktree.
- [ ] Reusing a request_id with a different canonical fingerprint fails closed with a stable conflict code and creates no additional state.
- [ ] Crash/restart recovery preserves the idempotency index and never repeats worktree creation.
- [ ] Credential-shaped values in launchctl-style output, environment assignments, authorization headers, URLs and generic secret key/value forms are redacted before stdout/stderr, resultRef, process logs, summaries or evidence leave the execution boundary.
- [ ] Redaction preserves useful non-sensitive diagnostics and is applied consistently to direct and managed Process Runtime results.
- [ ] Existing persisted unsafe process artifacts are identified and quarantined or replaced with redacted evidence without printing their contents.
- [ ] Duplicate cancelled Recovery WorkContracts/worktrees are safely reconciled through controller-owned cleanup, with unrelated worktrees untouched.
- [ ] Focused tests, package:check:type, package:check:runtime-architecture and package:check:controller-v8 pass.
- [ ] Credential rotation is recorded as a required human security action; no credential is included in Issue or test fixtures.

## GitHub

- Not published.

## Tasks

### T1 — Make work_prepare atomically idempotent

- Status: `done`
- Objective: Trace work_prepare from MCP facade through WorkContract and isolated worktree creation. Add a durable atomic request index keyed by repository, session/principal and request_id with a canonical operation fingerprint. Identical retries must return the original Work and workspace; fingerprint mismatch must fail closed before side effects. Add sequential, concurrent and restart-recovery tests using the exact reproduced pattern. Reconcile only the duplicate cancelled Recovery WorkContracts/worktrees after ownership and cleanliness checks.
- Depends on: none
- Allowed paths: `src/runtime/control-plane/**`, `src/runtime/gateway/mcp/**`, `src/cli/mcp/**`, `src/cli/controller/**`, `tests/runtime/**`, `tests/cli/**`, `docs/architecture/current/**`, `docs/operations/**`, `tasks/issues/**`
- Checks: `package:check:type`, `package:check:runtime-architecture`, `package:check:controller-v8`
- Execution hint: agent / codex

### T2 — Redact secrets at the Process Runtime output boundary

- Status: `done`
- Objective: Trace all direct and managed Process Runtime stdout/stderr, logs, resultRef, summary and Evidence Plane serialization. Add centralized bounded redaction for authorization material and credential-shaped environment/key-value output before persistence and before returning any tool result. Add launchctl-style fixtures with synthetic values, direct/managed path parity tests, artifact quarantine/migration for unsafe historical results, and documentation. Never include a real credential in source, tests, Issue notes or output.
- Depends on: `T1`
- Allowed paths: `src/runtime/execution/**`, `src/runtime/evidence/**`, `src/runtime/gateway/mcp/**`, `src/cli/mcp/**`, `src/cli/controller/**`, `tests/runtime/**`, `tests/cli/**`, `docs/architecture/current/**`, `docs/operations/**`, `SECURITY.md`, `tasks/issues/**`
- Checks: `package:check:type`, `package:check:runtime-architecture`, `package:check:controller-v8`
- Execution hint: agent / codex

### T3 — Sanitize historical Process and result artifacts

- Status: `done`
- Objective: Run the bounded in-place Process Runtime and Controller result-store sanitizers against the stable controller repository state without returning historical contents. Record counts only, verify second-pass idempotency, preserve active process artifacts, and confirm no repository source changes are produced.
- Depends on: `T2`
- Allowed paths: `src/runtime/execution/**`, `src/runtime/evidence/**`, `docs/operations/**`, `tasks/issues/**`
- Checks: `package:check:type`, `package:check:runtime-architecture`, `package:check:controller-v8`
- Execution hint: agent / codex

### T4 — Reconcile duplicate Recovery work and close security acceptance

- Status: `done`
- Objective: Identify only the duplicate cancelled Recovery WorkContracts/worktrees created by the reproduced work_prepare retry defect, verify controller ownership, terminal state, cleanliness and merge disposition, then reconcile them through controller-owned cleanup without touching unrelated active work. Record credential rotation/revocation as a required human action without exposing any credential, verify exact-main checks and clean Git state, and close the Issue with auditable evidence.
- Depends on: `T3`
- Allowed paths: `src/runtime/control-plane/**`, `src/cli/controller/**`, `docs/operations/**`, `SECURITY.md`, `tasks/issues/**`
- Checks: `package:check:type`, `package:check:runtime-architecture`, `package:check:controller-v8`
- Execution hint: agent / codex

## Related Artifacts

- `work_prepare`
- `work_25cf8ace1ed642d4bcd6841f6622b41b`
- `ISS-20260730-6444C7`
- `src/runtime/execution/**`
- `src/runtime/control-plane/**`
- `src/runtime/gateway/mcp/**`
- `src/cli/mcp/**`
