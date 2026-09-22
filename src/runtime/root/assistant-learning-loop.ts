import { createHash } from 'crypto';
import type { WorkflowJsonValue, WorkflowPublicationReceipt } from '../../../packages/workflow-runtime/api/index';
import { createWorkContinuationSchedule } from '../workflow/schedules/work-continuation';

const DAY_MS = 86_400_000;

/** External-observation orchestration only. Semantic Memory writes live in the context adapter. */
export function schedulePublicationOutcomeCollection(input: {
  controllerHome: string;
  repoId: string;
  workId: string;
  publication: WorkflowPublicationReceipt;
  workflowInputs?: Record<string, WorkflowJsonValue>;
}) {
  const publishedAtMs = Date.parse(input.publication.publishedAt);
  if (!Number.isFinite(publishedAtMs)) throw new Error('OUTCOME_COLLECTION_PUBLICATION_TIME_INVALID');
  const browserSessionId = typeof input.workflowInputs?.session_id === 'string' ? input.workflowInputs.session_id.trim() : '';
  if (!browserSessionId) throw new Error('OUTCOME_COLLECTION_BROWSER_SESSION_REQUIRED');
  const dueAt = new Date(publishedAtMs + DAY_MS).toISOString();
  const semanticId = createHash('sha256').update(JSON.stringify([
    input.repoId, input.workId, input.publication.receiptId, input.publication.postId, input.publication.postUrl, dueAt,
  ])).digest('hex').slice(0, 24);
  const continuationPrompt = [
    `Publication outcome observation is due for receipt ${input.publication.receiptId}.`,
    `Use the same Work lineage. Execute the versioned metrics Workflow for channel=${input.publication.channel}, account=${input.publication.account}, post_id=${input.publication.postId}, post_url=${input.publication.postUrl}.`,
    'Then record an evidence-backed OutcomeObservation through rh_work outcome_record. Never infer or zero-fill a metric that the real page contract did not observe.',
    'If real metrics exist, the Controller may record a bounded Experience and must allow the next ControllerRound to classify that recalled experience as used or rejected with a reason.',
  ].join(' ');
  return createWorkContinuationSchedule(input.controllerHome, input.repoId, {
    workId: input.workId,
    scheduleMode: 'browser_watch',
    controllerType: 'chatgpt',
    probeUrl: input.publication.postUrl,
    probeBrowserSessionId: browserSessionId,
    wakeOnFirstObservation: true,
    wakeOnAuthRequired: true,
    continuationPrompt,
    scheduleName: `Observe publication ${input.publication.postId} after 24h`,
    requestId: `publication-outcome:${semanticId}`,
    triggerType: 'calendar',
    calendarAt: dueAt,
    catchUpMinutes: 24 * 60,
    stopConditions: ['work_terminal', 'human_review_required', 'external_blocker'],
  }).schedule;
}
