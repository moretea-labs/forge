import { WorkflowSupervisorControlPlane } from './control-plane';
import { createWorkflowSupervisorServer } from './server';
import { workflowSupervisorSocketPath } from './paths';
import { WorkflowSupervisorStore } from './store';
import { forgeWorkflowSupervisorValidators } from './forge-validators';

function argument(name: string): string | undefined { const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] : undefined; }
const controllerHome = argument('--controller-home');
const socketPath = argument('--socket') ?? workflowSupervisorSocketPath(controllerHome);
const store = new WorkflowSupervisorStore(controllerHome);
const controlPlane = new WorkflowSupervisorControlPlane(store, forgeWorkflowSupervisorValidators());
const server = createWorkflowSupervisorServer({ controlPlane, socketPath });
const close = () => server.close(() => process.exit(0));
process.once('SIGTERM', close); process.once('SIGINT', close);
console.log(JSON.stringify({ service: 'forge-workflow-supervisor', socketPath, database: 'supervisor.sqlite' }));
