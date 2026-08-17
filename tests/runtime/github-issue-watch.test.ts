import { describe, expect, test } from 'bun:test';
import {
  classifyGithubIssueWatchObservation,
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

describe('github issue watch', () => {
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
