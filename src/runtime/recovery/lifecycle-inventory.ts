/**
 * Machine-readable lifecycle inventory for persisted/generated Runtime classes.
 *
 * This registry is descriptive, not a second cleanup authority. It records the
 * current owner/protection/retention facts that v2c can prove and makes every
 * remaining v2c2 closure obligation explicit. Runtime maintenance and the
 * owning domain services remain the only mutation authorities.
 */

export const RUNTIME_LIFECYCLE_DATA_CLASSES = [
  'semantic_authority',
  'execution_authority',
  'evidence',
  'provider_artifact',
  'derived',
  'cache',
  'temporary',
] as const;
export type RuntimeLifecycleDataClass = (typeof RUNTIME_LIFECYCLE_DATA_CLASSES)[number];

export const RUNTIME_LIFECYCLE_CLOSURE_STATUSES = ['existing_bounded', 'needs_v2c2_closure'] as const;
export type RuntimeLifecycleClosureStatus = (typeof RUNTIME_LIFECYCLE_CLOSURE_STATUSES)[number];

export interface RuntimeLifecycleClassDefinition {
  id: string;
  owner: string;
  scope: 'controller' | 'repository' | 'work' | 'process' | 'session' | 'provider';
  dataClass: RuntimeLifecycleDataClass;
  storage: string;
  terminalCondition: string;
  activeProtection: string;
  retentionCapacity: string;
  cleanupAuthority: string;
  recoverySemantics: string;
  closureStatus: RuntimeLifecycleClosureStatus;
  evidencePaths: readonly string[];
}

function lifecycle(value: RuntimeLifecycleClassDefinition): RuntimeLifecycleClassDefinition {
  return Object.freeze(value);
}

export const RUNTIME_LIFECYCLE_INVENTORY: readonly RuntimeLifecycleClassDefinition[] = Object.freeze([
  lifecycle({
    id: 'requirement', owner: 'Goal / Requirement authority', scope: 'controller', dataClass: 'semantic_authority',
    storage: 'Controller Home SQLite requirement namespace',
    terminalCondition: 'Requirement reaches done or cancelled through canonical semantic transition.',
    activeProtection: 'Terminal state and optimistic revision fencing prevent a retained historical row from regaining current authority.',
    retentionCapacity: 'Semantic/audit history is durable; bounded physical pruning policy is intentionally unresolved for v2c2.',
    cleanupAuthority: 'Central Runtime maintenance may prune only after current authority, audit, migration and recovery references are proven absent.',
    recoverySemantics: 'Retained history is evidence only; recovery must never reopen a terminal Requirement implicitly.',
    closureStatus: 'needs_v2c2_closure', evidencePaths: ['src/runtime/control-plane/persistence/requirement-store.ts','docs/architecture/decisions/20260904-repository-runtime-data-boundary.md'],
  }),
  lifecycle({
    id: 'plan', owner: 'Goal / Plan authority', scope: 'repository', dataClass: 'semantic_authority',
    storage: 'Controller Home SQLite plan namespace',
    terminalCondition: 'Plan is finalized, superseded, cancelled or invalidated by drift.',
    activeProtection: 'Current-plan queries exclude terminal/superseded authority and successor obligation continuity is fenced explicitly.',
    retentionCapacity: 'Plan history remains durable for lineage/acceptance; bounded physical pruning policy is a v2c2 obligation.',
    cleanupAuthority: 'Central Runtime maintenance after successor obligations and audit/recovery references are closed.',
    recoverySemantics: 'Recovery preserves predecessor lineage but cannot make a terminal predecessor current.',
    closureStatus: 'needs_v2c2_closure', evidencePaths: ['src/runtime/control-plane/facade/plan-contract-store.ts','packages/kernel/goal/api/index.ts'],
  }),
  lifecycle({
    id: 'work', owner: 'Kernel Work authority', scope: 'work', dataClass: 'execution_authority',
    storage: 'Controller Home SQLite / Work authority records plus WorkHandle placement state',
    terminalCondition: 'Work reaches completed, failed or cancelled with delivery/cleanup evidence as required.',
    activeProtection: 'Work state machine, controller ownership, leases, delivery containment and active Plan bindings protect live Work.',
    retentionCapacity: 'History remains durable; stale/orphan reconciliation exists, but a complete age/count/size policy for terminal Work is not yet proven.',
    cleanupAuthority: 'Work finalization/terminal cleanup plus centralized Runtime maintenance.',
    recoverySemantics: 'Terminal Work may seed explicit successor lineage but is never silently resumed or treated as current.',
    closureStatus: 'needs_v2c2_closure', evidencePaths: ['packages/kernel/work/api/index.ts','src/runtime/control-plane/execution/work-terminal-cleanup.ts','src/runtime/recovery/maintenance-executor.ts'],
  }),
  lifecycle({
    id: 'process_record_log', owner: 'Process Runtime', scope: 'process', dataClass: 'execution_authority',
    storage: 'Controller Home repository process records/logs',
    terminalCondition: 'Process is succeeded, failed, timed_out, cancelled, orphaned, completed_unknown or unknown after reconciliation.',
    activeProtection: 'Active process index and live process identity are never GCd; stale active records require evidence-based reconciliation.',
    retentionCapacity: 'Terminal records default to 7 days and 500 records per repository; malformed/unknown evidence is preserved fail-closed.',
    cleanupAuthority: 'Process Runtime gcTerminalProcesses under Runtime writer fence.',
    recoverySemantics: 'GC never fabricates terminality and never throws cleanup failure into the controller main loop.',
    closureStatus: 'existing_bounded', evidencePaths: ['src/runtime/execution/process-runtime/gc.ts'],
  }),
  lifecycle({
    id: 'execution_job', owner: 'Execution Job / Scheduler authority', scope: 'repository', dataClass: 'execution_authority',
    storage: 'Controller Home execution-job store',
    terminalCondition: 'Job reaches its canonical terminal lifecycle outcome.',
    activeProtection: 'Active Job/lease/dependency state remains authoritative and cannot be reclaimed by artifact cleanup.',
    retentionCapacity: 'Terminal Job retention/capacity is not yet represented by one v2c2 policy and must be closed explicitly.',
    cleanupAuthority: 'Central Runtime maintenance coordinated with Execution Job authority.',
    recoverySemantics: 'Reconciliation may repair stale lifecycle state but must not replay an already accepted external effect.',
    closureStatus: 'needs_v2c2_closure', evidencePaths: ['src/runtime/execution/jobs/store.ts','src/runtime/control-plane/global-scheduler/reconciliation.ts'],
  }),
  lifecycle({
    id: 'check_receipt', owner: 'Verification / Process evidence authority', scope: 'work', dataClass: 'evidence',
    storage: 'Controller Home Process/check receipt evidence',
    terminalCondition: 'Check Process reaches terminal outcome and receipt is bound to exact input/source identity.',
    activeProtection: 'Receipts required by active validation, completion, review or Operational Memory support evidence are protected.',
    retentionCapacity: 'Reusable check evidence participates in Process retention, but complete evidence-reference-aware pruning is a v2c2 closure item.',
    cleanupAuthority: 'Process GC / centralized Runtime maintenance after evidence-reference checks.',
    recoverySemantics: 'Missing or changed authoritative receipt creates stale/replay-gap evidence rather than synthetic success.',
    closureStatus: 'needs_v2c2_closure', evidencePaths: ['packages/kernel/work/api/index.ts','src/runtime/execution/process-runtime/gc.ts'],
  }),
  lifecycle({
    id: 'controller_round', owner: 'Kernel ControllerRound authority', scope: 'work', dataClass: 'semantic_authority',
    storage: 'Controller Home SQLite controller-round relay records',
    terminalCondition: 'Exactly one semantic disposition settles the round: continue_immediately, wait, wait_for_user or goal_complete; failed/blocked are explicit recovery states.',
    activeProtection: 'Relay scope, claim generation and opaque authority fence each live semantic round.',
    retentionCapacity: 'Historical round evidence is durable; bounded old-round retention is not yet proven and is a v2c2 obligation.',
    cleanupAuthority: 'ControllerRound lifecycle plus centralized Runtime maintenance after settlement/lineage protection.',
    recoverySemantics: 'Transport/session replacement preserves semantic lineage; ambiguous provider effect is reconciled before replay.',
    closureStatus: 'needs_v2c2_closure', evidencePaths: ['packages/kernel/controller/api/index.ts','docs/architecture/CURRENT.md'],
  }),
  lifecycle({
    id: 'controller_session_lease', owner: 'Kernel ControllerSession / resource lease authority', scope: 'session', dataClass: 'execution_authority',
    storage: 'Controller Home ControllerSession authority plus repository-scoped active resource lease files.',
    terminalCondition: 'Controller ownership is explicitly released/replaced, expires or is fenced by terminalization; resource leases expire or are released by their exact owner/terminal Process.',
    activeProtection: 'Principal/controller type/Runtime instance/claim-generation fencing protects Controller ownership; resource key, owner identity and fencing token protect each live resource lease.',
    retentionCapacity: 'ControllerSession ownership is capped at one hour, claim persistence drops expired sessions and release removes active ownership immediately. Resource leases default to 30 seconds with a five-second minimum; every active-lease read/acquire physically reaps expired or malformed files without truncating the live authoritative set, and periodic Runtime maintenance traverses that same active view.',
    cleanupAuthority: 'ControllerSession claim/release/terminalization owns session expiry; the resource Lease store owns expiry/release under the repository Controller lock, while centralized Runtime maintenance invokes the same active-lease view rather than introducing a second lease authority.',
    recoverySemantics: 'Expired/replaced Controller transports or resource leases cannot strand permanent Work ownership; claim generation and exact fencing tokens fail closed, while retained Controller identity remains audit/recovery evidence rather than an active lease.',
    closureStatus: 'existing_bounded', evidencePaths: ['packages/kernel/controller/api/index.ts','src/runtime/resources/leases/store.ts','src/runtime/control-plane/runtime-cleanup.ts','tests/runtime/controller-session-store.test.ts','tests/runtime/work-execution-concurrency.test.ts','tests/runtime/process-runtime.test.ts'],
  }),
  lifecycle({
    id: 'scheduler_occurrence_history', owner: 'Kernel Scheduler authority', scope: 'repository', dataClass: 'execution_authority',
    storage: 'Controller Home schedule occurrence/decision records plus a bounded active/recent index.',
    terminalCondition: 'Occurrence settles and falls outside the 5,000-entry recent index; active created/queued/running occurrences remain protected independently of age.',
    activeProtection: 'The active/recent index plus a per-schedule Controller lock is re-read immediately before deletion, so concurrent saveOccurrence and active wake lineage fail closed.',
    retentionCapacity: 'The Scheduler index retains at most 5,000 recent and 5,000 active identities; centralized maintenance physically reclaims occurrence/decision files after they fall outside both sets under bounded scan/removal budgets.',
    cleanupAuthority: 'Central Runtime maintenance invokes Scheduler-owned cleanup; Scheduler storage performs deletion under the same schedule task lock used by occurrence writes.',
    recoverySemantics: 'Deleted history is disposable execution history backed by Runtime events; cleanup never recreates a deleted Schedule or resurrects terminal Work.',
    closureStatus: 'existing_bounded', evidencePaths: ['packages/kernel/scheduler/api/index.ts','src/runtime/control-plane/runtime-cleanup.ts','tests/runtime/runtime-cleanup.test.ts'],
  }),
  lifecycle({
    id: 'managed_workspace_checkout', owner: 'Work finalization / managed workspace authority', scope: 'work', dataClass: 'provider_artifact',
    storage: 'Controller-owned managed worktree/checkouts plus repository registry placement metadata',
    terminalCondition: 'Delivery containment/integration is proven and Work no longer owns the isolated workspace.',
    activeProtection: 'Active Work, delivery containment and source-preservation checks block unsafe worktree deletion.',
    retentionCapacity: 'Orphaned managed worktrees use a six-hour default TTL, cleanup-pending ownership releases after one hour, and every pass is scan/removal-budget bounded; active Work, lease and explicit references remain protected.',
    cleanupAuthority: 'Work finalization/terminal cleanup and centralized Runtime maintenance; both reuse the managed-workspace/registry authority and never infer semantic completion from deletion.',
    recoverySemantics: 'Dirty/unintegrated source is preserved and surfaced for reconciliation; malformed/unknown ownership and active leases fail closed instead of deleting the workspace.',
    closureStatus: 'existing_bounded', evidencePaths: ['src/runtime/execution/managed-workspace.ts','src/runtime/control-plane/execution/work-terminal-cleanup.ts','src/runtime/control-plane/runtime-cleanup.ts','tests/runtime/runtime-cleanup.test.ts'],
  }),
  lifecycle({
    id: 'edit_session', owner: 'Edit Session authority', scope: 'work', dataClass: 'execution_authority',
    storage: 'Controller Home repository edit-sessions namespace reached through the repository runtime-storage compatibility binding.',
    terminalCondition: 'Edit session is finalized, superseded or rolled back and no non-terminal Work still references the session for review/delivery.',
    activeProtection: 'Non-terminal sessions and terminal sessions whose workId belongs to a non-terminal Work are never physically reclaimed.',
    retentionCapacity: 'Terminal unowned sessions retain at most the newest 200 identities and seven days of history; centralized cleanup uses bounded rotating scans/removal budgets.',
    cleanupAuthority: 'Central Runtime maintenance invokes EditSession-owned physical retention after canonical Work liveness is read successfully.',
    recoverySemantics: 'Stale fingerprints reconcile into explicit session state before terminality; physical cleanup removes disposable patch/session artifacts only and never implies Work semantic completion.',
    closureStatus: 'existing_bounded', evidencePaths: ['src/cli/editing/edit-session.ts','src/cli/repositories/runtime-storage.ts','src/runtime/control-plane/runtime-cleanup.ts','tests/runtime/runtime-cleanup.test.ts'],
  }),
  lifecycle({
    id: 'verification_snapshot', owner: 'Work verification authority', scope: 'work', dataClass: 'evidence',
    storage: 'Controller Home Work verification snapshots/process evidence',
    terminalCondition: 'Snapshot is superseded by changed source/workspace/input identity or Work terminal cleanup.',
    activeProtection: 'Exact source/workspace fingerprints and active Work review/completion references protect applicable evidence.',
    retentionCapacity: 'Marked snapshots use a six-hour TTL, unmarked in-progress snapshots a 24-hour grace, with 512-entry/50-removal defaults per retention pass; active nonterminal Work ids are protected and malformed markers fail closed.',
    cleanupAuthority: "Explicit full Runtime maintenance calls the Work verification snapshot retention authority; snapshot creation no longer opportunistically deletes another Work's evidence.",
    recoverySemantics: 'Stale snapshots are rebuildable evidence; active Work snapshots are protected, invalid markers are retained for recovery review, and source/workspace identity still forces revalidation rather than unsafe reuse.',
    closureStatus: 'existing_bounded', evidencePaths: ['src/runtime/control-plane/execution/work-verification-snapshot.ts','src/runtime/recovery/maintenance-executor.ts','tests/runtime/runtime-cleanup.test.ts'],
  }),
  lifecycle({
    id: 'mcp_transport_session', owner: 'MCP HTTP transport lifecycle', scope: 'session', dataClass: 'execution_authority',
    storage: 'Controller-owned MCP transport registry',
    terminalCondition: 'Client DELETE, explicit replacement, lease expiry, absolute lifetime or oldest-safe capacity eviction.',
    activeProtection: 'Active POST work cannot be evicted and authenticated principal/route must match stored session.',
    retentionCapacity: 'Global maximum, lease expiry and absolute lifetime bound stream-only sessions.',
    cleanupAuthority: 'MCP transport registry lifecycle.',
    recoverySemantics: 'Closing transport state never cancels or completes a durably accepted Job.',
    closureStatus: 'existing_bounded', evidencePaths: ['docs/architecture/modules/controller-runtime/transport-lifecycle.md','src/cli/mcp/transports'],
  }),
  lifecycle({
    id: 'browser_session_profile', owner: 'Browser session/provider authority', scope: 'provider', dataClass: 'provider_artifact',
    storage: 'Controller Home BrowserSession authority and provider profile roots',
    terminalCondition: 'Session is explicitly closed/replaced/expired; reusable profile may outlive one session only by explicit ownership policy.',
    activeProtection: 'Active session/profile ownership and user-owned browser resources must not be reclaimed as Forge disposable state.',
    retentionCapacity: 'Profile/session vs disposable artifact TTL/capacity separation is not yet fully closed.',
    cleanupAuthority: 'Browser provider lifecycle plus centralized Runtime maintenance.',
    recoverySemantics: 'Provider/session replacement preserves Work/ControllerRound semantics and never treats a closed tab as goal completion.',
    closureStatus: 'needs_v2c2_closure', evidencePaths: ['adapters/browser/session-authority.ts','src/runtime/root/browser-session-persistence.ts'],
  }),
  lifecycle({
    id: 'browser_disposable_artifact', owner: 'Browser provider artifact lifecycle', scope: 'provider', dataClass: 'provider_artifact',
    storage: 'Controller Home captures/downloads/diagnostics/interactions',
    terminalCondition: 'Owning browser interaction/round is settled and no active diagnostic/recovery reference remains.',
    activeProtection: 'Artifacts referenced by active provider interaction or user-owned resources are protected.',
    retentionCapacity: 'Explicit TTL plus byte/count quotas for screenshots/downloads/diagnostics are a v2c2 closure requirement.',
    cleanupAuthority: 'Central Runtime maintenance with Browser provider ownership checks.',
    recoverySemantics: 'Artifact deletion is disposable cleanup only and cannot rewrite provider-effect or ControllerRound outcome.',
    closureStatus: 'needs_v2c2_closure', evidencePaths: ['adapters/browser','src/runtime/plugins/browser-runtime.ts'],
  }),
  lifecycle({
    id: 'computer_interaction_target', owner: 'Computer interaction target authority', scope: 'controller', dataClass: 'execution_authority',
    storage: 'Controller Home computer_interaction_target records',
    terminalCondition: 'Target/lease is released, replaced or becomes invalid against stable application/provider identity.',
    activeProtection: 'Stable application identity and provider binding/lease fencing protect active interaction targets.',
    retentionCapacity: 'Bounded stale target/lease cleanup is not yet represented by one v2c2 policy.',
    cleanupAuthority: 'Computer target authority plus centralized Runtime maintenance.',
    recoverySemantics: 'Missing/mismatched stable identity fails closed rather than retargeting an arbitrary foreground app.',
    closureStatus: 'needs_v2c2_closure', evidencePaths: ['adapters/computer/interaction-target-authority.ts','packages/plugin-runtime/computer/target-authority.ts'],
  }),
  lifecycle({
    id: 'plugin_config_profile', owner: 'Plugin configuration/trust authority', scope: 'controller', dataClass: 'execution_authority',
    storage: 'Controller Home plugin config/registration/trust state',
    terminalCondition: 'Registration/profile is disabled, removed or superseded by explicit configuration mutation.',
    activeProtection: 'Exact Controller Home trust, principal grants and provider identity protect active plugin capability.',
    retentionCapacity: 'Controller Home config/profile state has explicit replace/remove operations; legacy .forge/plugins and .repo-harness/plugins config is import-only, retired after cutover, and stale cross-Controller symlinks are unlinked without traversal. GitHub registry authority remains outside this config class.',
    cleanupAuthority: 'Plugin configuration authority owns explicit replacement/removal; legacy import cleanup retires repository-local compatibility state without creating a second Runtime authority.',
    recoverySemantics: 'Missing/unhealthy provider remains degraded/unsupported; authoritative malformed Controller Home config fails closed instead of falling back to legacy state, and cleanup cannot broaden trust or arbitrary-code authority.',
    closureStatus: 'existing_bounded', evidencePaths: ['src/runtime/plugins/external-registration.ts','src/runtime/plugins/store.ts','tests/runtime/plugin-config-controller-home-boundary.test.ts','tests/cli/plugin-command.test.ts'],
  }),
  lifecycle({
    id: 'release_artifact', owner: 'Runtime Release authority', scope: 'controller', dataClass: 'provider_artifact',
    storage: 'Controller Home immutable release resources/manifests',
    terminalCondition: 'Release is superseded and is neither active, known-good nor inside the required rollback/reference window.',
    activeProtection: 'Active release, known-good/rollback identity and recovery references are never deleted.',
    retentionCapacity: 'Superseded unreferenced Runtime releases use a 30-minute default grace and staging releases a six-hour grace under a shared bounded removal budget; active, previous, connector, Supervisor and Recovery current/previous references are protected.',
    cleanupAuthority: 'Release retention runs under centralized Runtime maintenance for unreferenced immutable artifacts; activation, known-good attestation and rollback selection remain Recovery/Release authority only.',
    recoverySemantics: 'Every candidate refreshes release authority before deletion; missing/malformed authority fails closed, while historical known-good attestations remain evidence without pinning obsolete artifacts forever.',
    closureStatus: 'existing_bounded', evidencePaths: ['src/runtime/control-plane/release-retention.ts','src/runtime/root/release-store.ts','src/runtime/root/release-manifest.ts','tests/runtime/release-retention.test.ts'],
  }),
  lifecycle({
    id: 'recovery_backup', owner: 'Standalone Recovery authority', scope: 'controller', dataClass: 'provider_artifact',
    storage: 'Recovery-owned backup/audit resources outside ordinary execution state',
    terminalCondition: 'Backup is superseded, unreferenced and outside rollback/recovery retention policy.',
    activeProtection: 'Active/known-good recovery target and required schema/database rollback evidence are protected.',
    retentionCapacity: 'The exact previous-release database backup is protected; older unreferenced .sqlite backups share the release-retention grace/removal budget and report reclaimed bytes separately from immutable release artifacts.',
    cleanupAuthority: 'Central release retention may prune only old unreferenced backup artifacts; Recovery remains the sole rollback/selection authority and ordinary cleanup cannot alter release selection.',
    recoverySemantics: 'Backup authority is re-read immediately before deletion; missing/invalid previous-backup authority fails closed and the only referenced rollback backup is never reclaimed.',
    closureStatus: 'existing_bounded', evidencePaths: ['src/runtime/control-plane/release-retention.ts','src/runtime/standalone-recovery','docs/operations/standalone-disaster-recovery.md','tests/runtime/release-retention.test.ts'],
  }),
  lifecycle({
    id: 'quarantine', owner: 'Runtime Recovery / migration quarantine', scope: 'repository', dataClass: 'provider_artifact',
    storage: 'Controller Home quarantine namespaces',
    terminalCondition: 'Quarantined artifact is reconciled/recovered or exceeds a safe retention window with no active audit/recovery hold.',
    activeProtection: 'Unresolved/corrupt evidence is preserved until an explicit safe disposition exists.',
    retentionCapacity: 'Local Job quarantine lives under Controller Home with a 30-day default retention horizon, 200-entry and 256 MiB capacity bounds, plus bounded scan/removal budgets; legacy repo-local quarantine roots are migration-only and retired after evidence relocation.',
    cleanupAuthority: 'Central Runtime full maintenance owns quarantine retention; repair/quarantine writers only relocate evidence into the Controller Home quarantine root and never infer semantic completion.',
    recoverySemantics: 'Quarantine remains diagnostic evidence, never a shadow active authority; legacy symlinks are relocated without traversal, and repeated maintenance is idempotent and fail-closed on unreadable evidence.',
    closureStatus: 'existing_bounded', evidencePaths: ['src/runtime/recovery/quarantine-retention.ts','src/runtime/recovery/maintenance-executor.ts','src/runtime/recovery/local-jobs-repair.ts','tests/runtime/capability-recovery.test.ts'],
  }),
  lifecycle({
    id: 'codegraph_cache', owner: 'Context / CodeGraph cache lifecycle', scope: 'repository', dataClass: 'cache',
    storage: 'Controller Home tool-cache/codegraph or explicit external cache root',
    terminalCondition: 'Index is stale, superseded, repository-retired or evicted as rebuildable cache.',
    activeProtection: 'Only a live process-scoped Forge locator fences Controller Home cache deletion; unreadable, truncated, or ambiguous locator evidence fails closed. Raw source remains authority when cache is missing/stale.',
    retentionCapacity: 'Forge-owned Controller Home indexes use a 7-day default idle grace, 512 MiB per-repository cap, 2 GiB Controller aggregate cap, and bounded oldest-first scan/removal budgets. Inactive caches may be rebuilt and evicted under age or capacity pressure; explicit external cache roots remain outside Forge cleanup authority.',
    cleanupAuthority: 'Central Runtime cleanup owns rebuildable Controller Home CodeGraph eviction; no semantic authority is deleted and non-owned/symlink entries fail closed.',
    recoverySemantics: 'Missing/stale cache degrades explicitly to lexical/raw-source evidence and rebuilds on demand; removal is idempotent and bounded by the shared cleanup budget.',
    closureStatus: 'existing_bounded', evidencePaths: ['src/runtime/context/codegraph-cache-boundary.ts','src/runtime/control-plane/codegraph-cache-retention.ts','src/runtime/control-plane/runtime-cleanup.ts','tests/runtime/codegraph-cache-retention.test.ts'],
  }),
  lifecycle({
    id: 'operational_memory', owner: 'Kernel Memory shadow reducer', scope: 'controller', dataClass: 'derived',
    storage: 'Controller Home derived operational Memory records backed by retained Process evidence',
    terminalCondition: 'Support evidence expires/disappears, compatibility invalidates the prior, or the namespace is explicitly dropped.',
    activeProtection: 'Only exact retained mechanical evidence supports a prior; semantic decisions/external effects/authorization are forbidden consumers.',
    retentionCapacity: 'Signals have 7d/30d horizons, scope cardinality 128, compatibility cardinality 256 and per-target sample caps.',
    cleanupAuthority: 'Operational Memory store/reducer; full namespace is droppable and rebuildable.',
    recoverySemantics: 'Corrupt/missing/stale derived state fails open and rebuilds from authoritative retained Process evidence.',
    closureStatus: 'existing_bounded', evidencePaths: ['packages/kernel/memory/api/index.ts','tests/runtime/operational-prior-store.test.ts'],
  }),
  lifecycle({
    id: 'context_record', owner: 'Context Plane projection authority', scope: 'controller', dataClass: 'derived',
    storage: 'Controller Home SQLite context_record namespace',
    terminalCondition: 'Record is superseded/stale/dropped and no longer selected by bounded context projection.',
    activeProtection: 'Context is advisory only; missing context degrades routing/evidence readiness instead of changing authority.',
    retentionCapacity: 'Record count is capped at 1000 and each record/query has explicit byte/item/token bounds.',
    cleanupAuthority: 'Context Plane bounded projection maintenance.',
    recoverySemantics: 'Loss is tolerated; source/control-plane authorities reconstruct current context.',
    closureStatus: 'existing_bounded', evidencePaths: ['src/runtime/context/context-plane.ts'],
  }),
  lifecycle({
    id: 'repository_controller_home_namespace', owner: 'Repository Registry / Controller Home storage authority', scope: 'repository', dataClass: 'execution_authority',
    storage: 'Controller Home repositories/<repoId> namespace',
    terminalCondition: 'Repository is explicitly disabled/removed and all active Work/Process/session/provider/recovery references are closed.',
    activeProtection: 'Registered active repository and every live child authority protect its namespace.',
    retentionCapacity: 'Explicit retired-repository namespace reclamation preserving required audit/migration facts is a v2c2 closure item.',
    cleanupAuthority: 'Central Runtime maintenance coordinated with Repository Registry.',
    recoverySemantics: 'Removal must not erase portable semantic/audit facts required for migration or cause a later repo registration to inherit stale execution placement.',
    closureStatus: 'needs_v2c2_closure', evidencePaths: ['src/cli/repositories/controller-home.ts','src/cli/repositories/registry.ts'],
  }),
  lifecycle({
    id: 'sqlite_control_plane', owner: 'Controller Home SQLite persistence authority', scope: 'controller', dataClass: 'execution_authority',
    storage: 'Controller Home control-plane.sqlite and bounded backup/recovery artifacts',
    terminalCondition: 'Rows follow their owning domain lifecycle; free pages become reclaimable only after safe row cleanup.',
    activeProtection: 'Transactions/CAS revisions and domain references protect current canonical rows.',
    retentionCapacity: 'Central cleanup performs PASSIVE WAL checkpointing and only VACUUMs already-free pages after both the 64 MiB reclaimable-byte and 20% free-page thresholds are met; live-writer SQLITE_BUSY is a fail-closed retry-later blocker.',
    cleanupAuthority: 'Central Runtime cleanup invokes bounded SQLite physical maintenance; owning domains remain the only row-retirement authority.',
    recoverySemantics: 'Compaction never defines semantic terminality, preserves current rows/audit continuity, and re-runs integrity validation after VACUUM.',
    closureStatus: 'existing_bounded', evidencePaths: ['src/runtime/control-plane/persistence/sqlite-store.ts','src/runtime/control-plane/runtime-cleanup.ts'],
  }),
  lifecycle({
    id: 'runtime_temp', owner: 'Runtime diagnostics/process scratch lifecycle', scope: 'process', dataClass: 'temporary',
    storage: 'OS temporary roots / Controller-observed Runtime temp entries',
    terminalCondition: 'Owning live Process is gone and entry exceeds the runtime temp retention threshold.',
    activeProtection: 'collectRuntimeProcesses protects scratch still owned by a live Runtime process.',
    retentionCapacity: 'RUNTIME_TEMP_RETENTION_MINUTES age threshold and bounded maintenance candidate scan.',
    cleanupAuthority: 'Central Runtime maintenance removeRuntimeTempEntry.',
    recoverySemantics: 'Temp cleanup is disposable and never participates in semantic completion or effect replay.',
    closureStatus: 'existing_bounded', evidencePaths: ['src/runtime/diagnostics/performance.ts','src/runtime/recovery/maintenance-executor.ts'],
  }),
]);

export function runtimeLifecycleClass(id: string): RuntimeLifecycleClassDefinition | undefined {
  return RUNTIME_LIFECYCLE_INVENTORY.find((entry) => entry.id === id);
}

export function runtimeLifecycleClosureSummary(): { total: number; existingBounded: number; needsV2c2Closure: number; pendingIds: string[] } {
  const pendingIds = RUNTIME_LIFECYCLE_INVENTORY.filter((entry) => entry.closureStatus === 'needs_v2c2_closure').map((entry) => entry.id);
  return {
    total: RUNTIME_LIFECYCLE_INVENTORY.length,
    existingBounded: RUNTIME_LIFECYCLE_INVENTORY.length - pendingIds.length,
    needsV2c2Closure: pendingIds.length,
    pendingIds,
  };
}
