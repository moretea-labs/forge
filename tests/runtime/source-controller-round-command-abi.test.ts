import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { previewRepositoryCommandExecution } from '../../src/cli/repositories/command-executor';
import { emptyWorkspaceSnapshot } from '../../src/cli/repositories/repository-snapshot';
import { registerRepository } from '../../src/cli/repositories/registry';

const roots: string[] = [];

function temp(prefix: string): string {
  const value = mkdtempSync(join(tmpdir(), prefix));
  roots.push(value);
  return value;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('current-source ControllerRound Tool Contract ABI', () => {
  test('repository executor admits only the exact typed controller-local effect', () => {
    const root = temp('forge-source-round-command-abi-');
    const controllerHome = join(root, 'controller');
    mkdirSync(controllerHome, { recursive: true });
    const repository = registerRepository({
      path: process.cwd(),
      controllerHome,
      displayName: 'source-round-command-abi',
    });
    const command = [
      'bun', 'src/cli/index.ts', 'chatgpt', 'round-continue',
      '--controller-home', controllerHome,
      '--repo-id', repository.repoId,
      '--work-id', 'work-source-round',
      '--controller-authority-id', 'cra_source_round',
      '--relay-scope-id', 'goal:work-source-round',
    ];

    const preview = previewRepositoryCommandExecution(repository, {
      command,
      dryRun: true,
      reuseSnapshot: emptyWorkspaceSnapshot(),
    }, controllerHome);

    expect(preview.executable).toBeTrue();
    expect(preview.execution.policyDecision).toBe('allowed');
    expect(preview.execution.externalPathUsages).toEqual([expect.objectContaining({
      canonicalPath: realpathSync(controllerHome),
      operation: 'controller_local_effect',
    })]);

    expect(() => previewRepositoryCommandExecution(repository, {
      command: command.map((value) => value === repository.repoId ? 'repo-other' : value),
      dryRun: true,
      reuseSnapshot: emptyWorkspaceSnapshot(),
    }, controllerHome)).toThrow('SOURCE_CONTROLLER_ROUND_COMMAND_REPOSITORY_MISMATCH');

    expect(() => previewRepositoryCommandExecution(repository, {
      command: `bun src/cli/index.ts chatgpt round-continue --controller-home ${controllerHome} --repo-id ${repository.repoId} --work-id work-source-round --controller-authority-id cra_source_round --relay-scope-id goal:work-source-round`,
      dryRun: true,
      reuseSnapshot: emptyWorkspaceSnapshot(),
    }, controllerHome)).toThrow('COMMAND_SCOPE_DENIED: external writes are not allowed from repository commands');
  });
});
