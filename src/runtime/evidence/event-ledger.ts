import { randomUUID } from 'crypto';
import { join } from 'path';
import { closeSync, fstatSync, openSync, readFileSync, readSync } from 'fs';
import { repositoryControllerRoot } from '../../effects/controller-home';
import { appendJsonLine } from '../shared/json-files';
import type { ExecutionJob, ExecutionJobEvent } from '../execution/jobs/types';

function ledgerPath(controllerHome: string, repoId: string): string {
  return join(repositoryControllerRoot(controllerHome, repoId), 'events', 'ledger.jsonl');
}

function jobEventPath(controllerHome: string, repoId: string, jobId: string): string {
  return join(repositoryControllerRoot(controllerHome, repoId), 'events', 'jobs', `${jobId}.jsonl`);
}

export interface RuntimeEntityEvent {
  schemaVersion: 1;
  eventId: string;
  eventType: string;
  repoId: string;
  entityType: 'job' | 'plugin' | 'schedule' | 'occurrence' | 'portfolio' | 'release' | 'lease' | 'schedule-decision';
  entityId: string;
  correlationId?: string;
  causationId?: string;
  requestId: string;
  revision: number;
  occurredAt: string;
  data?: Record<string, unknown>;
}

export function appendRuntimeEvent(
  controllerHome: string,
  input: Omit<RuntimeEntityEvent, 'schemaVersion' | 'eventId' | 'occurredAt'>,
): RuntimeEntityEvent {
  const event: RuntimeEntityEvent = {
    schemaVersion: 1,
    eventId: `EVT-${Date.now()}-${randomUUID().slice(0, 8)}`,
    occurredAt: new Date().toISOString(),
    ...input,
  };
  appendJsonLine(ledgerPath(controllerHome, input.repoId), event);
  return event;
}

const MAX_RUNTIME_EVENT_READ_BYTES = 1024 * 1024;
const MAX_RUNTIME_EVENT_READ_LIMIT = 200;

export function readRuntimeEvents(
  controllerHome: string,
  repoId: string,
  options: { entityType?: RuntimeEntityEvent['entityType']; limit?: number } = {},
): RuntimeEntityEvent[] {
  const path = ledgerPath(controllerHome, repoId);
  let descriptor: number;
  try {
    descriptor = openSync(path, 'r');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }

  try {
    const size = fstatSync(descriptor).size;
    const length = Math.min(size, MAX_RUNTIME_EVENT_READ_BYTES);
    if (length === 0) return [];
    const buffer = Buffer.alloc(length);
    const bytesRead = readSync(descriptor, buffer, 0, length, size - length);
    let content = buffer.subarray(0, bytesRead).toString('utf8');
    if (size > bytesRead) {
      const firstLineEnd = content.indexOf('\n');
      if (firstLineEnd < 0) return [];
      content = content.slice(firstLineEnd + 1);
    }
    const lines = content.split(/\r?\n/);
    lines.pop();
    const limit = Math.max(1, Math.min(
      MAX_RUNTIME_EVENT_READ_LIMIT,
      Math.trunc(options.limit ?? 100),
    ));
    const events = lines.filter(Boolean).map((line) => {
      try {
        return JSON.parse(line) as RuntimeEntityEvent;
      } catch {
        throw new Error(`RUNTIME_EVENT_LEDGER_CORRUPT: ${path}`);
      }
    }).filter((event) => event.schemaVersion === 1
      && event.repoId === repoId
      && (!options.entityType || event.entityType === options.entityType));
    return events.slice(-limit);
  } finally {
    closeSync(descriptor);
  }
}

export function appendJobEvent(
  controllerHome: string,
  job: ExecutionJob,
  eventType: string,
  data?: Record<string, unknown>,
): ExecutionJobEvent {
  const event: ExecutionJobEvent = {
    schemaVersion: 1,
    eventId: `EVT-${Date.now()}-${randomUUID().slice(0, 8)}`,
    eventType,
    repoId: job.repoId,
    entityType: 'job',
    entityId: job.jobId,
    correlationId: job.origin.correlationId,
    causationId: job.origin.causationId,
    requestId: job.requestId,
    revision: job.revision,
    occurredAt: new Date().toISOString(),
    data,
  };
  appendJsonLine(ledgerPath(controllerHome, job.repoId), event);
  appendJsonLine(jobEventPath(controllerHome, job.repoId, job.jobId), event);
  return event;
}

export function readJobEvents(controllerHome: string, repoId: string, jobId: string, limit = 200): ExecutionJobEvent[] {
  try {
    const lines = readFileSync(jobEventPath(controllerHome, repoId, jobId), 'utf8')
      .split(/\r?\n/)
      .filter(Boolean)
      .slice(-Math.max(1, Math.min(limit, 1000)));
    return lines.map((line) => JSON.parse(line) as ExecutionJobEvent);
  } catch {
    return [];
  }
}
