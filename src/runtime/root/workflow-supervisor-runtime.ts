import { once } from 'node:events';
import { WorkflowSupervisorControlPlane } from '../../../supervisor/control-plane';
import { forgeWorkflowSupervisorValidators } from '../../../supervisor/forge-validators';
import { forgeWorkflowSupervisorLifecycleHooks } from './workflow-supervisor-composition';
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
import { MacOsChatgptConversationTargetPort } from '../plugins/computer-chatgpt-macos-target';
import { ChromeExtensionChatgptConversationTargetPort } from '../../../adapters/computer/chatgpt-extension-target';
import { PreferredChatgptConversationTargetPort } from '../../../adapters/computer/chatgpt-target-router';
import { createRuntimeComputerTargetPersistence } from './computer-target-persistence';
import { listDirectActivities, listUserRequests, recordDirectActivity, recordUserRequest, resolveUserRequest } from '../../../packages/kernel/identity/api/index';
import { getRuntimeWriteClaim } from './write-fence';

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
      startedAt: existing?.startedAt ?? projection.observedAt,
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
  const targetAuthority = createComputerInteractionTargetAuthority(createRuntimeComputerTargetPersistence());
  const extensionTargetPort = new ChromeExtensionChatgptConversationTargetPort(controllerHome, targetAuthority);
  const appleEventsTargetPort = new MacOsChatgptConversationTargetPort(controllerHome, targetAuthority);
  const targetPort = new PreferredChatgptConversationTargetPort(extensionTargetPort, appleEventsTargetPort);
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
      .then(() => undefined)
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
