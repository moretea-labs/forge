import type { CodeGraphNodeSummary, CodeGraphReadProviderResponse } from '../../../runtime/context/codegraph-read-provider';

export function structuralResult(response: CodeGraphReadProviderResponse): {
  nodes: CodeGraphNodeSummary[];
  entryPoints: CodeGraphNodeSummary[];
  relatedFiles: string[];
  truncated: boolean;
} {
  const result = response.result ?? {};
  return {
    nodes: Array.isArray(result.nodes) ? result.nodes as CodeGraphNodeSummary[] : [],
    entryPoints: Array.isArray(result.entryPoints) ? result.entryPoints as CodeGraphNodeSummary[] : [],
    relatedFiles: Array.isArray(result.relatedFiles) ? result.relatedFiles.filter((value): value is string => typeof value === 'string') : [],
    truncated: result.truncated === true,
  };
}
