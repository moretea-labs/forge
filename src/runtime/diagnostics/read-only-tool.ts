import type { RepositoryRecord } from '../../cli/repositories/types';
import { previewRuntimeCleanup } from '../maintenance/cleanup';
import { buildRuntimeMaintenanceStatus } from '../recovery/maintenance-executor';
import { buildWorkflowWatchdogReport } from '../watchdog/workflow-watchdog';

export const READ_ONLY_DIAGNOSTIC_TOOLS = [
  'runtime_maintenance_status',
  'workflow_watchdog_report',
  'runtime_cleanup_preview',
] as const;

export type ReadOnlyDiagnosticTool = (typeof READ_ONLY_DIAGNOSTIC_TOOLS)[number];

const READ_ONLY_DIAGNOSTIC_TOOL_SET = new Set<string>(READ_ONLY_DIAGNOSTIC_TOOLS);

export function isReadOnlyDiagnosticTool(value: string): value is ReadOnlyDiagnosticTool {
  return READ_ONLY_DIAGNOSTIC_TOOL_SET.has(value);
}

export function executeReadOnlyDiagnostic(
  tool: ReadOnlyDiagnosticTool,
  controllerHome: string,
  repository: RepositoryRecord,
  args: Record<string, unknown>,
): Record<string, unknown> {
  switch (tool) {
    case 'runtime_maintenance_status':
      return buildRuntimeMaintenanceStatus(repository, controllerHome, {
        minAgeMinutes: typeof args.min_age_minutes === 'number' ? args.min_age_minutes : undefined,
        maxCandidates: typeof args.max_candidates === 'number' ? args.max_candidates : undefined,
        cancelPendingApprovals: args.cancel_pending_approvals === true,
        recentErrors: Array.isArray(args.recent_errors) ? args.recent_errors.map(String) : undefined,
      }) as unknown as Record<string, unknown>;
    case 'workflow_watchdog_report':
      return buildWorkflowWatchdogReport(controllerHome, repository, {
        staleMinutes: args.stale_minutes,
        includeProcesses: args.include_processes,
      }) as unknown as Record<string, unknown>;
    case 'runtime_cleanup_preview':
      return previewRuntimeCleanup(repository.canonicalRoot, {
        minAgeMinutes: typeof args.min_age_minutes === 'number' ? args.min_age_minutes : undefined,
        includeTempDirs: args.include_temp_dirs !== false,
        includeTerminalLocalJobs: args.include_terminal_local_jobs === true,
        includeLegacyRuns: args.include_legacy_runs === true,
        includeHistoricalAttention: args.include_historical_attention === true,
        maxCandidates: typeof args.max_candidates === 'number' ? args.max_candidates : undefined,
      }) as unknown as Record<string, unknown>;
  }
}
