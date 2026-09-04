import { describe, expect, test } from 'bun:test';
import { workValidationCheckSemanticIdentity, workValidationProcessCheckExecutionIsCurrent } from '../../src/runtime/control-plane/execution/work-operation-service';
import { controllerCheckExecutionIdentity } from '../../src/cli/controller/check-runner';
import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

describe('work_validate semantic identity', () => {
  test('binds Process request identity and VerificationRecord identity to one canonical fingerprint', () => {
    const input = {
      sourceRevision: 'revision-a',
      workspaceFingerprint: 'workspace-a',
      checkId: 'package:check:type',
      requestedChecks: ['package:check:type', 'package:check:runtime-architecture'],
    };
    const first = workValidationCheckSemanticIdentity(input);
    const replay = workValidationCheckSemanticIdentity(input);

    expect(first).toEqual(replay);
    expect(first.requestSemanticFingerprint).toBe(first.verificationInputFingerprint);
    expect(first.requestSemanticFingerprint).toMatch(/^[a-f0-9]{64}$/);
  });

  test('uses content-bound Check execution identity rather than request provenance to validate a completed Process', () => {
    const root = mkdtempSync(join(tmpdir(), 'forge-work-validation-execution-'));
    try {
      mkdirSync(join(root, '.forge'), { recursive: true });
      writeFileSync(join(root, '.forge', 'checks.json'), JSON.stringify({
        version: 1,
        checks: { typecheck: { command: [process.execPath, '-e', 'process.exit(0)'], timeoutMs: 10_000 } },
      }));
      execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
      execFileSync('git', ['config', 'user.email', 'test@example.test'], { cwd: root });
      execFileSync('git', ['config', 'user.name', 'Test'], { cwd: root });
      execFileSync('git', ['add', '.'], { cwd: root });
      execFileSync('git', ['commit', '-qm', 'fixture'], { cwd: root });
      const identity = controllerCheckExecutionIdentity(root, 'typecheck');
      expect(workValidationProcessCheckExecutionIsCurrent(root, 'typecheck', identity)).toBe(true);
      expect(workValidationProcessCheckExecutionIsCurrent(root, 'typecheck', { ...identity, revision: `${identity.revision}-stale` })).toBe(false);
      expect(workValidationProcessCheckExecutionIsCurrent(root, 'typecheck', { ...identity, definitionDigest: `${identity.definitionDigest}-stale` })).toBe(false);
      expect(workValidationProcessCheckExecutionIsCurrent(root, 'typecheck', { ...identity, environmentFingerprint: `${identity.environmentFingerprint}-stale` })).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('changes request provenance fingerprint when any verification request identity input changes', () => {
    const base = workValidationCheckSemanticIdentity({
      sourceRevision: 'revision-a',
      workspaceFingerprint: 'workspace-a',
      checkId: 'package:check:type',
      requestedChecks: ['package:check:type'],
    }).requestSemanticFingerprint;

    const variants = [
      { sourceRevision: 'revision-b', workspaceFingerprint: 'workspace-a', checkId: 'package:check:type', requestedChecks: ['package:check:type'] },
      { sourceRevision: 'revision-a', workspaceFingerprint: 'workspace-b', checkId: 'package:check:type', requestedChecks: ['package:check:type'] },
      { sourceRevision: 'revision-a', workspaceFingerprint: 'workspace-a', checkId: 'package:check:runtime-architecture', requestedChecks: ['package:check:type'] },
      { sourceRevision: 'revision-a', workspaceFingerprint: 'workspace-a', checkId: 'package:check:type', requestedChecks: ['package:check:type', 'package:check:runtime-architecture'] },
    ];

    for (const variant of variants) {
      expect(workValidationCheckSemanticIdentity(variant).requestSemanticFingerprint).not.toBe(base);
    }
  });
});
