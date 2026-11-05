import { describe, expect, test } from 'bun:test';
import { advanceLocalToolProgress, createThread, findExistingWorkThread } from '../src/local-conversation';

describe('Forge Desktop Work-bound Agent thread identity', () => {
  test('new threads store only repository/Work foreign keys, no semantic duplicates', () => {
    const thread = createThread('api', 'repo_a', 'work_existing_1');
    expect(thread.projectRepoId).toBe('repo_a');
    expect(thread.workId).toBe('work_existing_1');
    expect(thread.messages).toEqual([]);
    expect(thread.provider).toBe('api');
    expect('requirement' in thread).toBe(false);
    expect('plan' in thread).toBe(false);
    expect(createThread('api', undefined, 'work_orphan').workId).toBeUndefined();
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
    expect(findExistingWorkThread(threads, 'codex', 'repo_a', 'work_1')?.id).toBe(otherProvider.id);
    expect(findExistingWorkThread(threads, 'api', 'repo_c', 'work_1')).toBeUndefined();
    expect(findExistingWorkThread(threads, 'api', 'repo_a', 'work_not_registered')).toBeUndefined();
  });
});
