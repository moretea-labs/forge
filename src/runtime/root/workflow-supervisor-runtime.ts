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
import { startWorkflowSupervisorNativeBrowserAdapter, type WorkflowSupervisorNativeBrowserHandle } from '../../../supervisor/native-browser-adapter';
import type { WorkflowSupervisorConsumerStatus } from '../../../supervisor/types';
import { WorkflowSupervisorStore } from '../../../supervisor/store';
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
  const store = new WorkflowSupervisorStore(forgeHome);
  const controlPlane = new WorkflowSupervisorControlPlane(
    store,
    forgeWorkflowSupervisorValidators(),
    forgeWorkflowSupervisorLifecycleHooks(controllerHome),
  );
  const discovery = new WorkflowSupervisorEphemeralDiscovery();
  // The Browser RPC surface is consumed by the installed Chrome/Vivaldi
  // extension and is independent from the macOS Apple Events compatibility
  // consumer. Native browser automation is explicit opt-in only.
  const browserAdapterEnabled = true;
  const nativeBrowserAdapterEnabled = options.nativeBrowserAdapter === true;
  let nativeBrowser: WorkflowSupervisorNativeBrowserHandle | undefined;
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
  const reconciliationTimer = setInterval(reconcileCommittedContinuations, 2_000);
  reconciliationTimer.unref?.();
  nativeBrowser = nativeBrowserAdapterEnabled
    ? startWorkflowSupervisorNativeBrowserAdapter(controlPlane, discovery, { providerScopeKey: controllerHome })
    : undefined;
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
