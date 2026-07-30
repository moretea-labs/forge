import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ensureControllerHome, repositoryControllerRoot } from '../../src/cli/repositories/controller-home';
import {
  readControllerResult,
  sanitizeControllerResultStore,
  searchControllerResult,
  writeControllerResult,
} from '../../src/runtime/evidence/result-store';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const controllerHome = mkdtempSync(join(tmpdir(), 'repo-harness-result-redaction-'));
  roots.push(controllerHome);
  ensureControllerHome(controllerHome);
  const repoId = 'repo-result-redaction';
  const sessionId = 'session-result-redaction';
  const principalId = 'principal-result-redaction';
  const root = join(repositoryControllerRoot(controllerHome, repoId), 'results');
  return { controllerHome, repoId, sessionId, principalId, root };
}

function dataPath(root: string, resultId: string): string {
  return join(root, 'data', `${resultId}.json`);
}

describe('controller result redaction', () => {
  test('redacts nested synthetic credentials before resultRef persistence and read', () => {
    const fx = fixture();
    const syntheticKey = 'sk-SYNTHETICRESULT0123456789ABCDEF';
    const syntheticPassword = 'synthetic-result-password-0123456789';
    const record = writeControllerResult({
      controllerHome: fx.controllerHome,
      repoId: fx.repoId,
      sessionId: fx.sessionId,
      principalId: fx.principalId,
      kind: 'command',
      value: {
        SAFE_MODE: 'enabled',
        API_KEY: syntheticKey,
        nested: {
          output: `SYNTHETIC_ACCESS_TOKEN => ${syntheticKey}\nSAFE_MARKER => retained`,
          endpoint: `https://user:${syntheticPassword}@example.test/path`,
          terminalFenceToken: 42,
          continuationToken: 'continue-page-123',
          authorization: { decision: 'allow', source: 'policy', reason: 'safe local read' },
        },
      },
    });
    const path = dataPath(fx.root, record.resultId);
    const persisted = readFileSync(path, 'utf8');
    expect(persisted).not.toContain(syntheticKey);
    expect(persisted).not.toContain(syntheticPassword);
    expect(persisted).toContain('SAFE_MARKER');
    expect(record.redaction?.redactionCount).toBeGreaterThan(0);
    if (process.platform !== 'win32') expect(statSync(path).mode & 0o777).toBe(0o600);

    const read = readControllerResult({
      controllerHome: fx.controllerHome,
      resultRef: record.resultRef,
      sessionId: fx.sessionId,
      principalId: fx.principalId,
    });
    expect(JSON.stringify(read.items)).not.toContain(syntheticKey);
    expect(JSON.stringify(read.items)).not.toContain(syntheticPassword);
    expect(JSON.stringify(read.items)).toContain('SAFE_MARKER');
    expect(JSON.stringify(read.items)).toContain('continue-page-123');
    expect(JSON.stringify(read.items)).toContain('safe local read');
    expect(sanitizeControllerResultStore(fx.controllerHome, fx.repoId)).toMatchObject({
      scanned: 1,
      changed: 0,
      failed: 0,
    });
  });

  test('replaces historical raw result data without returning its contents', () => {
    const fx = fixture();
    const historicalSecret = 'synthetic-historical-result-secret-0123456789';
    const record = writeControllerResult({
      controllerHome: fx.controllerHome,
      repoId: fx.repoId,
      sessionId: fx.sessionId,
      principalId: fx.principalId,
      kind: 'generic',
      value: { items: ['SAFE_INITIAL'] },
    });
    const path = dataPath(fx.root, record.resultId);
    writeFileSync(path, JSON.stringify({
      items: [
        `LEGACY_REFRESH_TOKEN => ${historicalSecret}`,
        'SAFE_MARKER => retained',
      ],
    }, null, 2));

    const report = sanitizeControllerResultStore(fx.controllerHome, fx.repoId);
    expect(report).toMatchObject({ scanned: 1, changed: 1, failed: 0 });
    expect(JSON.stringify(report)).not.toContain(historicalSecret);
    expect(readFileSync(path, 'utf8')).not.toContain(historicalSecret);
    expect(sanitizeControllerResultStore(fx.controllerHome, fx.repoId)).toMatchObject({ scanned: 1, changed: 0, failed: 0 });

    // Reintroduce a synthetic legacy value to prove lazy read/search migration.
    writeFileSync(path, JSON.stringify({ items: [`LEGACY_ACCESS_TOKEN => ${historicalSecret}`, 'SAFE_SEARCH_MARKER'] }));
    const read = readControllerResult({
      controllerHome: fx.controllerHome,
      resultRef: record.resultRef,
      sessionId: fx.sessionId,
      principalId: fx.principalId,
    });
    expect(JSON.stringify(read.items)).not.toContain(historicalSecret);
    expect(readFileSync(path, 'utf8')).not.toContain(historicalSecret);
    const search = searchControllerResult({
      controllerHome: fx.controllerHome,
      resultRef: record.resultRef,
      sessionId: fx.sessionId,
      principalId: fx.principalId,
      query: 'safe_search_marker',
    });
    expect(search.matches).toHaveLength(1);
    expect(JSON.stringify(search)).not.toContain(historicalSecret);
  });
});
