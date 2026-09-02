import { withControllerLock } from '../../src/cli/repositories/locks';
import { readControlPlaneRecord, writeControlPlaneRecord } from '../../src/runtime/control-plane/persistence/sqlite-store';
import type { ControllerBinding, ControllerType } from '../../packages/kernel/controller/api/index';

const NAMESPACE = 'process_controller_binding';
export type ProcessControllerType = Exclude<ControllerType, 'chatgpt' | 'human'>;

export interface ProcessControllerBindingPayload {
  schemaVersion: 1; bindingId: string; repoId: string; workId: string; sessionId: string;
  controllerType: ProcessControllerType; executable?: string; launchArgs: string[]; handoffId?: string; launchReservationMs?: number;
  createdAt: string; updatedAt: string;
}

function bindingId(repoId: string, workId: string, controllerType: ProcessControllerType): string {
  return `process-controller:${controllerType}:${repoId}:${workId}`;
}

export function upsertProcessControllerBinding(
  options: { controllerHome: string; repoId: string; now?: () => string },
  input: Omit<ProcessControllerBindingPayload, 'schemaVersion' | 'bindingId' | 'repoId' | 'createdAt' | 'updatedAt'>,
): { binding: ControllerBinding; payload: ProcessControllerBindingPayload } {
  const id = bindingId(options.repoId, input.workId, input.controllerType);
  return withControllerLock(options.controllerHome, { scope: 'task', repoId: options.repoId, taskId: `process-controller-binding-${input.workId}` }, `process-controller-binding:${id}`, () => {
    const current = readControlPlaneRecord<ProcessControllerBindingPayload>(options.controllerHome, NAMESPACE, options.repoId, id);
    const at = options.now?.() ?? new Date().toISOString();
    const payload: ProcessControllerBindingPayload = { ...input, schemaVersion: 1, bindingId: id, repoId: options.repoId, createdAt: current?.value.createdAt ?? at, updatedAt: at };
    writeControlPlaneRecord(options.controllerHome, { namespace: NAMESPACE, scope: options.repoId, key: id, schemaVersion: 1, value: payload, action: current ? 'process_controller_binding_update' : 'process_controller_binding_create', expectedRevision: current?.revision ?? null });
    return { binding: { bindingId: id, hostKind: input.controllerType, adapterRef: id }, payload };
  });
}

export function getProcessControllerBindingPayload(options: { controllerHome: string; repoId: string }, adapterRef: string) {
  return readControlPlaneRecord<ProcessControllerBindingPayload>(options.controllerHome, NAMESPACE, options.repoId, adapterRef)?.value;
}
