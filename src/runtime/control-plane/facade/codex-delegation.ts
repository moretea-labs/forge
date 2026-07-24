import { randomUUID } from 'crypto';
import { buildFacadeResult } from './facade-result';
import type {
  EvidenceRef,
  FacadeResult,
  WorkContract,
} from './types';

export type DelegateTarget = 'codex' | 'grok' | 'claude';

/** @deprecated since 1.4.0; removed no earlier than 2026-12-31. Use controller_claim and handoff_create/read/accept. */

export interface CodexContextPack {
  schemaVersion: 1;
  workId?: string;
  repoId: string;
  target: DelegateTarget;
  objective: string;
  acceptanceCriteria: string[];
  constraints: WorkContract['constraints'];
  relevantFilesSummary: string[];
  policyBoundaries: string[];
  allowedPaths: string[];
  forbiddenPaths: string[];
  currentEvidenceRefs: EvidenceRef[];
  workContractState?: {
    workId: string;
    status: WorkContract['status'];
    mode: WorkContract['mode'];
  };
  policyDecision?: string;
  expectedOutputFormat: {
    mustProduce: Array<'evidence_artifact' | 'handoff_item' | 'patch_proposal' | 'suggested_next_actions'>;
    mustNot: string[];
  };
}

export interface GrokDelegateRequestPacket {
  schemaVersion: 1;
  requestId: string;
  target: 'grok';
  mode: 'bounded_handoff_request';
  repoId: string;
  workId?: string;
  objective: string;
  acceptanceCriteria: string[];
  constraints: WorkContract['constraints'];
  allowedPaths: string[];
  forbiddenPaths: string[];
  relevantFilesSummary: string[];
  policyBoundaries: string[];
  currentEvidenceRefs: EvidenceRef[];
  requiredOutputFormat: CodexContextPack['expectedOutputFormat'];
  instructions: string[];
  /** Direct Grok execution is not assumed available; ChatGPT remains authority. */
  directExecutionAvailable: false;
  returnPath: 'evidence_or_handoff_for_chatgpt_review';
}

export interface CodexDelegationInput {
  workId?: string;
  target?: DelegateTarget;
  objective: string;
  acceptanceCriteria?: string[];
  allowedPaths?: string[];
  forbiddenPaths?: string[];
  constraints?: WorkContract['constraints'];
  relevantFilesSummary?: string[];
  policyBoundaries?: string[];
  evidenceRefs?: EvidenceRef[];
  policyDecision?: string;
  /** When false, target executor is treated as unavailable. Defaults: codex/claude true if not set; grok false for direct exec. */
  available?: boolean;
  /** @deprecated Use available. Kept for stage-2 callers. */
  codexAvailable?: boolean;
  workerOutput?: {
    uncertain?: boolean;
    summary?: string;
    patchProposal?: string;
    evidenceSummary?: string;
  };
}

export interface CodexDelegationContext {
  repoId: string;
}

function normalizeTarget(value: unknown): DelegateTarget {
  if (value === 'grok' || value === 'claude' || value === 'codex') return value;
  return 'codex';
}

export function buildCodexContextPack(input: CodexDelegationInput & { repoId: string; work?: WorkContract }): CodexContextPack {
  const work = input.work;
  const target = normalizeTarget(input.target);
  return {
    schemaVersion: 1,
    workId: input.workId ?? work?.workId,
    repoId: input.repoId,
    target,
    objective: (input.objective || work?.objective || '').slice(0, 2_000),
    acceptanceCriteria: (input.acceptanceCriteria ?? work?.acceptanceCriteria ?? []).slice(0, 20),
    constraints: input.constraints ?? work?.constraints ?? { requireHandoffOnAmbiguity: true },
    relevantFilesSummary: (input.relevantFilesSummary ?? []).slice(0, 30).map((entry) => entry.slice(0, 200)),
    policyBoundaries: (input.policyBoundaries ?? [
      `${target} is an external controller, not a Kernel-managed executor.`,
      'Do not finalize WorkContract.',
      'Do not push, merge, or perform destructive cleanup.',
      'Do not return raw secrets, tokens, auth config, or full runtime state.',
      'Output must be evidence / handoff / patch proposal / suggested_next_actions only.',
      'ChatGPT must review before rh_work.finalize.',
    ]).slice(0, 20),
    allowedPaths: (input.allowedPaths ?? work?.allowedPaths ?? []).slice(0, 50),
    forbiddenPaths: (input.forbiddenPaths ?? work?.forbiddenPaths ?? ['.env', '_ops/secrets', '**/*secret*', '**/*token*']).slice(0, 50),
    currentEvidenceRefs: (input.evidenceRefs ?? work?.evidenceRefs ?? []).slice(0, 10),
    workContractState: work
      ? { workId: work.workId, status: work.status, mode: work.mode }
      : undefined,
    policyDecision: input.policyDecision,
    expectedOutputFormat: {
      mustProduce: ['evidence_artifact', 'handoff_item', 'patch_proposal', 'suggested_next_actions'],
      mustNot: [
        'finalize_work_contract',
        'mutate_mainline_state_directly',
        'push_or_remote_write',
        'return_raw_stdout_stderr',
        'return_secrets_or_tokens',
      ],
    },
  };
}

export function prepareGrokDelegateRequest(
  input: CodexDelegationInput & { repoId: string; work?: WorkContract },
): GrokDelegateRequestPacket {
  const pack = buildCodexContextPack({ ...input, target: 'grok' });
  return {
    schemaVersion: 1,
    requestId: `grok-req-${randomUUID().slice(0, 10)}`,
    target: 'grok',
    mode: 'bounded_handoff_request',
    repoId: pack.repoId,
    workId: pack.workId,
    objective: pack.objective,
    acceptanceCriteria: pack.acceptanceCriteria,
    constraints: pack.constraints,
    allowedPaths: pack.allowedPaths,
    forbiddenPaths: pack.forbiddenPaths,
    relevantFilesSummary: pack.relevantFilesSummary,
    policyBoundaries: pack.policyBoundaries,
    currentEvidenceRefs: pack.currentEvidenceRefs,
    requiredOutputFormat: pack.expectedOutputFormat,
    instructions: [
      'Act as a parallel small-brain reviewer/implementer for ChatGPT.',
      'Return only bounded evidence, patch proposal, and suggested next actions.',
      'Do not finalize work, push, or request secrets.',
      'ChatGPT remains the primary controller and must review before finalize.',
    ],
    directExecutionAvailable: false,
    returnPath: 'evidence_or_handoff_for_chatgpt_review',
  };
}

/**
 * Deprecated compatibility surface. It intentionally performs no Work/Handoff
 * mutation and never starts or interprets an external controller session.
 */
export function delegateToCodexCerebellum(
  ctx: CodexDelegationContext,
  input: CodexDelegationInput,
): FacadeResult {
  const target = normalizeTarget(input.target);
  const pack = buildCodexContextPack({
    ...input,
    target,
    repoId: ctx.repoId,
  });
  return buildFacadeResult({
    status: 'blocked',
    summary: 'DEPRECATED_DELEGATE: delegate is read-only through 2026-12-31 and will be removed in 1.5.0. Use controller_claim, launcher_start, and rh_inbox.create/accept.',
    data: {
      target,
      workId: input.workId,
      deprecated: true,
      removalVersion: '1.5.0',
      removalDate: '2026-12-31',
      canFinalize: false,
      contextPack: pack,
      workerOutputIgnored: input.workerOutput !== undefined,
    },
    suggestedNextActions: input.workId ? [
      { label: 'Claim controller ownership', tool: 'rh_work', operation: 'controller_claim', payload: { work_id: input.workId }, risk: 'workspace_write' },
      { label: 'Start external controller', tool: 'rh_work', operation: 'launcher_start', payload: { work_id: input.workId, controller_type: target }, risk: 'workspace_write' },
    ] : [],
  });
}
