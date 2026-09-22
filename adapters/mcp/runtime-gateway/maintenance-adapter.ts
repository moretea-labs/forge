import type { McpToolDefinition, CallToolResult } from '../../../packages/protocols/mcp/tool-contract';
import type { MultiRepositoryMcpToolContext } from '../multi-repository';
import { boundedPluginArtifactImageContent, jsonPreview, result, resultWithPluginArtifactImages } from './result-adapter';
import { expectedRevision, repositoryRootForRepoId, selected, stringList } from './shared-adapter';
import { applyRuntimeCleanup, previewRuntimeCleanup } from '../../../src/runtime/maintenance/cleanup';



export async function callMaintenanceAdapter(ctx: MultiRepositoryMcpToolContext, name: string, args: Record<string, unknown>): Promise<CallToolResult | undefined> {
  try {
    switch (name) {
      case 'runtime_cleanup_preview': {
              const repository = selected(ctx, args);
              const preview = previewRuntimeCleanup(repository.canonicalRoot, {
                minAgeMinutes: typeof args.min_age_minutes === 'number' ? args.min_age_minutes : undefined,
                includeTempDirs: args.include_temp_dirs !== false,
                includeTerminalLocalJobs: args.include_terminal_local_jobs === true,
                includeLegacyRuns: args.include_legacy_runs === true,
                includeHistoricalAttention: args.include_historical_attention === true,
                maxCandidates: typeof args.max_candidates === 'number' ? args.max_candidates : undefined,
              });
              return result({ ...preview });
            }
      case 'runtime_cleanup_apply': {
              const repository = selected(ctx, args);
              const applied = applyRuntimeCleanup(repository.canonicalRoot, {
                minAgeMinutes: typeof args.min_age_minutes === 'number' ? args.min_age_minutes : undefined,
                includeTempDirs: args.include_temp_dirs !== false,
                includeTerminalLocalJobs: args.include_terminal_local_jobs === true,
                includeLegacyRuns: args.include_legacy_runs === true,
                includeHistoricalAttention: args.include_historical_attention === true,
                maxCandidates: typeof args.max_candidates === 'number' ? args.max_candidates : undefined,
                confirmCleanup: args.confirm_cleanup === true,
              });
              return result({ ...applied });
            }
      default: return undefined;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const structuredCode = /^([A-Z][A-Z0-9_]+)(?::|$)/.exec(message)?.[1];
    return result({ error: { code: structuredCode ?? 'RUNTIME_TOOL_FAILED', message } }, true);
  }
}
