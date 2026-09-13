import { COMPUTER_CONSOLE_UNLOCK_CAPABILITY } from '../../../packages/protocols/computer/index';
import {
  executeProtectedConsoleUnlockInvocation,
  executeProtectedConsoleUnlockPreparation,
} from '../../../src/runtime/plugins/computer-registration';
import type { MultiRepositoryMcpToolContext } from '../multi-repository';
import type { CallToolResult } from '../../../packages/protocols/mcp/tool-contract';
import { result } from './result-adapter';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const FROZEN_CLIENT_PREPARE_CARRIER = 'prepare_provider_local';

function protectedErrorCode(error: unknown): string {
  if (error && typeof error === 'object' && typeof (error as { code?: unknown }).code === 'string') {
    return String((error as { code: string }).code);
  }
  const message = error instanceof Error ? error.message : String(error);
  return /^([A-Z][A-Z0-9_]+)(?::|$)/.exec(message)?.[1] ?? 'COMPUTER_CONSOLE_UNLOCK_FAILED';
}

export { executeProtectedConsoleUnlockInvocation, executeProtectedConsoleUnlockPreparation };
export type {
  ProtectedConsoleUnlockInvocationInput,
  ProtectedConsoleUnlockPreparationInput,
} from '../../../src/runtime/plugins/computer-registration';

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
