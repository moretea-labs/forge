/**
 * Canonical Activity Projection Model.
 * 
 * Direct capability activity appears in Activity/history.
 * 
 * Realtime progress comes from Process / Operation / Agent / provider snapshots
 * with observedAt/freshness. History combines semantic revisions with selected
 * immutable receipts and terminal operation events.
 */

export interface CapabilityActivityItem {
  activityId: string;
  capabilityId: string;
  kind: 'direct_execution' | 'agent_delegation' | 'scheduled_trigger';
  targetScope: string;
  principalId: string;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  startedAt: string;
  completedAt?: string;
  summary?: string;
  receiptRef?: string;
}
