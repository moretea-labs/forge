import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { buildContextClosureReceipt, validateRuntimeIssuedContextClosureReceipt } from '../../src/runtime/context/context-closure';
import { validateProjectEngineeringContract } from '../../packages/kernel/work/domain/project-engineering-contract';

const roots: string[] = [];
function temp(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });

function pack(sourceRevision: string, files: string[], tests: string[] = []) {
  return {
    schemaVersion: 11,
    generatedAt: '2026-09-03T00:00:00.000Z',
    git: { branch: 'kernel-v2/architecture', dirty: false },
    instructionContext: { status: 'ready' as const, contracts: [{ path: 'AGENTS.md' }] },
    structuralContext: { status: 'ready' as const },
    readiness: { sourceRevision, rawSource: { status: 'current' as const }, status: 'ready' as const, unresolvedReasonCodes: [] },
    files: files.map((path) => ({ path })),
    coverage: { relevantTests: tests, inspectedFiles: files },
  };
}

function skill(root: string, id: string) {
  const folder = join(root, '.agents', 'skills', id);
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, 'SKILL.md'), `---\nname: ${id}\n---\n\nInstructions`);
}

function projectContract(root: string, input: {
  projectId: string;
  platforms?: string[];
  skillRefs?: string[];
  skillBindings?: Array<{ id: string; version?: string; kinds: string[] }>;
  tooling?: Array<{ id: string; purpose?: string }>;
}) {
  mkdirSync(join(root, '.forge'), { recursive: true });
  writeFileSync(join(root, '.forge/project-engineering.json'), JSON.stringify({
    schemaVersion: 1,
    contractId: `${input.projectId}-engineering`,
    contractVersion: '1',
    projectId: input.projectId,
    authority: {}, quality: {}, checks: [], journeys: [],
    platforms: input.platforms ?? [],
    skillRefs: input.skillRefs ?? [],
    skillBindings: input.skillBindings ?? [],
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
    skill(root, 'typescript-engineering');
    const receipt = buildContextClosureReceipt({
      repoRoot: root,
      skillHomeDir: join(root, 'no-user-skills'),
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
    skill(root, 'ios-engineering');
    projectContract(root, {
      projectId: 'ios-app',
      platforms: ['ios'],
      skillBindings: [{ id: 'ios-engineering', version: '1', kinds: ['swift', 'ios'] }],
      tooling: [{ id: 'sourcekit-lsp' }],
    });
    const receipt = buildContextClosureReceipt({
      repoRoot: root,
      skillHomeDir: join(root, 'no-user-skills'),
      query: 'Change cross-file ownership safely',
      pack: pack('rev-ios', ['Sources/App.swift']),
      semanticProviders: [{ id: 'sourcekit-lsp', languages: ['swift'] }],
      semanticNavigation: { requested: 0, results: [], errors: [], freshness: 'current' },
    });
    expect(receipt.detected).toMatchObject({ languages: ['swift'] });
    expect(receipt.detected.platforms).toContain('ios');
    expect(receipt.skills.status).toBe('ready');
    expect(receipt.skills.unresolvedKinds).toEqual([]);
    expect(receipt.skills.resolved).toEqual([
      expect.objectContaining({ id: 'ios-engineering', version: '1', matchedKinds: ['ios', 'swift'] }),
    ]);
    expect(receipt.semanticTools).toMatchObject({ required: true, status: 'degraded', compilerEvidenceRequired: true });
    expect(receipt.semanticTools.reasonCodes).toContain('semantic.navigation_not_requested');
    expect(receipt.readiness.status).toBe('degraded');
  });

  test('accepts the runtime-emitted semantic provider field as compiler evidence', () => {
    const root = temp('context-closure-ios-evidence-');
    mkdirSync(join(root, 'Example.xcodeproj'));
    mkdirSync(join(root, 'Sources'));
    writeFileSync(join(root, 'Sources/App.swift'), 'struct App {}');
    skill(root, 'ios-engineering');
    projectContract(root, {
      projectId: 'ios-evidence-app',
      platforms: ['ios'],
      skillBindings: [{ id: 'ios-engineering', version: '1', kinds: ['swift', 'ios'] }],
      tooling: [{ id: 'sourcekit-lsp' }],
    });
    const receipt = buildContextClosureReceipt({
      repoRoot: root,
      skillHomeDir: join(root, 'no-user-skills'),
      query: 'Change cross-file ownership safely',
      pack: pack('rev-ios-evidence', ['Sources/App.swift']),
      semanticProviders: [{ id: 'sourcekit-lsp', languages: ['swift'] }],
      semanticNavigation: {
        requested: 1,
        results: [{ provider: 'sourcekit-lsp' }],
        errors: [],
        freshness: 'current',
      },
    });
    expect(receipt.semanticTools).toMatchObject({
      required: true,
      status: 'ready',
      compilerEvidenceRequired: false,
      providers: [expect.objectContaining({ providerId: 'sourcekit-lsp', status: 'ready', evidenceCount: 1 })],
    });
    expect(receipt.semanticTools.reasonCodes).not.toContain('semantic.swift_unproven');
    expect(receipt.readiness.status).toBe('ready');
  });

  test('validates explicit project skill bindings as unambiguous kind authority', () => {
    const base = {
      schemaVersion: 1,
      contractId: 'skill-binding-contract',
      contractVersion: '1',
      projectId: 'skill-binding-project',
      authority: {}, quality: {}, checks: [], journeys: [],
    };
    expect(() => validateProjectEngineeringContract({
      ...base,
      skillBindings: [{ id: 'ios-engineering', kinds: [] }],
    })).toThrow('PROJECT_ENGINEERING_CONTRACT_SKILL_KINDS_INVALID');
    expect(() => validateProjectEngineeringContract({
      ...base,
      skillBindings: [
        { id: 'ios-engineering', kinds: ['swift'] },
        { id: 'ios-engineering', kinds: ['ios'] },
      ],
    })).toThrow('PROJECT_ENGINEERING_CONTRACT_SKILL_BINDING_ID_DUPLICATE');
    expect(validateProjectEngineeringContract({
      ...base,
      skillBindings: [{ id: 'ios-engineering', kinds: ['Swift', 'IOS'] }],
    }).skillBindings).toEqual([{ id: 'ios-engineering', kinds: ['swift', 'ios'] }]);
  });

  test('discovers a symlinked installed ios-engineering without a project contract', () => {
    const root = temp('context-closure-user-skill-');
    const home = join(root, 'home');
    mkdirSync(join(root, 'Sources'));
    writeFileSync(join(root, 'Sources', 'App.swift'), 'struct App {}');
    const folder = join(home, '.agents', 'skills', 'ios-engineering');
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, 'SKILL.md'), '---\\nname: ios-engineering\\n---');
    mkdirSync(join(home, '.codex', 'skills'), { recursive: true });
    symlinkSync(folder, join(home, '.codex', 'skills', 'ios-engineering'));
    const receipt = buildContextClosureReceipt({
      repoRoot: root,
      skillHomeDir: home,
      query: 'Implement a SwiftUI view',
      pack: pack('rev-installed', ['Sources/App.swift']),
      semanticNavigation: { requested: 0, results: [], errors: [] },
      semanticProviders: [],
    });
    expect(receipt.projectContractStatus).toBe('missing');
    expect(receipt.skills.status).toBe('ready');
    expect(receipt.skills.resolved).toEqual([
      expect.objectContaining({ id: 'ios-engineering', source: 'user_skill', matchedKinds: ['swift'] }),
    ]);
    expect(receipt.readiness.reasonCodes).toContain('project_contract.missing');
    expect(receipt.readiness.reasonCodes).not.toContain('skill.swift_unresolved');
  });

  test('uninstalled project skill bindings cannot claim available skills', () => {
    const root = temp('context-closure-phantom-skill-');
    projectContract(root, { projectId: 'ios-app', skillBindings: [{ id: 'ios-engineering', kinds: ['swift', 'ios'] }], platforms: ['ios'] });
    const receipt = buildContextClosureReceipt({
      repoRoot: root,
      skillHomeDir: join(root, 'no-user-skills'),
      query: 'SwiftUI change',
      pack: pack('rev-phantom', ['Sources/App.swift']),
      semanticNavigation: { requested: 0, results: [], errors: [] },
      semanticProviders: [],
    });
    expect(receipt.skills.status).toBe('unavailable');
    expect(receipt.skills.unresolvedKinds).toEqual(['ios', 'swift']);
    expect(receipt.readiness.reasonCodes).toContain('skill.swift_unresolved');
  });

  test('keeps missing project/skill facts explicit instead of inventing defaults', () => {
    const root = temp('context-closure-missing-');
    writeFileSync(join(root, 'package.json'), '{}');
    const receipt = buildContextClosureReceipt({
      repoRoot: root,
      skillHomeDir: join(root, 'no-user-skills'),
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

  test('accepts semantically identical issued content regardless of object property order but rejects content tampering', () => {
    const root = temp('context-closure-issued-');
    projectContract(root, { projectId: 'issued', skillRefs: ['typescript-engineering'] });
    skill(root, 'typescript-engineering');
    const issued = buildContextClosureReceipt({
      repoRoot: root,
      skillHomeDir: join(root, 'no-user-skills'),
      query: 'typescript service implementation',
      pack: pack('revision-issued', ['src/service.ts'], ['tests/service.test.ts']),
      semanticNavigation: { requested: 0, results: [], errors: [] },
      semanticProviders: [{ id: 'typescript-language-service', languages: ['typescript'] }],
      activeWorkIds: ['work-a', 'work-b'],
    });
    expect(validateRuntimeIssuedContextClosureReceipt(issued).receiptId).toBe(issued.receiptId);

    const reverseObjectKeyOrder = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(reverseObjectKeyOrder);
      if (!value || typeof value !== 'object') return value;
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
          .reverse()
          .map(([key, entry]) => [key, reverseObjectKeyOrder(entry)]),
      );
    };
    const reordered = reverseObjectKeyOrder(issued) as typeof issued;
    expect(validateRuntimeIssuedContextClosureReceipt(reordered).receiptId).toBe(issued.receiptId);

    const tampered = { ...issued, generatedAt: '2026-09-03T00:00:01.000Z' };
    expect(() => validateRuntimeIssuedContextClosureReceipt(tampered)).toThrow('CONTEXT_CLOSURE_RECEIPT_NOT_ISSUED_BY_RUNTIME');

    const reorderedArray = {
      ...issued,
      repository: { ...issued.repository, activeWorkIds: [...issued.repository.activeWorkIds].reverse() },
    };
    expect(() => validateRuntimeIssuedContextClosureReceipt(reorderedArray)).toThrow('CONTEXT_CLOSURE_RECEIPT_NOT_ISSUED_BY_RUNTIME');
  });

});
