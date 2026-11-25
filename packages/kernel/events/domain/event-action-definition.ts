import type { EventRuleJson } from './event-rule';

export type EventActionRisk = 'read' | 'workspace_write' | 'external_write' | 'destructive';
export type EventActionInputType = 'string' | 'number' | 'boolean' | 'json';

export interface EventActionInputContract {
  type: EventActionInputType;
  required?: boolean;
  default?: EventRuleJson;
}

export type EventActionHandlerV1 =
  | {
      kind: 'workflow';
      workflowId: string;
      registryScope: { kind: 'controller' } | { kind: 'project'; projectId: string };
    }
  | { kind: 'capability'; capabilityId: string }
  | {
      kind: 'model';
      modelProfileId: string;
      instructionTemplateId?: string;
      outputSchemaId?: string;
    }
  | { kind: 'emit_event'; source: string; eventType: string };

export interface EventActionDefinitionV1 {
  schemaVersion: 1;
  actionRef: string;
  revision: number;
  enabled: boolean;
  title?: string;
  description?: string;
  handler: EventActionHandlerV1;
  inputContract?: Record<string, EventActionInputContract>;
  authorization: {
    risk: EventActionRisk;
    requiresApproval: boolean;
  };
}

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const TYPES = new Set<EventActionInputType>(['string', 'number', 'boolean', 'json']);
const RISKS = new Set<EventActionRisk>(['read', 'workspace_write', 'external_write', 'destructive']);

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function exact(value: Record<string, unknown>, keys: readonly string[], code: string): void {
  if (Object.keys(value).some((key) => !keys.includes(key))) throw new Error(code);
}
function id(value: unknown, code: string): string {
  if (typeof value !== 'string' || !ID.test(value)) throw new Error(code);
  return value;
}
function optionalText(value: unknown, code: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !value.trim() || value.length > 2000) throw new Error(code);
  return value;
}

function validateWorkflowHandler(value: Record<string, unknown>): EventActionHandlerV1 {
  exact(value, ['kind', 'workflowId', 'registryScope'], 'EVENT_ACTION_HANDLER_FIELD_UNSUPPORTED');
  const workflowId = id(value.workflowId, 'EVENT_ACTION_WORKFLOW_ID_INVALID');
  if (!record(value.registryScope) || typeof value.registryScope.kind !== 'string')
    throw new Error('EVENT_ACTION_WORKFLOW_SCOPE_INVALID');
  if (value.registryScope.kind === 'controller') {
    exact(value.registryScope, ['kind'], 'EVENT_ACTION_WORKFLOW_SCOPE_FIELD_UNSUPPORTED');
    return { kind: 'workflow', workflowId, registryScope: { kind: 'controller' } };
  }
  if (value.registryScope.kind !== 'project') throw new Error('EVENT_ACTION_WORKFLOW_SCOPE_INVALID');
  exact(value.registryScope, ['kind', 'projectId'], 'EVENT_ACTION_WORKFLOW_SCOPE_FIELD_UNSUPPORTED');
  return {
    kind: 'workflow',
    workflowId,
    registryScope: { kind: 'project', projectId: id(value.registryScope.projectId, 'EVENT_ACTION_PROJECT_ID_INVALID') },
  };
}

function validateModelHandler(value: Record<string, unknown>): EventActionHandlerV1 {
  exact(
    value,
    ['kind', 'modelProfileId', 'instructionTemplateId', 'outputSchemaId'],
    'EVENT_ACTION_HANDLER_FIELD_UNSUPPORTED',
  );
  const modelProfileId = id(value.modelProfileId, 'EVENT_ACTION_MODEL_PROFILE_INVALID');
  const instructionTemplateId =
    value.instructionTemplateId === undefined
      ? undefined
      : id(value.instructionTemplateId, 'EVENT_ACTION_INSTRUCTION_TEMPLATE_INVALID');
  const outputSchemaId =
    value.outputSchemaId === undefined ? undefined : id(value.outputSchemaId, 'EVENT_ACTION_OUTPUT_SCHEMA_INVALID');
  return {
    kind: 'model',
    modelProfileId,
    ...(instructionTemplateId ? { instructionTemplateId } : {}),
    ...(outputSchemaId ? { outputSchemaId } : {}),
  };
}

function validateHandler(value: unknown): EventActionHandlerV1 {
  if (!record(value) || typeof value.kind !== 'string') throw new Error('EVENT_ACTION_HANDLER_INVALID');
  if (value.kind === 'workflow') return validateWorkflowHandler(value);
  if (value.kind === 'capability') {
    exact(value, ['kind', 'capabilityId'], 'EVENT_ACTION_HANDLER_FIELD_UNSUPPORTED');
    return { kind: 'capability', capabilityId: id(value.capabilityId, 'EVENT_ACTION_CAPABILITY_ID_INVALID') };
  }
  if (value.kind === 'model') return validateModelHandler(value);
  if (value.kind === 'emit_event') {
    exact(value, ['kind', 'source', 'eventType'], 'EVENT_ACTION_HANDLER_FIELD_UNSUPPORTED');
    return {
      kind: 'emit_event',
      source: id(value.source, 'EVENT_ACTION_EMIT_SOURCE_INVALID'),
      eventType: id(value.eventType, 'EVENT_ACTION_EMIT_TYPE_INVALID'),
    };
  }
  throw new Error('EVENT_ACTION_HANDLER_KIND_INVALID');
}

function validateInputSpec(key: string, raw: unknown): EventActionInputContract {
  if (!ID.test(key) || !record(raw)) throw new Error('EVENT_ACTION_INPUT_CONTRACT_INVALID');
  exact(raw, ['type', 'required', 'default'], 'EVENT_ACTION_INPUT_CONTRACT_FIELD_UNSUPPORTED');
  if (typeof raw.type !== 'string' || !TYPES.has(raw.type as EventActionInputType))
    throw new Error('EVENT_ACTION_INPUT_TYPE_INVALID');
  if (raw.required !== undefined && typeof raw.required !== 'boolean')
    throw new Error('EVENT_ACTION_INPUT_REQUIRED_INVALID');
  if (raw.required === true && raw.default !== undefined) throw new Error('EVENT_ACTION_REQUIRED_DEFAULT_CONFLICT');
  if (raw.default !== undefined) validateEventActionInputValue(raw.type as EventActionInputType, raw.default, key);
  return {
    type: raw.type as EventActionInputType,
    ...(raw.required === undefined ? {} : { required: raw.required }),
    ...(raw.default === undefined ? {} : { default: structuredClone(raw.default as EventRuleJson) }),
  };
}

function validateInputContract(value: unknown): Record<string, EventActionInputContract> | undefined {
  if (value === undefined) return undefined;
  if (!record(value) || Object.keys(value).length > 64) throw new Error('EVENT_ACTION_INPUT_CONTRACT_INVALID');
  return Object.fromEntries(Object.entries(value).map(([key, raw]) => [key, validateInputSpec(key, raw)]));
}

function validateEventActionInputValue(type: EventActionInputType, value: unknown, key: string): void {
  if (type === 'json') {
    try {
      JSON.stringify(value);
    } catch {
      throw new Error('EVENT_ACTION_INPUT_VALUE_INVALID:' + key);
    }
    if (value === undefined || typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint')
      throw new Error('EVENT_ACTION_INPUT_VALUE_INVALID:' + key);
    return;
  }
  if (type === 'number' && typeof value === 'number' && Number.isFinite(value)) return;
  if (type === 'string' && typeof value === 'string') return;
  if (type === 'boolean' && typeof value === 'boolean') return;
  throw new Error('EVENT_ACTION_INPUT_VALUE_INVALID:' + key);
}

export function validateEventActionDefinitionV1(value: unknown): EventActionDefinitionV1 {
  if (!record(value)) throw new Error('EVENT_ACTION_DEFINITION_INVALID');
  exact(
    value,
    [
      'schemaVersion',
      'actionRef',
      'revision',
      'enabled',
      'title',
      'description',
      'handler',
      'inputContract',
      'authorization',
    ],
    'EVENT_ACTION_DEFINITION_FIELD_UNSUPPORTED',
  );
  if (value.schemaVersion !== 1) throw new Error('EVENT_ACTION_SCHEMA_VERSION_UNSUPPORTED');
  const actionRef = id(value.actionRef, 'EVENT_ACTION_REF_INVALID');
  if (!Number.isSafeInteger(value.revision) || Number(value.revision) < 1)
    throw new Error('EVENT_ACTION_REVISION_INVALID');
  if (typeof value.enabled !== 'boolean') throw new Error('EVENT_ACTION_ENABLED_INVALID');
  if (!record(value.authorization)) throw new Error('EVENT_ACTION_AUTHORIZATION_INVALID');
  exact(value.authorization, ['risk', 'requiresApproval'], 'EVENT_ACTION_AUTHORIZATION_FIELD_UNSUPPORTED');
  if (typeof value.authorization.risk !== 'string' || !RISKS.has(value.authorization.risk as EventActionRisk))
    throw new Error('EVENT_ACTION_RISK_INVALID');
  if (typeof value.authorization.requiresApproval !== 'boolean') throw new Error('EVENT_ACTION_APPROVAL_INVALID');
  if (
    (value.authorization.risk === 'external_write' || value.authorization.risk === 'destructive') &&
    !value.authorization.requiresApproval
  )
    throw new Error('EVENT_ACTION_SENSITIVE_APPROVAL_REQUIRED');
  const title = optionalText(value.title, 'EVENT_ACTION_TITLE_INVALID');
  const description = optionalText(value.description, 'EVENT_ACTION_DESCRIPTION_INVALID');
  const inputContract = validateInputContract(value.inputContract);
  return {
    schemaVersion: 1,
    actionRef,
    revision: Number(value.revision),
    enabled: value.enabled,
    ...(title ? { title } : {}),
    ...(description ? { description } : {}),
    handler: validateHandler(value.handler),
    ...(inputContract ? { inputContract } : {}),
    authorization: {
      risk: value.authorization.risk as EventActionRisk,
      requiresApproval: value.authorization.requiresApproval,
    },
  };
}

export function validateEventActionInputs(
  definitionInput: EventActionDefinitionV1,
  provided: Record<string, EventRuleJson> = {},
): Record<string, EventRuleJson> {
  const definition = validateEventActionDefinitionV1(definitionInput);
  const contract = definition.inputContract ?? {};
  const unknown = Object.keys(provided).filter((key) => !Object.hasOwn(contract, key));
  if (unknown.length > 0) throw new Error('EVENT_ACTION_INPUT_UNKNOWN:' + unknown.sort().join(','));
  const resolved: Record<string, EventRuleJson> = {};
  for (const [key, spec] of Object.entries(contract)) {
    const value = Object.hasOwn(provided, key) ? provided[key] : spec.default;
    if (value === undefined) {
      if (spec.required) throw new Error('EVENT_ACTION_INPUT_REQUIRED:' + key);
      continue;
    }
    validateEventActionInputValue(spec.type, value, key);
    resolved[key] = structuredClone(value);
  }
  return resolved;
}
