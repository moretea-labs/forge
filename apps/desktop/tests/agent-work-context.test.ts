import { describe, expect, test } from 'bun:test';
import { createThread, findExistingWorkThread } from '../src/local-conversation';

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
