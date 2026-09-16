import { WorkflowSupervisorControlPlane } from './control-plane';
import { createWorkflowSupervisorServer } from './server';
import { workflowSupervisorServicePaths } from './service';
import { WorkflowSupervisorStore } from './store';

function argument(name: string): string | undefined { const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] : undefined; }
const forgeHome = argument('--forge-home') ?? process.env.FORGE_HOME;
const paths = workflowSupervisorServicePaths(forgeHome);
const socketPath = argument('--socket') ?? paths.socketPath;
const store = new WorkflowSupervisorStore(forgeHome);
const controlPlane = new WorkflowSupervisorControlPlane(store);
const server = createWorkflowSupervisorServer({ controlPlane, socketPath });
const close = () => server.close(() => process.exit(0));
process.once('SIGTERM', close); process.once('SIGINT', close);
console.log(JSON.stringify({ service: 'forge-workflow-supervisor', socketPath, database: 'supervisor.sqlite' }));
