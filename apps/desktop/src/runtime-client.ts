import { invoke } from '@tauri-apps/api/core';
import type {
  AutomaticContinuationTaskProjection,
  ControllerConnectionProjection,
  ForgeDesktopProjection,
  ProjectListItemProjection,
  ProjectPlanProjection,
  PlanRevisionProjection,
  ProjectRequirementProjection,
  UserRequestProjection,
  WorkExecutionEvidenceProjection,
  WorkRevisionProjection,
  WorkGraphEdgeProjection,
  WorkGraphNodeProjection,
  WorkSemanticState,
} from './runtime-projection';

interface RawSupervisorTask {
  taskId: string;
  conversationId: string;
  conversationUrl: string;
  objective: string;
  completionContract?: Record<string, unknown>;
  continuationPolicy?: Record<string, unknown>;
  createdAt?: string;
}

interface SupervisorListResult {
  tasks?: RawSupervisorTask[];
}

interface RawRepository {
  repoId: string;
  displayName: string;
  checkoutId?: string;
  remoteUrl?: string;
  defaultBranch?: string;
}

interface ProjectListResult {
  repositories?: RawRepository[];
  preferredRepoId?: string | null;
}

interface RawPlanSummary {
  planId: string;
  revision: number;
  requirementId?: string;
  goal: string;
  status: string;
  updatedAt?: string;
  recordedAt?: string;
  items?: Array<{ id: string; objective: string }>;
}

interface RawRequirement {
  requirementId: string;
  revision: number;
  title: string;
  outcomeStatement: string;
  state: string;
  acceptanceCriteria?: string[];
  updatedAt?: string;
}

interface RawRequirementDetailResult {
  data?: { requirement?: RawRequirement };
}

interface RawPlanDetailResult {
  data?: {
    plan?: RawPlanSummary;
    revisionHistory?: RawPlanSummary[];
  };
}

interface RawUserRequest {
  requestId: string;
  kind: 'user_action_request' | 'user_decision_request';
  title: string;
  summary: string;
  actionRequired: 'login' | 'grant_permission' | 'confirm_destructive' | 'product_decision';
  status: string;
  targetScope?: { repoId?: string; workId?: string };
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

interface RawWorkListResult {
  data?: {
    works?: RawWorkView[];
    recentHistory?: RawWorkView[];
    bounded?: boolean;
  };
}

interface RawWorkView {
  workId: string;
  revision?: number;
  objective: string;
  state: WorkSemanticState;
  semanticParentWorkId?: string;
  dependsOnWorkIds?: string[];
  requirementId?: string;
  planId?: string;
  resultRefs?: string[];
  updatedAt?: string;
  recordedAt?: string;
}

interface RawWorkDetailResult {
  data?: {
    work?: RawWorkView;
    revisionHistory?: RawWorkView[];
    executionEvidence?: WorkExecutionEvidenceProjection;
    continuation?: {
      continuationPrompt?: string;
      nextSafeAction?: string;
      reconciliationRequired?: boolean;
    };
    objectiveGraph?: {
      current?: {
        nodes?: RawWorkView[];
        edges?: WorkGraphEdgeProjection[];
        truncated?: boolean;
      };
    };
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

function textField(record: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function repositoryLabel(repository: RawRepository): string {
  const remote = repository.remoteUrl?.trim();
  if (!remote) return repository.displayName;
  const github = remote.match(/github\.com[/:]([^/]+\/[^/.]+)(?:\.git)?$/i);
  return github?.[1] ?? repository.displayName;
}

function localizeRuntimeError(error: unknown): Error {
  const raw = error instanceof Error ? error.message : String(error);
  const messages: Record<string, string> = {
    FORGE_DESKTOP_RUNTIME_CONFIG_UNAVAILABLE: '未找到 Forge 运行时配置。',
    FORGE_DESKTOP_RUNTIME_CONFIG_INVALID: 'Forge 运行时配置无法读取。',
    FORGE_DESKTOP_RUNTIME_UNREACHABLE: 'Forge 运行时当前不可达。',
    FORGE_DESKTOP_RUNTIME_TOKEN_UNAVAILABLE: 'Forge 运行时认证信息不可用。',
    AUTOMATIC_CONTINUATION_EXACT_CONVERSATION_REQUIRED: '当前自动推进任务尚未绑定可切换的精确会话。',
  };
  return new Error(messages[raw] ?? raw);
}

function projectTask(task: RawSupervisorTask): AutomaticContinuationTaskProjection {
  const switching = task.conversationId.startsWith('bootstrap:');
  const workId = textField(task.completionContract, 'work_id') ?? textField(task.continuationPolicy, 'work_id');
  const repoId = textField(task.completionContract, 'repo_id') ?? textField(task.continuationPolicy, 'repo_id');
  const requirementId = textField(task.completionContract, 'requirement_id');
  const exactConversation = !switching && /\/c\//.test(task.conversationUrl);
  return {
    taskId: task.taskId,
    ...(workId ? { workId } : {}),
    title: workId ? '自动推进' : '独立自动推进',
    objective: task.objective,
    status: switching ? 'switching_conversation' : 'running',
    statusLabel: switching ? '正在切换会话' : '推进中',
    detail: switching
      ? '自动推进监督器正在创建并绑定新的精确 ChatGPT 会话。'
      : '自动推进监督器负责该任务的下一轮外层推进。',
    conversation: exactConversation ? {
      conversationId: task.conversationId,
      conversationUrl: task.conversationUrl,
    } : null,
    nextAction: switching
      ? '等待新会话的接管消息被观察并完成绑定。'
      : '继续已绑定会话，或显式切换到新的 ChatGPT 会话。',
    ...(repoId ? { repoId } : {}),
    ...(requirementId ? { requirementId } : {}),
    ...(task.createdAt ? { createdAt: task.createdAt } : {}),
  };
}

function graphNode(work: RawWorkView): WorkGraphNodeProjection {
  return {
    workId: work.workId,
    objective: work.objective,
    state: work.state,
    ...(work.semanticParentWorkId ? { semanticParentWorkId: work.semanticParentWorkId } : {}),
    dependsOnWorkIds: work.dependsOnWorkIds ?? [],
  };
}

export async function readLocalProviderStatus(): Promise<LocalProviderStatusProjection> {
  try {
    return await invoke<LocalProviderStatusProjection>('read_local_provider_status');
  } catch (error) {
    throw localizeRuntimeError(error);
  }
}

export async function sendLocalConversation(input: {
  conversationId: string;
  providerSessionId?: string;
  prompt: string;
  repoId?: string;
}): Promise<LocalConversationSendProjection> {
  try {
    return await invoke<LocalConversationSendProjection>('send_local_conversation', {
      conversationId: input.conversationId,
      providerSessionId: input.providerSessionId,
      prompt: input.prompt,
      repoId: input.repoId,
    });
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

export async function readAutomaticContinuations(): Promise<AutomaticContinuationTaskProjection[]> {
  try {
    const result = await invoke<SupervisorListResult>('read_automatic_continuations');
    return (result.tasks ?? []).map(projectTask);
  } catch (error) {
    throw localizeRuntimeError(error);
  }
}

export async function readProjectWorkspace(
  project: ProjectListItemProjection,
  selectedWorkId?: string,
): Promise<Pick<ForgeDesktopProjection, 'project' | 'workGraph' | 'recentWorkHistory' | 'work' | 'requirement' | 'plan' | 'userRequests'>> {
  try {
    const [overview, workList] = await Promise.all([
      invoke<RawProjectOverviewResult>('read_project_overview', { repoId: project.repoId }),
      invoke<RawWorkListResult>('read_project_work_list', { repoId: project.repoId }),
    ]);
    const repositoryState = overview.data?.repositoryState;
    const activeWork = workList.data?.works ?? [];
    const targetWorkId = selectedWorkId;

    let detail: RawWorkDetailResult | undefined;
    if (targetWorkId) {
      detail = await invoke<RawWorkDetailResult>('read_work_detail', { repoId: project.repoId, workId: targetWorkId });
    }

    const selectedWork = detail?.data?.work;
    const graph = detail?.data?.objectiveGraph?.current;
    const nodes = new Map<string, WorkGraphNodeProjection>();
    for (const work of activeWork) nodes.set(work.workId, graphNode(work));
    for (const work of graph?.nodes ?? []) nodes.set(work.workId, graphNode(work));
    if (selectedWork) nodes.set(selectedWork.workId, graphNode(selectedWork));
    const recentWorkHistory = (workList.data?.recentHistory ?? [])
      .filter((work) => !nodes.has(work.workId))
      .map(graphNode);

    const [requirementDetail, planDetail, userRequestResult] = await Promise.all([
      selectedWork?.requirementId
        ? invoke<RawRequirementDetailResult>('read_requirement_detail', { repoId: project.repoId, requirementId: selectedWork.requirementId })
        : Promise.resolve(undefined),
      selectedWork?.planId
        ? invoke<RawPlanDetailResult>('read_plan_detail', { repoId: project.repoId, planId: selectedWork.planId })
        : Promise.resolve(undefined),
      invoke<RawUserRequestListResult>('read_user_requests'),
    ]);
    const rawRequirement = requirementDetail?.data?.requirement;
    const requirement: ProjectRequirementProjection | null = rawRequirement ? {
      requirementId: rawRequirement.requirementId,
      revision: rawRequirement.revision,
      title: rawRequirement.title,
      outcomeStatement: rawRequirement.outcomeStatement,
      state: rawRequirement.state,
      acceptanceCriteria: rawRequirement.acceptanceCriteria ?? [],
      ...(rawRequirement.updatedAt ? { updatedAt: rawRequirement.updatedAt } : {}),
    } : null;
    const userRequests: UserRequestProjection[] = selectedWork
      ? (userRequestResult.data?.items ?? [])
        .filter((item) => item.status === 'pending' && item.targetScope?.workId === selectedWork.workId)
        .map((item) => ({
          requestId: item.requestId,
          kind: item.kind,
          title: item.title,
          summary: item.summary,
          actionRequired: item.actionRequired,
          ...(item.updatedAt ? { updatedAt: item.updatedAt } : {}),
        }))
      : [];
    const workRevisionHistory: WorkRevisionProjection[] = (detail?.data?.revisionHistory ?? []).map((revision) => ({
      revision: revision.revision ?? 1,
      objective: revision.objective,
      state: revision.state,
      resultRefs: revision.resultRefs ?? [],
      ...(revision.updatedAt ? { updatedAt: revision.updatedAt } : {}),
      ...(revision.recordedAt ? { recordedAt: revision.recordedAt } : {}),
    }));
    const selectedPlan = planDetail?.data?.plan;
    const planRevisionHistory: PlanRevisionProjection[] = (planDetail?.data?.revisionHistory ?? []).map((revision) => ({
      revision: revision.revision,
      goal: revision.goal,
      status: revision.status,
      ...(revision.updatedAt ? { updatedAt: revision.updatedAt } : {}),
      ...(revision.recordedAt ? { recordedAt: revision.recordedAt } : {}),
      items: revision.items ?? [],
    }));
    const plan: ProjectPlanProjection | null = selectedPlan ? {
      planId: selectedPlan.planId,
      revision: selectedPlan.revision,
      goal: selectedPlan.goal,
      status: selectedPlan.status,
      ...(selectedPlan.requirementId ? { requirementId: selectedPlan.requirementId } : {}),
      ...(selectedPlan.updatedAt ? { updatedAt: selectedPlan.updatedAt } : {}),
      items: selectedPlan.items ?? [],
      revisionHistory: planRevisionHistory,
    } : null;

    return {
      project: {
        repoId: project.repoId,
        name: project.name,
        repository: project.repository,
        branch: repositoryState?.branch ?? project.defaultBranch ?? '未知分支',
        worktree: project.checkoutId ? '已选择检出' : '未选择检出',
        sourceRevision: repositoryState?.head ?? '未知版本',
        dirty: Boolean(repositoryState?.dirty),
      },
      workGraph: {
        nodes: [...nodes.values()],
        edges: graph?.edges ?? [],
        truncated: graph?.truncated ?? false,
      },
      recentWorkHistory,
      work: selectedWork ? {
        workId: selectedWork.workId,
        revision: selectedWork.revision ?? 1,
        title: selectedWork.objective,
        objective: selectedWork.objective,
        semanticState: selectedWork.state,
        relationLabel: selectedWork.semanticParentWorkId ? '子工作' : '当前工作',
        ...(detail?.data?.continuation?.continuationPrompt ? { continuationPrompt: detail.data.continuation.continuationPrompt } : {}),
        ...(detail?.data?.continuation?.nextSafeAction ? { nextSafeAction: detail.data.continuation.nextSafeAction } : {}),
        ...(selectedWork.semanticParentWorkId ? { semanticParentWorkId: selectedWork.semanticParentWorkId } : {}),
        dependsOnWorkIds: selectedWork.dependsOnWorkIds ?? [],
        ...(selectedWork.requirementId ? { requirementId: selectedWork.requirementId } : {}),
        ...(selectedWork.planId ? { planId: selectedWork.planId } : {}),
        ...(selectedWork.updatedAt ? { updatedAt: selectedWork.updatedAt } : {}),
        resultRefs: selectedWork.resultRefs ?? [],
        revisionHistory: workRevisionHistory,
        ...(detail?.data?.executionEvidence ? { executionEvidence: detail.data.executionEvidence } : {}),
      } : null,
      requirement,
      plan,
      userRequests,
    };
  } catch (error) {
    throw localizeRuntimeError(error);
  }
}

export async function continueWork(repoId: string, workId: string, prompt: string): Promise<void> {
  try {
    await invoke('continue_work', { repoId, workId, prompt });
  } catch (error) {
    throw localizeRuntimeError(error);
  }
}

export async function switchAutomaticContinuationConversation(task: AutomaticContinuationTaskProjection): Promise<void> {
  if (!task.conversation) throw localizeRuntimeError(new Error('AUTOMATIC_CONTINUATION_EXACT_CONVERSATION_REQUIRED'));
  try {
    await invoke('switch_automatic_continuation_conversation', {
      taskId: task.taskId,
      expectedConversationId: task.conversation.conversationId,
      reason: '用户从 Forge 桌面客户端显式要求切换到新的会话。',
    });
  } catch (error) {
    throw localizeRuntimeError(error);
  }
}
