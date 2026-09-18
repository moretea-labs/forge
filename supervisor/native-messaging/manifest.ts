import { isAbsolute } from 'node:path';
import { WORKFLOW_SUPERVISOR_NATIVE_HOST_NAME } from './host';

export interface WorkflowSupervisorNativeManifestInput {
  executablePath: string;
  extensionId?: string;
  extensionIds?: readonly string[];
}

export function renderWorkflowSupervisorNativeManifest(input: WorkflowSupervisorNativeManifestInput): string {
  if (!isAbsolute(input.executablePath)) throw new Error('WORKFLOW_SUPERVISOR_NATIVE_EXECUTABLE_ABSOLUTE_REQUIRED');
  const extensionIds = (input.extensionIds ?? (input.extensionId ? [input.extensionId] : []))
    .map((value) => value.trim())
    .filter((value, index, values) => Boolean(value) && values.indexOf(value) === index)
    .sort();
  if (extensionIds.length === 0 || extensionIds.some((value) => !/^[a-p]{32}$/.test(value))) {
    throw new Error('WORKFLOW_SUPERVISOR_EXTENSION_ID_INVALID');
  }
  return `${JSON.stringify({
    name: WORKFLOW_SUPERVISOR_NATIVE_HOST_NAME,
    description: 'Stateless Chrome relay to the Forge Workflow Supervisor authority',
    path: input.executablePath,
    type: 'stdio',
    allowed_origins: extensionIds.map((extensionId) => `chrome-extension://${extensionId}/`),
  }, null, 2)}\n`;
}
