import type { ComputerSurfaceProviderBinding } from './target-authority';

export interface ComputerChatgptConversationIdentity {
  namespace: 'chatgpt.conversation';
  conversationId: string;
  canonicalUrl: string;
}

export interface ComputerChatgptBootstrapIdentity {
  namespace: 'chatgpt.bootstrap';
  bootstrapKey: string;
  projectUrl: string;
}

export type ComputerChatgptTargetIdentity = ComputerChatgptConversationIdentity | ComputerChatgptBootstrapIdentity;

export interface ComputerChatgptConversationObservation {
  url: string;
  title: string;
  latestUserText: string;
  latestAssistantResponse: string;
  userMessages?: string[];
  assistantMessages?: string[];
  composerText?: string;
  providerActivityText: string;
  providerFailureText: string;
  pageText?: string;
  latestTurnRole?: 'user' | 'assistant';
  isGenerating: boolean;
}

export interface ComputerChatgptConversationObservationOptions {
  includeUserHistory?: boolean;
  includePageText?: boolean;
}

/**
 * Opaque exact-conversation attachment. The targetId is durable Computer
 * identity; provider ids and tab/window handles remain inside the Computer
 * implementation and can be replaced without changing Supervisor authority.
 */
export interface ComputerChatgptConversationTarget {
  targetId: string;
  identity: ComputerChatgptTargetIdentity;
  observe(options?: ComputerChatgptConversationObservationOptions): Promise<ComputerChatgptConversationObservation>;
  dispatch(
    prompt: string,
    options?: { mode?: 'send' | 'resume' | 'recover' },
  ): Promise<
    | { mutation: 'not_attempted'; reasonCode: string }
    | { mutation: 'attempted'; confirmed?: boolean }
  >;
}

export type ComputerChatgptTargetFailure = {
  code: string;
  retryable: boolean;
  /** Failover is legal only while provider mutation is mechanically impossible. */
  phase: 'pre_mutation';
  /** False when provider resource recovery is itself outcome-unknown. */
  failoverSafe?: boolean;
  humanAction?: 'login' | 'grant_permission';
};

export type ComputerChatgptTargetResult =
  | { state: 'ready'; target: ComputerChatgptConversationTarget; observation?: ComputerChatgptConversationObservation }
  | { state: 'unavailable'; failure: ComputerChatgptTargetFailure };

export interface ComputerObservedChatgptConversation {
  conversationId: string;
  canonicalUrl: string;
  title?: string;
  projectTitle?: string;
  projectUrl?: string;
  isCurrent?: boolean;
}

export interface ComputerChatgptConversationInventory {
  conversations: ComputerObservedChatgptConversation[];
  complete: boolean;
  unavailableProviders: string[];
}

/**
 * Browser/Computer-owned target boundary consumed by Workflow Supervisor.
 * Implementations own discovery, exact target recovery, provider binding and
 * transport replacement. They never decide effect admission or effect outcome.
 */
export type ComputerChatgptExtensionCommand =
  | { commandId: string; kind: 'ensure'; identity: ComputerChatgptTargetIdentity }
  | { commandId: string; kind: 'observe'; identity: ComputerChatgptTargetIdentity; options?: ComputerChatgptConversationObservationOptions }
  | { commandId: string; kind: 'dispatch'; identity: ComputerChatgptTargetIdentity; prompt: string; mode?: 'send' | 'resume' | 'recover' }
  | { commandId: string; kind: 'find_marker'; marker: string; bootstrapKey?: string }
  | { commandId: string; kind: 'close'; identity: ComputerChatgptTargetIdentity };
export type ComputerChatgptExtensionCommandInput = ComputerChatgptExtensionCommand extends infer Command
  ? Command extends { commandId: string }
    ? Omit<Command, 'commandId'>
    : never
  : never;


export type ComputerChatgptExtensionCommandResult =
  | { kind: 'ensured'; providerBinding?: ComputerSurfaceProviderBinding; observation?: ComputerChatgptConversationObservation }
  | { kind: 'observation'; providerBinding?: ComputerSurfaceProviderBinding; observation: ComputerChatgptConversationObservation }
  | { kind: 'dispatch'; mutation: 'not_attempted'; reasonCode: string }
  | { kind: 'dispatch'; mutation: 'attempted'; confirmed?: boolean; observation?: ComputerChatgptConversationObservation }
  | { kind: 'marker_matches'; matches: Array<{ identity: ComputerChatgptConversationIdentity; providerBinding?: ComputerSurfaceProviderBinding; observation: ComputerChatgptConversationObservation }> }
  | { kind: 'closed' }
  | { kind: 'failed'; code: string; retryable?: boolean; failoverSafe?: boolean; humanAction?: 'login' | 'grant_permission' };

export interface ComputerChatgptExtensionHeartbeat {
  providerId: string;
  /** Ephemeral browser/profile provider runtime identity; mechanical binding only. */
  providerInstanceId: string;
  observedAt: string;
  conversations: Array<ComputerObservedChatgptConversation & { providerBinding?: ComputerSurfaceProviderBinding }>;
}

export interface ComputerChatgptExtensionBrokerRpc {
  heartbeat(input: ComputerChatgptExtensionHeartbeat): void;
  claim(providerInstanceId: string): ComputerChatgptExtensionCommand | undefined;
  complete(providerInstanceId: string, commandId: string, result: ComputerChatgptExtensionCommandResult): boolean;
}

export interface ComputerChatgptConversationTargetPort {
  inventory(): Promise<ComputerChatgptConversationInventory>;
  ensureExact(identity: ComputerChatgptConversationIdentity): Promise<ComputerChatgptTargetResult>;
  openBootstrap(projectUrl: string, bootstrapKey: string): Promise<ComputerChatgptTargetResult>;
  findBySubmittedMarker(
    marker: string,
    bootstrapKey?: string,
    betweenObservations?: () => Promise<void>,
  ): Promise<ComputerChatgptTargetResult[]>;
  promoteBootstrap(targetId: string, identity: ComputerChatgptConversationIdentity): Promise<ComputerChatgptTargetResult>;
  /** Mechanical cleanup of provider-owned attachments; semantic target identity remains durable. */
  cleanup(activeResourceKeys: readonly string[]): Promise<void>;
  release(targetId: string): Promise<void>;
  close(): Promise<void>;
}
