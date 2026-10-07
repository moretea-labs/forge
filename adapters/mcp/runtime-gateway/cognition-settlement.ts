import type { CallToolResult, McpToolDefinition } from '../../../packages/protocols/mcp/tool-contract';
import type { MultiRepositoryMcpToolContext } from '../multi-repository';
import { parseControllerLearningSignalDrafts, CONTROLLER_LEARNING_SIGNAL_ENVELOPE_MAX_ITEMS } from '../../../src/runtime/context/automatic-learning';
import {
  persistDirectControllerLearning,
  recordDirectControllerLearningFeedback,
  type DirectControllerLearningFeedbackDraft,
} from '../../../src/runtime/context/direct-controller-learning';
import { selected } from './shared-adapter';

export const COGNITION_SETTLEMENT_PROPERTY = {
  type: 'object',
  additionalProperties: false,
  properties: {
    work_id: {
      type: 'string',
      description: 'Optional selected Work. Forge derives reachable Work/Requirement/Project/Workspace scope and provenance; this is not caller-authored authority.',
    },
    learning_signals: {
      type: 'array',
      maxItems: CONTROLLER_LEARNING_SIGNAL_ENVELOPE_MAX_ITEMS,
      items: { type: 'object' },
      description: 'Optional model-authored reusable learning using the same LearningSignal contract as rh_work learning_record.',
    },
    learning_feedback: {
      type: 'array',
      maxItems: 32,
      items: { type: 'object' },
      description: 'Optional model-authored used/rejected feedback using the same contract as rh_work learning_feedback.',
    },
  },
  description: 'Optional bounded advisory cognition settlement for a meaningful successful tool outcome. It creates no lifecycle and grants no authority.',
} as const;

/**
 * Cognition settlement is transport metadata shared by every Controller tool.
 * The detailed semantic contract remains owned by the canonical learning parser/writer;
 * keeping this envelope compact avoids duplicating that schema across every tools/list entry.
 */
export function injectCognitionSettlementFields(definition: McpToolDefinition): McpToolDefinition {
  const schema = definition.inputSchema as {
    type?: unknown;
    properties?: Record<string, unknown>;
    [key: string]: unknown;
  };
  if (!schema || schema.type !== 'object') return definition;
  return {
    ...definition,
    inputSchema: {
      ...schema,
      properties: {
        ...(schema.properties ?? {}),
        cognition_settlement: COGNITION_SETTLEMENT_PROPERTY,
      },
    },
  };
}

export interface CognitionSettlementReceipt {
  recorded: boolean;
  storedMemoryIds: string[];
  observationIds: string[];
}

function parseFeedback(raw: unknown): DirectControllerLearningFeedbackDraft[] {
  if (!Array.isArray(raw)) throw new Error('COGNITION_SETTLEMENT_FEEDBACK_INVALID');
  if (raw.length === 0 || raw.length > 32) throw new Error('COGNITION_SETTLEMENT_FEEDBACK_ITEMS_INVALID');
  return raw.map((rawItem, index) => {
    if (!rawItem || typeof rawItem !== 'object' || Array.isArray(rawItem)) {
      throw new Error(`COGNITION_SETTLEMENT_FEEDBACK_ITEM_INVALID: ${index}`);
    }
    const item = rawItem as Record<string, unknown>;
    const memoryAddress = String(item.memory_address ?? '').trim();
    const decision = String(item.decision ?? '').trim();
    const reason = String(item.reason ?? '').trim();
    const rejectionKind = typeof item.rejection_kind === 'string' ? item.rejection_kind.trim() : undefined;
    if (!memoryAddress || !reason || !['used', 'rejected'].includes(decision)) {
      throw new Error(`COGNITION_SETTLEMENT_FEEDBACK_ITEM_INVALID: ${index}`);
    }
    if (decision === 'rejected' && !['irrelevant', 'stale', 'contradicted'].includes(rejectionKind ?? '')) {
      throw new Error(`COGNITION_SETTLEMENT_FEEDBACK_REJECTION_KIND_REQUIRED: ${index}`);
    }
    if (decision === 'used' && rejectionKind) {
      throw new Error(`COGNITION_SETTLEMENT_FEEDBACK_REJECTION_KIND_UNEXPECTED: ${index}`);
    }
    return {
      memoryAddress,
      decision: decision as 'used' | 'rejected',
      reason,
      ...(rejectionKind ? { rejectionKind: rejectionKind as 'irrelevant' | 'stale' | 'contradicted' } : {}),
    };
  });
}

/** Mechanical settlement shared by ordinary successful MCP outcome boundaries. */
export function settleCognitionEnvelope(
  ctx: MultiRepositoryMcpToolContext,
  args: Record<string, unknown>,
): CognitionSettlementReceipt | undefined {
  const raw = args.cognition_settlement;
  if (raw === undefined) return undefined;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('COGNITION_SETTLEMENT_INVALID');
  const envelope = raw as Record<string, unknown>;
  const repository = selected(ctx, args);
  const workId = typeof envelope.work_id === 'string' && envelope.work_id.trim()
    ? envelope.work_id.trim()
    : typeof args.work_id === 'string' && args.work_id.trim() ? args.work_id.trim() : undefined;

  const storedMemoryIds: string[] = [];
  const observationIds: string[] = [];

  if (envelope.learning_signals !== undefined) {
    const signals = parseControllerLearningSignalDrafts(envelope.learning_signals);
    if (!signals.length) throw new Error('COGNITION_SETTLEMENT_SIGNALS_REQUIRED');
    const learning = persistDirectControllerLearning({
      controllerHome: ctx.controllerHome,
      repository,
      signals,
      principalId: ctx.principalId,
      sessionId: ctx.sessionId,
      controllerInstanceId: ctx.controllerInstanceId,
      controllerType: ctx.controllerType,
      workId,
    });
    storedMemoryIds.push(...learning.storedMemoryIds);
  }

  if (envelope.learning_feedback !== undefined) {
    const recorded = recordDirectControllerLearningFeedback({
      controllerHome: ctx.controllerHome,
      repository,
      feedback: parseFeedback(envelope.learning_feedback),
      principalId: ctx.principalId,
      sessionId: ctx.sessionId,
      controllerInstanceId: ctx.controllerInstanceId,
      workId,
    });
    observationIds.push(...recorded.observationIds);
  }

  return {
    recorded: storedMemoryIds.length > 0 || observationIds.length > 0,
    storedMemoryIds,
    observationIds,
  };
}

function attachSettlementMetadata(
  outcome: CallToolResult,
  metadata: unknown,
  warning?: string,
): CallToolResult {
  const structured = outcome.structuredContent;
  if (!structured || typeof structured !== 'object' || Array.isArray(structured)) return outcome;
  const current = structured as Record<string, unknown>;
  const currentWarnings = Array.isArray(current.warnings)
    ? current.warnings.filter((item): item is string => typeof item === 'string')
    : [];
  const structuredContent = {
    ...current,
    cognitionSettlement: metadata,
    ...(warning ? { warnings: [...currentWarnings, warning] } : {}),
  };
  return {
    ...outcome,
    structuredContent,
    content: outcome.content.map((block, index) => index === 0 && block.type === 'text'
      ? { ...block, text: JSON.stringify(structuredContent) }
      : block),
  };
}

/**
 * Settle advisory cognition only after the primary tool outcome succeeded.
 * A settlement defect must never turn an already-applied repository/process/external effect
 * into a failed tool call that a model might dangerously retry. Explicit learning_record /
 * learning_feedback calls remain normal first-class operations and keep their own errors.
 */
export function settleCognitionAfterTool(
  ctx: MultiRepositoryMcpToolContext,
  name: string,
  args: Record<string, unknown>,
  outcome: CallToolResult | undefined,
): CallToolResult | undefined {
  if (!outcome || outcome.isError || args.cognition_settlement === undefined) return outcome;
  if (name === 'rh_work' && ['learning_record', 'learning_feedback'].includes(String(args.operation ?? ''))) {
    return outcome;
  }
  try {
    const receipt = settleCognitionEnvelope(ctx, args);
    return receipt ? attachSettlementMetadata(outcome, receipt) : outcome;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const code = /^([A-Z][A-Z0-9_]+)(?::|$)/.exec(message)?.[1] ?? 'COGNITION_SETTLEMENT_FAILED';
    return attachSettlementMetadata(
      outcome,
      { recorded: false, error: { code, message } },
      `COGNITION_SETTLEMENT_FAILED: ${message}`,
    );
  }
}
