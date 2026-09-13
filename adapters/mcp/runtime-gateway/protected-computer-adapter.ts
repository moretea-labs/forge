import { randomUUID } from 'crypto';
import {
  COMPUTER_CONSOLE_UNLOCK_CAPABILITY,
  type ComputerConsoleUnlockPrepareRequest,
  type ComputerConsoleUnlockRequest,
} from '../../../packages/protocols/computer/index';
import { executeRuntimeComputerConsoleUnlock } from '../../../src/runtime/root/computer-composition';
import type { MultiRepositoryMcpToolContext } from '../multi-repository';
import type { CallToolResult } from '../../../packages/protocols/mcp/tool-contract';
import { result } from './result-adapter';

const DEFAULT_CONSOLE_UNLOCK_TIMEOUT_MS = 15_000;
const MAX_CONSOLE_UNLOCK_TIMEOUT_MS = 30_000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const FROZEN_CLIENT_PREPARE_CARRIER = 'prepare_provider_local';

export interface ProtectedConsoleUnlockPreparationInput {
  confirmAuthorization: boolean;
  timeoutMs?: number;
}

export interface ProtectedConsoleUnlockInvocationInput {
  credentialHandle: string;
  confirmAuthorization: boolean;
  timeoutMs?: number;
}

function boundedTimeoutMs(value: number | undefined): number {
  if (!Number.isFinite(value)) return DEFAULT_CONSOLE_UNLOCK_TIMEOUT_MS;
  return Math.min(MAX_CONSOLE_UNLOCK_TIMEOUT_MS, Math.max(1_000, Math.trunc(value!)));
}

function protectedErrorCode(error: unknown): string {
  if (error && typeof error === 'object' && typeof (error as { code?: unknown }).code === 'string') {
    return String((error as { code: string }).code);
  }
  const message = error instanceof Error ? error.message : String(error);
  return /^([A-Z][A-Z0-9_]+)(?::|$)/.exec(message)?.[1] ?? 'COMPUTER_CONSOLE_UNLOCK_FAILED';
}

function requireAuthorization(confirmed: boolean): void {
  if (confirmed !== true) {
    throw new Error('COMPUTER_CONSOLE_UNLOCK_EXPLICIT_AUTHORIZATION_REQUIRED: confirm_authorization=true is required for this one invocation.');
  }
}

export async function executeProtectedConsoleUnlockPreparation(
  input: ProtectedConsoleUnlockPreparationInput,
  controllerHome: string,
): Promise<Record<string, unknown>> {
  requireAuthorization(input.confirmAuthorization);
  const invocationId = randomUUID();
  const request: ComputerConsoleUnlockPrepareRequest = {
    capability: COMPUTER_CONSOLE_UNLOCK_CAPABILITY,
    action: 'prepare_unlock_console',
  };
  const providerResult = await executeRuntimeComputerConsoleUnlock(
    request,
    { kind: 'explicit_single_use', confirmed: true, invocationId },
    boundedTimeoutMs(input.timeoutMs),
    controllerHome,
  );
  const credentialHandle = typeof providerResult.credential_handle === 'string'
    ? providerResult.credential_handle
    : undefined;
  if (!credentialHandle || !UUID_PATTERN.test(credentialHandle)) {
    throw new Error('COMPUTER_CONSOLE_UNLOCK_PREPARATION_INVALID: provider did not return a valid opaque credential handle.');
  }
  return {
    capability: COMPUTER_CONSOLE_UNLOCK_CAPABILITY,
    action: 'prepare_unlock_console',
    invocationId,
    prepared: providerResult.prepared === true,
    credentialHandle,
    ...(typeof providerResult.expires_in_ms === 'number'
      ? { expiresInMs: providerResult.expires_in_ms }
      : {}),
  };
}

export async function executeProtectedConsoleUnlockInvocation(
  input: ProtectedConsoleUnlockInvocationInput,
  controllerHome: string,
): Promise<Record<string, unknown>> {
  requireAuthorization(input.confirmAuthorization);
  if (typeof input.credentialHandle !== 'string' || !UUID_PATTERN.test(input.credentialHandle)) {
    throw new Error('COMPUTER_CONSOLE_UNLOCK_CREDENTIAL_HANDLE_REQUIRED: one provider-local opaque credential handle is required.');
  }

  const invocationId = randomUUID();
  const request: ComputerConsoleUnlockRequest = {
    capability: COMPUTER_CONSOLE_UNLOCK_CAPABILITY,
    action: 'unlock_console',
    credentialHandle: input.credentialHandle,
  };
  const providerResult = await executeRuntimeComputerConsoleUnlock(
    request,
    { kind: 'explicit_single_use', confirmed: true, invocationId },
    boundedTimeoutMs(input.timeoutMs),
    controllerHome,
  );

  return {
    capability: COMPUTER_CONSOLE_UNLOCK_CAPABILITY,
    action: 'unlock_console',
    invocationId,
    unlocked: providerResult.unlocked === true,
    verified: providerResult.verified === true,
    ...(typeof providerResult.postcondition === 'string'
      ? { postcondition: providerResult.postcondition }
      : {}),
  };
}

export async function callProtectedComputerAdapter(
  ctx: MultiRepositoryMcpToolContext,
  name: string,
  args: Record<string, unknown>,
): Promise<CallToolResult | undefined> {
  if (name !== 'computer_console_unlock_prepare' && name !== 'computer_console_unlock') return undefined;
  if (name === 'computer_console_unlock' && args.credential_handle === undefined && typeof args.credential === 'string') {
    if (args.credential === FROZEN_CLIENT_PREPARE_CARRIER) {
      name = 'computer_console_unlock_prepare';
    } else if (UUID_PATTERN.test(args.credential)) {
      args = { ...args, credential_handle: args.credential };
    } else {
      return result({
        accepted: false,
        capability: COMPUTER_CONSOLE_UNLOCK_CAPABILITY,
        action: 'unlock_console',
        error: {
          code: 'COMPUTER_CONSOLE_UNLOCK_FROZEN_CLIENT_CARRIER_INVALID',
          message: 'Frozen clients may pass only the provider-local prepare sentinel or an opaque UUID handle; raw credentials are forbidden.',
        },
      }, true);
    }
  }
  const action = name === 'computer_console_unlock_prepare' ? 'prepare_unlock_console' : 'unlock_console';
  try {
    const payload = name === 'computer_console_unlock_prepare'
      ? await executeProtectedConsoleUnlockPreparation({
          confirmAuthorization: args.confirm_authorization === true,
          timeoutMs: typeof args.timeout_ms === 'number' ? args.timeout_ms : undefined,
        }, ctx.controllerHome)
      : await executeProtectedConsoleUnlockInvocation({
          credentialHandle: typeof args.credential_handle === 'string' ? args.credential_handle : '',
          confirmAuthorization: args.confirm_authorization === true,
          timeoutMs: typeof args.timeout_ms === 'number' ? args.timeout_ms : undefined,
        }, ctx.controllerHome);
    return result({ accepted: true, ...payload });
  } catch (error) {
    return result({
      accepted: false,
      capability: COMPUTER_CONSOLE_UNLOCK_CAPABILITY,
      action,
      error: {
        code: protectedErrorCode(error),
        message: action === 'prepare_unlock_console'
          ? 'Protected console-unlock credential preparation did not complete.'
          : 'Protected console unlock did not complete. Provider-local credential material was not exposed.',
      },
    }, true);
  }
}
