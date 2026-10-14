import type { StructuralNodeSummary, StructuralReadProviderResponse } from './structural-provider';

export function structuralResult(response: StructuralReadProviderResponse): {
  nodes: StructuralNodeSummary[];
  entryPoints: StructuralNodeSummary[];
  relatedFiles: string[];
  truncated: boolean;
} {
  const result = response.result ?? {};
  return {
    nodes: Array.isArray(result.nodes) ? result.nodes as StructuralNodeSummary[] : [],
    entryPoints: Array.isArray(result.entryPoints) ? result.entryPoints as StructuralNodeSummary[] : [],
    relatedFiles: Array.isArray(result.relatedFiles) ? result.relatedFiles.filter((value): value is string => typeof value === 'string') : [],
    truncated: result.truncated === true,
  };
}
