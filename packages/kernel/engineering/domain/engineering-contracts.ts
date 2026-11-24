export type EngineeringRiskClass = 'low' | 'normal' | 'high' | 'critical';

/** Exact source-bound reference for a loaded project engineering contract; the project file remains authority. */
export interface ProjectEngineeringContractReceipt {
  schemaVersion: 1;
  contractPath: string;
  projectId: string;
  contractId: string;
  contractVersion: string;
  sourceRevision: string;
  contentDigest: string;
  provenance: {
    source: 'repository';
    loadedAt: string;
  };
}

export interface ContextClosureSkillResolution {
  id: string;
  version?: string;
  /** Availability source, not proof the invoking assistant read the skill. */
  source: 'project_contract' | 'repository_skill' | 'user_skill';
  matchedKinds: string[];
}

export interface ContextClosureSemanticToolResolution {
  providerId: string;
  languages: string[];
  status: 'ready' | 'registered' | 'degraded' | 'unavailable';
  evidenceCount: number;
}

/** Exact-source, bounded Context Closure evidence. It is derived from source/runtime facts and is not a new persistence authority. */
export interface ContextClosureReceipt {
  schemaVersion: 1;
  receiptId: string;
  sourceRevision: string;
  generatedAt: string;
  contextPackSchemaVersion: number;
  repository: {
    branch: string | null;
    dirty: boolean;
  };
  projectContract?: ProjectEngineeringContractReceipt;
  projectContractStatus: 'ready' | 'missing';
  guidance: { status: 'none' | 'ready' | 'degraded'; paths: string[] };
  detected: { languages: string[]; platforms: string[] };
  skills: {
    status: 'ready' | 'degraded' | 'unavailable' | 'not_required';
    requiredKinds: string[];
    resolved: ContextClosureSkillResolution[];
    unresolvedKinds: string[];
  };
  semanticTools: {
    required: boolean;
    status: 'ready' | 'degraded' | 'unavailable' | 'not_required';
    providers: ContextClosureSemanticToolResolution[];
    reasonCodes: string[];
    compilerEvidenceRequired: boolean;
  };
  sourceEvidence: {
    currentPaths: string[];
    testPaths: string[];
    recentChanges: Array<{ revision: string; committedAt: string; summary: string }>;
    rawSourceStatus: 'current' | 'partial' | 'unavailable';
    structuralStatus: 'disabled' | 'ready' | 'stale' | 'unavailable' | 'degraded';
  };
  readiness: { status: 'ready' | 'degraded' | 'insufficient'; reasonCodes: string[] };
  provenance: { source: 'rh_context'; contextGeneratedAt: string };
}
