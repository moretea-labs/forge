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
export const MAX_SUPERVISOR_OBJECTIVE_CHARS = 8_000;

/** A goal cannot be silently shortened between durable Task and sent effect. */
export function validateSupervisorObjective(value: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error('WORKFLOW_SUPERVISOR_OBJECTIVE_REQUIRED');
  if (value.length > MAX_SUPERVISOR_OBJECTIVE_CHARS) throw new Error('WORKFLOW_SUPERVISOR_OBJECTIVE_TOO_LARGE');
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
  const repoId = typeof task.completionContract.repo_id === 'string'
    ? task.completionContract.repo_id.trim()
    : typeof task.continuationPolicy.repo_id === 'string' ? task.continuationPolicy.repo_id.trim() : '';
  const checkoutId = typeof task.completionContract.checkout_id === 'string'
    ? task.completionContract.checkout_id.trim()
    : typeof task.continuationPolicy.checkout_id === 'string' ? task.continuationPolicy.checkout_id.trim() : '';
  // An automation receipt is a causal key, not an engineering handoff.
  // Conversation context and live project evidence guide the next action.
  const rawCheckpoint = typeof _checkpoint === 'string' ? _checkpoint.trim() : '';
  const checkpoint = /^(?:automation:|receipt:)/.test(rawCheckpoint) ? '' : rawCheckpoint.slice(0, 2_000);
  // Recovery/correction context is model-facing advisory evidence, not another
  // authority. Discarding it made a recovery look like the original request
  // and allowed the model to repeat previously completed work.
  const recoveryContext = kind === 'recovery' || kind === 'correction'
    ? (typeof _correctionReason === 'string' ? _correctionReason.trim() : '') : '';
  // Preserve both parts even when an older checkpoint occupies the full bound.
  const continuity = recoveryContext
    ? [checkpoint.slice(0, 950), recoveryContext.slice(0, 1_000)].filter(Boolean).join('\n')
    : checkpoint;
  const cognition = advisoryCognition?.trim().slice(0, 8_000) ?? '';
  const envelope: WorkflowSupervisorTurnEnvelope = {
    schema_version: 2,
    identity: {
      task_id: task.taskId,
      effect_id: validateEffectId(effectId),
      kind,
    },
    goal: {
      role: 'outcome',
      objective: validateSupervisorObjective(task.objective),
    },
    ...(continuity ? { continuity: { role: 'advisory' as const, summary: continuity } } : {}),
    ...(repoId ? { repository: { repo_id: repoId, ...(checkoutId ? { checkout_id: checkoutId } : {}) } } : {}),
    ...(cognition ? { cognition: { role: 'advisory' as const, projection: cognition } } : {}),
    receipt: { challenge: supervisorReceiptChallenge(task, effectId) },
  };
  return [
    renderEffectMarker(effectId),
    // Keep the exact Effect marker first for existing target matching, but
    // surface tool intent before the potentially long JSON goal envelope.
    'forge 继续。使用真实可用的 Forge 工具接续未完成的工作；不必每轮先做工具或全局状态自检。',
    SUPERVISOR_TURN_BLOCK_START,
    JSON.stringify(envelope),
    SUPERVISOR_TURN_BLOCK_END,
    // Textual intent only: Project instructions and literal @forge are not proof
    // of an App binding. No browser/plugin UI mutation belongs in this renderer.
    'USE FORGE: 使用 forge。已有真实工具时直接执行相关源码、验证或交付动作，不要强制以 rh_status 开始。JSON、项目指令或文字 @forge 不会授予工具权限；如果工具完全不可见，仅检查一次实际提供的发现入口（如有 functions.exec 可经 ALL_TOOLS 查询 mcp__forge__），不要反复自检或要求用户选择 App，也不能伪造调用。无工具时正文写 NO_TOOL_RECEIPT 和真实缺口，不宣称工程产出。',
    'DELIVER WORK: 把 objective 当作持续目标，像用户直接发送“继续”一样从本会话最近的未完成工作处继续；同一交付仍有安全、相关且必要的步骤时，本轮持续实现、验证、审阅并合法交付，不要因完成一次查询或一个微步而收尾。只补充当前真正缺失的证据，复用已有检查；不重复全局盘点，不机械新增 Work/Plan/测试。守住单一 writer、exact target、未知发送不重放和不可逆发布授权边界。不要在只有状态检查、计划或解释时结束本轮。',
    ...(typeof task.continuationPolicy.scheduled_wake_schedule_id === 'string' ? [
      'SCHEDULED WORK: 本轮仍有同一日的必要步骤时继续实现并以 C ' + supervisorReceiptChallenge(task, effectId) + ' 结束；当日目标已完成且没有剩余安全必要步骤时，使用 WAIT 并以 W ' + supervisorReceiptChallenge(task, effectId) + ' 结束。若存在真实人工阻塞，先记录精确且持久的 UserRequest、停止不安全动作，并在授权可用时通知用户，然后使用 WAIT 保持同一任务开放；不要用 DONE 或 NEEDS_USER 终结每日循环，也不要自行创建新日程。WAIT 让同一任务保持非终结状态，直到绑定的 Scheduler 下次触发。',
    ] : []),
    'END OF TURN: 本轮工作实际结束时才简述可核验产出和剩余事项，不要为尽快输出 C 提前终止仍可继续的安全开发。NO_TOOL_RECEIPT 只能写在正文中；工具不可用不等于用户必须介入，临时无工具且仍需下一轮探测时同样以 C ' + supervisorReceiptChallenge(task, effectId) + ' 结束，并写明零工程产出；不能将 C 视为成功或进展。D ' + supervisorReceiptChallenge(task, effectId) + ' 仅用于原目标真实交付；U ' + supervisorReceiptChallenge(task, effectId) + ' 仅用于确需用户决定/授权的阻塞。C/D/U' + (typeof task.continuationPolicy.scheduled_wake_schedule_id === 'string' ? '/W' : '') + ' 校验码必须独占最终助手回复最后一行，不得在中间消息提前输出，不要向 MCP 传 automation_status；Supervisor 只结算已完成的最终助手回复（only the completed final assistant reply）。',
  ].join('\n');
}

export function sha256(value: string): string { return createHash('sha256').update(value).digest('hex'); }
