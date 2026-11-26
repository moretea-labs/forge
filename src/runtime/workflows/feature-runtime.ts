import type { WorkflowGraphCheckpoint, WorkflowRunResult } from '../../../packages/workflow-runtime/api/index';
import {
  executeRegisteredWorkflow,
  type ExecuteRegisteredWorkflowInput,
  type WorkflowRuntimeExecutionDependencies,
} from './runtime';
import { executeRegisteredWorkflowGraph, type WorkflowGraphRuntimeDependencies } from './graph-runtime';
import { prepareWorkflowInvocationIntent, type WorkflowInvocationOriginKind } from './catalog';
import {
  validateWorkflowInvocationIntent,
  type WorkflowInvocationIntentV1,
} from '../../../packages/workflow-runtime/domain/workflow-invocation';

export interface ExecuteWorkflowFeatureInput extends ExecuteRegisteredWorkflowInput {
  origin?: { kind: WorkflowInvocationOriginKind; id?: string };
}

export interface ExecuteWorkflowInvocationIntentInput {
  controllerHome: string;
  repository: ExecuteRegisteredWorkflowInput['repository'];
  executionIdentity: ExecuteRegisteredWorkflowInput['executionIdentity'];
  intent: WorkflowInvocationIntentV1;
  requirementId?: string;
  timeoutMs?: number;
  approvalContext?: ExecuteRegisteredWorkflowInput['approvalContext'];
}

export type WorkflowFeatureRunResult = WorkflowRunResult | WorkflowGraphCheckpoint;

export interface WorkflowFeatureRuntimeDependencies {
  executeSequence?: (
    input: ExecuteRegisteredWorkflowInput,
    dependencies?: WorkflowRuntimeExecutionDependencies,
  ) => Promise<WorkflowRunResult>;
  sequenceDependencies?: WorkflowRuntimeExecutionDependencies;
  executeGraph?: typeof executeRegisteredWorkflowGraph;
  graphDependencies?: Omit<WorkflowGraphRuntimeDependencies, 'executeChild'>;
}

/**
 * Canonical first-class Workflow execution router.
 * All callers pass Catalog preflight before engine dispatch. Graph v2 fails closed
 * until its effect-owner adapter is connected; it is never coerced through v1.
 */
export async function executeWorkflowInvocationIntent(
  input: ExecuteWorkflowInvocationIntentInput,
  dependencies: WorkflowFeatureRuntimeDependencies = {},
): Promise<WorkflowFeatureRunResult> {
  const intent = validateWorkflowInvocationIntent(input.intent);
  const plan = prepareWorkflowInvocationIntent(input.controllerHome, intent);
  if (plan.readiness !== 'ready') {
    throw new Error(`WORKFLOW_INVOCATION_BLOCKED:${plan.blockers.join('|')}`);
  }
  const runtimeInput: ExecuteRegisteredWorkflowInput = {
    controllerHome: input.controllerHome,
    repository: input.repository,
    executionIdentity: input.executionIdentity,
    scopeId: intent.binding.scopeId,
    runId: intent.binding.runId,
    registryScope: intent.registryScope,
    workflowId: intent.workflowId,
    inputs: intent.inputs,
    ...(input.requirementId ? { requirementId: input.requirementId } : {}),
    ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
    ...(input.approvalContext ? { approvalContext: input.approvalContext } : {}),
  };
  if (plan.workflow.engine === 'graph_v2') {
    const executeGraph = dependencies.executeGraph ?? executeRegisteredWorkflowGraph;
    return executeGraph(runtimeInput, {
      ...dependencies.graphDependencies,
      executeChild: async (child) =>
        (await executeRegisteredWorkflowFeature(child, dependencies)) as WorkflowFeatureRunResult &
          Record<string, unknown>,
    });
  }
  const executeSequence = dependencies.executeSequence ?? executeRegisteredWorkflow;
  return executeSequence(runtimeInput, dependencies.sequenceDependencies);
}

export async function executeRegisteredWorkflowFeature(
  input: ExecuteWorkflowFeatureInput,
  dependencies: WorkflowFeatureRuntimeDependencies = {},
): Promise<WorkflowFeatureRunResult> {
  const intent = validateWorkflowInvocationIntent({
    schemaVersion: 1,
    workflowId: input.workflowId,
    registryScope: input.registryScope,
    origin: input.origin ?? { kind: 'system', id: 'workflow-feature-runtime' },
    inputs: input.inputs ?? {},
    binding: { scopeId: input.scopeId, runId: input.runId },
  });
  return executeWorkflowInvocationIntent(
    {
      controllerHome: input.controllerHome,
      repository: input.repository,
      executionIdentity: input.executionIdentity,
      intent,
      ...(input.requirementId ? { requirementId: input.requirementId } : {}),
      ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
      ...(input.approvalContext ? { approvalContext: input.approvalContext } : {}),
    },
    dependencies,
  );
}
