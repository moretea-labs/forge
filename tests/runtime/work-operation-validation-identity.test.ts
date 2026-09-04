import { describe, expect, test } from 'bun:test';
import { workValidationCheckSemanticIdentity } from '../../src/runtime/control-plane/execution/work-operation-service';

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

  test('invalidates stale or mismatched Process bindings when any verification identity input changes', () => {
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
