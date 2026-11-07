export type RuntimeConnectionStatus = 'not_connected' | 'connecting' | 'connected' | 'degraded';
export type ProjectionSource = 'runtime' | 'disconnected' | 'design_preview';

export interface UserRequestProjection {
  requestId: string;
  kind: 'user_action_request' | 'user_decision_request';
  title: string;
  summary: string;
  actionRequired: 'login' | 'grant_permission' | 'confirm_destructive' | 'product_decision';
  updatedAt?: string;
}

export interface ProjectListItemProjection {
  repoId: string;
  name: string;
  repository: string;
  localRoot?: string;
  checkoutId?: string;
  defaultBranch?: string;
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
  requirementId?: string;
  updatedAt?: string;
  items: Array<{ id: string; objective: string }>;
}

export interface RecoveryProbeProjection {
  id: string;
  label: string;
  ok: boolean;
}

export interface RecoveryHistoryEntryProjection {
  at: string;
  event: string;
  label: string;
  ok?: boolean;
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
  history: RecoveryHistoryEntryProjection[];
  diagnostics: {
    checkedAt?: string;
    ok: boolean;
    passed: number;
    failed: number;
    probes: RecoveryProbeProjection[];
  } | null;
}

export interface ControllerConnectionProjection {
  schemaVersion: 1;
  configured: boolean;
  ready: boolean;
  profile?: {
    primaryController: string;
    controllers: string[];
    tunnelProvider: string;
  };
  controller: {
    ready: boolean;
    controller?: string;
    title: string;
    detail: string;
  };
  tunnel: {
    ready: boolean;
    provider: string;
    title: string;
    detail: string;
  };
  repair: {
    available: boolean;
    action: 'repair_connector';
    label: string;
  };
}

export interface ProjectCheckoutProjection {
  checkoutId: string;
  path: string;
  branch?: string;
  kind: 'primary' | 'worktree';
  lifecycle: 'active' | 'archived' | 'removed';
  active: boolean;
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
    checkoutId: string;
    checkoutPath: string;
    checkoutCount: number;
    activeCheckoutCount: number;
    checkoutListTruncated: boolean;
    checkouts: ProjectCheckoutProjection[];
    sourceRevision: string;
    dirty: boolean;
  } | null;
  requirement: ProjectRequirementProjection | null;
  plan: ProjectPlanProjection | null;
  userRequests: UserRequestProjection[];
}

/** Read-only fallback. Runtime and semantic authorities remain in Forge. */
export const disconnectedProjection = Object.freeze<ForgeDesktopProjection>({
  source: 'disconnected',
  runtime: {
    status: 'not_connected',
    label: '运行时未连接',
    detail: '桌面客户端已启动，但尚未读取到 Forge 运行时投影。',
  },
  projects: [],
  project: null,
  requirement: null,
  plan: null,
  userRequests: [],
});

export const designPreviewProjection = Object.freeze<ForgeDesktopProjection>({
  source: 'design_preview',
  runtime: {
    status: 'connected',
    label: '设计预览',
    detail: '示例数据仅用于 Desktop UI 预览。',
  },
  projects: [{
    repoId: 'preview-forge',
    name: 'Forge',
    repository: 'moretea-labs/forge',
    localRoot: '/Users/preview/forge',
    checkoutId: 'checkout-preview',
    defaultBranch: 'main',
  }],
  project: {
    repoId: 'preview-forge',
    name: 'Forge',
    repository: 'moretea-labs/forge',
    branch: 'main',
    worktree: '主检出',
    checkoutId: 'checkout-preview',
    checkoutPath: '/Users/preview/forge',
    checkoutCount: 1,
    activeCheckoutCount: 1,
    checkoutListTruncated: false,
    checkouts: [{
      checkoutId: 'checkout-preview',
      path: '/Users/preview/forge',
      branch: 'main',
      kind: 'primary',
      lifecycle: 'active',
      active: true,
    }],
    sourceRevision: '0123456789abcdef',
    dirty: false,
  },
  requirement: {
    requirementId: 'REQ-forge-v3-desktop-client',
    revision: 1,
    title: 'Forge Desktop Client',
    outcomeStatement: '提供第一方 macOS 客户端，并保持 Runtime 与项目事实的单一权威。',
    state: 'open',
    acceptanceCriteria: ['原生桌面体验', '不复制 Forge 语义权威'],
  },
  plan: {
    planId: 'PLAN-forge-v3-desktop-client-r1',
    revision: 1,
    goal: '交付 Forge Desktop 的 Project、Agent 与 Runtime 体验。',
    requirementId: 'REQ-forge-v3-desktop-client',
    items: [
      { id: 'project', objective: '展示 repository / checkout 项目事实' },
      { id: 'agent', objective: '提供项目绑定的本地 Agent 会话' },
    ],
  },
  userRequests: [{
    requestId: 'preview-user-request',
    kind: 'user_decision_request',
    title: '确认下一阶段产品方向',
    summary: '设计预览示例；正式客户端只展示 Forge Inbox 的真实 pending 请求。',
    actionRequired: 'product_decision',
  }],
});

export interface ForgeRuntimeProjectionPort {
  readProjection(): Promise<ForgeDesktopProjection>;
}
