/** Local-owner approval for a narrowly scoped ForgeInstance host grant. */
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { readForgeInstanceIdentity, recordCanonicalGrant, listCanonicalGrants, revokeCanonicalGrant, type Grant } from '../../../packages/kernel/identity/api/index';
import { resolveControllerHome } from '../../effects/controller-home';
import { withControllerLock } from '../repositories/locks';

export interface HostProcessAuthorizationTerminal {
  interactive: boolean;
  confirm(prompt: string): Promise<string>;
}
export function localHostProcessTerminal(): HostProcessAuthorizationTerminal {
  return {
    interactive: stdin.isTTY === true && stdout.isTTY === true,
    async confirm(prompt) {
      const rl = createInterface({ input: stdin, output: stdout });
      try { return await rl.question(prompt); } finally { rl.close(); }
    },
  };
}
export async function authorizeHostProcessFromLocalTerminal(
  input: { principalId: string; days?: number; controllerHome?: string },
  terminal: HostProcessAuthorizationTerminal = localHostProcessTerminal(),
): Promise<Grant> {
  if (!terminal.interactive) {
    throw new Error('HOST_GRANT_INTERACTIVE_TERMINAL_REQUIRED: use a trusted local terminal, not MCP, pipes or automation');
  }
  const principalId = input.principalId?.trim();
  if (!principalId || !/^[A-Za-z0-9][A-Za-z0-9._:-]{1,255}$/.test(principalId)) {
    throw new Error('HOST_GRANT_PRINCIPAL_INVALID: use the authenticated principal from the denial');
  }
  const days = input.days ?? 30;
  if (!Number.isInteger(days) || days < 1 || days > 90) {
    throw new Error('HOST_GRANT_DURATION_INVALID: expected 1-90 days');
  }
  const controllerHome = resolveControllerHome(input.controllerHome);
  const instance = readForgeInstanceIdentity(controllerHome);
  if (!instance?.instanceId) {
    throw new Error('HOST_PROCESS_TARGET_UNAVAILABLE: an existing local ForgeInstance is required');
  }
  const phrase = 'AUTHORIZE process:exec ' + instance.instanceId + ' ' + principalId;
  const confirmed = await terminal.confirm(
    'Host execution can read local secrets and modify files.\n'
      + 'Instance: ' + instance.instanceId + '\nPrincipal: ' + principalId + '\n'
      + 'Capability: process:exec\nDuration: ' + days + ' day(s)\n'
      + 'Type exactly: ' + phrase + '\n> ',
  );
  if (confirmed.trim() !== phrase) {
    throw new Error('HOST_GRANT_CONFIRMATION_MISMATCH: no grant created');
  }
  return withControllerLock(
    controllerHome,
    { scope: 'global', resource: 'plugin-capability-authorization-grants' },
    'host-process-local-authorization:' + principalId,
    () => recordCanonicalGrant(controllerHome, {
      principalId,
      capabilities: ['process:exec'],
      target: { kind: 'forge_instance', id: instance.instanceId },
      riskCeiling: 'remote_write',
      expiresInMinutes: days * 24 * 60,
      constraints: { kind: 'local_operator_host_process_authorization' },
    }),
  );
}

/** Revoke only the caller-selected principal's exact local host capability. */
export function revokeHostProcessFromLocalTerminal(
  input: { principalId: string; controllerHome?: string },
  terminal: HostProcessAuthorizationTerminal = localHostProcessTerminal(),
): number {
  if (!terminal.interactive) {
    throw new Error('HOST_GRANT_INTERACTIVE_TERMINAL_REQUIRED: use a trusted local terminal, not MCP, pipes or automation');
  }
  const principalId = input.principalId?.trim();
  if (!principalId || !/^[A-Za-z0-9][A-Za-z0-9._:-]{1,255}$/.test(principalId)) {
    throw new Error('HOST_GRANT_PRINCIPAL_INVALID');
  }
  const controllerHome = resolveControllerHome(input.controllerHome);
  const instance = readForgeInstanceIdentity(controllerHome);
  if (!instance?.instanceId) {
    throw new Error('HOST_PROCESS_TARGET_UNAVAILABLE: an existing local ForgeInstance is required');
  }
  return withControllerLock(
    controllerHome,
    { scope: 'global', resource: 'plugin-capability-authorization-grants' },
    'host-process-local-revocation:' + principalId,
    () => {
      const matching = listCanonicalGrants(controllerHome).filter((g) =>
        g.principalId === principalId
        && g.capabilities.length === 1 && g.capabilities[0] === 'process:exec'
        && g.target?.kind === 'forge_instance' && g.target.id === instance.instanceId
        && !g.revokedAt
      );
      for (const grant of matching) {
        revokeCanonicalGrant(controllerHome, { grantId: grant.grantId, reason: 'local_operator_revocation' });
      }
      return matching.length;
    },
  );
}
