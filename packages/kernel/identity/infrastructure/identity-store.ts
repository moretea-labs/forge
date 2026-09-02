import { randomUUID } from 'crypto';
import { closeSync, existsSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import type { ForgeInstanceIdentity } from '../domain/types';

export interface ForgeIdentityStoreOptions {
  controllerHome: string;
  now?: () => string;
  preferredInstanceId?: string;
  label?: string;
}

function normalizedInstanceId(value: string | undefined): string | undefined {
  const id = value?.trim();
  if (!id) return undefined;
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{2,191}$/.test(id)) throw new Error('FORGE_INSTANCE_ID_INVALID');
  return id;
}

export function forgeInstanceIdentityPath(controllerHome: string): string {
  return join(resolve(controllerHome), 'identity', 'forge-instance.json');
}

export function readForgeInstanceIdentity(controllerHome: string): ForgeInstanceIdentity | undefined {
  const path = forgeInstanceIdentityPath(controllerHome);
  if (!existsSync(path)) return undefined;
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as ForgeInstanceIdentity;
    if (value.schemaVersion !== 1 || !normalizedInstanceId(value.instanceId) || typeof value.createdAt !== 'string') return undefined;
    return value;
  } catch {
    return undefined;
  }
}

export function ensureForgeInstanceIdentity(options: ForgeIdentityStoreOptions): ForgeInstanceIdentity {
  const existing = readForgeInstanceIdentity(options.controllerHome);
  const preferred = normalizedInstanceId(options.preferredInstanceId);
  if (existing) {
    if (preferred && existing.instanceId !== preferred) {
      throw new Error(`FORGE_INSTANCE_ID_MISMATCH: existing=${existing.instanceId} requested=${preferred}`);
    }
    return existing;
  }
  const path = forgeInstanceIdentityPath(options.controllerHome);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const identity: ForgeInstanceIdentity = {
    schemaVersion: 1,
    instanceId: preferred ?? `forge_${randomUUID().replaceAll('-', '')}`,
    createdAt: (options.now ?? (() => new Date().toISOString()))(),
    ...(options.label?.trim() ? { label: options.label.trim().slice(0, 160) } : {}),
  };
  const temporary = `${path}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  const fd = openSync(temporary, 'wx', 0o600);
  try {
    writeFileSync(fd, `${JSON.stringify(identity, null, 2)}\n`, 'utf8');
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    // link() is atomic and refuses to replace an existing semantic identity.
    linkSync(temporary, path);
    unlinkSync(temporary);
    return identity;
  } catch (error) {
    try { unlinkSync(temporary); } catch { /* best effort */ }
    const raced = readForgeInstanceIdentity(options.controllerHome);
    if (raced) {
      if (preferred && raced.instanceId !== preferred) throw new Error(`FORGE_INSTANCE_ID_MISMATCH: existing=${raced.instanceId} requested=${preferred}`);
      return raced;
    }
    throw error;
  }
}
