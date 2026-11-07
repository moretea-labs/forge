import { createHash } from 'crypto';
import type { WorkflowJsonValue, WorkflowPublicationReceipt } from '../../../packages/workflow-runtime/api/index';
import { createBrowserObservationSchedule } from '../workflow/schedules/browser-observation';

const DAY_MS = 86_400_000;

/** External-observation orchestration only. Semantic Memory writes live in the context adapter. */
export function schedulePublicationOutcomeCollection(input: {
  controllerHome: string;
  repoId: string;
  runId: string;
  publication: WorkflowPublicationReceipt;
  workflowInputs?: Record<string, WorkflowJsonValue>;
}) {
  const publishedAtMs = Date.parse(input.publication.publishedAt);
  if (!Number.isFinite(publishedAtMs)) throw new Error('OUTCOME_COLLECTION_PUBLICATION_TIME_INVALID');
  const browserSessionId = typeof input.workflowInputs?.session_id === 'string' ? input.workflowInputs.session_id.trim() : '';
  if (!browserSessionId) throw new Error('OUTCOME_COLLECTION_BROWSER_SESSION_REQUIRED');
  const dueAt = new Date(publishedAtMs + DAY_MS).toISOString();
  const semanticId = createHash('sha256').update(JSON.stringify([
    input.repoId, input.runId, input.publication.receiptId, input.publication.postId, input.publication.postUrl, dueAt,
  ])).digest('hex').slice(0, 24);
  return createBrowserObservationSchedule(input.controllerHome, input.repoId, {
    scheduleMode: 'browser_watch',
    controllerType: 'chatgpt',
    probeUrl: input.publication.postUrl,
    probeBrowserSessionId: browserSessionId,
    wakeOnFirstObservation: true,
    scheduleName: `Observe publication ${input.publication.postId} after 24h`,
    requestId: `publication-outcome:${semanticId}`,
    triggerType: 'calendar',
    calendarAt: dueAt,
    catchUpMinutes: 24 * 60,
    stopConditions: ['human_review_required', 'external_blocker'],
  }).schedule;
}
