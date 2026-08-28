import { globMatches } from '../../../cli/mcp/paths';
import type { WorkContract } from '../facade/types';

export interface WorkPathScopeViolation {
  kind: 'forbidden' | 'out_of_scope';
  path: string;
  pattern?: string;
}

/**
 * WorkContract path scope is the durable mutation authority. Edit-session or
 * caller-local path filters may narrow this scope, but they can never widen it.
 */
export function findWorkPathScopeViolation(
  work: Pick<WorkContract, 'allowedPaths' | 'forbiddenPaths'>,
  paths: readonly string[],
): WorkPathScopeViolation | undefined {
  for (const path of [...new Set(paths.map((value) => value.trim()).filter(Boolean))]) {
    const forbidden = work.forbiddenPaths.find((pattern) => globMatches(pattern, path));
    if (forbidden) return { kind: 'forbidden', path, pattern: forbidden };
    if (work.allowedPaths.length > 0 && !work.allowedPaths.some((pattern) => globMatches(pattern, path))) {
      return { kind: 'out_of_scope', path };
    }
  }
  return undefined;
}

export function assertWorkPathsWithinScope(
  work: Pick<WorkContract, 'allowedPaths' | 'forbiddenPaths'>,
  paths: readonly string[],
  codes: { forbidden: string; outOfScope: string },
): void {
  const violation = findWorkPathScopeViolation(work, paths);
  if (!violation) return;
  if (violation.kind === 'forbidden') throw new Error(`${codes.forbidden}: ${violation.path}`);
  throw new Error(`${codes.outOfScope}: ${violation.path}`);
}
