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

function claimHostService(serviceKey: string, mode: 'read' | 'write' = 'write'): ResourceClaimSpec {
  const normalized = serviceKey.trim().replace(/\s+/g, '-').slice(0, 240) || 'global';
  return { resourceKey: `host-service:${normalized}`, mode };
}

function hostOnlyCommandClaims(command: string | readonly string[]): ResourceClaimSpec[] | undefined {
  const canonical = normalizeRepositoryCommand(command);
  if (canonical.kind !== 'argv') return undefined;
  const program = (canonical.executable ?? '').split(/[\\/]/).at(-1)?.toLowerCase();
  const args = canonical.args ?? [];
  if (program !== 'launchctl') return undefined;
  const subcommand = args[0]?.toLowerCase() ?? '';
  const target = [...args].reverse().find((arg) => arg && !arg.startsWith('-')) ?? subcommand ?? 'global';
  if (['print', 'print-disabled', 'list', 'managerpid', 'manageruid'].includes(subcommand)) {
    return [claimHostService(`launchctl:${target}`, 'read')];
  }
  // launchctl mutates launchd/service state, not the Git checkout. Serialize
  // only operations that address the same host service/domain instead of taking
  // the checkout-wide workspace lease.
  return [claimHostService(`launchctl:${target}`, 'write')];
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
  return /(?:^|:)(?:type|typecheck|lint|format:check|runtime-architecture|mcp-compatibility|forge-runtime)$/.test(
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

/**
 * A typed argv TypeScript --noEmit invocation reads source/config and may still
 * update incremental build metadata. Model that metadata as build-cache rather
 * than claiming the whole checkout as a writer. Shell strings and package-script
 * aliases remain conservative because their real effects are not proven here.
 */
function isTypedTypeScriptNoEmit(command: string | readonly string[]): boolean {
  if (!Array.isArray(command) || command.length === 0) return false;
  const words = command.map((value) => String(value));
  const base = (value: string): string => value.replace(/\\/g, '/').split('/').at(-1)?.toLowerCase() ?? '';
  let program = base(words[0] ?? '');
  let args = words.slice(1);
  if (program === 'bun' && args[0]?.toLowerCase() === 'x' && base(args[1] ?? '') === 'tsc') {
    program = 'tsc';
    args = args.slice(2);
  } else if (program === 'npx' && base(args[0] ?? '') === 'tsc') {
    program = 'tsc';
    args = args.slice(1);
  }
  if (program !== 'tsc') return false;
  return args.some((arg) => arg === '--noEmit' || arg.toLowerCase() === '--noemit');
}

function focusedTestRequestsWorkspaceMutation(command: string | readonly string[]): boolean {
  const canonical = normalizeRepositoryCommand(command);
  if (canonical.kind !== 'argv') return true;
  const args = (canonical.args ?? []).map((value) => value.toLowerCase());
  return args.includes('-u')
    || args.includes('--update-snapshots')
    || args.includes('--update-snapshot')
    || args.some((value) => value.startsWith('--update-snapshots='));
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
  const hostClaims = hostOnlyCommandClaims(command);
  if (hostClaims) return hostClaims;

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

  // workspace_write — refine. Typed noEmit may write only incremental metadata,
  // while ordinary focused tests are observation unless snapshot-update mode is
  // explicit. Both can share repository source reads without a workspace writer.
  if (isTypedTypeScriptNoEmit(command)) {
    return [claimWorkspaceRead(checkoutId), claimBuildCacheWrite(repoId)];
  }
  if (focused) {
    if (!focusedTestRequestsWorkspaceMutation(command)) return [claimWorkspaceRead(checkoutId)];
    const claims: ResourceClaimSpec[] = [claimWorkspaceRead(checkoutId)];
    for (const path of extractLikelyPaths(command).slice(0, 16)) claims.push(claimPathWrite(path, checkoutId));
    return normalizeClaims(claims);
  }
  if (looksLikeBuildOrTest(command)) {
    const paths = extractLikelyPaths(command);
    if (paths.length === 0) {
      // Broad or opaque build/test commands may create arbitrary artifacts.
      return [claimWorkspaceWrite(checkoutId), claimBuildCacheWrite(repoId)];
    }
    const claims: ResourceClaimSpec[] = [claimWorkspaceRead(checkoutId), claimBuildCacheWrite(repoId)];
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
  const heavy = /(?:^|:)(?:test(?::coverage)?|check:(?:ci|forge-runtime|public-export|release(?:-[a-z0-9-]+)?))$/.test(checkId)
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
