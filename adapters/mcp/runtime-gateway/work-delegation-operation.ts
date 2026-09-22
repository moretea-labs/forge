import type { CallToolResult } from '../../../packages/protocols/mcp/tool-contract';
import { delegateToCodexCerebellum } from '../../../src/runtime/control-plane/facade';
import { result } from './result-adapter';

type DelegationRepository = { repoId: string };

/** Thin rh_work delegation facade. Worker admission and delegation policy remain canonical. */
export function callRhWorkDelegationOperation(
  repository: DelegationRepository,
  operation: string,
  args: Record<string, unknown>,
): CallToolResult | undefined {
  if (operation !== 'delegate') return undefined;
  const facade = delegateToCodexCerebellum(
    { repoId: repository.repoId },
    {
      workId: typeof args.work_id === 'string' ? args.work_id : undefined,
      target: args.target === 'grok' || args.target === 'claude' || args.target === 'codex' ? args.target : 'codex',
      objective: typeof args.objective === 'string' ? args.objective : 'Delegated cerebellum work',
      acceptanceCriteria: Array.isArray(args.acceptance_criteria) ? args.acceptance_criteria.map(String) : undefined,
      allowedPaths: Array.isArray(args.allowed_paths) ? args.allowed_paths.map(String) : undefined,
      forbiddenPaths: Array.isArray(args.forbidden_paths) ? args.forbidden_paths.map(String) : undefined,
      available: typeof args.available === 'boolean' ? args.available : undefined,
      codexAvailable: args.codex_available !== false,
      workerOutput: args.worker_output && typeof args.worker_output === 'object' && !Array.isArray(args.worker_output)
        ? args.worker_output as { uncertain?: boolean; summary?: string; patchProposal?: string; evidenceSummary?: string }
        : undefined,
    },
  );
  return result(facade as unknown as Record<string, unknown>, facade.status === 'blocked');
}
