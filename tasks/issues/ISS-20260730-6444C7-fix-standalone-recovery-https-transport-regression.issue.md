---
id: "ISS-20260730-6444C7"
kind: "bug"
status: "done"
updated_at: "2026-07-30T03:03:49.527Z"
source: "repo-harness-controller-v8"
---

# Fix standalone Recovery HTTPS transport regression

Resolved and independently verified. The standalone Recovery external HTTPS/MCP lifecycle now uses a fixed trusted system curl transport with minimal environment, protected temporary material and bounded asynchronous execution. Final installed revision 814824d2 is known-good; full external MCP lifecycle, official Supervisor PID-change restart, and paced 20/20 public probes passed. The ledger still projects the terminal task as integration-blocked solely because the takeover had no compatible legacy Run delivery receipt; this accounting defect is tracked separately and does not reflect an implementation or release failure.

## Goals

- Replace the failing Recovery external HTTPS transport with a production-safe, certificate-validating, asynchronous implementation.
- Prove the complete external OAuth and authenticated MCP lifecycle against the real endpoint.
- Preserve secret isolation, known-good attestation safeguards, cross-platform behavior and non-blocking Recovery operation.
- Return a clean isolated commit for independent review before RC6 publication resumes.

## Non-goals

- Do not disable certificate verification or use insecure TLS options.
- Do not weaken OAuth, known-good matching, rollback restrictions or Supervisor fencing.
- Do not modify package version, release workflows, GitHub Wiki or repository governance.
- Do not push, tag, publish npm or create a GitHub Release.

## Acceptance Criteria

- [ ] Regression history is confirmed: 9d13ec6c introduced Bun fetch, 329028b6 extended it to MCP sessions, and e4cf015a only corrected 401 challenge classification.
- [ ] curl, Node and OpenSSL success plus Bun/compiled Recovery failure are reproduced before the fix.
- [ ] External OAuth 401 challenge and authenticated initialize, initialized notification, tools/list, read-only tools/call and DELETE session close pass after the fix.
- [ ] Bearer tokens and request bodies never appear in argv, process listings, logs, returned errors or committed fixtures.
- [ ] Temporary request material is mode 0600 and removed on success, error, timeout and cancellation.
- [ ] The implementation is asynchronous and cannot deadlock an in-process HTTP server or block the Recovery gateway event loop.
- [ ] Windows either uses a validated system transport or fails closed clearly; Windows release checks remain green.
- [ ] Focused tests, package:check:type, package:check:runtime-architecture and package:check:release-readiness pass.
- [ ] Rebuilt installed Recovery verifies the real endpoint, attests the exact active release, and a real Stable Supervisor restart changes PID while retaining exact revision, known-good evidence and full MCP health.
- [ ] No remote or publication side effects occur.

## GitHub

- Not published.

## Tasks

### T1 — Implement and prove safe Recovery HTTPS transport

- Status: `done`
- Objective: Start from exact clean main a8faa5369ad6571e32d8f90a060b8ab55e20b8e2. Independently confirm the regression history and reproduce the real endpoint behavior. Implement a small explicit external HTTPS transport abstraction for standalone Recovery that does not depend on Bun TLS certificate verification. A fixed system curl approach is acceptable only if invoked directly without a shell, asynchronously/non-blocking, with bounded timeout/output, minimal environment, secure mode-0600 request material, guaranteed cleanup, correct status/header/body parsing including multiple header blocks, MCP JSON/event-stream parsing and session ID preservation. Never put Authorization or JSON bodies in argv or returned diagnostics. Preserve existing local HTTP health behavior. Add focused tests for GET 401 OAuth challenge, authenticated initialize, notifications/initialized, tools/list, read-only tools/call, DELETE session close, timeout/error/cancellation cleanup, no secret leakage, no event-loop deadlock and Windows fail-closed/system transport behavior. Rebuild and reinstall standalone Recovery, restart its launchd gateway/watchdog, verify the real public endpoint and authenticated MCP lifecycle, attest the exact active release, and use the official Recovery restart action to prove the Supervisor PID changes while exact revision, known-good evidence, ingress, gateway and MCP health remain coherent. Commit only scoped source/tests/docs in the isolated worktree. Do not push or publish. Return exact commit, changed files, commands, live evidence and remaining risks for independent ChatGPT review.
- Depends on: none
- Allowed paths: `src/runtime/standalone-recovery/**`, `tests/runtime/standalone-recovery.test.ts`, `scripts/install-standalone-recovery.ts`, `docs/operations/standalone-disaster-recovery.md`
- Checks: `package:check:type`, `package:check:runtime-architecture`, `package:check:release-readiness`
- Execution hint: agent / codex

## Related Artifacts

- `src/runtime/standalone-recovery/core.ts`
- `src/runtime/standalone-recovery/entry.ts`
- `tests/runtime/standalone-recovery.test.ts`
- `scripts/install-standalone-recovery.ts`
- `docs/operations/standalone-disaster-recovery.md`
- `ISS-20260729-BF2F89/T3`
