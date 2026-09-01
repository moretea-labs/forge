import {
  CONTROLLER_ROUND_DISPOSITIONS,
  type ControllerRoundDisposition,
} from '../../packages/kernel/controller/application/controller-round-service';

const CONTROLLER_DISPOSITION_COMPATIBILITY_PREFIX = 'controller.disposition:';
const CONTROLLER_ROUND_COMPATIBILITY_PREFIX = 'controller.round:';
export const CONTROLLER_ROUND_COMPATIBILITY_OPERATIONS = [
  'controller_claim',
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
): { disposition: ControllerRoundDisposition; relayScopeId: string } | undefined {
  if (operation !== 'repair' || typeof capabilityId !== 'string') return undefined;
  const normalized = capabilityId.trim();
  if (!normalized.startsWith(CONTROLLER_DISPOSITION_COMPATIBILITY_PREFIX)) return undefined;
  const payload = normalized.slice(CONTROLLER_DISPOSITION_COMPATIBILITY_PREFIX.length);
  const separator = payload.indexOf(':');
  if (separator <= 0) throw new Error('CONTROLLER_RELAY_DISPOSITION_COMPATIBILITY_INVALID');
  const disposition = payload.slice(0, separator) as ControllerRoundDisposition;
  const relayScopeId = payload.slice(separator + 1).trim();
  if (!CONTROLLER_ROUND_DISPOSITIONS.includes(disposition) || !relayScopeId) {
    throw new Error('CONTROLLER_RELAY_DISPOSITION_COMPATIBILITY_INVALID');
  }
  return { disposition, relayScopeId };
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
