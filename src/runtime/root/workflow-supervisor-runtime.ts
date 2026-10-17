import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { WorkflowSupervisorControlPlane } from '../../../supervisor/control-plane';
import { forgeWorkflowSupervisorValidators } from '../../../supervisor/forge-validators';
import { forgeWorkflowSupervisorLifecycleHooks, workflowSupervisorContractText } from './workflow-supervisor-composition';
import { resolveWorkflowSupervisorForgeHome, workflowSupervisorSocketPath } from '../../../supervisor/paths';
import {
  createWorkflowSupervisorServer,
  reconcileWorkflowSupervisorSocket,
  WorkflowSupervisorEphemeralDiscovery,
} from '../../../supervisor/server';
import { startWorkflowSupervisorNativeBrowserAdapter, type WorkflowSupervisorNativeBrowserHandle, type WorkflowSupervisorStallProjection, type WorkflowSupervisorTransportProjection } from '../../../supervisor/native-browser-adapter';
import type { WorkflowSupervisorConsumerStatus } from '../../../supervisor/types';
import { WorkflowSupervisorStore } from '../../../supervisor/store';
import { createComputerInteractionTargetAuthority } from '../../../adapters/computer/interaction-target-authority';
import { ChromeExtensionChatgptConversationTargetPort } from '../../../adapters/computer/chatgpt-extension-target';
import { createRuntimeComputerTargetPersistence } from './computer-target-persistence';
import { listDirectActivities, listUserRequests, recordDirectActivity, recordUserRequest, resolveUserRequest } from '../../../packages/kernel/identity/api/index';
import { getRuntimeWriteClaim } from './write-fence';
import { getRepository } from '../../cli/repositories/registry';
import { getWorkContract } from '../../../packages/kernel/work/api/index';
import { isTerminalSemanticWorkState } from '../../../packages/kernel/work/api/index';
import { findActivePluginCapabilityAuthorization, pluginCapabilityAuthorizationOwnerScope } from '../plugins/capability-authorization-grants';
import { submitAssistantPluginAction } from '../plugins/store';
import { loadGmailPluginConfig } from '../plugins/google-shared';
import { GMAIL_AUTOMATION_CAPABILITY_ID, GMAIL_PLUGIN_ID } from '../plugins/gmail-adapter';

export interface RuntimeWorkflowSupervisorHandle {
  readonly done: Promise<void>;
  close(): Promise<void>;
}

/**
 * Workflow Supervisor is a distinct lifecycle authority, not a distinct OS
 * service. Canonical Forge Runtime already owns the durable process lifecycle;
 * this composition gives Supervisor one in-process server/writer while keeping
 * its SQLite and Unix socket authority isolated under the exact Controller Home.
 */
export function startWorkflowSupervisorRuntime(controllerHome: string): Promise<RuntimeWorkflowSupervisorHandle>;
export function startWorkflowSupervisorRuntime(
  controllerHome: string,
  options: { nativeBrowserAdapter?: boolean },
): Promise<RuntimeWorkflowSupervisorHandle>;
export async function startWorkflowSupervisorRuntime(
  controllerHome: string,
  options: { nativeBrowserAdapter?: boolean } = {},
): Promise<RuntimeWorkflowSupervisorHandle> {
  const forgeHome = resolveWorkflowSupervisorForgeHome(controllerHome);
  const socketPath = workflowSupervisorSocketPath(forgeHome);
  const claim = getRuntimeWriteClaim();
  const writer = claim && !claim.unmanaged
    ? { runtimeInstanceId: claim.runtimeInstanceId, fencingGeneration: claim.fencingGeneration, pid: claim.ownerPid }
    : undefined;
  if (writer) await reconcileWorkflowSupervisorSocket({ socketPath, incoming: writer });
  const store = new WorkflowSupervisorStore(forgeHome, {
    activeReleaseId: () => getRuntimeWriteClaim()?.releaseId,
  });
  const controlPlane = new WorkflowSupervisorControlPlane(
    store,
    forgeWorkflowSupervisorValidators(),
    forgeWorkflowSupervisorLifecycleHooks(controllerHome),
  );
  const discovery = new WorkflowSupervisorEphemeralDiscovery();
  const browserAdapterEnabled = true;
  const nativeBrowserAdapterEnabled = options.nativeBrowserAdapter !== false;
  let nativeBrowser: WorkflowSupervisorNativeBrowserHandle | undefined;
  const transportActivityId = (taskId?: string): string => `workflow-supervisor-transport-${(taskId ?? 'instance').replace(/[^a-zA-Z0-9._-]/g, '_')}`;
  const reportTransportState = (projection: WorkflowSupervisorTransportProjection): void => {
    const activityId = transportActivityId(projection.taskId);
    const existing = listDirectActivities(controllerHome, 200).find((item) => item.activityId === activityId);
    const recovered = projection.state === 'recovered';
    recordDirectActivity(controllerHome, {
      activityId,
      capabilityId: 'workflow-supervisor.transport',
      kind: 'direct_execution',
      targetScope: projection.taskId ? `workflow-supervisor-task:${projection.taskId}` : 'workflow-supervisor:instance',
      principalId: 'forge-runtime',
      status: recovered ? 'completed' : 'running',
      startedAt: existing?.startedAt ?? projection.firstFailureAt ?? projection.observedAt,
      ...(recovered ? { completedAt: projection.observedAt } : {}),
      summary: recovered
        ? 'Workflow Supervisor transport recovered; autonomous continuation resumed without user action.'
        : `Workflow Supervisor transport is temporarily degraded and auto-recovering${projection.code ? ` (${projection.code})` : ''}. Durable task/effect progress is preserved.`,
    });
    if (recovered && projection.taskId) {
      const prefix = `workflow-supervisor.transport-human:${projection.taskId}:`;
      for (const request of listUserRequests(controllerHome, 'pending').filter((item) => item.rootCauseKey.startsWith(prefix))) {
        resolveUserRequest(controllerHome, { requestId: request.requestId, decision: 'transport_recovered', resolvedBy: 'forge-runtime' });
      }
    }
  };
  const stallActivityId = (taskId: string): string => `workflow-supervisor-stall-${taskId.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
  const reportTaskStall = (projection: WorkflowSupervisorStallProjection): void => {
    const activityId = stallActivityId(projection.taskId);
    const existing = listDirectActivities(controllerHome, 200).find((item) => item.activityId === activityId);
    const exhausted = projection.state === 'exhausted';
    if (!exhausted && !existing) return;
    const budget = projection.generations !== undefined && projection.maxGenerations !== undefined
      ? ` (${projection.generations}/${projection.maxGenerations})`
      : '';
    recordDirectActivity(controllerHome, {
      activityId,
      capabilityId: 'workflow-supervisor.continuation',
      kind: 'direct_execution',
      targetScope: `workflow-supervisor-task:${projection.taskId}`,
      principalId: 'forge-runtime',
      status: exhausted ? 'running' : 'completed',
      startedAt: exhausted && existing?.status !== 'running' ? projection.observedAt : existing?.startedAt ?? projection.observedAt,
      ...(!exhausted ? { completedAt: projection.observedAt } : {}),
      summary: exhausted
        ? projection.stallKind === 'provider_resume_exhausted'
          ? 'Workflow Supervisor exhausted bounded provider-resume attempts. The committed effect is preserved; only read-only reconciliation for late receipt evidence continues, and no duplicate provider turn will be sent.'
          : `Workflow Supervisor exhausted bounded automatic dispatch generations${budget}. The task/effect remains durable, but automatic sending is paused until explicit recovery or new authoritative evidence; no duplicate provider turn will be sent.`
        : 'Workflow Supervisor continuation stall cleared; the durable task/effect can progress again.',
    });
  };
  const requestHumanAction = (input: { taskId: string; effectId?: string; action: 'login' | 'grant_permission'; code: string }): void => {
    const actionLabel = input.action === 'login' ? 'sign in to ChatGPT' : 'restore browser automation permission';
    recordUserRequest(controllerHome, {
      kind: 'user_action_request',
      rootCauseKey: `workflow-supervisor.transport-human:${input.taskId}:${input.action}`,
      title: input.action === 'login' ? 'ChatGPT sign-in required' : 'Browser permission required',
      summary: `Workflow Supervisor cannot continue this task until you ${actionLabel}. The task and effect ledger are preserved and will resume automatically afterward.`,
      actionRequired: input.action,
      targetScope: { scopeKind: 'workflow_supervisor_task', scopeId: input.taskId },
      presentation: {
        severity: 'blocked',
        creationReason: 'workflow_supervisor_transport_human_boundary',
        reason: input.code,
        currentState: { taskId: input.taskId, ...(input.effectId ? { effectId: input.effectId } : {}), transportCode: input.code },
      },
    });
  };
  const notificationRequestId = (...parts: string[]): string => `wfsn_${createHash('sha256').update(parts.join('\u0000')).digest('hex').slice(0, 32)}`;
  const notificationOrigin = { surface: 'system' as const };
  const notificationOwnerScope = pluginCapabilityAuthorizationOwnerScope({ surface: 'system', actor: 'plugin_action_execute' });
  const findNotificationGrant = (repoId: string, target: { kind: 'gmail-mailbox'; id: string; identityFingerprint: string } | undefined) => target && findActivePluginCapabilityAuthorization(controllerHome, {
    ownerScope: notificationOwnerScope,
    repoId,
    pluginId: GMAIL_PLUGIN_ID,
    capabilityId: GMAIL_AUTOMATION_CAPABILITY_ID,
    target,
    scopes: ['gmail.send'],
    risk: 'remote_write',
  });
  const sendSupervisorNotification = async (input: {
    taskId: string;
    requestId: string;
    kind: 'user_action_required' | 'continuation_exhausted';
    subject: string;
    reason: string;
    effectId?: string;
    userRequestId?: string;
    stillActive?: () => boolean;
  }): Promise<void> => {
    if (input.stillActive && !input.stillActive()) return;
    const task = store.getTask(input.taskId);
    if (!task) return;
    const repoId = workflowSupervisorContractText(task, 'repo_id');
    if (!repoId) return;
    const repository = getRepository(repoId, controllerHome);
    if (!repository) return;
    const mailbox = loadGmailPluginConfig(repository.canonicalRoot, { controllerHome, repoId }).accountEmail?.trim().toLowerCase();
    const target = mailbox ? {
      kind: 'gmail-mailbox' as const,
      id: mailbox,
      identityFingerprint: `gmail-profile:${mailbox}`,
    } : undefined;
    const grant = findNotificationGrant(repoId, target);
    if (!grant) {
      recordUserRequest(controllerHome, {
        kind: 'user_action_request',
        rootCauseKey: `workflow-supervisor.notification-auth:${input.taskId}`,
        title: 'Scheduled Gmail notification authorization required',
        summary: `Forge has not sent the Workflow Supervisor notification because no active reusable Gmail automation grant is available for the configured Gmail profile${mailbox ? ` (${mailbox})` : ''}. Set Gmail accountEmail to match the connected profile, then run Gmail action authorize_scheduled_gmail_automation interactively. The grant permits only selected-message archiving and notifications to this profile for up to 90 days; it does not authorize arbitrary recipients, replies, or trash. No email was sent or retried around this boundary.`,
        actionRequired: 'grant_permission',
        targetScope: { scopeKind: 'workflow_supervisor_task', scopeId: input.taskId },
        presentation: {
          severity: 'blocked',
          creationReason: 'scheduled_gmail_notification_authorization_required',
          reason: 'EXTERNAL_EFFECT_AUTHORIZATION_REQUIRED',
          currentState: {
            taskId: input.taskId,
            repoId,
            ...(mailbox ? { mailbox } : {}),
            pluginId: GMAIL_PLUGIN_ID,
            capabilityId: GMAIL_AUTOMATION_CAPABILITY_ID,
            authorizationAction: 'authorize_scheduled_gmail_automation',
            scopes: ['gmail.modify', 'gmail.send'],
            grantLifetimeDays: 90,
          },
        },
      });
      return;
    }
    if (input.stillActive && !input.stillActive()) return;
    const workId = workflowSupervisorContractText(task, 'work_id');
    const body = [
      'Forge Workflow Supervisor 检测到需要人工处理的事件。',
      `事件：${input.kind}`,
      `原因：${input.reason.slice(0, 1800)}`,
      `Supervisor Task：${task.taskId}`,
      `Work：${workId ?? '未绑定 Work'}`,
      `目标：${task.objective.slice(0, 800)}`,
      `ChatGPT 处理入口：${task.conversationUrl}`,
      ...(repoId && workId ? [`Forge Work 查询：rh_work operation=get repo_id=${repoId} work_id=${workId}`] : []),
      ...(input.effectId ? [`Effect：${input.effectId}`] : []),
      ...(input.userRequestId ? [`UserRequest：${input.userRequestId}`] : []),
      '处理或恢复后，Forge 会继续沿用原有任务与 effect；不要手动重复发送。',
    ].join('\n').slice(0, 11000);
    try {
      await submitAssistantPluginAction(controllerHome, repository, {
        pluginId: GMAIL_PLUGIN_ID,
        actionId: 'send_owner_notification',
        requestId: input.requestId,
        args: { subject: input.subject, body_text: body },
        origin: {
          surface: 'system',
          correlationId: input.requestId,
          ...(input.effectId ? { causationId: input.effectId } : {}),
        },
        authorizationGrantRefs: [grant.grantId],
      });
    } catch (error) {
      const failureMessage = error instanceof Error ? error.message : String(error);
      const failureCode = /^([A-Z][A-Z0-9_]+)(?::|$)/.exec(failureMessage)?.[1];
      const loginRequired = failureCode === 'PLUGIN_AUTH_REQUIRED' || failureCode === 'PLUGIN_AUTH_FAILED';
      const authorizationRequired = loginRequired || [
        'PLUGIN_CAPABILITY_GRANT_REQUIRED',
        'GMAIL_AUTOMATION_DISABLED',
        'GMAIL_AUTOMATION_MAILBOX_NOT_CONFIGURED',
        'GMAIL_AUTOMATION_MAILBOX_MISMATCH',
        'EXTERNAL_EFFECT_AUTHORIZATION_REQUIRED',
      ].includes(failureCode ?? '');
      if (authorizationRequired && failureCode) {
        const workId = workflowSupervisorContractText(task, 'work_id');
        recordUserRequest(controllerHome, {
          kind: 'user_action_request',
          rootCauseKey: `workflow-supervisor.notification-send-auth:${input.taskId}:${input.requestId}`,
          title: loginRequired ? 'Gmail notification reauthorization required' : 'Gmail notification authorization required',
          summary: `Forge could not send the notification to the configured Gmail profile${mailbox ? ` (${mailbox})` : ''} because the exact Gmail provider action failed with ${failureCode}: ${failureMessage}. No alternate provider or automatic resend was used. Restore the Gmail authorization or exact mailbox grant, then continue from the original task.`,
          actionRequired: loginRequired ? 'login' : 'grant_permission',
          targetScope: {
            scopeKind: 'workflow_supervisor_task',
            scopeId: input.taskId,
            repoId,
            ...(workId ? { workId } : {}),
          },
          presentation: {
            severity: 'blocked',
            creationReason: 'scheduled_gmail_notification_authorization_failed',
            reason: failureCode,
            currentState: {
              taskId: input.taskId,
              repoId,
              ...(workId ? { workId } : {}),
              ...(mailbox ? { mailbox } : {}),
              pluginId: GMAIL_PLUGIN_ID,
              capabilityId: GMAIL_AUTOMATION_CAPABILITY_ID,
              actionId: 'send_owner_notification',
              requestId: input.requestId,
              ...(input.effectId ? { effectId: input.effectId } : {}),
              errorCode: failureCode,
            },
          },
        });
      }
      process.stderr.write(`[workflow-supervisor-notification] ${input.requestId}: ${failureMessage}\\n`);
    }
  };
  let notificationReconciliationInFlight: Promise<void> | undefined;
  const reconcileSupervisorNotifications = (): void => {
    if (closing || notificationReconciliationInFlight) return;
    notificationReconciliationInFlight = (async () => {
      const allRequests = listUserRequests(controllerHome);
      for (const request of allRequests.filter((item) => item.status === 'pending' && item.rootCauseKey.startsWith('workflow-supervisor.notification-auth:'))) {
        const taskId = request.targetScope?.scopeId;
        if (!taskId) continue;
        const task = store.getTask(taskId);
        if (!task) continue;
        const repoId = workflowSupervisorContractText(task, 'repo_id');
        const workId = workflowSupervisorContractText(task, 'work_id');
        if (!repoId) continue;
        if (workId) {
          const work = getWorkContract({ controllerHome, repoId }, workId);
          if (!work || isTerminalSemanticWorkState(work.semanticState)) {
            resolveUserRequest(controllerHome, { requestId: request.requestId, decision: 'underlying_work_terminal', resolvedBy: 'forge-runtime' });
            continue;
          }
        }
        const repository = getRepository(repoId, controllerHome);
        if (!repository) continue;
        const mailbox = loadGmailPluginConfig(repository.canonicalRoot, { controllerHome, repoId }).accountEmail?.trim().toLowerCase();
        const target = mailbox ? {
          kind: 'gmail-mailbox' as const,
          id: mailbox,
          identityFingerprint: `gmail-profile:${mailbox}`,
        } : undefined;
        if (findNotificationGrant(repoId, target)) {
          resolveUserRequest(controllerHome, { requestId: request.requestId, decision: 'gmail_automation_authorized', resolvedBy: 'forge-runtime' });
        }
      }

      for (const request of allRequests.filter((item) => item.status === 'pending' && item.rootCauseKey.startsWith('workflow-supervisor.transport-human:'))) {
        const taskId = request.targetScope?.scopeId;
        if (!taskId) continue;
        const task = store.getTask(taskId);
        if (!task) continue;
        const repoId = workflowSupervisorContractText(task, 'repo_id');
        const workId = workflowSupervisorContractText(task, 'work_id');
        if (repoId && workId) {
          const work = getWorkContract({ controllerHome, repoId }, workId);
          if (!work || isTerminalSemanticWorkState(work.semanticState)) {
            resolveUserRequest(controllerHome, { requestId: request.requestId, decision: 'underlying_work_terminal', resolvedBy: 'forge-runtime' });
            continue;
          }
        }
        const effectId = typeof request.presentation?.currentState?.effectId === 'string' ? request.presentation.currentState.effectId : undefined;
        const actionLabel = request.actionRequired === 'login' ? 'ChatGPT 登录' : '浏览器权限';
        await sendSupervisorNotification({
          taskId,
          requestId: notificationRequestId('user-action', request.requestId),
          kind: 'user_action_required',
          subject: `[Forge] 需要处理：${actionLabel}`,
          reason: request.summary,
          effectId,
          userRequestId: request.requestId,
          stillActive: () => listUserRequests(controllerHome, 'pending').some((item) => item.requestId === request.requestId),
        });
      }

      for (const activity of listDirectActivities(controllerHome, 200).filter((item) => item.capabilityId === 'workflow-supervisor.continuation' && item.status === 'running')) {
        const prefix = 'workflow-supervisor-task:';
        if (!activity.targetScope.startsWith(prefix)) continue;
        const taskId = activity.targetScope.slice(prefix.length);
        const stall = controlPlane.taskStall(taskId);
        if (!stall || !(stall.state === 'provider_resume_exhausted'
          || (stall.state === 'retryable' && stall.generations >= stall.maxGenerations))) continue;
        const reason = stall.state === 'provider_resume_exhausted'
          ? 'Supervisor 的 provider resume 尝试已确认耗尽；原 effect 仍被保留，不会盲目重发。'
          : `Supervisor 自动派发尝试已确认耗尽（${stall.generations}/${stall.maxGenerations}）；原 effect 仍被保留，不会盲目重发。`;
        await sendSupervisorNotification({
          taskId,
          requestId: notificationRequestId('stall', taskId, stall.state, activity.startedAt),
          kind: 'continuation_exhausted',
          subject: `[Forge] 自动续跑已耗尽：${taskId}`,
          reason,
          effectId: stall.effectId,
          stillActive: () => {
            const currentActivity = listDirectActivities(controllerHome, 200).find((item) => item.activityId === activity.activityId);
            const currentStall = controlPlane.taskStall(taskId);
            const currentStallExhausted = currentStall.state === 'provider_resume_exhausted'
              || (currentStall.state === 'retryable' && currentStall.generations >= currentStall.maxGenerations);
            return currentActivity?.status === 'running'
              && currentActivity.startedAt === activity.startedAt
              && currentStallExhausted
              && currentStall.state === stall.state
              && currentStall.effectId === stall.effectId;
          },
        });
      }

      for (const task of store.listTasks()) {
        if (store.terminalAction(task.taskId) !== 'NEEDS_USER') continue;
        const completion = store.getLatestCompletion(task.taskId);
        if (!completion || completion.action !== 'NEEDS_USER') continue;
        const repoId = workflowSupervisorContractText(task, 'repo_id');
        const workId = workflowSupervisorContractText(task, 'work_id');
        if (repoId && workId) {
          const work = getWorkContract({ controllerHome, repoId }, workId);
          if (!work || isTerminalSemanticWorkState(work.semanticState)) continue;
        }
        const relatedRequests = allRequests.filter((request) => request.targetScope?.scopeId === task.taskId
          && request.rootCauseKey.startsWith(`workflow-supervisor.transport-human:${task.taskId}:`));
        if (relatedRequests.some((request) => request.status === 'pending')) continue;
        const completionCommittedAt = Date.parse(completion.committedAt);
        if (relatedRequests.some((request) => {
          const resolvedAt = Date.parse(request.resolution?.resolvedAt ?? '');
          return Number.isFinite(resolvedAt) && Number.isFinite(completionCommittedAt) && resolvedAt >= completionCommittedAt;
        })) continue;
        await sendSupervisorNotification({
          taskId: task.taskId,
          requestId: notificationRequestId('terminal-needs-user', task.taskId, completion.completionFingerprint),
          kind: 'user_action_required',
          subject: `[Forge] 需要人工处理：${task.taskId}`,
          reason: completion.proposal.reason,
          effectId: completion.sourceEffectId,
          stillActive: () => {
            const currentTask = store.getTask(task.taskId);
            const currentCompletion = store.getLatestCompletion(task.taskId);
            if (store.terminalAction(task.taskId) !== 'NEEDS_USER' || currentCompletion?.completionFingerprint !== completion.completionFingerprint) return false;
            const currentRepoId = currentTask ? workflowSupervisorContractText(currentTask, 'repo_id') : undefined;
            const currentWorkId = currentTask ? workflowSupervisorContractText(currentTask, 'work_id') : undefined;
            if (currentRepoId && currentWorkId) {
              const currentWork = getWorkContract({ controllerHome, repoId: currentRepoId }, currentWorkId);
              if (!currentWork || isTerminalSemanticWorkState(currentWork.semanticState)) return false;
            }
            return true;
          },
        });
      }
    })()
      .catch((error) => { process.stderr.write(`[workflow-supervisor-notification-reconcile] ${error instanceof Error ? error.message : String(error)}\\n`); })
      .finally(() => { notificationReconciliationInFlight = undefined; });
  };
  const targetAuthority = createComputerInteractionTargetAuthority(createRuntimeComputerTargetPersistence());
  const extensionTargetPort = new ChromeExtensionChatgptConversationTargetPort(controllerHome, targetAuthority);
  const targetPort = extensionTargetPort;
  const browserConsumerStatus = (): WorkflowSupervisorConsumerStatus => nativeBrowser?.status() ?? {
    enabled: browserAdapterEnabled,
    running: false,
    observedAt: new Date().toISOString(),
    transportFailureStreak: 0,
    providerBackpressureMs: 0,
    stalled: false,
  };
  const server = createWorkflowSupervisorServer({
    controlPlane,
    socketPath,
    discovery,
    browserAdapterEnabled,
    browserConsumerStatus,
    computerExtensionBroker: extensionTargetPort,
    ...(writer ? { writer } : {}),
  });
  const done = once(server, 'close').then(() => undefined);
  await once(server, 'listening');
  let closing = false;
  let reconciliationInFlight: Promise<void> | undefined;
  const reconcileCommittedContinuations = (): void => {
    if (closing || reconciliationInFlight) return;
    reconciliationInFlight = controlPlane.reconcileCommittedContinuations()
      .then(() => { reconcileSupervisorNotifications(); })
      .catch((error) => { process.stderr.write(`[workflow-supervisor-reconcile] ${error instanceof Error ? error.message : String(error)}\\n`); })
      .finally(() => { reconciliationInFlight = undefined; });
  };
  // Reconcile before browser polling starts so a Runtime restart can finish a
  // previously committed CONTINUE without requiring another user/provider turn.
  reconcileCommittedContinuations();
  // Reconciliation is a core Runtime responsibility. Keep this timer referenced
  // for the whole Runtime lifetime instead of treating continuation delivery as
  // best-effort background work.
  const reconciliationTimer = setInterval(reconcileCommittedContinuations, 2_000);
  if (nativeBrowserAdapterEnabled) {
    nativeBrowser = startWorkflowSupervisorNativeBrowserAdapter(controlPlane, discovery, {
      targetPort,
      nowMs: () => Date.now(),
      // Liveness authority for one applied provider turn. Live evidence: these
      // Supervisor turns run for 10-50 minutes, so any quiet window shorter than
      // that reserved duplicate recovery prompts on turns that were still
      // working (60s and then 3 minutes both fired in production). This is the
      // existing bounded maximum, and the digest itself now tracks live turn
      // activity, so the window only elapses on a genuinely silent surface. A
      // real provider failure is classified from provider failure text
      // independently of this threshold.
      providerIdleGraceMs: 10 * 60_000,
      providerScopeKey: controllerHome,
      sleep: async (ms) => { await new Promise((resolve) => setTimeout(resolve, ms)); },
      setInterval: (handler, ms) => setInterval(handler, ms),
      clearInterval: (timer) => clearInterval(timer),
      onError: (error) => { process.stderr.write(`[workflow-supervisor-computer-target] ${error instanceof Error ? error.message : String(error)}\\n`); },
      reportTransportState,
      reportTaskStall,
      requestHumanAction,
    });
  }
  return {
    done,
    async close(): Promise<void> {
      if (closing) return;
      closing = true;
      clearInterval(reconciliationTimer);
      try {
        await reconciliationInFlight?.catch(() => undefined);
        await nativeBrowser?.close().catch(() => undefined);
        if (server.listening) {
          await new Promise<void>((resolve, reject) => {
            server.close((error) => error ? reject(error) : resolve());
          });
        }
      } finally {
        store.close();
      }
    },
  };
}
