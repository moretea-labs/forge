import {
  CONTROLLER_ROUND_DISPOSITIONS,
  type ControllerRoundDisposition,
} from '../../packages/kernel/controller/api/index';

const CONTROLLER_DISPOSITION_COMPATIBILITY_PREFIX = 'controller.disposition:';
const CONTROLLER_ROUND_COMPATIBILITY_PREFIX = 'controller.round:';
export const CONTROLLER_ROUND_COMPATIBILITY_OPERATIONS = [
  'controller_claim',
  'plan_accept_step',
  'continue',
  'verify',
  'review',
  'finalize',
  'stop',
  'controller_release',
] as const;
export type ControllerRoundCompatibilityOperation = (typeof CONTROLLER_ROUND_COMPATIBILITY_OPERATIONS)[number];

export function parseControllerDispositionCompatibilityCapability(
  operation: string,
  capabilityId: unknown,
): { disposition: ControllerRoundDisposition; relayScopeId: string; authorityId?: string } | undefined {
  if (operation !== 'repair' || typeof capabilityId !== 'string') return undefined;
  const normalized = capabilityId.trim();
  if (!normalized.startsWith(CONTROLLER_DISPOSITION_COMPATIBILITY_PREFIX)) return undefined;
  const payload = normalized.slice(CONTROLLER_DISPOSITION_COMPATIBILITY_PREFIX.length);
  const separator = payload.indexOf(':');
  if (separator <= 0) throw new Error('CONTROLLER_RELAY_DISPOSITION_COMPATIBILITY_INVALID');
  const disposition = payload.slice(0, separator) as ControllerRoundDisposition;
  const remainder = payload.slice(separator + 1).trim();
  let authorityId: string | undefined;
  let relayScopeId = remainder;
  if (remainder.startsWith('cra_')) {
    const authoritySeparator = remainder.indexOf(':');
    if (authoritySeparator <= 0) throw new Error('CONTROLLER_RELAY_DISPOSITION_COMPATIBILITY_INVALID');
    authorityId = remainder.slice(0, authoritySeparator).trim();
    relayScopeId = remainder.slice(authoritySeparator + 1).trim();
    if (!/^cra_[0-9a-f]{32}$/i.test(authorityId)) throw new Error('CONTROLLER_RELAY_DISPOSITION_COMPATIBILITY_INVALID');
  }
  if (!CONTROLLER_ROUND_DISPOSITIONS.includes(disposition) || !relayScopeId) {
    throw new Error('CONTROLLER_RELAY_DISPOSITION_COMPATIBILITY_INVALID');
  }
  return { disposition, relayScopeId, ...(authorityId ? { authorityId } : {}) };
}

export function parseControllerRoundCompatibilityCapability(
  operation: string,
  capabilityId: unknown,
): { operation: ControllerRoundCompatibilityOperation; authorityId: string; relayScopeId: string } | undefined {
  if (operation !== 'repair' || typeof capabilityId !== 'string') return undefined;
  const normalized = capabilityId.trim();
  if (!normalized.startsWith(CONTROLLER_ROUND_COMPATIBILITY_PREFIX)) return undefined;
  const payload = normalized.slice(CONTROLLER_ROUND_COMPATIBILITY_PREFIX.length);
  const operationSeparator = payload.indexOf(':');
  const authoritySeparator = operationSeparator < 0 ? -1 : payload.indexOf(':', operationSeparator + 1);
  if (operationSeparator <= 0 || authoritySeparator <= operationSeparator + 1) {
    throw new Error('CONTROLLER_ROUND_COMPATIBILITY_INVALID');
  }
  const canonicalOperation = payload.slice(0, operationSeparator) as ControllerRoundCompatibilityOperation;
  const authorityId = payload.slice(operationSeparator + 1, authoritySeparator).trim();
  const relayScopeId = payload.slice(authoritySeparator + 1).trim();
  if (!CONTROLLER_ROUND_COMPATIBILITY_OPERATIONS.includes(canonicalOperation) || !/^cra_[0-9a-f]{32}$/i.test(authorityId) || !relayScopeId) {
    throw new Error('CONTROLLER_ROUND_COMPATIBILITY_INVALID');
  }
  return { operation: canonicalOperation, authorityId, relayScopeId };
}


const PLAN_OBLIGATION_COMPATIBILITY_PREFIX = 'plan.obligations.v1:';
const PLAN_OBLIGATION_COMPATIBILITY_MAX_ENCODED_CHARS = 96_000;
const PLAN_OBLIGATION_COMPATIBILITY_MAX_DECODED_BYTES = 64 * 1024;
const PLAN_OBLIGATION_COMPATIBILITY_MAX_DISPOSITIONS = 512;
const PLAN_OBLIGATION_COMPATIBILITY_MAX_SUCCESSOR_REFS = 32;

export type PlanObligationCompatibilityDispositionKind = 'keep' | 'change' | 'defer' | 'drop';

export interface PlanObligationCompatibilityDisposition {
  predecessor_plan_id: string;
  obligation_id: string;
  disposition: PlanObligationCompatibilityDispositionKind;
  successor_refs: string[];
  rationale?: string;
}

function boundedCompatibilityText(value: unknown, maximum: number): string {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized || normalized.length > maximum) throw new Error('PLAN_OBLIGATION_COMPATIBILITY_INVALID');
  return normalized;
}

/**
 * Encode only the field missing from older frozen rh_work schemas. This is a
 * transport compatibility envelope, never Plan state or semantic authority.
 */
export function buildPlanObligationCompatibilityCapability(
  dispositions: readonly PlanObligationCompatibilityDisposition[],
): string {
  if (dispositions.length > PLAN_OBLIGATION_COMPATIBILITY_MAX_DISPOSITIONS) {
    throw new Error('PLAN_OBLIGATION_COMPATIBILITY_TOO_LARGE');
  }
  const payload = {
    v: 1,
    d: dispositions.map((entry) => ({
      p: boundedCompatibilityText(entry.predecessor_plan_id, 256),
      o: boundedCompatibilityText(entry.obligation_id, 512),
      d: entry.disposition,
      s: entry.successor_refs.map((ref) => boundedCompatibilityText(ref, 512)),
      ...(entry.rationale?.trim() ? { r: boundedCompatibilityText(entry.rationale, 4_000) } : {}),
    })),
  };
  for (const entry of payload.d) {
    if (!['keep', 'change', 'defer', 'drop'].includes(entry.d) || entry.s.length > PLAN_OBLIGATION_COMPATIBILITY_MAX_SUCCESSOR_REFS) {
      throw new Error('PLAN_OBLIGATION_COMPATIBILITY_INVALID');
    }
  }
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  if (encoded.length > PLAN_OBLIGATION_COMPATIBILITY_MAX_ENCODED_CHARS) {
    throw new Error('PLAN_OBLIGATION_COMPATIBILITY_TOO_LARGE');
  }
  return `${PLAN_OBLIGATION_COMPATIBILITY_PREFIX}${encoded}`;
}

export function parsePlanObligationCompatibilityCapability(
  operation: string,
  capabilityId: unknown,
): PlanObligationCompatibilityDisposition[] | undefined {
  if (operation !== 'plan_create' || typeof capabilityId !== 'string') return undefined;
  const normalized = capabilityId.trim();
  if (!normalized.startsWith(PLAN_OBLIGATION_COMPATIBILITY_PREFIX)) return undefined;
  const encoded = normalized.slice(PLAN_OBLIGATION_COMPATIBILITY_PREFIX.length);
  if (!encoded || encoded.length > PLAN_OBLIGATION_COMPATIBILITY_MAX_ENCODED_CHARS || !/^[A-Za-z0-9_-]+$/.test(encoded)) {
    throw new Error('PLAN_OBLIGATION_COMPATIBILITY_INVALID');
  }
  let decoded: Buffer;
  let parsed: unknown;
  try {
    decoded = Buffer.from(encoded, 'base64url');
    if (decoded.byteLength > PLAN_OBLIGATION_COMPATIBILITY_MAX_DECODED_BYTES) throw new Error('too_large');
    parsed = JSON.parse(decoded.toString('utf8'));
  } catch (error) {
    if (error instanceof Error && error.message === 'too_large') throw new Error('PLAN_OBLIGATION_COMPATIBILITY_TOO_LARGE');
    throw new Error('PLAN_OBLIGATION_COMPATIBILITY_INVALID');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('PLAN_OBLIGATION_COMPATIBILITY_INVALID');
  const envelope = parsed as Record<string, unknown>;
  if (envelope.v !== 1 || !Array.isArray(envelope.d) || envelope.d.length > PLAN_OBLIGATION_COMPATIBILITY_MAX_DISPOSITIONS) {
    throw new Error('PLAN_OBLIGATION_COMPATIBILITY_INVALID');
  }
  return envelope.d.map((value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('PLAN_OBLIGATION_COMPATIBILITY_INVALID');
    const entry = value as Record<string, unknown>;
    const disposition = boundedCompatibilityText(entry.d, 16) as PlanObligationCompatibilityDispositionKind;
    const successorRefs = Array.isArray(entry.s) ? entry.s : [];
    if (!['keep', 'change', 'defer', 'drop'].includes(disposition) || successorRefs.length > PLAN_OBLIGATION_COMPATIBILITY_MAX_SUCCESSOR_REFS) {
      throw new Error('PLAN_OBLIGATION_COMPATIBILITY_INVALID');
    }
    return {
      predecessor_plan_id: boundedCompatibilityText(entry.p, 256),
      obligation_id: boundedCompatibilityText(entry.o, 512),
      disposition,
      successor_refs: successorRefs.map((ref) => boundedCompatibilityText(ref, 512)),
      ...(typeof entry.r === 'string' && entry.r.trim()
        ? { rationale: boundedCompatibilityText(entry.r, 4_000) }
        : {}),
    };
  });
}
