import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { spawnSync } from 'child_process';
import {
  CliRuntimeResolutionError,
  currentCliRuntimeTarget,
  resolveCliChildInvocation,
} from '../../src/cli/runtime-invocation';
import { resolveDiagnosticCliInvocation, runReadOnlyDiagnosticViaProcessRuntime } from '../../src/runtime/diagnostics/process-facade';
import { ensureControllerHome } from '../../src/cli/repositories/controller-home';
import { registerRepository } from '../../src/cli/repositories/registry';
import {
  resolvePersistedCheckCliInvocation,
  resolvePersistedCheckProcessInvocation,
  resolvePersistedCheckRuntimeExecutable,
} from '../../src/runtime/gateway/mcp/persisted-check-process';

const diagnosticArgs = ['runtime', 'diagnostic-read', '--tool', 'workflow_watchdog_report'];

describe('typed CLI child invocation', () => {
  test('executes a Bun standalone release directly without its virtual bunfs entry', () => {
    const expected = {
      executable: '/opt/releases/forge.js',
      args: diagnosticArgs,
    };
    expect(resolveCliChildInvocation('/$bunfs/root/forge.js', diagnosticArgs, {
      runtimeExecutable: '/opt/releases/forge.js',
      env: {},
    })).toEqual(expected);
    expect(resolveDiagnosticCliInvocation('/$bunfs/root/forge.js', diagnosticArgs, {
      runtimeExecutable: '/opt/releases/forge.js',
      env: {},
    })).toEqual(expected);
    expect(resolvePersistedCheckCliInvocation('/$bunfs/root/forge.js', diagnosticArgs, {
      runtimeExecutable: '/opt/releases/forge.js',
      env: {},
    })).toEqual(expected);
    expect(expected.args).not.toContain('/$bunfs/root/forge.js');
  });

  test('honors explicit standalone runtime identity even when argv entry is physical', () => {
    expect(resolveDiagnosticCliInvocation('/opt/releases/forge.js', diagnosticArgs, {
      runtimeExecutable: '/opt/releases/forge.js',
      env: { FORGE_RUNTIME_EXECUTION: 'standalone-binary' },
    })).toEqual({
      executable: '/opt/releases/forge.js',
      args: diagnosticArgs,
    });
  });

  test('persisted checks use a dedicated immutable check runner instead of the Runtime daemon or diagnostic CLI', () => {
    const cliTarget = {
      entry: '/opt/releases/release-123/forge-runtime',
      cwd: '/opt/releases/release-123',
      runtimeKind: 'compiled_bun_release' as const,
      sourceRevision: 'release-123',
      immutable: true,
      explanation: 'fixture',
    };
    const executable = resolvePersistedCheckRuntimeExecutable(
      cliTarget,
      '/opt/releases/release-123/forge-runtime',
      (path) => path === '/opt/releases/release-123/forge-check-runner',
    );
    expect(executable).toBe('/opt/releases/release-123/forge-check-runner');
    expect(resolvePersistedCheckProcessInvocation(cliTarget, diagnosticArgs, {
      runtimeExecutable: '/opt/releases/release-123/forge-runtime',
      entryExists: (path) => path === '/opt/releases/release-123/forge-check-runner',
    })).toEqual({ executable, args: diagnosticArgs });
  });

  test('passes source entries to Bun and Node runtimes', () => {
    expect(resolveDiagnosticCliInvocation('/repo/src/cli/index.ts', diagnosticArgs, {
      runtimeExecutable: '/opt/bun/bin/bun',
      env: {},
    })).toEqual({
      executable: '/opt/bun/bin/bun',
      args: ['/repo/src/cli/index.ts', ...diagnosticArgs],
    });
    expect(resolveDiagnosticCliInvocation('/repo/bin/forge.mjs', diagnosticArgs, {
      runtimeExecutable: '/usr/bin/node',
      env: {},
    })).toEqual({
      executable: '/usr/bin/node',
      args: ['/repo/bin/forge.mjs', ...diagnosticArgs],
    });
  });

  test('returns typed runtime identity and source revision in source and compiled modes', () => {
    const compiled = resolveCliChildInvocation('/$bunfs/root/forge.js', diagnosticArgs, {
      runtimeExecutable: '/Applications/Forge Runtime/forge',
      sourceRevision: 'release-abc',
      env: {},
    });
    expect(compiled.argv).toEqual(diagnosticArgs);
    expect(compiled.runtimeKind).toBe('compiled_bun_release');
    expect(compiled.sourceRevision).toBe('release-abc');
    expect(compiled.immutable).toBe(true);
    expect(compiled.diagnostic).toContain('immutable compiled release');

    const node = resolveCliChildInvocation('/repo with spaces/src/cli/index.ts', diagnosticArgs, {
      runtimeExecutable: '/usr/local/bin/node',
      sourceRevision: 'source-def',
      env: {},
    });
    expect(node.argv).toEqual(['/repo with spaces/src/cli/index.ts', ...diagnosticArgs]);
    expect(node.runtimeKind).toBe('node_source');
    expect(node.sourceRevision).toBe('source-def');
    expect(node.immutable).toBe(false);
  });

  test('uses explicit package launcher identity for shims and paths containing spaces', () => {
    const launcher = '/Applications/Forge Runtime/bin/forge shim';
    const invocation = resolveCliChildInvocation('/ignored', diagnosticArgs, {
      runtimeExecutable: '/Applications/Node Runtime/bin/node',
      runtimeKind: 'package_launcher',
      launcherEntry: launcher,
      sourceRevision: 'global-package-1',
      env: {},
    });
    expect(invocation.executable).toBe('/Applications/Node Runtime/bin/node');
    expect(invocation.args).toEqual([launcher, ...diagnosticArgs]);
    expect(invocation.runtimeKind).toBe('package_launcher');
    expect(invocation.sourceRevision).toBe('global-package-1');
  });

  test('locates explicit source, compiled release, and package targets without extension guessing', () => {
    const existing = new Set([
      '/repo with spaces/src/cli/index.ts',
      '/Applications/Forge Runtime/lib/forge.js',
    ]);
    const source = currentCliRuntimeTarget({
      argv: [],
      env: {},
      sourceRoot: '/repo with spaces',
      runtimeExecutable: '/usr/bin/node',
      sourceRevision: 'source-1',
      entryExists: (path) => existing.has(path),
    });
    expect(source.runtimeKind).toBe('node_source');
    expect(source.entry).toBe('/repo with spaces/src/cli/index.ts');

    const immutableRoot = currentCliRuntimeTarget({
      argv: [],
      env: {},
      sourceRoot: '/controller/runtime/releases/release-1',
      runtimeExecutable: '/controller/runtime/releases/release-1/forge-runtime',
      sourceRevision: 'release-1',
      entryExists: (path) => path === '/controller/runtime/releases/release-1/forge-cli',
    });
    expect(immutableRoot).toMatchObject({
      entry: '/controller/runtime/releases/release-1/forge-cli',
      cwd: '/controller/runtime/releases/release-1',
      runtimeKind: 'compiled_bun_release',
      immutable: true,
    });
    expect(() => currentCliRuntimeTarget({
      argv: [],
      env: {},
      sourceRoot: '/controller/runtime/releases/legacy-release',
      runtimeExecutable: '/controller/runtime/releases/legacy-release/forge-runtime',
      sourceRevision: 'legacy-release',
      entryExists: (path) => path === '/controller/runtime/releases/legacy-release/forge-runtime',
    })).toThrow(/missing forge-cli diagnostic sidecar/);

    const compiled = currentCliRuntimeTarget({
      argv: ['/Applications/Forge Runtime/forge', '/$bunfs/root/forge.js'],
      env: { FORGE_RUNTIME_EXECUTION: 'standalone-binary' },
      runtimeExecutable: '/Applications/Forge Runtime/forge',
      sourceRevision: 'compiled-1',
      entryExists: () => false,
    });
    expect(compiled.runtimeKind).toBe('compiled_bun_release');
    expect(compiled.immutable).toBe(true);

    const installed = currentCliRuntimeTarget({
      argv: [],
      env: {},
      moduleUrl: 'file:///Applications/Forge%20Runtime/lib/diagnostics.js',
      runtimeExecutable: '/usr/bin/node',
      sourceRevision: 'package-1',
      entryExists: (path) => existing.has(path),
    });
    expect(installed.runtimeKind).toBe('package_launcher');
    expect(installed.entry).toBe('/Applications/Forge Runtime/lib/forge.js');
  });

  test('fails closed when runtime identity cannot be resolved', () => {
    expect(() => resolveCliChildInvocation('/opaque/entry', diagnosticArgs, {
      runtimeExecutable: '/opt/custom/runner',
      env: {},
    })).toThrow(CliRuntimeResolutionError);
    expect(() => currentCliRuntimeTarget({
      argv: [],
      env: {},
      runtimeExecutable: '/opt/custom/runner',
      entryExists: () => false,
    })).toThrow('CLI_RUNTIME_UNRESOLVED');
  });

  test('reports a completed nonzero diagnostic process as failed rather than running', async () => {
    const root = mkdtempSync(join(tmpdir(), 'diagnostic-process-failure-'));
    try {
      const controllerHome = join(root, 'controller');
      const repoRoot = join(root, 'repo');
      mkdirSync(controllerHome, { recursive: true });
      mkdirSync(repoRoot, { recursive: true });
      const git = (args: string[]) => {
        const result = spawnSync('git', ['-C', repoRoot, ...args], { encoding: 'utf8' });
        if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(' ')} failed`);
      };
      git(['init', '-b', 'main']);
      git(['config', 'user.name', 'Test']);
      git(['config', 'user.email', 'test@example.com']);
      writeFileSync(join(repoRoot, 'README.md'), 'fixture\n');
      git(['add', '.']);
      git(['commit', '-m', 'init']);
      ensureControllerHome(controllerHome);
      const repository = registerRepository({ path: repoRoot, controllerHome, displayName: 'diagnostic-failure' });
      const failingEntry = join(root, 'index.ts');
      writeFileSync(failingEntry, "console.error('intentional diagnostic failure'); process.exit(23);\n");

      const result = await runReadOnlyDiagnosticViaProcessRuntime({
        controllerHome,
        repository,
        tool: 'workflow_watchdog_report',
        args: {
          request_id: 'diagnostic-failure-terminal',
          interactive_wait_ms: 10_000,
          execution_timeout_ms: 20_000,
        },
        cliInvocation: {
          entry: failingEntry,
          options: { runtimeExecutable: process.execPath, env: {} },
        },
      });

      expect(result.accepted).toBe(false);
      expect((result.error as { code?: string }).code).toBe('DIAGNOSTIC_PROCESS_FAILED');
      expect((result.process as { completed?: boolean }).completed).toBe(true);
      expect((result.process as { status?: string }).status).toBe('failed');
      expect((result.process as { contractStatus?: string }).contractStatus).toBe('failed');
      expect((result.process as { exitCode?: number }).exitCode).toBe(23);
      expect(JSON.stringify(result)).not.toContain('"status":"running"');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('records unresolved runtime launch as a truthful terminal Process failure', async () => {
    const root = mkdtempSync(join(tmpdir(), 'diagnostic-runtime-unresolved-'));
    try {
      const controllerHome = join(root, 'controller');
      const repoRoot = join(root, 'repo');
      mkdirSync(controllerHome, { recursive: true });
      mkdirSync(repoRoot, { recursive: true });
      const git = (args: string[]) => {
        const result = spawnSync('git', ['-C', repoRoot, ...args], { encoding: 'utf8' });
        if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(' ')} failed`);
      };
      git(['init', '-b', 'main']);
      git(['config', 'user.name', 'Test']);
      git(['config', 'user.email', 'test@example.com']);
      writeFileSync(join(repoRoot, 'README.md'), 'fixture\n');
      git(['add', '.']);
      git(['commit', '-m', 'init']);
      ensureControllerHome(controllerHome);
      const repository = registerRepository({ path: repoRoot, controllerHome, displayName: 'runtime-unresolved' });

      const result = await runReadOnlyDiagnosticViaProcessRuntime({
        controllerHome,
        repository,
        tool: 'workflow_watchdog_report',
        args: {
          request_id: 'diagnostic-runtime-unresolved-terminal',
          interactive_wait_ms: 20_000,
          execution_timeout_ms: 20_000,
        },
        cliInvocation: {
          entry: '/opaque/entry',
          options: { runtimeExecutable: '/opt/custom/runner', env: {} },
        },
      });

      expect(result.accepted).toBe(false);
      expect((result.error as { code?: string }).code).toBe('DIAGNOSTIC_RUNTIME_UNRESOLVED');
      expect((result.process as { completed?: boolean }).completed).toBe(true);
      expect((result.process as { status?: string }).status).toBe('failed');
      expect((result.diagnosticRuntime as { explanation?: string }).explanation).toContain('CLI_RUNTIME_UNRESOLVED');
      expect(JSON.stringify(result)).not.toContain('"status":"running"');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

});
