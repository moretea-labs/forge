import type { ProcessCheckReceiptEvidence } from './check-receipt';

export type FacadeDetailLevel = 'summary' | 'detail' | 'raw';
export interface EvidenceRef {
  evidenceId?: string;
  artifactId?: string;
  title: string;
  summary?: string;
  detailLevel?: FacadeDetailLevel;
}
export interface SuggestedNextAction {
  label: string;
  tool: 'rh_access' | 'rh_status' | 'rh_inbox' | 'rh_context' | 'rh_work' | 'capability_execute';
  operation: string;
  payload?: Record<string, unknown>;
  risk:
    | 'readonly'
    | 'local_repo_write'
    | 'workspace_write'
    | 'remote_write'
    | 'destructive_remote'
    | 'destructive'
    | 'raw_secret_config'
    | 'unknown';
  confidence?: 'low' | 'medium' | 'high';
  reason?: string;
  fallback?: string;
}
export interface PolicyDecision {
  decision: 'allowed' | 'approval_required' | 'denied' | 'dry_run_only';
  reason: string;
  capabilityId?: string;
  approvalRequestId?: string;
  requiredConfirmationText?: string;
  warnings: string[];
  suggestedNextActions: SuggestedNextAction[];
}

export const ENGINEERING_RISKS = ['readonly', 'low', 'medium', 'high', 'destructive'] as const;
export type EngineeringRisk = (typeof ENGINEERING_RISKS)[number];

export const VERIFICATION_OUTCOMES = [
  'valid_pass',
  'valid_fail',
  'invalid_check_id',
  'infrastructure_failure',
  'skipped',
  'superseded',
] as const;
export type VerificationOutcome = (typeof VERIFICATION_OUTCOMES)[number];

export interface VerificationRecord {
  checkId: string;
  outcome: VerificationOutcome;
  summary: string;
  recordedAt: string;
  /** Exact checked revision. Absence denotes legacy/non-authoritative evidence. */
  sourceRevision?: string;
  /** Exact dirty-workspace content identity observed by the check. */
  workspaceFingerprint?: string;
  /** Hash of the check inputs that must match before this result can be reused. */
  verificationInputFingerprint?: string;
  /** Bounded identity of the command/configuration that produced the result. */
  commandFingerprint?: string;
  resultArtifactId?: string;
  startedAt?: string;
  completedAt?: string;
  supersedes?: string;
  staleReason?: string;
  evidenceRef?: EvidenceRef;
  receipt?: ProcessCheckReceiptEvidence;
}
