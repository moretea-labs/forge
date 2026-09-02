import { withControllerLock } from '../../src/cli/repositories/locks';
import { readControlPlaneRecord, writeControlPlaneRecord } from '../../src/runtime/control-plane/persistence/sqlite-store';
import type { ControllerBinding } from '../../packages/kernel/controller/api/index';

const NAMESPACE = 'chatgpt_controller_binding';

export interface ChatgptControllerBindingPayload {
  schemaVersion: 1;
  bindingId: string;
  repoId: string;
  workId: string;
  sessionId: string;
  browserSessionId?: string;
  conversationUrl?: string;
  title?: string;
  model?: string;
  reasoning?: 'medium' | 'high' | 'xhigh';
  tabPolicy?: 'auto' | 'reuse' | 'new';
  timeoutMs?: number;
  createdAt: string;
  updatedAt: string;
}

function bindingId(repoId: string, workId: string, sessionId: string): string {
  return `chatgpt-controller:${repoId}:${workId}:${sessionId}`;
}

export function upsertChatgptControllerBinding(
  options: { controllerHome: string; repoId: string; now?: () => string },
  input: Omit<ChatgptControllerBindingPayload, 'schemaVersion' | 'bindingId' | 'repoId' | 'createdAt' | 'updatedAt'>,
): { binding: ControllerBinding; payload: ChatgptControllerBindingPayload } {
  const id = bindingId(options.repoId, input.workId, input.sessionId);
  return withControllerLock(options.controllerHome, { scope: 'task', repoId: options.repoId, taskId: `chatgpt-controller-binding-${input.workId}` }, `chatgpt-controller-binding:${id}`, () => {
    const current = readControlPlaneRecord<ChatgptControllerBindingPayload>(options.controllerHome, NAMESPACE, options.repoId, id);
    const at = options.now?.() ?? new Date().toISOString();
    const payload: ChatgptControllerBindingPayload = {
      ...(current?.value ?? {} as ChatgptControllerBindingPayload),
      ...input,
      schemaVersion: 1, bindingId: id, repoId: options.repoId,
      createdAt: current?.value.createdAt ?? at, updatedAt: at,
    };
    writeControlPlaneRecord(options.controllerHome, {
      namespace: NAMESPACE, scope: options.repoId, key: id, schemaVersion: 1, value: payload,
      action: current ? 'chatgpt_controller_binding_update' : 'chatgpt_controller_binding_create',
      expectedRevision: current?.revision ?? null,
    });
    return { binding: { bindingId: id, hostKind: 'chatgpt', adapterRef: id }, payload };
  });
}

export function getChatgptControllerBindingPayload(
  options: { controllerHome: string; repoId: string }, adapterRef: string,
): ChatgptControllerBindingPayload | undefined {
  return readControlPlaneRecord<ChatgptControllerBindingPayload>(options.controllerHome, NAMESPACE, options.repoId, adapterRef)?.value;
}
