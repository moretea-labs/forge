# ADR: Whole-Forge-Runtime Release Identity and Exit Policy

- **Status:** Accepted and aligned with the Canonical Forge Runtime
- **Date:** 2026-08-03; revised 2026-08-09 and 2026-09-18
- **Authority:** [`../CURRENT.md`](../CURRENT.md), [`../CURRENT.md`](../CURRENT.md)

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

The OS service manager starts and automatically restarts the single `forge-runtime` root process after unexpected process death. The service executes from the stable physical path `ControllerHome/runtime/service/active-forge-runtime`; that file is an atomic byte-for-byte mirror of the signed entrypoint in the selected immutable release, not a symlink into `runtime/releases/<releaseId>`. Release assets and semantic identity remain bound by the selected manifest and `FORGE_RELEASE_*` environment. The fixed physical executable path is required so macOS TCC descendants inherit one stable responsible-process identity across releases instead of creating one permission principal per release directory. Module readiness failure does not create component restart authority. A release transition stops and starts the complete Runtime, refreshes the stable mirror from the selected release before launch, verifies binary whole-Runtime readiness, and on failure restores the previous complete release together with its matching stable mirror and bound SQLite backup.

Standalone Recovery remains independently installed. It may diagnose the service, repair the service definition or tunnel, and perform authorized offline whole-Runtime rollback when the primary Runtime cannot start. It never becomes a second scheduler, Gateway, state writer, or component owner.

Runtime release activation is a recoverable transaction inside the single `ControllerHome/runtime/releases/authority.json` authority. While a candidate is being activated, the authority carries bounded pre-activation rollback context for the prior active/previous release bundle and bound SQLite backup. Successful whole-Runtime verification commits by clearing that transaction context without minting a second release authority; failed or interrupted activation aborts through the same authority and restores the pre-activation bundle. Standalone Recovery reconciles an interrupted transaction on restart rather than creating a new activation owner.

Recovery known-good attestations are bounded recovery authority, not detached historical labels. A live known-good record binds its matching immutable Runtime release, a checked Recovery-owned SQLite snapshot, and a hashed declarative service contract; release retention uses that same invariant. Schema-1 metadata-only history has no recovery or retention authority. Once a bounded bundle retires, ordinary bounded retention may remove its artifact. Recovery projections distinguish physically recoverable bundles from stale/unavailable evidence.

A Runtime startup failure before Gateway readiness writes one latest-only diagnostic receipt containing the startup stage and reason. This receipt is diagnostic evidence only, never lifecycle authority, and a later successful whole-Runtime startup clears it.

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
- interrupted activation reconciles to one committed or aborted release transaction without a second release authority;
- bounded known-good attestations cannot advertise a missing immutable release as usable recovery authority;
- pre-Gateway startup failure remains diagnosable after process exit without preserving stale Runtime lifecycle state;
- service restart preserves durable Work, Process and evidence identities;
- a release missing any CodeGraph artifact fails closed before activation, a bounded query times out or exits without leaving a child owner, and a complete previous-release rollback restores the matching CodeGraph artifact group;
- no component-level restart, slot selection, ingress fallback or Supervisor authority exists.
