export type CandidateFindingStatus = 'candidate' | 'promoted' | 'dismissed';

export interface CandidateFindingEvidence {
  source: string;
  reference?: string;
  observedAt: string;
  details?: Record<string, unknown>;
}

export interface CandidateFindingExternalRef {
  kind: string;
  url?: string;
  number?: number;
  label?: string;
}

export interface CandidateFinding {
  schemaVersion: 1;
  revision: number;
  findingId: string;
  repoId: string;
  semanticKey: string;
  title: string;
  summary?: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  status: CandidateFindingStatus;
  observationCount: number;
  evidence: CandidateFindingEvidence[];
  firstSeenAt: string;
  lastSeenAt: string;
  promotedJobId?: string;
  dismissedReason?: string;
  /** Optional Requirement/operational provenance; repoId remains the owner. */
  requirementId?: string;
  kind?: 'defect' | 'performance' | 'reliability' | 'usability';
  sourceRepoId?: string;
  sourceWorkId?: string;
  sourceProcessId?: string;
  sourcePluginId?: string;
  externalRefs?: CandidateFindingExternalRef[];
}

export interface RecordCandidateFindingInput {
  repoId: string;
  semanticKey: string;
  title: string;
  summary?: string;
  severity?: CandidateFinding['severity'];
  evidence?: Omit<CandidateFindingEvidence, 'observedAt'> & { observedAt?: string };
  requirementId?: string;
  kind?: CandidateFinding['kind'];
  sourceRepoId?: string;
  sourceWorkId?: string;
  sourceProcessId?: string;
  sourcePluginId?: string;
  externalRefs?: CandidateFindingExternalRef[];
  requestId: string;
}
