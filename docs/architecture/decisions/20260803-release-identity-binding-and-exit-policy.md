# ADR: Whole-Forge-Runtime Release Identity and Exit Policy

- **Status:** Accepted and aligned with the Canonical Forge Runtime
- **Date:** 2026-08-03; revised 2026-08-06
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
- no component-level restart, slot selection, ingress fallback or Supervisor authority exists.
