---
id: "ISS-20260730-B55445"
kind: "feature"
status: "in_progress"
updated_at: "2026-07-31T02:39:37.263Z"
source: "repo-harness-controller-v8"
---

# Converge Core, Advanced, and Full tool surfaces without capability loss

Result Goal 3 of ISS-20260730-AE1BCC for the next reliability release line. The RC6 gate was satisfied at exact released revision 2a48486b7b8c3395d05e4f30201e968ee88f9779. T1 is ready to establish one authoritative stable/compatibility/experimental/retired tool inventory and freeze Core/Advanced/Full exposure invariants without changing permissions or removing callable capabilities. Final rh_work and E2E stages depend on the evidence and context foundations.

## Goals

- Create one authoritative tool inventory and exposure classification for Core, Advanced, and Full.
- Shrink Core to a small model-friendly facade without deleting or permission-gating underlying capabilities.
- Guarantee all stable typed tools remain callable through Advanced/Full and that Core omissions return explicit capability/routing guidance.
- Run a dual-connector Shadow period and switch defaults only after measured correctness, latency, payload, and fallback gates pass.

## Non-goals

- Do not use tool exposure profiles as a replacement for authorization or repository access policy.
- Do not remove stable typed tools merely to reduce Core schema size.
- Do not force specialist iOS, Browser, ASC, Git, Campaign, Agent, Recovery, or runtime workflows through an impoverished generic facade.
- Do not switch the default Connector before Shadow criteria are met.
- Do not duplicate tool registries in CLI, Gateway, tests, and documentation.

## Acceptance Criteria

- [ ] A single authoritative inventory generates or validates profile membership, schemas, documentation, snapshots, and fingerprints.
- [ ] Core remains intentionally small; Advanced contains every stable typed capability; Full is a superset for compatibility and maintenance.
- [ ] Core hidden tools are distinguishable from permission denied and return unsupported_in_core with required capability, reason, and Advanced route where applicable.
- [ ] Category-level invocation E2E proves Advanced/Full tools are actually callable, not merely present in tools/list.
- [ ] Core facade E2E proves ordinary repository work remains correct and specialist tasks route without capability loss.
- [ ] Core, Advanced, and Full expose distinct stable fingerprints and satisfy Full >= Advanced > Core.
- [ ] Dual Connector Shadow collects correctness, tool-selection, fallback, payload, latency, and unsupported-route metrics before any default switch.
- [ ] Existing authorization, strong confirmation, resource claims, secret handling, and remote-write gates behave identically across profiles.

## GitHub

- Not published.

## Tasks

### T1 — Establish the authoritative tool inventory and exposure invariants

- Status: `verifying`
- Objective: After RC6 is clean, inventory all registered stable, compatibility, experimental, and retired tools; identify every duplicated membership source; define generation/validation rules, profile fingerprints, and capability categories without changing runtime exposure yet.
- Depends on: none
- Allowed paths: `src/cli/mcp/**`, `src/runtime/gateway/mcp/**`, `src/mcp/**`, `tests/**`, `docs/**`
- Checks: `typecheck`, `test`
- Execution hint: selected at runtime

### T2 — Implement the bounded Core exposure profile

- Status: `planned`
- Objective: Create the minimal Core profile around rh_access, rh_status, rh_inbox, rh_context, rh_work, session binding, bounded search/read, and safe patching while preserving Advanced and Full registries.
- Depends on: `T1`
- Allowed paths: `src/cli/mcp/**`, `src/runtime/gateway/mcp/**`, `src/mcp/**`, `tests/**`, `docs/**`
- Checks: `typecheck`, `test`
- Execution hint: selected at runtime

### T3 — Add explicit Core-to-Advanced capability routing

- Status: `planned`
- Objective: For capabilities intentionally absent from Core, return structured unsupported_in_core guidance with required capability, why specialist routing is needed, and the Advanced entry point; ensure specialist prompts can select Advanced directly.
- Depends on: `T2`
- Allowed paths: `src/runtime/control-plane/facade/**`, `src/runtime/gateway/mcp/**`, `src/cli/mcp/**`, `tests/**`, `docs/**`
- Checks: `typecheck`, `test`
- Execution hint: selected at runtime

### T4 — Converge the Core rh_work schema on evidence and context contracts

- Status: `planned`
- Objective: After the execution-evidence baseline and action ContextRequirements are stable, simplify rh_work inputs/outputs while preserving objective, acceptance, path, check, evidence, approval, recovery, and context-resolution references needed for safe continuation.
- Depends on: `T3`
- Allowed paths: `src/runtime/control-plane/facade/**`, `src/runtime/gateway/mcp/**`, `src/cli/mcp/**`, `tests/**`, `docs/**`
- Checks: `typecheck`, `test`
- Execution hint: selected at runtime

### T5 — Prove Core ordinary flows and Advanced category callability

- Status: `planned`
- Objective: Build E2E suites for Core session/context/search/read/patch/work/verify/finalize flows and category-level Advanced/Full invocation for repository, Git, Agent, Campaign/legacy migration, Recovery, runtime, iOS, Browser, ASC, and plugin actions.
- Depends on: `T4`
- Allowed paths: `tests/**`, `scripts/**`, `docs/**`
- Checks: `typecheck`, `test`, `ci`
- Execution hint: selected at runtime

### T6 — Run dual-connector Shadow with measurable fallback

- Status: `planned`
- Objective: Operate Core and Advanced connectors side by side, keep Advanced as the default, collect schema payload, latency, tool-selection correctness, unsupported routes, fallback frequency, task success, and capability-loss signals, and document rollback.
- Depends on: `T5`
- Allowed paths: `src/cli/**`, `src/runtime/**`, `scripts/**`, `tests/**`, `docs/**`
- Checks: `typecheck`, `test`, `ci`
- Execution hint: selected at runtime

### T7 — Decide and verify the default Core cutover

- Status: `planned`
- Objective: Use predeclared Shadow thresholds to accept, defer, or reject Core as the default model-facing connector; verify no capability loss and retain Advanced/Full escape paths.
- Depends on: `T6`
- Allowed paths: `src/cli/**`, `src/runtime/**`, `scripts/**`, `tests/**`, `docs/**`
- Checks: `typecheck`, `test`, `ci`
- Execution hint: selected at runtime

## Related Artifacts

- `ISS-20260730-AE1BCC`
- `ISS-20260729-BF2F89 (mandatory runtime gate)`
- `ISS-20260730-A1EA53 (required before final Core work/finalize schema)`
- `ISS-20260730-84CE88 (ContextRequirements inform specialist routing)`
- `docs/architecture/RELIABILITY-PROGRAM.md`
