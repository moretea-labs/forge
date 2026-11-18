export type WindowsRecoveryTaskStatus = {
  installed: boolean;
  method: 'scheduled_task' | 'hkcu_run' | 'none';
  identityMatches?: boolean;
};

export function parseTaskStatus(output: string): WindowsRecoveryTaskStatus;
