import type { ControllerBinding, ControllerHost, ControllerRoundContext } from '../../packages/kernel/controller/api/index';
import { launchSuperController } from '../../src/runtime/control-plane/launcher/thin-launcher';
import { getProcessControllerBindingPayload } from './binding-store';

export function createProcessControllerHost(options: { controllerHome: string; repoId: string; repoRoot: string }): ControllerHost {
  return {
    async resume(binding: ControllerBinding, roundContext: ControllerRoundContext) {
      if (binding.hostKind === 'chatgpt' || binding.hostKind === 'human') return { accepted: false, reason: `CONTROLLER_HOST_KIND_MISMATCH:${binding.hostKind}` };
      const payload = getProcessControllerBindingPayload(options, binding.adapterRef);
      if (!payload || payload.bindingId !== binding.bindingId || payload.workId !== roundContext.workId || payload.controllerType !== binding.hostKind) {
        return { accepted: false, reason: `PROCESS_CONTROLLER_BINDING_NOT_FOUND:${binding.bindingId}` };
      }
      const continuationPrompt = [
        `Continue exact Forge Work ${roundContext.workId}.`,
        `Controller round authority: controller_authority_id=${roundContext.authorityId}; relay_scope_id=${roundContext.relayScopeId}.`,
        roundContext.continuationHint?.trim() ?? '',
      ].filter(Boolean).join(' ');
      const launched = await launchSuperController({ work: options, handoff: options }, {
        controllerType: payload.controllerType, executable: payload.executable, args: payload.launchArgs,
        workId: roundContext.workId, handoffId: payload.handoffId, launchReservationMs: payload.launchReservationMs,
        continuationPrompt, cwd: options.repoRoot,
      });
      return { accepted: true, dispatchId: launched.pid !== undefined ? String(launched.pid) : undefined };
    },
  };
}
