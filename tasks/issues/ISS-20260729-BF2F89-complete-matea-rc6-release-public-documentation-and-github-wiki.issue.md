---
id: "ISS-20260729-BF2F89"
kind: "governance"
status: "in_progress"
updated_at: "2026-07-30T14:05:23.655Z"
source: "repo-harness-controller-v8"
---

# Complete Matea RC6 release, public documentation, and GitHub Wiki

Finish the public release baseline from clean main: restore the Windows-native command fix, improve the public documentation and Wiki source, synchronize the GitHub Wiki, harden repository settings, verify CI, and publish v1.4.0-rc.6 only after exact green evidence.

## Goals

- Restore Windows-native PATH/PATHEXT command execution and cross-platform test fixtures.
- Make README and public docs clear, accurate, navigable, and aligned with the Matea package/CLI identity.
- Create and synchronize a useful GitHub Wiki with Home, sidebar, installation, concepts, operations, troubleshooting, security, and release guidance.
- Push clean main, obtain green CI and Windows smoke, tighten GitHub repository governance, and publish the RC6 prerelease.

## Non-goals

- Do not publish npm without confirmed authentication and exact release readiness.
- Do not switch the running Stable Supervisor away from revision 58cd291d7b14 during repository work.
- Do not rewrite Git history or include controller runtime state under _ops or .ai/harness runtime directories.

## Acceptance Criteria

- [ ] Windows-focused tests, TypeScript, platform support, public docs, release surface, and release readiness pass.
- [ ] README, README.zh-CN if present, CONTRIBUTING, SECURITY, SUPPORT, CHANGELOG, docs navigation, and docs/wiki are reviewed for current Matea names, commands, links, and public-safe content.
- [ ] GitHub Wiki is synchronized from reviewed repository sources and contains working Home and _Sidebar navigation.
- [ ] Remote main contains all reviewed commits, required CI and Windows smoke are green, repository merge/branch settings are tightened, and v1.4.0-rc.6 GitHub prerelease is created from the exact green commit.
- [ ] Feature branches and temporary worktrees created for this release are cleaned.

## GitHub

- Not published.

## Tasks

### T1 — Restore native Windows command execution

- Status: `verified`
- Objective: Reimplement the previously validated Windows process-runner fix from clean main. Resolve commands using Windows PATH/PATHEXT case-insensitively, route .cmd/.bat through ComSpec with safe argument escaping, keep .exe direct, and replace Unix-only global-runtime fake command fixtures with cross-platform shims. Run targeted tests and declared release checks, then commit and integrate cleanly.
- Depends on: none
- Allowed paths: `src/effects/process-runner.ts`, `tests/process-runner.test.ts`, `tests/cli/global-runtime-init.test.ts`
- Checks: `package:check:type`, `package:check:platform-support`, `package:check:release-surface`
- Execution hint: agent / codex

### T2 — Rework public docs and Wiki source

- Status: `verified`
- Objective: Audit and improve the public documentation for Matea. Rewrite the README information architecture and quick start where needed, align Chinese/English docs, improve CONTRIBUTING, SECURITY, SUPPORT, CHANGELOG and docs navigation, add a platform support matrix and operational concepts, and build a coherent docs/wiki source including Home and _Sidebar. Remove stale names, commands, links, internal-only paths, and duplicated material. Run public documentation and release-surface checks.
- Depends on: none
- Allowed paths: `README.md`, `README.zh-CN.md`, `CONTRIBUTING.md`, `SECURITY.md`, `SUPPORT.md`, `CHANGELOG.md`, `docs/**`, `.github/ISSUE_TEMPLATE/**`, `.github/PULL_REQUEST_TEMPLATE.md`
- Checks: `package:check:public-docs`, `package:check:open-source-surface`, `package:check:release-surface`
- Execution hint: agent / claude

### T3 — Finalize GitHub governance and publish RC6

- Status: `running`
- Objective: After the code and docs tasks are integrated, push main, verify GitHub CI and Windows smoke on the exact commit, synchronize docs/wiki to the GitHub Wiki repository, tighten safe repository settings such as deleting merged branches and a clear merge strategy, apply an appropriate main ruleset/branch protection using existing CI check names, update repository topics/about links where supported, and create v1.4.0-rc.6 as a GitHub prerelease with accurate notes. Confirm npm publication separately and do not claim it without evidence.
- Depends on: `T1`, `T2`
- Allowed paths: `.github/**`, `package.json`, `CHANGELOG.md`, `docs/wiki/**`
- Checks: `package:check:release-readiness`, `package:check:ci`
- Execution hint: selected at runtime

### T4 — Expose verified known-good release attestation

- Status: `done`
- Objective: Expose the existing attestKnownGood operation through the standalone Recovery CLI and MCP gateway only after full independent verification succeeds. Add focused tests for tool exposure, dispatch, state persistence, and rollback eligibility. Rebuild and activate the exact main revision, attest it as known-good, cold-restart the Supervisor, and verify the release remains active and rollback-safe.
- Depends on: `T1`
- Allowed paths: `src/runtime/standalone-recovery/core.ts`, `src/runtime/standalone-recovery/entry.ts`, `tests/runtime/**`, `tasks/issues/ISS-20260729-BF2F89-*`
- Checks: `package:check:type`, `package:check:release-readiness`
- Execution hint: selected at runtime

### T5 — Repair standalone Recovery HTTPS transport before RC6

- Status: `superseded`
- Objective: Release-blocking repair. Start from clean main a8faa5369ad6571e32d8f90a060b8ab55e20b8e2 and independently verify the regression history: commit 9d13ec6cf28319a650b05afeb44e15e18f7a157a introduced Bun fetch for standalone Recovery HTTPS traffic; commit 329028b64ddcf40b23ea09ab4aea9e9bdc1281b3 extended the same transport to the full MCP lifecycle; commit e4cf015a037eb602dcdb6f37e53008fa31e660ce only accepted a valid 401 Bearer challenge and did not fix Bun TLS verification. Reproduce that curl, Node fetch, and OpenSSL verify https://mcp.moretea-lab.tech/mcp successfully while Bun fetch/Bun https and the compiled recovery binary fail with unknown certificate verification error. Implement a production-safe HTTPS transport for standalone Recovery that does not depend on Bun TLS certificate verification. Prefer a small explicit transport abstraction; a fixed system curl implementation is acceptable only if asynchronous/non-blocking, bounded by timeouts and output limits, does not invoke a shell, does not expose bearer tokens or JSON bodies in argv/process listings/logs/errors, uses mode-0600 temporary request material below controller-home/recovery, always cleans it on success/error/timeout/cancellation, parses HTTP status/headers/body and MCP event-stream responses correctly, preserves MCP session IDs, and keeps local HTTP health probes compatible. Do not disable TLS verification, use --insecure, NODE_TLS_REJECT_UNAUTHORIZED=0, inherit the full user environment, weaken known-good attestation, or special-case the production hostname. Add focused tests for GET 401 OAuth challenge, authenticated initialize, notifications/initialized, tools/list, read-only tools/call, DELETE session close, timeout/error cleanup, no secret leakage, and no event-loop blocking/deadlock. Ensure Windows behavior either uses a verified system curl path or fails closed with a precise error; do not regress native Windows release checks. Rebuild and reinstall standalone Recovery in an isolated validation step, restart its launchd gateway/watchdog, verify the real external endpoint and authenticated MCP lifecycle, attest the exact active release, and prove a real Stable Supervisor restart keeps the same exact revision and full MCP health. Commit the scoped fix in the isolated worktree, but do not push, tag, publish npm, or create a GitHub Release. Return the exact commit, changed files, commands, live verification evidence, and remaining risks for independent ChatGPT review.
- Depends on: `T4`
- Allowed paths: `src/runtime/standalone-recovery/**`, `tests/runtime/standalone-recovery.test.ts`, `scripts/install-standalone-recovery.ts`, `docs/operations/standalone-disaster-recovery.md`
- Checks: `package:check:type`, `package:check:runtime-architecture`, `package:check:release-readiness`
- Execution hint: agent / codex

### T6 — Fix RC6 Windows global runtime fixture failure

- Status: `running`
- Objective: Reproduce and fix the exact Windows smoke failure in tests/cli/global-runtime-init.test.ts at final RC6 commit 733f7917. Installer dry-run and platform contract already pass; the failure is limited to fake command/runtime fixture execution returning exit code 1 on windows-latest. Inspect the GitHub run 30511067300, identify the first causal error rather than patching downstream assertions, make the smallest cross-platform change, add focused regression coverage, run type/platform/release readiness locally, push a new main commit, and require both Linux CI and Windows smoke to pass before tagging. Do not publish or tag until green.
- Depends on: none
- Allowed paths: `tests/cli/global-runtime-init.test.ts`, `src/runtime/effects/**`, `src/runtime/execution/**`, `src/cli/**`, `scripts/check-platform-support.mjs`, `.github/workflows/windows-smoke.yml`, `tasks/issues/**`
- Checks: `package:check:type`, `package:check:platform-support`, `package:check:release-readiness`
- Execution hint: agent / codex

### T7 — Self-heal a stalled Cloudflare tunnel connector

- Status: `verified`
- Objective: Prevent the production MCP endpoint from remaining unavailable when the registered cloudflared launchd process is alive but has no active tunnel connector. Add an explicit, opt-in public tunnel launchd service binding to standalone Recovery; detect the isolated failure shape where local ingress, active Gateway, and authenticated MCP lifecycle are healthy but the external endpoint fails; perform a bounded, rate-limited launchctl kickstart of only the configured service; verify the external endpoint and full MCP lifecycle after restart; expose a manually invokable Recovery action; add failure-injection tests, installer/configuration support, and an operations runbook. Never restart an unconfigured service, never weaken TLS/OAuth, never roll back a known-good application revision for a tunnel-only failure, and never expose credentials.
- Depends on: none
- Allowed paths: `src/runtime/standalone-recovery/**`, `scripts/install-standalone-recovery.ts`, `tests/runtime/standalone-recovery.test.ts`, `docs/operations/**`, `docs/repo-harness-chatgpt-mcp-setup.md`, `package.json`
- Checks: `package:check:type`, `package:check:runtime-architecture`, `package:check:release-readiness`
- Execution hint: agent / codex

### T8 — Preserve literal percent arguments through Windows command shims

- Status: `ready`
- Objective: Fix the exact Windows smoke regression where ComSpec execution of a PATH-resolved .cmd/.bat doubles a literal percent argument. Preserve command arguments exactly, including standalone percent and environment-variable-looking percent pairs, while retaining safe quoting for spaces, ampersands and quotes. Add preparation-level tests plus a real Windows command-shim regression, run focused/type/platform/release gates, verify through the Windows smoke workflow on the exact branch commit, then integrate before RC6 publication.
- Depends on: none
- Allowed paths: `src/effects/process-runner.ts`, `tests/process-runner.test.ts`, `.github/workflows/windows-smoke.yml`, `tasks/issues/ISS-20260729-BF2F89-*`
- Checks: `package:check:type`, `package:check:platform-support`, `package:check:release-readiness`
- Execution hint: selected at runtime

## Related Artifacts

- `README.md`
- `docs/`
- `docs/wiki/`
- `.github/workflows/`
- `package.json`
