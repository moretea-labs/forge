import { randomUUID } from 'crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, readdirSync } from 'fs';
import { dirname, join, resolve } from 'path';
import type { OwnedResource, RecordOwnedResourceInput } from '../domain/owned-resource';

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

function readResourceFile(filePath: string): OwnedResource | undefined {
  try {
    if (!existsSync(filePath)) return undefined;
    const raw = readFileSync(filePath, 'utf8');
    return JSON.parse(raw) as OwnedResource;
  } catch {
    return undefined;
  }
}

function writeResourceFile(controllerHome: string, resource: OwnedResource): void {
  const filePath = resourcePath(controllerHome, resource.resourceId);
  const tmpPath = `${filePath}.${randomUUID()}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(resource, null, 2), 'utf8');
  renameSync(tmpPath, filePath);
}

export function recordOwnedResource(controllerHome: string, input: RecordOwnedResourceInput): OwnedResource {
  const now = new Date().toISOString();
  const resourceId = input.resourceId || `res-${randomUUID()}`;
  const resource: OwnedResource = {
    schemaVersion: 1,
    resourceId,
    kind: input.kind,
    targetRef: input.targetRef,
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
