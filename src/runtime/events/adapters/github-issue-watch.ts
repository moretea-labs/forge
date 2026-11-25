import { createHash } from 'crypto';
import { createEventEnvelope, type EventSourceAdapter, type EventEnvelopeV1 } from '../../../../packages/kernel/events';
import type { GithubIssueWatchIssue } from '../../workflow/schedules/github-issue-watch';

export interface GithubIssueWatchEventObservation {
  repository: string;
  scheduleId: string;
  occurrenceId: string;
  changedOpenIssues: readonly GithubIssueWatchIssue[];
}

export interface GithubIssueWatchEventPayload {
  repository: string;
  issue: {
    number: number;
    title: string;
    state: 'open';
    updatedAt: string;
    url: string;
  };
}

const descriptor = Object.freeze({
  source: 'github.issue_watch',
  provider: 'github',
  eventTypes: Object.freeze(['github.issue.open_changed']),
});

function isGithubRepository(value: string): boolean {
  const segments = value.split('/');
  return (
    segments.length === 2 &&
    segments.every((segment) => /^[A-Za-z0-9_.-]+$/.test(segment) && segment !== '.' && segment !== '..')
  );
}
const identityPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export function githubIssueWatchEventPayload(
  repository: string,
  issue: GithubIssueWatchIssue,
): GithubIssueWatchEventPayload {
  return {
    repository,
    issue: {
      number: issue.number,
      title: issue.title,
      state: 'open',
      updatedAt: issue.updatedAt,
      url: issue.url,
    },
  };
}

export const githubIssueWatchEventAdapter: EventSourceAdapter<GithubIssueWatchEventObservation> = {
  descriptor,
  normalize(observation, context): readonly EventEnvelopeV1[] {
    if (
      !observation ||
      !isGithubRepository(observation.repository) ||
      !identityPattern.test(observation.scheduleId) ||
      !identityPattern.test(observation.occurrenceId) ||
      !Array.isArray(observation.changedOpenIssues)
    ) {
      throw new Error('GITHUB_ISSUE_WATCH_EVENT_OBSERVATION_INVALID');
    }

    return observation.changedOpenIssues.map((issue) => {
      if (
        !Number.isSafeInteger(issue.number) ||
        issue.number < 1 ||
        issue.state !== 'open' ||
        !issue.title ||
        !issue.updatedAt ||
        !Number.isFinite(Date.parse(issue.updatedAt)) ||
        issue.url !== `https://github.com/${observation.repository}/issues/${issue.number}`
      ) {
        throw new Error('GITHUB_ISSUE_WATCH_EVENT_ISSUE_INVALID');
      }
      const payload = githubIssueWatchEventPayload(observation.repository, issue);
      const canonicalPayload = JSON.stringify(payload);
      const identity = `${observation.repository}#${issue.number}@${issue.updatedAt}`;
      const eventId = `github-issue:${identity}`;
      const idempotencyKey = createHash('sha256').update(identity).digest('hex');
      return createEventEnvelope({
        eventId,
        source: descriptor.source,
        provider: descriptor.provider,
        eventType: 'github.issue.open_changed',
        occurredAt: issue.updatedAt,
        receivedAt: context.receivedAt,
        scope: { kind: 'repository', id: observation.repository },
        subject: { kind: 'github.issue', id: String(issue.number) },
        correlationId: observation.occurrenceId,
        causationId: observation.scheduleId,
        idempotencyKey,
        payloadRef: {
          store: 'forge',
          key: `forge://schedule-decisions/DEC-${observation.occurrenceId}/github-issues/${issue.number}`,
          mediaType: 'application/json',
          schemaVersion: 1,
          digest: {
            algorithm: 'sha256',
            value: createHash('sha256').update(canonicalPayload).digest('hex'),
            bytes: Buffer.byteLength(canonicalPayload, 'utf8'),
          },
        },
      });
    });
  },
};

export function normalizeGithubIssueWatchObservation(
  observation: GithubIssueWatchEventObservation,
  context: { readonly receivedAt: string },
): EventEnvelopeV1[] {
  return [...githubIssueWatchEventAdapter.normalize(observation, context)];
}
