import { afterEach, describe, expect, test } from 'bun:test';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
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
  workspaceTargetGrantStorePath,
} from '../../src/runtime/workspace-targets';
import {
  executeLocalSystemPluginAction,
  resetLocalSystemPluginHooksForTest,
  setLocalSystemPluginHooksForTest,
} from '../../src/runtime/plugins/local-system-adapter';
import type { AssistantPluginActionExecutionInput } from '../../src/runtime/plugins/types';

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

describe('workspace target grant authority', () => {
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
    expect(target.rootPath).toBe(resolve(root));
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
    }).path).toBe(resolve(root, 'src/index.ts'));
    expect(resolveWorkspaceTargetCwd(
      controllerHome,
      'workspace',
      'principal:test',
      'src',
      'read',
    ).path).toBe(resolve(root, 'src'));
    expect(resolveWorkspaceTargetPath(controllerHome, 'workspace', 'generated/out.txt', {
      ownerScope: 'principal:test',
      operation: 'write',
    }).path).toBe(resolve(root, 'generated/out.txt'));
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
      .toBe(resolve(root));
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
});
