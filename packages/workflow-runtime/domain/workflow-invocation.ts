import type { WorkflowJsonValue } from './workflow-asset';

export type WorkflowInvocationOriginKind =
  | 'user'
  | 'event'
  | 'schedule'
  | 'model'
  | 'plugin'
  | 'skill'
  | 'workflow'
  | 'system';

export interface WorkflowInvocationOriginV1 {
  kind: WorkflowInvocationOriginKind;
  id?: string;
}

export interface WorkflowInvocationIntentV1 {
  schemaVersion: 1;
  workflowId: string;
  registryScope: { kind: 'controller' } | { kind: 'project'; projectId: string };
  origin: WorkflowInvocationOriginV1;
  inputs: Record<string, WorkflowJsonValue>;
  binding: {
    scopeId: string;
    runId: string;
  };
}

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/;
const ORIGINS = new Set<WorkflowInvocationOriginKind>([
  'user',
  'event',
  'schedule',
  'model',
  'plugin',
  'skill',
  'workflow',
  'system',
]);

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function id(value: unknown, code: string, max = 191): string {
  if (typeof value !== 'string' || value.length > max || !ID.test(value)) throw new Error(code);
  return value;
}

function assertJson(value: unknown, depth = 0): void {
  if (depth > 32) throw new Error('WORKFLOW_INVOCATION_JSON_DEPTH_LIMIT');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (Array.isArray(value)) {
    for (const item of value) assertJson(item, depth + 1);
    return;
  }
  if (!record(value)) throw new Error('WORKFLOW_INVOCATION_JSON_INVALID');
  for (const [key, entry] of Object.entries(value)) {
    id(key, 'WORKFLOW_INVOCATION_INPUT_KEY_INVALID', 128);
    assertJson(entry, depth + 1);
  }
}

export function validateWorkflowInvocationIntent(value: unknown): WorkflowInvocationIntentV1 {
  if (!record(value)) throw new Error('WORKFLOW_INVOCATION_INVALID');
  if (value.schemaVersion !== 1) throw new Error('WORKFLOW_INVOCATION_SCHEMA_VERSION_UNSUPPORTED');
  const workflowId = id(value.workflowId, 'WORKFLOW_INVOCATION_WORKFLOW_ID_INVALID', 128);
  if (!record(value.registryScope) || typeof value.registryScope.kind !== 'string')
    throw new Error('WORKFLOW_INVOCATION_REGISTRY_SCOPE_INVALID');
  let registryScope: WorkflowInvocationIntentV1['registryScope'];
  if (value.registryScope.kind === 'controller') {
    registryScope = { kind: 'controller' };
  } else if (value.registryScope.kind === 'project') {
    registryScope = {
      kind: 'project',
      projectId: id(value.registryScope.projectId, 'WORKFLOW_INVOCATION_PROJECT_ID_INVALID', 128),
    };
  } else {
    throw new Error('WORKFLOW_INVOCATION_REGISTRY_SCOPE_INVALID');
  }
  if (
    !record(value.origin) ||
    typeof value.origin.kind !== 'string' ||
    !ORIGINS.has(value.origin.kind as WorkflowInvocationOriginKind)
  )
    throw new Error('WORKFLOW_INVOCATION_ORIGIN_INVALID');
  const origin: WorkflowInvocationOriginV1 = {
    kind: value.origin.kind as WorkflowInvocationOriginKind,
    ...(value.origin.id === undefined ? {} : { id: id(value.origin.id, 'WORKFLOW_INVOCATION_ORIGIN_ID_INVALID') }),
  };
  if (!record(value.inputs)) throw new Error('WORKFLOW_INVOCATION_INPUTS_INVALID');
  assertJson(value.inputs);
  if (!record(value.binding)) throw new Error('WORKFLOW_INVOCATION_BINDING_INVALID');
  const binding = {
    scopeId: id(value.binding.scopeId, 'WORKFLOW_INVOCATION_SCOPE_ID_INVALID'),
    runId: id(value.binding.runId, 'WORKFLOW_INVOCATION_RUN_ID_INVALID'),
  };
  return {
    schemaVersion: 1,
    workflowId,
    registryScope,
    origin,
    inputs: structuredClone(value.inputs) as WorkflowInvocationIntentV1['inputs'],
    binding,
  };
}
