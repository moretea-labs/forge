import type { ComputerInteractionTargetAuthorityPort } from '../../../packages/plugin-runtime/computer/target-authority';
import { createComputerInteractionTargetAuthority } from '../../../adapters/computer/interaction-target-authority';
import { createRuntimeComputerTargetPersistence } from './computer-target-persistence';

const computerInteractionTargetAuthority = createComputerInteractionTargetAuthority(createRuntimeComputerTargetPersistence());

export function runtimeComputerInteractionTargetAuthority(): ComputerInteractionTargetAuthorityPort {
  return computerInteractionTargetAuthority;
}
