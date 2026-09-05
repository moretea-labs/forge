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
    storage: 'Controller Home session/lease authority',
    terminalCondition: 'Lease is explicitly released, replaced, expired or fenced by terminalization.',
    activeProtection: 'Principal/session/instance/claim-generation ownership fencing protects current claims.',
    retentionCapacity: 'Expiry exists for active ownership, but unified stale-session/lease history cleanup remains a v2c2 closure item.',
    cleanupAuthority: 'ControllerSession release/terminalization and centralized Runtime maintenance.',
    recoverySemantics: 'Expired or replaced transport cannot retain permanent Work ownership.',
    closureStatus: 'needs_v2c2_closure', evidencePaths: ['packages/kernel/controller/api/index.ts','src/runtime/resources/leases/store.ts'],
  }),
  lifecycle({
    id: 'scheduler_occurrence_history', owner: 'Kernel Scheduler authority', scope: 'repository', dataClass: 'execution_authority',
    storage: 'Controller Home schedule and occurrence state',
    terminalCondition: 'Occurrence settles and schedule is paused/deleted/disabled or advances to its next eligibility.',
    activeProtection: 'Occurrence idempotency and exact Work binding protect active wake lineage from duplicate dispatch.',
    retentionCapacity: 'Occurrence/history retention and deleted-schedule pruning require one explicit bounded v2c2 policy.',
    cleanupAuthority: 'Scheduler maintenance under schedule ownership fencing.',
    recoverySemantics: 'Terminal Work is never resurrected by a retained occurrence; recovery re-arms only eligible existing authority.',
    closureStatus: 'needs_v2c2_closure', evidencePaths: ['packages/kernel/scheduler/api/index.ts','src/runtime/control-plane/global-scheduler/scheduler.ts'],
  }),
  lifecycle({
    id: 'managed_workspace_checkout', owner: 'Work finalization / managed workspace authority', scope: 'work', dataClass: 'provider_artifact',
    storage: 'Controller-owned managed worktree/checkouts plus repository registry placement metadata',
    terminalCondition: 'Delivery containment/integration is proven and Work no longer owns the isolated workspace.',
    activeProtection: 'Active Work, delivery containment and source-preservation checks block unsafe worktree deletion.',
    retentionCapacity: 'Unowned managed worktrees are detected today; deterministic age/capacity orphan reclamation is completed in v2c2.',
    cleanupAuthority: 'Work finalization/terminal cleanup and centralized Runtime maintenance.',
    recoverySemantics: 'Dirty/unintegrated source is preserved and surfaced for reconciliation instead of deleted.',
    closureStatus: 'needs_v2c2_closure', evidencePaths: ['src/runtime/execution/managed-workspace.ts','src/runtime/recovery/maintenance-executor.ts'],
  }),
  lifecycle({
    id: 'edit_session', owner: 'Edit Session authority', scope: 'work', dataClass: 'execution_authority',
    storage: 'Controller Home repository edit-sessions namespace',
    terminalCondition: 'Edit session is reconciled/cleaned after its deterministic patch/validation transaction no longer owns mutable state.',
    activeProtection: 'Current edit-session identity/fingerprints and Work attribution protect live sessions.',
    retentionCapacity: 'Stale EditSession candidates are detected; complete retention/capacity semantics are a v2c2 closure item.',
    cleanupAuthority: 'Edit Session cleanup plus centralized Runtime maintenance.',
    recoverySemantics: 'Stale fingerprints reconcile into explicit session state; cleanup does not imply Work semantic completion.',
    closureStatus: 'needs_v2c2_closure', evidencePaths: ['src/cli/editing/edit-session.ts','src/runtime/recovery/maintenance-executor.ts'],
  }),
  lifecycle({
    id: 'verification_snapshot', owner: 'Work verification authority', scope: 'work', dataClass: 'evidence',
    storage: 'Controller Home Work verification snapshots/process evidence',
    terminalCondition: 'Snapshot is superseded by changed source/workspace/input identity or Work terminal cleanup.',
    activeProtection: 'Exact source/workspace fingerprints and active Work review/completion references protect applicable evidence.',
    retentionCapacity: 'A unified age/count/size policy for stale snapshots is not yet closed.',
    cleanupAuthority: 'Work verification/finalization plus centralized Runtime maintenance.',
    recoverySemantics: 'Stale snapshots fail closed and force revalidation rather than being reused.',
    closureStatus: 'needs_v2c2_closure', evidencePaths: ['src/runtime/control-plane/execution/work-verification-snapshot.ts'],
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
    retentionCapacity: 'Current authority is centralized; legacy repo-local compatibility retirement/pruning is completed in v2c2.',
    cleanupAuthority: 'Plugin configuration authority and centralized Runtime maintenance.',
    recoverySemantics: 'Missing/unhealthy provider remains degraded/unsupported; cleanup cannot broaden trust or arbitrary-code authority.',
    closureStatus: 'needs_v2c2_closure', evidencePaths: ['src/runtime/plugins/external-registration.ts','src/runtime/plugins/store.ts','tests/cli/plugin-command.test.ts'],
  }),
  lifecycle({
    id: 'release_artifact', owner: 'Runtime Release authority', scope: 'controller', dataClass: 'provider_artifact',
    storage: 'Controller Home immutable release resources/manifests',
    terminalCondition: 'Release is superseded and is neither active, known-good nor inside the required rollback/reference window.',
    activeProtection: 'Active release, known-good/rollback identity and recovery references are never deleted.',
    retentionCapacity: 'Pruning/count/byte policy for superseded unreferenced releases is a v2c2 closure item.',
    cleanupAuthority: 'Mac Recovery/Release owner only; ordinary Forge/Cloud maintenance may not activate or attest releases.',
    recoverySemantics: 'Recovery selects only verified immutable candidates and preserves protected rollback resources.',
    closureStatus: 'needs_v2c2_closure', evidencePaths: ['src/runtime/root/release-store.ts','src/runtime/root/release-manifest.ts'],
  }),
  lifecycle({
    id: 'recovery_backup', owner: 'Standalone Recovery authority', scope: 'controller', dataClass: 'provider_artifact',
    storage: 'Recovery-owned backup/audit resources outside ordinary execution state',
    terminalCondition: 'Backup is superseded, unreferenced and outside rollback/recovery retention policy.',
    activeProtection: 'Active/known-good recovery target and required schema/database rollback evidence are protected.',
    retentionCapacity: 'Age/count/byte pruning policy for old backups is not yet closed.',
    cleanupAuthority: 'Recovery owner, never ordinary Work/Cloud execution.',
    recoverySemantics: 'Cleanup cannot modify active release selection or erase the only known-good rollback proof.',
    closureStatus: 'needs_v2c2_closure', evidencePaths: ['src/runtime/standalone-recovery','docs/operations/standalone-disaster-recovery.md'],
  }),
  lifecycle({
    id: 'quarantine', owner: 'Runtime Recovery / migration quarantine', scope: 'repository', dataClass: 'provider_artifact',
    storage: 'Controller Home quarantine namespaces',
    terminalCondition: 'Quarantined artifact is reconciled/recovered or exceeds a safe retention window with no active audit/recovery hold.',
    activeProtection: 'Unresolved/corrupt evidence is preserved until an explicit safe disposition exists.',
    retentionCapacity: 'Age and byte/count bounds are not yet uniformly enforced and are a v2c2 closure item.',
    cleanupAuthority: 'Central Runtime maintenance after recovery/audit protection.',
    recoverySemantics: 'Quarantine remains evidence, not a shadow active authority or permanent archive.',
    closureStatus: 'needs_v2c2_closure', evidencePaths: ['src/runtime/recovery/maintenance-executor.ts','src/runtime/recovery/local-jobs-repair.ts'],
  }),
  lifecycle({
    id: 'codegraph_cache', owner: 'Context / CodeGraph cache lifecycle', scope: 'repository', dataClass: 'cache',
    storage: 'Controller Home tool-cache/codegraph or explicit external cache root',
    terminalCondition: 'Index is stale, superseded, repository-retired or evicted as rebuildable cache.',
    activeProtection: 'Current explicit structural query may use a source-bound index; raw source remains authority when cache is missing/stale.',
    retentionCapacity: 'TTL/LRU/byte capacity and retired-repository eviction need explicit v2c2 closure.',
    cleanupAuthority: 'Central cache maintenance; deletion must remain fully rebuildable.',
    recoverySemantics: 'Missing/stale cache degrades explicitly to lexical/raw-source evidence and cannot mutate semantic authority.',
    closureStatus: 'needs_v2c2_closure', evidencePaths: ['src/runtime/context/codegraph-sidecar.cjs','src/runtime/context/context-plane.ts'],
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
    retentionCapacity: 'WAL/checkpoint and reclaimable-page observation exist; explicit safe compaction/vacuum policy tied to lifecycle pruning is a v2c2 closure item.',
    cleanupAuthority: 'Central Runtime/Recovery SQLite maintenance under writer and backup safety fences.',
    recoverySemantics: 'Compaction never defines semantic terminality and must preserve rows required by current authority/audit/recovery.',
    closureStatus: 'needs_v2c2_closure', evidencePaths: ['src/runtime/control-plane/persistence/sqlite-store.ts','src/runtime/control-plane/global-scheduler/scheduler.ts'],
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
