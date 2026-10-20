import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  findActivePluginCapabilityAuthorization,
  findActivePluginCapabilityAuthorizationById,
  migrateControllerPluginCapabilityAuthorizations,
  recordPluginCapabilityAuthorization,
} from '../../src/runtime/plugins/capability-authorization-grants';
import { readPluginActionReceiptForRequest } from '../../src/runtime/plugins/store';

const roots: string[] = [];
afterEach(() => { for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }); });
function controllerHome(): string {
  const root = mkdtempSync(join(tmpdir(), 'forge-controller-global-migrate-'));
  roots.push(root);
  return root;
}
const target = { kind: 'mailbox', id: 'owner@example.test', identityFingerprint: 'mailbox-verified' };
function grant(home: string, repoId: string, capabilityId = 'gmail.send') {
  return recordPluginCapabilityAuthorization(home, {
    ownerScope: 'mcp:owner',
    repoId,
    pluginId: 'gmail',
    capabilityId,
    target,
    scopes: ['gmail.send'],
    riskCeiling: 'remote_write',
    expiresInMinutes: 60,
  });
}
function query(home: string) {
  return findActivePluginCapabilityAuthorization(home, {
    ownerScope: 'mcp:owner', repoId: 'controller:global',
    pluginId: 'gmail', capabilityId: 'gmail.send',
    target, scopes: ['gmail.send'], risk: 'remote_write',
  });
}

describe('Controller-global existing Grant migration', () => {
  test('preserves the exact grant ID, target, risk and original expiry; repeated migration is a no-op', () => {
    const home = controllerHome();
    const existing = grant(home, 'repo-legacy');
    expect(migrateControllerPluginCapabilityAuthorizations(home, ['gmail'])).toEqual(['gmail']);
    const migrated = query(home);
    expect(migrated).toMatchObject({
      grantId: existing.grantId,
      repoId: 'controller:global',
      target,
      scopes: existing.scopes,
      riskCeiling: existing.riskCeiling,
      createdAt: existing.createdAt,
      expiresAt: existing.expiresAt,
    });
    expect(findActivePluginCapabilityAuthorizationById(home, existing.grantId)?.repoId).toBe('controller:global');
    expect(migrateControllerPluginCapabilityAuthorizations(home, ['gmail'])).toEqual([]);
    expect(query(home)?.expiresAt).toBe(existing.expiresAt);
  });

  test('does not choose between two live repo grants for the same exact target', () => {
    const home = controllerHome();
    const a = grant(home, 'repo-a');
    const b = grant(home, 'repo-b');
    expect(migrateControllerPluginCapabilityAuthorizations(home, ['gmail'])).toEqual([]);
    expect(query(home)).toBeUndefined();
    expect(findActivePluginCapabilityAuthorizationById(home, a.grantId)?.repoId).toBe('repo-a');
    expect(findActivePluginCapabilityAuthorizationById(home, b.grantId)?.repoId).toBe('repo-b');
  });

  test('does not duplicate an existing global authorization for the same exact target', () => {
    const home = controllerHome();
    const global = grant(home, 'controller:global');
    const legacy = grant(home, 'repo-old');
    expect(migrateControllerPluginCapabilityAuthorizations(home, ['gmail'])).toEqual([]);
    expect(query(home)?.grantId).toBe(global.grantId);
    expect(findActivePluginCapabilityAuthorizationById(home, legacy.grantId)?.repoId).toBe('repo-old');
  });

  test('does not migrate unrelated repository-owned provider grants', () => {
    const home = controllerHome();
    const old = grant(home, 'repo-legacy', 'github.write');
    expect(migrateControllerPluginCapabilityAuthorizations(home, ['resend'])).toEqual([]);
    expect(findActivePluginCapabilityAuthorizationById(home, old.grantId)?.repoId).toBe('repo-legacy');
  });
});

describe('Controller-global historical receipt migration', () => {
  test('moves a completed Work-bound Gmail effect once without provider execution or lost attribution', () => {
    const home = controllerHome();
    const requestId = 'legacy-gmail-send-one';
    const receiptId = 'PLG-legacy-mail-one';
    const oldScope = 'repo-old';
    const receiptRoot = join(home, 'repositories', oldScope, 'plugin-action-receipts');
    const indexRoot = join(home, 'indexes', 'plugin-actions', 'requests');
    mkdirSync(receiptRoot, { recursive: true });
    mkdirSync(indexRoot, { recursive: true });
    const oldSemantic = `plugin-action:${oldScope}:gmail:send:12345`;
    const oldReceipt = {
      schemaVersion: 1, receiptId, requestId, scopeKey: oldScope, repoId: oldScope,
      pluginId: 'gmail', actionId: 'send', semanticKey: oldSemantic,
      status: 'succeeded', createdAt: new Date().toISOString(), workId: 'work-mail-legacy',
      result: { providerId: 'sent-once' },
    };
    const source = join(receiptRoot, `${receiptId}.json`);
    const requestPath = join(indexRoot, `${createHash('sha256').update(requestId).digest('hex')}.json`);
    writeFileSync(source, JSON.stringify(oldReceipt));
    writeFileSync(requestPath, JSON.stringify({
      requestId, scopeKey: oldScope, repoId: oldScope, receiptId,
      semanticKey: oldSemantic, createdAt: oldReceipt.createdAt,
    }));

    const migrated = readPluginActionReceiptForRequest(home, requestId);
    expect(migrated).toMatchObject({
      receiptId, requestId, scopeKey: 'forge-instance',
      workRepoId: oldScope, workId: 'work-mail-legacy',
      semanticKey: 'plugin-action:forge-instance:gmail:send:12345',
      result: { providerId: 'sent-once' },
    });
    expect(existsSync(source)).toBe(false);
    expect(existsSync(join(home, 'system', 'plugin-action-receipts', `${receiptId}.json`))).toBe(true);
    const index = JSON.parse(readFileSync(requestPath, 'utf8'));
    expect(index).toMatchObject({ scopeKey: 'forge-instance', workRepoId: oldScope });
    expect(readPluginActionReceiptForRequest(home, requestId)).toEqual(migrated);
  });
});
