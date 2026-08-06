# Forge Capability Recovery

Capability recovery reconciles provider health, Process receipts, Work state, Leases, projections, and bounded maintenance evidence without creating another Runtime owner. Uncertain writes are never replayed blindly. Standalone Recovery handles service repair and offline whole-Runtime rollback when the primary Runtime cannot start.

See [Failure Recovery](architecture/current/failure-recovery.md) and [Standalone disaster recovery](operations/standalone-disaster-recovery.md).
