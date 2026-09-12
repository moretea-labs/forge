import { randomUUID } from 'crypto';
import {
  COMPUTER_CONSOLE_UNLOCK_CAPABILITY,
  type ComputerConsoleUnlockRequest,
} from '../../../packages/protocols/computer/index';
import { executeRuntimeComputerConsoleUnlock } from '../../../src/runtime/root/computer-composition';
import type { MultiRepositoryMcpToolContext } from '../multi-repository';
import type { CallToolResult } from '../../../packages/protocols/mcp/tool-contract';
import { result } from './result-adapter';

const DEFAULT_CONSOLE_UNLOCK_TIMEOUT_MS = 15_000;
const MAX_CONSOLE_UNLOCK_TIMEOUT_MS = 30_000;

export interface ProtectedConsoleUnlockInvocationInput {
  credential: string;
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

/**
 * Protected one-shot invocation. Credential material remains request-local and is
 * never copied into Work, Process, Plugin action, receipt, audit, or result state.
 */
export async function executeProtectedConsoleUnlockInvocation(
  input: ProtectedConsoleUnlockInvocationInput,
  controllerHome: string,
): Promise<Record<string, unknown>> {
  if (input.confirmAuthorization !== true) {
    throw new Error('COMPUTER_CONSOLE_UNLOCK_EXPLICIT_AUTHORIZATION_REQUIRED: confirm_authorization=true is required for this one invocation.');
  }
  if (typeof input.credential !== 'string' || input.credential.length === 0 || Buffer.byteLength(input.credential, 'utf8') > 1_024) {
    throw new Error('COMPUTER_CONSOLE_UNLOCK_CREDENTIAL_REQUIRED: one bounded ephemeral credential is required.');
  }

  const invocationId = randomUUID();
  const request: ComputerConsoleUnlockRequest = {
    capability: COMPUTER_CONSOLE_UNLOCK_CAPABILITY,
    action: 'unlock_console',
    credential: input.credential,
  };
  const providerResult = await executeRuntimeComputerConsoleUnlock(
    request,
    { kind: 'explicit_single_use', confirmed: true, invocationId },
    boundedTimeoutMs(input.timeoutMs),
    controllerHome,
  );

  // Return an allowlisted postcondition projection. Provider payload growth can
  // never accidentally echo credential material through the MCP result surface.
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
  if (name !== 'computer_console_unlock') return undefined;
  try {
    const payload = await executeProtectedConsoleUnlockInvocation({
      credential: typeof args.credential === 'string' ? args.credential : '',
      confirmAuthorization: args.confirm_authorization === true,
      timeoutMs: typeof args.timeout_ms === 'number' ? args.timeout_ms : undefined,
    }, ctx.controllerHome);
    return result({ accepted: true, ...payload });
  } catch (error) {
    return result({
      accepted: false,
      capability: COMPUTER_CONSOLE_UNLOCK_CAPABILITY,
      action: 'unlock_console',
      error: {
        code: protectedErrorCode(error),
        message: 'Protected console unlock did not complete. Credential material was not retained.',
      },
    }, true);
  }
}
