import { invoke } from '@tauri-apps/api/core';
import type { AutomaticContinuationTaskProjection } from './runtime-projection';

interface RawSupervisorTask {
  taskId: string;
  conversationId: string;
  conversationUrl: string;
  objective: string;
  completionContract?: Record<string, unknown>;
  continuationPolicy?: Record<string, unknown>;
}

interface SupervisorListResult {
  tasks?: RawSupervisorTask[];
}

export function tauriRuntimeAvailable(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

function textField(record: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function projectTask(task: RawSupervisorTask): AutomaticContinuationTaskProjection {
  const switching = task.conversationId.startsWith('bootstrap:');
  const workId = textField(task.completionContract, 'work_id') ?? textField(task.continuationPolicy, 'work_id');
  const exactConversation = !switching && /\/c\//.test(task.conversationUrl);
  return {
    taskId: task.taskId,
    ...(workId ? { workId } : {}),
    title: workId ? 'Automatic continuation' : 'Standalone automatic continuation',
    objective: task.objective,
    status: switching ? 'switching_conversation' : 'running',
    statusLabel: switching ? 'Switching conversation' : 'Running',
    detail: switching
      ? 'Workflow Supervisor is creating and binding a fresh exact ChatGPT conversation.'
      : 'Workflow Supervisor owns the next outer turn for this task.',
    conversation: exactConversation ? {
      conversationId: task.conversationId,
      conversationUrl: task.conversationUrl,
    } : null,
    nextAction: switching
      ? 'Wait for the fresh conversation enrollment turn to be observed.'
      : 'Continue in the bound conversation, or explicitly switch this task to a fresh conversation.',
  };
}

export async function readAutomaticContinuations(): Promise<AutomaticContinuationTaskProjection[]> {
  const result = await invoke<SupervisorListResult>('read_automatic_continuations');
  return (result.tasks ?? []).map(projectTask);
}

export async function switchAutomaticContinuationConversation(task: AutomaticContinuationTaskProjection): Promise<void> {
  if (!task.conversation) throw new Error('AUTOMATIC_CONTINUATION_EXACT_CONVERSATION_REQUIRED');
  await invoke('switch_automatic_continuation_conversation', {
    taskId: task.taskId,
    expectedConversationId: task.conversation.conversationId,
    reason: 'User requested a fresh conversation from Forge Desktop.',
  });
}
