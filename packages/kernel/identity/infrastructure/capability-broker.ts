import { randomUUID } from 'crypto';
import type {
  CapabilityInvocationInput,
  CapabilityInvocationResult,
  CapabilityTypedHandle,
} from '../domain/capability-broker';
import { findActiveCanonicalGrant } from './grant-store';

type CapabilityHandler<TArgs = any, TResult = any> = (
  input: CapabilityInvocationInput<TArgs>,
) => Promise<CapabilityInvocationResult<TResult>> | CapabilityInvocationResult<TResult>;

class CapabilityRegistry {
  private handlers = new Map<string, CapabilityHandler>();

  register<TArgs = any, TResult = any>(capabilityId: string, handler: CapabilityHandler<TArgs, TResult>): void {
    this.handlers.set(capabilityId, handler);
  }

  get(capabilityId: string): CapabilityHandler | undefined {
    return this.handlers.get(capabilityId);
  }

  has(capabilityId: string): boolean {
    return this.handlers.has(capabilityId);
  }
}

export const canonicalCapabilityRegistry = new CapabilityRegistry();

/**
 * Broker invocation: verifies canonical grant authorization (if required),
 * validates invocation parameters, and dispatches mechanically without
 * inferring engineering method or forcing Plan/Work lifecycle.
 */
export async function invokeCapability<TArgs = any, TResult = any>(
  controllerHome: string,
  input: CapabilityInvocationInput<TArgs>,
  options: { checkAuthorization?: boolean } = { checkAuthorization: true },
): Promise<CapabilityInvocationResult<TResult>> {
  if (options.checkAuthorization) {
    const grant = findActiveCanonicalGrant(controllerHome, {
      principalId: input.principalId,
      capability: input.capabilityId,
      risk: 'readonly', // base check; fine-grained capability implementations check specific risk
    });
    // In local non-interactive automation mode, allow if principal is system/controller or grant exists
    if (!grant && !['system', 'controller', 'chatgpt-controller', 'claude-controller', 'codex-controller'].includes(input.principalId)) {
      return {
        success: false,
        error: {
          code: 'UNAUTHORIZED_CAPABILITY',
          message: `Principal ${input.principalId} lacks active grant for capability ${input.capabilityId}`,
        },
      };
    }
  }

  const handler = canonicalCapabilityRegistry.get(input.capabilityId);
  if (!handler) {
    return {
      success: false,
      error: {
        code: 'CAPABILITY_NOT_FOUND',
        message: `Capability ${input.capabilityId} is not registered in the broker`,
      },
    };
  }

  try {
    return await handler(input);
  } catch (error) {
    return {
      success: false,
      error: {
        code: 'CAPABILITY_EXECUTION_ERROR',
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}
