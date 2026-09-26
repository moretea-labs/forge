import { FORGE_INSTANCE_SCOPE_KEY } from '../../src/cli/repositories/controller-home';
import { withControllerLock } from '../../src/cli/repositories/locks';
import { readControlPlaneRecord, writeControlPlaneRecord } from '../../src/runtime/control-plane/persistence/sqlite-store';
import type { ControllerBinding } from '../../packages/kernel/controller/api/index';

const NAMESPACE = 'chatgpt_controller_binding';

export interface ChatgptControllerBindingPayload {
  schemaVersion: 1;
  bindingId: string;
  /** Optional repository provenance only. */
  repoId?: string;
  workId: string;
  sessionId: string;
  browserSessionId?: string;
  conversationUrl?: string;
  title?: string;
  model?: string;
  reasoning?: 'medium' | 'high' | 'xhigh';
  tabPolicy?: 'auto' | 'reuse' | 'new';
  timeoutMs?: number;
  authorizationGrantRefs?: string[];
  createdAt: string;
  updatedAt: string;
}

function canonicalBindingId(workId: string): string {
  return `chatgpt-controller:${workId}`;
}

function legacyBindingId(repoId: string, workId: string): string {
  return `chatgpt-controller:${repoId}:${workId}`;
}

function readBinding(
  controllerHome: string,
  workId: string,
  repoId?: string,
): { value: ChatgptControllerBindingPayload; revision: number } | undefined {
  const canonicalId = canonicalBindingId(workId);
  const canonical = readControlPlaneRecord<ChatgptControllerBindingPayload>(
    controllerHome,
    NAMESPACE,
    FORGE_INSTANCE_SCOPE_KEY,
    canonicalId,
  );
  const legacy = repoId?.trim()
    ? readControlPlaneRecord<ChatgptControllerBindingPayload>(
        controllerHome,
        NAMESPACE,
        repoId.trim(),
        legacyBindingId(repoId.trim(), workId),
      )
    : undefined;
  if (canonical && legacy) {
    const left = canonical.value;
    const right = legacy.value;
    if (left.workId !== right.workId
      || left.sessionId !== right.sessionId
      || (left.conversationUrl ?? '') !== (right.conversationUrl ?? '')) {
      throw new Error(`CHATGPT_CONTROLLER_BINDING_COLLISION: ${workId}`);
    }
  }
  return canonical ?? legacy;
}

export function upsertChatgptControllerBinding(
  options: { controllerHome: string; repoId?: string; now?: () => string },
  input: Omit<ChatgptControllerBindingPayload, 'schemaVersion' | 'bindingId' | 'repoId' | 'createdAt' | 'updatedAt'>,
): { binding: ControllerBinding; payload: ChatgptControllerBindingPayload } {
  const id = canonicalBindingId(input.workId);
  return withControllerLock(
    options.controllerHome,
    { scope: 'global', resource: `chatgpt-controller-binding:${input.workId}` },
    `chatgpt-controller-binding:${id}`,
    () => {
      const current = readBinding(options.controllerHome, input.workId, options.repoId);
      const at = options.now?.() ?? new Date().toISOString();
      const payload: ChatgptControllerBindingPayload = {
        ...(current?.value ?? {} as ChatgptControllerBindingPayload),
        ...input,
        schemaVersion: 1,
        bindingId: id,
        ...(options.repoId?.trim() ? { repoId: options.repoId.trim() } : {}),
        createdAt: current?.value.createdAt ?? at,
        updatedAt: at,
      };
      writeControlPlaneRecord(options.controllerHome, {
        namespace: NAMESPACE,
        scope: FORGE_INSTANCE_SCOPE_KEY,
        key: id,
        schemaVersion: 1,
        value: payload,
        action: current ? 'chatgpt_controller_binding_update' : 'chatgpt_controller_binding_create',
        expectedRevision: readControlPlaneRecord<ChatgptControllerBindingPayload>(
          options.controllerHome,
          NAMESPACE,
          FORGE_INSTANCE_SCOPE_KEY,
          id,
        )?.revision ?? null,
      });
      return { binding: { bindingId: id, hostKind: 'chatgpt', adapterRef: id }, payload };
    },
  );
}

export function getChatgptControllerBindingPayload(
  options: { controllerHome: string; repoId?: string },
  adapterRef: string,
): ChatgptControllerBindingPayload | undefined {
  const canonical = readControlPlaneRecord<ChatgptControllerBindingPayload>(
    options.controllerHome,
    NAMESPACE,
    FORGE_INSTANCE_SCOPE_KEY,
    adapterRef,
  )?.value;
  if (canonical) return canonical;
  const repoId = options.repoId?.trim();
  if (!repoId) return undefined;
  return readControlPlaneRecord<ChatgptControllerBindingPayload>(
    options.controllerHome,
    NAMESPACE,
    repoId,
    adapterRef,
  )?.value;
}
