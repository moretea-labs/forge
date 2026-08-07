import type { TaskRisk } from './types';
import { decideRoute, type RouteDecision, type RoutePolicyInput } from '../../runtime/control-plane/routing/route-policy';

export type WorkMode = 'direct_edit' | 'quick_agent' | 'issue_task' | 'campaign';
export type ExecutionPathPreference = 'fast' | 'durable' | 'campaign';

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
  campaignRequired: boolean;
  /** Replayable evidence from the single Route Policy authority. */
  routeDecision: RouteDecision;
}

function nextTools(decision: RouteDecision, investigation: boolean): string[] {
  if (decision.workMode === 'campaign') return ['create_campaign', 'add_campaign_task', 'reconcile_campaign', 'get_campaign_review_packet'];
  if (decision.workMode === 'issue_task') return ['inspect_issue_readiness', 'create_issue or append_task', 'dispatch_task', 'verify_task', 'accept_task'];
  if (decision.workMode === 'quick_agent') return ['search_repository', 'submit_local_job(action=quick-agent-session)', 'get_task_run', 'get_task_diff'];
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
  const routeDecision = decideRoute(input.routePolicyInput ?? {
    intent: {
      objective: input.description,
      scopeClear: (input.knownPaths?.length ?? 0) > 0 || input.requiresInvestigation === true,
      mutation: input.risk !== 'readonly',
      expectedFiles: input.expectedFiles,
      expectedChangedLines: input.expectedChangedLines,
      requiresInvestigation: input.requiresInvestigation,
      requiresParallelism: input.requiresParallelism,
      requiresLongRunningChecks: input.requiresLongRunningChecks,
      needsDependencies: input.needsDependencies,
      requiresIndependentDeliverables: input.requiresIndependentDeliverables,
      independentTaskCount: input.independentTaskCount,
      agentRequested: input.agentRequested,
    },
    workspace: { knownPaths: input.knownPaths },
    policy: {
      risk: input.risk,
      remoteWrite: input.requiresRemoteWrite,
      requiresApproval: input.requiresRemoteWrite,
    },
    capabilities: { requiresWorker: input.agentRequested },
    recovery: { required: input.requiresRecovery, isolationRequired: input.requiresWorkerIsolation },
  });
  return {
    recommendedMode: routeDecision.workMode,
    executionPath: routeDecision.executionPath,
    confidence: input.requiresInvestigation || (input.knownPaths?.length ?? 0) === 0 ? 'medium' : 'high',
    reasons: routeDecision.reasons.map((reason) => reason.message),
    nextTools: nextTools(routeDecision, input.requiresInvestigation === true || (input.knownPaths?.length ?? 0) === 0),
    issueRequired: routeDecision.workMode === 'issue_task',
    campaignRequired: routeDecision.workMode === 'campaign',
    routeDecision,
  };
}
