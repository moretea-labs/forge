---
id: "ISS-20260729-3A88E8"
kind: "governance"
status: "cancelled"
updated_at: "2026-07-29T12:39:45.184Z"
source: "repo-harness-controller-v8"
---

# Complete Matea RC6 release, public documentation, and GitHub Wiki

Superseded by ISS-20260729-BF2F89, which is the active RC6 release/documentation/Wiki closeout issue. This duplicate was created during the earlier unstable 502 window.

## Goals

- Make Windows PATH-resolved .cmd/.bat command execution safe and portable.
- Give new users a concise, accurate README and structured public documentation.
- Maintain a complete GitHub Wiki with repository-backed source pages.
- Push an exact validated main revision and require CI/Windows smoke to pass.
- Create the v1.4.0-rc.6 GitHub prerelease with trustworthy release notes.

## Non-goals

- Do not publish npm unless authentication and provenance are independently verified.
- Do not change Stable Supervisor runtime away from the currently verified 58cd291d release.
- Do not rewrite existing Git history or delete historical releases.

## Acceptance Criteria

- [ ] Windows command runner and global runtime fixtures pass targeted and release checks.
- [ ] README, contributing/support/security/release docs, docs navigation, and Wiki source are accurate and link-clean.
- [ ] Main is clean, pushed, and GitHub CI plus Windows smoke are green for the exact release commit.
- [ ] GitHub Wiki is synchronized from reviewed repository source.
- [ ] Repository metadata and merge/branch settings are production-appropriate.
- [ ] v1.4.0-rc.6 tag and GitHub prerelease exist at the exact green commit.

## GitHub

- Not published.

## Tasks

### T1 — Restore native Windows command execution

- Status: `ready`
- Objective: Recreate the previously validated fix for PATH/PATHEXT resolution and safe ComSpec invocation of .cmd/.bat tools, retain direct .exe execution, make global runtime test shims cross-platform, and run type/platform/release-surface validation.
- Depends on: none
- Allowed paths: `src/effects/process-runner.ts`, `tests/process-runner.test.ts`, `tests/cli/global-runtime-init.test.ts`
- Checks: `package:check:type`, `package:check:platform-support`, `package:check:release-surface`
- Execution hint: selected at runtime

### T2 — Improve public docs and Wiki source

- Status: `planned`
- Objective: Audit and improve README, Chinese README, contributing/support/security/changelog/release documentation, docs navigation, installation and concepts pages, troubleshooting, and repository-backed Wiki source. Remove stale names, internal-only material, broken links, and unclear first-run instructions.
- Depends on: `T1`
- Allowed paths: `README.md`, `README.zh-CN.md`, `CONTRIBUTING.md`, `SUPPORT.md`, `SECURITY.md`, `CHANGELOG.md`, `docs/**`, `.github/**`
- Checks: `package:check:public-docs`, `package:check:open-source-surface`, `package:check:release-surface`
- Execution hint: selected at runtime

### T3 — Publish and govern GitHub RC6

- Status: `planned`
- Objective: Review the final diff, run release readiness, merge to main, push using the authenticated SSH path, verify GitHub CI and Windows smoke, synchronize the Wiki repository, configure repository metadata/merge policy/branch cleanup and required checks where permitted, then create the v1.4.0-rc.6 tag and GitHub prerelease at the exact green commit.
- Depends on: `T2`
- Allowed paths: `.github/**`, `docs/**`, `CHANGELOG.md`, `package.json`
- Checks: `package:check:release-readiness`
- Execution hint: selected at runtime

## Related Artifacts

- None.
