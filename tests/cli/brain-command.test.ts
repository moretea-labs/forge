import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { spawnSync } from 'child_process';
import { runBrainPromote } from '../../src/cli/commands/brain';
import { registerRepository } from '../../src/cli/repositories/registry';
import { createWorkContract, recordWorkCompletionReceipt } from '../../packages/kernel/work/api/index';

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

  test('modern promotion rejects a nonterminal Work instead of falling back to Git history', () => {
    const repo = mkdtempSync(join(tmpdir(), 'forge-brain-modern-nonterminal-'));
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
      const repository = registerRepository({ path: repo, controllerHome, displayName: 'Brain modern fixture' });
      const workId = 'work-brain-nonterminal';
      createWorkContract({ controllerHome, repoId: repository.repoId }, {
        workId, repoId: repository.repoId, mode: 'goal_workloop', objective: 'Not terminal yet', acceptanceCriteria: [],
        allowedPaths: [], forbiddenPaths: [], checks: [], constraints: { requireHandoffOnAmbiguity: true }, requestedBy: 'chatgpt', status: 'running',
        scopeRef: { schemaVersion: 1, kind: 'project', id: 'project-brain-modern' },
      });
      const result = runBrainPromote({ repo, controllerHome, workId, slug: 'modern-nonterminal', category: 'references', dryRun: true });
      expect(result.written).toBe(false);
      expect(result.sources).toEqual([]);
      expect(result.issues.map(item => item.message).join('\n')).toContain('completed Work with a durable completion receipt');
      expect(result.issues.map(item => item.message).join('\n')).not.toContain('Git history');
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(controllerHome, { recursive: true, force: true });
    }
  });

  test('modern promotion uses validated terminal Work completion evidence and never requires deleted Git files', () => {
    const repo = mkdtempSync(join(tmpdir(), 'forge-brain-modern-terminal-'));
    const controllerHome = mkdtempSync(join(tmpdir(), 'forge-brain-modern-terminal-home-'));
    try {
      git(repo, 'init', '-q', '-b', 'main');
      git(repo, 'config', 'user.email', 'forge-test@example.invalid');
      git(repo, 'config', 'user.name', 'Forge Test');
      mkdirSync(join(repo, '.ai', 'harness'), { recursive: true });
      writeFileSync(join(repo, '.ai', 'harness', 'brain-manifest.json'), `${JSON.stringify({ version: 1, project: 'forge-brain-modern', groups: [], entries: [] }, null, 2)}\n`);
      writeFileSync(join(repo, 'README.md'), '# terminal brain\n');
      git(repo, 'add', '.');
      git(repo, 'commit', '-qm', 'init terminal brain fixture');
      const repository = registerRepository({ path: repo, controllerHome, displayName: 'Brain terminal fixture' });
      const workId = 'work-brain-terminal';
      const store = { controllerHome, repoId: repository.repoId };
      createWorkContract(store, {
        workId, repoId: repository.repoId, mode: 'goal_workloop', objective: 'Produce one durable learning result', acceptanceCriteria: ['terminal evidence exists'],
        allowedPaths: [], forbiddenPaths: [], checks: [], constraints: { requireHandoffOnAmbiguity: true }, requestedBy: 'chatgpt', status: 'running',
        workKind: 'local_effect', scopeRef: { schemaVersion: 1, kind: 'project', id: 'project-brain-modern' },
      });
      const recordedAt = '2026-09-08T00:00:00.000Z';
      recordWorkCompletionReceipt(store, workId, {
        schemaVersion: 1, receiptId: 'REC-brain-terminal', source: 'local_effect', workId,
        operation: 'capture_learning_result', target: { kind: 'controller_local', id: 'brain-learning-result' }, changed: true, recordedAt,
      }, 'completed_local', 'local_effect');
      const result = runBrainPromote({ repo, controllerHome, workId, slug: 'modern-terminal', category: 'references', dryRun: true });
      expect(result.issues).toEqual([]);
      expect(result.written).toBe(false);
      expect(result.sources).toEqual([`work:${workId}`, 'completion:REC-brain-terminal']);
      expect(result.sources.some(source => source.startsWith('git:'))).toBe(false);
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(controllerHome, { recursive: true, force: true });
    }
  });

});
