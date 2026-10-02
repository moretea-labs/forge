import { isDeepStrictEqual } from 'node:util';
import { AUTOMATION_RECEIPT_CAPABILITY_PREFIX } from './automation-receipt-adapter';

export type RhWorkInputCompatibilityResult =
  | {
      ok: true;
      args: Record<string, unknown>;
      operation: string;
      scheduleIdOverride?: string;
      requirementOperationArgs?: Record<string, unknown>;
    }
  | { ok: false; summary: string; data: Record<string, unknown> };

function failure(summary: string, data: Record<string, unknown> = {}): RhWorkInputCompatibilityResult {
  return { ok: false, summary, data };
}

const FROZEN_SEMANTIC_V1_PREFIX = 'semantic.v1:';
const FROZEN_CURRENT_CONVERSATION_ENROLLMENT = 'controller.current_conversation.enroll';
const FROZEN_SEMANTIC_V1_MAX_BYTES = 8 * 1024;
const FROZEN_FORBIDDEN_OBJECT_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const FROZEN_COMMON_FIELDS = ['repo_id', 'checkout_id', 'request_id', 'detail_level'] as const;
const FROZEN_SEMANTIC_V1_FIELDS: Record<string, ReadonlySet<string>> = {
  work_get: new Set([...FROZEN_COMMON_FIELDS, 'operation', 'work_id']),
  work_revise: new Set([
    ...FROZEN_COMMON_FIELDS,
    'operation',
    'work_id',
    'expected_revision',
    'objective',
    'work_state',
    'requirement_revision',
    'plan_revision',
    'work_result_refs',
  ]),
  work_complete: new Set([
    ...FROZEN_COMMON_FIELDS,
    'operation',
    'work_id',
    'expected_revision',
    'objective',
    'requirement_revision',
    'plan_revision',
    'work_result_refs',
  ]),
  requirement_get: new Set([...FROZEN_COMMON_FIELDS, 'operation', 'requirement_id']),
  requirement_revise: new Set([
    ...FROZEN_COMMON_FIELDS,
    'operation',
    'requirement_id',
    'expected_revision',
    'requirement_title',
    'requirement_outcome',
    'requirement_acceptance_criteria',
    'requirement_delivery_references',
    'requirement_state',
  ]),
  plan_get: new Set([...FROZEN_COMMON_FIELDS, 'operation', 'plan_id']),
  plan_revise: new Set([
    ...FROZEN_COMMON_FIELDS,
    'operation',
    'plan_id',
    'expected_revision',
    'superseded_by',
    'requirement_revision',
    'source_revision',
    'objective',
    'non_goals',
    'assumptions',
    'resolved_decisions',
    'stop_conditions',
    'replan_conditions',
    'integration_strategy',
    'plan_items',
  ]),
  plan_list: new Set([...FROZEN_COMMON_FIELDS, 'operation', 'limit']),
};
const FROZEN_CURRENT_CONVERSATION_FIELDS = new Set([
  'operation',
  'capability_id',
  'repo_id',
  'checkout_id',
  'request_id',
  'detail_level',
  'work_id',
  'handoff_id',
  'launch_args',
  'launch_reservation_ms',
  'lease_ms',
  'continuation_prompt',
  'controller_type',
  'transport_conversation',
]);

function unsafeObjectKey(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  if (Array.isArray(value)) {
    for (const item of value) {
      const nested = unsafeObjectKey(item);
      if (nested) return nested;
    }
    return undefined;
  }
  for (const [key, nestedValue] of Object.entries(value as Record<string, unknown>)) {
    if (FROZEN_FORBIDDEN_OBJECT_KEYS.has(key)) return key;
    const nested = unsafeObjectKey(nestedValue);
    if (nested) return nested;
  }
  return undefined;
}

function parseFrozenSemanticV1(capabilityId: string):
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; summary: string; data: Record<string, unknown> } {
  const encoded = capabilityId.slice(FROZEN_SEMANTIC_V1_PREFIX.length);
  if (Buffer.byteLength(encoded, 'utf8') > FROZEN_SEMANTIC_V1_MAX_BYTES) {
    return { ok: false, summary: 'FROZEN_MCP_SEMANTIC_V1_TOO_LARGE', data: { maxBytes: FROZEN_SEMANTIC_V1_MAX_BYTES } };
  }
  try {
    const parsed = JSON.parse(encoded) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, summary: 'FROZEN_MCP_SEMANTIC_V1_INVALID', data: {} };
    }
    const unsafeKey = unsafeObjectKey(parsed);
    if (unsafeKey) return { ok: false, summary: 'FROZEN_MCP_SEMANTIC_V1_UNSAFE_KEY', data: { key: unsafeKey } };
    return { ok: true, value: parsed as Record<string, unknown> };
  } catch {
    return { ok: false, summary: 'FROZEN_MCP_SEMANTIC_V1_INVALID', data: {} };
  }
}

function unsupportedInputField(input: Record<string, unknown>, allowed: ReadonlySet<string>): string | undefined {
  return Object.keys(input).find((key) => !allowed.has(key));
}

function translateFrozenSemanticV1(
  outer: Record<string, unknown>,
  semantic: Record<string, unknown>,
): RhWorkInputCompatibilityResult {
  const operation = typeof semantic.operation === 'string' ? semantic.operation.trim() : '';
  const allowed = FROZEN_SEMANTIC_V1_FIELDS[operation];
  if (!allowed) return failure('FROZEN_MCP_SEMANTIC_V1_OPERATION_UNSUPPORTED', { operation });

  const semanticUnsupported = unsupportedInputField(semantic, allowed);
  if (semanticUnsupported) {
    return failure('FROZEN_MCP_SEMANTIC_V1_FIELD_UNSUPPORTED', { operation, field: semanticUnsupported });
  }
  const outerAllowed = new Set([...allowed, 'capability_id']);
  const outerUnsupported = unsupportedInputField(outer, outerAllowed);
  if (outerUnsupported) {
    return failure('FROZEN_MCP_SEMANTIC_V1_FIELD_UNSUPPORTED', { operation, field: outerUnsupported });
  }

  for (const field of allowed) {
    if (field === 'operation') continue;
    if (Object.prototype.hasOwnProperty.call(semantic, field)
      && Object.prototype.hasOwnProperty.call(outer, field)
      && !isDeepStrictEqual(semantic[field], outer[field])) {
      return failure('FROZEN_MCP_SEMANTIC_V1_FIELD_CONFLICT', { operation, field });
    }
  }

  const translated: Record<string, unknown> = { operation };
  for (const field of allowed) {
    if (field === 'operation') continue;
    if (Object.prototype.hasOwnProperty.call(semantic, field)) translated[field] = semantic[field];
    else if (Object.prototype.hasOwnProperty.call(outer, field)) translated[field] = outer[field];
  }
  return { ok: true, args: translated, operation };
}

/**
 * Versioned wire bridge for MCP clients whose rh_work schema was frozen before
 * the Thin Forge cutover. The bridge owns no lifecycle or persistence: it only
 * validates and translates two bounded historical carriers into current
 * semantic/controller operations, which remain the sole mutation authorities.
 *
 * Removal condition: the minimum supported MCP client contract no longer
 * advertises these pre-Thin carriers and release reconnect canaries prove there
 * are no supported frozen-session consumers.
 */
export function normalizeRhWorkInputCompatibility(input: Record<string, unknown>): RhWorkInputCompatibilityResult {
  const unsafeKey = unsafeObjectKey(input);
  if (unsafeKey) return failure('FROZEN_MCP_INPUT_UNSAFE_KEY', { key: unsafeKey });

  const args = { ...input };
  const requestedOperation = String(args.operation ?? 'start');
  const capabilityId = typeof args.capability_id === 'string' ? args.capability_id.trim() : '';

  if (capabilityId === FROZEN_CURRENT_CONVERSATION_ENROLLMENT) {
    const unsupported = unsupportedInputField(args, FROZEN_CURRENT_CONVERSATION_FIELDS);
    if (unsupported) return failure('FROZEN_MCP_CURRENT_CONVERSATION_FIELD_UNSUPPORTED', { field: unsupported });
    if (args.controller_type !== undefined && args.controller_type !== 'chatgpt') {
      return failure('FROZEN_MCP_CURRENT_CONVERSATION_FIELD_CONFLICT', { field: 'controller_type' });
    }
    if (args.transport_conversation !== undefined && args.transport_conversation !== 'bound') {
      return failure('FROZEN_MCP_CURRENT_CONVERSATION_FIELD_CONFLICT', { field: 'transport_conversation' });
    }
    const translated: Record<string, unknown> = {
      ...args,
      operation: 'launcher_start',
      controller_type: 'chatgpt',
      transport_conversation: 'bound',
      enroll_current_conversation: true,
    };
    delete translated.capability_id;
    return { ok: true, args: translated, operation: 'launcher_start' };
  }

  if (capabilityId.startsWith(FROZEN_SEMANTIC_V1_PREFIX)) {
    const parsed = parseFrozenSemanticV1(capabilityId);
    if (!parsed.ok) return failure(parsed.summary, parsed.data);
    return translateFrozenSemanticV1(args, parsed.value);
  }

  if (capabilityId.startsWith(AUTOMATION_RECEIPT_CAPABILITY_PREFIX)) {
    // Frozen clients attach ordinary repository context and a reason. These are
    // transport annotations, never receipt/task/effect authority. Strip them;
    // the canonical Supervisor derives all causal identity from its own journal.
    const allowed = new Set(['operation', 'capability_id', 'repo_id', 'reason']);
    const unsupported = unsupportedInputField(args, allowed);
    if (unsupported) return failure('FROZEN_MCP_AUTOMATION_RECEIPT_FIELD_UNSUPPORTED', { field: unsupported });
    if (requestedOperation !== 'repair') return failure('FROZEN_MCP_AUTOMATION_RECEIPT_OPERATION_INVALID', { operation: requestedOperation });
    for (const field of ['repo_id', 'reason']) {
      if (args[field] !== undefined && (typeof args[field] !== 'string' || (args[field] as string).length > 2_000)) {
        return failure('FROZEN_MCP_AUTOMATION_RECEIPT_FIELD_INVALID', { field });
      }
    }
    return { ok: true, args: { operation: 'repair', capability_id: capabilityId }, operation: 'repair' };
  }

  if (capabilityId.includes(':')) {
    return failure('FROZEN_MCP_LIFECYCLE_REMOVED: only bounded semantic.v1 and current-conversation enrollment carriers remain supported.', {
      carrier: capabilityId.slice(0, capabilityId.indexOf(':')),
    });
  }

  return { ok: true, args, operation: requestedOperation };
}
