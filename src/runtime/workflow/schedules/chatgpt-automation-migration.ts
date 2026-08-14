import type { RepositorySchedule } from './types';

export const CHATGPT_AUTOMATION_EXECUTION_PROFILE = 'chatgpt_browser_v1';
export const CHATGPT_AUTOMATION_DEFAULT_MODEL = 'gpt-5.6';
export const CHATGPT_AUTOMATION_DEFAULT_REASONING = 'high';
export const CHATGPT_AUTOMATION_DEFAULT_TAB_POLICY = 'auto';

export interface ChatgptAutomationScheduleMigrationResult {
  changed: boolean;
  schedule: RepositorySchedule;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export function migrateChatgptAutomationSchedule(schedule: RepositorySchedule): ChatgptAutomationScheduleMigrationResult {
  if (schedule.action.operation !== 'external_controller_wake') return { changed: false, schedule };
  const current = schedule.action.arguments ?? {};
  const controllerType = nonEmptyString(current.controller_type) ?? 'chatgpt';
  if (controllerType !== 'chatgpt') return { changed: false, schedule };

  const argumentsNext: Record<string, unknown> = {
    ...current,
    controller_type: controllerType,
    model: nonEmptyString(current.model) ?? CHATGPT_AUTOMATION_DEFAULT_MODEL,
    reasoning: nonEmptyString(current.reasoning) ?? CHATGPT_AUTOMATION_DEFAULT_REASONING,
    tab_policy: nonEmptyString(current.tab_policy) ?? CHATGPT_AUTOMATION_DEFAULT_TAB_POLICY,
    execution_profile: nonEmptyString(current.execution_profile) ?? CHATGPT_AUTOMATION_EXECUTION_PROFILE,
  };
  const changed = Object.entries(argumentsNext).some(([key, value]) => current[key] !== value);
  if (!changed) return { changed: false, schedule };
  return {
    changed: true,
    schedule: {
      ...schedule,
      action: { ...schedule.action, arguments: argumentsNext },
    },
  };
}
