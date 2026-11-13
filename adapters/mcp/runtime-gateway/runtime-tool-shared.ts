import { boundedPluginArtifactImageContent, jsonPreview, result, resultWithPluginArtifactImages } from './result-adapter';
import { expectedRevision, repositoryRootForRepoId, selected, stringList } from './shared-adapter';
import type { MultiRepositoryMcpToolContext } from '../multi-repository';
import { getAgentJob } from '../../../src/cli/agent-jobs/job-manager';
import { getLocalBridgeJob } from '../../../src/cli/local-bridge/job-store';
import type { ExecutionJob } from '../../../src/runtime/execution/jobs/types';
import { readJobEvents } from '../../../src/runtime/evidence/event-ledger';
import {
  summarizeExecutionJobForMcp,
  summarizeJobResultForLowInterception,
  summarizePluginForLowInterception,
} from '../../../src/runtime/safe-tooling';

export function summarizeJobEvents(ctx: MultiRepositoryMcpToolContext, repoId: string, jobId: string): Array<Record<string, unknown>> {
  const repoRoot = repositoryRootForRepoId(ctx, repoId);
  return readJobEvents(ctx.controllerHome, repoId, jobId).slice(-20).map((event) => {
    const dataPreview = event.data && Object.keys(event.data).length > 0 ? jsonPreview(event.data, 240, repoRoot ? [repoRoot] : []) : undefined;
    return {
      eventId: event.eventId,
      eventType: event.eventType,
      occurredAt: event.occurredAt,
      revision: event.revision,
      ...(dataPreview ? { dataPreview: dataPreview.preview, dataTruncated: dataPreview.truncated } : {}),
    };
  });
}

export function summarizeExecutionJob(job: ExecutionJob, repoRoot?: string): Record<string, unknown> {
  return summarizeExecutionJobForMcp(job, repoRoot, { getLocalBridgeJob, getAgentJob });
}
