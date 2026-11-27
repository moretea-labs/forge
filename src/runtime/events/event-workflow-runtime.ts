import { createHash } from 'crypto';
import {
  eventEnvelopeDeduplicationKey,
  validateEventEnvelopeV1,
  type EventEnvelopeV1,
} from '../../../packages/kernel/events';
import type { WorkflowJsonValue } from '../../../packages/workflow-runtime/api/index';
import type { RepositoryRecord } from '../../core/repository/types';
import { getRepository } from '../repositories/registry';
import { executionIdentityForRepository } from '../control-plane/execution/execution-identity';
import { getWorkflowCatalogEntry } from '../workflows/catalog';
import {
  executeRegisteredWorkflowFeature,
  type ExecuteWorkflowFeatureInput,
  type WorkflowFeatureRunResult,
  type WorkflowFeatureRuntimeDependencies,
} from '../workflows/feature-runtime';
import type { EventAutomationActionPlanV1 } from './event-automation-plan';

export type EventWorkflowExecutionStatus = 'succeeded' | 'waiting' | 'reconcile_required' | 'failed' | 'cancelled';

export interface EventWorkflowExecutionResultV1 {
  schemaVersion: 1;
  eventId: string;
  ruleId: string;
  routeId: string;
  actionRef: string;
  workflowId: string;
  runId: string;
  scopeId: string;
  status: EventWorkflowExecutionStatus;
  workflowResult: WorkflowFeatureRunResult;
}

export interface EventWorkflowRuntimeDependencies {
  executeWorkflow?: (
    input: ExecuteWorkflowFeatureInput,
    dependencies?: WorkflowFeatureRuntimeDependencies,
  ) => Promise<WorkflowFeatureRunResult>;
  workflowDependencies?: WorkflowFeatureRuntimeDependencies;
}

function workflowHandler(plan: EventAutomationActionPlanV1) {
  if (plan.readiness !== 'ready') throw new Error('EVENT_WORKFLOW_PLAN_BLOCKED:' + (plan.blocker ?? 'unknown'));
  if (plan.execution !== 'not_executed') throw new Error('EVENT_WORKFLOW_PLAN_ALREADY_EXECUTED');
  if (plan.handler?.kind !== 'workflow') throw new Error('EVENT_WORKFLOW_HANDLER_REQUIRED');
  return plan.handler;
}

function assertPlanIdentity(controllerHome: string, plan: EventAutomationActionPlanV1): void {
  const handler = workflowHandler(plan);
  const current = getWorkflowCatalogEntry(controllerHome, handler.registryScope, handler.workflowId);
  if (current?.status !== 'active') throw new Error('EVENT_WORKFLOW_PLAN_STALE');
  const descriptor = current.descriptor;
  if (
    descriptor.workflowId !== handler.workflowId ||
    descriptor.version !== handler.version ||
    descriptor.contentDigest !== handler.contentDigest ||
    descriptor.engine !== handler.engine
  ) {
    throw new Error('EVENT_WORKFLOW_PLAN_STALE');
  }
}

function eventWorkflowOriginId(event: EventEnvelopeV1): string {
  return `event:${createHash('sha256').update(event.eventId).digest('hex')}`;
}

function eventWorkflowRunId(event: EventEnvelopeV1, plan: EventAutomationActionPlanV1): string {
  const handler = workflowHandler(plan);
  const identity = JSON.stringify([
    eventEnvelopeDeduplicationKey(event),
    plan.ruleId,
    plan.ruleRevision,
    plan.routeId,
    plan.actionRef,
    handler.workflowId,
    handler.version,
    handler.contentDigest,
  ]);
  return `event-workflow-${createHash('sha256').update(identity).digest('hex').slice(0, 32)}`;
}

function runtimeScopeId(repository: RepositoryRecord, workflowId: string): string {
  return `repository:${repository.repoId}:checkout:${repository.activeCheckoutId}:workflow:${workflowId}`;
}

function normalizeStatus(result: WorkflowFeatureRunResult): EventWorkflowExecutionStatus {
  if (result.status === 'succeeded') return 'succeeded';
  if (result.status === 'reconcile_required') return 'reconcile_required';
  if (result.status === 'cancelled') return 'cancelled';
  if (result.status === 'failed') return 'failed';
  if (result.status === 'waiting' || result.status === 'running') return 'waiting';
  throw new Error('EVENT_WORKFLOW_RESULT_STATUS_UNSUPPORTED:' + String(result.status));
}

/**
 * Thin Event→Workflow adapter. Event owns rule matching/config resolution only;
 * Workflow owns lifecycle, engine routing, authorization, effects and recovery.
 */
export async function executeEventWorkflowAutomation(input: {
  controllerHome: string;
  event: EventEnvelopeV1;
  plan: EventAutomationActionPlanV1;
  repository: RepositoryRecord;
  timeoutMs?: number;
  approvalContext?: ExecuteWorkflowFeatureInput['approvalContext'];
  dependencies?: EventWorkflowRuntimeDependencies;
}): Promise<EventWorkflowExecutionResultV1> {
  const event = validateEventEnvelopeV1(input.event);
  const handler = workflowHandler(input.plan);
  assertPlanIdentity(input.controllerHome, input.plan);
  const repository = getRepository(input.repository.repoId, input.controllerHome, { includeRemoved: true });
  if (!repository.enabled || repository.removedAt) throw new Error('EVENT_WORKFLOW_REPOSITORY_UNAVAILABLE');
  if (repository.activeCheckoutId !== input.repository.activeCheckoutId)
    throw new Error('EVENT_WORKFLOW_REPOSITORY_CHECKOUT_STALE');
  const runId = eventWorkflowRunId(event, input.plan);
  const scopeId = runtimeScopeId(repository, handler.workflowId);
  const execute = input.dependencies?.executeWorkflow ?? executeRegisteredWorkflowFeature;
  const workflowResult = await execute(
    {
      controllerHome: input.controllerHome,
      repository,
      executionIdentity: executionIdentityForRepository(repository),
      scopeId,
      runId,
      registryScope: structuredClone(handler.registryScope),
      workflowId: handler.workflowId,
      inputs: structuredClone(input.plan.inputs) as Record<string, WorkflowJsonValue>,
      origin: { kind: 'event', id: eventWorkflowOriginId(event) },
      ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
      ...(input.approvalContext ? { approvalContext: input.approvalContext } : {}),
    },
    input.dependencies?.workflowDependencies,
  );
  return {
    schemaVersion: 1,
    eventId: event.eventId,
    ruleId: input.plan.ruleId,
    routeId: input.plan.routeId,
    actionRef: input.plan.actionRef,
    workflowId: handler.workflowId,
    runId,
    scopeId,
    status: normalizeStatus(workflowResult),
    workflowResult,
  };
}
