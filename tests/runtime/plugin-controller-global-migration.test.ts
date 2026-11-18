import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'crypto';
import { spawnSync } from 'child_process';
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
    const phones = ['ios-physical-device', 'action:physical_device_open'].map((capabilityId) =>
      recordPluginCapabilityAuthorization(home, {
        ownerScope: 'mcp:owner', repoId: 'repo-phone', pluginId: 'computer', capabilityId,
        target, scopes: ['ios.device'], riskCeiling: 'workspace_write', expiresInMinutes: 60,
      }));
    const browser = recordPluginCapabilityAuthorization(home, {
      ownerScope: 'mcp:owner', repoId: 'repo-browser', pluginId: 'computer', capabilityId: 'browser-interaction',
      target, scopes: ['browser'], riskCeiling: 'workspace_write', expiresInMinutes: 60,
    });
    expect(migrateControllerPluginCapabilityAuthorizations(home, ['computer'])).toEqual(['computer']);
    for (const phone of phones) expect(findActivePluginCapabilityAuthorizationById(home, phone.grantId)?.repoId).toBe('repo-phone');
    expect(findActivePluginCapabilityAuthorizationById(home, browser.grantId)?.repoId).toBe('controller:global');
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

    const phoneId = 'phone-repository-write';
    const phoneReceiptId = 'PLG-phone-write';
    const phoneSemantic = `plugin-action:${oldScope}:computer:physical_device_open:12345`;
    const phoneReceipt = { ...oldReceipt, receiptId: phoneReceiptId, requestId: phoneId,
      pluginId: 'computer', actionId: 'physical_device_open', semanticKey: phoneSemantic,
      status: 'failed', effectOutcome: 'outcome_unknown' };
    const phoneSource = join(receiptRoot, `${phoneReceiptId}.json`);
    const phoneIndex = join(indexRoot, `${createHash('sha256').update(phoneId).digest('hex')}.json`);
    writeFileSync(phoneSource, JSON.stringify(phoneReceipt));
    writeFileSync(phoneIndex, JSON.stringify({ requestId: phoneId, scopeKey: oldScope, repoId: oldScope,
      receiptId: phoneReceiptId, semanticKey: phoneSemantic, createdAt: oldReceipt.createdAt }));
    const beforeReceipt = readFileSync(phoneSource, 'utf8');
    const beforeIndex = readFileSync(phoneIndex, 'utf8');
    const migrated = readPluginActionReceiptForRequest(home, requestId);
    expect(readFileSync(phoneSource, 'utf8')).toBe(beforeReceipt);
    expect(readFileSync(phoneIndex, 'utf8')).toBe(beforeIndex);
    const phoneContext = { repoId: oldScope, pluginId: 'computer', actionId: 'physical_device_open' };
    expect(readPluginActionReceiptForRequest(home, phoneId, phoneContext)).toMatchObject(phoneReceipt);
    writeFileSync(phoneSource, JSON.stringify({ ...phoneReceipt, receiptId: 'PLG-corrupt-identity' }));
    expect(() => readPluginActionReceiptForRequest(home, phoneId, phoneContext)).toThrow('PLUGIN_RECEIPT_LOST');
    writeFileSync(phoneSource, beforeReceipt);
    expect(() => readPluginActionReceiptForRequest(home, phoneId, { ...phoneContext, repoId: 'other-repo' }))
      .toThrow('REQUEST_ID_SCOPE_CONFLICT');
    expect(() => readPluginActionReceiptForRequest(home, phoneId, { ...phoneContext, actionId: 'physical_device_tap' }))
      .toThrow('REQUEST_ID_SCOPE_CONFLICT');
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

    const markerPath = join(home, 'system', 'plugin-action-receipts-migration.json');
    const markerBefore = readFileSync(markerPath, 'utf8');
    const marker = JSON.parse(markerBefore);
    expect(marker).toMatchObject({ schemaVersion: 1, fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/) });

    // A new module instance models a Runtime restart: the process-local migration
    // cache is empty, so only the durable marker can avoid the historical scan.
    const lateRequestId = 'legacy-gmail-send-after-marker';
    const lateReceiptId = 'PLG-legacy-mail-after-marker';
    const lateSemantic = `plugin-action:${oldScope}:gmail:send:12346`;
    const lateReceipt = { ...oldReceipt, receiptId: lateReceiptId, requestId: lateRequestId,
      semanticKey: lateSemantic, createdAt: new Date().toISOString(), result: { providerId: 'sent-after-marker' } };
    const lateSource = join(receiptRoot, `${lateReceiptId}.json`);
    const lateIndex = join(indexRoot, `${createHash('sha256').update(lateRequestId).digest('hex')}.json`);
    writeFileSync(lateSource, JSON.stringify(lateReceipt));
    writeFileSync(lateIndex, JSON.stringify({
      requestId: lateRequestId, scopeKey: oldScope, repoId: oldScope,
      receiptId: lateReceiptId, semanticKey: lateSemantic, createdAt: lateReceipt.createdAt,
    }));

    const coldRead = (id: string, refresh = false) => {
      const child = spawnSync(process.execPath, ['-e', `
        import { readPluginActionReceiptForRequest, syncControllerPluginManifest } from ${JSON.stringify(new URL('../../src/runtime/plugins/store.ts', import.meta.url).href)};
        const receipt = readPluginActionReceiptForRequest(${JSON.stringify(home)}, ${JSON.stringify(id)});
        if (${refresh}) syncControllerPluginManifest(${JSON.stringify(home)}, 'gmail');
        console.log(JSON.stringify(receipt));
      `], { encoding: 'utf8', timeout: 10_000 });
      expect(child.status, child.stderr).toBe(0);
      return JSON.parse(child.stdout.trim());
    };
    expect(coldRead(requestId)).toEqual(migrated);
    expect(existsSync(lateSource)).toBe(true);
    expect(existsSync(join(home, 'system', 'plugin-action-receipts', `${lateReceiptId}.json`))).toBe(false);
    expect(coldRead(requestId, true)).toEqual(migrated);
    expect(existsSync(lateSource)).toBe(true);
    expect(readFileSync(markerPath, 'utf8')).toBe(markerBefore);

    // An invalid marker fails open to the idempotent migration, rather than
    // treating a corrupt completion receipt as authority to skip old data.
    writeFileSync(markerPath, JSON.stringify({ schemaVersion: 99 }));
    expect(coldRead(lateRequestId)).toMatchObject({
      receiptId: lateReceiptId,
      requestId: lateRequestId,
      scopeKey: 'forge-instance',
      workRepoId: oldScope,
      result: { providerId: 'sent-after-marker' },
    });
    expect(existsSync(lateSource)).toBe(false);
    expect(JSON.parse(readFileSync(markerPath, 'utf8'))).toMatchObject({
      schemaVersion: 1,
      fingerprint: marker.fingerprint,
    });
  });
});
