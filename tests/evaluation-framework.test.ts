import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, test } from 'bun:test';
import { parseScenario } from '../evaluation/lib/scenario.ts';
import { runEvaluation } from '../evaluation/lib/runner.ts';
import type { EvaluationScenario } from '../evaluation/lib/types.ts';

function git(cwd: string, arguments_: string[]): string {
  return execFileSync('git', arguments_, { cwd, encoding: 'utf8' }).trim();
}

function scenario(source: string, commit: string): EvaluationScenario {
  return parseScenario({
    schemaVersion: 'forge-evaluation-scenario/v1',
    id: 'isolated-framework-fixture',
    title: 'Isolated framework fixture',
    userIntent: 'Write evidence only in the isolated snapshot.',
    snapshot: { source, commit },
    groundTruth: {
      intendedBehavior: ['The isolated clone may change.'],
      affectedDomains: ['fixture-domain'],
      behavioralInvariants: ['The source repository is untouched.'],
      regressionRisks: ['Accidentally executing in the source repository.'],
    },
    execution: { interface: 'forge_cli', arguments: ['fixture'], traceFile: 'execution-trace.json' },
    validators: [
      {
        id: 'sandbox-command-wrote-evidence',
        kind: 'invariant',
        type: 'command',
        command: process.execPath,
        arguments: ['-e', "const fs=require('fs'); process.exit(fs.existsSync('execution-evidence.txt') ? 0 : 1)"],
      },
      {
        id: 'no-protected-change',
        kind: 'change_precision',
        type: 'changed_paths',
        requiredGlobs: ['execution-evidence.txt'],
        forbiddenGlobs: ['protected/**'],
      },
    ],
  });
}

describe('Forge evaluation framework', () => {
  test('runs only in a clone, captures a trace, calculates metrics, and writes a report externally', () => {
    const root = mkdtempSync(join(tmpdir(), 'forge-evaluation-test-'));
    try {
      const source = join(root, 'source');
      const output = join(root, 'output');
      const fixtureForge = join(root, 'fixture-forge.cjs');
      execFileSync('git', ['init', '--initial-branch=main', source]);
      writeFileSync(join(source, 'README.md'), 'fixture\n');
      git(source, ['add', 'README.md']);
      git(source, ['-c', 'user.email=evaluation@example.test', '-c', 'user.name=Evaluation', 'commit', '-m', 'fixture']);
      const commit = git(source, ['rev-parse', 'HEAD']);
      writeFileSync(fixtureForge, "const fs=require('fs'); fs.writeFileSync('execution-evidence.txt', process.cwd()); fs.writeFileSync('execution-trace.json', JSON.stringify({ contextRetrieval:[{domain:'fixture-domain',source:'fixture-forge',summary:'queried fixture context'}], inspectedEvidence:[{domain:'fixture-domain',source:'fixture-forge',summary:'inspected fixture evidence'}], toolInteractions:[{name:'rh_context',outcome:'success'}], finalResult:'fixture executor completed' })); console.log('forge fixture');\n");

      const report = runEvaluation({
        scenario: scenario(source, commit),
        forgeCommand: { executable: process.execPath, prefixArguments: [fixtureForge] },
        outputDirectory: output,
      });

      expect(report.trace.finalResult.status).toBe('passed');
      expect(report.trace.snapshot.sourceStateBefore).toEqual(report.trace.snapshot.sourceStateAfter);
      expect(git(source, ['status', '--porcelain'])).toBe('');
      expect(report.trace.changedFiles).toEqual(['execution-evidence.txt']);
      expect(report.trace.commands.some((command) => command.command === 'git' && command.arguments[0] === 'clone')).toBe(true);
      expect(report.trace.commands.every((command) => command.cwd.length > 0)).toBe(true);
      expect(report.trace.sandbox.path).toBeUndefined();
      expect(report.metrics.taskSuccessRate).toBe(1);
      expect(report.metrics.impactCoverage).toBe(1);
      expect(report.metrics.behavioralInvariantSuccess).toBe(1);
      expect(report.metrics.changePrecision).toBe(1);
      expect(report.trace.validation.find((result) => result.id === 'no-protected-change')?.status).toBe('passed');
      expect(report.metrics.executionLatencyMs).not.toBeNull();
      expect(report.metrics.toolInteractionCount).toBe(3);
      expect(report.trace.finalResult.summary).toBe('fixture executor completed');
      expect(existsSync(join(output, 'report.json'))).toBe(true);
      expect(readFileSync(join(output, 'report.md'), 'utf8')).toContain('Forge Evaluation: Isolated framework fixture');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('rejects a changed-path validator with no positive or negative ground truth', () => {
    const input = scenario('/tmp/source', 'abcdef1') as unknown as Record<string, unknown>;
    const validators = input.validators as Array<Record<string, unknown>>;
    validators[1] = { id: 'empty-change-scope', kind: 'change_precision', type: 'changed_paths' };
    expect(() => parseScenario(input)).toThrow('changed_paths must declare requiredGlobs, forbiddenGlobs, or both');
  });

  test('rejects a report path inside the source repository before execution', () => {
    const root = mkdtempSync(join(tmpdir(), 'forge-evaluation-test-'));
    try {
      execFileSync('git', ['init', '--initial-branch=main', root]);
      writeFileSync(join(root, 'README.md'), 'fixture\n');
      git(root, ['add', 'README.md']);
      git(root, ['-c', 'user.email=evaluation@example.test', '-c', 'user.name=Evaluation', 'commit', '-m', 'fixture']);
      const input = scenario(root, git(root, ['rev-parse', 'HEAD']));
      expect(() => runEvaluation({
        scenario: input,
        forgeCommand: { executable: process.execPath },
        outputDirectory: join(root, 'forbidden-report'),
      })).toThrow('Evaluation output must be outside the source repository');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
