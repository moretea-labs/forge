import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { randomUUID } from 'crypto';
import { ensureControllerHome } from '../../cli/repositories/controller-home';

export interface RuntimeReleaseAuthority {
  releasePath: string;
  releaseRevision: string;
  sourceCommit: string;
  manifestHash: string;
  publishedAt: string;
}

export interface RuntimePreviousAuthority extends RuntimeReleaseAuthority {
  rollbackUntil: string;
}

export interface RuntimeAuthority {
  schemaVersion: 1;
  authorityTerm: string;
  activationId: string;
  generation: string;
  active: RuntimeReleaseAuthority;
  previous?: RuntimePreviousAuthority;
  ingress: { host: string; port: number };
  operationId?: string;
}

export interface RuntimeConfig {
  schemaVersion: 1;
  controllerHome: string;
  ingress: { host: string; port: number };
  daemon: { port: number };
  gateway: { host: string; port: number; auth: string };
  primaryPublicEndpoint?: string;
  primaryTunnelService?: string;
  toolset: string;
  accessMode: string;
}

export function runtimeAuthorityPath(controllerHome: string): string {
  return join(ensureControllerHome(controllerHome), 'bootstrap', 'runtime-authority.json');
}

export function runtimeConfigPath(controllerHome: string): string {
  return join(ensureControllerHome(controllerHome), 'bootstrap', 'runtime-config.json');
}

function readJson<T>(path: string): T | undefined {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return undefined;
  }
}

function atomicWrite(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  renameSync(temporary, path);
}

function validPort(port: number | undefined): boolean {
  return typeof port === 'number' && Number.isInteger(port) && port >= 0 && port <= 65_535;
}

function validEndpoint(endpoint: { host: string; port: number } | undefined): boolean {
  return Boolean(endpoint && typeof endpoint.host === 'string' && endpoint.host.length > 0 && validPort(endpoint.port));
}

function validRelease(release: RuntimeReleaseAuthority | undefined): release is RuntimeReleaseAuthority {
  return Boolean(release
    && typeof release.releasePath === 'string'
    && typeof release.releaseRevision === 'string'
    && typeof release.sourceCommit === 'string'
    && typeof release.manifestHash === 'string'
    && typeof release.publishedAt === 'string');
}

export function readRuntimeAuthority(controllerHome: string): RuntimeAuthority | undefined {
  const value = readJson<RuntimeAuthority>(runtimeAuthorityPath(controllerHome));
  if (!value || value.schemaVersion !== 1 || !value.authorityTerm || !value.activationId || !value.generation) return undefined;
  if (!validRelease(value.active) || !validEndpoint(value.ingress)) return undefined;
  if (value.previous && (!validRelease(value.previous) || !value.previous.rollbackUntil)) return undefined;
  return value;
}

export function readRuntimeConfig(controllerHome: string): RuntimeConfig | undefined {
  const value = readJson<RuntimeConfig>(runtimeConfigPath(controllerHome));
  if (!value || value.schemaVersion !== 1 || resolve(value.controllerHome) !== resolve(controllerHome)) return undefined;
  if (!validEndpoint(value.ingress) || !validPort(value.daemon?.port) || !validEndpoint(value.gateway)) return undefined;
  if (!value.gateway.auth || !value.toolset || !value.accessMode) return undefined;
  return value;
}

export function writeRuntimeAuthority(controllerHome: string, authority: RuntimeAuthority): void {
  if (authority.schemaVersion !== 1 || !validRelease(authority.active) || !validEndpoint(authority.ingress)) {
    throw new Error('RUNTIME_AUTHORITY_INVALID');
  }
  atomicWrite(runtimeAuthorityPath(controllerHome), authority);
}
export function writeRuntimeConfig(controllerHome: string, config: RuntimeConfig): void {
  if (config.schemaVersion !== 1 || resolve(config.controllerHome) !== resolve(controllerHome)
    || !validEndpoint(config.ingress) || !validPort(config.daemon?.port) || !validEndpoint(config.gateway)) {
    throw new Error('RUNTIME_CONFIG_INVALID');
  }
  atomicWrite(runtimeConfigPath(controllerHome), { ...config, controllerHome: resolve(controllerHome) });
}

export function requireRuntimeAuthority(controllerHome: string): RuntimeAuthority {
  const authority = readRuntimeAuthority(controllerHome);
  if (authority) return authority;
  const legacy = join(ensureControllerHome(controllerHome), 'active-slot.json');
  if (existsSync(legacy)) throw new Error('MIGRATION_REQUIRED: runtime-authority.json is missing or invalid');
  throw new Error('RUNTIME_AUTHORITY_MISSING');
}

export function requireRuntimeConfig(controllerHome: string): RuntimeConfig {
  const config = readRuntimeConfig(controllerHome);
  if (config) return config;
  const legacy = join(ensureControllerHome(controllerHome), '.repo-harness', 'mcp.local.json');
  if (existsSync(legacy)) throw new Error('MIGRATION_REQUIRED: runtime-config.json is missing or invalid');
  throw new Error('RUNTIME_CONFIG_MISSING');
}
