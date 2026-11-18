import { listAutopilotRuns } from './store';
import type { AutopilotRun, AutopilotRunStatus } from './types';

export interface AutopilotRunSummary {
  runId: string;
  status: AutopilotRunStatus;
  requirementRevision: number;
  requiresReapproval: boolean;
  currentPlanId?: string;
  lastSummary?: string;
  stopReason?: string;
  processReconciliationPending: boolean;
  evidenceRefs: string[];
  evidenceTruncatedCount: number;
  usage: { totalTokens: number; turns: number; toolCalls: number };
  createdAt: string;
  updatedAt: string;
}

/** A bounded read-only projection; authorization secrets and execution policy stay with their owners. */
export function summarizeAutopilotRun(run: AutopilotRun, currentRequirementRevision: number): AutopilotRunSummary {
  const allEvidenceRefs = Array.isArray(run.evidenceRefs) ? run.evidenceRefs : [];
  const evidenceRefs = allEvidenceRefs.slice(-20).map((reference) => String(reference).slice(0, 512));
  return {
    runId: run.runId,
    status: run.status,
    requirementRevision: run.requirementRevision,
    requiresReapproval: run.requirementRevision !== currentRequirementRevision,
    ...(run.currentPlanId?.trim() ? { currentPlanId: run.currentPlanId.trim() } : {}),
    ...(run.lastSummary?.trim() ? { lastSummary: run.lastSummary.trim().slice(0, 500) } : {}),
    ...(run.stopReason?.trim() ? { stopReason: run.stopReason.trim().slice(0, 500) } : {}),
    processReconciliationPending: Boolean(run.pendingProcessId?.trim() || run.pendingCommandRequestId?.trim()),
    evidenceRefs,
    evidenceTruncatedCount: Math.max(0, allEvidenceRefs.length - evidenceRefs.length),
    usage: {
      totalTokens: Math.max(0, Number(run.usage.totalTokens) || 0),
      turns: Math.max(0, Number(run.usage.turns) || 0),
      toolCalls: Math.max(0, Number(run.usage.toolCalls) || 0),
    },
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
  };
}

export function listAutopilotRunSummaries(
  controllerHome: string,
  requirements: readonly { requirementId: string; repoId?: string; revision: number }[],
): Map<string, AutopilotRunSummary | null> {
  const runsByRepository = new Map<string, Map<string, AutopilotRun>>();
  const summaries = new Map<string, AutopilotRunSummary | null>();
  for (const requirement of requirements) {
    const repoId = requirement.repoId?.trim();
    if (!repoId) {
      summaries.set(requirement.requirementId, null);
      continue;
    }
    let runs = runsByRepository.get(repoId);
    if (!runs) {
      const records = listAutopilotRuns(controllerHome, repoId, 1_000);
      if (records.length >= 1_000) throw new Error('AUTOPILOT_RUN_LOOKUP_LIMIT');
      runs = new Map(records
        .filter(({ value }) => value.repoId === repoId)
        .map(({ value }) => [value.requirementId, value]));
      runsByRepository.set(repoId, runs);
    }
    const run = runs.get(requirement.requirementId);
    summaries.set(requirement.requirementId, run ? summarizeAutopilotRun(run, requirement.revision) : null);
  }
  return summaries;
}
