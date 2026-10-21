/** Local-owner approval for a narrowly scoped ForgeInstance host grant. */
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { readForgeInstanceIdentity, recordCanonicalGrant, type Grant } from '../../../packages/kernel/identity/api/index';
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
  input: { principalId: string; minutes?: number; controllerHome?: string },
  terminal: HostProcessAuthorizationTerminal = localHostProcessTerminal(),
): Promise<Grant> {
  if (!terminal.interactive) {
    throw new Error('HOST_GRANT_INTERACTIVE_TERMINAL_REQUIRED: use a trusted local terminal, not MCP, pipes or automation');
  }
  const principalId = input.principalId?.trim();
  if (!principalId || !/^[A-Za-z0-9][A-Za-z0-9._:-]{1,255}$/.test(principalId)) {
    throw new Error('HOST_GRANT_PRINCIPAL_INVALID: use the authenticated principal from the denial');
  }
  const minutes = input.minutes ?? 15;
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 30) {
    throw new Error('HOST_GRANT_DURATION_INVALID: expected 1-30 minutes');
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
      + 'Capability: process:exec\nDuration: ' + minutes + ' minute(s)\n'
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
      expiresInMinutes: minutes,
      constraints: { kind: 'local_operator_host_process_authorization' },
    }),
  );
}
