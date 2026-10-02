import type { CallToolResult } from '../../../packages/protocols/mcp/tool-contract';
import { getWorkflowSupervisorTask, recordWorkflowSupervisorAutomationReceipt } from '../../../supervisor/client';
import { resolveWorkflowSupervisorForgeHome } from '../../../supervisor/paths';
import type { MultiRepositoryMcpToolContext } from '../multi-repository';

type AutomationStatus = 'working' | 'continue' | 'done' | 'needs_user';

export const AUTOMATION_RECEIPT_CAPABILITY_PREFIX = 'automation.receipt:';

function compatibilityAutomationMetadata(args: Record<string, unknown>): { status: AutomationStatus; taskId: string } | undefined {
  const capabilityId = typeof args.capability_id === 'string' ? args.capability_id.trim() : '';
  if (!capabilityId.startsWith(AUTOMATION_RECEIPT_CAPABILITY_PREFIX)) return undefined;
  const payload = capabilityId.slice(AUTOMATION_RECEIPT_CAPABILITY_PREFIX.length);
  const separator = payload.indexOf(':');
  if (separator <= 0) throw new Error('AUTOMATION_RECEIPT_CAPABILITY_INVALID');
  const status = payload.slice(0, separator);
  const taskId = payload.slice(separator + 1).trim();
  if (!['working', 'continue', 'done', 'needs_user'].includes(status)) throw new Error('AUTOMATION_STATUS_INVALID');
  if (!taskId) throw new Error('AUTOMATION_TASK_ID_REQUIRED');
  return { status: status as AutomationStatus, taskId };
}

export function isAutomationReceiptCompatibilityCall(args: Record<string, unknown>): boolean {
  return typeof args.capability_id === 'string' && args.capability_id.trim().startsWith(AUTOMATION_RECEIPT_CAPABILITY_PREFIX);
}

export function automationReceiptControllerTypeAllowed(controllerType: MultiRepositoryMcpToolContext['controllerType']): boolean {
  return controllerType === undefined || controllerType === 'chatgpt';
}

export function automationMetadata(args: Record<string, unknown>): { status: AutomationStatus; taskId: string } | undefined {
  const type = args.automation_type;
  const status = args.automation_status;
  if (type === undefined && status === undefined) return compatibilityAutomationMetadata(args);
  if (type !== 'autonomous_continuation') throw new Error('AUTOMATION_TYPE_INVALID');
  if (typeof status !== 'string' || !['working', 'continue', 'done', 'needs_user'].includes(status)) throw new Error('AUTOMATION_STATUS_INVALID');
  const taskId = typeof args.automation_task_id === 'string' ? args.automation_task_id.trim() : '';
  if (!taskId) throw new Error('AUTOMATION_TASK_ID_REQUIRED');
  return { status: status as AutomationStatus, taskId };
}

export async function persistAutomationReceipt(
  ctx: MultiRepositoryMcpToolContext,
  name: string,
  metadata: { status: AutomationStatus; taskId: string } | undefined,
  outcome: CallToolResult | undefined,
): Promise<void> {
  if (!metadata || outcome?.isError) return;
  // Some frozen ChatGPT connector transports predate request-scoped controllerType.
  // An explicit non-ChatGPT identity is authoritative and must fail closed, but an
  // absent compatibility field must not override the stronger Supervisor authority
  // below: exact task, bound conversation, and latest applied causal effect.
  if (!automationReceiptControllerTypeAllowed(ctx.controllerType)) {
    throw new Error('AUTOMATION_CONTROLLER_TYPE_INVALID');
  }
  const forgeHome = resolveWorkflowSupervisorForgeHome(ctx.controllerHome);
  const task = await getWorkflowSupervisorTask(forgeHome, metadata.taskId);
  if (!task) throw new Error('AUTOMATION_SUPERVISOR_TASK_REQUIRED: Copy the complete task id from the current Supervisor prompt, including its suffix, and retry the receipt. Do not create a replacement task.');
  await recordWorkflowSupervisorAutomationReceipt(forgeHome, {
    taskId: task.taskId,
    conversationId: task.conversationId,
    status: metadata.status,
    receiptId: `${task.taskId}:${name}:${metadata.status}`,
  });
}
