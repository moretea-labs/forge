import type { ComputerInteractionTargetAuthorityPort, ComputerInteractionTargetCleanupReport } from '../../../packages/plugin-runtime/computer/target-authority';
import { createComputerInteractionTargetAuthority } from '../../../adapters/computer/interaction-target-authority';
import { createRuntimeComputerTargetPersistence } from './computer-target-persistence';

const computerInteractionTargetAuthority = createComputerInteractionTargetAuthority(createRuntimeComputerTargetPersistence());

export function runtimeComputerInteractionTargetAuthority(): ComputerInteractionTargetAuthorityPort {
  return computerInteractionTargetAuthority;
}

export function cleanupRuntimeComputerInteractionTargets(
  controllerHome: string,
  options?: { nowMs?: number; ttlMs?: number; maxTombstones?: number; maxRemovals?: number },
): Promise<ComputerInteractionTargetCleanupReport> {
  return computerInteractionTargetAuthority.cleanupTombstones(controllerHome, options);
}
