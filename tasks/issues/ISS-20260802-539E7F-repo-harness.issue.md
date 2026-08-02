---
id: "ISS-20260802-539E7F"
kind: "governance"
status: "planned"
updated_at: "2026-08-02T06:30:18.733Z"
source: "repo-harness-controller-v8"
---

# 让 Repo Harness 升级和重启时保持可用

唯一的主运行时稳定性需求。目标是通过固定 Bootstrap、自包含发布、单一运行时权威与配置、Supervisor 单 owner、last-known-good 切流和独立 Recovery，消除重复进程、多配置和半完成发布造成的断联。

## Goals

- Reduce long-lived process managers, state authorities, configuration sources, and compatibility branches.
- Make launchd start a fixed bootstrap that is independent of ordinary runtime releases and mutable worktrees.
- Make every managed runtime and Recovery release self-contained and immutable.
- Allow only the Supervisor to mutate primary runtime authority; Daemon and Gateway expose health but cannot write root authority.
- Replace persistent blue/green slot identity with temporary candidate and previous release instances around an atomic cutover.
- Keep stable ingress on the last-known-good release until the candidate passes complete readiness and post-cutover verification.
- Keep Recovery source in the monorepo while installing it as independently supervised immutable binaries with a dedicated public tunnel.
- Make cold start, crash recovery, interrupted rollout, stale process, and primary/Recovery failure isolation mandatory release gates.
- Complete a one-way migration and delete obsolete dual-read, dual-write, slot-config, argv-override, and legacy lifecycle paths.

## Non-goals

- Do not preserve internal runtime-state compatibility indefinitely.
- Do not create a separate Recovery Git repository.
- Do not introduce multi-host consensus or a general distributed-systems platform.
- Do not allow Recovery to become a second primary runtime writer or arbitrary shell execution service.
- Do not push remote changes without explicit user authorization.
- Do not preserve the current long-lived blue/green data model merely for compatibility.

## Acceptance Criteria

- [ ] launchd service definitions reference fixed bootstrap or stable current pointers rather than an ordinary mutable worktree or active runtime slot.
- [ ] Managed runtime and Recovery can cold-start after the repository worktree is moved or unavailable.
- [ ] Exactly one primary runtime authority file and one primary runtime configuration file exist after migration; root/blue/green duplicate configuration and argv business overrides are gone.
- [ ] Supervisor directly owns primary runtime process lifecycle; no nested Gateway KeepAlive acts as a second process manager.
- [ ] At most one committed primary generation exists; stale instances cannot mutate authority and are terminated or isolated deterministically.
- [ ] Candidate failure before cutover leaves last-known-good traffic uninterrupted; post-cutover failure atomically returns traffic to a verified previous release.
- [ ] Primary Gateway failure does not remove Recovery reachability, and Recovery failure does not restart or mutate the primary runtime.
- [ ] The supported migration is one-way, transactional, backed up, and verified; unsupported legacy state reports MIGRATION_REQUIRED instead of fallback guessing.
- [ ] Fault-injection tests cover every rollout phase, launchd restart, stale callback, duplicate process, port conflict, cold boot, tunnel failure, and interrupted install.
- [ ] After verified cutover, obsolete lifecycle code, compatibility readers/writers, stale services, old worktrees/branches, and redundant Issues are removed or explicitly superseded.

## GitHub

- Not published.

## Tasks

### T1 — Freeze target architecture and deletion map

- Status: `ready`
- Objective: Write the executable target architecture, process ownership table, authoritative state/config schemas, service graph, availability invariants, one-way migration contract, and an explicit list of legacy components and fallback paths to delete. Reconcile overlapping runtime/recovery Issues so this Issue is the implementation authority and ISS-20260802-27931A remains the Recovery delivery line rather than a competing architecture.
- Depends on: none
- Allowed paths: `docs/architecture/**`, `docs/operations/**`, `docs/runbooks/**`, `tasks/issues/**`
- Checks: not defined
- Execution hint: selected at runtime

### T2 — Build fixed bootstrap and self-contained immutable releases

- Status: `planned`
- Objective: Introduce a fixed Supervisor bootstrap executable or stable activation path that launchd never binds to an ordinary runtime revision. Package Supervisor/Daemon/Gateway/process runtime and all required code into self-contained immutable releases with manifests; runtime execution must not depend on the repository worktree, Bun installation path, or mutable runtime-source-root.
- Depends on: `T1`
- Allowed paths: `src/runtime/bootstrap/**`, `src/runtime/supervisor/**`, `src/runtime/control-plane/**`, `src/runtime/gateway/**`, `src/runtime/execution/**`, `scripts/**`, `tests/runtime/**`, `package.json`
- Checks: `package:check:type`, `package:check:runtime-architecture`, `package:check:ci`
- Execution hint: selected at runtime

### T3 — Converge to one runtime authority and one config

- Status: `planned`
- Objective: Create a single Supervisor-owned runtime authority record and one runtime configuration record. Move Daemon/Gateway to health/report-only roles, remove root authority writes from children, implement an atomic one-way migration from root/blue/green and legacy MCP configs, then refuse unmigratable state with MIGRATION_REQUIRED.
- Depends on: `T1`, `T2`
- Allowed paths: `src/cli/controller/stable-state/**`, `src/cli/controller/runtime-slots.ts`, `src/cli/mcp/**`, `src/runtime/supervisor/**`, `src/runtime/control-plane/**`, `src/runtime/gateway/**`, `src/runtime/shared/**`, `scripts/**`, `tests/**`, `docs/operations/**`
- Checks: `package:check:type`, `package:check:runtime-architecture`, `package:check:mcp-compatibility`, `package:check:ci`
- Execution hint: selected at runtime

### T4 — Collapse primary process hierarchy

- Status: `planned`
- Objective: Remove Gateway KeepAlive as a second process manager and make Supervisor directly spawn, observe, restart, and stop the Daemon and Gateway process groups. Replace long-lived blue/green slot ownership with release-instance identities: active, candidate, and short-lived previous.
- Depends on: `T2`, `T3`
- Allowed paths: `src/runtime/supervisor/**`, `src/runtime/control-plane/**`, `src/runtime/gateway/**`, `src/cli/mcp/keepalive.ts`, `src/cli/mcp/restart.ts`, `src/cli/controller/**`, `scripts/**`, `tests/runtime/**`, `tests/cli/**`
- Checks: `package:check:type`, `package:check:runtime-architecture`, `package:check:mcp-compatibility`, `package:check:ci`
- Execution hint: selected at runtime

### T5 — Implement transactional rollout and last-known-good ingress

- Status: `planned`
- Objective: Implement one durable rollout state machine: prepare candidate, start on isolated endpoint, complete readiness/canary, CAS authority, atomically switch ingress, post-verify, retain previous during rollback window, then retire it. Failed candidates must never remove service from the last-known-good instance.
- Depends on: `T3`, `T4`
- Allowed paths: `src/runtime/bootstrap/**`, `src/runtime/supervisor/**`, `src/runtime/gateway/**`, `src/runtime/health/**`, `src/runtime/recovery/**`, `scripts/**`, `tests/runtime/**`, `docs/operations/**`
- Checks: `package:check:type`, `package:check:runtime-architecture`, `package:check:controller-v8`, `package:check:ci`
- Execution hint: selected at runtime

### T6 — Deliver standalone immutable Recovery and dedicated tunnel

- Status: `planned`
- Objective: Replan and complete ISS-20260802-27931A under the simplified architecture: Recovery remains in the monorepo but installs as versioned self-contained binaries, uses independent launchd services and state, monitors its own local/public endpoint through a dedicated cloudflared service, and never depends on or writes primary runtime authority.
- Depends on: `T1`, `T2`, `T3`
- Allowed paths: `src/runtime/standalone-recovery/**`, `scripts/install-standalone-recovery.ts`, `scripts/load-standalone-recovery.sh`, `tests/runtime/standalone-recovery.test.ts`, `tests/runtime/**`, `docs/operations/**`, `recovery/**`
- Checks: `package:check:type`, `package:check:runtime-architecture`, `package:check:ci`
- Execution hint: selected at runtime

### T7 — Delete compatibility and obsolete lifecycle paths

- Status: `planned`
- Objective: After the new runtime is available behind an explicit cutover flag, remove old blue/green authority/config readers, repo-local MCP fallback, legacy toolset migration branches, nested keepalive production startup, old restart coordinators, stale service templates, and duplicate projections. Do not retain hidden fallback paths.
- Depends on: `T3`, `T4`, `T5`, `T6`
- Allowed paths: `src/**`, `scripts/**`, `tests/**`, `docs/**`, `package.json`
- Checks: `package:check:type`, `package:check:runtime-architecture`, `package:check:mcp-compatibility`, `package:check:controller-v8`, `package:check:ci`
- Execution hint: selected at runtime

### T8 — Establish destructive fault-injection release gate

- Status: `planned`
- Objective: Add deterministic tests and local smoke drills that kill or corrupt each lifecycle phase, restart launchd services, introduce stale processes and callbacks, interrupt installs, break each tunnel independently, and simulate cold boot. The gate must prove availability and isolation, not merely error classification.
- Depends on: `T5`, `T6`, `T7`
- Allowed paths: `tests/**`, `scripts/smoke-runtime-control-plane.ts`, `scripts/smoke-runtime-recovery.ts`, `scripts/check-release-readiness.sh`, `scripts/verify-controller-v8.sh`, `docs/operations/**`, `package.json`
- Checks: `package:check:type`, `package:check:runtime-architecture`, `package:check:mcp-compatibility`, `package:check:controller-v8`, `package:check:ci`
- Execution hint: selected at runtime

### T9 — Perform staged cutover and governance cleanup

- Status: `planned`
- Objective: Migrate the live Controller Home using the supported one-way migrator, activate the new bootstrap/runtime/Recovery architecture, run cold-start and failure drills, retain a bounded rollback backup, then delete retired services/state and reconcile or supersede overlapping runtime reliability Issues. Do not push remotely.
- Depends on: `T8`
- Allowed paths: `scripts/**`, `docs/operations/**`, `tasks/issues/**`, `tasks/notes/**`
- Checks: `package:check:type`, `package:check:runtime-architecture`, `package:check:mcp-compatibility`, `package:check:controller-v8`, `package:check:ci`
- Execution hint: selected at runtime

## Related Artifacts

- `ISS-20260802-27931A`
- `ISS-20260802-7E1D69`
- `ISS-20260731-CCF3E3`
- `retired blue-green and source-identity Issues`
