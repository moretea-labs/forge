import { afterEach, describe, expect, test } from 'bun:test';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { controllerSystemRoot } from '../../src/cli/repositories/controller-home';
import {
  acquireControllerLock,
  releaseControllerLock,
} from '../../src/cli/repositories/locks';
import {
  authorizeWorkspaceTargetGrant,
  getActiveWorkspaceTargetGrant,
  listActiveWorkspaceTargetGrants,
  resolveWorkspaceTargetCwd,
  resolveWorkspaceTargetPath,
  WorkspaceTargetGrantError,
  withWorkspaceTargetMutationLocks,
  workspaceTargetGrantStorePath,
  workspaceTargetMutationResourceId,
} from '../../src/runtime/workspace-targets';
import {
  executeLocalSystemPluginAction,
  resetLocalSystemPluginHooksForTest,
  setLocalSystemPluginHooksForTest,
} from '../../src/runtime/plugins/local-system-adapter';
import {
  controllerPluginRepository,
  submitAssistantPluginAction,
} from '../../src/runtime/plugins/store';
import type { AssistantPluginActionExecutionInput } from '../../src/runtime/plugins/types';
import { getWorkContractByRequestId } from '../../src/runtime/control-plane/facade/work-contract-store';

const roots: string[] = [];

afterEach(() => {
  resetLocalSystemPluginHooksForTest();
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

function temp(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function input(
  controllerHome: string,
  actionId: string,
  args: Record<string, unknown>,
): AssistantPluginActionExecutionInput {
  return {
    controllerHome,
    repoId: '__controller__',
    repoRoot: controllerHome,
    pluginId: 'local_system',
    actionId,
    requestId: `request-${actionId}`,
    args,
    origin: { surface: 'chatgpt-action', actor: 'principal:test-user' },
  };
}

function expectGrantCode(action: () => unknown, code: WorkspaceTargetGrantError['code']): void {
  try {
    action();
    throw new Error(`Expected ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(WorkspaceTargetGrantError);
    expect((error as WorkspaceTargetGrantError).code).toBe(code);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

describe('workspace target grant authority', () => {
  test('serializes same-root mutations while allowing different roots to overlap', async () => {
    const controllerHome = temp('forge-target-lock-controller-');
    const rootA = temp('forge-target-lock-a-');
    const rootB = temp('forge-target-lock-b-');
    const targetA = authorizeWorkspaceTargetGrant(controllerHome, {
      targetKey: 'a', rootPath: rootA, ownerScope: 'owner:a', access: 'read_write', reason: 'lock a',
    });
    const targetB = authorizeWorkspaceTargetGrant(controllerHome, {
      targetKey: 'b', rootPath: rootB, ownerScope: 'owner:b', access: 'read_write', reason: 'lock b',
    });

    let sameActive = 0;
    let sameMax = 0;
    const sameMutation = (owner: string) => withWorkspaceTargetMutationLocks(
      controllerHome,
      [targetA],
      owner,
      async () => {
        sameActive += 1;
        sameMax = Math.max(sameMax, sameActive);
        await delay(40);
        sameActive -= 1;
      },
      { waitMs: 1_000 },
    );
    await Promise.all([sameMutation('same-a'), sameMutation('same-b')]);
    expect(sameMax).toBe(1);

    let differentActive = 0;
    let differentMax = 0;
    await Promise.all([
      withWorkspaceTargetMutationLocks(controllerHome, [targetA], 'different-a', async () => {
        differentActive += 1;
        differentMax = Math.max(differentMax, differentActive);
        await delay(40);
        differentActive -= 1;
      }, { waitMs: 1_000 }),
      withWorkspaceTargetMutationLocks(controllerHome, [targetB], 'different-b', async () => {
        differentActive += 1;
        differentMax = Math.max(differentMax, differentActive);
        await delay(40);
        differentActive -= 1;
      }, { waitMs: 1_000 }),
    ]);
    expect(differentMax).toBe(2);
  });

  test('uses canonical root rather than grant owner as mutation contention identity', async () => {
    const controllerHome = temp('forge-target-lock-shared-controller-');
    const root = temp('forge-target-lock-shared-root-');
    const first = authorizeWorkspaceTargetGrant(controllerHome, {
      targetKey: 'first', rootPath: root, ownerScope: 'owner:first', access: 'read_write', reason: 'first grant',
    });
    const second = authorizeWorkspaceTargetGrant(controllerHome, {
      targetKey: 'second', rootPath: root, ownerScope: 'owner:second', access: 'read_write', reason: 'second grant',
    });
    expect(first.workspaceId).not.toBe(second.workspaceId);
    expect(workspaceTargetMutationResourceId(first)).toBe(workspaceTargetMutationResourceId(second));

    let active = 0;
    let maxActive = 0;
    const run = (target: typeof first, owner: string) => withWorkspaceTargetMutationLocks(
      controllerHome,
      [target],
      owner,
      async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await delay(30);
        active -= 1;
      },
      { waitMs: 1_000 },
    );
    await Promise.all([run(first, 'first-op'), run(second, 'second-op')]);
    expect(maxActive).toBe(1);
  });

  test('orders multi-target locks deterministically so reverse requests cannot deadlock', async () => {
    const controllerHome = temp('forge-target-lock-pair-controller-');
    const rootA = temp('forge-target-lock-pair-a-');
    const rootB = temp('forge-target-lock-pair-b-');
    const targetA = authorizeWorkspaceTargetGrant(controllerHome, {
      targetKey: 'a', rootPath: rootA, ownerScope: 'owner:pair', access: 'read_write', reason: 'pair a',
    });
    const targetB = authorizeWorkspaceTargetGrant(controllerHome, {
      targetKey: 'b', rootPath: rootB, ownerScope: 'owner:pair', access: 'read_write', reason: 'pair b',
    });

    let active = 0;
    let maxActive = 0;
    const run = (targets: [typeof targetA, typeof targetB], owner: string) => withWorkspaceTargetMutationLocks(
      controllerHome,
      targets,
      owner,
      async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await delay(30);
        active -= 1;
      },
      { waitMs: 1_000 },
    );
    await Promise.all([
      run([targetA, targetB], 'pair-forward'),
      run([targetB, targetA], 'pair-reverse'),
    ]);
    expect(maxActive).toBe(1);
  });

  test('keeps the existing local_system targets.json as the sole store', () => {
    const controllerHome = temp('forge-target-controller-');
    expect(workspaceTargetGrantStorePath(controllerHome)).toBe(
      join(controllerSystemRoot(controllerHome), 'local-system', 'targets.json'),
    );
  });

  test('reads historical schema-v1 records without rewriting them', () => {
    const controllerHome = temp('forge-target-legacy-');
    const root = temp('forge-target-legacy-root-');
    const path = workspaceTargetGrantStorePath(controllerHome);
    writeFileSync(path, `${JSON.stringify({
      schemaVersion: 1,
      targets: [{
        targetKey: 'legacy',
        rootPath: root,
        createdAt: '2026-08-07T00:00:00.000Z',
        expiresAt: '2026-08-08T00:00:00.000Z',
        reason: 'legacy compatibility',
      }],
    }, null, 2)}\n`);

    const target = getActiveWorkspaceTargetGrant(
      controllerHome,
      'legacy',
      new Date('2026-08-07T01:00:00.000Z'),
    );
    expect(target.access).toBe('read_write');
    expect(target.ownerScope).toBe('legacy:shared');
    expect(target.workspaceId.startsWith('workspace_')).toBe(true);
    expect(target.rootPath).toBe(realpathSync(root));
  });

  test('fails closed when the persisted target store is corrupt', () => {
    const controllerHome = temp('forge-target-corrupt-controller-');
    const root = temp('forge-target-corrupt-root-');
    const path = workspaceTargetGrantStorePath(controllerHome);
    writeFileSync(path, '{not-json\n');

    expectGrantCode(
      () => authorizeWorkspaceTargetGrant(controllerHome, {
        targetKey: 'must-not-overwrite',
        rootPath: root,
        ownerScope: 'principal:test',
        reason: 'corrupt store must remain intact',
      }),
      'TARGET_STORE_CORRUPT',
    );
    expect(readFileSync(path, 'utf8')).toBe('{not-json\n');
  });

  test('rejects malformed records and identity drift without rewriting evidence', () => {
    const controllerHome = temp('forge-target-integrity-controller-');
    const root = temp('forge-target-integrity-root-');
    const path = workspaceTargetGrantStorePath(controllerHome);
    writeFileSync(path, `${JSON.stringify({
      schemaVersion: 1,
      targets: [{
        targetKey: 'malformed',
        rootPath: root,
        createdAt: '2026-08-07T00:00:00.000Z',
        expiresAt: '2026-08-08T00:00:00.000Z',
      }],
    })}\n`);
    expectGrantCode(
      () => listActiveWorkspaceTargetGrants(
        controllerHome,
        new Date('2026-08-07T01:00:00.000Z'),
      ),
      'TARGET_STORE_CORRUPT',
    );

    const cleanHome = temp('forge-target-identity-drift-controller-');
    authorizeWorkspaceTargetGrant(cleanHome, {
      targetKey: 'drift',
      rootPath: root,
      ownerScope: 'principal:test',
      reason: 'identity evidence',
      now: new Date('2026-08-07T00:00:00.000Z'),
    });
    const cleanPath = workspaceTargetGrantStorePath(cleanHome);
    const persisted = JSON.parse(readFileSync(cleanPath, 'utf8')) as {
      targets: Array<Record<string, unknown>>;
    };
    persisted.targets[0]!.workspaceId = 'workspace_tampered';
    writeFileSync(cleanPath, `${JSON.stringify(persisted, null, 2)}\n`);
    expectGrantCode(
      () => getActiveWorkspaceTargetGrant(
        cleanHome,
        'drift',
        new Date('2026-08-07T01:00:00.000Z'),
        'principal:test',
      ),
      'TARGET_IDENTITY_MISMATCH',
    );
  });

  test('creates stable scoped identities and refreshes Git detection without mutation', () => {
    const controllerHome = temp('forge-target-identity-controller-');
    const root = temp('forge-target-identity-root-');
    const first = authorizeWorkspaceTargetGrant(controllerHome, {
      targetKey: 'first',
      rootPath: root,
      ownerScope: 'chatgpt-action:principal:test-user',
      access: 'read_write',
      reason: 'test',
      now: new Date('2026-08-07T00:00:00.000Z'),
    });
    const same = authorizeWorkspaceTargetGrant(controllerHome, {
      targetKey: 'same-root',
      rootPath: root,
      ownerScope: 'chatgpt-action:principal:test-user',
      access: 'read_write',
      reason: 'retry',
      now: new Date('2026-08-07T00:01:00.000Z'),
    });
    const readOnly = authorizeWorkspaceTargetGrant(controllerHome, {
      targetKey: 'read-only',
      rootPath: root,
      ownerScope: 'chatgpt-action:principal:test-user',
      access: 'read_only',
      reason: 'read',
      now: new Date('2026-08-07T00:02:00.000Z'),
    });

    expect(same.workspaceId).toBe(first.workspaceId);
    expect(readOnly.workspaceId).not.toBe(first.workspaceId);
    expect(first.git.kind).toBe('none');
    mkdirSync(join(root, '.git'));
    expect(getActiveWorkspaceTargetGrant(
      controllerHome,
      'first',
      new Date('2026-08-07T00:03:00.000Z'),
      'chatgpt-action:principal:test-user',
    ).git.kind).toBe('repository_root');
    expectGrantCode(
      () => resolveWorkspaceTargetPath(controllerHome, 'first', '.', {
        ownerScope: 'chatgpt-action:principal:other-user',
        mustExist: true,
        at: new Date('2026-08-07T00:03:00.000Z'),
      }),
      'TARGET_OWNER_MISMATCH',
    );
    expect(listActiveWorkspaceTargetGrants(
      controllerHome,
      new Date('2026-08-07T00:03:00.000Z'),
    )).toHaveLength(3);

    const otherOwner = authorizeWorkspaceTargetGrant(controllerHome, {
      targetKey: 'first',
      rootPath: root,
      ownerScope: 'chatgpt-action:principal:other-user',
      access: 'read_write',
      reason: 'same key in another session',
      now: new Date('2026-08-07T00:04:00.000Z'),
    });
    expect(otherOwner.workspaceId).not.toBe(first.workspaceId);
    expect(getActiveWorkspaceTargetGrant(
      controllerHome,
      'first',
      new Date('2026-08-07T00:05:00.000Z'),
      'chatgpt-action:principal:test-user',
    ).workspaceId).toBe(first.workspaceId);
    expect(getActiveWorkspaceTargetGrant(
      controllerHome,
      'first',
      new Date('2026-08-07T00:05:00.000Z'),
      'chatgpt-action:principal:other-user',
    ).workspaceId).toBe(otherOwner.workspaceId);
  });

  test('fails closed on concurrent grant-store mutation instead of losing an update', () => {
    const controllerHome = temp('forge-target-lock-controller-');
    const root = temp('forge-target-lock-root-');
    const key = { scope: 'global' as const, resource: 'local-system-target-grants' };
    const lock = acquireControllerLock(controllerHome, key, 'test-holder', 5_000);
    try {
      expectGrantCode(
        () => authorizeWorkspaceTargetGrant(controllerHome, {
          targetKey: 'blocked',
          rootPath: root,
          ownerScope: 'principal:test',
          reason: 'must not race',
        }),
        'TARGET_STORE_BUSY',
      );
      expect(listActiveWorkspaceTargetGrants(controllerHome)).toHaveLength(0);
    } finally {
      releaseControllerLock(controllerHome, key, lock.lockId);
    }
  });

  test('resolves file and cwd paths through one symlink-safe boundary', () => {
    const controllerHome = temp('forge-target-path-controller-');
    const root = temp('forge-target-path-root-');
    const outside = temp('forge-target-outside-');
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'src', 'index.ts'), 'export {};\n');
    writeFileSync(join(outside, 'secret.txt'), 'secret\n');
    symlinkSync(outside, join(root, 'escape'), 'dir');
    authorizeWorkspaceTargetGrant(controllerHome, {
      targetKey: 'workspace',
      rootPath: root,
      ownerScope: 'principal:test',
      reason: 'path checks',
    });

    expect(resolveWorkspaceTargetPath(controllerHome, 'workspace', 'src/index.ts', {
      ownerScope: 'principal:test',
      mustExist: true,
      kind: 'file',
    }).path).toBe(realpathSync(join(root, 'src', 'index.ts')));
    expect(resolveWorkspaceTargetCwd(
      controllerHome,
      'workspace',
      'principal:test',
      'src',
      'read',
    ).path).toBe(realpathSync(join(root, 'src')));
    expect(resolveWorkspaceTargetPath(controllerHome, 'workspace', 'generated/out.txt', {
      ownerScope: 'principal:test',
      operation: 'write',
    }).path).toBe(join(realpathSync(root), 'generated', 'out.txt'));
    expectGrantCode(
      () => resolveWorkspaceTargetPath(controllerHome, 'workspace', '../outside', {
        ownerScope: 'principal:test',
      }),
      'PATH_OUTSIDE_TARGET',
    );
    expectGrantCode(
      () => resolveWorkspaceTargetPath(controllerHome, 'workspace', 'escape/secret.txt', {
        ownerScope: 'principal:test',
        mustExist: true,
      }),
      'SYMLINK_ESCAPE',
    );
    expectGrantCode(
      () => resolveWorkspaceTargetPath(controllerHome, 'workspace', 'escape/future.txt', {
        ownerScope: 'principal:test',
        operation: 'write',
      }),
      'SYMLINK_ESCAPE',
    );
  });

  test('blocks writes through a read-only grant', () => {
    const controllerHome = temp('forge-target-readonly-controller-');
    const root = temp('forge-target-readonly-root-');
    authorizeWorkspaceTargetGrant(controllerHome, {
      targetKey: 'readonly',
      rootPath: root,
      ownerScope: 'principal:test',
      access: 'read_only',
      reason: 'read only',
    });

    expect(resolveWorkspaceTargetCwd(controllerHome, 'readonly', 'principal:test').path)
      .toBe(realpathSync(root));
    expectGrantCode(
      () => resolveWorkspaceTargetPath(controllerHome, 'readonly', 'new.txt', {
        ownerScope: 'principal:test',
        operation: 'write',
      }),
      'TARGET_ACCESS_DENIED',
    );
  });
});

describe('local_system target adapter', () => {
  test('promotes Git-contained target authorization to the project root by default', async () => {
    const controllerHome = temp('forge-target-project-scope-controller-');
    const project = temp('forge-target-project-scope-root-');
    mkdirSync(join(project, '.git'));
    const nested = join(project, 'src', 'feature');
    mkdirSync(nested, { recursive: true });

    const auto = authorizeWorkspaceTargetGrant(controllerHome, {
      targetKey: 'auto-project',
      rootPath: nested,
      ownerScope: 'principal:test',
      access: 'read_write',
      reason: 'project work',
    });
    expect(auto.rootPath).toBe(realpathSync(project));
    expect(auto.git.kind).toBe('repository_root');

    const directory = authorizeWorkspaceTargetGrant(controllerHome, {
      targetKey: 'directory-only',
      rootPath: nested,
      scope: 'directory',
      ownerScope: 'principal:test',
      access: 'read_write',
      reason: 'narrow directory work',
    });
    expect(directory.rootPath).toBe(realpathSync(nested));
    expect(directory.git.kind).toBe('within_repository');
  });

  test('authorizes and lists a scoped grant without repository registration', async () => {
    const controllerHome = temp('forge-target-plugin-controller-');
    const root = temp('forge-target-plugin-root-');
    setLocalSystemPluginHooksForTest({
      now: () => new Date('2026-08-07T00:00:00.000Z'),
    });

    const authorized = await executeLocalSystemPluginAction(input(controllerHome, 'authorize_target', {
      target_key: 'project',
      root_path: root,
      expires_in_minutes: 60,
      reason: 'temporary project work',
      access: 'read_only',
    }));

    expect(authorized.repositoryRegistered).toBe(false);
    expect((authorized.target as Record<string, unknown>).access).toBe('read_only');
    expect((authorized.target as Record<string, unknown>).ownerScope)
      .toBe('chatgpt-action:principal:test-user');

    const genericAuthorized = await executeLocalSystemPluginAction({
      ...input(controllerHome, 'authorize_target', {
        target_key: 'shared-project',
        root_path: root,
        expires_in_minutes: 60,
        reason: 'controller shared compatibility',
      }),
      origin: { surface: 'mcp', actor: 'plugin_action_execute' },
    });
    expect((genericAuthorized.target as Record<string, unknown>).ownerScope)
      .toBe('controller:shared');

    const principalList = await executeLocalSystemPluginAction(
      input(controllerHome, 'list_targets', {}),
    );
    const sharedList = await executeLocalSystemPluginAction({
      ...input(controllerHome, 'list_targets', {}),
      origin: { surface: 'mcp', actor: 'plugin_action_execute' },
    });
    expect((principalList.targets as unknown[])).toHaveLength(1);
    expect((sharedList.targets as unknown[])).toHaveLength(1);
  });

  test('never auto-opens command files or executable scripts', async () => {
    const controllerHome = temp('forge-target-open-safe-controller-');
    const root = temp('forge-target-open-safe-root-');
    const commandFile = join(root, 'run-system.command');
    const executableScript = join(root, 'run.sh');
    const document = join(root, 'notes.txt');
    writeFileSync(commandFile, '#!/bin/zsh\necho unsafe\n');
    writeFileSync(executableScript, '#!/bin/sh\necho unsafe\n');
    chmodSync(executableScript, 0o755);
    writeFileSync(document, 'safe document\n');
    authorizeWorkspaceTargetGrant(controllerHome, {
      targetKey: 'project', rootPath: root, ownerScope: 'chatgpt-action:principal:test-user', access: 'read_write', reason: 'document open safety',
    });
    const commands: string[][] = [];
    setLocalSystemPluginHooksForTest({
      runCommand: (command, args) => {
        commands.push([command, ...args]);
        return { ok: true, status: 0, stdout: '', stderr: '', command: [command, ...args] };
      },
    });

    await expect(executeLocalSystemPluginAction(input(controllerHome, 'open_file', {
      target_key: 'project', path: 'run-system.command',
    }))).rejects.toThrow(/LOCAL_SYSTEM_EXECUTABLE_OPEN_DENIED/);
    await expect(executeLocalSystemPluginAction(input(controllerHome, 'open_file', {
      target_key: 'project', path: 'run.sh',
    }))).rejects.toThrow(/LOCAL_SYSTEM_EXECUTABLE_OPEN_DENIED/);
    expect(commands).toHaveLength(0);

    await expect(executeLocalSystemPluginAction(input(controllerHome, 'open_file', {
      target_key: 'project', path: 'notes.txt',
    }))).resolves.toMatchObject({ opened: true, path: 'notes.txt' });
    expect(commands).toEqual([['open', realpathSync(document)]]);
  });

  test('executes bounded typed-argv reads without repository registration or Work creation', async () => {
    const controllerHome = temp('forge-target-command-read-controller-');
    const root = temp('forge-target-command-read-root-');
    writeFileSync(join(root, 'note.txt'), 'hello target\n');
    authorizeWorkspaceTargetGrant(controllerHome, {
      targetKey: 'project',
      rootPath: root,
      ownerScope: 'chatgpt-action:principal:test-user',
      access: 'read_only',
      reason: 'readonly command',
    });

    const requestId = 'target-read-command';
    const submitted = await submitAssistantPluginAction(
      controllerHome,
      controllerPluginRepository(controllerHome),
      {
        pluginId: 'local_system',
        actionId: 'execute_command',
        requestId,
        args: { target_key: 'project', command: ['cat', 'note.txt'] },
        origin: { surface: 'chatgpt-action', actor: 'principal:test-user' },
      },
    );

    expect(submitted.workId).toBeUndefined();
    expect(submitted.receipt.workId).toBeUndefined();
    expect((submitted.result?.result as Record<string, unknown>).repositoryRegistered).toBe(false);
    expect((submitted.result?.result as Record<string, unknown>).stdout).toContain('hello target');
    expect(getWorkContractByRequestId(controllerHome, requestId, '__controller__')).toBeUndefined();
  });

  test('terminalizes a lightweight local-effect Work for a target mutation', async () => {
    const controllerHome = temp('forge-target-command-write-controller-');
    const root = temp('forge-target-command-write-root-');
    authorizeWorkspaceTargetGrant(controllerHome, {
      targetKey: 'project',
      rootPath: root,
      ownerScope: 'chatgpt-action:principal:test-user',
      access: 'read_write',
      reason: 'mutation command',
    });

    const requestId = 'target-write-command';
    const submitted = await submitAssistantPluginAction(
      controllerHome,
      controllerPluginRepository(controllerHome),
      {
        pluginId: 'local_system',
        actionId: 'execute_command',
        requestId,
        args: { target_key: 'project', command: ['touch', 'created.txt'] },
        origin: { surface: 'chatgpt-action', actor: 'principal:test-user' },
      },
    );

    expect(existsSync(join(root, 'created.txt'))).toBe(true);
    expect(submitted.workId).toBeTruthy();
    expect(submitted.receipt.workId).toBe(submitted.workId);
    const work = getWorkContractByRequestId(controllerHome, requestId, '__controller__');
    expect(work).toMatchObject({
      workId: submitted.workId,
      status: 'completed',
      workKind: 'local_effect',
      dispatchState: 'terminal',
      evidenceState: 'valid',
      completionOutcome: 'completed_local',
    });
    expect(work?.completionReceipt).toMatchObject({
      source: 'local_effect',
      workId: submitted.workId,
      operation: 'local_system/execute_command',
      changed: true,
    });
  });

  test('fails mutating Work terminally when target access rejects the command', async () => {
    const controllerHome = temp('forge-target-command-fail-controller-');
    const root = temp('forge-target-command-fail-root-');
    authorizeWorkspaceTargetGrant(controllerHome, {
      targetKey: 'project',
      rootPath: root,
      ownerScope: 'chatgpt-action:principal:test-user',
      access: 'read_only',
      reason: 'deny mutation',
    });

    const requestId = 'target-write-command-denied';
    await expect(submitAssistantPluginAction(
      controllerHome,
      controllerPluginRepository(controllerHome),
      {
        pluginId: 'local_system',
        actionId: 'execute_command',
        requestId,
        args: { target_key: 'project', command: ['touch', 'denied.txt'] },
        origin: { surface: 'chatgpt-action', actor: 'principal:test-user' },
      },
    )).rejects.toThrow(/LOCAL_SYSTEM_TARGET_READ_ONLY/);

    expect(existsSync(join(root, 'denied.txt'))).toBe(false);
    expect(getWorkContractByRequestId(controllerHome, requestId, '__controller__')).toMatchObject({
      status: 'failed',
      workKind: 'local_effect',
      dispatchState: 'terminal',
      evidenceState: 'failed',
    });
  });

  test('marks a mutating command Work failed when the process exits non-zero', async () => {
    const controllerHome = temp('forge-target-command-exit-controller-');
    const root = temp('forge-target-command-exit-root-');
    mkdirSync(join(root, 'existing'));
    authorizeWorkspaceTargetGrant(controllerHome, {
      targetKey: 'project',
      rootPath: root,
      ownerScope: 'chatgpt-action:principal:test-user',
      access: 'read_write',
      reason: 'non-zero mutation',
    });

    const requestId = 'target-write-command-nonzero';
    await expect(submitAssistantPluginAction(
      controllerHome,
      controllerPluginRepository(controllerHome),
      {
        pluginId: 'local_system',
        actionId: 'execute_command',
        requestId,
        args: { target_key: 'project', command: ['mkdir', 'existing'] },
        origin: { surface: 'chatgpt-action', actor: 'principal:test-user' },
      },
    )).rejects.toThrow(/LOCAL_SYSTEM_COMMAND_FAILED/);

    expect(getWorkContractByRequestId(controllerHome, requestId, '__controller__')).toMatchObject({
      status: 'failed',
      workKind: 'local_effect',
      dispatchState: 'terminal',
      evidenceState: 'failed',
    });
  });

  test('rejects dangerous and escaping target commands before execution', async () => {
    const controllerHome = temp('forge-target-command-policy-controller-');
    const root = temp('forge-target-command-policy-root-');
    const outside = temp('forge-target-command-policy-outside-');
    const outsideFile = join(outside, 'secret.txt');
    writeFileSync(join(root, 'local.txt'), 'local\n');
    writeFileSync(outsideFile, 'outside\n');
    authorizeWorkspaceTargetGrant(controllerHome, {
      targetKey: 'project',
      rootPath: root,
      ownerScope: 'chatgpt-action:principal:test-user',
      access: 'read_write',
      reason: 'command policy',
    });

    await expect(executeLocalSystemPluginAction(input(controllerHome, 'execute_command', {
      target_key: 'project',
      command: ['rm', 'local.txt'],
    }))).rejects.toThrow(/LOCAL_SYSTEM_COMMAND_RISK_DENIED/);
    expect(existsSync(join(root, 'local.txt'))).toBe(true);

    await expect(executeLocalSystemPluginAction(input(controllerHome, 'execute_command', {
      target_key: 'project',
      command: ['cat', outsideFile],
    }))).rejects.toThrow(/EXTERNAL_FILESYSTEM_GRANT_REQUIRED|COMMAND_SCOPE_DENIED/);

    await expect(executeLocalSystemPluginAction(input(controllerHome, 'execute_command', {
      target_key: 'project',
      command: ['npm', 'publish'],
    }))).rejects.toThrow(/LOCAL_SYSTEM_COMMAND_REPOSITORY_REQUIRED/);

    await expect(executeLocalSystemPluginAction(input(controllerHome, 'execute_command', {
      target_key: 'project',
      command: ['docker', 'rm', 'anything'],
    }))).rejects.toThrow(/LOCAL_SYSTEM_COMMAND_REPOSITORY_REQUIRED/);

    await expect(executeLocalSystemPluginAction(input(controllerHome, 'execute_command', {
      target_key: 'project',
      command: 'cat local.txt',
    }))).rejects.toThrow(/command must be a non-empty string array/);
  });

  test('structured target mutations use the same terminal local-effect Work lineage', async () => {
    const controllerHome = temp('forge-target-structured-work-controller-');
    const root = temp('forge-target-structured-work-root-');
    authorizeWorkspaceTargetGrant(controllerHome, {
      targetKey: 'project',
      rootPath: root,
      ownerScope: 'chatgpt-action:principal:test-user',
      access: 'read_write',
      reason: 'structured mutation',
    });

    const requestId = 'target-create-directory-work';
    const submitted = await submitAssistantPluginAction(
      controllerHome,
      controllerPluginRepository(controllerHome),
      {
        pluginId: 'local_system',
        actionId: 'create_directory',
        requestId,
        args: { target_key: 'project', path: 'generated' },
        origin: { surface: 'chatgpt-action', actor: 'principal:test-user' },
      },
    );
    expect(existsSync(join(root, 'generated'))).toBe(true);
    expect(submitted.workId).toBeTruthy();
    expect(getWorkContractByRequestId(controllerHome, requestId, '__controller__')).toMatchObject({
      status: 'completed',
      workKind: 'local_effect',
      completionOutcome: 'completed_local',
    });
  });
});
