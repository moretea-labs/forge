import type { CallToolResult } from '../../../packages/protocols/mcp/tool-contract';
import type { MultiRepositoryMcpToolContext } from '../multi-repository';
import {
  authorizeCredentialUse,
  credentialUseStatus,
  revokeCredentialUse,
} from '../../../src/runtime/safe-tooling/managed-credential-authorization';
import { result } from './result-adapter';

function required(args: Record<string, unknown>, key: string, code: string): string {
  const value = typeof args[key] === 'string' ? String(args[key]).trim() : '';
  if (!value) throw new Error(code);
  return value;
}

export async function callCredentialAdapter(
  ctx: MultiRepositoryMcpToolContext,
  name: string,
  args: Record<string, unknown>,
): Promise<CallToolResult | undefined> {
  if (name !== 'rh_credential') return undefined;
  try {
    const operation = typeof args.operation === 'string' ? args.operation : 'status';
    const credentialRef = required(args, 'credential_ref', 'CREDENTIAL_REF_REQUIRED');
    if (operation === 'revoke') {
      return result(revokeCredentialUse({
        controllerHome: ctx.controllerHome,
        credentialRef,
        reason: typeof args.reason === 'string' ? args.reason : undefined,
      }));
    }
    const endpoint = required(args, 'endpoint', 'CREDENTIAL_ENDPOINT_REQUIRED');
    if (operation === 'status') {
      return result(credentialUseStatus({
        controllerHome: ctx.controllerHome,
        credentialRef,
        endpoint,
      }));
    }
    if (operation === 'authorize') {
      const enrolled = authorizeCredentialUse({
        controllerHome: ctx.controllerHome,
        credentialRef,
        endpoint,
        principalId: ctx.principalId,
        confirmAuthorization: args.confirm_authorization === true,
        expiresInMinutes: typeof args.expires_in_minutes === 'number' ? args.expires_in_minutes : undefined,
      });
      return result({
        authorized: true,
        reused: enrolled.reused,
        credentialRef,
        endpoint,
        grantId: enrolled.grant.grantId,
        expiresAt: enrolled.grant.expiresAt,
        credentialMaterialReturned: false,
      });
    }
    throw new Error(`CREDENTIAL_OPERATION_UNSUPPORTED: ${operation}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const code = /^([A-Z][A-Z0-9_]+)(?::|$)/.exec(message)?.[1] ?? 'CREDENTIAL_FAILED';
    return result({ error: { code, message } }, true);
  }
}
