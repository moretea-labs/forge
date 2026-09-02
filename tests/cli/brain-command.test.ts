import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { spawnSync } from 'child_process';
import { runBrainPromote } from '../../src/cli/commands/brain';

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

      const result = runBrainPromote({ repo, slug: 'terminal-history-canary', category: 'references', dryRun: true });
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
});
