import { createHash } from 'crypto';
import type { ControllerIssue, ControllerTask, IssueStatus, TaskStatus } from './types';
import type { Requirement, RequirementState } from '../../runtime/control-plane/persistence/requirement-store';
import {
  readControlPlaneRecordWithinTransaction,
  withControlPlaneTransaction,
  writeControlPlaneRecordWithinTransaction,
} from '../../runtime/control-plane/persistence/sqlite-store';
import type { EvidenceRef, PlanContract, PlanContractStatus, PlanStep, PlanStepStatus } from '../../runtime/control-plane/facade/types';

export const REQUIREMENT_PORTFOLIO_MIGRATION_ID = 'requirement-portfolio-20260802-v1';
export const FROZEN_PORTFOLIO_SOURCE_REVISION = '183c490dae39ecbe9db349a58a676570b5fabc71';

export type CanonicalRequirementId =
  | 'REQ-CONTROL-PLANE'
  | 'REQ-RUNTIME-AVAILABILITY'
  | 'REQ-REMOTE-RECOVERY'
  | 'REQ-TRUSTED-EXECUTION'
  | 'REQ-ROUTE-INTEGRITY'
  | 'REQ-PHYSICAL-IOS'
  | 'REQ-USER-CHROME'
  | 'REQ-APPLE-WORKFLOWS'
  | 'REQ-DEFECT-REVIEW'
  | 'REQ-RC6-RELEASE';

type MigrationDisposition = 'canonical' | 'active_plan' | 'historical' | 'superseded';

export interface PortfolioIssueMapping {
  issueId: string;
  requirementId: CanonicalRequirementId;
  disposition: MigrationDisposition;
  scopeKey: string;
  planId?: string;
  linkedRequirementIds?: CanonicalRequirementId[];
  postSnapshot?: boolean;
}

interface CanonicalRequirementDefinition {
  requirementId: CanonicalRequirementId;
  title: string;
  outcomeStatement: string;
  state: RequirementState;
  activePlanIssueId?: string;
  needsAttention?: boolean;
  attentionSummary?: string;
}

export const CANONICAL_REQUIREMENTS: readonly CanonicalRequirementDefinition[] = [
  {
    requirementId: 'REQ-CONTROL-PLANE',
    title: '让 Repo Harness 只展示清晰需求并自动管理执行细节',
    outcomeStatement: '用户默认只管理清晰的 Requirement，技术计划、执行尝试和维护证据按需查看。',
    state: 'active',
    activePlanIssueId: 'ISS-20260802-7E1D69',
  },
  {
    requirementId: 'REQ-RUNTIME-AVAILABILITY',
    title: '让 Repo Harness 升级和重启时保持可用',
    outcomeStatement: '升级、切换和重启期间保持可恢复、可验证且不中断控制能力。',
    state: 'active',
    activePlanIssueId: 'ISS-20260802-539E7F',
  },
  {
    requirementId: 'REQ-REMOTE-RECOVERY',
    title: '主服务不可用时仍能远程恢复',
    outcomeStatement: '主 Controller 或 Gateway 不可用时，仍有独立、受限且可验证的恢复路径。',
    state: 'planned',
    activePlanIssueId: 'ISS-20260802-27931A',
    needsAttention: true,
    attentionSummary: '远程恢复的剩余计划仍有依赖，当前不是用户决策阻塞。',
  },
  {
    requirementId: 'REQ-TRUSTED-EXECUTION',
    title: '让执行结果可验证、可恢复并可信完成',
    outcomeStatement: '每次执行具有唯一身份、验证证据、交付收据和可恢复的终态。',
    state: 'done',
  },
  {
    requirementId: 'REQ-ROUTE-INTEGRITY',
    title: '确保任务只在选定仓库中执行',
    outcomeStatement: '仓库、checkout、worktree和进程身份始终一致，漂移在执行前失败关闭。',
    state: 'active',
    activePlanIssueId: 'ISS-20260731-B66A97',
    needsAttention: true,
    attentionSummary: '切换后的故障矩阵与并发场景仍需完成最终验证。',
  },
  {
    requirementId: 'REQ-PHYSICAL-IOS',
    title: '让 Repo Harness 稳定、快速地操作物理 iPhone',
    outcomeStatement: '物理 iPhone连接、交互、恢复和自动化在真实设备上稳定可用。',
    state: 'active',
    activePlanIssueId: 'ISS-20260720-66E25D',
    needsAttention: true,
    attentionSummary: '设备能力仍有依赖和剩余交付步骤。',
  },
  {
    requirementId: 'REQ-USER-CHROME',
    title: '让浏览器操作复用用户当前 Chrome',
    outcomeStatement: '浏览器操作优先复用用户当前 Chrome，并如实区分原生标签控制与 DOM能力。',
    state: 'active',
    activePlanIssueId: 'ISS-20260731-6A7BB5',
    needsAttention: true,
    attentionSummary: '实现已存在，仍需真实用户 Chrome场景的最终验收。',
  },
  {
    requirementId: 'REQ-APPLE-WORKFLOWS',
    title: '让 Apple 项目配置和发布流程可持续复用',
    outcomeStatement: 'Apple项目、签名、设备、构建、TestFlight和发布上下文可安全复用。',
    state: 'planned',
    activePlanIssueId: 'ISS-20260730-84CE88',
    needsAttention: true,
    attentionSummary: 'Apple工作流等待控制面切换和依赖能力完成。',
  },
  {
    requirementId: 'REQ-DEFECT-REVIEW',
    title: '验证自动缺陷复核是否真的能减少 Bug',
    outcomeStatement: '用可重复实验衡量自动缺陷复核对真实缺陷率和返工成本的影响。',
    state: 'planned',
    activePlanIssueId: 'ISS-20260730-CCF211',
    needsAttention: true,
    attentionSummary: '实验前置条件尚未满足，不需要用户立即决定。',
  },
  {
    requirementId: 'REQ-RC6-RELEASE',
    title: '完成 Matea RC6 发布',
    outcomeStatement: 'Matea RC6已完成发布并保留精确版本、文档和验证证据。',
    state: 'done',
  },
] as const;

function mapping(
  issueId: string,
  requirementId: CanonicalRequirementId,
  disposition: MigrationDisposition,
  scopeKey: string,
  options: Pick<PortfolioIssueMapping, 'planId' | 'linkedRequirementIds' | 'postSnapshot'> = {},
): PortfolioIssueMapping {
  return { issueId, requirementId, disposition, scopeKey, ...options };
}

export const PORTFOLIO_ISSUE_MAPPINGS: readonly PortfolioIssueMapping[] = [
  mapping('ISS-20260712-14BA0C', 'REQ-TRUSTED-EXECUTION', 'historical', 'trusted-execution-recovery'),
  mapping('ISS-20260714-AF7CBF', 'REQ-RUNTIME-AVAILABILITY', 'historical', 'early-runtime-stability'),
  mapping('ISS-20260715-9E34AD', 'REQ-RUNTIME-AVAILABILITY', 'superseded', 'runtime-source-identity'),
  mapping('ISS-20260716-34A906', 'REQ-RUNTIME-AVAILABILITY', 'historical', 'runtime-resource-cleanup'),
  mapping('ISS-20260719-65CFF4', 'REQ-TRUSTED-EXECUTION', 'historical', 'completion-evidence-ownership'),
  mapping('ISS-20260719-8A4B9C', 'REQ-RUNTIME-AVAILABILITY', 'historical', 'global-supervisor-rollout'),
  mapping('ISS-20260719-F77E4C', 'REQ-PHYSICAL-IOS', 'historical', 'human-device-interaction', { linkedRequirementIds: ['REQ-USER-CHROME'] }),
  mapping('ISS-20260720-66E25D', 'REQ-PHYSICAL-IOS', 'canonical', 'physical-ios'),
  mapping('ISS-20260720-E8E871', 'REQ-PHYSICAL-IOS', 'superseded', 'physical-ios-legacy'),
  mapping('ISS-20260726-69DA83', 'REQ-RUNTIME-AVAILABILITY', 'superseded', 'v2-cutover'),
  mapping('ISS-20260727-197BBE', 'REQ-RUNTIME-AVAILABILITY', 'historical', 'runtime-routing-performance', { linkedRequirementIds: ['REQ-ROUTE-INTEGRITY'] }),
  mapping('ISS-20260729-3A88E8', 'REQ-RC6-RELEASE', 'superseded', 'rc6-release-duplicate'),
  mapping('ISS-20260729-BF2F89', 'REQ-RC6-RELEASE', 'canonical', 'rc6-release'),
  mapping('ISS-20260730-6444C7', 'REQ-REMOTE-RECOVERY', 'historical', 'recovery-https-transport'),
  mapping('ISS-20260730-84CE88', 'REQ-APPLE-WORKFLOWS', 'canonical', 'apple-workflows'),
  mapping('ISS-20260730-A1EA53', 'REQ-TRUSTED-EXECUTION', 'canonical', 'trusted-execution'),
  mapping('ISS-20260730-AE1BCC', 'REQ-CONTROL-PLANE', 'superseded', 'legacy-reliability-governance'),
  mapping('ISS-20260730-B55445', 'REQ-RUNTIME-AVAILABILITY', 'superseded', 'tool-surface-convergence'),
  mapping('ISS-20260730-CCF211', 'REQ-DEFECT-REVIEW', 'canonical', 'defect-review-experiment'),
  mapping('ISS-20260730-F311FC', 'REQ-TRUSTED-EXECUTION', 'historical', 'work-idempotency-redaction'),
  mapping('ISS-20260731-0A6D9E', 'REQ-USER-CHROME', 'historical', 'chrome-connection'),
  mapping('ISS-20260731-4D2F9E', 'REQ-CONTROL-PLANE', 'superseded', 'downstream-rebaseline'),
  mapping('ISS-20260731-6A7BB5', 'REQ-USER-CHROME', 'canonical', 'user-chrome'),
  mapping('ISS-20260731-7BB554', 'REQ-CONTROL-PLANE', 'superseded', 'portfolio-governance-archive'),
  mapping('ISS-20260731-B28C97', 'REQ-USER-CHROME', 'historical', 'browser-attach-reliability'),
  mapping('ISS-20260731-B66A97', 'REQ-ROUTE-INTEGRITY', 'canonical', 'route-integrity'),
  mapping('ISS-20260731-CCF3E3', 'REQ-CONTROL-PLANE', 'historical', 'control-plane-storage'),
  mapping('ISS-20260802-27931A', 'REQ-REMOTE-RECOVERY', 'canonical', 'remote-recovery'),
  mapping('ISS-20260802-3EC105', 'REQ-RUNTIME-AVAILABILITY', 'active_plan', 'runtime-plugin-boundary', { planId: 'PLAN-RUNTIME-PLUGIN-BOUNDARY' }),
  mapping('ISS-20260802-539E7F', 'REQ-RUNTIME-AVAILABILITY', 'canonical', 'runtime-availability'),
  mapping('ISS-20260802-7E1D69', 'REQ-CONTROL-PLANE', 'canonical', 'requirement-control-plane'),
  mapping('ISS-20260802-C31FEE', 'REQ-RUNTIME-AVAILABILITY', 'superseded', 'immutable-release-surface'),
  mapping('ISS-20260802-E3F4A7', 'REQ-REMOTE-RECOVERY', 'superseded', 'standalone-recovery-duplicate'),
  mapping('ISS-20260803-02317D', 'REQ-ROUTE-INTEGRITY', 'active_plan', 'worktree-cleanup-registration', { planId: 'PLAN-ROUTE-WORKTREE-CLEANUP', postSnapshot: true }),
  mapping('ISS-20260803-810BB4', 'REQ-REMOTE-RECOVERY', 'historical', 'recovery-mutation-fence', { planId: 'PLAN-RECOVERY-MUTATION-FENCE', postSnapshot: true }),
  mapping('ISS-20260803-90E84B', 'REQ-ROUTE-INTEGRITY', 'active_plan', 'multi-project-session-concurrency', { planId: 'PLAN-ROUTE-SESSION-CONCURRENCY', postSnapshot: true }),
] as const;

export const FROZEN_PORTFOLIO_ISSUE_IDS = PORTFOLIO_ISSUE_MAPPINGS.filter((entry) => !entry.postSnapshot).map((entry) => entry.issueId);
export const POST_SNAPSHOT_ISSUE_IDS = PORTFOLIO_ISSUE_MAPPINGS.filter((entry) => entry.postSnapshot).map((entry) => entry.issueId);

export interface RequirementPortfolioMigrationInput {
  controllerHome: string;
  repoId: string;
  sourceRevision: string;
  issues: ControllerIssue[];
  now?: () => string;
}

export interface RequirementPortfolioMigrationRecord {
  schemaVersion: 1;
  migrationId: string;
  repoId: string;
  frozenSourceRevision: string;
  sourceRevision: string;
  mappingFingerprint: string;
  sourceFingerprint: string;
  sourceIssueIds: string[];
  requirementIds: string[];
  planIds: string[];
  requirementStateCounts: Record<RequirementState, number>;
  appliedAt: string;
}

export interface PreparedRequirementPortfolioMigration {
  migrationRecord: RequirementPortfolioMigrationRecord;
  requirements: Requirement[];
  plans: PlanContract[];
}

export interface RequirementPortfolioMigrationResult {
  status: 'preview' | 'applied' | 'deduplicated';
  migrationId: string;
  sourceIssueCount: number;
  frozenIssueCount: number;
  postSnapshotIssueCount: number;
  requirementCount: number;
  planCount: number;
  requirementStateCounts: Record<RequirementState, number>;
  sourceFingerprint: string;
  mappingFingerprint: string;
  sourceRevision: string;
  requirementIds: string[];
  planIds: string[];
}

function planIdForMapping(entry: PortfolioIssueMapping): string {
  return entry.planId ?? `PLAN-${entry.issueId.replace(/^ISS-/, '')}`;
}

function stableJson(value: unknown): string {
  return JSON.stringify(value);
}

function fingerprint(value: unknown): string {
  return createHash('sha256').update(stableJson(value)).digest('hex');
}

function bounded(values: readonly string[] | undefined, limit: number, maxLength = 500): string[] {
  return (values ?? []).map((value) => String(value).trim()).filter(Boolean).slice(0, limit).map((value) => value.slice(0, maxLength));
}

function normalizedTask(task: ControllerTask): Record<string, unknown> {
  return {
    id: task.id,
    title: task.title,
    objective: task.objective,
    status: task.status,
    dependsOn: task.dependsOn,
    allowedPaths: task.allowedPaths,
    forbiddenPaths: task.forbiddenPaths,
    checks: task.checks,
    acceptanceCriteria: task.acceptanceCriteria,
    risk: task.risk,
    workId: task.workId,
    notes: task.notes,
    runIds: task.runIds,
    supersededBy: task.supersededBy,
    verification: task.verification ? {
      integratedRevision: task.verification.integratedRevision,
      reviewedDiffHash: task.verification.reviewedDiffHash,
      checkResults: task.verification.checkResults.map((check) => ({ checkId: check.checkId, ok: check.ok, summary: check.summary })),
      acceptanceResults: task.verification.acceptanceResults.map((result) => ({ criterion: result.criterion, ok: result.ok, outcome: result.outcome, source: result.source })),
      completionReceiptId: task.verification.completionReceipt?.receiptId,
      completionTargetRevision: task.verification.completionReceipt?.targetRevision,
      verifiedAt: task.verification.verifiedAt,
    } : undefined,
  };
}

function normalizedIssue(issue: ControllerIssue): Record<string, unknown> {
  return {
    id: issue.id,
    repoId: issue.repoId,
    title: issue.title,
    kind: issue.kind,
    status: issue.status,
    summary: issue.summary,
    goals: issue.goals,
    nonGoals: issue.nonGoals,
    acceptanceCriteria: issue.acceptanceCriteria,
    relatedArtifacts: issue.relatedArtifacts,
    createdAt: issue.createdAt,
    updatedAt: issue.updatedAt,
    tasks: [...issue.tasks].sort((left, right) => left.id.localeCompare(right.id)).map(normalizedTask),
  };
}

function assertPortfolioInput(input: RequirementPortfolioMigrationInput): ControllerIssue[] {
  if (!input.repoId.trim()) throw new Error('REQUIREMENT_PORTFOLIO_REPO_ID_REQUIRED');
  if (!input.sourceRevision.trim()) throw new Error('REQUIREMENT_PORTFOLIO_SOURCE_REVISION_REQUIRED');
  if (FROZEN_PORTFOLIO_ISSUE_IDS.length !== 33) throw new Error('REQUIREMENT_PORTFOLIO_FROZEN_COUNT_INVALID');
  if (POST_SNAPSHOT_ISSUE_IDS.length !== 3) throw new Error('REQUIREMENT_PORTFOLIO_POST_SNAPSHOT_COUNT_INVALID');
  if (CANONICAL_REQUIREMENTS.length !== 10) throw new Error('REQUIREMENT_PORTFOLIO_REQUIREMENT_COUNT_INVALID');

  const issueIds = input.issues.map((issue) => issue.id);
  if (new Set(issueIds).size !== issueIds.length) throw new Error('REQUIREMENT_PORTFOLIO_DUPLICATE_SOURCE_ISSUE');
  const mappingIds = PORTFOLIO_ISSUE_MAPPINGS.map((entry) => entry.issueId);
  if (new Set(mappingIds).size !== mappingIds.length) throw new Error('REQUIREMENT_PORTFOLIO_DUPLICATE_MAPPING');
  const expected = new Set(mappingIds);
  const actual = new Set(issueIds);
  const missing = mappingIds.filter((issueId) => !actual.has(issueId));
  const unknown = issueIds.filter((issueId) => !expected.has(issueId));
  if (missing.length > 0 || unknown.length > 0) {
    throw new Error(`REQUIREMENT_PORTFOLIO_SOURCE_SET_MISMATCH: missing=${missing.join(',') || 'none'} unknown=${unknown.join(',') || 'none'}`);
  }
  for (const issue of input.issues) {
    // The frozen portfolio contains one record from a predecessor repository
    // registration. File identity plus the reviewed Issue map authorizes import;
    // the historical repoId is evidence only and never becomes Plan authority.
    if (new Set(issue.tasks.map((task) => task.id)).size !== issue.tasks.length) throw new Error(`REQUIREMENT_PORTFOLIO_DUPLICATE_TASK: ${issue.id}`);
  }
  const requirementIds = new Set(CANONICAL_REQUIREMENTS.map((definition) => definition.requirementId));
  for (const entry of PORTFOLIO_ISSUE_MAPPINGS) {
    if (!requirementIds.has(entry.requirementId)) throw new Error(`REQUIREMENT_PORTFOLIO_UNKNOWN_REQUIREMENT: ${entry.requirementId}`);
    for (const linked of entry.linkedRequirementIds ?? []) {
      if (!requirementIds.has(linked)) throw new Error(`REQUIREMENT_PORTFOLIO_UNKNOWN_LINKED_REQUIREMENT: ${linked}`);
    }
  }
  return [...input.issues].sort((left, right) => left.id.localeCompare(right.id));
}

function planStatus(issueStatus: IssueStatus, disposition: MigrationDisposition): PlanContractStatus {
  if (disposition === 'superseded') return 'superseded';
  if (issueStatus === 'done') return 'finalized';
  if (issueStatus === 'cancelled') return 'superseded';
  if (issueStatus === 'review') return 'verifying';
  if (issueStatus === 'in_progress') return 'executing';
  if (issueStatus === 'planned' || issueStatus === 'launch_blocked') return 'approved';
  return 'draft';
}

function taskStepStatus(issueId: string, task: ControllerTask): PlanStepStatus {
  if (issueId === 'ISS-20260802-7E1D69' && task.id === 'T5') return 'completed';
  if (task.verification?.completionReceipt) return 'completed';
  const terminal = new Set<TaskStatus>(['done', 'cancelled', 'superseded']);
  if (terminal.has(task.status)) return 'completed';
  if (task.status === 'ready') return 'ready';
  if (task.status === 'running' || task.status === 'integrating') return 'executing';
  if (['review', 'verifying', 'ready_to_integrate', 'integration_blocked', 'integrated', 'cleanup_pending', 'cleanup_blocked', 'verified'].includes(task.status)) return 'validating';
  return 'pending';
}

function taskEvidence(issueId: string, task: ControllerTask): EvidenceRef[] {
  const evidence: EvidenceRef[] = [{
    evidenceId: `${issueId}/${task.id}`,
    title: `Legacy Task ${task.id}`,
    summary: `Imported declared status ${task.status}: ${task.title}`.slice(0, 1_000),
    detailLevel: 'detail',
  }];
  if (issueId === 'ISS-20260802-7E1D69' && task.id === 'T5') {
    evidence.push({ evidenceId: REQUIREMENT_PORTFOLIO_MIGRATION_ID, title: 'Portfolio migration transaction', summary: 'This step is satisfied by the atomic migration record written in the same transaction.', detailLevel: 'detail' });
  }
  if (task.verification?.integratedRevision) {
    evidence.push({ evidenceId: task.verification.integratedRevision, title: 'Integrated revision', summary: task.verification.integratedRevision, detailLevel: 'summary' });
  }
  if (task.verification?.completionReceipt) {
    evidence.push({ evidenceId: task.verification.completionReceipt.receiptId, title: 'Completion receipt', summary: `Delivered ${task.verification.completionReceipt.targetRevision}; cleanup=${task.verification.completionReceipt.cleanup.status}.`, detailLevel: 'detail' });
  }
  if (task.runIds.length > 0) {
    evidence.push({ title: 'Historical run references', summary: task.runIds.slice(-10).join(', '), detailLevel: 'detail' });
  }
  for (const note of task.notes.slice(-2)) evidence.push({ title: 'Legacy Task note', summary: note.slice(0, 1_000), detailLevel: 'detail' });
  if (task.supersededBy?.length) evidence.push({ title: 'Superseded Task mapping', summary: task.supersededBy.join(', '), detailLevel: 'detail' });
  return evidence.slice(0, 10);
}

function buildPlan(
  input: RequirementPortfolioMigrationInput,
  issue: ControllerIssue,
  entry: PortfolioIssueMapping,
  activePlanId: string | undefined,
): PlanContract {
  const planId = planIdForMapping(entry);
  const steps: PlanStep[] = issue.tasks.map((task) => ({
    id: task.id,
    objective: String(task.objective || task.title).trim().slice(0, 1_000),
    dependencies: bounded(task.dependsOn, 30, 120),
    authoritativeFiles: [],
    allowedPaths: bounded(task.allowedPaths, 50),
    forbiddenPaths: bounded(task.forbiddenPaths, 50),
    checks: bounded(task.checks, 30, 200),
    acceptanceCriteria: bounded(task.acceptanceCriteria, 20),
    status: taskStepStatus(issue.id, task),
    workId: task.workId?.trim() || undefined,
    evidenceRefs: taskEvidence(issue.id, task),
  }));
  const evidenceRefs: EvidenceRef[] = [{
    evidenceId: issue.id,
    title: `Legacy Issue ${issue.id}`,
    summary: `${entry.disposition}; legacy status=${issue.status}; source repoId=${issue.repoId ?? 'missing'}; ${issue.title}`.slice(0, 1_000),
    detailLevel: 'detail',
  }];
  for (const linked of entry.linkedRequirementIds ?? []) {
    evidenceRefs.push({ title: 'Linked Requirement', summary: linked, detailLevel: 'summary' });
  }
  for (const artifact of issue.relatedArtifacts.slice(0, 8)) {
    evidenceRefs.push({ artifactId: artifact, title: 'Legacy related artifact', summary: artifact, detailLevel: 'detail' });
  }
  return {
    schemaVersion: 1,
    planId,
    repoId: input.repoId,
    requirementId: entry.requirementId,
    scopeKey: entry.scopeKey,
    sourceRevision: input.sourceRevision,
    goal: String(issue.summary || issue.title).trim().slice(0, 2_000),
    nonGoals: bounded(issue.nonGoals, 20),
    assumptions: [
      `Imported from ${issue.id} under the accepted 2026-08-02 portfolio mapping.`,
      `Historical source repoId ${issue.repoId ?? 'missing'} is retained as evidence; Plan authority is ${input.repoId}.`,
    ],
    resolvedDecisions: [`Migration disposition: ${entry.disposition}.`, `Legacy status retained as evidence: ${issue.status}.`],
    stopConditions: ['Stop if source Issue identity, mapping ownership, or SQLite authority conflicts.'],
    replanConditions: ['Replan through a new Plan version; never recreate the user Requirement.'],
    integrationStrategy: 'One-time atomic import; SQLite-only writes after cutover.',
    status: planStatus(issue.status, entry.disposition),
    steps,
    evidenceRefs: evidenceRefs.slice(0, 20),
    supersededBy: entry.disposition === 'superseded' && activePlanId && activePlanId !== planId ? activePlanId : undefined,
    createdAt: issue.createdAt,
    updatedAt: issue.updatedAt,
  };
}

function buildRequirement(
  input: RequirementPortfolioMigrationInput,
  definition: CanonicalRequirementDefinition,
  issuesById: ReadonlyMap<string, ControllerIssue>,
  at: string,
): Requirement {
  const primaryMappings = PORTFOLIO_ISSUE_MAPPINGS.filter((entry) => entry.requirementId === definition.requirementId);
  const linkedMappings = PORTFOLIO_ISSUE_MAPPINGS.filter((entry) => entry.linkedRequirementIds?.includes(definition.requirementId));
  const sourceIssues = primaryMappings.map((entry) => issuesById.get(entry.issueId)!).filter(Boolean);
  const canonical = definition.activePlanIssueId
    ? issuesById.get(definition.activePlanIssueId)
    : sourceIssues.find((issue) => PORTFOLIO_ISSUE_MAPPINGS.find((entry) => entry.issueId === issue.id)?.disposition === 'canonical');
  const receiptIds = sourceIssues.flatMap((issue) => issue.tasks.map((task) => task.verification?.completionReceipt?.receiptId).filter((value): value is string => Boolean(value)));
  const auditRefs = [
    ...primaryMappings.map((entry) => entry.issueId),
    ...linkedMappings.map((entry) => `linked:${entry.issueId}`),
    ...receiptIds,
  ].slice(0, 50);
  const createdAt = sourceIssues.map((issue) => issue.createdAt).sort()[0] ?? at;
  return {
    schemaVersion: 1,
    requirementId: definition.requirementId,
    legacyAliases: primaryMappings.map((entry) => entry.issueId).slice(0, 20),
    title: definition.title,
    outcomeStatement: definition.outcomeStatement,
    acceptanceCriteria: bounded(canonical?.acceptanceCriteria, 50),
    requiredDeliveryReferences: [...new Set(receiptIds)].slice(0, 50),
    activePlanId: definition.activePlanIssueId
      ? planIdForMapping(PORTFOLIO_ISSUE_MAPPINGS.find((entry) => entry.issueId === definition.activePlanIssueId)!)
      : undefined,
    state: definition.state,
    needsAttention: definition.needsAttention ?? false,
    attentionSummary: definition.attentionSummary,
    revision: 1,
    createdAt,
    updatedAt: at,
    auditRefs,
  };
}

function stateCounts(requirements: readonly Requirement[]): Record<RequirementState, number> {
  const counts: Record<RequirementState, number> = { planned: 0, active: 0, waiting_for_user: 0, done: 0, cancelled: 0 };
  for (const requirement of requirements) counts[requirement.state] += 1;
  return counts;
}

function resultFromPrepared(status: RequirementPortfolioMigrationResult['status'], prepared: PreparedRequirementPortfolioMigration): RequirementPortfolioMigrationResult {
  return {
    status,
    migrationId: prepared.migrationRecord.migrationId,
    sourceIssueCount: prepared.migrationRecord.sourceIssueIds.length,
    frozenIssueCount: FROZEN_PORTFOLIO_ISSUE_IDS.length,
    postSnapshotIssueCount: POST_SNAPSHOT_ISSUE_IDS.length,
    requirementCount: prepared.requirements.length,
    planCount: prepared.plans.length,
    requirementStateCounts: prepared.migrationRecord.requirementStateCounts,
    sourceFingerprint: prepared.migrationRecord.sourceFingerprint,
    mappingFingerprint: prepared.migrationRecord.mappingFingerprint,
    sourceRevision: prepared.migrationRecord.sourceRevision,
    requirementIds: prepared.migrationRecord.requirementIds,
    planIds: prepared.migrationRecord.planIds,
  };
}

export function prepareRequirementPortfolioMigration(input: RequirementPortfolioMigrationInput): PreparedRequirementPortfolioMigration {
  const issues = assertPortfolioInput(input);
  const issuesById = new Map(issues.map((issue) => [issue.id, issue]));
  const at = input.now?.() ?? new Date().toISOString();
  const requirements = CANONICAL_REQUIREMENTS.map((definition) => buildRequirement(input, definition, issuesById, at));
  const activePlanIds = new Map(CANONICAL_REQUIREMENTS.map((definition) => [
    definition.requirementId,
    definition.activePlanIssueId
      ? planIdForMapping(PORTFOLIO_ISSUE_MAPPINGS.find((entry) => entry.issueId === definition.activePlanIssueId)!)
      : undefined,
  ]));
  const plans = PORTFOLIO_ISSUE_MAPPINGS.map((entry) => buildPlan(input, issuesById.get(entry.issueId)!, entry, activePlanIds.get(entry.requirementId)));
  const activeScopeKeys = new Set<string>();
  for (const plan of plans.filter((candidate) => !['finalized', 'superseded', 'cancelled', 'invalidated_by_drift'].includes(candidate.status))) {
    const key = `${plan.requirementId}:${plan.scopeKey}`;
    if (activeScopeKeys.has(key)) throw new Error(`REQUIREMENT_PORTFOLIO_ACTIVE_PLAN_SCOPE_CONFLICT: ${key}`);
    activeScopeKeys.add(key);
  }
  const mappingFingerprint = fingerprint({ requirements: CANONICAL_REQUIREMENTS, mappings: PORTFOLIO_ISSUE_MAPPINGS });
  const sourceFingerprint = fingerprint({
    sourceRevision: input.sourceRevision,
    issues: issues.map(normalizedIssue),
  });
  const migrationRecord: RequirementPortfolioMigrationRecord = {
    schemaVersion: 1,
    migrationId: REQUIREMENT_PORTFOLIO_MIGRATION_ID,
    repoId: input.repoId,
    frozenSourceRevision: FROZEN_PORTFOLIO_SOURCE_REVISION,
    sourceRevision: input.sourceRevision,
    mappingFingerprint,
    sourceFingerprint,
    sourceIssueIds: issues.map((issue) => issue.id),
    requirementIds: requirements.map((requirement) => requirement.requirementId),
    planIds: plans.map((plan) => plan.planId),
    requirementStateCounts: stateCounts(requirements),
    appliedAt: at,
  };
  return { migrationRecord, requirements, plans };
}

export function previewRequirementPortfolioMigration(input: RequirementPortfolioMigrationInput): RequirementPortfolioMigrationResult {
  return resultFromPrepared('preview', prepareRequirementPortfolioMigration(input));
}

export function applyRequirementPortfolioMigration(input: RequirementPortfolioMigrationInput): RequirementPortfolioMigrationResult {
  const prepared = prepareRequirementPortfolioMigration(input);
  return withControlPlaneTransaction(input.controllerHome, (database) => {
    const existingMigration = readControlPlaneRecordWithinTransaction<RequirementPortfolioMigrationRecord>(
      database,
      'requirement_portfolio_migration',
      input.repoId,
      REQUIREMENT_PORTFOLIO_MIGRATION_ID,
    );
    if (existingMigration) {
      if (existingMigration.value.mappingFingerprint !== prepared.migrationRecord.mappingFingerprint
        || existingMigration.value.sourceFingerprint !== prepared.migrationRecord.sourceFingerprint) {
        throw new Error('REQUIREMENT_PORTFOLIO_ALREADY_MIGRATED_DIFFERENT_SOURCE');
      }
      return resultFromPrepared('deduplicated', prepared);
    }

    for (const requirement of prepared.requirements) {
      const existing = readControlPlaneRecordWithinTransaction<Requirement>(database, 'requirement', 'controller', requirement.requirementId);
      if (existing) throw new Error(`REQUIREMENT_PORTFOLIO_PARTIAL_AUTHORITY: requirement/${requirement.requirementId}`);
    }
    for (const plan of prepared.plans) {
      const existing = readControlPlaneRecordWithinTransaction<PlanContract>(database, 'plan_contract', input.repoId, plan.planId);
      if (existing) throw new Error(`REQUIREMENT_PORTFOLIO_PARTIAL_AUTHORITY: plan_contract/${plan.planId}`);
    }

    for (const requirement of prepared.requirements) {
      writeControlPlaneRecordWithinTransaction(database, {
        namespace: 'requirement',
        scope: 'controller',
        key: requirement.requirementId,
        schemaVersion: 1,
        value: requirement,
        action: 'requirement_portfolio_import',
        expectedRevision: null,
      });
    }
    for (const plan of prepared.plans) {
      writeControlPlaneRecordWithinTransaction(database, {
        namespace: 'plan_contract',
        scope: input.repoId,
        key: plan.planId,
        schemaVersion: 1,
        value: plan,
        action: 'requirement_portfolio_plan_import',
        expectedRevision: null,
      });
    }
    writeControlPlaneRecordWithinTransaction(database, {
      namespace: 'requirement_portfolio_migration',
      scope: input.repoId,
      key: REQUIREMENT_PORTFOLIO_MIGRATION_ID,
      schemaVersion: 1,
      value: prepared.migrationRecord,
      action: 'requirement_portfolio_migration_completed',
      expectedRevision: null,
    });
    return resultFromPrepared('applied', prepared);
  });
}
