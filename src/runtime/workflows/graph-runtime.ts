import { withControllerLockAsync } from '../../effects/controller-locks';
import type { WorkflowJsonValue } from '../../../packages/workflow-runtime/api/index';
import {
  executeWorkflowGraph,
  resolveWorkflowGraphWait,
  reconcileWorkflowGraphNodeEffect,
  reconcileWorkflowGraphCompensationEffect,
  resolveWorkflowGraphBinding,
  type WorkflowGraphCheckpoint,
  type WorkflowGraphEffectPlan,
  type WorkflowGraphCompensationPlan,
  type WorkflowGraphReconciliationBinding,
  type WorkflowGraphWaitPlan,
} from '../../../packages/workflow-runtime/api/index';
import { readAuthorizationRequest, requestExplicitAuthorization } from '../control-plane/governance/authorization';
import { readWorkflowExecutableContentFile } from '../control-plane/persistence/workflow-content-store';
import { readWorkflowRegistryEntry } from '../control-plane/persistence/workflow-registry-store';
import {
  readWorkflowGraphRun,
  workflowInputDigest,
  writeWorkflowGraphRunCheckpoint,
} from '../control-plane/persistence/workflow-run-store';
import {
  executeWorkflowCapabilityEffect,
  executeWorkflowScriptEffect,
  type WorkflowEffectRuntimeDependencies,
} from './effect-runtime';
import { assertWorkflowExecutionScope, type ExecuteRegisteredWorkflowInput } from './runtime';

export interface WorkflowGraphRuntimeChildResult {
  workflowId: string;
  status: string;
  [key: string]: unknown;
}

export interface WorkflowGraphRuntimeDependencies extends WorkflowEffectRuntimeDependencies {
  executeChild?: (
    input: ExecuteRegisteredWorkflowInput & { origin?: { kind: 'workflow'; id: string } },
  ) => Promise<WorkflowGraphRuntimeChildResult>;
  now?: () => Date;
}

function childRunId(
  parentRunId: string,
  nodeId: string,
  attempt: number,
  phase: 'forward' | 'compensation' = 'forward',
): string {
  return `${parentRunId}:${phase === 'forward' ? 'child' : 'compensation'}:${nodeId}:${attempt}`;
}

function childOutput(result: WorkflowGraphRuntimeChildResult): Record<string, unknown> {
  return structuredClone(result) as Record<string, unknown>;
}

export async function executeRegisteredWorkflowGraph(
  input: ExecuteRegisteredWorkflowInput,
  dependencies: WorkflowGraphRuntimeDependencies = {},
): Promise<WorkflowGraphCheckpoint> {
  assertWorkflowExecutionScope(input);
  return withControllerLockAsync(
    input.controllerHome,
    { scope: 'task', repoId: input.repository.repoId, taskId: `workflow:${input.scopeId}` },
    `workflow-graph:${input.runId}`,
    async () => {
      const registry = readWorkflowRegistryEntry(input.controllerHome, input.registryScope, input.workflowId);
      if (!registry) throw new Error(`WORKFLOW_REGISTRY_ENTRY_REQUIRED: ${input.workflowId}`);
      if (registry.value.status !== 'active')
        throw new Error(`WORKFLOW_REGISTRY_ENTRY_NOT_ACTIVE: ${input.workflowId}`);
      if ((registry.value.engine ?? 'sequence_v1') !== 'graph_v2') throw new Error('WORKFLOW_GRAPH_ENGINE_REQUIRED');
      const asset = readWorkflowExecutableContentFile(registry.value.contentLocation.path);
      if (asset.schemaVersion !== 2) throw new Error('WORKFLOW_GRAPH_CONTENT_REQUIRED');
      if (
        asset.workflowId !== registry.value.workflowId ||
        asset.version !== registry.value.version ||
        asset.contentDigest !== registry.value.contentDigest
      ) {
        throw new Error('WORKFLOW_REGISTRY_CONTENT_IDENTITY_MISMATCH:' + input.workflowId);
      }
      const existing = readWorkflowGraphRun(input.controllerHome, input.scopeId, input.runId);
      const inputDigest = workflowInputDigest(input.inputs);
      if (existing) {
        if (
          existing.value.workflowId !== asset.workflowId ||
          existing.value.version !== asset.version ||
          existing.value.contentDigest !== asset.contentDigest ||
          existing.value.inputDigest !== inputDigest
        ) {
          throw new Error('WORKFLOW_RUN_IDENTITY_CONFLICT');
        }
        if (existing.value.status === 'succeeded') throw new Error('WORKFLOW_RUN_ALREADY_SUCCEEDED');
        if (existing.value.status === 'compensated') throw new Error('WORKFLOW_RUN_ALREADY_COMPENSATED');
        if (
          (existing.value.status === 'failed' && asset.failurePolicy?.mode !== 'compensate') ||
          existing.value.status === 'cancelled'
        )
          throw new Error('WORKFLOW_RUN_FAILED_RESTART_REQUIRES_NEW_RUN_ID');
        if (existing.value.status === 'reconcile_required') throw new Error('WORKFLOW_RUN_RECONCILIATION_REQUIRED');
      }
      let revision = existing?.revision;
      let resumedCheckpoint = existing
        ? {
            schemaVersion: 2 as const,
            binding: { scopeId: existing.value.scopeId, runId: existing.value.runId },
            workflowId: existing.value.workflowId,
            version: existing.value.version,
            contentDigest: existing.value.contentDigest,
            status: existing.value.status,
            nodes: structuredClone(existing.value.nodes),
            edges: structuredClone(existing.value.edges),
          }
        : undefined;
      if (resumedCheckpoint?.status === 'waiting') {
        const resolved = resolveApprovedWorkflowWaits(input, asset, resumedCheckpoint);
        if (resolved !== resumedCheckpoint) {
          const stored = writeWorkflowGraphRunCheckpoint({
            controllerHome: input.controllerHome,
            checkpoint: resolved,
            inputs: input.inputs,
            execution: {
              repositoryId: input.repository.repoId,
              checkoutId: input.repository.activeCheckoutId,
              registryScope: input.registryScope,
            },
            expectedRevision: revision ?? null,
            ...(dependencies.now ? { now: dependencies.now() } : {}),
          });
          revision = stored.revision;
          resumedCheckpoint = resolved;
        }
      }
      const context = {
        controllerHome: input.controllerHome,
        repository: input.repository,
        executionIdentity: input.executionIdentity,
        runId: input.runId,
        timeoutMs: input.timeoutMs,
        registry: registry.value,
      };
      return executeWorkflowGraph(
        {
          asset,
          binding: { scopeId: input.scopeId, runId: input.runId },
          inputs: input.inputs,
          checkpoint: resumedCheckpoint,
        },
        {
          now: dependencies.now,
          checkpoint: (checkpoint) => {
            const stored = writeWorkflowGraphRunCheckpoint({
              controllerHome: input.controllerHome,
              checkpoint,
              inputs: input.inputs,
              execution: {
                repositoryId: input.repository.repoId,
                checkoutId: input.repository.activeCheckoutId,
                registryScope: input.registryScope,
                ...(input.approvalContext ? { approvalContext: input.approvalContext } : {}),
              },
              expectedRevision: revision ?? null,
              ...(dependencies.now ? { now: dependencies.now() } : {}),
            });
            revision = stored.revision;
          },
          executeEffect: async ({ plan, requestId }) => {
            if (plan.kind === 'capability') {
              return executeWorkflowCapabilityEffect({
                context,
                capabilityId: plan.capabilityId,
                arguments: plan.input,
                requestId,
                idempotency: plan.idempotency,
                dependencies,
              });
            }
            if (plan.kind === 'script') {
              const script = asset.scripts?.[plan.scriptRef];
              if (!script) throw new Error('WORKFLOW_GRAPH_SCRIPT_REF_MISSING:' + plan.scriptRef);
              return executeWorkflowScriptEffect({
                context,
                script,
                arguments: plan.input,
                requestId,
                dependencies,
              });
            }
            return executeChildWorkflow(input, plan, dependencies);
          },
          executeCompensation: async ({ plan, requestId }) =>
            executeGraphCompensation(input, asset, plan, requestId, context, dependencies),
          registerWait: async ({ plan, requestId }) =>
            registerGraphWait(input, asset, plan, requestId, dependencies.now?.() ?? new Date()),
        },
      );
    },
    undefined,
    0,
  );
}

async function executeChildWorkflow(
  parent: ExecuteRegisteredWorkflowInput,
  plan: Extract<WorkflowGraphEffectPlan | WorkflowGraphCompensationPlan, { kind: 'workflow' }>,
  dependencies: WorkflowGraphRuntimeDependencies,
) {
  if (!dependencies.executeChild) throw new Error('WORKFLOW_GRAPH_CHILD_RUNTIME_NOT_CONNECTED');
  const runId = childRunId(
    parent.runId,
    plan.nodeId,
    plan.nextAttempt,
    'phase' in plan && plan.phase === 'compensation' ? 'compensation' : 'forward',
  );
  const result = await dependencies.executeChild({
    ...parent,
    scopeId: `repository:${parent.repository.repoId}:checkout:${parent.repository.activeCheckoutId}:workflow:${plan.workflowId}`,
    runId,
    workflowId: plan.workflowId,
    inputs: plan.input,
    origin: { kind: 'workflow', id: `${parent.workflowId}:${parent.runId}:${plan.nodeId}` },
  });
  if (result.status !== 'succeeded') {
    return {
      outcome: result.status === 'reconcile_required' ? ('outcome_unknown' as const) : ('failed' as const),
      receiptRef: runId,
      error: {
        code: 'WORKFLOW_GRAPH_CHILD_NOT_SUCCEEDED',
        message: `Child Workflow ${plan.workflowId} ended with status ${result.status}.`,
      },
    };
  }
  return { outcome: 'succeeded' as const, receiptRef: runId, output: childOutput(result) };
}

async function executeGraphCompensation(
  parent: ExecuteRegisteredWorkflowInput,
  asset: Extract<ReturnType<typeof readWorkflowExecutableContentFile>, { schemaVersion: 2 }>,
  plan: WorkflowGraphCompensationPlan,
  requestId: string,
  context: Parameters<typeof executeWorkflowCapabilityEffect>[0]['context'],
  dependencies: WorkflowGraphRuntimeDependencies,
) {
  if (plan.kind === 'capability') {
    return executeWorkflowCapabilityEffect({
      context,
      capabilityId: plan.capabilityId,
      arguments: plan.input,
      requestId,
      idempotency: plan.idempotency,
      dependencies,
    });
  }
  if (plan.kind === 'script') {
    const script = asset.scripts?.[plan.scriptRef];
    if (!script) throw new Error('WORKFLOW_GRAPH_COMPENSATION_SCRIPT_REF_MISSING:' + plan.scriptRef);
    return executeWorkflowScriptEffect({ context, script, arguments: plan.input, requestId, dependencies });
  }
  return executeChildWorkflow(parent, plan, dependencies);
}

function approvalCommand(
  input: ExecuteRegisteredWorkflowInput,
  plan: Extract<WorkflowGraphWaitPlan, { kind: 'approval' }>,
): string[] {
  return ['workflow-approval', input.scopeId, input.runId, plan.nodeId, plan.approvalKey];
}

function resolveApprovedWorkflowWaits(
  input: ExecuteRegisteredWorkflowInput,
  asset: Extract<ReturnType<typeof readWorkflowExecutableContentFile>, { schemaVersion: 2 }>,
  checkpointInput: WorkflowGraphCheckpoint,
): WorkflowGraphCheckpoint {
  let checkpoint = checkpointInput;
  for (const state of checkpoint.nodes) {
    if (state.status !== 'waiting' || state.wait?.kind !== 'approval' || !state.wait.requestRef) continue;
    const definition = asset.nodes.find((node) => node.nodeId === state.nodeId);
    if (!definition || definition.kind !== 'approval') throw new Error('WORKFLOW_GRAPH_APPROVAL_NODE_MISMATCH');
    const request = readAuthorizationRequest(input.controllerHome, input.repository.repoId, state.wait.requestRef);
    if (request.status !== 'resolved') continue;
    const expectedCommand = ['workflow-approval', input.scopeId, input.runId, state.nodeId, definition.approvalKey];
    if (JSON.stringify(request.command) !== JSON.stringify(expectedCommand))
      throw new Error('WORKFLOW_GRAPH_APPROVAL_REQUEST_IDENTITY_MISMATCH');
    checkpoint = resolveWorkflowGraphWait(
      asset,
      checkpoint,
      state.nodeId,
      {
        approved: true,
        receiptRef: request.approvalRequestId,
        recordedAt: request.resolvedAt ?? request.createdAt,
      },
      input.inputs ?? {},
    );
  }
  return checkpoint;
}

function registerGraphWait(
  input: ExecuteRegisteredWorkflowInput,
  asset: Extract<ReturnType<typeof readWorkflowExecutableContentFile>, { schemaVersion: 2 }>,
  plan: WorkflowGraphWaitPlan,
  requestId: string,
  now: Date,
) {
  const node = asset.nodes.find((entry) => entry.nodeId === plan.nodeId);
  if (!node || node.timeoutMs === undefined) throw new Error('WORKFLOW_GRAPH_WAIT_TIMEOUT_REQUIRED:' + plan.nodeId);
  if (plan.kind === 'approval') {
    if (!input.approvalContext) throw new Error('WORKFLOW_GRAPH_APPROVAL_CONTEXT_REQUIRED');
    const request = requestExplicitAuthorization({
      controllerHome: input.controllerHome,
      repositoryId: input.repository.repoId,
      requestKey: requestId,
      sessionId: input.approvalContext.sessionId,
      principalId: input.approvalContext.principalId,
      permissionSnapshotVersion: input.approvalContext.permissionSnapshotVersion,
      risk: 'workspace_write',
      humanSummary: plan.prompt,
      consequences: [
        `Workflow approval gate: ${plan.approvalKey}`,
        `Workflow: ${input.workflowId}`,
        `Run: ${input.runId}`,
      ],
      command: approvalCommand(input, plan),
    });
    return {
      registeredAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + node.timeoutMs).toISOString(),
      requestRef: request.approvalRequestId,
    };
  }
  return {
    registeredAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + node.timeoutMs).toISOString(),
    correlationKey: plan.correlationKey,
  };
}

function graphEffectRequestId(
  scopeId: string,
  runId: string,
  nodeId: string,
  attempt: number,
  phase: 'effect' | 'compensation',
): string {
  return `workflow-graph:${scopeId}:${runId}:${nodeId}:${attempt}:${phase}`;
}

function graphReconciliationRequestId(
  scopeId: string,
  runId: string,
  nodeId: string,
  attempt: number,
  phase: 'effect' | 'compensation',
): string {
  return `workflow-graph-reconcile:${scopeId}:${runId}:${nodeId}:${attempt}:${phase}`;
}

function resolveGraphReconciliationArguments(
  mapping: Record<string, WorkflowGraphReconciliationBinding> | undefined,
  inputs: Record<string, WorkflowJsonValue>,
  checkpoint: WorkflowGraphCheckpoint,
  effectRequestId: string,
): Record<string, WorkflowJsonValue> {
  const effective = mapping ?? { effectRequestId: { kind: 'effect_request_id' as const } };
  return Object.fromEntries(
    Object.entries(effective).map(([key, binding]) => {
      if (binding.kind === 'effect_request_id') return [key, effectRequestId];
      const value = resolveWorkflowGraphBinding(binding, inputs, checkpoint);
      if (value === undefined) throw new Error(`WORKFLOW_GRAPH_RECONCILIATION_INPUT_UNRESOLVED:${key}`);
      return [key, structuredClone(value)];
    }),
  );
}

function parseGraphReconciliationObservation(
  expectedEffectRequestId: string,
  result: Awaited<ReturnType<typeof executeWorkflowCapabilityEffect>>,
): { outcome: 'applied' | 'not_applied'; receiptRef: string; output?: Record<string, unknown> } {
  if (result.outcome !== 'succeeded' || !result.receiptRef || !result.output)
    throw new Error('WORKFLOW_GRAPH_RECONCILIATION_OBSERVATION_FAILED');
  if (result.output.effectRequestId !== expectedEffectRequestId)
    throw new Error('WORKFLOW_GRAPH_RECONCILIATION_EFFECT_ID_MISMATCH');
  const outcome = result.output.outcome;
  if (outcome !== 'applied' && outcome !== 'not_applied')
    throw new Error('WORKFLOW_GRAPH_RECONCILIATION_OUTCOME_INVALID');
  const observedOutput = result.output.output;
  if (
    observedOutput !== undefined &&
    (!observedOutput || typeof observedOutput !== 'object' || Array.isArray(observedOutput))
  )
    throw new Error('WORKFLOW_GRAPH_RECONCILIATION_OUTPUT_INVALID');
  return {
    outcome,
    receiptRef: result.receiptRef,
    ...(observedOutput ? { output: observedOutput as Record<string, unknown> } : {}),
  };
}

export async function observeAndReconcileRegisteredWorkflowGraph(
  input: ExecuteRegisteredWorkflowInput & { reconciliationRequestId?: string },
  dependencies: WorkflowGraphRuntimeDependencies = {},
): Promise<WorkflowGraphCheckpoint> {
  assertWorkflowExecutionScope(input);
  const registry = readWorkflowRegistryEntry(input.controllerHome, input.registryScope, input.workflowId);
  if (!registry || registry.value.status !== 'active')
    throw new Error('WORKFLOW_REGISTRY_ENTRY_NOT_ACTIVE:' + input.workflowId);
  const asset = readWorkflowExecutableContentFile(registry.value.contentLocation.path);
  if (asset.schemaVersion !== 2) throw new Error('WORKFLOW_GRAPH_CONTENT_REQUIRED');
  const stored = readWorkflowGraphRun(input.controllerHome, input.scopeId, input.runId);
  if (!stored || stored.value.status !== 'reconcile_required') throw new Error('WORKFLOW_RUN_RECONCILIATION_REQUIRED');
  if (
    stored.value.workflowId !== asset.workflowId ||
    stored.value.version !== asset.version ||
    stored.value.contentDigest !== asset.contentDigest ||
    stored.value.inputDigest !== workflowInputDigest(input.inputs)
  )
    throw new Error('WORKFLOW_RUN_IDENTITY_CONFLICT');
  const storedValue = stored.value;
  const storedRevision = stored.revision;
  const checkpoint: WorkflowGraphCheckpoint = {
    schemaVersion: 2,
    binding: { scopeId: stored.value.scopeId, runId: stored.value.runId },
    workflowId: stored.value.workflowId,
    version: stored.value.version,
    contentDigest: stored.value.contentDigest,
    status: stored.value.status,
    nodes: structuredClone(stored.value.nodes),
    edges: structuredClone(stored.value.edges),
  };
  const targets: Array<{
    phase: 'effect' | 'compensation';
    state: WorkflowGraphCheckpoint['nodes'][number];
  }> = [];
  for (const state of checkpoint.nodes) {
    if (state.status === 'reconcile_required') targets.push({ phase: 'effect', state });
    if (state.compensation?.status === 'reconcile_required') targets.push({ phase: 'compensation', state });
  }
  if (targets.length !== 1) throw new Error('WORKFLOW_GRAPH_RECONCILIATION_TARGET_AMBIGUOUS');
  const target = targets[0]!;
  const definition = asset.nodes.find((node) => node.nodeId === target.state.nodeId);
  if (!definition) throw new Error('WORKFLOW_GRAPH_RECONCILIATION_NODE_NOT_FOUND');
  let capabilityId: string | undefined;
  let mapping: Record<string, WorkflowGraphReconciliationBinding> | undefined;
  let attempt = target.state.attempts;
  if (target.phase === 'effect') {
    if (definition.kind !== 'capability' || !definition.reconcileWithCapabilityId)
      throw new Error('WORKFLOW_GRAPH_RECONCILIATION_CAPABILITY_REQUIRED');
    capabilityId = definition.reconcileWithCapabilityId;
    mapping = definition.reconciliationInput;
  } else {
    const compensation =
      definition.kind === 'capability' || definition.kind === 'script' || definition.kind === 'workflow'
        ? definition.compensation
        : undefined;
    if (compensation?.kind !== 'capability' || !compensation.reconcileWithCapabilityId || !target.state.compensation)
      throw new Error('WORKFLOW_GRAPH_COMPENSATION_RECONCILIATION_CAPABILITY_REQUIRED');
    capabilityId = compensation.reconcileWithCapabilityId;
    mapping = compensation.reconciliationInput;
    attempt = target.state.compensation.attempts;
  }
  const effectRequestId = graphEffectRequestId(input.scopeId, input.runId, target.state.nodeId, attempt, target.phase);
  const reconciliationRequestId =
    input.reconciliationRequestId ??
    graphReconciliationRequestId(input.scopeId, input.runId, target.state.nodeId, attempt, target.phase);
  const context = {
    controllerHome: input.controllerHome,
    repository: input.repository,
    executionIdentity: input.executionIdentity,
    runId: input.runId,
    timeoutMs: input.timeoutMs,
    registry: registry.value,
  };
  const observed = await executeWorkflowCapabilityEffect({
    context,
    capabilityId,
    arguments: resolveGraphReconciliationArguments(mapping, storedValue.inputs, checkpoint, effectRequestId),
    requestId: reconciliationRequestId,
    idempotency: 'idempotent',
    dependencies,
  });
  const observation = parseGraphReconciliationObservation(effectRequestId, observed);
  const recordedAt = (dependencies.now?.() ?? new Date()).toISOString();
  const resolved =
    target.phase === 'effect'
      ? reconcileWorkflowGraphNodeEffect(
          asset,
          checkpoint,
          target.state.nodeId,
          { ...observation, recordedAt },
          storedValue.inputs,
        )
      : reconcileWorkflowGraphCompensationEffect(asset, checkpoint, target.state.nodeId, {
          ...observation,
          recordedAt,
        });
  writeWorkflowGraphRunCheckpoint({
    controllerHome: input.controllerHome,
    checkpoint: resolved,
    inputs: storedValue.inputs,
    execution: storedValue.execution,
    expectedRevision: storedRevision,
    now: dependencies.now?.() ?? new Date(recordedAt),
  });
  if (
    resolved.status === 'running' ||
    resolved.status === 'compensating' ||
    (resolved.status === 'failed' && asset.failurePolicy?.mode === 'compensate')
  ) {
    return executeRegisteredWorkflowGraph({ ...input, inputs: storedValue.inputs }, dependencies);
  }
  return resolved;
}
