import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  classifyGithubIssueWatchObservation,
  resolveGithubIssueWatchExecutable,
  type GithubIssueWatchIssue,
  type GithubIssueWatchState,
} from '../../src/runtime/workflow/schedules/github-issue-watch';

const issue = (number: number, state: 'open' | 'closed', updatedAt: string): GithubIssueWatchIssue => ({
  number,
  state,
  updatedAt,
  title: `Issue ${number}`,
  url: `https://github.com/moretea-labs/forge/issues/${number}`,
});

const tempRoots: string[] = [];
afterEach(() => {
  while (tempRoots.length) rmSync(tempRoots.pop()!, { recursive: true, force: true });
});

function executableFixture(name = 'gh'): string {
  const root = mkdtempSync(join(tmpdir(), 'forge-gh-watch-'));
  tempRoots.push(root);
  const executable = join(root, name);
  writeFileSync(executable, '#!/bin/sh\nexit 0\n');
  chmodSync(executable, 0o755);
  return executable;
}

describe('github issue watch', () => {
  test('resolves an explicit absolute gh executable and rejects invalid configured overrides', () => {
    const executable = executableFixture();
    expect(resolveGithubIssueWatchExecutable({ gh_executable: executable }, { PATH: '' }, [])).toBe(executable);
    expect(() => resolveGithubIssueWatchExecutable({ gh_executable: 'gh' }, { PATH: '' }, []))
      .toThrow('SCHEDULE_GITHUB_ISSUE_WATCH_GH_EXECUTABLE_INVALID');
    expect(() => resolveGithubIssueWatchExecutable({ gh_executable: join(executable, 'missing') }, { PATH: '' }, []))
      .toThrow('SCHEDULE_GITHUB_ISSUE_WATCH_GH_EXECUTABLE_INVALID');
  });

  test('uses fixed trusted candidates before PATH and reports a stable not-found error', () => {
    const preferred = executableFixture('preferred-gh');
    const pathGh = executableFixture('gh');
    expect(resolveGithubIssueWatchExecutable({}, { PATH: join(pathGh, '..') }, [preferred])).toBe(preferred);
    expect(() => resolveGithubIssueWatchExecutable({}, { PATH: '' }, []))
      .toThrow('SCHEDULE_GITHUB_ISSUE_WATCH_GH_EXECUTABLE_NOT_FOUND');
  });

  test('honors FORGE_GH_EXECUTABLE as an absolute trusted override', () => {
    const executable = executableFixture();
    expect(resolveGithubIssueWatchExecutable({}, { FORGE_GH_EXECUTABLE: executable, PATH: '' }, [])).toBe(executable);
  });

  test('first observation establishes a baseline when no since cursor is configured', () => {
    const observed = classifyGithubIssueWatchObservation([
      issue(10, 'open', '2026-08-17T10:00:00Z'),
      issue(9, 'closed', '2026-08-17T09:00:00Z'),
    ], undefined, { observedAt: '2026-08-17T10:01:00Z' });
    expect(observed.status).toBe('baseline');
    expect(observed.shouldWake).toBe(false);
    expect(observed.changedOpenIssues).toEqual([]);
    expect(observed.nextState.signatures['10']).toBe('open:2026-08-17T10:00:00Z');
  });

  test('initial since cursor triggers only newer open issues and ignores closed changes', () => {
    const observed = classifyGithubIssueWatchObservation([
      issue(12, 'open', '2026-08-17T10:05:00Z'),
      issue(11, 'closed', '2026-08-17T10:04:00Z'),
      issue(10, 'open', '2026-08-17T09:59:00Z'),
    ], undefined, { since: '2026-08-17T10:00:00Z' });
    expect(observed.shouldWake).toBe(true);
    expect(observed.changedOpenIssues.map((entry) => entry.number)).toEqual([12]);
  });

  test('unchanged state is deduplicated while reopen and updated open issues retrigger', () => {
    const previous: GithubIssueWatchState = {
      schemaVersion: 1,
      observedAt: '2026-08-17T10:00:00Z',
      signatures: {
        '20': 'open:2026-08-17T09:55:00Z',
        '19': 'closed:2026-08-17T09:50:00Z',
        '18': 'open:2026-08-17T09:45:00Z',
      },
    };
    const observed = classifyGithubIssueWatchObservation([
      issue(20, 'open', '2026-08-17T09:55:00Z'),
      issue(19, 'open', '2026-08-17T10:02:00Z'),
      issue(18, 'open', '2026-08-17T10:03:00Z'),
    ], previous);
    expect(observed.status).toBe('changed');
    expect(observed.shouldWake).toBe(true);
    expect(observed.changedOpenIssues.map((entry) => entry.number)).toEqual([19, 18]);
  });
});
