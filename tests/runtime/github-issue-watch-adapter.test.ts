import { describe, expect, test } from 'bun:test';
import { createHash } from 'crypto';
import { normalizeGithubIssueWatchObservation } from '../../src/runtime/events/adapters/github-issue-watch';

const issue = {
  number: 718,
  title: 'Unify event-driven architecture',
  state: 'open' as const,
  updatedAt: '2026-11-25T10:00:00Z',
  url: 'https://github.com/moretea-labs/forge/issues/718',
};

const observation = {
  repository: 'moretea-labs/forge',
  scheduleId: 'schedule-github-issue-watch',
  occurrenceId: 'occurrence-2026-11-25-1000',
  changedOpenIssues: [issue],
};

const context = { receivedAt: '2026-11-25T10:01:00Z' };

describe('GitHub Issue Watch Event Source Adapter', () => {
  test('maps changed open issues into scoped, occurrence-correlated Event Envelopes', () => {
    const [envelope] = normalizeGithubIssueWatchObservation(observation, context);
    const payload = {
      repository: observation.repository,
      issue,
    };
    const canonicalPayload = JSON.stringify(payload);
    expect(envelope).toMatchObject({
      schemaVersion: 1,
      eventId: 'github-issue:moretea-labs/forge#718@2026-11-25T10:00:00Z',
      source: 'github.issue_watch',
      provider: 'github',
      eventType: 'github.issue.open_changed',
      occurredAt: issue.updatedAt,
      receivedAt: context.receivedAt,
      scope: { kind: 'repository', id: observation.repository },
      subject: { kind: 'github.issue', id: '718' },
      correlationId: observation.occurrenceId,
      causationId: observation.scheduleId,
      idempotencyKey: createHash('sha256').update('moretea-labs/forge#718@2026-11-25T10:00:00Z').digest('hex'),
      payloadRef: {
        store: 'forge',
        key: 'forge://schedule-decisions/DEC-occurrence-2026-11-25-1000/github-issues/718',
        mediaType: 'application/json',
        schemaVersion: 1,
        digest: {
          algorithm: 'sha256',
          value: createHash('sha256').update(canonicalPayload).digest('hex'),
          bytes: Buffer.byteLength(canonicalPayload, 'utf8'),
        },
      },
    });
    expect(envelope).not.toHaveProperty('payload');
  });

  test('keeps event identity stable across observation retries and isolates each issue update', () => {
    const first = normalizeGithubIssueWatchObservation(observation, context);
    const replay = normalizeGithubIssueWatchObservation(observation, context);
    const updated = normalizeGithubIssueWatchObservation(
      {
        ...observation,
        changedOpenIssues: [{ ...issue, updatedAt: '2026-11-25T10:05:00Z' }],
      },
      context,
    );
    expect(replay).toEqual(first);
    expect(updated[0]?.eventId).not.toBe(first[0]?.eventId);
    expect(updated[0]?.idempotencyKey).not.toBe(first[0]?.idempotencyKey);
  });

  test('rejects malformed repository, schedule identity and issue source data', () => {
    expect(() => normalizeGithubIssueWatchObservation({ ...observation, repository: '../other' }, context)).toThrow(
      'GITHUB_ISSUE_WATCH_EVENT_OBSERVATION_INVALID',
    );
    expect(() =>
      normalizeGithubIssueWatchObservation(
        { ...observation, changedOpenIssues: [{ ...issue, state: 'closed' as 'open' }] },
        context,
      ),
    ).toThrow('GITHUB_ISSUE_WATCH_EVENT_ISSUE_INVALID');
    expect(() =>
      normalizeGithubIssueWatchObservation(
        { ...observation, changedOpenIssues: [{ ...issue, url: 'https://github.com/other/repo/issues/718' }] },
        context,
      ),
    ).toThrow('GITHUB_ISSUE_WATCH_EVENT_ISSUE_INVALID');
  });
});
