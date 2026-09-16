import { isAbsolute } from 'node:path';
import { WORKFLOW_SUPERVISOR_NATIVE_HOST_NAME } from './host';

export interface WorkflowSupervisorNativeManifestInput { executablePath: string; extensionId: string }
export function renderWorkflowSupervisorNativeManifest(input: WorkflowSupervisorNativeManifestInput): string {
  if (!isAbsolute(input.executablePath)) throw new Error('WORKFLOW_SUPERVISOR_NATIVE_EXECUTABLE_ABSOLUTE_REQUIRED');
  if (!/^[a-p]{32}$/.test(input.extensionId)) throw new Error('WORKFLOW_SUPERVISOR_EXTENSION_ID_INVALID');
  return `${JSON.stringify({ name: WORKFLOW_SUPERVISOR_NATIVE_HOST_NAME, description: 'Stateless Chrome relay to the Forge Workflow Supervisor daemon', path: input.executablePath, type: 'stdio', allowed_origins: [`chrome-extension://${input.extensionId}/`] }, null, 2)}\n`;
}
