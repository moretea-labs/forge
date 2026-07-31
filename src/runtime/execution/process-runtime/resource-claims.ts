/**
 * Fine-grained resource claims for Process Runtime and MCP operations.
 * Prefer path / git-index / git-refs / build-cache over whole-repo exclusive locks.
 */

import type { ResourceClaimSpec } from '../jobs/types';
import type { ControllerCheckEffects } from '../../../cli/controller/check-runner';
import { classifyRepositoryCommand } from '../../../cli/repositories/command-classifier';
import { normalizeRepositoryCommand } from '../../../cli/repositories/command-normalization';
import { isFocusedCheckCommand } from '../thin-harness/execution-router';
import type { ProcessResourceClaim } from './types';
import { normalizeClaimPath, normalizeClaims } from '../../resources/claims/conflicts';

export type ResourceClaimKind =
  | 'workspace_read'
  | 'path_read'
  | 'path_write'
  | 'build_cache_read'
  | 'build_cache_write'
  | 'temp'
  | 'network'
  | 'git_index'
  | 'git_refs'
  | 'integration'
  | 'migration'
  | 'release'
  | 'remote_mutation'
  | 'heavy_check'
  | 'workspace_write';

function checkoutScope(checkoutId?: string): string {
  return checkoutId?.trim() || 'active';
}

/**
 * Workspace read uses the same resource key as workspace write.
 * Conflict is expressed via mode (read vs write), not a separate key.
 * Legacy workspace-read:* keys are normalized in claims/conflicts.ts.
 */
export function claimWorkspaceRead(checkoutId?: string): ResourceClaimSpec {
  return { resourceKey: `workspace:${checkoutScope(checkoutId)}`, mode: 'read' };
}

export function claimPathRead(path: string, checkoutId?: string): ResourceClaimSpec {
  if (path === '.') return claimWorkspaceRead(checkoutId);
  const normalized = normalizeClaimPath(path);
  if (!normalized) return claimWorkspaceRead(checkoutId);
  return { resourceKey: `path:${checkoutScope(checkoutId)}:${normalized}`, mode: 'read' };
}

export function claimPathWrite(path: string, checkoutId?: string): ResourceClaimSpec {
  const normalized = normalizeClaimPath(path);
  if (!normalized) {
    // Unsafe / ambiguous path → escalate to whole-checkout workspace write.
    return claimWorkspaceWrite(checkoutId);
  }
  return { resourceKey: `path:${checkoutScope(checkoutId)}:${normalized}`, mode: 'write' };
}

export function claimBuildCacheRead(repoId: string): ResourceClaimSpec {
  return { resourceKey: `build-cache:${repoId}`, mode: 'read' };
}

export function claimBuildCacheWrite(repoId: string): ResourceClaimSpec {
  return { resourceKey: `build-cache:${repoId}`, mode: 'write' };
}

export function claimGitIndexRead(checkoutId?: string): ResourceClaimSpec {
  return { resourceKey: `git-index:${checkoutScope(checkoutId)}`, mode: 'read' };
}

export function claimGitIndex(checkoutId?: string): ResourceClaimSpec {
  return { resourceKey: `git-index:${checkoutScope(checkoutId)}`, mode: 'exclusive' };
}

export function claimGitRefsRead(repoId: string): ResourceClaimSpec {
  return { resourceKey: `git-refs:${repoId}`, mode: 'read' };
}

export function claimGitRefs(repoId: string): ResourceClaimSpec {
  return { resourceKey: `git-refs:${repoId}`, mode: 'exclusive' };
}

export function claimIntegration(repoId: string): ResourceClaimSpec {
  return { resourceKey: `integration:${repoId}`, mode: 'exclusive' };
}

export function claimRelease(repoId: string): ResourceClaimSpec {
  return { resourceKey: `release:${repoId}`, mode: 'exclusive' };
}

export function claimRemoteMutation(repoId: string): ResourceClaimSpec {
  return { resourceKey: `remote:${repoId}`, mode: 'exclusive' };
}

export function claimWorkspaceWrite(checkoutId?: string): ResourceClaimSpec {
  return { resourceKey: `workspace:${checkoutScope(checkoutId)}`, mode: 'write' };
}

export function claimHeavyCheck(repoId: string): ResourceClaimSpec {
  return { resourceKey: `heavy-check:${repoId}`, mode: 'exclusive' };
}

function claimTemp(checkId: string, repoId: string, scope: 'isolated' | 'shared'): ResourceClaimSpec {
  const identity = checkId.replace(/[^a-zA-Z0-9._-]+/g, '-');
  return { resourceKey: scope === 'shared' ? `temp:${repoId}` : `temp:${repoId}:${identity}`, mode: 'write' };
}

function claimNetwork(repoId: string, mode: 'read' | 'write'): ResourceClaimSpec {
  return { resourceKey: `network:${repoId}`, mode };
}

function staticAnalysisCheckId(checkId: string): boolean {
  const normalized = checkId.trim().toLowerCase();
  if (!normalized.startsWith('package:')) return false;
  return /(?:^|:)(?:type|typecheck|lint|format:check|runtime-architecture|mcp-compatibility|controller-v8)$/.test(
    normalized.slice('package:'.length),
  );
}

function claimsForDeclaredCheckEffects(
  checkId: string,
  effects: ControllerCheckEffects,
  repoId: string,
  checkoutId?: string,
): ResourceClaimSpec[] {
  const claims: ResourceClaimSpec[] = [];
  const hasDeclaredField = Object.keys(effects).length > 0;
  if (!hasDeclaredField) return [claimWorkspaceWrite(checkoutId)];

  // Missing read scope is unknown, so custom checks fail closed. An explicit
  // reads: [] means the command does not inspect repository content.
  if (effects.reads === undefined) claims.push(claimWorkspaceWrite(checkoutId));
  else for (const path of effects.reads) claims.push(claimPathRead(path, checkoutId));
  for (const path of effects.writes ?? []) claims.push(claimPathWrite(path, checkoutId));

  if (effects.cache === 'read') claims.push(claimBuildCacheRead(repoId));
  if (effects.cache === 'write') claims.push(claimBuildCacheWrite(repoId));
  if (effects.temp) claims.push(claimTemp(checkId, repoId, effects.temp));
  if (effects.git === 'read') claims.push(claimGitIndexRead(checkoutId), claimGitRefsRead(repoId));
  if (effects.git === 'index') claims.push(claimGitIndex(checkoutId));
  if (effects.git === 'refs') claims.push(claimGitRefs(repoId));
  if (effects.git === 'write') claims.push(claimWorkspaceWrite(checkoutId), claimGitIndex(checkoutId), claimGitRefs(repoId));
  if (effects.network) claims.push(claimNetwork(repoId, effects.network));

  return normalizeClaims(claims, { readOnly: claims.every((claim) => claim.mode === 'read') });
}

function looksLikeBuildOrTest(command: string | readonly string[]): boolean {
  const text = Array.isArray(command) ? command.join(' ') : String(command);
  const lower = text.toLowerCase();
  return /\b(?:bun|npm|pnpm|yarn|node|cargo|go|swift|pytest|xcodebuild|tsc|eslint|biome)\b/.test(lower)
    && /\b(?:test|check|typecheck|lint|build|compile)\b/.test(lower);
}

function extractLikelyPaths(command: string | readonly string[]): string[] {
  const words = Array.isArray(command)
    ? command.map(String)
    : String(command).split(/\s+/);
  return words.filter((word) => {
    if (!word || word.startsWith('-')) return false;
    return word.includes('/')
      || word.includes('\\')
      || /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|swift|test|spec|json|md)$/i.test(word);
  }).map((word) => word.replace(/^\.\//, '').replace(/\\/g, '/'));
}

/**
 * Classify resource claims for a repository command without taking whole-repo exclusive locks
 * for ordinary readonly / focused validation commands.
 */
export function claimsForRepositoryCommand(
  command: string | readonly string[],
  repoId: string,
  checkoutId?: string,
  defaultBranch?: string,
): ResourceClaimSpec[] {
  const classification = classifyRepositoryCommand(command, defaultBranch);
  const canonical = normalizeRepositoryCommand(command);
  const focused = isFocusedCheckCommand(command);

  if (classification.risk === 'readonly') {
    return [claimWorkspaceRead(checkoutId)];
  }
  if (classification.risk === 'remote_write') {
    return [claimRemoteMutation(repoId), claimGitRefs(repoId)];
  }
  if (classification.risk === 'destructive') {
    return [
      claimWorkspaceWrite(checkoutId),
      claimGitIndex(checkoutId),
      claimGitRefs(repoId),
    ];
  }

  // workspace_write — refine
  if (focused || looksLikeBuildOrTest(command)) {
    const paths = extractLikelyPaths(command);
    if (paths.length === 0) {
      // Unknown read/output scopes: fail closed to a single workspace write
      // plus build-cache ownership. Do not request read+write on the same key.
      return [claimWorkspaceWrite(checkoutId), claimBuildCacheWrite(repoId)];
    }
    const claims: ResourceClaimSpec[] = [claimWorkspaceRead(checkoutId), claimBuildCacheWrite(repoId)];
    // Focused tests may write snapshots next to sources.
    for (const path of paths.slice(0, 16)) claims.push(claimPathWrite(path, checkoutId));
    return normalizeClaims(claims);
  }

  const program = canonical.kind === 'argv'
    ? (canonical.executable ?? '').split(/[\\/]/).at(-1)?.toLowerCase()
    : undefined;
  const sub = canonical.kind === 'argv' ? canonical.args?.[0]?.toLowerCase() : undefined;
  if (program === 'git') {
    if (sub === 'add' || sub === 'rm' || sub === 'mv' || sub === 'restore' || sub === 'apply') {
      return [claimGitIndex(checkoutId), claimWorkspaceWrite(checkoutId)];
    }
    if (sub === 'commit' || sub === 'merge' || sub === 'rebase' || sub === 'cherry-pick' || sub === 'revert') {
      return [claimGitIndex(checkoutId), claimGitRefs(repoId), claimWorkspaceWrite(checkoutId)];
    }
    if (sub === 'checkout' || sub === 'switch' || sub === 'branch' || sub === 'tag') {
      return [claimGitRefs(repoId), claimWorkspaceWrite(checkoutId)];
    }
  }

  // Unknown mutating command — workspace write, not heavy-check exclusive.
  return [claimWorkspaceWrite(checkoutId)];
}

/**
 * Claims for run_check by check id / command.
 * Only full CI / release / multi-phase checks take heavy-check exclusive.
 */
export function claimsForCheck(
  checkId: string,
  command: readonly string[] | undefined,
  repoId: string,
  checkoutId?: string,
  effects?: ControllerCheckEffects,
): ResourceClaimSpec[] {
  // Self-hosting controller-v8 spawns nested jobs; exclusive heavy-check would deadlock.
  if (/(?:^|:)(?:check:controller-v8|package:check:controller-v8|controller-v8)(?:$|:)/i.test(checkId)) {
    return [claimWorkspaceRead(checkoutId), claimBuildCacheWrite(repoId)];
  }
  const heavy = /(?:^|:)(?:test(?::coverage)?|check:(?:ci|public-export|release(?:-[a-z0-9-]+)?))$/.test(checkId)
    || /release|migration|integrate/i.test(checkId);
  if (heavy) return [claimHeavyCheck(repoId)];
  if (effects) return claimsForDeclaredCheckEffects(checkId, effects, repoId, checkoutId);
  if (staticAnalysisCheckId(checkId)) return [claimWorkspaceRead(checkoutId), claimBuildCacheWrite(repoId)];
  if (command && command.length > 0) return claimsForRepositoryCommand(command, repoId, checkoutId);
  // Unknown named checks without a command/effects contract remain conservative.
  return [claimWorkspaceWrite(checkoutId)];
}

export function scopeResourceClaims(
  claims: ResourceClaimSpec[],
  repoId: string,
  checkoutId?: string,
  workId?: string,
): ResourceClaimSpec[] {
  const normalizedWorkId = workId?.trim();
  if (!normalizedWorkId) return claims;
  const normalizedRepoId = repoId.trim();
  const normalizedCheckoutId = checkoutId?.trim();
  if (!normalizedRepoId) throw new Error('RESOURCE_CLAIM_REPOSITORY_REQUIRED');
  if (!normalizedCheckoutId) throw new Error(`RESOURCE_CLAIM_CHECKOUT_REQUIRED: ${normalizedWorkId}`);
  return claims.map((claim) => {
    if (claim.repoId && claim.repoId !== normalizedRepoId) throw new Error('RESOURCE_CLAIM_REPOSITORY_MISMATCH');
    if (claim.checkoutId && claim.checkoutId !== normalizedCheckoutId) throw new Error('RESOURCE_CLAIM_CHECKOUT_MISMATCH');
    if (claim.workId && claim.workId !== normalizedWorkId) throw new Error('RESOURCE_CLAIM_WORK_MISMATCH');
    return {
      ...claim,
      repoId: normalizedRepoId,
      checkoutId: normalizedCheckoutId,
      workId: normalizedWorkId,
    };
  });
}

export function toProcessClaims(claims: ResourceClaimSpec[]): ProcessResourceClaim[] {
  return claims.map((claim) => ({
    resourceKey: claim.resourceKey,
    mode: claim.mode,
    ...(claim.repoId ? { repoId: claim.repoId } : {}),
    ...(claim.checkoutId ? { checkoutId: claim.checkoutId } : {}),
    ...(claim.workId ? { workId: claim.workId } : {}),
  }));
}
