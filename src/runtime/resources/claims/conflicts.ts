import type { ResourceClaimSpec } from '../../execution/jobs/types';
import type { ExecutionLease } from '../leases/types';

/**
 * Resource claim conflict model.
 *
 * There is no checkout-wide writer (#713). Source ownership is exact
 * path:<checkoutId>:<relative>; Git index/HEAD/refs, build caches and devices
 * are separate physical resources claimed only by operations that touch them.
 *
 * Same-key policy: multiple reads may share; any write/exclusive conflicts
 * with other modes on that exact resource (see claimsConflict).
 */

/** One canonical simulator device identity across Process, Plugin and Lease owners.
 * Unknown/name-selected devices retain the legacy host-wide fence.
 */
export const IOS_SIMULATOR_TEST_RESOURCE = 'host-service:ios-simulator-test';

export function iosSimulatorResourceKey(udid?: unknown): string {
  if (typeof udid !== 'string') return IOS_SIMULATOR_TEST_RESOURCE;
  const exact = udid.trim();
  return /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(exact)
    ? `${IOS_SIMULATOR_TEST_RESOURCE}:udid:${exact.toUpperCase()}`
    : IOS_SIMULATOR_TEST_RESOURCE;
}

function normalizeResourceKey(key: string): string {
  return key.trim();
}

function pathValue(key: string): string | undefined {
  if (!key.startsWith('path:')) return undefined;
  const raw = key.slice('path:'.length).replace(/^\.\//, '');
  // Support path:<checkoutId>:<relative> and legacy path:<relative>
  const parts = raw.split(':');
  if (parts.length >= 2 && !parts[0]!.includes('/') && !parts[0]!.includes('.')) {
    // checkout-scoped: return relative path portion for overlap checks
    return parts.slice(1).join(':').replace(/^\.\//, '');
  }
  return raw;
}

function pathCheckoutId(key: string): string | undefined {
  if (!key.startsWith('path:')) return undefined;
  const raw = key.slice('path:'.length);
  const parts = raw.split(':');
  if (parts.length >= 2 && !parts[0]!.includes('/') && !parts[0]!.includes('.')) {
    return parts[0];
  }
  return undefined;
}

function isGitRefKey(key: string): boolean {
  return key.startsWith('git-ref:') || key.startsWith('git-refs:') || key.startsWith('remote-ref:');
}

function scopedRemoteRef(key: string): { repoId: string; remote: string; ref: string } | undefined {
  const match = /^remote-ref:([^:]+):([^:]+):(refs\/heads\/.+)$/.exec(key);
  return match ? { repoId: match[1]!, remote: match[2]!, ref: match[3]! } : undefined;
}

/**
 * Normalize path for overlap checks.
 * Returns null when the path cannot be safely compared (symlink markers,
 * case-fold ambiguity markers, empty, absolute escape). Callers must treat
 * null as "overlap unknown" → conflict conservatively.
 */
export function normalizeClaimPath(raw: string): string | null {
  if (!raw || typeof raw !== 'string') return null;
  const path = raw.replace(/\\/g, '/').replace(/^\.\//, '');
  // Reject absolute and parent-escape for claim paths (workspace write instead).
  if (path.startsWith('/') || path.startsWith('~/') || path.includes('\0')) return null;
  // Shell text / command strings are not repository-relative paths. Allowing
  // whitespace or metacharacters produced bogus claims such as
  // `path:<checkout>:set -euo pipefail; …` under #713 concurrent admission.
  if (/[\s;|&<>$`\n\r]/.test(path)) return null;
  const segments = path.split('/').filter((s) => s.length > 0 && s !== '.');
  const out: string[] = [];
  for (const seg of segments) {
    if (seg === '..') return null;
    // Symlink-ish or case-ambiguous markers we cannot prove safe.
    if (seg.includes('->') || seg === '*') return null;
    out.push(seg);
  }
  if (out.length === 0) return null;
  return out.join('/');
}

export function pathOverlaps(left: string, right: string): boolean {
  const aNorm = normalizeClaimPath(left);
  const bNorm = normalizeClaimPath(right);
  // Unsafe / un-normalizable paths: conservative overlap.
  if (aNorm === null || bNorm === null) return true;
  const a = aNorm.replace(/\*\*?$/, '').replace(/\/$/, '');
  const b = bNorm.replace(/\*\*?$/, '').replace(/\/$/, '');
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

/**
 * Resource key overlap for mutation ownership. Source paths overlap by path;
 * the Git index, HEAD and refs are distinct physical resources (#713).
 *
 * Note: same-key overlap is true even when modes differ; mode policy lives in
 * claimsConflict (read+read allowed).
 */
export function resourceKeysOverlap(leftRaw: string, rightRaw: string): boolean {
  const left = normalizeResourceKey(leftRaw);
  const right = normalizeResourceKey(rightRaw);
  if (left === right) return true;
  // Legacy host-wide claims remain a conservative wildcard while exact UDIDs
  // on different booted simulators may proceed independently.
  const scopedPrefix = `${IOS_SIMULATOR_TEST_RESOURCE}:udid:`;
  if (
    (left === IOS_SIMULATOR_TEST_RESOURCE && right.startsWith(scopedPrefix)) ||
    (right === IOS_SIMULATOR_TEST_RESOURCE && left.startsWith(scopedPrefix))
  )
    return true;

  // A single exact remote ref is independent from different review refs,
  // while opaque Git pushes and repo-wide remote mutations stay exclusive.
  // Do not add index ownership: deleting a remote ref does not edit
  // another Checkout's source tree.
  const leftRemoteRef = scopedRemoteRef(left);
  const rightRemoteRef = scopedRemoteRef(right);
  if (leftRemoteRef || rightRemoteRef) {
    if (leftRemoteRef && rightRemoteRef) {
      return (
        leftRemoteRef.repoId === rightRemoteRef.repoId &&
        leftRemoteRef.remote === rightRemoteRef.remote &&
        leftRemoteRef.ref === rightRemoteRef.ref
      );
    }
    const exact = leftRemoteRef ?? rightRemoteRef!;
    const other = leftRemoteRef ? right : left;
    return (
      other === `remote:${exact.repoId}` ||
      other === `git-refs:${exact.repoId}` ||
      other.startsWith('git-ref:') ||
      other === 'repo-content:*'
    );
  }

  // Explicit Xcode caches also carry a shared read on build-cache:<repo>.
  // Opaque builds retain its write lock; concrete caches serialize by physical
  // path (including ancestor/child overlap), even across different repositories.
  const cacheMarker = ':xcode-derived-data:';
  if (
    left.startsWith('build-cache:') &&
    right.startsWith('build-cache:') &&
    left.includes(cacheMarker) &&
    right.includes(cacheMarker)
  ) {
    return pathOverlaps(
      left.slice(left.indexOf(cacheMarker) + cacheMarker.length).replace(/^\/+/, ''),
      right.slice(right.indexOf(cacheMarker) + cacheMarker.length).replace(/^\/+/, ''),
    );
  }

  if (left === 'repo-content:*') {
    return (
      right === 'repo-content:*' ||
      right.startsWith('path:') ||
      isGitRefKey(right) ||
      right.startsWith('git-index:') ||
      right.startsWith('git-head:')
    );
  }
  if (right === 'repo-content:*') {
    return (
      left.startsWith('path:') ||
      isGitRefKey(left) ||
      left.startsWith('git-index:') ||
      left.startsWith('git-head:')
    );
  }

  const leftPath = pathValue(left);
  const rightPath = pathValue(right);
  if (leftPath !== undefined && rightPath !== undefined) {
    const leftCheckout = pathCheckoutId(left);
    const rightCheckout = pathCheckoutId(right);
    if (leftCheckout && rightCheckout && leftCheckout !== rightCheckout) return false;
    return pathOverlaps(leftPath, rightPath);
  }

  // Repository-scoped Git refs cannot conflict across different repositories.
  // Same-repository keys already matched above; legacy unscoped git-ref keys
  // remain conservative because they have no provable repository identity.
  if (left.startsWith('git-refs:') && right.startsWith('git-refs:')) return false;
  if (isGitRefKey(left) && isGitRefKey(right)) return true;

  return false;
}

export function resourceClaimsConflict(
  left: Pick<ResourceClaimSpec, 'resourceKey' | 'mode'>,
  right: Pick<ResourceClaimSpec, 'resourceKey' | 'mode'>,
): boolean {
  const leftKey = normalizeResourceKey(left.resourceKey);
  const rightKey = normalizeResourceKey(right.resourceKey);
  const leftRelease = leftKey.startsWith('release:');
  const rightRelease = rightKey.startsWith('release:');
  if (leftRelease || rightRelease) {
    if (leftRelease && rightRelease) return true;
    // Release Freeze blocks mutations and external effects but intentionally
    // allows read-only observation and Schedule triage to remain available.
    const nonReleaseMode = leftRelease ? right.mode : left.mode;
    return nonReleaseMode !== 'read';
  }
  if (!resourceKeysOverlap(leftKey, rightKey)) return false;
  // Read + read may share; any write/exclusive conflicts.
  return left.mode !== 'read' || right.mode !== 'read';
}

export function claimsConflict(claim: ResourceClaimSpec, lease: ExecutionLease): boolean {
  return resourceClaimsConflict(claim, lease);
}

export function normalizeClaims(
  claims: ResourceClaimSpec[],
  options: { readOnly?: boolean } = {},
): ResourceClaimSpec[] {
  // No claims means no shared resource. There is no implicit repository-wide
  // writer for commands whose effect scope is unknown (#713).
  if (claims.length === 0) return [];
  const map = new Map<string, ResourceClaimSpec>();
  for (const claim of claims) {
    const key = normalizeResourceKey(claim.resourceKey);
    if (!key) continue;
    const existing = map.get(key);
    if (
      !existing ||
      (existing.mode === 'read' && claim.mode !== 'read') ||
      (existing.mode === 'write' && claim.mode === 'exclusive')
    ) {
      map.set(key, { ...claim, resourceKey: key });
    }
  }
  return [...map.values()];
}
