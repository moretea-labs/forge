import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { spawnSync } from 'child_process';
import { resolveCliChildInvocation } from '../../src/cli/runtime-invocation';
import { resolveDiagnosticCliInvocation, runReadOnlyDiagnosticViaProcessRuntime } from '../../src/runtime/diagnostics/process-facade';
import { ensureControllerHome } from '../../src/cli/repositories/controller-home';
import { registerRepository } from '../../src/cli/repositories/registry';
import { resolvePersistedCheckCliInvocation } from '../../src/runtime/gateway/mcp/persisted-check-process';

const diagnosticArgs = ['runtime', 'diagnostic-read', '--tool', 'workflow_watchdog_report'];

describe('typed CLI child invocation', () => {
  test('executes a Bun standalone release directly without its virtual bunfs entry', () => {
    const expected = {
      executable: '/opt/releases/repo-harness.js',
      args: diagnosticArgs,
    };
    expect(resolveCliChildInvocation('/$bunfs/root/repo-harness.js', diagnosticArgs, {
      runtimeExecutable: '/opt/releases/repo-harness.js',
      env: {},
    })).toEqual(expected);
    expect(resolveDiagnosticCliInvocation('/$bunfs/root/repo-harness.js', diagnosticArgs, {
      runtimeExecutable: '/opt/releases/repo-harness.js',
      env: {},
    })).toEqual(expected);
    expect(resolvePersistedCheckCliInvocation('/$bunfs/root/repo-harness.js', diagnosticArgs, {
      runtimeExecutable: '/opt/releases/repo-harness.js',
      env: {},
    })).toEqual(expected);
    expect(expected.args).not.toContain('/$bunfs/root/repo-harness.js');
  });

  test('honors explicit standalone runtime identity even when argv entry is physical', () => {
    expect(resolveDiagnosticCliInvocation('/opt/releases/repo-harness.js', diagnosticArgs, {
      runtimeExecutable: '/opt/releases/repo-harness.js',
      env: { REPO_HARNESS_RUNTIME_EXECUTION: 'standalone-binary' },
    })).toEqual({
      executable: '/opt/releases/repo-harness.js',
      args: diagnosticArgs,
    });
  });

  test('passes source entries to Bun and Node runtimes', () => {
    expect(resolveDiagnosticCliInvocation('/repo/src/cli/index.ts', diagnosticArgs, {
      runtimeExecutable: '/opt/bun/bin/bun',
      env: {},
    })).toEqual({
      executable: '/opt/bun/bin/bun',
      args: ['/repo/src/cli/index.ts', ...diagnosticArgs],
    });
    expect(resolveDiagnosticCliInvocation('/repo/bin/repo-harness.mjs', diagnosticArgs, {
      runtimeExecutable: '/usr/bin/node',
      env: {},
    })).toEqual({
      executable: '/usr/bin/node',
      args: ['/repo/bin/repo-harness.mjs', ...diagnosticArgs],
    });
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

});
