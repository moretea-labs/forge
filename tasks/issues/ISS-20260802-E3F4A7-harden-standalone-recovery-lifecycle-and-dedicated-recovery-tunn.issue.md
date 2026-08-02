---
id: "ISS-20260802-E3F4A7"
kind: "governance"
status: "cancelled"
updated_at: "2026-08-02T05:29:43.848Z"
source: "repo-harness-controller-v8"
---

# Harden standalone recovery lifecycle and dedicated recovery tunnel

Duplicate issue created accidentally during task preparation. Canonical issue is ISS-20260802-27931A.

## Goals

- Preserve monorepo source ownership for Supervisor and standalone Recovery.
- Install Recovery Gateway and Watchdog as immutable versioned artifacts with atomic activation.
- Keep Supervisor, Recovery Gateway, Recovery Watchdog, primary tunnel, and recovery tunnel as separate OS service units.
- Persist Recovery Watchdog state and prevent repeated noisy degraded loops or repeated rollback after watchdog restart.
- Probe and repair the dedicated Recovery public endpoint independently from the primary MCP endpoint.
- Document the exact separation between Supervisor monitor, Recovery Watchdog, Gateway KeepAlive, and workflow_watchdog_report.

## Non-goals

- Do not make Recovery depend on the primary Gateway, Controller Daemon, active runtime slot, or repository worktree at runtime.
- Do not let Supervisor supervise Recovery Gateway or Recovery Watchdog; launchd/systemd remains their common lower-level authority.
- Do not allow arbitrary shell execution through Recovery.
- Do not replace the existing Supervisor blue/green runtime model.

## Acceptance Criteria

- [ ] Recovery source remains under the repo-harness repository and is built from a clean canonical revision.
- [ ] Installed Recovery artifacts live under versioned immutable release directories and activate through an atomic current pointer or equivalent.
- [ ] Recovery Gateway and Recovery Watchdog cold-start successfully without the primary Gateway or active runtime slot.
- [ ] Both Recovery services restart after an abnormal exit and remain stopped after an explicit authorized unload.
- [ ] A dedicated recovery cloudflared service exposes only the Recovery endpoint and is independently repairable.
- [ ] Watchdog separately evaluates local runtime, primary public endpoint, local Recovery Gateway, and public Recovery endpoint.
- [ ] Watchdog state survives its own restart and rollback/tunnel-repair actions remain idempotent and rate-limited.
- [ ] Workflow watchdog remains read-only and cannot trigger process restart, rollout, or rollback.
- [ ] Focused unit, smoke, launchd template, interrupted-install, and tunnel-failure tests pass.

## GitHub

- Not published.

## Tasks

### T1 — Define recovery authority and failure-domain contract

- Status: `ready`
- Objective: Add or update architecture decisions documenting monorepo source ownership, immutable installed artifacts, OS-level service ownership, and the four distinct monitoring layers.
- Depends on: none
- Allowed paths: `docs/architecture/**`, `docs/operations/**`, `docs/wiki/**`
- Checks: not defined
- Execution hint: selected at runtime

## Related Artifacts

- None.
