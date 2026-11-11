import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getMcpPolicy } from '../../adapters/mcp/policy';
import { buildRepositoryInstructionContext } from '../../src/cli/controller/context/instruction-context';
import { buildControllerContextPack } from '../../src/cli/controller/context-pack';

describe('repository UI instruction context', () => {
  test('includes existing design guidance declared by AGENTS without a separate registry', () => {
    const root = mkdtempSync(join(tmpdir(), 'forge-design-context-'));
    try {
      mkdirSync(join(root, 'docs', 'mvp2', 'design'), { recursive: true });
      mkdirSync(join(root, 'apps', 'ios', 'Features'), { recursive: true });
      writeFileSync(join(root, 'AGENTS.md'),
        '# Project rules\nFor UI work read `docs/mvp2/design/design-rules.md`.\n');
      writeFileSync(join(root, 'apps', 'ios', 'AGENTS.md'), '# iOS rules\n');
      writeFileSync(join(root, 'DESIGN.md'), '# Canonical visual style\nOrdinary cards have no shadows.\n');
      writeFileSync(join(root, 'docs', 'mvp2', 'design', 'design-rules.md'),
        '# Design rules\nNo decorative outlines.\n');
      writeFileSync(join(root, 'apps', 'ios', 'Features', 'MedicationView.swift'), 'struct MedicationView {}\n');
      const paths = ['apps/ios/Features/MedicationView.swift'];
      const policy = getMcpPolicy('controller', { repoRoot: root });

      const ui = buildRepositoryInstructionContext(root, policy, paths, { uiIntent: '优化用药界面' });
      expect(ui.status).toBe('ready');
      expect(ui.contracts.map(contract => contract.path)).toContain('AGENTS.md');
      expect(ui.contracts.map(contract => contract.path)).toContain('apps/ios/AGENTS.md');
      expect(ui.contracts.map(contract => contract.path)).toContain('DESIGN.md');
      expect(ui.contracts.map(contract => contract.path)).toContain('docs/mvp2/design/design-rules.md');
      expect(ui.contracts.find(contract => contract.path === 'DESIGN.md')?.content).toContain('no shadows');
      expect(ui.contracts.find(contract => contract.path === 'docs/mvp2/design/design-rules.md')?.content).toContain('No decorative outlines');

      const backend = buildRepositoryInstructionContext(root, policy, ['apps/api/Domain/Medicine.ts'], { uiIntent: 'fix transaction persistence' });
      expect(backend.contracts.map(contract => contract.path)).not.toContain('DESIGN.md');
      expect(backend.contracts.map(contract => contract.path)).not.toContain('docs/mvp2/design/design-rules.md');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('Requirement-only source retrieval includes relevant design guidance without a Work ID', () => {
    const root = mkdtempSync(join(tmpdir(), 'forge-requirement-design-context-'));
    try {
      mkdirSync(join(root, 'src'), { recursive: true });
      writeFileSync(join(root, 'AGENTS.md'), 'Before UI edits read `docs/design/design-rules.md`.\n');
      mkdirSync(join(root, 'docs', 'design'), { recursive: true });
      writeFileSync(join(root, 'docs', 'design', 'design-rules.md'), 'Flat cards and restrained color.\n');
      writeFileSync(join(root, 'DESIGN.md'), 'No ornamental shadows.\n');
      writeFileSync(join(root, 'src', 'MedicationView.swift'), 'struct MedicationView {}\n');
      expect(Bun.spawnSync(['git', 'init', '-q'], { cwd: root }).exitCode).toBe(0);
      expect(Bun.spawnSync([
        'git', '-c', 'user.name=Forge Test', '-c', 'user.email=forge@test.invalid',
        'commit', '--allow-empty', '-qm', 'init',
      ], { cwd: root }).exitCode).toBe(0);
      const pack = buildControllerContextPack(root, getMcpPolicy('controller', { repoRoot: root }), {
        description: 'Requirement-only: 复刻 SwiftUI 用药界面',
        knownPaths: ['src/MedicationView.swift'],
        maxFiles: 1,
        maxSnippets: 2,
      });
      expect(pack.files.some(file => file.path === 'src/MedicationView.swift')).toBe(true);
      expect(pack.instructionContext.contracts.map(contract => contract.path)).toContain('DESIGN.md');
      expect(pack.instructionContext.contracts.map(contract => contract.path)).toContain('docs/design/design-rules.md');
      expect(pack.instructionContext.contracts.find(contract => contract.path === 'DESIGN.md')?.content)
        .toContain('No ornamental shadows');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('first-turn UI intent resolves root guidance with only AGENTS.md known', () => {
    const root = mkdtempSync(join(tmpdir(), 'forge-root-design-bootstrap-'));
    try {
      mkdirSync(join(root, 'docs', 'design'), { recursive: true });
      writeFileSync(join(root, 'AGENTS.md'), 'UI guidance lives in \`docs/design/design-rules.md\`.\\n');
      writeFileSync(join(root, 'DESIGN.md'), 'Avoid decorative shadows.\\n');
      writeFileSync(join(root, 'docs', 'design', 'design-rules.md'), 'Use flat cards.\\n');
      expect(Bun.spawnSync(['git', 'init', '-q'], { cwd: root }).exitCode).toBe(0);
      expect(Bun.spawnSync([
        'git', '-c', 'user.name=Forge Test', '-c', 'user.email=forge@test.invalid',
        'commit', '--allow-empty', '-qm', 'init',
      ], { cwd: root }).exitCode).toBe(0);
      const pack = buildControllerContextPack(root, getMcpPolicy('controller', { repoRoot: root }), {
        description: '按用户设计规范继续修改用药界面',
        knownPaths: ['AGENTS.md'], maxFiles: 1, maxSnippets: 1,
      });
      const paths = pack.instructionContext.contracts.map(contract => contract.path);
      expect(paths).toContain('AGENTS.md');
      expect(paths).toContain('DESIGN.md');
      expect(paths).toContain('docs/design/design-rules.md');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('preserves bounded truncation evidence for long design documents', () => {
    const root = mkdtempSync(join(tmpdir(), 'forge-design-bounds-'));
    try {
      mkdirSync(join(root, 'src'), { recursive: true });
      writeFileSync(join(root, 'AGENTS.md'), '# Rules\nSee `DESIGN.md` for UI.\n');
      writeFileSync(join(root, 'DESIGN.md'), 'A'.repeat(20_000));
      writeFileSync(join(root, 'src', 'EditorView.swift'), 'struct EditorView {}\n');
      const ui = buildRepositoryInstructionContext(root, getMcpPolicy('controller', { repoRoot: root }),
        ['src/EditorView.swift'], { uiIntent: 'UI', maxCharsPerContract: 800, maxTotalChars: 2_000 });
      expect(ui.contracts.find(contract => contract.path === 'DESIGN.md')?.truncated).toBe(true);
      expect(ui.coverageGaps.some(gap => gap.includes('instruction_contract_content_truncated:DESIGN.md'))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
