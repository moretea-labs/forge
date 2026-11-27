import {
  parseCanonicalChatgptConversationIdentity,
  type ComputerChatgptConversationIdentity,
  type ComputerChatgptConversationInventory,
  type ComputerChatgptConversationTargetPort,
  type ComputerChatgptTargetIdentity,
} from '../../../packages/plugin-runtime/computer';
import { MacOsChatgptConversationTargetPort } from '../plugins/browser-chatgpt-target';
import { runtimeComputerInteractionTargetAuthority } from './computer-target-composition';
import * as linuxExtension from './computer-chatgpt-extension';

export type RuntimeComputerChatgptActionInput =
  | { kind: 'ensure'; identity: ComputerChatgptTargetIdentity }
  | { kind: 'observe'; identity: ComputerChatgptConversationIdentity }
  | { kind: 'refresh'; identity: ComputerChatgptConversationIdentity }
  | { kind: 'promote'; targetId: string; identity: ComputerChatgptConversationIdentity }
  | { kind: 'find_marker'; marker: string; bootstrapKey: string }
  | {
      kind: 'prepare' | 'dispatch';
      identity: ComputerChatgptTargetIdentity;
      prompt: string;
      mode?: 'send' | 'resume' | 'recover';
    };

const ports = new Map<string, ComputerChatgptConversationTargetPort>();

function portFor(controllerHome: string, timeoutMs?: number): ComputerChatgptConversationTargetPort {
  const existing = ports.get(controllerHome);
  if (existing) return existing;
  const created = new MacOsChatgptConversationTargetPort(
    controllerHome,
    runtimeComputerInteractionTargetAuthority(),
    timeoutMs,
  );
  ports.set(controllerHome, created);
  return created;
}

async function executeRuntimeAction(
  port: ComputerChatgptConversationTargetPort,
  action: RuntimeComputerChatgptActionInput,
): Promise<Record<string, unknown>> {
  if (action.kind === 'promote') {
    const promoted = await port.promoteBootstrap(action.targetId, action.identity);
    if (promoted.state !== 'ready') {
      return {
        state: promoted.state,
        failure: promoted.failure,
        ...(promoted.observation ? { observation: promoted.observation } : {}),
      };
    }
    return {
      state: 'ready',
      targetId: promoted.target.targetId,
      identity: action.identity,
      ...(promoted.observation ? { observation: promoted.observation } : {}),
    };
  }

  if (action.kind === 'find_marker') {
    const results = await port.findBySubmittedMarker(action.marker, action.bootstrapKey);
    const matches: Array<Record<string, unknown>> = [];
    for (const result of results) {
      if (result.state !== 'ready') {
        matches.push({
          state: 'unavailable',
          failure: result.failure,
          ...(result.observation ? { observation: result.observation } : {}),
        });
        continue;
      }
      if (!result.observation) continue;
      try {
        const parsed = parseCanonicalChatgptConversationIdentity(result.observation.url);
        matches.push({
          state: 'ready',
          targetId: result.target.targetId,
          identity: {
            namespace: 'chatgpt.conversation',
            conversationId: parsed.conversationId,
            canonicalUrl: parsed.conversationUrl,
          },
          observation: result.observation,
        });
      } catch {}
    }
    return { matches };
  }

  const exact =
    action.kind === 'refresh'
      ? await port.refreshExact(action.identity)
      : action.identity.namespace === 'chatgpt.bootstrap'
        ? await port.openBootstrap(action.identity.projectUrl, action.identity.bootstrapKey)
        : await port.ensureExact(action.identity, { createIfMissing: action.kind !== 'observe' });

  if (exact.state !== 'ready') {
    return {
      state: exact.state,
      failure: exact.failure,
      ...(exact.observation ? { observation: exact.observation } : {}),
    };
  }

  if (action.kind === 'ensure' || action.kind === 'observe' || action.kind === 'refresh') {
    return {
      state: 'ready',
      targetId: exact.target.targetId,
      identity: action.identity,
      observation:
        exact.observation ?? (await exact.target.observe({ includeUserHistory: false, includePageText: false })),
    };
  }

  if (action.kind === 'prepare') {
    return {
      state: 'ready',
      targetId: exact.target.targetId,
      identity: action.identity,
      prepare: await exact.target.prepare(action.prompt, { mode: action.mode }),
    };
  }

  return {
    state: 'ready',
    targetId: exact.target.targetId,
    identity: action.identity,
    dispatch: await exact.target.dispatch(action.prompt, { mode: action.mode }),
  };
}

export async function ensureRuntimeComputerChatgptTarget(
  controllerHome: string,
  timeoutMs?: number,
): Promise<ComputerChatgptConversationTargetPort> {
  if (process.platform === 'linux')
    return await linuxExtension.runtimeComputerChatgptTargetPort(controllerHome, { timeoutMs });
  return portFor(controllerHome, timeoutMs);
}

export async function runtimeComputerChatgptAction(
  controllerHome: string,
  input: RuntimeComputerChatgptActionInput,
  timeoutMs?: number,
): Promise<Record<string, unknown>> {
  if (process.platform === 'linux')
    return await linuxExtension.runtimeComputerChatgptAction(controllerHome, input, timeoutMs);
  return await executeRuntimeAction(portFor(controllerHome, timeoutMs), input);
}

export async function runtimeComputerChatgptInventory(
  controllerHome: string,
  timeoutMs?: number,
): Promise<ComputerChatgptConversationInventory> {
  if (process.platform === 'linux')
    return await linuxExtension.runtimeComputerChatgptInventory(controllerHome, timeoutMs);
  return await portFor(controllerHome, timeoutMs).inventory();
}

export async function closeRuntimeComputerChatgptTarget(controllerHome: string): Promise<void> {
  if (process.platform === 'linux') {
    await linuxExtension.closeRuntimeComputerChatgptExtension(controllerHome);
    return;
  }
  const port = ports.get(controllerHome);
  if (!port) return;
  ports.delete(controllerHome);
  await port.close();
}

export const closeRuntimeComputerChatgptTargetForTest = closeRuntimeComputerChatgptTarget;
