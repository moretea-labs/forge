import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { spawnSync } from 'child_process';
import { runBrainPromote } from '../../src/cli/commands/brain';
import { registerRepository } from '../../src/cli/repositories/registry';
import { createRequirement, reviseRequirementSemantic } from '../../src/runtime/control-plane/persistence/requirement-store';

function git(repo: string, ...args: string[]) {
  const result = spawnSync('git', args, { cwd: repo, encoding: 'utf-8' });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  }
}

describe('brain terminal workflow promotion', () => {
  test('recovers terminal plan and notes from Git after repo-local cleanup', () => {
    const repo = mkdtempSync(join(tmpdir(), 'forge-brain-terminal-history-'));
    try {
      git(repo, 'init', '-q');
      git(repo, 'config', 'user.email', 'forge-test@example.invalid');
      git(repo, 'config', 'user.name', 'Forge Test');
      mkdirSync(join(repo, 'plans'), { recursive: true });
      mkdirSync(join(repo, 'tasks', 'notes'), { recursive: true });
      mkdirSync(join(repo, '.ai', 'harness'), { recursive: true });
      writeFileSync(
        join(repo, '.ai', 'harness', 'brain-manifest.json'),
        `${JSON.stringify({ version: 1, project: 'forge-brain-canary', default_brain_path: 'brain/forge-brain-canary/*', groups: [], entries: [] }, null, 2)}\n`,
      );

      const plan = 'plans/plan-20260831-0000-terminal-history-canary.md';
      const notes = 'tasks/notes/20260831-0000-terminal-history-canary.notes.md';
      writeFileSync(join(repo, plan), '# Plan: Terminal History Canary\n\n> **Status**: Completed\n\nGit is the terminal workflow evidence authority.\n');
      writeFileSync(join(repo, notes), '# Terminal History Canary Notes\n\n> **Outcome**: Completed\n\nRecover this note after repo-local cleanup.\n');
      git(repo, 'add', '.');
      git(repo, 'commit', '-qm', 'record terminal workflow evidence');

      unlinkSync(join(repo, plan));
      unlinkSync(join(repo, notes));
      git(repo, 'add', '-u');
      git(repo, 'commit', '-qm', 'close terminal workflow');

      const result = runBrainPromote({ repo, slug: 'terminal-history-canary', category: 'references', legacyGitHistory: true, dryRun: true });
      expect(result.issues).toEqual([]);
      expect(result.written).toBe(false);
      expect(result.sources).toHaveLength(2);
      expect(result.sources.every((source) => source.startsWith('git:'))).toBe(true);
      expect(result.sources.some((source) => source.includes(plan))).toBe(true);
      expect(result.sources.some((source) => source.includes(notes))).toBe(true);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test('modern promotion uses accepted Requirement evidence without Work lifecycle state', () => {
    const repo = mkdtempSync(join(tmpdir(), 'forge-brain-modern-requirement-'));
    const controllerHome = mkdtempSync(join(tmpdir(), 'forge-brain-modern-home-'));
    try {
      git(repo, 'init', '-q', '-b', 'main');
      git(repo, 'config', 'user.email', 'forge-test@example.invalid');
      git(repo, 'config', 'user.name', 'Forge Test');
      mkdirSync(join(repo, '.ai', 'harness'), { recursive: true });
      writeFileSync(join(repo, '.ai', 'harness', 'brain-manifest.json'), `${JSON.stringify({ version: 1, project: 'forge-brain-modern', groups: [], entries: [] }, null, 2)}\n`);
      writeFileSync(join(repo, 'README.md'), '# modern brain\n');
      git(repo, 'add', '.');
      git(repo, 'commit', '-qm', 'init modern brain fixture');
      registerRepository({ path: repo, controllerHome, displayName: 'Brain modern fixture' });
      const requirementId = 'REQ-BRAIN-MODERN';
      createRequirement({ controllerHome }, {
        requirementId,
        title: 'Promote validated architecture knowledge',
        outcomeStatement: 'Brain promotion is Requirement-scoped and Work-free.',
        acceptanceCriteria: ['Use accepted evidence rather than Work completion.'],
      });
      reviseRequirementSemantic({ controllerHome }, requirementId, {
        expectedRevision: 1,
        progressSummary: 'Validated one reusable architecture decision.',
        acceptedEvidenceRefs: ['git:abc123', 'check:brain-modern-pass'],
      });

      const result = runBrainPromote({ repo, controllerHome, requirementId, slug: 'modern-requirement', category: 'references', dryRun: true });
      expect(result.written).toBe(false);
      expect(result.issues).toEqual([]);
      expect(result.sources).toEqual(['requirement:REQ-BRAIN-MODERN', 'git:abc123', 'check:brain-modern-pass']);
      expect(result.sources.some(source => source.startsWith('work:'))).toBe(false);
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(controllerHome, { recursive: true, force: true });
    }
  });

  test('modern promotion refuses a Requirement with no accepted evidence instead of falling back to Work or Git history', () => {
    const repo = mkdtempSync(join(tmpdir(), 'forge-brain-modern-unaccepted-'));
    const controllerHome = mkdtempSync(join(tmpdir(), 'forge-brain-modern-unaccepted-home-'));
    try {
      git(repo, 'init', '-q', '-b', 'main');
      git(repo, 'config', 'user.email', 'forge-test@example.invalid');
      git(repo, 'config', 'user.name', 'Forge Test');
      mkdirSync(join(repo, '.ai', 'harness'), { recursive: true });
      writeFileSync(join(repo, '.ai', 'harness', 'brain-manifest.json'), `${JSON.stringify({ version: 1, project: 'forge-brain-modern', groups: [], entries: [] }, null, 2)}\n`);
      writeFileSync(join(repo, 'README.md'), '# modern brain\n');
      git(repo, 'add', '.');
      git(repo, 'commit', '-qm', 'init modern brain fixture');
      registerRepository({ path: repo, controllerHome, displayName: 'Brain unaccepted fixture' });
      const requirementId = 'REQ-BRAIN-UNACCEPTED';
      createRequirement({ controllerHome }, {
        requirementId,
        title: 'Unaccepted knowledge',
        outcomeStatement: 'No evidence yet.',
      });

      const result = runBrainPromote({ repo, controllerHome, requirementId, slug: 'modern-unaccepted', category: 'references', dryRun: true });
      expect(result.sources).toEqual([]);
      expect(result.issues.map(item => item.message).join('\n')).toContain('accepted Requirement evidence');
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(controllerHome, { recursive: true, force: true });
    }
  });


});
