import type { AssistantPluginActionConfirmation, AssistantPluginActionRisk } from '../plugins/types';

export type SafeToolRisk = AssistantPluginActionRisk | 'low' | 'medium' | 'high';

export interface SafeActionSummary {
  actionKey: string;
  title: string;
  readOnly: boolean;
  risk: AssistantPluginActionRisk;
  confirmation: AssistantPluginActionConfirmation;
  requiresExplicitApproval: boolean;
  argumentKeys: string[];
}

export interface SafePluginSummary {
  pluginId: string;
  displayName: string;
  provider: string;
  enabled: boolean;
  lifecycleState: string;
  healthState: string;
  ready: boolean;
  warnings: string[];
  errors: string[];
  permissionSummary: {
    total: number;
    granted: number;
    missingRequired: number;
    writableGranted: number;
  };
  actionSummary: {
    total: number;
    readonly: number;
    writable: number;
    remoteWrite: number;
    destructive: number;
    requiresApproval: number;
  };
  actions: SafeActionSummary[];
  redaction: {
    configContentReturned: false;
    rawSecretsReturned: false;
    rawPathsReturned: false;
  };
}


export interface SafeJobResultSummary {
  jobId: string;
  repoId: string;
  status: string;
  type: string;
  operation: string;
  plugin?: { pluginId?: string; actionId?: string };
  safeError?: {
    code?: string;
    class: 'dependency_missing' | 'policy_denied' | 'authorization_required' | 'platform_blocked' | 'runtime_error' | 'unknown';
    retryable?: boolean;
    message: string;
    suggestedFixes: string[];
  };
  resultAvailable: boolean;
  resultPreview?: Record<string, unknown>;
  evidenceIds: string[];
  artifactRefs?: Array<{ artifactId: string; artifactKind?: string; byteLength?: number; next?: string }>;
  detailPointers?: Record<string, unknown>;
  redaction: {
    rawStdoutReturned: false;
    rawStderrReturned: false;
    rawPathsReturned: false;
    rawSecretsReturned: false;
  };
}
