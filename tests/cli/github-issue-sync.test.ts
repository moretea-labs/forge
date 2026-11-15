import { describe, expect, test } from 'bun:test';
import { createHash } from 'crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { spawnSync } from 'child_process';
import { tmpdir } from 'os';
import { delimiter, join } from 'path';
import { createIssue, getIssue } from '../../src/cli/controller/issue-store';
import { registerRepository } from '../../src/runtime/repositories/registry';
import { loadGitHubPluginConfig, saveGitHubPluginConfig } from '../../src/runtime/plugins/github-config';

describe('GitHub Issue publication retry safety', () => {
  test('persists parent and task links before Project attachment and reuses them after failures', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'forge-github-issue-sync-'));
    const repoRoot = join(workspace, 'repo');
    const controllerHome = join(workspace, 'controller-home');
    const binRoot = join(workspace, 'bin');
    const logPath = join(workspace, 'gh.log');
    const originalPath = process.env.PATH;
    const originalControllerHome = process.env.FORGE_CONTROLLER_HOME;
    const originalGhLog = process.env.GH_TEST_LOG;

    try {
      mkdirSync(repoRoot, { recursive: true });
      mkdirSync(controllerHome, { recursive: true });
      mkdirSync(binRoot, { recursive: true });
      const initialized = spawnSync('git', ['init', '-b', 'main'], { cwd: repoRoot, encoding: 'utf8' });
      expect(initialized.status).toBe(0);

      process.env.FORGE_CONTROLLER_HOME = controllerHome;
      const repository = registerRepository({ path: repoRoot, controllerHome, defaultBranch: 'main' });
      const canonicalRoot = repository.canonicalRoot;
      process.env.PATH = [binRoot, originalPath ?? ''].filter(Boolean).join(delimiter);
      process.env.GH_TEST_LOG = logPath;

      const sidecarEntry = join(process.cwd(), 'src', 'cli', 'github', 'plugin-action-sidecar.ts');
      const compiledSidecarPath = join(workspace, 'forge-plugin-action-sidecar');
      const compile = spawnSync(process.execPath, ['build', sidecarEntry, '--compile', '--outfile', compiledSidecarPath], {
        cwd: process.cwd(),
        encoding: 'utf8',
        timeout: 120_000,
        maxBuffer: 16 * 1024 * 1024,
      });
      if (compile.status !== 0) throw new Error(`plugin action sidecar compile failed: ${compile.stderr}${compile.stdout}`);
      expect(existsSync(compiledSidecarPath)).toBe(true);

      let actionSequence = 0;
      const runSidecarAction = (actionId: string, args: Record<string, unknown>, confirmAuthorization = false, confirmationText?: string) => {
        const requestId = `github-issue-sync-${actionId}-${++actionSequence}`;
        const requestPath = join(workspace, `${requestId}.json`);
        const requestBytes = JSON.stringify({
          schemaVersion: 1,
          controllerHome,
          repoId: repository.repoId,
          request: { pluginId: 'github', actionId, requestId, args, origin: { surface: 'mcp' }, confirmAuthorization, confirmationText },
        });
        writeFileSync(requestPath, requestBytes, 'utf8');
        const expectedSha256 = createHash('sha256').update(requestBytes).digest('hex');
        const result = spawnSync(compiledSidecarPath, ['--request', requestPath, '--expected-sha256', expectedSha256], {
          cwd: process.cwd(),
          encoding: 'utf8',
          env: process.env,
          timeout: 30_000,
        });
        expect(existsSync(requestPath)).toBe(false);
        if (result.status !== 0) throw new Error(`${result.stderr}${result.stdout}`.trim());
        return JSON.parse(result.stdout.trim()) as { ok: boolean; requestId: string; receiptId: string; deduplicated: boolean };
      };

      const fakeGh = join(binRoot, 'gh');
      writeFileSync(fakeGh, `#!/bin/sh
set -eu
printf '%s\n' "$*" >> "$GH_TEST_LOG"
if [ "$1" = "repo" ] && [ "$2" = "view" ]; then
  printf '%s\n' '{"nameWithOwner":"owner/repo","url":"https://github.com/owner/repo","defaultBranchRef":{"name":"main"}}'
  exit 0
fi
if [ "$1" = "issue" ] && [ "$2" = "create" ]; then
  count=$(grep -c '^issue create ' "$GH_TEST_LOG" || true)
  printf 'https://github.com/owner/repo/issues/%s\n' "$count"
  exit 0
fi
if [ "$1" = "issue" ] && [ "$2" = "edit" ]; then
  exit 0
fi
if [ "$1" = "issue" ] && [ "$2" = "view" ]; then
  printf '{"number":1,"title":"Refreshed title","state":"CLOSED","url":"https://github.com/owner/repo/issues/1?refreshed","labels":[],"assignees":[],"projectItems":[],"updatedAt":"2026-11-15T02:00:00Z"}\n'
  exit 0
fi
if [ "$1" = "issue" ] && [ "$2" = "close" ]; then
  exit 0
fi
if [ "$1" = "project" ] && [ "$2" = "item-add" ]; then
  count=$(grep -c '^project item-add ' "$GH_TEST_LOG" || true)
  case "$count" in
    1|3) printf 'simulated project attachment failure %s\n' "$count" >&2; exit 1 ;;
  esac
  printf '{"id":"PVTI_%s"}\n' "$count"
  exit 0
fi
printf 'unexpected gh command: %s\n' "$*" >&2
exit 2
`);
      chmodSync(fakeGh, 0o755);

      saveGitHubPluginConfig(canonicalRoot, {
        enabled: true,
        repository: 'owner/repo',
        projectOwner: 'owner',
        projectNumber: 42,
        includeTasks: true,
      });
      const issue = createIssue(canonicalRoot, {
        title: 'Retry-safe GitHub publication',
        kind: 'feature',
        tasks: [{ title: 'Child task', objective: 'Verify the child Issue link survives Project sync failure.' }],
      });

      const publish = () => runSidecarAction('publish_issue', { issue_id: issue.id });

      expect(() => publish()).toThrow('simulated project attachment failure 1');
      const afterParentFailure = getIssue(canonicalRoot, issue.id);
      expect(afterParentFailure.github).toMatchObject({
        number: 1,
        url: 'https://github.com/owner/repo/issues/1',
      });
      expect(afterParentFailure.tasks[0]?.github).toBeUndefined();

      expect(() => publish()).toThrow('simulated project attachment failure 3');
      const afterTaskFailure = getIssue(canonicalRoot, issue.id);
      expect(afterTaskFailure.github?.number).toBe(1);
      expect(afterTaskFailure.tasks[0]?.github).toMatchObject({
        number: 2,
        url: 'https://github.com/owner/repo/issues/2',
      });

      expect(publish().ok).toBe(true);
      const completed = getIssue(canonicalRoot, issue.id);
      expect(completed.github).toMatchObject({ number: 1, projectItemId: 'PVTI_4' });
      expect(completed.tasks[0]?.github).toMatchObject({ number: 2, projectItemId: 'PVTI_5' });

      const refreshed = runSidecarAction('refresh_issue', { issue_id: issue.id });
      expect(refreshed.ok).toBe(true);
      const afterRefresh = getIssue(canonicalRoot, issue.id);
      expect(afterRefresh.github?.url).toBe('https://github.com/owner/repo/issues/1?refreshed');
      expect(afterRefresh.github?.syncedAt).toBeTruthy();

      const closed = runSidecarAction('close_issue', { issue_id: issue.id }, true, 'close-github-issue');
      expect(closed.ok).toBe(true);
      expect(readFileSync(logPath, 'utf8')).toContain('issue close 1 --repo owner/repo');

      const disabled = runSidecarAction('configure', { enabled: false });
      expect(disabled.ok).toBe(true);
      expect(loadGitHubPluginConfig(canonicalRoot).enabled).toBe(false);
      const issueViewCount = readFileSync(logPath, 'utf8').trim().split(/\r?\n/).filter((line) => line.startsWith('issue view ')).length;
      expect(() => runSidecarAction('refresh_issue', { issue_id: issue.id })).toThrow(/PLUGIN_DISABLED|GitHub plugin is disabled/);

      const commands = readFileSync(logPath, 'utf8').trim().split(/\r?\n/);
      expect(commands.filter((line) => line.startsWith('issue create '))).toHaveLength(2);
      expect(commands.filter((line) => line.startsWith('issue edit '))).toHaveLength(3);
      expect(commands.filter((line) => line.startsWith('project item-add '))).toHaveLength(5);
      expect(commands.filter((line) => line.startsWith('issue close '))).toHaveLength(1);
      expect(commands.filter((line) => line.startsWith('issue view '))).toHaveLength(issueViewCount);
    } finally {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
      if (originalControllerHome === undefined) delete process.env.FORGE_CONTROLLER_HOME;
      else process.env.FORGE_CONTROLLER_HOME = originalControllerHome;
      if (originalGhLog === undefined) delete process.env.GH_TEST_LOG;
      else process.env.GH_TEST_LOG = originalGhLog;
      rmSync(workspace, { recursive: true, force: true });
    }
  }, 30_000);
});
