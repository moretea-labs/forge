import { createHash, randomUUID } from 'crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync, readdirSync } from 'fs';
import { dirname, join, resolve } from 'path';
import {
  ownedResourceLocator,
  type OwnedResource,
  type OwnedResourceKind,
  type OwnedResourceLocator,
  type RecordOwnedResourceInput,
} from '../domain/owned-resource';
import { ensureForgeInstanceIdentity } from './identity-store';

function resourcesDir(controllerHome: string): string {
  const dir = resolve(controllerHome, 'owned-resources');
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return dir;
}

function resourcePath(controllerHome: string, resourceId: string): string {
  const sanitized = resourceId.replace(/[^a-zA-Z0-9._-]/g, '_');
  return join(resourcesDir(controllerHome), `${sanitized}.json`);
}

function validateOwnedResource(value: unknown): OwnedResource {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('record must be an object');
  const resource = value as OwnedResource;
  if (resource.schemaVersion !== 1 || !resource.resourceId || !resource.kind || !resource.targetRef) {
    throw new Error('required resource identity is missing');
  }
  if (!resource.provenance?.creator || !resource.provenance.createdAt || !resource.retention?.intent || !resource.status || !resource.updatedAt) {
    throw new Error('required ownership metadata is missing');
  }
  if (resource.cleanupCapable === true
    && (!resource.ownerForgeInstanceId || !resource.locator?.kind || !resource.locator.value || !resource.identityFingerprint)) {
    throw new Error('cleanup-capable resource lacks owner/locator/fingerprint');
  }
  return resource;
}

function readResourceFile(filePath: string): OwnedResource | undefined {
  if (!existsSync(filePath)) return undefined;
  try {
    return validateOwnedResource(JSON.parse(readFileSync(filePath, 'utf8')));
  } catch (error) {
    throw new Error(`OWNED_RESOURCE_STORE_CORRUPT: ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function writeResourceFile(controllerHome: string, resource: OwnedResource): void {
  const filePath = resourcePath(controllerHome, resource.resourceId);
  const tmpPath = `${filePath}.${randomUUID()}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(resource, null, 2), 'utf8');
  renameSync(tmpPath, filePath);
}

export function ownedResourceLocatorFingerprint(ownerForgeInstanceId: string, locator: OwnedResourceLocator): string {
  const owner = ownerForgeInstanceId.trim();
  if (!owner || !locator.kind || !locator.value.trim()) throw new Error('OWNED_RESOURCE_FINGERPRINT_IDENTITY_REQUIRED');
  return createHash('sha256').update(`${owner}\0${locator.kind}\0${locator.value.trim()}`).digest('hex');
}

export function ownedFilesystemIdentityFingerprint(ownerForgeInstanceId: string, pathInput: string): string {
  const path = resolve(pathInput);
  if (!existsSync(path)) throw new Error(`OWNED_RESOURCE_FILESYSTEM_TARGET_MISSING: ${path}`);
  const canonicalPath = realpathSync(path);
  const stat = lstatSync(canonicalPath);
  const kind = stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : stat.isSymbolicLink() ? 'symlink' : 'other';
  return createHash('sha256').update([
    ownerForgeInstanceId.trim(),
    'filesystem_path',
    canonicalPath,
    String(stat.dev),
    String(stat.ino),
    kind,
  ].join('\0')).digest('hex');
}

function resolvedIdentityFingerprint(
  ownerForgeInstanceId: string,
  locator: OwnedResourceLocator,
  explicitFingerprint?: string,
): string {
  const explicit = explicitFingerprint?.trim();
  if (explicit) return explicit;
  if (locator.kind === 'filesystem_path') return ownedFilesystemIdentityFingerprint(ownerForgeInstanceId, locator.value);
  return ownedResourceLocatorFingerprint(ownerForgeInstanceId, locator);
}

export interface OwnedResourceCleanupTargetInput {
  resourceId: string;
  kind: OwnedResourceKind;
  targetRef?: string;
  locator?: OwnedResourceLocator;
  identityFingerprint?: string;
}

/**
 * Cleanup authorization is an exact OwnedResource fact, never path shape or caller possession.
 * Filesystem targets are re-fingerprinted immediately before mutation so a recycled path cannot
 * inherit an older Forge ownership record.
 */
export function assertOwnedResourceCleanupTarget(
  controllerHome: string,
  input: OwnedResourceCleanupTargetInput,
): OwnedResource {
  const resource = getOwnedResource(controllerHome, input.resourceId);
  if (!resource) throw new Error(`OWNED_RESOURCE_CLEANUP_AUTHORITY_MISSING: ${input.resourceId}`);
  const currentInstance = ensureForgeInstanceIdentity({ controllerHome }).instanceId;
  if (resource.ownerForgeInstanceId !== currentInstance) {
    throw new Error(`OWNED_RESOURCE_OWNER_INSTANCE_MISMATCH: ${input.resourceId}`);
  }
  if (resource.cleanupCapable !== true) throw new Error(`OWNED_RESOURCE_NOT_CLEANUP_CAPABLE: ${input.resourceId}`);
  if (resource.status === 'released') throw new Error(`OWNED_RESOURCE_ALREADY_RELEASED: ${input.resourceId}`);
  if (resource.kind !== input.kind) throw new Error(`OWNED_RESOURCE_KIND_MISMATCH: ${input.resourceId}`);
  if (input.targetRef?.trim() && resource.targetRef !== input.targetRef.trim()) {
    throw new Error(`OWNED_RESOURCE_TARGET_MISMATCH: ${input.resourceId}`);
  }
  if (!resource.locator || !resource.identityFingerprint) throw new Error(`OWNED_RESOURCE_CLEANUP_IDENTITY_MISSING: ${input.resourceId}`);
  const expectedLocator = input.locator ?? resource.locator;
  if (expectedLocator.kind !== resource.locator.kind || expectedLocator.value.trim() !== resource.locator.value) {
    throw new Error(`OWNED_RESOURCE_LOCATOR_MISMATCH: ${input.resourceId}`);
  }
  const observedFingerprint = input.identityFingerprint?.trim()
    || (resource.locator.kind === 'filesystem_path'
      ? ownedFilesystemIdentityFingerprint(currentInstance, resource.locator.value)
      : ownedResourceLocatorFingerprint(currentInstance, expectedLocator));
  if (observedFingerprint !== resource.identityFingerprint) {
    throw new Error(`OWNED_RESOURCE_IDENTITY_FINGERPRINT_MISMATCH: ${input.resourceId}`);
  }
  return resource;
}

export function recordOwnedResource(controllerHome: string, input: RecordOwnedResourceInput): OwnedResource {
  const now = new Date().toISOString();
  const resourceId = input.resourceId || `res-${randomUUID()}`;
  // Cleanup authority is target-safe: ownership is pinned to the ForgeInstance
  // that created/adopted the resource, and the locator fingerprint follows the
  // resource kind so a recycled path/id cannot be reclaimed as the same resource.
  const ownerForgeInstanceId = input.ownerForgeInstanceId?.trim()
    || ensureForgeInstanceIdentity({ controllerHome }).instanceId;
  const locator = input.locator ?? ownedResourceLocator(input.kind, input.targetRef);
  const identityFingerprint = resolvedIdentityFingerprint(ownerForgeInstanceId, locator, input.identityFingerprint);
  const cleanupCapable = input.cleanupCapable ?? true;
  const existing = readResourceFile(resourcePath(controllerHome, resourceId));
  if (existing) {
    const sameLocator = existing.kind === input.kind
      && existing.ownerForgeInstanceId === ownerForgeInstanceId
      && existing.locator?.kind === locator.kind
      && existing.locator?.value === locator.value;
    const sameIdentity = sameLocator && existing.identityFingerprint === identityFingerprint;
    const legacyWeakFilesystemFingerprint = sameLocator
      && locator.kind === 'filesystem_path'
      && existing.identityFingerprint === ownedResourceLocatorFingerprint(ownerForgeInstanceId, locator)
      && existing.identityFingerprint !== identityFingerprint;
    if (legacyWeakFilesystemFingerprint) {
      // Never bless a pre-upgrade path-only fingerprint as the identity of the
      // currently observed inode. Preserve the historical record but retire its
      // destructive authority; a newly created resource gets a new strong witness.
      const downgraded: OwnedResource = { ...existing, cleanupCapable: false, updatedAt: now };
      writeResourceFile(controllerHome, downgraded);
      return downgraded;
    }
    if (!sameIdentity) throw new Error(`OWNED_RESOURCE_IDENTITY_CONFLICT: ${resourceId}`);
    if (existing.cleanupCapable !== true && cleanupCapable === true) {
      throw new Error(`OWNED_RESOURCE_CLEANUP_AUTHORITY_ESCALATION_FORBIDDEN: ${resourceId}`);
    }
    if (existing.status === 'released') throw new Error(`OWNED_RESOURCE_REUSE_REQUIRES_NEW_ID: ${resourceId}`);
  }
  const resource: OwnedResource = {
    schemaVersion: 1,
    resourceId,
    kind: input.kind,
    targetRef: input.targetRef,
    ownerForgeInstanceId,
    locator,
    identityFingerprint,
    cleanupCapable,
    provenance: {
      creator: input.creator,
      createdAt: now,
      associatedWorkId: input.associatedWorkId,
      associatedRequirementId: input.associatedRequirementId,
      repoId: input.repoId,
    },
    retention: {
      intent: input.retentionIntent ?? 'temporary',
      expiresAt: input.expiresAt,
    },
    status: 'active',
    updatedAt: now,
  };

  writeResourceFile(controllerHome, resource);
  return resource;
}

export function getOwnedResource(controllerHome: string, resourceId: string): OwnedResource | undefined {
  return readResourceFile(resourcePath(controllerHome, resourceId));
}

export function listOwnedResources(controllerHome: string, filter?: { kind?: string; status?: string; repoId?: string }): OwnedResource[] {
  const dir = resourcesDir(controllerHome);
  const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
  const results: OwnedResource[] = [];

  for (const file of files) {
    const resource = readResourceFile(join(dir, file));
    if (!resource) continue;
    if (filter?.kind && resource.kind !== filter.kind) continue;
    if (filter?.status && resource.status !== filter.status) continue;
    if (filter?.repoId && resource.provenance.repoId !== filter.repoId) continue;
    results.push(resource);
  }

  return results.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/** Mark an owned resource as intentionally retained without changing cleanup authority. */
export function markOwnedResourceRetained(
  controllerHome: string,
  resourceId: string,
): OwnedResource | undefined {
  const existing = getOwnedResource(controllerHome, resourceId);
  if (!existing) return undefined;
  const updated: OwnedResource = {
    ...existing,
    status: 'retained',
    updatedAt: new Date().toISOString(),
  };
  writeResourceFile(controllerHome, updated);
  return updated;
}

export function markOwnedResourceCleaned(
  controllerHome: string,
  resourceId: string,
  cleanedBy: string,
  receiptRef?: string,
): OwnedResource | undefined {
  const existing = getOwnedResource(controllerHome, resourceId);
  if (!existing) return undefined;

  const now = new Date().toISOString();
  const updated: OwnedResource = {
    ...existing,
    status: 'released',
    updatedAt: now,
    cleanupProof: {
      cleanedAt: now,
      cleanedBy,
      receiptRef,
    },
  };

  writeResourceFile(controllerHome, updated);
  return updated;
}
