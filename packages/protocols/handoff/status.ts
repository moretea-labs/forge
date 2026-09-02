export const HANDOFF_STATUSES = [
  'pending',
  'acknowledged',
  'in_progress',
  'resolved',
  'dismissed',
  'superseded',
  'expired',
] as const;

export type HandoffStatus = (typeof HANDOFF_STATUSES)[number];

export const TERMINAL_HANDOFF_STATUSES: readonly HandoffStatus[] = [
  'resolved',
  'dismissed',
  'superseded',
  'expired',
] as const;

export function isTerminalHandoffStatus(status: HandoffStatus): boolean {
  return TERMINAL_HANDOFF_STATUSES.includes(status);
}
