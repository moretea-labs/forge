/**
 * Canonical Activity Projection Model.
 * 
 * GUI work tree is an explicit-link projection of Requirement / Plan / Work,
 * while direct capability activity that has no Work appears in Activity/history
 * rather than being forced into a synthetic Work.
 * 
 * Realtime progress comes from Process / Operation / Agent / provider snapshots
 * with observedAt/freshness. History combines semantic revisions with selected
 * immutable receipts and terminal operation events.
 */

export interface CapabilityActivityItem {
  activityId: string;
  capabilityId: string;
  kind: 'direct_execution' | 'agent_delegation' | 'scheduled_trigger' | 'work_bound';
  targetScope: string;
  principalId: string;
  associatedWorkId?: string;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  startedAt: string;
  completedAt?: string;
  summary?: string;
  receiptRef?: string;
}

export interface WorkTreeProjectionNode {
  type: 'requirement' | 'plan' | 'work';
  id: string;
  title?: string;
  status: string;
  revision: number;
  updatedAt: string;
  parentId?: string;
  children?: WorkTreeProjectionNode[];
}

export interface UnifiedActivityView {
  workTree: WorkTreeProjectionNode[];
  directActivities: CapabilityActivityItem[];
  observedAt: string;
  freshnessMs: number;
}
