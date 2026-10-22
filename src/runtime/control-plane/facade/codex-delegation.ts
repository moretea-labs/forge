import { buildFacadeResult } from './facade-result';
import type {
  EvidenceRef,
  FacadeResult,
  WorkContract,
} from './types';

export type DelegateTarget = 'codex' | 'grok' | 'claude';

/** @deprecated since 1.4.0; removed no earlier than 2026-12-31. Use launcher_start for an explicit external controller. */

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
    state: WorkContract['semanticState'];
    dispatchState: WorkContract['dispatchState'];
  };
  policyDecision?: string;
  expectedOutputFormat: {
    mustProduce: Array<'evidence_artifact' | 'handoff_item' | 'patch_proposal' | 'suggested_next_actions'>;
    mustNot: string[];
  };
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
    constraints: input.constraints ?? work?.constraints ?? {},
    relevantFilesSummary: (input.relevantFilesSummary ?? []).slice(0, 30).map((entry) => entry.slice(0, 200)),
    policyBoundaries: (input.policyBoundaries ?? [
      `${target} is an external controller, not a Kernel-managed executor.`,
      'Do not finalize WorkContract.',
      'Do not push, merge, or perform destructive cleanup.',
      'Do not return raw secrets, tokens, auth config, or full runtime state.',
      'Output must be evidence / handoff / patch proposal / suggested_next_actions only.',
      'ChatGPT remains responsible for semantic review and explicit Work completion.',
    ]).slice(0, 20),
    allowedPaths: (input.allowedPaths ?? []).slice(0, 50),
    forbiddenPaths: (input.forbiddenPaths ?? ['.env', '_ops/secrets', '**/*secret*', '**/*token*']).slice(0, 50),
    currentEvidenceRefs: (input.evidenceRefs ?? work?.evidenceRefs ?? []).slice(0, 10),
    workContractState: work
      ? { workId: work.workId, state: work.semanticState, dispatchState: work.dispatchState }
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
    summary: 'DEPRECATED_DELEGATE: delegate is read-only through 2026-12-31 and will be removed in 1.5.0. Use launcher_start for an explicit external controller and the inbox only for genuine human decisions.',
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
      { label: 'Start external controller', tool: 'rh_work', operation: 'launcher_start', payload: { work_id: input.workId, controller_type: target }, risk: 'workspace_write' },
    ] : [],
  });
}
