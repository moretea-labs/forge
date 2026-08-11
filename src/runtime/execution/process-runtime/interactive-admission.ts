import { normalizeRepositoryCommand } from '../../../cli/repositories/command-normalization';

const SHORT_COMMANDS = new Set([
  'true', 'false', 'echo', 'printf', 'pwd', 'basename', 'dirname', 'test', '[', 'which',
]);

/**
 * Admission is deliberately category-based rather than a second scheduler.
 * Only commands that are predictably sub-second get a synchronous window;
 * builds, tests, shells, and unknown programs return their existing handle
 * immediately. Callers may always explicitly override the recommendation.
 */
export function durationAwareInteractiveWaitMs(
  command: string | readonly string[],
  requestedWaitMs: number | undefined,
  shortCommandWaitMs = 250,
): number {
  if (requestedWaitMs !== undefined) return Math.max(0, Math.trunc(requestedWaitMs));
  const normalized = normalizeRepositoryCommand(command);
  if (normalized.kind !== 'argv') return 0;
  const executable = normalized.executable?.split(/[\\/]/).at(-1)?.toLowerCase();
  return executable && SHORT_COMMANDS.has(executable) ? shortCommandWaitMs : 0;
}
