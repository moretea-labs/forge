import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { buildContextClosureReceipt } from '../../src/runtime/context/context-closure';

const roots: string[] = [];
function temp(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });

function pack(sourceRevision: string, files: string[], tests: string[] = []) {
  return {
    schemaVersion: 10,
    generatedAt: '2026-09-03T00:00:00.000Z',
    git: { branch: 'kernel-v2/architecture', dirty: false },
    instructionContext: { status: 'ready' as const, contracts: [{ path: 'AGENTS.md' }] },
    structuralContext: { status: 'ready' as const },
    readiness: { sourceRevision, rawSource: { status: 'current' as const }, status: 'ready' as const, unresolvedReasonCodes: [] },
    files: files.map((path) => ({ path })),
    coverage: { relevantTests: tests, inspectedFiles: files },
  };
}

function projectContract(root: string, input: { projectId: string; platforms?: string[]; skillRefs: string[]; tooling?: Array<{ id: string; purpose?: string }> }) {
  mkdirSync(join(root, '.forge'), { recursive: true });
  writeFileSync(join(root, '.forge/project-engineering.json'), JSON.stringify({
    schemaVersion: 1,
    contractId: `${input.projectId}-engineering`,
    contractVersion: '1',
    projectId: input.projectId,
    authority: {}, quality: {}, checks: [], journeys: [],
    platforms: input.platforms ?? [],
    skillRefs: input.skillRefs,
    tooling: input.tooling ?? [],
  }));
}

describe('Context Closure', () => {
  test('automatically resolves TypeScript skill and semantic provider from source facts', () => {
    const root = temp('context-closure-ts-');
    writeFileSync(join(root, 'package.json'), '{}');
    writeFileSync(join(root, 'tsconfig.json'), '{}');
    mkdirSync(join(root, 'src')); mkdirSync(join(root, 'tests'));
    writeFileSync(join(root, 'src/service.ts'), 'export const value = 1;');
    writeFileSync(join(root, 'tests/service.test.ts'), '');
    projectContract(root, { projectId: 'ts-app', skillRefs: ['typescript-engineering@2'] });
    const receipt = buildContextClosureReceipt({
      repoRoot: root,
      query: 'Change the cross-file protocol ownership contract',
      pack: pack('rev-ts', ['src/service.ts'], ['tests/service.test.ts']),
      semanticProviders: [{ id: 'typescript-language-service', languages: ['typescript'] }],
      semanticNavigation: { requested: 1, results: [{ result: { providerId: 'typescript-language-service' } }], errors: [], freshness: 'current' },
      workId: 'work-ts', activeWorkIds: ['work-ts'],
    });
    expect(receipt.detected.languages).toContain('typescript');
    expect(receipt.skills).toMatchObject({ status: 'ready', unresolvedKinds: [] });
    expect(receipt.skills.resolved[0]).toMatchObject({ id: 'typescript-engineering', version: '2', matchedKinds: ['typescript'] });
    expect(receipt.semanticTools).toMatchObject({ required: true, status: 'ready', compilerEvidenceRequired: false });
    expect(receipt.projectContract).toMatchObject({ sourceRevision: 'rev-ts', projectId: 'ts-app' });
    expect(receipt.readiness.status).toBe('ready');
  });

  test('detects Swift/iOS without prompt instructions and degrades when SourceKit evidence is not executed', () => {
    const root = temp('context-closure-ios-');
    mkdirSync(join(root, 'Example.xcodeproj'));
    mkdirSync(join(root, 'Sources'));
    writeFileSync(join(root, 'Sources/App.swift'), 'struct App {}');
    projectContract(root, { projectId: 'ios-app', platforms: ['ios'], skillRefs: ['ios-engineering@1', 'swift-engineering@3'], tooling: [{ id: 'sourcekit-lsp' }] });
    const receipt = buildContextClosureReceipt({
      repoRoot: root,
      query: 'Change cross-file ownership safely',
      pack: pack('rev-ios', ['Sources/App.swift']),
      semanticProviders: [{ id: 'sourcekit-lsp', languages: ['swift'] }],
      semanticNavigation: { requested: 0, results: [], errors: [], freshness: 'current' },
    });
    expect(receipt.detected).toMatchObject({ languages: ['swift'] });
    expect(receipt.detected.platforms).toContain('ios');
    expect(receipt.skills.status).toBe('ready');
    expect(receipt.skills.resolved.map((skill) => skill.id).sort()).toEqual(['ios-engineering', 'swift-engineering']);
    expect(receipt.semanticTools).toMatchObject({ required: true, status: 'degraded', compilerEvidenceRequired: true });
    expect(receipt.semanticTools.reasonCodes).toContain('semantic.navigation_not_requested');
    expect(receipt.readiness.status).toBe('degraded');
  });

  test('keeps missing project/skill facts explicit instead of inventing defaults', () => {
    const root = temp('context-closure-missing-');
    writeFileSync(join(root, 'package.json'), '{}');
    const receipt = buildContextClosureReceipt({
      repoRoot: root,
      query: 'Inspect one local function',
      pack: pack('rev-missing', ['src/value.ts']),
      semanticProviders: [{ id: 'typescript-language-service', languages: ['typescript'] }],
      semanticNavigation: { requested: 0, results: [], errors: [], freshness: 'current' },
    });
    expect(receipt.projectContractStatus).toBe('missing');
    expect(receipt.skills).toMatchObject({ status: 'unavailable', unresolvedKinds: ['typescript'] });
    expect(receipt.readiness.reasonCodes).toContain('project_contract.missing');
    expect(receipt.readiness.status).toBe('degraded');
  });
});
