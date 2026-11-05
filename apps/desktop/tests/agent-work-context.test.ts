import { describe, expect, test } from 'bun:test';
import { advanceLocalToolProgress, createThread, findExistingWorkThread, selectThreadRepository } from '../src/local-conversation';
import { repositoryLabel } from '../src/runtime-client';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ProjectRecordsView } from '../src/project-records-view';
import { disconnectedProjection } from '../src/runtime-projection';

describe('Forge Desktop Work-bound Agent thread identity', () => {
  test('direct Git commit requires approval and explicit paths before loading Forge source', async () => {
    const script = new URL('../src-tauri/resources/forge-local-tool.mjs', import.meta.url).pathname;
    async function runGitCommit(allowEffects: boolean, paths: string[]) {
      const runner = Bun.spawn([process.execPath, script], { stdin: 'pipe', stdout: 'pipe' });
      runner.stdin.write(JSON.stringify({
        tool: 'git_commit', repoId: 'repo_forge', checkoutId: 'checkout_forge',
        conversationId: 'conv_1', controllerHome: '/does-not-exist', sourceRoot: '/does-not-exist',
        allowEffects, arguments: { message: 'fix: test', paths, request_id: 'effect_1' },
      }));
      runner.stdin.end();
      const output = await new Response(runner.stdout).text();
      expect(await runner.exited).toBe(0);
      return JSON.parse(output);
    }
    expect(await runGitCommit(false, ['src/file.ts'])).toEqual({
      ok: false, error: 'LOCAL_FORGE_TOOL_REQUIRES_USER_APPROVAL',
    });
    expect(await runGitCommit(true, [])).toEqual({
      ok: false, error: 'LOCAL_FORGE_GIT_COMMIT_ARGUMENTS_INVALID',
    });
    expect(await runGitCommit(true, ['../outside'])).toEqual({
      ok: false, error: 'LOCAL_FORGE_GIT_COMMIT_ARGUMENTS_INVALID',
    });
  });

  test('direct Forge runner denies mutations without a pinned checkout before touching source', async () => {
    const script = new URL('../src-tauri/resources/forge-local-tool.mjs', import.meta.url).pathname;
    const runner = Bun.spawn([process.execPath, script], { stdin: 'pipe', stdout: 'pipe' });
    runner.stdin.write(JSON.stringify({
      tool: 'run_command', repoId: 'repo_forge', conversationId: 'conv_1',
      controllerHome: '/does-not-exist', sourceRoot: '/does-not-exist',
      allowEffects: true, arguments: { command: ['git', 'status'] },
    }));
    runner.stdin.end();
    const output = await new Response(runner.stdout).text();
    expect(await runner.exited).toBe(0);
    expect(JSON.parse(output)).toEqual({
      ok: false, error: 'LOCAL_FORGE_EFFECT_CHECKOUT_REQUIRED',
    });
  });

  test('failed project read reports the selected project failure rather than showing stale records', () => {
    const html = renderToStaticMarkup(createElement(ProjectRecordsView, {
      mode: 'works',
      projection: {
        ...disconnectedProjection,
        source: 'runtime',
        runtime: { status: 'degraded', label: '项目详情读取失败', detail: 'yaozhunshi：Forge 返回了错误' },
      },
      onSelectWork() {},
      onNavigateRecord() {},
      async onRefresh() {},
    }));
    expect(html).toContain('yaozhunshi：Forge 返回了错误');
    expect(html).not.toContain('从左侧选择已注册项目');
    expect(html).not.toContain('相同 Requirement 下的其他 Work');
  });

  test('disambiguates misleading registry display names using actual repository identity', () => {
    const design = {
      repoId: 'repo_design', displayName: 'Avela',
      localRoot: '/Users/greyson/DevProjects/repo-harness-design',
    };
    expect(repositoryLabel(design)).toBe('repo-harness-design');
    expect(repositoryLabel({
      repoId: 'repo_avela', displayName: 'Avela Yi Fu Yao',
      localRoot: '/Users/greyson/DevProjects/yaozhunshi',
    })).toBe('yaozhunshi');
    expect(repositoryLabel({
      repoId: 'repo_forge', displayName: 'Forge',
      remoteUrl: 'https://github.com/moretea-labs/forge.git',
    })).toBe('moretea-labs/forge');
    expect(repositoryLabel({ repoId: 'repo_unlocated', displayName: 'Legacy' })).toBe('Legacy');
  });

  test('new threads store only repository/Work/Checkout foreign keys, no semantic duplicates', () => {
    const thread = createThread('api', 'repo_a', 'work_existing_1', 'checkout_a');
    expect(thread.projectRepoId).toBe('repo_a');
    expect(thread.workId).toBe('work_existing_1');
    expect(thread.checkoutId).toBe('checkout_a');
    expect(thread.messages).toEqual([]);
    expect(thread.provider).toBe('api');
    expect('requirement' in thread).toBe(false);
    expect('plan' in thread).toBe(false);
    expect(createThread('api', undefined, 'work_orphan').workId).toBeUndefined();
  });

  test('switching Avela to Forge creates a new Agent identity without rewriting history or resume ID', () => {
    const avela = {
      ...createThread('codex', 'repo_avela', 'work_avela'),
      providerSessionId: 'codex-session-avela',
      messages: [{ id: 'msg1', role: 'user' as const, content: 'build Avela', createdAt: '2026-11-05T00:00:00Z' }],
    };
    const switched = selectThreadRepository(avela, 'codex', 'repo_forge');
    expect(switched.created).toBe(true);
    expect(switched.thread.projectRepoId).toBe('repo_forge');
    expect(switched.thread.messages).toEqual([]);
    expect(switched.thread.workId).toBeUndefined();
    expect(switched.thread.providerSessionId).toBeUndefined();
    expect(switched.thread.id).not.toBe(avela.id);
    expect(avela.projectRepoId).toBe('repo_avela');
    expect(avela.workId).toBe('work_avela');
    expect(avela.providerSessionId).toBe('codex-session-avela');
    expect(avela.messages[0]?.content).toBe('build Avela');
    const bounded = selectThreadRepository(avela, 'codex', 'repo_forge', 'checkout_forge');
    expect(bounded.thread.checkoutId).toBe('checkout_forge');
    expect(avela.checkoutId).toBeUndefined();
  });

  test('switching an unsent draft reuses it but clears old Work binding', () => {
    const empty = createThread('api', 'repo_avela', 'work_avela');
    const switched = selectThreadRepository(empty, 'api', 'repo_forge');
    expect(switched.created).toBe(false);
    expect(switched.thread.id).toBe(empty.id);
    expect(switched.thread.projectRepoId).toBe('repo_forge');
    expect(switched.thread.workId).toBeUndefined();
    expect(empty.projectRepoId).toBe('repo_avela');
    expect(selectThreadRepository(switched.thread, 'api', 'repo_forge').thread).toBe(switched.thread);
    const ghostResume = { ...empty, providerSessionId: 'old-resume' };
    expect(selectThreadRepository(ghostResume, 'api', 'repo_forge').created).toBe(true);
    const pinned = selectThreadRepository(empty, 'api', 'repo_forge', 'checkout_forge');
    expect(pinned.thread.checkoutId).toBe('checkout_forge');
    expect(empty.checkoutId).toBeUndefined();
  });

  test('keeps one truthful tool row per start and terminal receipt, with a bounded timeline', () => {
    const start = { conversationId: 'thread1', name: 'run_command', phase: 'started' as const, requestId: 'effect-123' };
    const finish = { ...start, phase: 'completed' as const };
    const running = advanceLocalToolProgress([], start);
    expect(running).toHaveLength(1);
    expect(running[0]?.phase).toBe('started');
    const completed = advanceLocalToolProgress(running, finish);
    expect(completed).toHaveLength(1);
    expect(completed[0]).toEqual(finish);
    // Another operation's completion is never attributed to this one.
    const different = { ...finish, requestId: 'effect-456' };
    expect(advanceLocalToolProgress(running, different)).toHaveLength(2);
    const recent = Array.from({ length: 15 }, (_, index) => ({
      conversationId: 'thread1', name: 'read_file', phase: 'started' as const,
      requestId: 'r' + index,
    })).reduce(advanceLocalToolProgress, [] as ReturnType<typeof advanceLocalToolProgress>);
    expect(recent).toHaveLength(12);
    expect(recent[0]?.requestId).toBe('r3');
  });

  test('resumes latest active same-project, same-Work and same-provider thread only', () => {
    const older = { ...createThread('api', 'repo_a', 'work_1'), updatedAt: '2026-11-01T00:00:00Z' };
    const current = { ...createThread('api', 'repo_a', 'work_1'), updatedAt: '2026-11-05T00:00:00Z' };
    const otherProject = createThread('api', 'repo_b', 'work_1');
    const otherWork = createThread('api', 'repo_a', 'work_2');
    const otherProvider = createThread('codex', 'repo_a', 'work_1');
    const archived = { ...createThread('api', 'repo_a', 'work_1'), archived: true, updatedAt: '2026-11-06T00:00:00Z' };
    const threads = [older, otherProject, archived, otherWork, current, otherProvider];
    expect(findExistingWorkThread(threads, 'api', 'repo_a', 'work_1')?.id).toBe(current.id);
    const otherCheckout = createThread('api', 'repo_a', 'work_1', 'checkout_2');
    expect(findExistingWorkThread([...threads, otherCheckout], 'api', 'repo_a', 'work_1', 'checkout_2')?.id)
      .toBe(otherCheckout.id);
    expect(findExistingWorkThread([...threads, otherCheckout], 'api', 'repo_a', 'work_1', 'checkout_1'))
      .toBeUndefined();
    expect(findExistingWorkThread(threads, 'codex', 'repo_a', 'work_1')?.id).toBe(otherProvider.id);
    expect(findExistingWorkThread(threads, 'api', 'repo_c', 'work_1')).toBeUndefined();
    expect(findExistingWorkThread(threads, 'api', 'repo_a', 'work_not_registered')).toBeUndefined();
  });
});
