import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  accessModeDescriptor,
  evaluateAccessMode,
  readRepositoryAccessPolicy,
  repositoryAccessPolicyPath,
  writeRepositoryAccessPolicy,
} from '../src/runtime/control-plane/governance/access-policy';
import { evaluatePolicyGate } from '../src/runtime/control-plane/facade/policy-gate';

const tempRoots: string[] = [];

function controllerHome(): string {
  const root = mkdtempSync(join(tmpdir(), 'forge-access-policy-'));
  tempRoots.push(root);
  return root;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('repository access policy', () => {
  test('defaults to Full Access without writing controller state', () => {
    const home = controllerHome();
    const policy = readRepositoryAccessPolicy(home, 'repo-test');

    expect(policy.mode).toBe('full_access');
    expect(policy.updatedBy).toBe('system');
    expect(repositoryAccessPolicyPath(home, 'repo-test')).toEndWith(
      join('repositories', 'repo-test', 'controller', 'access-policy.json'),
    );
  });

  test('persists full access under controllerHome repository storage', () => {
    const home = controllerHome();
    const written = writeRepositoryAccessPolicy(home, 'repo-test', 'full_access');
    const loaded = readRepositoryAccessPolicy(home, 'repo-test');

    expect(written.mode).toBe('full_access');
    expect(written.updatedBy).toBe('user');
    expect(loaded).toEqual(written);
  });

  test('falls back to host-managed execution for malformed policy files', () => {
    const home = controllerHome();
    writeRepositoryAccessPolicy(home, 'repo-test', 'full_access');
    const path = repositoryAccessPolicyPath(home, 'repo-test');
    writeFileSync(path, '{invalid-json', 'utf-8');

    expect(readRepositoryAccessPolicy(home, 'repo-test').mode).toBe('full_access');
  });
});

describe('access decision matrix', () => {
  test('legacy request mode allows normal host-authorized effects', () => {
    expect(evaluateAccessMode('request', 'read')).toBe('allow');
    expect(evaluateAccessMode('request', 'local_repo_write')).toBe('allow');
    expect(evaluateAccessMode('request', 'local_command')).toBe('allow');
    expect(evaluateAccessMode('request', 'local_git')).toBe('allow');
  });

  test('host-managed execution allows ordinary work and keeps hard boundaries', () => {
    expect(evaluateAccessMode('full_access', 'local_repo_write')).toBe('allow');
    expect(evaluateAccessMode('full_access', 'workspace_write')).toBe('allow');
    expect(evaluateAccessMode('full_access', 'local_command')).toBe('allow');
    expect(evaluateAccessMode('full_access', 'dependency_change')).toBe('allow');
    expect(evaluateAccessMode('full_access', 'local_git')).toBe('allow');
    expect(evaluateAccessMode('full_access', 'external_network')).toBe('allow');
    expect(evaluateAccessMode('full_access', 'remote_write')).toBe('allow');
    expect(evaluateAccessMode('full_access', 'destructive')).toBe('request');
    expect(evaluateAccessMode('full_access', 'outside_repository')).toBe('request');
    expect(evaluateAccessMode('full_access', 'secret_access')).toBe('deny');
  });

  test('descriptors explain the remaining hard boundaries', () => {
    const full = accessModeDescriptor('full_access');
    expect(full.shortLabel).toBe('Host managed');
    expect(full.automaticallyAllowed.join(' ')).toContain('Ordinary host commands');
    expect(full.stillRequiresApproval.join(' ')).toContain('Protected credential use');
    expect(full.alwaysDenied.join(' ')).toContain('secrets');
  });
});

describe('policy gate access mode integration', () => {
  test('full access removes repeated approval for local writes', () => {
    expect(evaluatePolicyGate({ risk: 'workspace_write', accessMode: 'full_access' }).decision).toBe('allowed');
    expect(evaluatePolicyGate({ risk: 'local_repo_write', accessMode: 'full_access' }).decision).toBe('allowed');
  });

  test('legacy request mode no longer adds approval for normal repository work', () => {
    expect(evaluatePolicyGate({ risk: 'workspace_write', accessMode: 'request' }).decision).toBe('allowed');
    expect(evaluatePolicyGate({ risk: 'local_repo_write', accessMode: 'request' }).decision).toBe('allowed');
  });

  test('ordinary remote writes proceed while destructive and secret gates remain', () => {
    expect(evaluatePolicyGate({ risk: 'remote_write', accessMode: 'full_access' }).decision).toBe('allowed');
    expect(evaluatePolicyGate({ risk: 'destructive', accessMode: 'full_access' }).decision).toBe('approval_required');
    expect(evaluatePolicyGate({ risk: 'raw_secret_config', accessMode: 'full_access' }).decision).toBe('denied');
  });
});
