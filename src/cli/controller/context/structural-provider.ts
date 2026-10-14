export type StructuralReadOperation = 'status' | 'search' | 'context' | 'impact' | 'file_dependencies';
export type StructuralProviderStatus = 'ready' | 'stale' | 'unavailable' | 'degraded';

export interface StructuralNodeSummary {
  id: string;
  kind: string;
  name: string;
  qualifiedName?: string;
  filePath: string;
  language?: string;
  startLine: number;
  endLine: number;
  signature?: string;
}

export interface StructuralIndexMetadata {
  initialized: boolean;
  lastIndexedAt: number | null;
  buildVersion: string | null;
  extractionVersion: number | null;
  staleEngine: boolean;
  changedFiles: {
    added: string[];
    modified: string[];
    removed: string[];
  };
  ignoredChangedFileCount?: number;
}

export interface StructuralReadRequest {
  operation: StructuralReadOperation;
  query?: string;
  nodeId?: string;
  filePath?: string;
  limit?: number;
  maxNodes?: number;
  maxDepth?: number;
  refresh?: 'if_stale';
}

export interface StructuralReadProviderResponse {
  schemaVersion: 1;
  provider: 'none';
  operation: StructuralReadOperation;
  ok: boolean;
  status: StructuralProviderStatus;
  metadata?: StructuralIndexMetadata;
  result?: Record<string, unknown>;
  error?: {
    code: string;
    message: string;
  };
  timingsMs: {
    total: number;
    process?: number;
    open?: number;
    query?: number;
  };
}

export function unavailableStructuralProvider(
  _repoRoot: string,
  request: StructuralReadRequest,
): StructuralReadProviderResponse {
  return {
    schemaVersion: 1,
    provider: 'none',
    operation: request.operation,
    ok: false,
    status: 'unavailable',
    error: {
      code: 'STRUCTURAL_PROVIDER_UNAVAILABLE',
      message: 'Integrated CodeGraph structural indexing has been decommissioned; use current raw source, lexical search, known_paths, or semantic_navigation.',
    },
    timingsMs: { total: 0 },
  };
}

export async function unavailableStructuralProviderAsync(
  repoRoot: string,
  request: StructuralReadRequest,
): Promise<StructuralReadProviderResponse> {
  return unavailableStructuralProvider(repoRoot, request);
}
