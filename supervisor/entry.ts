import { WorkflowSupervisorControlPlane } from './control-plane';
import { createWorkflowSupervisorServer, reconcileWorkflowSupervisorSocket, type WorkflowSupervisorWriterIdentity } from './server';
import { workflowSupervisorSocketPath } from './paths';
import { WorkflowSupervisorStore } from './store';
import { forgeWorkflowSupervisorValidators } from './forge-validators';

function argument(name: string): string | undefined { const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] : undefined; }

/**
 * The standalone CLI entry is a manual/diagnostic writer of the same
 * supervisor.sqlite journal. It reuses the canonical socket writer fence so a
 * live Canonical Runtime writer blocks this process (and a live standalone
 * process blocks a later Runtime) instead of creating a second concurrent
 * journal writer.
 */
const standaloneWriter: WorkflowSupervisorWriterIdentity = {
  runtimeInstanceId: 'standalone-workflow-supervisor-cli',
  fencingGeneration: 1,
  pid: process.pid,
};

async function main(): Promise<void> {
  const controllerHome = argument('--controller-home');
  const socketPath = argument('--socket') ?? workflowSupervisorSocketPath(controllerHome);
  await reconcileWorkflowSupervisorSocket({ socketPath, incoming: standaloneWriter });
  // A custom --socket still shares supervisor.sqlite with the Canonical
  // Runtime's writer, so the canonical socket must also be fenced.
  const canonicalSocketPath = workflowSupervisorSocketPath(controllerHome);
  if (canonicalSocketPath !== socketPath) {
    await reconcileWorkflowSupervisorSocket({ socketPath: canonicalSocketPath, incoming: standaloneWriter });
  }
  const store = new WorkflowSupervisorStore(controllerHome);
  const controlPlane = new WorkflowSupervisorControlPlane(store, forgeWorkflowSupervisorValidators());
  const server = createWorkflowSupervisorServer({ controlPlane, socketPath, writer: standaloneWriter });
  const close = () => server.close(() => process.exit(0));
  process.once('SIGTERM', close); process.once('SIGINT', close);
  console.log(JSON.stringify({ service: 'forge-workflow-supervisor', socketPath, database: 'supervisor.sqlite' }));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
