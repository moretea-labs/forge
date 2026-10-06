export type RuntimeConnectionStatus = 'not_connected' | 'connecting' | 'connected' | 'degraded';
export type ProjectionSource = 'runtime' | 'disconnected' | 'design_preview';
export type AutomaticContinuationStatus = 'running' | 'waiting' | 'needs_user' | 'completed' | 'stopped' | 'switching_conversation';
export type WorkSemanticState = 'open' | 'completed' | 'cancelled';

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

export interface ProjectListItemProjection {
  repoId: string;
  name: string;
  repository: string;
  checkoutId?: string;
  defaultBranch?: string;
}

export interface WorkGraphNodeProjection {
  workId: string;
  objective: string;
  state: WorkSemanticState;
  semanticParentWorkId?: string;
  dependsOnWorkIds: string[];
  activity?: string;
  nextSafeAction?: string;
}

export interface WorkGraphEdgeProjection {
  kind: 'decomposition' | 'dependency';
  fromWorkId: string;
  toWorkId: string;
}

export interface ProjectRequirementProjection {
  requirementId: string;
  revision: number;
  title: string;
  outcomeStatement: string;
  state: string;
  acceptanceCriteria: string[];
  updatedAt?: string;
}

export interface ProjectPlanProjection {
  planId: string;
  revision: number;
  goal: string;
  status: string;
  requirementId?: string;
  updatedAt?: string;
  items: Array<{ id: string; objective: string }>;
}

export interface RecoveryProbeProjection {
  id: string;
  label: string;
  ok: boolean;
}

export interface RuntimeRecoveryProjection {
  recovery: {
    available: boolean;
    label: string;
    detail: string;
    host?: string;
    platform?: string;
    releaseRevision?: string;
    watchdogDecision?: string;
    watchdogUpdatedAt?: string;
  };
  runtime: {
    running: boolean;
    ready: boolean;
    stale: boolean;
    label: string;
    detail: string;
    pid?: number;
    releaseId?: string;
    endpoint?: string;
    observedAt?: string;
    reasonCount: number;
  };
  diagnostics: {
    checkedAt?: string;
    ok: boolean;
    passed: number;
    failed: number;
    probes: RecoveryProbeProjection[];
  } | null;
}

export interface ForgeDesktopProjection {
  source: ProjectionSource;
  runtime: {
    status: RuntimeConnectionStatus;
    label: string;
    detail: string;
  };
  projects: ProjectListItemProjection[];
  project: {
    repoId: string;
    name: string;
    repository: string;
    branch: string;
    worktree: string;
    sourceRevision: string;
    dirty: boolean;
  } | null;
  workGraph: {
    nodes: WorkGraphNodeProjection[];
    edges: WorkGraphEdgeProjection[];
    truncated: boolean;
  };
  work: {
    workId: string;
    revision: number;
    title: string;
    objective: string;
    semanticState: WorkSemanticState;
    relationLabel?: string;
    currentFocus?: string;
    nextSafeAction?: string;
    semanticParentWorkId?: string;
    dependsOnWorkIds: string[];
    requirementId?: string;
    planId?: string;
    updatedAt?: string;
    resultRefs: string[];
  } | null;
  requirement: ProjectRequirementProjection | null;
  plan: ProjectPlanProjection | null;
  automaticContinuations: AutomaticContinuationTaskProjection[];
}

/**
 * 仅用于断开连接时的展示值。Requirement、Plan、Work、Controller、Scheduler
 * 和 connection facts 仍由 Forge Runtime 持有权威；桌面端不持久化语义副本。
 */
export const disconnectedProjection = Object.freeze<ForgeDesktopProjection>({
  source: 'disconnected',
  runtime: {
    status: 'not_connected',
    label: '运行时未连接',
    detail: '桌面客户端已启动，但尚未读取到 Forge 运行时投影。',
  },
  projects: [],
  project: null,
  workGraph: { nodes: [], edges: [], truncated: false },
  work: null,
  requirement: null,
  plan: null,
  automaticContinuations: [],
});

/**
 * 显式设计预览数据。仅在 ?preview=1 时启用，不得作为 Runtime 事实。
 */
export const designPreviewProjection = Object.freeze<ForgeDesktopProjection>({
  source: 'design_preview',
  runtime: {
    status: 'connected',
    label: '运行时正常',
    detail: '当前为设计预览；正式客户端中的数据来自 Forge 运行时权威投影。',
  },
  projects: [
    { repoId: 'repo-preview-forge', name: 'forge', repository: 'moretea-labs/forge', defaultBranch: 'main' },
    { repoId: 'repo-preview-avela', name: 'Avela', repository: 'greysonOuyang/yaozhunshi', defaultBranch: 'main' },
    { repoId: 'repo-preview-knowledge', name: 'Knowledge', repository: 'personal-knowledge-system', defaultBranch: 'main' },
  ],
  project: {
    repoId: 'repo-preview-forge',
    name: 'forge',
    repository: 'moretea-labs/forge',
    branch: 'main',
    worktree: '主检出',
    sourceRevision: '设计预览',
    dirty: false,
  },
  workGraph: {
    nodes: [
      { workId: 'work-ia', objective: '冻结 MCP-first 信息架构', state: 'completed', dependsOnWorkIds: [] },
      { workId: 'work-foundation', objective: '完成桌面客户端基础壳层', state: 'completed', semanticParentWorkId: 'work-ia', dependsOnWorkIds: [] },
      { workId: 'work-mcp', objective: '接通项目、Work 与自动推进的 Runtime 投影', state: 'open', semanticParentWorkId: 'work-ia', dependsOnWorkIds: ['work-foundation'] },
      { workId: 'work-recovery', objective: '补齐运行时与恢复界面', state: 'open', semanticParentWorkId: 'work-ia', dependsOnWorkIds: [] },
    ],
    edges: [
      { kind: 'decomposition', fromWorkId: 'work-ia', toWorkId: 'work-foundation' },
      { kind: 'decomposition', fromWorkId: 'work-ia', toWorkId: 'work-mcp' },
      { kind: 'decomposition', fromWorkId: 'work-ia', toWorkId: 'work-recovery' },
      { kind: 'dependency', fromWorkId: 'work-foundation', toWorkId: 'work-mcp' },
    ],
    truncated: false,
  },
  work: {
    workId: 'work-mcp',
    revision: 3,
    title: '接通项目、Work 与自动推进的 Runtime 投影',
    objective: '围绕 Forge canonical projection 完成项目工作台，不在客户端复制 Work 生命周期或图权威。',
    semanticState: 'open',
    relationLabel: '当前工作',
    currentFocus: '项目列表、Work 选择、依赖关系与会话继续全部通过现有 MCP 权威读取和执行。',
    nextSafeAction: '继续把 Forge canonical facts 投影到当前工作面。',
    semanticParentWorkId: 'work-ia',
    dependsOnWorkIds: ['work-foundation'],
    requirementId: 'REQ-forge-v3-desktop-client-20260930',
    planId: 'PLAN-forge-v3-desktop-client-20260930-r1',
    updatedAt: '2026-10-06T03:40:00.000Z',
    resultRefs: ['path:apps/desktop', 'adr:forge-v3-desktop-client-boundary'],
  },
  requirement: {
    requirementId: 'REQ-forge-v3-desktop-client-20260930',
    revision: 1,
    title: 'Forge V3 Desktop Client',
    outcomeStatement: '交付第一方 macOS Forge 客户端，同时保持 Forge Runtime 与语义事实的单一权威。',
    state: 'open',
    acceptanceCriteria: ['macOS 日间模式', '客户端不复制 Forge 语义权威'],
    updatedAt: '2026-09-30T11:38:34.129Z',
  },
  plan: {
    planId: 'PLAN-forge-v3-desktop-client-20260930-r1',
    revision: 1,
    goal: '交付 Forge V3 桌面客户端，并保持 Runtime / Controller 单一权威。',
    status: 'draft',
    requirementId: 'REQ-forge-v3-desktop-client-20260930',
    updatedAt: '2026-10-04T11:45:31.464Z',
    items: [
      { id: 'v3-4-runtime-recovery-bootstrap', objective: '完成运行时与恢复纵向闭环' },
      { id: 'v3-5-mcp-assistant-projects', objective: '完成 Assistant、Projects 与 Work 的真实事实投影' },
    ],
  },
  automaticContinuations: [
    {
      taskId: 'forge:repo-preview:work:work-mcp',
      workId: 'work-mcp',
      title: '自动推进',
      objective: '继续 Forge V3 客户端开发，直到形成可审查交付或明确需要用户处理的阻塞。',
      status: 'running',
      statusLabel: '推进中',
      detail: '自动推进监督器负责下一轮外层推进；桌面端只展示其权威状态。',
      conversation: {
        conversationId: '00000000-0000-4000-8000-000000000001',
        conversationUrl: 'https://chatgpt.com/c/00000000-0000-4000-8000-000000000001',
        title: 'Forge V3 客户端开发',
      },
      nextAction: '继续当前会话，或显式切换到新的 ChatGPT 会话。',
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
