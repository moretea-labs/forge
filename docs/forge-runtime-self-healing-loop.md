# Forge Runtime Self-Healing Loop

The canonical Forge Runtime reconciles durable Work, Process, Lease, projection, plugin, and schedule state without creating another lifecycle owner. Recovery is evidence-driven and fail-closed: already-started commands are never blindly replayed, stale owners cannot mutate state, and uncertain writes require reconciliation or human attention.

The OS service manager automatically starts and restarts the single `forge-runtime` process. Standalone Recovery remains independently installable for diagnostics, service repair, tunnel repair, and offline whole-Runtime rollback when the primary Runtime cannot start.

On macOS, an immutable compiled release keeps `forge-runtime` as the small, Developer-ID-signed stable service executable, while the full Canonical Runtime is a co-located `forge-runtime-bundle.js` artifact in the same release. The loader verifies the bundle SHA-256 declared by `manifest.json` before importing it; there is no source-checkout fallback. This preserves one Runtime/release/TCC authority without embedding the full application graph in Bun's standalone executable image.

See [Failure Recovery](architecture/CURRENT.md), [Reliability runbook](operations/controller-reliability-runbook.md), and [Standalone disaster recovery](operations/standalone-disaster-recovery.md).
