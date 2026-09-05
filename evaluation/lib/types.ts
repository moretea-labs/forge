export const SCENARIO_SCHEMA = 'forge-evaluation-scenario/v1' as const;
export const TRACE_SCHEMA = 'forge-evaluation-trace/v1' as const;
export const REPORT_SCHEMA = 'forge-evaluation-report/v1' as const;

export type EvaluationAuthorityClass = 'cross_version_evaluation' | 'candidate_internal_diagnostic';
export type EvaluationCorpusClass = 'shared' | 'v2_only';
export type EvaluationBehaviorClass =
  | 'discovery_context'
  | 'bounded_mutation'
  | 'work_lifecycle'
  | 'failure_classification'
  | 'restart_recovery'
  | 'multi_repo_concurrency';
export type EvaluationProvenanceKind = 'historical_regression' | 'historical_behavior' | 'synthetic_fixture';

export type ValidatorKind = 'behavior' | 'invariant' | 'regression' | 'change_precision';
export type ValidationStatus = 'passed' | 'failed' | 'skipped';
export type CommandKind = 'sandbox_setup' | 'forge' | 'check' | 'evidence';

export interface GroundTruth {
  intendedBehavior: string[];
  affectedDomains: string[];
  behavioralInvariants: string[];
  regressionRisks: string[];
}

export interface ForgeCliExecutionStep {
  id: string;
  arguments: string[];
  timeoutMs?: number;
  expectedExitCode?: number;
  traceFile?: string;
}

export interface ForgeCliExecution {
  interface: 'forge_cli';
  arguments?: string[];
  timeoutMs?: number;
  traceFile?: string;
  steps?: ForgeCliExecutionStep[];
}

export interface ForgeMcpCall {
  id: string;
  tool: string;
  arguments: Record<string, unknown>;
  capture?: Record<string, string>;
  expectedOutcome?: 'success' | 'error';
  timeoutMs?: number;
  restartBefore?: boolean;
  parallelGroup?: string;
}

export interface EvaluationRepositoryFixture {
  id: string;
}

export interface EvaluationScenarioFixtures {
  repositories?: EvaluationRepositoryFixture[];
}

export interface ForgeMcpExecution {
  interface: 'forge_mcp';
  profile?: 'planner' | 'executor' | 'orchestrator' | 'controller';
  toolset?: 'facade' | 'core' | 'advanced' | 'full';
  calls: ForgeMcpCall[];
}

export type ScenarioExecution = ForgeCliExecution | ForgeMcpExecution;

export interface CommandValidator {
  id: string;
  kind: ValidatorKind;
  type: 'command';
  command: string;
  arguments?: string[];
  expectedExitCode?: number;
  timeoutMs?: number;
}

export interface ChangedPathsValidator {
  id: string;
  kind: 'regression' | 'change_precision';
  type: 'changed_paths';
  requiredGlobs?: string[];
  forbiddenGlobs?: string[];
}

export interface ExecutionOutputValidator {
  id: string;
  kind: 'behavior' | 'invariant' | 'regression';
  type: 'execution_output';
  stepId?: string;
  stream?: 'stdout' | 'stderr' | 'combined';
  includes?: string[];
  excludes?: string[];
  expectedExitCode?: number;
}

export type ScenarioValidator = CommandValidator | ChangedPathsValidator | ExecutionOutputValidator;

export interface EvaluationScenario {
  schemaVersion: typeof SCENARIO_SCHEMA;
  id: string;
  title: string;
  userIntent: string;
  snapshot: {
    source: string;
    commit: string;
  };
  groundTruth: GroundTruth;
  fixtures?: EvaluationScenarioFixtures;
  execution: ScenarioExecution;
  validators: ScenarioValidator[];
  corpus?: {
    class: EvaluationCorpusClass;
    behaviorClass: EvaluationBehaviorClass;
  };
  provenance?: {
    kind?: EvaluationProvenanceKind;
    sourceCommit?: string;
    fixCommit?: string;
    references?: string[];
    note?: string;
  };
}

export interface CommandRecord {
  kind: CommandKind;
  stepId?: string;
  command: string;
  arguments: string[];
  cwd: string;
  exitCode: number | null;
  startedAt: string;
  durationMs: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface EvidenceRecord {
  domain: string;
  source: string;
  summary: string;
}

export interface ToolInteraction {
  kind: 'forge_cli' | 'forge_tool' | 'check';
  name: string;
  outcome: 'success' | 'failure';
}

export interface ValidationResult {
  id: string;
  kind: ValidatorKind | 'isolation';
  status: ValidationStatus;
  summary: string;
}

export interface SourceState {
  clean: boolean;
  statusDigest: string;
}

export interface EvaluationTrace {
  schemaVersion: typeof TRACE_SCHEMA;
  scenarioId: string;
  taskInput: string;
  snapshot: {
    commit: string;
    sourceStateBefore: SourceState;
    sourceStateAfter: SourceState;
  };
  sandbox: {
    strategy: 'git-clone-no-local';
    retained: boolean;
    path?: string;
  };
  contextRetrieval: EvidenceRecord[];
  inspectedEvidence: EvidenceRecord[];
  changedFiles: string[];
  commands: CommandRecord[];
  checks: CommandRecord[];
  toolInteractions: ToolInteraction[];
  finalResult: {
    status: 'passed' | 'failed';
    summary: string;
  };
  validation: ValidationResult[];
}

export interface ExecutionEvidence {
  contextRetrieval: EvidenceRecord[];
  inspectedEvidence: EvidenceRecord[];
  toolInteractions: ToolInteraction[];
  finalResult?: string;
}

export interface EvaluationMetrics {
  taskSuccessRate: number | null;
  impactCoverage: number | null;
  behavioralInvariantSuccess: number | null;
  regressionReintroductionRate: number | null;
  changePrecision: number | null;
  executionLatencyMs: number | null;
  toolInteractionCount: number;
}

export interface EvaluationReport {
  schemaVersion: typeof REPORT_SCHEMA;
  authority: EvaluationAuthorityClass;
  generatedAt: string;
  scenario: Pick<EvaluationScenario, 'id' | 'title' | 'userIntent' | 'groundTruth' | 'provenance'>;
  trace: EvaluationTrace;
  metrics: EvaluationMetrics;
  diagnosis: Array<{
    category: 'missed_context' | 'implementation_error' | 'verification_failure' | 'regression_reintroduced' | 'isolation_failure';
    detail: string;
  }>;
}

export interface ForgeCommand {
  executable: string;
  prefixArguments?: string[];
}

export interface RunEvaluationInput {
  scenario: EvaluationScenario;
  repositoryRoot?: string;
  forgeCommand?: ForgeCommand;
  outputDirectory?: string;
  keepSandbox?: boolean;
}
