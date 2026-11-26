import type { WorkflowJsonValue } from '../../../packages/workflow-runtime/api/index';
import { resolveWorkflowGraphWait } from '../../../packages/workflow-runtime/api/index';
import { executionIdentityForRepository } from '../control-plane/execution/execution-identity';
import { readWorkflowExecutableContentFile } from '../control-plane/persistence/workflow-content-store';
import {
  readWorkflowRegistryEntry,
  type WorkflowRegistryScope,
} from '../control-plane/persistence/workflow-registry-store';
import {
  listWorkflowGraphRuns,
  readWorkflowGraphRun,
  writeWorkflowGraphRunCheckpoint,
} from '../control-plane/persistence/workflow-run-store';
import { getRepository } from '../repositories/registry';
import { executeRegisteredWorkflowGraph, type WorkflowGraphRuntimeDependencies } from './graph-runtime';

export interface WorkflowGraphEventSignal {
  eventId: string;
  source: string;
  eventType: string;
  correlationKey: string;
  occurredAt?: string;
  receivedAt: string;
  payload?: Record<string, WorkflowJsonValue>;
}

export interface WorkflowGraphEventWaitMatch {
  scopeId: string;
  runId: string;
  runRevision: number;
  workflowId: string;
  nodeId: string;
  expiresAt: string;
  repositoryId: string;
  checkoutId: string;
  registryScope: WorkflowRegistryScope;
}

function signalTime(signal: WorkflowGraphEventSignal): number {
  const value = Date.parse(signal.occurredAt ?? signal.receivedAt);
  if (!Number.isFinite(value)) throw new Error('WORKFLOW_EVENT_SIGNAL_TIME_INVALID');
  return value;
}

function waitingNodeMatches(
  node: { kind: string; sources?: string[]; eventTypes?: string[] },
  signal: WorkflowGraphEventSignal,
): boolean {
  if (node.kind !== 'wait_event') return false;
  if (!node.sources?.includes(signal.source)) return false;
  return !node.eventTypes || node.eventTypes.includes(signal.eventType);
}

export function findWorkflowGraphEventWaits(
  controllerHome: string,
  signal: WorkflowGraphEventSignal,
  limit = 1000,
): WorkflowGraphEventWaitMatch[] {
  const at = signalTime(signal);
  const matches: WorkflowGraphEventWaitMatch[] = [];
  for (const run of listWorkflowGraphRuns(controllerHome, { status: 'waiting', limit })) {
    const registry = readWorkflowRegistryEntry(controllerHome, run.value.execution.registryScope, run.value.workflowId);
    if (!registry) continue;
    if (
      registry.value.version !== run.value.version ||
      registry.value.contentDigest !== run.value.contentDigest ||
      (registry.value.engine ?? 'sequence_v1') !== 'graph_v2'
    ) {
      continue;
    }
    const asset = readWorkflowExecutableContentFile(registry.value.contentLocation.path);
    if (asset.schemaVersion !== 2) continue;
    for (const state of run.value.nodes) {
      if (state.status !== 'waiting' || state.wait?.kind !== 'event') continue;
      if (state.wait.correlationKey !== signal.correlationKey) continue;
      if (at > Date.parse(state.wait.expiresAt)) continue;
      const definition = asset.nodes.find((node) => node.nodeId === state.nodeId);
      if (!definition || !waitingNodeMatches(definition, signal)) continue;
      matches.push({
        scopeId: run.value.scopeId,
        runId: run.value.runId,
        runRevision: run.revision,
        workflowId: run.value.workflowId,
        nodeId: state.nodeId,
        expiresAt: state.wait.expiresAt,
        repositoryId: run.value.execution.repositoryId,
        checkoutId: run.value.execution.checkoutId,
        registryScope: structuredClone(run.value.execution.registryScope),
      });
    }
  }
  return matches.sort((left, right) =>
    `${left.scopeId}\0${left.runId}\0${left.nodeId}`.localeCompare(`${right.scopeId}\0${right.runId}\0${right.nodeId}`),
  );
}

function sameScope(left: WorkflowRegistryScope, right: WorkflowRegistryScope): boolean {
  return (
    left.kind === right.kind &&
    (left.kind === 'controller' || left.projectId === (right as { kind: 'project'; projectId: string }).projectId)
  );
}

/**
 * Resolve one exact durable wait with optimistic revision fencing, then continue
 * the same Workflow run. Discovery alone never authorizes execution.
 */
export async function resumeWorkflowGraphEventWait(
  controllerHome: string,
  match: WorkflowGraphEventWaitMatch,
  signal: WorkflowGraphEventSignal,
  dependencies: WorkflowGraphRuntimeDependencies = {},
) {
  const run = readWorkflowGraphRun(controllerHome, match.scopeId, match.runId);
  if (!run || run.revision !== match.runRevision) throw new Error('WORKFLOW_EVENT_WAIT_MATCH_STALE');
  if (
    run.value.workflowId !== match.workflowId ||
    run.value.execution.repositoryId !== match.repositoryId ||
    run.value.execution.checkoutId !== match.checkoutId ||
    !sameScope(run.value.execution.registryScope, match.registryScope)
  ) {
    throw new Error('WORKFLOW_EVENT_WAIT_IDENTITY_MISMATCH');
  }
  const repository = getRepository(match.repositoryId, controllerHome);
  if (repository.activeCheckoutId !== match.checkoutId) throw new Error('WORKFLOW_EVENT_WAIT_CHECKOUT_DRIFT');
  const registry = readWorkflowRegistryEntry(controllerHome, match.registryScope, match.workflowId);
  if (!registry || registry.value.status !== 'active') throw new Error('WORKFLOW_EVENT_WAIT_REGISTRY_NOT_ACTIVE');
  if (registry.value.version !== run.value.version || registry.value.contentDigest !== run.value.contentDigest)
    throw new Error('WORKFLOW_EVENT_WAIT_CONTENT_IDENTITY_MISMATCH');
  const asset = readWorkflowExecutableContentFile(registry.value.contentLocation.path);
  if (asset.schemaVersion !== 2) throw new Error('WORKFLOW_EVENT_WAIT_GRAPH_REQUIRED');
  const state = run.value.nodes.find((node) => node.nodeId === match.nodeId);
  const definition = asset.nodes.find((node) => node.nodeId === match.nodeId);
  if (
    !state ||
    state.status !== 'waiting' ||
    state.wait?.kind !== 'event' ||
    state.wait.correlationKey !== signal.correlationKey ||
    !definition ||
    !waitingNodeMatches(definition, signal)
  ) {
    throw new Error('WORKFLOW_EVENT_WAIT_NO_LONGER_MATCHES');
  }
  if (signalTime(signal) > Date.parse(state.wait.expiresAt)) throw new Error('WORKFLOW_EVENT_WAIT_EXPIRED');
  const checkpoint = {
    schemaVersion: 2 as const,
    binding: { scopeId: run.value.scopeId, runId: run.value.runId },
    workflowId: run.value.workflowId,
    version: run.value.version,
    contentDigest: run.value.contentDigest,
    status: run.value.status,
    nodes: structuredClone(run.value.nodes),
    edges: structuredClone(run.value.edges),
  };
  const resolved = resolveWorkflowGraphWait(
    asset,
    checkpoint,
    match.nodeId,
    {
      output: {
        eventId: signal.eventId,
        source: signal.source,
        eventType: signal.eventType,
        correlationKey: signal.correlationKey,
        receivedAt: signal.receivedAt,
        ...(signal.occurredAt ? { occurredAt: signal.occurredAt } : {}),
        ...(signal.payload ? { payload: structuredClone(signal.payload) } : {}),
      },
      receiptRef: signal.eventId,
      recordedAt: signal.receivedAt,
    },
    run.value.inputs,
  );
  writeWorkflowGraphRunCheckpoint({
    controllerHome,
    checkpoint: resolved,
    inputs: run.value.inputs,
    execution: run.value.execution,
    expectedRevision: run.revision,
    now: new Date(signal.receivedAt),
  });
  if (['succeeded', 'failed', 'reconcile_required', 'cancelled'].includes(resolved.status)) return resolved;
  return executeRegisteredWorkflowGraph(
    {
      controllerHome,
      repository,
      executionIdentity: executionIdentityForRepository(repository),
      scopeId: run.value.scopeId,
      runId: run.value.runId,
      registryScope: run.value.execution.registryScope,
      workflowId: run.value.workflowId,
      inputs: run.value.inputs,
      ...(run.value.execution.approvalContext
        ? { approvalContext: structuredClone(run.value.execution.approvalContext) }
        : {}),
    },
    dependencies,
  );
}
