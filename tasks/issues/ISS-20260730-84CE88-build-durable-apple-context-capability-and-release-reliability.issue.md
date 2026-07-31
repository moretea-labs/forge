---
id: "ISS-20260730-84CE88"
kind: "feature"
status: "planned"
updated_at: "2026-07-31T00:06:07.187Z"
source: "repo-harness-controller-v8"
---

# Build durable Apple context, capability, and release reliability

Result Goal 2 of ISS-20260730-AE1BCC for the next reliability release line. The RC6 gate was satisfied at exact released revision 2a48486b7b8c3395d05e4f30201e968ee88f9779. T1 is ready for reversible inventory of current App Store Connect, Browser, Xcode, simulator, physical-device, repository project bindings, and the stale ASC Campaign projection. Later resolver/evidence stages depend on the execution-evidence baseline in ISS-20260730-A1EA53.

## Goals

- Restore and verify current App Store Connect, Browser, Xcode, simulator, physical-device, and repository project bindings without storing secrets in repository state.
- Add durable ContextProfile and ContextBinding records for Apple credentials, ASC apps, Browser profiles/domain grants, Xcode projects, devices, signing, and release targets.
- Attach action-level ContextRequirements and produce bounded, provenance-rich, freshness-aware ContextResolutions/Capsules.
- Complete typed Xcode capability, signing, archive, export, upload, processing, asset, TestFlight, metadata, and Apple Release Orchestrator workflows.

## Non-goals

- Do not create a generic Secret Manager in the first implementation; reuse existing plugin credential providers and store opaque profile references only.
- Do not make App Store Connect context mandatory for simulator-only actions.
- Do not use a broad taskType resolver when action-specific requirements are available.
- Do not silently let explicit arguments override conflicting repository bindings for remote write or release actions.
- Do not rely on CMP-20260723-0FFA4F as the sole source because its paused record is currently unreadable.

## Acceptance Criteria

- [ ] A new session can select an iOS repository and resolve the intended Team, bundle/app identity, project, scheme, device, Browser profile, and ASC app without retyping stable identifiers.
- [ ] Claim kind, verification state, confidence, observed/verified timestamps, validity, provenance, and verification inputs are represented independently; desired intent is not conflated with observed state.
- [ ] Conflicting high-risk Apple context stops remote write/release and produces an actionable explanation; low-risk simulator actions remain usable when ASC is absent.
- [ ] Changing Xcode, project/bundle settings, credentials, bindings, or verification inputs invalidates only affected context; temporary device offline state does not erase durable identity.
- [ ] No private keys, passwords, session cookies, or raw secrets enter Context Capsules, repository files, logs, or Completion Receipts.
- [ ] Typed workflows cover capability inspection/apply, entitlements, signing, iCloud Containers, App Groups, certificates/profiles preflight, archive, export, upload, processing, assets, TestFlight, metadata/readiness, and final release orchestration with an explicit human authorization gate.
- [ ] Real-repository E2E proves recovery, resolution, fail-closed conflicts, simulator independence, physical-device readiness, and an authorized release dry run or non-production equivalent.

## GitHub

- Not published.

## Tasks

### T1 — Inventory and safely recover existing Apple execution assets

- Status: `ready`
- Objective: After RC6 is clean, inspect current App Store Connect plugin credentials/readiness, Browser availability and Apple domain access, named browser profiles, Xcode selection, iOS project discovery, simulator/device support, and the stale ASC Campaign projection. Perform only reversible configuration recovery and document what must be migrated rather than duplicated.
- Depends on: none
- Allowed paths: `docs/**`, `.repo-harness/plugins/**`, `src/plugins/**`, `tests/**`
- Checks: `typecheck`
- Execution hint: selected at runtime

### T2 — Add Apple ContextProfile and repository binding persistence

- Status: `planned`
- Objective: Implement versioned durable profiles and bindings for credential provider reference, Team, ASC app, Browser profile/domain grants, Xcode project/scheme, bundle identity, device preference, and release target. Use atomic writes and preserve last-known-good records on failed updates.
- Depends on: `T1`
- Allowed paths: `src/runtime/**`, `src/plugins/**`, `src/config/**`, `tests/**`, `docs/**`
- Checks: `typecheck`, `test`
- Execution hint: selected at runtime

### T3 — Implement Browser named domain grants and profile bindings

- Status: `planned`
- Objective: Replace brittle global allowlist replacement with additive/removable named Apple domain grants, deletion impact preview, and repository-to-browser-profile binding while preserving existing authorization gates.
- Depends on: `T2`
- Allowed paths: `src/plugins/browser/**`, `src/runtime/**`, `tests/**`, `docs/**`
- Checks: `typecheck`, `test`
- Execution hint: selected at runtime

### T4 — Implement monorepo iOS project discovery and project bindings

- Status: `planned`
- Objective: Add bounded project_root, search_roots, max_depth, nested .xcodeproj/.xcworkspace discovery, ambiguity reporting, and durable repository project/scheme binding.
- Depends on: `T2`
- Allowed paths: `src/plugins/ios/**`, `src/runtime/**`, `tests/fixtures/**`, `tests/**`, `docs/**`
- Checks: `typecheck`, `test`
- Execution hint: selected at runtime

### T5 — Attach action-level ContextRequirements and build the resolver/capsule

- Status: `planned`
- Objective: Declare minimal context requirements per existing iOS, Browser, and ASC action; resolve fields from explicit inputs, repository bindings, plugin configuration, environment, and bounded observation with field/action/risk-specific precedence, conflict rules, freshness, provenance, and redaction.
- Depends on: `T3`, `T4`
- Allowed paths: `src/runtime/control-plane/**`, `src/plugins/**`, `src/runtime/gateway/**`, `tests/**`, `docs/**`
- Checks: `typecheck`, `test`
- Execution hint: selected at runtime

### T6 — Integrate context verification with execution evidence and handoff

- Status: `planned`
- Objective: Connect ContextResolution fingerprints and verification evidence to WorkContract, exact-revision checks, Completion Receipts, stale detection, work_get/work_inspect, and cross-session continuation without creating a new top-level facade.
- Depends on: `T5`
- Allowed paths: `src/runtime/control-plane/**`, `src/runtime/evidence/**`, `src/runtime/gateway/**`, `tests/**`, `docs/**`
- Checks: `typecheck`, `test`
- Execution hint: selected at runtime

### T7 — Deliver typed Xcode capabilities and signing workflows

- Status: `planned`
- Objective: Implement or complete capability inspection, preview/apply, entitlements reconciliation, Team/bundle signing verification, iCloud Containers, App Groups, certificate/profile preflight, and safe rollback/repair semantics using resolved context.
- Depends on: `T6`
- Allowed paths: `src/plugins/ios/**`, `src/plugins/app-store-connect/**`, `src/runtime/**`, `tests/**`, `docs/**`
- Checks: `typecheck`, `test`
- Execution hint: selected at runtime

### T8 — Deliver archive, upload, App Store assets, TestFlight, and metadata workflows

- Status: `planned`
- Objective: Implement or complete archive, export, upload, processing wait, App Store asset management, build assignment, TestFlight, metadata/readiness, and submission preparation as typed resumable actions.
- Depends on: `T7`
- Allowed paths: `src/plugins/ios/**`, `src/plugins/app-store-connect/**`, `src/runtime/**`, `tests/**`, `docs/**`
- Checks: `typecheck`, `test`, `ci`
- Execution hint: selected at runtime

### T9 — Build and verify the Apple Release Orchestrator

- Status: `planned`
- Objective: Compose context resolution, capabilities, signing, archive/export/upload, processing, assets, TestFlight, metadata/readiness, and final submission into a resumable orchestrator with explicit preflight, stop conditions, evidence, and human authorization for irreversible production actions.
- Depends on: `T8`
- Allowed paths: `src/plugins/ios/**`, `src/plugins/app-store-connect/**`, `src/runtime/**`, `tests/**`, `docs/**`
- Checks: `typecheck`, `test`, `ci`
- Execution hint: selected at runtime

## Related Artifacts

- `ISS-20260730-AE1BCC`
- `ISS-20260729-BF2F89 (mandatory runtime gate)`
- `ISS-20260730-A1EA53 (execution-evidence dependency for resolver/finalize)`
- `CMP-20260723-0FFA4F (stale paused projection to inspect/migrate, not duplicate)`
- `docs/architecture/RELIABILITY-PROGRAM.md`
