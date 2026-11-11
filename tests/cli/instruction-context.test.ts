import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getMcpPolicy } from '../../adapters/mcp/policy';
import { buildRepositoryInstructionContext } from '../../src/cli/controller/context/instruction-context';

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
