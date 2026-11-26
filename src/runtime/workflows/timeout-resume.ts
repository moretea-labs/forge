import { expireWorkflowGraphWait, type WorkflowGraphCheckpoint } from '../../../packages/workflow-runtime/api/index';
import { invalidateAuthorizationRequest, readAuthorizationRequest } from '../control-plane/governance/authorization';
import { executionIdentityForRepository } from '../control-plane/execution/execution-identity';
import { readWorkflowExecutableContentFile } from '../control-plane/persistence/workflow-content-store';
import { readWorkflowRegistryEntry } from '../control-plane/persistence/workflow-registry-store';
import {
  listWorkflowGraphRuns,
  readWorkflowGraphRun,
  writeWorkflowGraphRunCheckpoint,
  type WorkflowGraphRunRecord,
} from '../control-plane/persistence/workflow-run-store';
import { getRepository } from '../repositories/registry';
import { executeRegisteredWorkflowGraph, type WorkflowGraphRuntimeDependencies } from './graph-runtime';

export interface WorkflowDueResumeResult {
  scopeId: string;
  runId: string;
  workflowId: string;
  status: 'resumed' | 'expired' | 'blocked';
  workflowStatus?: WorkflowGraphCheckpoint['status'];
  error?: string;
}

function reconstruct(run: WorkflowGraphRunRecord): WorkflowGraphCheckpoint {
  return {
    schemaVersion: 2,
    binding: { scopeId: run.scopeId, runId: run.runId },
    workflowId: run.workflowId,
    version: run.version,
    contentDigest: run.contentDigest,
    status: run.status,
    nodes: structuredClone(run.nodes),
    edges: structuredClone(run.edges),
  };
}

async function resumeOne(
  controllerHome: string,
  scopeId: string,
  runId: string,
  now: Date,
  dependencies: WorkflowGraphRuntimeDependencies,
): Promise<WorkflowDueResumeResult | undefined> {
  const record = readWorkflowGraphRun(controllerHome, scopeId, runId);
  if (!record || record.value.status !== 'waiting') return undefined;
  const run = record.value;
  const dueNodeIds = run.nodes
    .filter(
      (node) =>
        node.status === 'waiting' &&
        node.wait &&
        node.wait.kind !== 'retry_backoff' &&
        Date.parse(node.wait.expiresAt) <= now.getTime(),
    )
    .map((node) => node.nodeId);
  if (dueNodeIds.length === 0) return undefined;
  try {
    const registry = readWorkflowRegistryEntry(controllerHome, run.execution.registryScope, run.workflowId);
    if (!registry || registry.value.status !== 'active') throw new Error('WORKFLOW_DUE_RESUME_REGISTRY_NOT_ACTIVE');
    if (registry.value.version !== run.version || registry.value.contentDigest !== run.contentDigest)
      throw new Error('WORKFLOW_DUE_RESUME_CONTENT_IDENTITY_MISMATCH');
    const asset = readWorkflowExecutableContentFile(registry.value.contentLocation.path);
    if (asset.schemaVersion !== 2) throw new Error('WORKFLOW_DUE_RESUME_GRAPH_REQUIRED');
    const repository = getRepository(run.execution.repositoryId, controllerHome);
    if (repository.activeCheckoutId !== run.execution.checkoutId) throw new Error('WORKFLOW_DUE_RESUME_CHECKOUT_DRIFT');
    let checkpoint = reconstruct(run);
    for (const nodeId of dueNodeIds.sort()) {
      const state = checkpoint.nodes.find((node) => node.nodeId === nodeId);
      if (state?.status !== 'waiting' || !state.wait || state.wait.kind === 'retry_backoff') continue;
      if (state.wait.kind === 'approval' && state.wait.requestRef) {
        const request = readAuthorizationRequest(controllerHome, repository.repoId, state.wait.requestRef);
        if (request.status === 'pending') {
          invalidateAuthorizationRequest({
            controllerHome,
            repositoryId: repository.repoId,
            approvalRequestId: state.wait.requestRef,
            reason: `Workflow approval ${run.workflowId}/${run.runId}/${nodeId} expired at ${state.wait.expiresAt}.`,
          });
        }
      }
      checkpoint = expireWorkflowGraphWait(asset, checkpoint, nodeId, now, run.inputs);
    }
    const stored = writeWorkflowGraphRunCheckpoint({
      controllerHome,
      checkpoint,
      inputs: run.inputs,
      execution: run.execution,
      expectedRevision: record.revision,
      now,
    });
    if (
      stored.value.status === 'running' ||
      stored.value.status === 'compensating' ||
      (stored.value.status === 'failed' && asset.failurePolicy?.mode === 'compensate')
    ) {
      const resumed = await executeRegisteredWorkflowGraph(
        {
          controllerHome,
          repository,
          executionIdentity: executionIdentityForRepository(repository),
          scopeId: run.scopeId,
          runId: run.runId,
          registryScope: run.execution.registryScope,
          workflowId: run.workflowId,
          inputs: run.inputs,
          ...(run.execution.approvalContext ? { approvalContext: structuredClone(run.execution.approvalContext) } : {}),
        },
        dependencies,
      );
      return { scopeId, runId, workflowId: run.workflowId, status: 'resumed', workflowStatus: resumed.status };
    }
    return { scopeId, runId, workflowId: run.workflowId, status: 'expired', workflowStatus: stored.value.status };
  } catch (error) {
    return {
      scopeId,
      runId,
      workflowId: run.workflowId,
      status: 'blocked',
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Controller-wide due-wait sweep intended to be invoked by the existing Scheduler. No daemon or second wait ledger. */
export async function resumeDueWorkflowGraphWaits(
  controllerHome: string,
  now: Date,
  dependencies: WorkflowGraphRuntimeDependencies = {},
  limit = 256,
): Promise<WorkflowDueResumeResult[]> {
  const runs = listWorkflowGraphRuns(controllerHome, { status: 'waiting', limit });
  const results: WorkflowDueResumeResult[] = [];
  for (const run of runs) {
    const result = await resumeOne(controllerHome, run.value.scopeId, run.value.runId, now, dependencies);
    if (result) results.push(result);
  }
  return results;
}
