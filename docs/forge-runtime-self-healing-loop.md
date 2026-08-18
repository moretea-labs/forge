# Forge Runtime Self-Healing Loop

The canonical Forge Runtime reconciles durable Work, Process, Lease, projection, plugin, and schedule state without creating another lifecycle owner. Recovery is evidence-driven and fail-closed: already-started commands are never blindly replayed, stale owners cannot mutate state, and uncertain writes require reconciliation or human attention.

The OS service manager automatically starts and restarts the single `forge-runtime` process. Standalone Recovery remains independently installable for diagnostics, service repair, tunnel repair, and offline whole-Runtime rollback when the primary Runtime cannot start.

See [Failure Recovery](architecture/CURRENT.md), [Reliability runbook](operations/controller-reliability-runbook.md), and [Standalone disaster recovery](operations/standalone-disaster-recovery.md).
