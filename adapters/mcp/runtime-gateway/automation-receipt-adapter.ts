import type { CallToolResult } from '../../../packages/protocols/mcp/tool-contract';
import { getWorkflowSupervisorTask, recordWorkflowSupervisorAutomationReceipt } from '../../../supervisor/client';
import { resolveWorkflowSupervisorForgeHome } from '../../../supervisor/paths';
import type { MultiRepositoryMcpToolContext } from '../multi-repository';

type AutomationStatus = 'working' | 'continue' | 'done' | 'needs_user';

export function automationMetadata(args: Record<string, unknown>): { status: AutomationStatus; taskId: string } | undefined {
  const type = args.automation_type;
  const status = args.automation_status;
  if (type === undefined && status === undefined) return undefined;
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
  if (ctx.controllerType !== 'chatgpt') throw new Error('AUTOMATION_CONTROLLER_TYPE_INVALID');
  const forgeHome = resolveWorkflowSupervisorForgeHome(ctx.controllerHome);
  const task = await getWorkflowSupervisorTask(forgeHome, metadata.taskId);
  if (!task) throw new Error('AUTOMATION_SUPERVISOR_TASK_REQUIRED');
  await recordWorkflowSupervisorAutomationReceipt(forgeHome, {
    taskId: task.taskId,
    conversationId: task.conversationId,
    status: metadata.status,
    receiptId: `${task.taskId}:${name}:${metadata.status}`,
  });
}
