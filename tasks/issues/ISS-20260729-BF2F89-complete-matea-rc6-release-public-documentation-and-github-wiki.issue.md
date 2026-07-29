---
id: "ISS-20260729-BF2F89"
kind: "governance"
status: "in_progress"
updated_at: "2026-07-29T12:50:35.308Z"
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

- Status: `ready`
- Objective: Audit and improve the public documentation for Matea. Rewrite the README information architecture and quick start where needed, align Chinese/English docs, improve CONTRIBUTING, SECURITY, SUPPORT, CHANGELOG and docs navigation, add a platform support matrix and operational concepts, and build a coherent docs/wiki source including Home and _Sidebar. Remove stale names, commands, links, internal-only paths, and duplicated material. Run public documentation and release-surface checks.
- Depends on: none
- Allowed paths: `README.md`, `README.zh-CN.md`, `CONTRIBUTING.md`, `SECURITY.md`, `SUPPORT.md`, `CHANGELOG.md`, `docs/**`, `.github/ISSUE_TEMPLATE/**`, `.github/PULL_REQUEST_TEMPLATE.md`
- Checks: `package:check:public-docs`, `package:check:open-source-surface`, `package:check:release-surface`
- Execution hint: agent / claude

### T3 — Finalize GitHub governance and publish RC6

- Status: `planned`
- Objective: After the code and docs tasks are integrated, push main, verify GitHub CI and Windows smoke on the exact commit, synchronize docs/wiki to the GitHub Wiki repository, tighten safe repository settings such as deleting merged branches and a clear merge strategy, apply an appropriate main ruleset/branch protection using existing CI check names, update repository topics/about links where supported, and create v1.4.0-rc.6 as a GitHub prerelease with accurate notes. Confirm npm publication separately and do not claim it without evidence.
- Depends on: `T1`, `T2`
- Allowed paths: `.github/**`, `package.json`, `CHANGELOG.md`, `docs/wiki/**`
- Checks: `package:check:release-readiness`, `package:check:ci`
- Execution hint: selected at runtime

## Related Artifacts

- `README.md`
- `docs/`
- `docs/wiki/`
- `.github/workflows/`
- `package.json`
