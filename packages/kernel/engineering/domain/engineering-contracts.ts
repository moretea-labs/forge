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
