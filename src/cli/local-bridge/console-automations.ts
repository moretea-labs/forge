import type { RepositoryRecord } from '../repositories/types';
import { listAssistantRoutines } from '../../runtime/assistant/store';
import { runAssistantRoutineNow } from '../../runtime/assistant/intent';
import { getAssistantRoutineScheduleBinding, updateAssistantRoutineLifecycle } from '../../runtime/assistant/schedule-binding';
import { getWorkContract } from '../../runtime/control-plane/facade';
import { evaluateSchedule } from '../../runtime/workflow/schedules/engine';
import { getSchedule, listOccurrences, listSchedules, saveSchedule } from '../../runtime/workflow/schedules/store';
import type { RepositorySchedule, ScheduleOccurrence } from '../../runtime/workflow/schedules/types';

export type ConsoleAutomationMode = 'browser_watch' | 'browser_keepalive' | 'continuation' | 'chatgpt_prompt' | 'routine' | 'schedule';

export interface ConsoleAutomationHistoryView {
  id: string;
  at: string;
  result: string;
  tone: 'green' | 'amber' | 'red' | 'blue' | 'gray';
  reason?: string;
  trigger?: string;
}

export interface ConsoleAutomationView {
  id: string;
  source: 'schedule' | 'routine';
  repoId: string;
  repositoryName: string;
  name: string;
  summary?: string;
  status: 'enabled' | 'paused' | 'attention' | 'disabled';
  schedule: string;
  timezone?: string;
  delivery?: string;
  mode: ConsoleAutomationMode;
  modeLabel: string;
  live?: boolean;
  targetLabel?: string;
  boundWorkId?: string;
  boundWorkObjective?: string;
  observationStatus?: RepositorySchedule['lastObservationStatus'];
  observationAt?: string;
  failureCount?: number;
  policySummary?: string;
  agentModel?: string;
  reasoningLevel?: string;
  tabPolicy?: string;
  lastRunAt?: string;
  lastResult?: string;
  nextRunHint?: string;
  pausedReason?: string;
  history: ConsoleAutomationHistoryView[];
  actions: Array<'run' | 'pause' | 'resume'>;
}

function dailyCronLabel(expression?: string): string | undefined {
  const match = /^(\d{1,2})\s+(\d{1,2})\s+\*\s+\*\s+\*$/.exec(expression?.trim() ?? '');
  if (!match) return undefined;
  const minute = Number(match[1]);
  const hour = Number(match[2]);
  if (minute > 59 || hour > 23) return undefined;
  return `每天 ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

function triggerLabel(schedule: RepositorySchedule): string {
  const trigger = schedule.trigger;
  switch (trigger.type) {
    case 'interval': return `每 ${trigger.everyMinutes ?? '?'} 分钟`;
    case 'cron': return dailyCronLabel(trigger.cronExpression) ?? `Cron ${trigger.cronExpression ?? '—'}`;
    case 'calendar': return trigger.calendarAt ? `单次 · ${trigger.calendarAt}` : '指定时间';
    case 'condition': return `条件满足时 · ${trigger.condition?.kind ?? 'condition'}`;
    case 'repository-event': return `仓库事件 · ${trigger.eventName ?? 'repository event'}`;
    case 'dependency-checkpoint': return '依赖完成时';
    case 'manual': return '仅手动运行';
  }
}

function nextScheduleHint(schedule: RepositorySchedule): string | undefined {
  if (!schedule.enabled) return undefined;
  if (schedule.nextEligibleAt) return schedule.nextEligibleAt;
  if (schedule.trigger.type === 'calendar') return schedule.trigger.calendarAt;
  if (schedule.trigger.type === 'interval' && schedule.trigger.everyMinutes) {
    const base = Date.parse(schedule.lastTriggeredAt ?? schedule.createdAt);
    if (Number.isFinite(base)) {
      const next = base + schedule.trigger.everyMinutes * 60_000;
      return next > Date.now() ? new Date(next).toISOString() : '下一次调度周期';
    }
  }
  if (schedule.trigger.type === 'cron') return dailyCronLabel(schedule.trigger.cronExpression) ?? '由 Scheduler 计算';
  if (schedule.trigger.type === 'condition') return '条件满足时';
  return undefined;
}

function safeBoundSchedule(controllerHome: string, repoId: string, scheduleId?: string): RepositorySchedule | undefined {
  if (!scheduleId) return undefined;
  try { return getSchedule(controllerHome, repoId, scheduleId); } catch { return undefined; }
}

function occurrenceResult(occurrence?: ScheduleOccurrence): string | undefined {
  if (!occurrence) return undefined;
  if (occurrence.decision === 'nothing_to_do') return '无变化';
  if (occurrence.decision === 'would_execute') return '预演完成';
  if (occurrence.decision === 'stopped') return '已停止';
  if (occurrence.status === 'failed') return '失败';
  if (occurrence.status === 'succeeded') return '执行成功';
  if (occurrence.status === 'running' || occurrence.status === 'queued' || occurrence.status === 'created') return '运行中';
  if (occurrence.status === 'skipped') return '已跳过';
  return occurrence.status;
}

function occurrenceTone(occurrence: ScheduleOccurrence): ConsoleAutomationHistoryView['tone'] {
  if (occurrence.status === 'failed' || occurrence.decision === 'operation_blocked') return 'red';
  if (occurrence.decision === 'stopped' || occurrence.decision === 'budget_exhausted') return 'amber';
  if (occurrence.status === 'succeeded') return 'green';
  if (occurrence.status === 'running' || occurrence.status === 'queued' || occurrence.status === 'created') return 'blue';
  return 'gray';
}

function displayOccurrenceReason(reason?: string): string | undefined {
  const value = reason?.trim();
  if (!value) return undefined;
  if (value === 'Browser session keepalive refreshed successfully.') return '登录会话刷新成功，未发现认证问题。';
  if (value === 'Browser watcher baseline recorded; no Controller wake was emitted.') return '已建立观察基线；没有唤醒 ChatGPT。';
  if (value === 'Browser watcher observation is unchanged; no Controller wake was emitted.') return '页面没有变化；保持静默。';
  if (value.startsWith('Browser watcher requires authentication:')) return '目标登录状态已失效，需要重新认证。';
  if (value.startsWith('Work ') && value.includes(' is terminal')) return '绑定的 Work 已完成，自动任务已停止。';
  return value;
}

function occurrenceHistory(occurrences: ScheduleOccurrence[]): ConsoleAutomationHistoryView[] {
  return occurrences.slice(0, 8).map((occurrence) => ({
    id: occurrence.occurrenceId,
    at: occurrence.updatedAt,
    result: occurrenceResult(occurrence) ?? '已记录',
    tone: occurrenceTone(occurrence),
    reason: displayOccurrenceReason(occurrence.reason),
    trigger: occurrence.triggerContext?.source === 'manual' ? '手动' : occurrence.triggerContext?.source === 'timer' ? '定时' : occurrence.triggerContext?.source,
  }));
}

function scheduleMode(schedule: RepositorySchedule): ConsoleAutomationMode {
  if (schedule.action.operation === 'external_controller_wake') return 'continuation';
  if (schedule.action.operation === 'chatgpt_browser_prompt') return 'chatgpt_prompt';
  if (schedule.action.operation === 'browser_probe') return schedule.action.arguments?.keepalive_only === true ? 'browser_keepalive' : 'browser_watch';
  return 'schedule';
}

function modeLabel(mode: ConsoleAutomationMode): string {
  if (mode === 'browser_watch') return '网页变更监听';
  if (mode === 'browser_keepalive') return '登录保活';
  if (mode === 'continuation') return '自动继续 Work';
  if (mode === 'chatgpt_prompt') return 'ChatGPT 自动任务';
  if (mode === 'routine') return '助手例行任务';
  return '自动任务';
}

function scheduleSummary(mode: ConsoleAutomationMode): string {
  if (mode === 'browser_watch') return '静默观察目标页面；只有内容发生变化时才恢复 ChatGPT。';
  if (mode === 'browser_keepalive') return '静默刷新登录态；正常时不打扰，认证失效时再恢复 ChatGPT。';
  if (mode === 'continuation') return '按计划恢复绑定的 Work，让外部 Controller 继续未完成目标。';
  if (mode === 'chatgpt_prompt') return '由 Forge 定时唤醒 ChatGPT 执行保存的任务提示，不占用 ChatGPT Schedule 名额。';
  return '由 Forge Schedule Engine 管理的持久自动任务。';
}

function scheduleDelivery(schedule: RepositorySchedule, mode: ConsoleAutomationMode): string | undefined {
  const controller = typeof schedule.action.arguments?.controller_type === 'string' ? schedule.action.arguments.controller_type : 'chatgpt';
  if (mode === 'browser_watch') return `变化时唤醒 ${controller === 'chatgpt' ? 'ChatGPT' : controller}`;
  if (mode === 'browser_keepalive') return `登录失效时唤醒 ${controller === 'chatgpt' ? 'ChatGPT' : controller}`;
  if (mode === 'continuation') return `恢复 ${controller === 'chatgpt' ? 'ChatGPT' : controller}`;
  if (mode === 'chatgpt_prompt') return '发送到 ChatGPT';
  return undefined;
}

function chatgptExecutionProfile(schedule: RepositorySchedule, mode: ConsoleAutomationMode): { agentModel?: string; reasoningLevel?: string; tabPolicy?: string } {
  if (mode !== 'continuation' && mode !== 'chatgpt_prompt') return {};
  const args = schedule.action.arguments ?? {};
  const controller = typeof args.controller_type === 'string' ? args.controller_type : 'chatgpt';
  if (mode === 'continuation' && controller !== 'chatgpt') return {};
  return {
    agentModel: typeof args.model === 'string' && args.model.trim() ? args.model.trim() : 'gpt-5.6',
    reasoningLevel: typeof args.reasoning === 'string' && args.reasoning.trim() ? args.reasoning.trim() : 'high',
    tabPolicy: typeof args.tab_policy === 'string' && args.tab_policy.trim() ? args.tab_policy.trim() : 'auto',
  };
}

function scheduleTarget(schedule: RepositorySchedule, mode: ConsoleAutomationMode): string | undefined {
  const args = schedule.action.arguments ?? {};
  if (typeof args.probe_url === 'string') {
    try { return new URL(args.probe_url).hostname; } catch { return '网页目标'; }
  }
  if (typeof args.probe_session_id === 'string') return mode === 'browser_keepalive' ? '已绑定登录会话' : '已绑定浏览器会话';
  if (typeof args.browser_session_id === 'string') return '已绑定 ChatGPT 会话';
  return undefined;
}

function observationResult(schedule: RepositorySchedule, fallback?: ScheduleOccurrence): string | undefined {
  switch (schedule.lastObservationStatus) {
    case 'baseline': return '已建立基线';
    case 'unchanged': return '无变化';
    case 'changed': return '检测到变化';
    case 'keepalive': return '登录保持正常';
    case 'auth_required': return '需要重新登录';
    default: return occurrenceResult(fallback);
  }
}

function scheduleNeedsAttention(schedule: RepositorySchedule): boolean {
  if (schedule.lastObservationStatus === 'auth_required') return true;
  if (schedule.consecutiveFailures >= schedule.policy.maxFailures) return true;
  return Boolean(schedule.pausedReason && /(?:fail|error|auth|login|block|attention|maximum)/i.test(schedule.pausedReason));
}

function scheduleStatus(schedule: RepositorySchedule): ConsoleAutomationView['status'] {
  if (schedule.enabled) return scheduleNeedsAttention(schedule) ? 'attention' : 'enabled';
  return scheduleNeedsAttention(schedule) ? 'attention' : 'paused';
}

function workBinding(controllerHome: string, repoId: string, schedule: RepositorySchedule): { id?: string; objective?: string } {
  const value = schedule.action.arguments?.work_id;
  const workId = typeof value === 'string' && value.trim() ? value.trim() : undefined;
  if (!workId) return {};
  const work = getWorkContract({ controllerHome, repoId }, workId);
  return { id: workId, objective: work?.objective };
}

function policySummary(schedule: RepositorySchedule): string {
  return `连续失败 ${schedule.consecutiveFailures}/${schedule.policy.maxFailures} · 冷却 ${schedule.policy.cooldownMinutes} 分钟 · 每日预算 ${schedule.policy.dailyBudgetMinutes} 分钟`;
}

export function listConsoleAutomations(controllerHome: string, repositories: RepositoryRecord[]): ConsoleAutomationView[] {
  const items: ConsoleAutomationView[] = [];
  for (const repository of repositories.filter((entry) => entry.enabled && !entry.removedAt)) {
    const routines = listAssistantRoutines(repository.canonicalRoot).routines;
    const bindings = new Map(routines.map((routine) => [routine.routineId, getAssistantRoutineScheduleBinding(repository.canonicalRoot, routine.routineId)]));
    const boundScheduleIds = new Set([...bindings.values()].flatMap((binding) => binding ? [binding.scheduleId] : []));

    for (const schedule of listSchedules(controllerHome, repository.repoId)) {
      if (boundScheduleIds.has(schedule.scheduleId)) continue;
      const occurrences = listOccurrences(controllerHome, repository.repoId, schedule.scheduleId, 8);
      const last = occurrences[0];
      const mode = scheduleMode(schedule);
      const work = workBinding(controllerHome, repository.repoId, schedule);
      const executionProfile = chatgptExecutionProfile(schedule, mode);
      items.push({
        id: schedule.scheduleId,
        source: 'schedule',
        repoId: repository.repoId,
        repositoryName: repository.displayName,
        name: schedule.name,
        summary: scheduleSummary(mode),
        status: scheduleStatus(schedule),
        schedule: triggerLabel(schedule),
        timezone: schedule.trigger.timezone,
        delivery: scheduleDelivery(schedule, mode),
        mode,
        modeLabel: modeLabel(mode),
        live: !schedule.policy.shadowMode,
        targetLabel: scheduleTarget(schedule, mode),
        boundWorkId: work.id,
        boundWorkObjective: work.objective,
        observationStatus: schedule.lastObservationStatus,
        observationAt: schedule.lastObservationAt,
        failureCount: schedule.consecutiveFailures,
        policySummary: policySummary(schedule),
        ...executionProfile,
        lastRunAt: last?.updatedAt ?? schedule.lastTriggeredAt,
        lastResult: observationResult(schedule, last),
        nextRunHint: nextScheduleHint(schedule),
        pausedReason: schedule.pausedReason,
        history: occurrenceHistory(occurrences),
        actions: schedule.enabled ? ['run', 'pause'] : ['resume'],
      });
    }

    for (const routine of routines) {
      const binding = bindings.get(routine.routineId);
      const boundSchedule = safeBoundSchedule(controllerHome, repository.repoId, binding?.scheduleId);
      const occurrences = boundSchedule ? listOccurrences(controllerHome, repository.repoId, boundSchedule.scheduleId, 8) : [];
      const last = occurrences[0];
      const scheduleAttention = routine.status === 'enabled' && boundSchedule && scheduleNeedsAttention(boundSchedule);
      const status: ConsoleAutomationView['status'] = scheduleAttention ? 'attention' : routine.status === 'enabled' ? 'enabled' : routine.status === 'paused' ? 'paused' : 'disabled';
      items.push({
        id: routine.routineId,
        source: 'routine',
        repoId: repository.repoId,
        repositoryName: repository.displayName,
        name: routine.name,
        summary: routine.naturalLanguageGoal,
        status,
        schedule: routine.scheduleText,
        timezone: routine.timezone,
        delivery: routine.output === 'assistant_inbox' ? 'ChatGPT 助手收件箱' : routine.output === 'gmail_draft' ? 'Gmail 草稿' : '不外发',
        mode: 'routine',
        modeLabel: modeLabel('routine'),
        live: boundSchedule ? !boundSchedule.policy.shadowMode : undefined,
        observationStatus: boundSchedule?.lastObservationStatus,
        observationAt: boundSchedule?.lastObservationAt,
        failureCount: boundSchedule?.consecutiveFailures,
        policySummary: boundSchedule ? policySummary(boundSchedule) : undefined,
        lastRunAt: last?.updatedAt ?? routine.lastRunAt,
        lastResult: boundSchedule ? observationResult(boundSchedule, last) : occurrenceResult(last) ?? (routine.lastRunAt ? '已触发' : undefined),
        nextRunHint: boundSchedule ? nextScheduleHint(boundSchedule) : routine.nextRunHint,
        pausedReason: boundSchedule?.pausedReason,
        history: occurrenceHistory(occurrences),
        actions: scheduleAttention ? ['resume'] : routine.status === 'enabled' ? ['run', 'pause'] : routine.status === 'paused' ? ['resume'] : [],
      });
    }
  }
  return items.sort((a, b) => a.name.localeCompare(b.name));
}

export function summarizeConsoleAutomations(items: ConsoleAutomationView[]) {
  return {
    total: items.length,
    enabled: items.filter((item) => item.status === 'enabled').length,
    paused: items.filter((item) => item.status === 'paused' || item.status === 'disabled').length,
    needsAttention: items.filter((item) => item.status === 'attention').length,
  };
}

export async function applyConsoleAutomationAction(
  controllerHome: string,
  repositories: RepositoryRecord[],
  source: string,
  repoId: string,
  id: string,
  action: string,
): Promise<unknown> {
  const repository = repositories.find((entry) => entry.repoId === repoId && entry.enabled && !entry.removedAt);
  if (!repository) throw new Error(`REPOSITORY_NOT_FOUND: ${repoId}`);
  if (source === 'routine') {
    if (action === 'run') return runAssistantRoutineNow(controllerHome, repository, id);
    if (action === 'pause') return updateAssistantRoutineLifecycle(controllerHome, repository, id, 'paused');
    if (action === 'resume') return updateAssistantRoutineLifecycle(controllerHome, repository, id, 'enabled');
    throw new Error(`AUTOMATION_ACTION_UNSUPPORTED: routine/${action}`);
  }
  if (source === 'schedule') {
    const schedule = getSchedule(controllerHome, repoId, id);
    if (action === 'pause') return saveSchedule(controllerHome, { ...schedule, enabled: false, pausedReason: undefined });
    if (action === 'resume') return saveSchedule(controllerHome, { ...schedule, enabled: true, pausedReason: undefined, consecutiveFailures: 0 });
    if (action === 'run') return evaluateSchedule(controllerHome, schedule, true, { source: 'manual' });
    throw new Error(`AUTOMATION_ACTION_UNSUPPORTED: schedule/${action}`);
  }
  throw new Error(`AUTOMATION_SOURCE_UNSUPPORTED: ${source}`);
}
