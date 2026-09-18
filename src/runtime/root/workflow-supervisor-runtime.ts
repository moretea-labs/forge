import { once } from 'node:events';
import { WorkflowSupervisorControlPlane } from '../../../supervisor/control-plane';
import { forgeWorkflowSupervisorValidators } from '../../../supervisor/forge-validators';
import { resolveWorkflowSupervisorForgeHome, workflowSupervisorSocketPath } from '../../../supervisor/paths';
import { createWorkflowSupervisorServer, WorkflowSupervisorEphemeralDiscovery } from '../../../supervisor/server';
import { startWorkflowSupervisorNativeBrowserAdapter } from '../../../supervisor/native-browser-adapter';
import { WorkflowSupervisorStore } from '../../../supervisor/store';

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
export async function startWorkflowSupervisorRuntime(controllerHome: string): Promise<RuntimeWorkflowSupervisorHandle> {
  const forgeHome = resolveWorkflowSupervisorForgeHome(controllerHome);
  const controlPlane = new WorkflowSupervisorControlPlane(
    new WorkflowSupervisorStore(forgeHome),
    forgeWorkflowSupervisorValidators(),
  );
  const discovery = new WorkflowSupervisorEphemeralDiscovery();
  const server = createWorkflowSupervisorServer({
    controlPlane,
    socketPath: workflowSupervisorSocketPath(forgeHome),
    discovery,
  });
  const done = once(server, 'close').then(() => undefined);
  await once(server, 'listening');
  const nativeBrowser = startWorkflowSupervisorNativeBrowserAdapter(controlPlane, discovery);
  let closing = false;
  return {
    done,
    async close(): Promise<void> {
      if (closing || !server.listening) return;
      closing = true;
      await nativeBrowser?.close().catch(() => undefined);
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
    },
  };
}
