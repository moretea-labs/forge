import { invoke } from '@tauri-apps/api/core';
import type {
  AutomaticContinuationTaskProjection,
  ForgeDesktopProjection,
  ProjectListItemProjection,
  ProjectPlanProjection,
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

interface RawWorkSummary {
  workId: string;
  state: WorkSemanticState;
  objective: string;
  nextSafeAction?: string;
  semantics?: { state?: WorkSemanticState };
}

interface RawPlanSummary {
  planId: string;
  revision: number;
  requirementId?: string;
  goal: string;
  status: string;
}

interface RawProjectOverviewResult {
  data?: {
    repositoryState?: { branch?: string; head?: string | null };
    controllerSnapshot?: {
      activeWork?: RawWorkSummary[];
      activePlans?: RawPlanSummary[];
    };
  };
}

interface RawWorkView {
  workId: string;
  objective: string;
  state: WorkSemanticState;
  semanticParentWorkId?: string;
  dependsOnWorkIds?: string[];
  requirementId?: string;
  planId?: string;
  resultRefs?: string[];
}

interface RawWorkDetailResult {
  data?: {
    work?: RawWorkView;
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
  };
}

function graphNode(work: RawWorkView | RawWorkSummary): WorkGraphNodeProjection {
  const detailed = work as RawWorkView;
  const summary = work as RawWorkSummary;
  return {
    workId: work.workId,
    objective: work.objective,
    state: work.state,
    ...(detailed.semanticParentWorkId ? { semanticParentWorkId: detailed.semanticParentWorkId } : {}),
    dependsOnWorkIds: detailed.dependsOnWorkIds ?? [],
    ...(summary.nextSafeAction ? { nextSafeAction: summary.nextSafeAction } : {}),
  };
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
): Promise<Pick<ForgeDesktopProjection, 'project' | 'workGraph' | 'work' | 'plan'>> {
  try {
    const overview = await invoke<RawProjectOverviewResult>('read_project_overview', { repoId: project.repoId });
    const repositoryState = overview.data?.repositoryState;
    const activeWork = overview.data?.controllerSnapshot?.activeWork ?? [];
    const activePlans = overview.data?.controllerSnapshot?.activePlans ?? [];
    const targetWorkId = selectedWorkId ?? activeWork[0]?.workId;

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

    const selectedPlan = selectedWork?.planId
      ? activePlans.find((plan) => plan.planId === selectedWork.planId)
      : undefined;
    const plan: ProjectPlanProjection | null = selectedPlan ? {
      planId: selectedPlan.planId,
      revision: selectedPlan.revision,
      goal: selectedPlan.goal,
      status: selectedPlan.status,
      ...(selectedPlan.requirementId ? { requirementId: selectedPlan.requirementId } : {}),
    } : null;

    return {
      project: {
        repoId: project.repoId,
        name: project.name,
        repository: project.repository,
        branch: repositoryState?.branch ?? project.defaultBranch ?? '未知分支',
        worktree: project.checkoutId ? '已选择检出' : '未选择检出',
        sourceRevision: repositoryState?.head ?? '未知版本',
      },
      workGraph: {
        nodes: [...nodes.values()],
        edges: graph?.edges ?? [],
        truncated: graph?.truncated ?? false,
      },
      work: selectedWork ? {
        workId: selectedWork.workId,
        title: selectedWork.objective,
        objective: selectedWork.objective,
        semanticState: selectedWork.state,
        relationLabel: selectedWork.semanticParentWorkId ? '子工作' : '当前工作',
        currentFocus: selectedWork.objective,
        ...(selectedWork.requirementId ? { requirementId: selectedWork.requirementId } : {}),
        ...(selectedWork.planId ? { planId: selectedWork.planId } : {}),
        resultRefs: selectedWork.resultRefs ?? [],
      } : null,
      plan,
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
