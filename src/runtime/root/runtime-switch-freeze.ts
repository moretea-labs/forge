import { existsSync } from 'fs';
import { join } from 'path';

/** One persistent operator freeze, separate from the transient Recovery mutation lock.
 * Release workflows never clear this marker; only a user-authorized operation may do so.
 */
const RUNTIME_VERSION_MUTATIONS = new Set([
  'activate_runtime_release', 'rollback_previous', 'recover_primary_runtime',
  'release_session_cutover', 'release_session_rollback', 'release_session_known_good',
]);

export function runtimeSwitchFreezePath(controllerHome: string): string {
  return join(controllerHome, 'recovery', 'config', 'runtime-switch-frozen.json');
}

export function assertRuntimeSwitchNotFrozen(controllerHome: string, action: string): void {
  if (RUNTIME_VERSION_MUTATIONS.has(action) && existsSync(runtimeSwitchFreezePath(controllerHome))) {
    throw new Error('RUNTIME_SWITCH_FROZEN_USER_AUTHORIZATION_REQUIRED: explicit user approval is required before any Runtime version change');
  }
}
