import { normalizeRepositoryCommand } from '../../../cli/repositories/command-normalization';

const SHORT_COMMANDS = new Set([
  'true', 'false', 'echo', 'printf', 'pwd', 'basename', 'dirname', 'test', '[', 'which',
]);

// ChatGPT reaches Process Runtime through a remote MCP hop. Returning a handle
// immediately for a process that finishes a few milliseconds later forces an
// additional caller round trip that is much more expensive than a small local
// completion grace. Keep this far below the retired 800ms-2s waits: genuinely
// long commands still become managed almost immediately.
const DEFAULT_COMPLETION_GRACE_MS = 100;

/**
 * Admission is deliberately category-based rather than a second scheduler.
 * Predictable primitives retain the larger short-command window. Other
 * synchronous commands receive only a tiny completion grace so near-immediate
 * processes can finish in the originating MCP call instead of forcing a second
 * remote process_wait round trip. Explicit async/zero-wait callers still return
 * handles immediately.
 */
export function durationAwareInteractiveWaitMs(
  command: string | readonly string[],
  requestedWaitMs: number | undefined,
  shortCommandWaitMs = 250,
): number {
  if (requestedWaitMs !== undefined) return Math.max(0, Math.trunc(requestedWaitMs));
  const normalized = normalizeRepositoryCommand(command);
  if (normalized.kind !== 'argv') return DEFAULT_COMPLETION_GRACE_MS;
  const executable = normalized.executable?.split(/[\\/]/).at(-1)?.toLowerCase();
  return executable && SHORT_COMMANDS.has(executable) ? shortCommandWaitMs : DEFAULT_COMPLETION_GRACE_MS;
}
