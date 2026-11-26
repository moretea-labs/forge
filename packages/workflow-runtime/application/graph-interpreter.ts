import type { WorkflowJsonValue } from '../domain/workflow-asset';
import type { WorkflowGraphAssetDefinition } from '../domain/workflow-graph';
import {
  createInitialWorkflowGraphCheckpoint,
  validateWorkflowGraphCheckpoint,
  type WorkflowGraphCheckpoint,
} from '../domain/workflow-graph-checkpoint';
import {
  completeWorkflowGraphNodeFailure,
  completeWorkflowGraphNodeSuccess,
  registerWorkflowGraphWait,
  stabilizeWorkflowGraphCheckpoint,
  startWorkflowGraphNode,
} from './graph-reducer';
import { planWorkflowGraphDispatch, type WorkflowGraphDispatchPlan } from './graph-dispatch';
import {
  beginWorkflowGraphCompensation,
  completeWorkflowGraphCompensation,
  planWorkflowGraphCompensation,
  startWorkflowGraphCompensation,
  type WorkflowGraphCompensationPlan,
} from './graph-compensation';

export interface WorkflowGraphRunBinding {
  scopeId: string;
  runId: string;
}

export type WorkflowGraphEffectPlan = Extract<
  WorkflowGraphDispatchPlan,
  { kind: 'capability' | 'script' | 'workflow' }
>;
export type WorkflowGraphWaitPlan = Extract<WorkflowGraphDispatchPlan, { kind: 'wait_event' | 'approval' }>;

export interface WorkflowGraphEffectExecutionResult {
  outcome: 'succeeded' | 'failed' | 'outcome_unknown';
  failureClass?: 'failed' | 'timeout' | 'rate_limited' | 'unavailable';
  receiptRef?: string;
  output?: Record<string, unknown>;
  error?: { code: string; message: string };
  recordedAt?: string;
}

export interface WorkflowGraphWaitRegistrationResult {
  registeredAt: string;
  expiresAt: string;
  correlationKey?: string;
  requestRef?: string;
}

export interface WorkflowGraphInterpreterPorts {
  executeEffect(input: {
    binding: WorkflowGraphRunBinding;
    asset: WorkflowGraphAssetDefinition;
    plan: WorkflowGraphEffectPlan;
    requestId: string;
  }): Promise<WorkflowGraphEffectExecutionResult>;
  registerWait(input: {
    binding: WorkflowGraphRunBinding;
    asset: WorkflowGraphAssetDefinition;
    plan: WorkflowGraphWaitPlan;
    requestId: string;
  }): Promise<WorkflowGraphWaitRegistrationResult>;
  executeCompensation?(input: {
    binding: WorkflowGraphRunBinding;
    asset: WorkflowGraphAssetDefinition;
    plan: WorkflowGraphCompensationPlan;
    requestId: string;
  }): Promise<WorkflowGraphEffectExecutionResult>;
  checkpoint?(checkpoint: WorkflowGraphCheckpoint): Promise<void> | void;
  now?: () => Date;
}

export interface ExecuteWorkflowGraphInput {
  asset: WorkflowGraphAssetDefinition;
  binding: WorkflowGraphRunBinding;
  inputs?: Record<string, WorkflowJsonValue>;
  checkpoint?: WorkflowGraphCheckpoint;
  transitionLimit?: number;
}

function requestId(
  binding: WorkflowGraphRunBinding,
  nodeId: string,
  attempt: number,
  phase: 'effect' | 'wait' | 'compensation',
): string {
  return `workflow-graph:${binding.scopeId}:${binding.runId}:${nodeId}:${attempt}:${phase}`;
}

async function persist(ports: WorkflowGraphInterpreterPorts, checkpoint: WorkflowGraphCheckpoint): Promise<void> {
  await ports.checkpoint?.(structuredClone(checkpoint));
}

function recoverInterruptedEffects(
  asset: WorkflowGraphAssetDefinition,
  checkpointInput: WorkflowGraphCheckpoint,
  now: Date,
): WorkflowGraphCheckpoint | undefined {
  if (!checkpointInput.nodes.some((node) => node.status === 'running')) return undefined;
  const checkpoint = structuredClone(checkpointInput);
  for (const state of checkpoint.nodes) {
    if (state.status !== 'running') continue;
    state.status = 'reconcile_required';
    state.error = {
      code: 'WORKFLOW_GRAPH_EFFECT_INTERRUPTED',
      message: `Workflow effect ${state.nodeId} was in flight when execution ownership was lost.`,
    };
    state.receipts.push({
      attempt: state.attempts,
      outcome: 'outcome_unknown',
      recordedAt: now.toISOString(),
    });
  }
  checkpoint.status = 'reconcile_required';
  return validateWorkflowGraphCheckpoint(asset, checkpoint);
}

async function registerWaitPlans(
  input: ExecuteWorkflowGraphInput,
  checkpointInput: WorkflowGraphCheckpoint,
  plans: WorkflowGraphWaitPlan[],
  ports: WorkflowGraphInterpreterPorts,
): Promise<WorkflowGraphCheckpoint> {
  if (plans.length === 0) return checkpointInput;
  const registrations = await Promise.all(
    plans.map(async (plan) => ({
      plan,
      registration: await ports.registerWait({
        binding: input.binding,
        asset: input.asset,
        plan,
        requestId: requestId(input.binding, plan.nodeId, plan.nextAttempt, 'wait'),
      }),
    })),
  );
  let checkpoint = checkpointInput;
  for (const { plan, registration } of registrations.sort((a, b) => a.plan.nodeId.localeCompare(b.plan.nodeId))) {
    if (
      plan.kind === 'wait_event' &&
      registration.correlationKey !== undefined &&
      registration.correlationKey !== plan.correlationKey
    )
      throw new Error('WORKFLOW_GRAPH_WAIT_REGISTRATION_CORRELATION_MISMATCH:' + plan.nodeId);
    checkpoint = registerWorkflowGraphWait(input.asset, checkpoint, plan.nodeId, {
      ...(plan.kind === 'wait_event' ? { correlationKey: registration.correlationKey ?? plan.correlationKey } : {}),
      ...(registration.requestRef ? { requestRef: registration.requestRef } : {}),
      registeredAt: registration.registeredAt,
      expiresAt: registration.expiresAt,
    });
  }
  await persist(ports, checkpoint);
  return checkpoint;
}

async function dispatchEffects(
  input: ExecuteWorkflowGraphInput,
  checkpointInput: WorkflowGraphCheckpoint,
  plans: WorkflowGraphEffectPlan[],
  ports: WorkflowGraphInterpreterPorts,
): Promise<WorkflowGraphCheckpoint> {
  if (plans.length === 0) return checkpointInput;
  let checkpoint = checkpointInput;
  for (const plan of plans) checkpoint = startWorkflowGraphNode(input.asset, checkpoint, plan.nodeId);
  await persist(ports, checkpoint);
  const settled = await Promise.all(
    plans.map(async (plan) => {
      try {
        return {
          plan,
          result: await ports.executeEffect({
            binding: input.binding,
            asset: input.asset,
            plan,
            requestId: requestId(input.binding, plan.nodeId, plan.nextAttempt, 'effect'),
          }),
        };
      } catch (error) {
        return {
          plan,
          result: {
            outcome: 'outcome_unknown' as const,
            error: {
              code: 'WORKFLOW_GRAPH_EFFECT_EXECUTION_INTERRUPTED',
              message: error instanceof Error ? error.message : String(error),
            },
          },
        };
      }
    }),
  );
  for (const { plan, result } of settled.sort((a, b) => a.plan.nodeId.localeCompare(b.plan.nodeId))) {
    const recordedAt = result.recordedAt ?? (ports.now?.() ?? new Date()).toISOString();
    if (result.outcome === 'succeeded') {
      checkpoint = completeWorkflowGraphNodeSuccess(
        input.asset,
        checkpoint,
        plan.nodeId,
        {
          ...(result.output ? { output: result.output } : {}),
          ...(result.receiptRef ? { receiptRef: result.receiptRef } : {}),
          recordedAt,
        },
        input.inputs ?? {},
      );
      continue;
    }
    const error = result.error ?? {
      code:
        result.outcome === 'outcome_unknown' ? 'WORKFLOW_GRAPH_EFFECT_OUTCOME_UNKNOWN' : 'WORKFLOW_GRAPH_EFFECT_FAILED',
      message: `Workflow node ${plan.nodeId} did not succeed.`,
    };
    checkpoint = completeWorkflowGraphNodeFailure(
      input.asset,
      checkpoint,
      plan.nodeId,
      {
        class: result.outcome === 'outcome_unknown' ? 'outcome_unknown' : (result.failureClass ?? 'failed'),
        code: error.code,
        message: error.message,
        recordedAt,
        ...(result.receiptRef ? { receiptRef: result.receiptRef } : {}),
      },
      ports.now?.() ?? new Date(recordedAt),
      input.inputs ?? {},
    );
  }
  await persist(ports, checkpoint);
  return checkpoint;
}

async function dispatchOneCompensation(
  input: ExecuteWorkflowGraphInput,
  checkpointInput: WorkflowGraphCheckpoint,
  plan: WorkflowGraphCompensationPlan,
  ports: WorkflowGraphInterpreterPorts,
): Promise<WorkflowGraphCheckpoint> {
  if (!ports.executeCompensation) throw new Error('WORKFLOW_GRAPH_COMPENSATION_EXECUTOR_NOT_CONNECTED');
  let checkpoint = startWorkflowGraphCompensation(input.asset, checkpointInput, plan.nodeId);
  await persist(ports, checkpoint);
  let result: WorkflowGraphEffectExecutionResult;
  try {
    result = await ports.executeCompensation({
      binding: input.binding,
      asset: input.asset,
      plan,
      requestId: requestId(input.binding, plan.nodeId, plan.nextAttempt, 'compensation'),
    });
  } catch (error) {
    result = {
      outcome: 'outcome_unknown',
      error: {
        code: 'WORKFLOW_GRAPH_COMPENSATION_EXECUTION_INTERRUPTED',
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
  const recordedAt = result.recordedAt ?? (ports.now?.() ?? new Date()).toISOString();
  checkpoint = completeWorkflowGraphCompensation(input.asset, checkpoint, plan.nodeId, {
    outcome: result.outcome,
    ...(result.receiptRef ? { receiptRef: result.receiptRef } : {}),
    recordedAt,
    ...(result.output ? { output: result.output } : {}),
    ...(result.error ? { error: result.error } : {}),
  });
  await persist(ports, checkpoint);
  return checkpoint;
}

/**
 * Execute Graph control flow through typed ports. Effects are checkpointed as running
 * before parallel dispatch. A resumed in-flight effect is fenced as reconcile_required,
 * never replayed blindly.
 */
export async function executeWorkflowGraph(
  input: ExecuteWorkflowGraphInput,
  ports: WorkflowGraphInterpreterPorts,
): Promise<WorkflowGraphCheckpoint> {
  const now = ports.now ?? (() => new Date());
  let checkpoint = input.checkpoint
    ? structuredClone(validateWorkflowGraphCheckpoint(input.asset, input.checkpoint))
    : createInitialWorkflowGraphCheckpoint(input.asset, input.binding);
  const recovered = recoverInterruptedEffects(input.asset, checkpoint, now());
  if (recovered) {
    await persist(ports, recovered);
    return recovered;
  }
  checkpoint = stabilizeWorkflowGraphCheckpoint(input.asset, checkpoint, input.inputs ?? {});
  await persist(ports, checkpoint);
  const limit = Math.max(1, Math.min(Math.trunc(input.transitionLimit ?? 256), 4096));
  for (let transition = 0; transition < limit; transition += 1) {
    if (checkpoint.status === 'failed' && input.asset.failurePolicy?.mode === 'compensate') {
      const compensating = beginWorkflowGraphCompensation(input.asset, checkpoint);
      if (compensating.status !== checkpoint.status) {
        checkpoint = compensating;
        await persist(ports, checkpoint);
      }
    }
    if (checkpoint.status === 'compensating') {
      const plan = planWorkflowGraphCompensation(input.asset, checkpoint, input.inputs ?? {});
      if (!plan) throw new Error('WORKFLOW_GRAPH_COMPENSATION_DEADLOCK');
      checkpoint = await dispatchOneCompensation(input, checkpoint, plan, ports);
      continue;
    }
    if (
      ['succeeded', 'compensated', 'failed', 'waiting', 'reconcile_required', 'cancelled'].includes(checkpoint.status)
    )
      return checkpoint;
    const batch = planWorkflowGraphDispatch(input.asset, checkpoint, input.inputs ?? {});
    checkpoint = batch.checkpoint;
    if (batch.plans.length === 0) throw new Error('WORKFLOW_GRAPH_RUNTIME_DEADLOCK');
    const waits = batch.plans.filter(
      (plan): plan is WorkflowGraphWaitPlan => plan.kind === 'wait_event' || plan.kind === 'approval',
    );
    const effects = batch.plans.filter(
      (plan): plan is WorkflowGraphEffectPlan =>
        plan.kind === 'capability' || plan.kind === 'script' || plan.kind === 'workflow',
    );
    checkpoint = await registerWaitPlans(input, checkpoint, waits, ports);
    checkpoint = await dispatchEffects(input, checkpoint, effects, ports);
  }
  throw new Error('WORKFLOW_GRAPH_RUNTIME_TRANSITION_LIMIT');
}
