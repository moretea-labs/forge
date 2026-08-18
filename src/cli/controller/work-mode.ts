import type { TaskRisk } from './types';
import {
  decideRoute,
  type ExplicitTaskMode,
  type RouteDecision,
  type RoutePolicyInput,
} from '../../runtime/control-plane/routing/route-policy';

export type WorkMode = 'direct_edit' | 'bounded_work' | 'quick_agent' | 'issue_task';
export type ExecutionPathPreference = 'fast' | 'durable';
export type EffectiveTaskMode = ExplicitTaskMode | 'bounded';

export interface WorkModeAssessmentInput {
  description: string;
  knownPaths?: string[];
  expectedFiles?: number;
  expectedChangedLines?: number;
  requiresInvestigation?: boolean;
  requiresParallelism?: boolean;
  requiresLongRunningChecks?: boolean;
  needsDependencies?: boolean;
  requiresIndependentDeliverables?: boolean;
  independentTaskCount?: number;
  risk?: TaskRisk;
  requiresRemoteWrite?: boolean;
  requiresRecovery?: boolean;
  requiresWorkerIsolation?: boolean;
  agentRequested?: boolean;
  explicitMode?: ExplicitTaskMode | `-${ExplicitTaskMode}`;
  /** Migration/testing escape hatch: adapters must return this exact policy decision. */
  routePolicyInput?: RoutePolicyInput;
}

export interface WorkModeAssessment {
  recommendedMode: WorkMode;
  executionPath: ExecutionPathPreference;
  confidence: 'high' | 'medium';
  reasons: string[];
  nextTools: string[];
  issueRequired: boolean;
  taskMode: EffectiveTaskMode;
  explicitMode: ExplicitTaskMode | null;
  modeBehavior: {
    structuralContext: 'off' | 'required';
    mutationPhase: 'execute' | 'plan_only' | 'diagnose_first' | 'read_only' | 'coordinate' | 'release_gate' | 'benchmark';
    issueRequired: boolean;
    planRequired: boolean;
    worktreeRequired: boolean;
    workflow: string[];
  };
  /** Replayable evidence from the single Route Policy authority. */
  routeDecision: RouteDecision;
}

export function parseExplicitTaskMode(value: unknown): ExplicitTaskMode | undefined {
  if (typeof value !== 'string') return undefined;
  if (!value) return undefined;
  const normalized = value.replace(/^-/, '') as ExplicitTaskMode;
  return ['direct', 'plan', 'debug', 'review', 'release', 'scale'].includes(normalized)
    ? normalized
    : undefined;
}

function behaviorFor(mode: EffectiveTaskMode): WorkModeAssessment['modeBehavior'] {
  switch (mode) {
    case 'direct': return {
      structuralContext: 'off', mutationPhase: 'execute', issueRequired: false, planRequired: false, worktreeRequired: false,
      workflow: ['search/read exact known scope', 'edit 1-2 low-risk files', 'run focused checks', 'commit'],
    };
    case 'plan': return {
      structuralContext: 'required', mutationPhase: 'plan_only', issueRequired: false, planRequired: true, worktreeRequired: false,
      workflow: ['query CodeGraph structure', 'inspect cross-module contracts', 'write a decision-complete plan', 'do not mutate implementation'],
    };
    case 'debug': return {
      structuralContext: 'required', mutationPhase: 'diagnose_first', issueRequired: false, planRequired: false, worktreeRequired: false,
      workflow: ['reproduce', 'collect logs and traces', 'query CodeGraph callers and dependencies', 'identify root cause before mutation', 'apply focused fix and regression test'],
    };
    case 'review': return {
      structuralContext: 'off', mutationPhase: 'read_only', issueRequired: false, planRequired: false, worktreeRequired: false,
      workflow: ['read diff and affected source', 'review correctness and regressions', 'review lifecycle, concurrency, and security', 'report test gaps without mutation'],
    };
    case 'release': return {
      structuralContext: 'off', mutationPhase: 'release_gate', issueRequired: false, planRequired: false, worktreeRequired: false,
      workflow: ['verify checks and changelog', 'build immutable complete release', 'run integration and deployment gates', 'activate through Recovery', 'verify rollback evidence'],
    };
    case 'scale': return {
      structuralContext: 'off', mutationPhase: 'benchmark', issueRequired: false, planRequired: false, worktreeRequired: true,
      workflow: ['model concurrency and scheduling', 'run isolated large-load execution', 'measure queue, lease, and worker phases', 'publish benchmark evidence'],
    };
    default: return {
      structuralContext: 'off', mutationPhase: 'execute', issueRequired: false, planRequired: false, worktreeRequired: false,
      workflow: ['start resumable bounded Work', 'implement within declared scope', 'verify focused checks', 'finalize durable evidence'],
    };
  }
}

function nextTools(decision: RouteDecision, investigation: boolean): string[] {
  if (decision.workMode === 'issue_task') return ['inspect_issue_readiness', 'create_issue or append_task', 'dispatch_task', 'verify_task', 'accept_task'];
  if (decision.workMode === 'quick_agent') return ['search_repository', 'rh_work(operation=delegate)', 'rh_work(operation=continue)', 'rh_work(operation=verify)'];
  if (decision.workMode === 'bounded_work') return [
    ...(investigation ? ['rh_context', 'search_repository'] : []),
    'rh_work(operation=start)',
    'rh_work(operation=continue)',
    'rh_work(operation=verify)',
    'rh_work(operation=finalize)',
  ];
  return [
    ...(investigation ? ['search_repository', 'repository_workbench(operation=batch_execute reads)'] : []),
    'repository_workbench(operation=batch_execute)',
    'read_repository_file',
    'begin_edit_session',
    'apply_patch',
    'get_edit_session_diff',
    'verify_edit_session',
    'finalize_edit_session',
    'finish_edit_session',
  ];
}

/** @deprecated Compatibility adapter. Route Policy is the sole routing authority. */
export function assessWorkMode(input: WorkModeAssessmentInput): WorkModeAssessment {
  if (!input.description.trim()) throw new Error('work description is required');
  const explicitMode = parseExplicitTaskMode(input.explicitMode);
  const investigationMode = explicitMode === 'plan' || explicitMode === 'debug' || explicitMode === 'review';
  const readonlyMode = investigationMode;
  const parallelMode = explicitMode === 'scale';
  const routeDecision = decideRoute(input.routePolicyInput ?? {
    intent: {
      objective: input.description,
      scopeClear: explicitMode === 'direct' || (input.knownPaths?.length ?? 0) > 0 || input.requiresInvestigation === true || investigationMode,
      mutation: readonlyMode ? false : input.risk !== 'readonly',
      expectedFiles: input.expectedFiles,
      expectedChangedLines: input.expectedChangedLines,
      requiresInvestigation: explicitMode === 'direct' ? false : input.requiresInvestigation || investigationMode,
      requiresParallelism: explicitMode === 'direct' ? false : input.requiresParallelism || parallelMode,
      requiresLongRunningChecks: input.requiresLongRunningChecks || explicitMode === 'release' || explicitMode === 'scale',
      needsDependencies: input.needsDependencies,
      requiresIndependentDeliverables: input.requiresIndependentDeliverables || parallelMode,
      independentTaskCount: parallelMode ? Math.max(2, input.independentTaskCount ?? 0) : input.independentTaskCount,
      agentRequested: input.agentRequested,
      taskIntent: explicitMode === 'plan' ? 'architecture_planning' : explicitMode === 'review' ? 'review' : explicitMode === 'debug' ? 'code_repair' : undefined,
      explicitMode,
    },
    workspace: { knownPaths: input.knownPaths },
    policy: {
      risk: readonlyMode ? 'readonly' : input.risk,
      remoteWrite: input.requiresRemoteWrite,
      requiresApproval: input.requiresRemoteWrite,
    },
    capabilities: { requiresWorker: input.agentRequested },
    recovery: {
      // Debugging expands evidence through rh_context; it does not itself need
      // durable continuation or command recovery.
      required: input.requiresRecovery || explicitMode === 'release' || explicitMode === 'scale',
      isolationRequired: explicitMode === 'direct' ? false : input.requiresWorkerIsolation || parallelMode,
    },
  });
  const taskMode: EffectiveTaskMode = explicitMode
    ?? (routeDecision.workMode === 'direct_edit' ? 'direct' : 'bounded');
  const modeBehavior = behaviorFor(taskMode);
  return {
    recommendedMode: routeDecision.workMode,
    executionPath: routeDecision.executionPath,
    confidence: input.requiresInvestigation || (input.knownPaths?.length ?? 0) === 0 ? 'medium' : 'high',
    reasons: routeDecision.reasons.map((reason) => reason.message),
    nextTools: explicitMode === 'plan' || explicitMode === 'debug'
      ? ['rh_context(search.structural_context=required)', ...modeBehavior.workflow]
      : explicitMode === 'review'
        ? ['repository_git_status', 'repository_diff', ...modeBehavior.workflow]
        : explicitMode === 'release'
          ? ['run_check', 'request_release_gate', 'capability_recovery_plan', 'capability_recovery_apply', 'controller_ready']
          : explicitMode === 'scale'
            ? ['rh_work(operation=plan_create)', 'rh_work(operation=start)', 'process_get', 'process_wait', 'benchmark evidence']
            : nextTools(routeDecision, input.requiresInvestigation === true || investigationMode || (input.knownPaths?.length ?? 0) === 0),
    issueRequired: routeDecision.workMode === 'issue_task',
    taskMode,
    explicitMode: explicitMode ?? null,
    modeBehavior,
    routeDecision,
  };
}
