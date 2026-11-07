import { invoke } from '@tauri-apps/api/core';
import type {
  ControllerConnectionProjection,
  ForgeDesktopProjection,
  ProjectCheckoutProjection,
  ProjectListItemProjection,
  UserRequestProjection,
} from './runtime-projection';

interface RawRepository {
  repoId: string;
  displayName: string;
  localRoot?: string;
  checkoutId?: string;
  remoteUrl?: string;
  defaultBranch?: string;
}

interface ProjectListResult {
  repositories?: RawRepository[];
  preferredRepoId?: string | null;
}

interface RawUserRequest {
  requestId: string;
  kind: 'user_action_request' | 'user_decision_request';
  title: string;
  summary: string;
  actionRequired: 'login' | 'grant_permission' | 'confirm_destructive' | 'product_decision';
  status: string;
  targetScope?: { repoId?: string };
  updatedAt?: string;
}

interface RawUserRequestListResult {
  data?: { items?: RawUserRequest[] };
}

interface RawProjectOverviewResult {
  data?: {
    repositoryState?: { branch?: string; head?: string | null; dirty?: boolean };
  };
}

interface RawProjectRepositoryResult {
  repository?: {
    activeCheckoutId?: string;
    checkoutCount?: number;
    activeCheckoutCount?: number;
    truncated?: boolean;
    checkouts?: Array<{
      checkoutId?: string;
      path?: string;
      branch?: string | null;
      worktree?: boolean;
      lifecycle?: 'active' | 'archived' | 'removed';
      active?: boolean;
    }>;
  };
}

export interface ProjectCatalogProjection {
  projects: ProjectListItemProjection[];
  preferredRepoId?: string;
}

export interface LocalProviderStatusProjection {
  provider?: 'codex';
  status: 'ready' | 'not_configured' | 'unavailable';
  label: string;
  detail: string;
  streaming: boolean;
  tools: boolean;
  cancellable?: boolean;
}

export interface LocalConversationSendProjection {
  provider: 'codex';
  status: 'completed';
  conversationId: string;
  providerSessionId: string;
  output: string;
  toolActivityCount: number;
}

export function tauriRuntimeAvailable(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

export function repositoryLabel(repository: RawRepository): string {
  const remote = repository.remoteUrl?.trim();
  if (!remote) {
    const parts = repository.localRoot?.replace(/\\/g, '/').split('/').filter(Boolean) ?? [];
    return parts[parts.length - 1] ?? repository.displayName;
  }
  const github = remote.match(/github\.com[/:]([^/]+\/[^/.]+)(?:\.git)?$/i);
  return github?.[1] ?? repository.displayName;
}

function localizeRuntimeError(error: unknown): Error {
  const raw = error instanceof Error ? error.message : String(error);
  const messages: Record<string, string> = {
    FORGE_DESKTOP_RUNTIME_CONFIG_UNAVAILABLE: '未找到 Forge 运行时配置。',
    FORGE_DESKTOP_RUNTIME_CONFIG_INVALID: 'Forge 运行时配置无法读取。',
    FORGE_DESKTOP_RUNTIME_UNREACHABLE: 'Forge 运行时当前不可达。',
    FORGE_DESKTOP_RUNTIME_TOKEN_UNAVAILABLE: 'Forge Runtime 访问凭据不可用。',
  };
  return new Error(messages[raw] ?? raw);
}

export async function readLocalProviderStatus(): Promise<LocalProviderStatusProjection> {
  try {
    return await invoke<LocalProviderStatusProjection>('read_local_provider_status');
  } catch (error) {
    throw localizeRuntimeError(error);
  }
}

export async function cancelLocalConversation(conversationId: string): Promise<void> {
  const receipt = await invoke<{ requested: boolean }>('cancel_local_conversation', { conversationId });
  if (receipt.requested !== true) throw Error('FORGE_DESKTOP_LOCAL_CONVERSATION_CANCEL_UNCONFIRMED');
}

export async function sendLocalConversation(input: {
  conversationId: string;
  providerSessionId?: string;
  prompt: string;
  repoId?: string;
  checkoutId?: string;
}): Promise<LocalConversationSendProjection> {
  try {
    return await invoke<LocalConversationSendProjection>('send_local_conversation', {
      conversationId: input.conversationId,
      providerSessionId: input.providerSessionId,
      prompt: input.prompt,
      repoId: input.repoId,
      checkoutId: input.checkoutId,
    });
  } catch (error) {
    throw localizeRuntimeError(error);
  }
}

export interface KnowledgeAuditProjection {
  readonly: boolean;
  advisoryOnly: boolean;
  scopes: Array<{ kind: string; id: string }>;
  items: Array<{
    memory: {
      id: string;
      revision: number;
      canonicalText: string;
      concepts: string[];
      facets: string[];
      confidence: number;
      scope: { kind: string; id: string };
      provenance?: { sourceKind?: string; recordedAt?: string };
    };
  }>;
  inspected: number;
  truncated: boolean;
  gaps: string[];
}

export async function readProjectKnowledge(input: {
  repoId: string;
  query: string;
}): Promise<KnowledgeAuditProjection> {
  try {
    return await invoke<KnowledgeAuditProjection>('read_project_knowledge', input);
  } catch (error) {
    throw localizeRuntimeError(error);
  }
}

export async function readConnectionStatus(): Promise<ControllerConnectionProjection> {
  try {
    return await invoke<ControllerConnectionProjection>('read_connection_status');
  } catch (error) {
    throw localizeRuntimeError(error);
  }
}

export async function repairConnection(): Promise<ControllerConnectionProjection> {
  try {
    const result = await invoke<{ connection?: ControllerConnectionProjection }>('repair_connection');
    if (!result.connection) throw new Error('FORGE_DESKTOP_CONNECTION_RESULT_INVALID');
    return result.connection;
  } catch (error) {
    throw localizeRuntimeError(error);
  }
}

export async function readProjects(): Promise<ProjectCatalogProjection> {
  try {
    const result = await invoke<ProjectListResult>('read_projects');
    const projects = (result.repositories ?? []).map((repository): ProjectListItemProjection => ({
      repoId: repository.repoId,
      name: repository.displayName,
      repository: repositoryLabel(repository),
      ...(repository.localRoot ? { localRoot: repository.localRoot } : {}),
      ...(repository.checkoutId ? { checkoutId: repository.checkoutId } : {}),
      ...(repository.defaultBranch ? { defaultBranch: repository.defaultBranch } : {}),
    }));
    return {
      projects,
      ...(result.preferredRepoId ? { preferredRepoId: result.preferredRepoId } : {}),
    };
  } catch (error) {
    throw localizeRuntimeError(error);
  }
}

export async function readProjectWorkspace(
  project: ProjectListItemProjection,
): Promise<Pick<ForgeDesktopProjection, 'project' | 'requirement' | 'plan' | 'userRequests'>> {
  try {
    const [overview, repositoryDetail, userRequestResult] = await Promise.all([
      invoke<RawProjectOverviewResult>('read_project_overview', { repoId: project.repoId }),
      invoke<RawProjectRepositoryResult>('read_project_repository', { repoId: project.repoId }),
      invoke<RawUserRequestListResult>('read_user_requests'),
    ]);
    const repositoryState = overview.data?.repositoryState;
    const repository = repositoryDetail.repository;
    if (!repository?.activeCheckoutId || !Array.isArray(repository.checkouts)) {
      throw new Error('FORGE_DESKTOP_REPOSITORY_DETAIL_INVALID');
    }
    const checkouts: ProjectCheckoutProjection[] = repository.checkouts.map((entry) => ({
      checkoutId: entry.checkoutId ?? '未知检出',
      path: entry.path ?? '未知路径',
      ...(entry.branch ? { branch: entry.branch } : {}),
      kind: entry.worktree ? 'worktree' : 'primary',
      lifecycle: entry.lifecycle ?? 'active',
      active: entry.active === true,
    }));
    const activeCheckout = checkouts.find((entry) => entry.active)
      ?? checkouts.find((entry) => entry.checkoutId === repository.activeCheckoutId);
    if (!activeCheckout) throw new Error('FORGE_DESKTOP_REPOSITORY_ACTIVE_CHECKOUT_MISSING');
    const userRequests: UserRequestProjection[] = (userRequestResult.data?.items ?? [])
      .filter((item) => item.status === 'pending' && item.targetScope?.repoId === project.repoId)
      .map((item) => ({
        requestId: item.requestId,
        kind: item.kind,
        title: item.title,
        summary: item.summary,
        actionRequired: item.actionRequired,
        ...(item.updatedAt ? { updatedAt: item.updatedAt } : {}),
      }));
    return {
      project: {
        repoId: project.repoId,
        name: project.name,
        repository: project.repository,
        branch: repositoryState?.branch ?? activeCheckout.branch ?? project.defaultBranch ?? '未知分支',
        worktree: activeCheckout.kind === 'worktree' ? 'Git worktree' : '主检出',
        checkoutId: repository.activeCheckoutId,
        checkoutPath: activeCheckout.path,
        checkoutCount: repository.checkoutCount ?? checkouts.length,
        activeCheckoutCount: repository.activeCheckoutCount ?? checkouts.length,
        checkoutListTruncated: repository.truncated === true,
        checkouts,
        sourceRevision: repositoryState?.head ?? '未知版本',
        dirty: Boolean(repositoryState?.dirty),
      },
      requirement: null,
      plan: null,
      userRequests,
    };
  } catch (error) {
    throw localizeRuntimeError(error);
  }
}
