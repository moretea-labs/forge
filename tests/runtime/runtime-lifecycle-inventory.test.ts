import { describe, expect, test } from 'bun:test';
import {
  RUNTIME_LIFECYCLE_INVENTORY,
  runtimeLifecycleClosureSummary,
} from '../../src/runtime/recovery/lifecycle-inventory';

const REQUIRED_CLASSES = [
  'requirement','plan','work','process_record_log','execution_job','check_receipt',
  'controller_round','controller_session_lease','scheduler_occurrence_history',
  'managed_workspace_checkout','edit_session','verification_snapshot','mcp_transport_session',
  'browser_session_profile','browser_disposable_artifact','computer_interaction_target',
  'plugin_config_profile','release_artifact','recovery_backup','quarantine','codegraph_cache',
  'operational_memory','context_record','repository_controller_home_namespace','sqlite_control_plane','runtime_temp',
] as const;

describe('Kernel V2 runtime lifecycle inventory', () => {
  test('covers every release-relevant persisted/generated class exactly once', () => {
    const ids = RUNTIME_LIFECYCLE_INVENTORY.map((entry) => entry.id);
    expect(ids.sort()).toEqual([...REQUIRED_CLASSES].sort());
    expect(new Set(ids).size).toBe(ids.length);
  });

  test('makes ownership, terminality, protection, retention, cleanup and recovery explicit', () => {
    for (const entry of RUNTIME_LIFECYCLE_INVENTORY) {
      for (const value of [entry.owner, entry.storage, entry.terminalCondition, entry.activeProtection, entry.retentionCapacity, entry.cleanupAuthority, entry.recoverySemantics]) {
        expect(value.trim().length).toBeGreaterThan(8);
      }
      expect(entry.evidencePaths.length).toBeGreaterThan(0);
      expect(entry.storage.toLowerCase()).not.toContain('repository source tree');
    }
  });

  test('closes every v2c2 lifecycle class without treating durable semantic history as reclaimable garbage', () => {
    const summary = runtimeLifecycleClosureSummary();
    expect(summary.total).toBe(REQUIRED_CLASSES.length);
    expect(summary.existingBounded).toBe(REQUIRED_CLASSES.length);
    expect(summary.needsV2c2Closure).toBe(0);
    expect(summary.pendingIds).toEqual([]);
  });

  test('keeps semantic authority as one durable identity row instead of deleting it through Runtime GC', () => {
    for (const id of ['requirement', 'plan', 'work', 'controller_round'] as const) {
      const entry = RUNTIME_LIFECYCLE_INVENTORY.find((candidate) => candidate.id === id);
      expect(entry).toBeDefined();
      expect(entry!.retentionCapacity).toContain('Permanent semantic/audit retention');
      expect(entry!.cleanupAuthority).toContain('Runtime GC does not delete');
    }
  });

  test('keeps already-bounded Process, transport, Context and Operational Memory classes explicit', () => {
    const bounded = new Set(RUNTIME_LIFECYCLE_INVENTORY.filter((entry) => entry.closureStatus === 'existing_bounded').map((entry) => entry.id));
    for (const id of ['requirement','plan','work','controller_round','process_record_log','mcp_transport_session','operational_memory','context_record','runtime_temp','managed_workspace_checkout','verification_snapshot','scheduler_occurrence_history','edit_session','plugin_config_profile','quarantine','release_artifact','recovery_backup','codegraph_cache','controller_session_lease','browser_disposable_artifact','repository_controller_home_namespace','browser_session_profile','computer_interaction_target','check_receipt','execution_job']) {
      expect(bounded.has(id)).toBe(true);
    }
  });
});
