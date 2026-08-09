# ADR: Whole-Forge-Runtime Release Identity and Exit Policy

- **Status:** Accepted and aligned with the Canonical Forge Runtime
- **Date:** 2026-08-03; revised 2026-08-09
- **Authority:** [`../current/runtime-architecture-simplification.md`](../current/runtime-architecture-simplification.md), [`../current/failure-recovery.md`](../current/failure-recovery.md)

## Decision

One immutable release identity binds the complete `forge-runtime` process and every bounded child it launches:

```text
ReleaseIdentityBinding {
  releasePath
  releaseId
  releaseRevision
  sourceCommit
  cleanWorkspace
}
```

Authority order is:

1. `FORGE_RELEASE_*` binding injected by the active whole release;
2. the immutable release `manifest.json`;
3. an owning Git checkout only for explicit developer launches;
4. never an ambient parent repository.

The OS service manager starts and automatically restarts the single `forge-runtime` root process after unexpected process death. Module readiness failure does not create component restart authority. A release transition stops and starts the complete Runtime, verifies binary whole-Runtime readiness, and on failure restores the previous complete release together with its bound SQLite backup.

Standalone Recovery remains independently installed. It may diagnose the service, repair the service definition or tunnel, and perform authorized offline whole-Runtime rollback when the primary Runtime cannot start. It never becomes a second scheduler, Gateway, state writer, or component owner.

The immutable release carries every helper executable or library needed by those bounded children. This includes the Process/Check runners, Browser/Desktop helpers, external-plugin probe, and the matching CodeGraph Node executable, read-only sidecar, and compiled library tree. CodeGraph is invoked once per bounded context query by `forge-runtime`; it is not a daemon, service, recovery owner, readiness authority, or persistent state writer. Its only durable input is the repository-owned `.codegraph/` index selected for the request.

The CodeGraph artifact group is all-or-nothing in `manifest.json`: canonical co-located paths and SHA-256 identities are declared for the Node executable, sidecar, and library directory. A missing platform bundle fails release staging before publication. At runtime, an unavailable or failed structural query produces typed degraded context evidence and fails a mode's required-context condition; it does not create a second Runtime readiness state or restart authority.

CodeGraph child cleanup is owned by the initiating bounded query through timeout/exit handling. Release retention and deletion operate on the complete release directory, so the executable, sidecar, and library tree are removed only with their whole Runtime release. There is no component-level upgrade, fallback to an ambient checkout dependency, adoption, or independent rollback path.

## Exit policy

- explicit authorized stop remains stopped;
- unexpected root-process death is handled by the OS service manager;
- incomplete readiness is reported as degraded or failed whole-Runtime readiness;
- stale Workers cannot renew Leases or publish under a replacement Runtime/release fence;
- uncertain external writes are reconciled from receipts and are never replayed blindly.

## Verification

- immutable release identity never follows ambient Git HEAD;
- advancing a developer checkout cannot alter the active release identity;
- failed activation restores the previous release and matching SQLite backup;
- service restart preserves durable Work, Process and evidence identities;
- a release missing any CodeGraph artifact fails closed before activation, a bounded query times out or exits without leaving a child owner, and a complete previous-release rollback restores the matching CodeGraph artifact group;
- no component-level restart, slot selection, ingress fallback or Supervisor authority exists.
