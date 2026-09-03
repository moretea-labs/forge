import { readFileSync } from 'fs';
import { join } from 'path';
import { controllerSystemRoot } from '../../cli/repositories/controller-home';
import { readJsonFile, writeJsonAtomic } from '../shared/json-files';

export interface PackagedPluginTrustPolicy {
  schemaVersion: 1;
  firstPartyRepositoryPrefixes: string[];
}

export interface ControllerPluginTrustPolicy {
  schemaVersion: 1;
  trustedRepositories: string[];
  updatedAt: string;
}

function normalizeRepositoryUrl(value: string): string {
  let parsed: URL;
  try { parsed = new URL(value.trim()); } catch { throw new Error(`PLUGIN_TRUST_REPOSITORY_URL_INVALID: ${value}`); }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash || !parsed.hostname || !parsed.pathname.endsWith('.git')) {
    throw new Error(`PLUGIN_TRUST_REPOSITORY_URL_INVALID: ${value}`);
  }
  return parsed.toString();
}

export function loadPackagedPluginTrustPolicy(path: string): PackagedPluginTrustPolicy {
  const value = JSON.parse(readFileSync(path, 'utf8')) as PackagedPluginTrustPolicy;
  if (value.schemaVersion !== 1 || !Array.isArray(value.firstPartyRepositoryPrefixes) || value.firstPartyRepositoryPrefixes.length < 1) {
    throw new Error('PLUGIN_TRUST_POLICY_INVALID');
  }
  for (const prefix of value.firstPartyRepositoryPrefixes) {
    let parsed: URL;
    try { parsed = new URL(prefix); } catch { throw new Error('PLUGIN_TRUST_POLICY_INVALID'); }
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash || !prefix.endsWith('/')) throw new Error('PLUGIN_TRUST_POLICY_INVALID');
  }
  return value;
}

export function assertFirstPartyPluginRepositoryTrusted(repository: string, policyPath: string): string {
  const normalized = normalizeRepositoryUrl(repository);
  const policy = loadPackagedPluginTrustPolicy(policyPath);
  if (!policy.firstPartyRepositoryPrefixes.some((prefix) => normalized.startsWith(prefix))) {
    throw new Error(`PLUGIN_CATALOG_UNTRUSTED_REPOSITORY: ${repository}`);
  }
  return normalized;
}

export function controllerPluginTrustPolicyPath(controllerHome: string): string {
  return join(controllerSystemRoot(controllerHome), 'plugins', 'catalog-trust.v1.json');
}

export function readControllerPluginTrustPolicy(controllerHome: string): ControllerPluginTrustPolicy {
  const path = controllerPluginTrustPolicyPath(controllerHome);
  const value = readJsonFile<ControllerPluginTrustPolicy | undefined>(path, undefined);
  if (!value) return { schemaVersion: 1, trustedRepositories: [], updatedAt: new Date(0).toISOString() };
  if (value.schemaVersion !== 1 || !Array.isArray(value.trustedRepositories)) throw new Error('PLUGIN_CONTROLLER_TRUST_POLICY_INVALID');
  const trustedRepositories = [...new Set(value.trustedRepositories.map(normalizeRepositoryUrl))].sort();
  return { schemaVersion: 1, trustedRepositories, updatedAt: value.updatedAt };
}

export function trustExternalPluginRepository(controllerHome: string, repository: string): ControllerPluginTrustPolicy {
  const normalized = normalizeRepositoryUrl(repository);
  const current = readControllerPluginTrustPolicy(controllerHome);
  const next = { schemaVersion: 1 as const, trustedRepositories: [...new Set([...current.trustedRepositories, normalized])].sort(), updatedAt: new Date().toISOString() };
  writeJsonAtomic(controllerPluginTrustPolicyPath(controllerHome), next);
  return next;
}

export function untrustExternalPluginRepository(controllerHome: string, repository: string): ControllerPluginTrustPolicy {
  const normalized = normalizeRepositoryUrl(repository);
  const current = readControllerPluginTrustPolicy(controllerHome);
  const next = { schemaVersion: 1 as const, trustedRepositories: current.trustedRepositories.filter((entry) => entry !== normalized), updatedAt: new Date().toISOString() };
  writeJsonAtomic(controllerPluginTrustPolicyPath(controllerHome), next);
  return next;
}

export function assertExternalPluginRepositoryTrusted(controllerHome: string, repository: string): string {
  const normalized = normalizeRepositoryUrl(repository);
  const policy = readControllerPluginTrustPolicy(controllerHome);
  if (!policy.trustedRepositories.includes(normalized)) throw new Error(`PLUGIN_EXTERNAL_REPOSITORY_TRUST_REQUIRED: ${normalized}`);
  return normalized;
}
