import type { StructuralReadRequest, StructuralReadProviderResponse } from '../../../runtime/context/context-pack-contract';

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
