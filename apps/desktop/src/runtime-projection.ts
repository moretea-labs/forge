export type RuntimeConnectionStatus = 'not_connected' | 'connecting' | 'connected' | 'degraded';
export type ProjectionSource = 'runtime' | 'disconnected' | 'design_preview';
export type AutomaticContinuationStatus = 'running' | 'waiting' | 'needs_user' | 'completed' | 'stopped' | 'switching_conversation';

export interface AutomaticContinuationTaskProjection {
  taskId: string;
  workId?: string;
  title: string;
  objective: string;
  status: AutomaticContinuationStatus;
  statusLabel: string;
  detail: string;
  conversation: {
    conversationId: string;
    conversationUrl: string;
    title?: string;
  } | null;
  nextAction?: string;
}

export interface ForgeDesktopProjection {
  source: ProjectionSource;
  runtime: {
    status: RuntimeConnectionStatus;
    label: string;
    detail: string;
  };
  project: {
    name: string;
    repository: string;
    branch: string;
    worktree: string;
    sourceRevision: string;
  } | null;
  work: {
    workId: string;
    title: string;
    semanticState: 'open' | 'completed' | 'cancelled';
    relationLabel?: string;
    controller?: string;
    currentFocus?: string;
  } | null;
  automaticContinuations: AutomaticContinuationTaskProjection[];
}

/**
 * Presentation-only bootstrap value. Requirement, Plan, Work, Controller,
 * Scheduler and connection facts remain authoritative in the Forge Runtime.
 * The desktop client never persists a competing semantic copy.
 */
export const disconnectedProjection = Object.freeze<ForgeDesktopProjection>({
  source: 'disconnected',
  runtime: {
    status: 'not_connected',
    label: 'Runtime not connected',
    detail: 'Desktop bootstrap is ready. Runtime projection wiring is still required.',
  },
  project: null,
  work: null,
  automaticContinuations: [],
});

/**
 * Explicit design-preview fixture. It is never used as Runtime truth and is
 * enabled only with ?preview=1 so missing canonical data is not hidden.
 */
export const designPreviewProjection = Object.freeze<ForgeDesktopProjection>({
  source: 'design_preview',
  runtime: {
    status: 'connected',
    label: 'Runtime healthy',
    detail: 'Design preview data — production values come from Forge Runtime projection.',
  },
  project: {
    name: 'forge',
    repository: 'moretea-labs/forge',
    branch: 'main',
    worktree: 'canonical checkout',
    sourceRevision: 'preview',
  },
  work: {
    workId: 'work-forge-v3-client-development-v1',
    title: 'Forge V3 client development',
    semanticState: 'open',
    relationLabel: 'Current Work',
    controller: 'ChatGPT',
    currentFocus: 'Desktop projection, automatic continuation inspection, and exact conversation binding.',
  },
  automaticContinuations: [
    {
      taskId: 'forge:repo-preview:work:work-forge-v3-client-development-v1',
      workId: 'work-forge-v3-client-development-v1',
      title: 'Automatic continuation',
      objective: 'Continue Forge V3 client development until a reviewable delivery or an explicit user blocker.',
      status: 'running',
      statusLabel: 'Running',
      detail: 'Workflow Supervisor owns the next outer turn. The desktop only projects its state.',
      conversation: {
        conversationId: '00000000-0000-4000-8000-000000000001',
        conversationUrl: 'https://chatgpt.com/c/00000000-0000-4000-8000-000000000001',
        title: 'Forge V3 client development',
      },
      nextAction: 'Wait for the current turn, or explicitly switch this task to a fresh conversation.',
    },
  ],
});

export interface ForgeRuntimeProjectionPort {
  readProjection(): Promise<ForgeDesktopProjection>;
}

export interface ForgeRuntimeCommandPort {
  switchAutomaticContinuationConversation(input: {
    taskId: string;
    expectedConversationId: string;
    reason: string;
  }): Promise<{
    taskId: string;
    status: 'switching_to_fresh_conversation' | 'unchanged';
  }>;
}
