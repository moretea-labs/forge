import { chmodSync } from 'fs';
import { join } from 'path';
import { readJsonFile, writeJsonAtomic } from '../shared/json-files';

export interface StableIngressSessionUpstream {
  host: string;
  port: number;
  key: string;
}

export interface StableIngressSessionRoute {
  externalSessionId: string;
  backendSessionId: string;
  route: string;
  initializeBody: string;
  contentType: string;
  upstream: StableIngressSessionUpstream;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
}

interface StableIngressSessionStoreDocument {
  schemaVersion: 1;
  updatedAt: string;
  sessions: Record<string, StableIngressSessionRoute>;
}

export const STABLE_INGRESS_SESSION_TTL_MS = 2 * 60 * 60_000;
const MAX_PERSISTED_SESSIONS = 512;

export function stableIngressSessionStorePath(controllerHome: string): string {
  return join(controllerHome, 'supervisor', 'ingress-sessions.json');
}

function validRoute(value: unknown): value is StableIngressSessionRoute {
  if (!value || typeof value !== 'object') return false;
  const route = value as Partial<StableIngressSessionRoute>;
  return typeof route.externalSessionId === 'string'
    && typeof route.backendSessionId === 'string'
    && typeof route.route === 'string'
    && typeof route.initializeBody === 'string'
    && typeof route.contentType === 'string'
    && typeof route.createdAt === 'string'
    && typeof route.updatedAt === 'string'
    && typeof route.expiresAt === 'string'
    && typeof route.upstream?.host === 'string'
    && typeof route.upstream?.port === 'number'
    && typeof route.upstream?.key === 'string';
}

export class StableIngressSessionStore {
  private readonly sessions = new Map<string, StableIngressSessionRoute>();

  constructor(
    readonly path: string,
    readonly ttlMs = STABLE_INGRESS_SESSION_TTL_MS,
  ) {
    const loaded = readJsonFile<StableIngressSessionStoreDocument>(path, {
      schemaVersion: 1,
      updatedAt: new Date(0).toISOString(),
      sessions: {},
    });
    for (const [sessionId, route] of Object.entries(loaded.sessions ?? {})) {
      if (validRoute(route) && route.externalSessionId === sessionId) this.sessions.set(sessionId, route);
    }
    this.prune(false);
  }

  get(externalSessionId: string): StableIngressSessionRoute | undefined {
    this.prune(false);
    const route = this.sessions.get(externalSessionId);
    return route ? { ...route, upstream: { ...route.upstream } } : undefined;
  }

  put(input: Omit<StableIngressSessionRoute, 'createdAt' | 'updatedAt' | 'expiresAt'> & {
    createdAt?: string;
    expiresAt?: string;
  }): StableIngressSessionRoute {
    const now = new Date();
    const existing = this.sessions.get(input.externalSessionId);
    const createdAt = input.createdAt ?? existing?.createdAt ?? now.toISOString();
    const absoluteExpiry = Date.parse(input.expiresAt ?? existing?.expiresAt ?? '');
    const expiresAt = Number.isFinite(absoluteExpiry)
      ? new Date(absoluteExpiry).toISOString()
      : new Date(Date.parse(createdAt) + this.ttlMs).toISOString();
    const route: StableIngressSessionRoute = {
      ...input,
      upstream: { ...input.upstream },
      createdAt,
      updatedAt: now.toISOString(),
      expiresAt,
    };
    this.sessions.set(route.externalSessionId, route);
    this.prune(false);
    this.persist();
    return { ...route, upstream: { ...route.upstream } };
  }

  delete(externalSessionId: string): void {
    if (!this.sessions.delete(externalSessionId)) return;
    this.persist();
  }

  snapshot(): StableIngressSessionRoute[] {
    this.prune(false);
    return Array.from(this.sessions.values(), (route) => ({ ...route, upstream: { ...route.upstream } }));
  }

  private prune(persist = true): void {
    const now = Date.now();
    let changed = false;
    for (const [sessionId, route] of this.sessions) {
      const expiresAt = Date.parse(route.expiresAt);
      if (!Number.isFinite(expiresAt) || expiresAt <= now) {
        this.sessions.delete(sessionId);
        changed = true;
      }
    }
    if (this.sessions.size > MAX_PERSISTED_SESSIONS) {
      const oldest = Array.from(this.sessions.values())
        .sort((left, right) => Date.parse(left.updatedAt) - Date.parse(right.updatedAt));
      for (const route of oldest.slice(0, this.sessions.size - MAX_PERSISTED_SESSIONS)) {
        this.sessions.delete(route.externalSessionId);
        changed = true;
      }
    }
    if (changed && persist) this.persist();
  }

  private persist(): void {
    const sessions = Object.fromEntries(
      Array.from(this.sessions.entries()).sort(([left], [right]) => left.localeCompare(right)),
    );
    writeJsonAtomic(this.path, {
      schemaVersion: 1,
      updatedAt: new Date().toISOString(),
      sessions,
    } satisfies StableIngressSessionStoreDocument);
    try { chmodSync(this.path, 0o600); } catch { /* best-effort local privacy */ }
  }
}
