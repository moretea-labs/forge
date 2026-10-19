import { createHash } from 'node:crypto';
import type { WorkflowEffectKind, WorkflowSupervisorProposal, WorkflowSupervisorState, WorkflowSupervisorTask, WorkflowSupervisorTurnEnvelope } from './types';

// Newly-rendered Supervisor turns use one compact causal receipt because the
// provider/browser output path can truncate longer machine-shaped payloads. Older
// block formats remain read-only compatibility for already-durable conversations.
export const SUPERVISOR_BLOCK_START = 'FORGE_WORKFLOW_SUPERVISOR_V1_BEGIN';
export const SUPERVISOR_BLOCK_END = 'FORGE_WORKFLOW_SUPERVISOR_V1_END';
const COMPACT_RECEIPT = /(?:^|\n)([CWDU]) ([0-9a-f]{7})\s*$/;
// Older installed Chrome content scripts flattened an entire completed reply
// into one line. The immutable Effect challenge remains the sole authority;
// recover only its terminal token, never an inline token in multiline text.
const FLATTENED_COMPACT_RECEIPT = /(?:^| )([CWDU]) ([0-9a-f]{7})$/;
function terminalCompactReceipt(responseText: string): RegExpExecArray | null {
  const text = responseText.trim();
  return COMPACT_RECEIPT.exec(text)
    ?? (!/[\r\n]/.test(text) ? FLATTENED_COMPACT_RECEIPT.exec(text) : null);
}
export const LEGACY_BRACKET_SUPERVISOR_BLOCK_START = '[[[FORGE_WORKFLOW_SUPERVISOR_V1]]]';
export const LEGACY_BRACKET_SUPERVISOR_BLOCK_END = '[[[END_FORGE_WORKFLOW_SUPERVISOR_V1]]]';
export const LEGACY_SUPERVISOR_BLOCK_START = '<<<FORGE_WORKFLOW_SUPERVISOR_V1>>>';
export const LEGACY_SUPERVISOR_BLOCK_END = '<<<END_FORGE_WORKFLOW_SUPERVISOR_V1>>>';
export const EFFECT_MARKER_PREFIX = '<<<FORGE_WORKFLOW_EFFECT_V1:';
export const SUPERVISOR_TURN_BLOCK_START = 'FORGE_WORKFLOW_TURN_V2_BEGIN';
export const SUPERVISOR_TURN_BLOCK_END = 'FORGE_WORKFLOW_TURN_V2_END';
const EFFECT_ID = /^(?:fx|crpe)_[a-zA-Z0-9_-]{8,120}$/;
const MAX_RESPONSE = 512 * 1024;
export const MAX_SUPERVISOR_OBJECTIVE_CHARS = 500;
export const MAX_SUPERVISOR_PROMPT_CHARS = 500;

/** A goal cannot be silently shortened between durable Task and sent effect. */
export function validateSupervisorObjective(value: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error('WORKFLOW_SUPERVISOR_OBJECTIVE_REQUIRED');
  if (Array.from(value).length > MAX_SUPERVISOR_OBJECTIVE_CHARS) throw new Error('WORKFLOW_SUPERVISOR_OBJECTIVE_TOO_LARGE');
  return value;
}
const SUPERVISOR_BLOCK_MARKERS = [
  { start: SUPERVISOR_BLOCK_START, end: SUPERVISOR_BLOCK_END },
  { start: LEGACY_BRACKET_SUPERVISOR_BLOCK_START, end: LEGACY_BRACKET_SUPERVISOR_BLOCK_END },
  { start: LEGACY_SUPERVISOR_BLOCK_START, end: LEGACY_SUPERVISOR_BLOCK_END },
] as const;

function boundedString(value: unknown, name: string, max: number): string {
  if (typeof value !== 'string') throw new Error(`WORKFLOW_SUPERVISOR_${name}_REQUIRED`);
  const normalized = value.trim();
  if (!normalized || normalized.length > max) throw new Error(`WORKFLOW_SUPERVISOR_${name}_INVALID`);
  return normalized;
}

export function validateEffectId(value: string): string {
  if (!EFFECT_ID.test(value)) throw new Error('WORKFLOW_SUPERVISOR_EFFECT_ID_INVALID');
  return value;
}

export function renderEffectMarker(effectId: string): string {
  return `${EFFECT_MARKER_PREFIX}${validateEffectId(effectId)}>>>`;
}

export function supervisorReceiptChallenge(task: Pick<WorkflowSupervisorTask, 'taskId' | 'conversationId'>, effectId: string): string {
  return createHash('sha256')
    .update(`${task.taskId}\n${task.conversationId}\n${validateEffectId(effectId)}`)
    .digest('hex')
    .slice(0, 7);
}

export function renderSupervisorReceipt(
  task: Pick<WorkflowSupervisorTask, 'taskId' | 'conversationId'>,
  effectId: string,
  action: WorkflowSupervisorProposal['action'],
): string {
  const code = action === 'CONTINUE' ? 'C' : action === 'WAIT' ? 'W' : action === 'DONE' ? 'D' : 'U';
  return `${code} ${supervisorReceiptChallenge(task, effectId)}`;
}

function supervisorBlockEnvelope(responseText: string): { start: number; end: number; startMarker: string; endMarker: string } {
  const candidates = SUPERVISOR_BLOCK_MARKERS.flatMap((marker) => {
    const end = responseText.lastIndexOf(marker.end);
    if (end < 0 || responseText.slice(end + marker.end.length).trim()) return [];
    const start = responseText.lastIndexOf(marker.start, end);
    return start < 0 ? [] : [{ start, end, startMarker: marker.start, endMarker: marker.end }];
  });
  if (candidates.length === 0) throw new Error('WORKFLOW_SUPERVISOR_END_MARKER_REQUIRED');
  if (candidates.length !== 1) throw new Error('WORKFLOW_SUPERVISOR_CONTROL_BLOCK_AMBIGUOUS');
  const envelope = candidates[0]!;
  const prefix = responseText.slice(0, envelope.start);
  if (SUPERVISOR_BLOCK_MARKERS.some((marker) => prefix.includes(marker.start))) {
    throw new Error('WORKFLOW_SUPERVISOR_CONTROL_BLOCK_AMBIGUOUS');
  }
  return envelope;
}

export function hasCommittedSupervisorEnvelope(responseText: string): boolean {
  if (Buffer.byteLength(responseText, 'utf8') > MAX_RESPONSE) return false;
  if (terminalCompactReceipt(responseText)) return true;
  try { supervisorBlockEnvelope(responseText); return true; } catch { return false; }
}

export function parseSupervisorCompletion(
  responseText: string,
  expected?: { task: Pick<WorkflowSupervisorTask, 'taskId' | 'conversationId' | 'continuationPolicy'>; effectId: string; prompt?: string },
): { proposal: WorkflowSupervisorProposal; controlBlock: string } {
  if (Buffer.byteLength(responseText, 'utf8') > MAX_RESPONSE) throw new Error('WORKFLOW_SUPERVISOR_RESPONSE_TOO_LARGE');
  const compact = terminalCompactReceipt(responseText);
  if (compact) {
    if (!expected) throw new Error('WORKFLOW_SUPERVISOR_COMPACT_RECEIPT_CONTEXT_REQUIRED');
    let challenge = supervisorReceiptChallenge(expected.task, expected.effectId);
    // Bootstrap binding changes the Task's conversation identity after Send.
    // Validate the challenge actually sent in the immutable effect, never a
    // recomputation from that subsequently changed Task projection.
    if (expected.prompt?.includes(SUPERVISOR_TURN_BLOCK_START)) {
      const start = expected.prompt.indexOf(SUPERVISOR_TURN_BLOCK_START + '\n') + SUPERVISOR_TURN_BLOCK_START.length + 1;
      const end = expected.prompt.indexOf('\n' + SUPERVISOR_TURN_BLOCK_END, start);
      let envelope: WorkflowSupervisorTurnEnvelope;
      try { envelope = JSON.parse(expected.prompt.slice(start, end)); }
      catch { throw new Error('WORKFLOW_SUPERVISOR_EFFECT_RECEIPT_INVALID'); }
      if (end < start || envelope?.schema_version !== 2
        || envelope.identity?.task_id !== expected.task.taskId
        || envelope.identity?.effect_id !== expected.effectId
        || !/^[0-9a-f]{7}$/.test(envelope.receipt?.challenge ?? '')) {
        throw new Error('WORKFLOW_SUPERVISOR_EFFECT_RECEIPT_INVALID');
      }
      challenge = envelope.receipt.challenge;
    }
    if (compact[2] !== challenge) throw new Error('WORKFLOW_SUPERVISOR_COMPACT_RECEIPT_CHALLENGE_MISMATCH');
    const action = compact[1] === 'C' ? 'CONTINUE' : compact[1] === 'W' ? 'WAIT' : compact[1] === 'D' ? 'DONE' : 'NEEDS_USER';
    if (action === 'WAIT' && typeof expected.task.continuationPolicy.scheduled_wake_schedule_id !== 'string') {
      throw new Error('WORKFLOW_SUPERVISOR_WAIT_NOT_SCHEDULED');
    }
    const supervisorState: WorkflowSupervisorState = action === 'CONTINUE' ? 'running' : action === 'WAIT' ? 'waiting' : action === 'DONE' ? 'done' : 'needs_user';
    return {
      proposal: {
        action,
        sourceEffectId: validateEffectId(expected.effectId),
        checkpoint: `receipt:${challenge}`,
        reason: 'compact_receipt',
        // A transient missing tool is mechanical evidence, never user-only
        // authorization. Persist the explicit model diagnostic on this same
        // completion so crash reconciliation uses identical validation.
        evidence: action === 'NEEDS_USER' && /(?:^|\r?\n)\s*NO_TOOL_RECEIPT(?=\s|[:：]|$)/.test(responseText)
          ? ['NO_TOOL_RECEIPT'] : [],
        conversationId: expected.task.conversationId,
        taskId: expected.task.taskId,
        supervisorState,
      },
      controlBlock: compact[0].trim(),
    };
  }
  const { start, end, startMarker, endMarker } = supervisorBlockEnvelope(responseText);
  const jsonText = responseText.slice(start + startMarker.length, end).trim();
  let parsed: unknown;
  try { parsed = JSON.parse(jsonText); } catch { throw new Error('WORKFLOW_SUPERVISOR_CONTROL_BLOCK_JSON_INVALID'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('WORKFLOW_SUPERVISOR_CONTROL_BLOCK_INVALID');
  const record = parsed as Record<string, unknown>;
  const allowed = new Set(['action', 'source_effect_id', 'checkpoint', 'reason', 'evidence', 'conversation_id', 'task_id', 'supervisor_state', 'active_scope']);
  if (Object.keys(record).some((key) => !allowed.has(key))) throw new Error('WORKFLOW_SUPERVISOR_CONTROL_BLOCK_FIELD_INVALID');
  const action = boundedString(record.action, 'ACTION', 32);
  if (!['CONTINUE', 'WAIT', 'DONE', 'NEEDS_USER'].includes(action)) throw new Error('WORKFLOW_SUPERVISOR_ACTION_INVALID');
  if (action === 'WAIT' && (!expected || typeof expected.task.continuationPolicy.scheduled_wake_schedule_id !== 'string')) {
    throw new Error('WORKFLOW_SUPERVISOR_WAIT_NOT_SCHEDULED');
  }
  const sourceEffectId = validateEffectId(boundedString(record.source_effect_id, 'SOURCE_EFFECT_ID', 128));
  const checkpoint = boundedString(record.checkpoint, 'CHECKPOINT', 2_000);
  const reason = boundedString(record.reason, 'REASON', 2_000);
  if (!Array.isArray(record.evidence) || record.evidence.length > 16) throw new Error('WORKFLOW_SUPERVISOR_EVIDENCE_INVALID');
  const evidence = record.evidence.map((value) => boundedString(value, 'EVIDENCE_ITEM', 1_000));
  const conversationId = record.conversation_id === undefined ? undefined : boundedString(record.conversation_id, 'CONVERSATION_ID', 256);
  const taskId = record.task_id === undefined ? undefined : boundedString(record.task_id, 'TASK_ID', 512);
  const supervisorState = record.supervisor_state === undefined ? undefined : boundedString(record.supervisor_state, 'SUPERVISOR_STATE', 32) as WorkflowSupervisorState;
  const activeScope = record.active_scope === undefined ? undefined : boundedString(record.active_scope, 'ACTIVE_SCOPE', 512);
  if (supervisorState && !['running', 'waiting', 'done', 'needs_user'].includes(supervisorState)) throw new Error('WORKFLOW_SUPERVISOR_STATE_INVALID');
  const expectedState: WorkflowSupervisorState = action === 'CONTINUE' ? 'running' : action === 'WAIT' ? 'waiting' : action === 'DONE' ? 'done' : 'needs_user';
  if (supervisorState && supervisorState !== expectedState) throw new Error('WORKFLOW_SUPERVISOR_STATE_ACTION_MISMATCH');
  if (activeScope && !/^(?:requirement|goal):[^\s]{1,480}$/.test(activeScope)) throw new Error('WORKFLOW_SUPERVISOR_ACTIVE_SCOPE_INVALID');
  const controlBlock = responseText.slice(start, end + endMarker.length);
  return {
    proposal: {
      action: action as WorkflowSupervisorProposal['action'], sourceEffectId, checkpoint, reason, evidence,
      ...(conversationId ? { conversationId } : {}),
      ...(taskId ? { taskId } : {}),
      ...(supervisorState ? { supervisorState } : {}),
      ...(activeScope ? { activeScope } : {}),
    },
    controlBlock,
  };
}

export function renderSupervisorPrompt(
  task: WorkflowSupervisorTask,
  effectId: string,
  kind: WorkflowEffectKind,
  _checkpoint?: string,
  _correctionReason?: string,
  _lowerLayerContext?: string,
  advisoryCognition?: string,
): string {
  const challenge = supervisorReceiptChallenge(task, effectId);
  const scheduled = typeof task.continuationPolicy.scheduled_wake_schedule_id === 'string';
  const marker = renderEffectMarker(effectId);
  const instructions = scheduled
    ? `forge 继续。读取任务记录并执行。末行仅写 W/C/U 中一个字母、空格和 ${challenge}。`
    : `forge 继续。读取任务记录并执行。末行仅写 C/D/U 中一个字母、空格和 ${challenge}。`;
  const envelope: WorkflowSupervisorTurnEnvelope = {
    schema_version: 2,
    identity: { task_id: task.taskId, effect_id: validateEffectId(effectId), kind },
    goal: { role: 'outcome', objective: '读取持久化目标' },
    receipt: { challenge },
  };
  const render = () => [marker, instructions, SUPERVISOR_TURN_BLOCK_START,
    JSON.stringify(envelope), SUPERVISOR_TURN_BLOCK_END].join('\n');
  // Inline objective only when it fits. The durable Task remains the sole
  // authority; checkpoints, safety boilerplate and past context are not sent.
  const objective = task.objective;
  envelope.goal!.objective = objective;
  if (Array.from(render()).length > MAX_SUPERVISOR_PROMPT_CHARS) {
    delete envelope.goal;
  }
  const prompt = render();
  if (Array.from(prompt).length > MAX_SUPERVISOR_PROMPT_CHARS) {
    throw new Error('WORKFLOW_SUPERVISOR_PROMPT_TOO_LARGE');
  }
  return prompt;
}

export function sha256(value: string): string { return createHash('sha256').update(value).digest('hex'); }
