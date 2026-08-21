export const SCENARIO_SCHEMA = 'forge-evaluation-scenario/v1' as const;
export const TRACE_SCHEMA = 'forge-evaluation-trace/v1' as const;
export const REPORT_SCHEMA = 'forge-evaluation-report/v1' as const;

export type ValidatorKind = 'behavior' | 'invariant' | 'regression' | 'change_precision';
export type ValidationStatus = 'passed' | 'failed' | 'skipped';
export type CommandKind = 'sandbox_setup' | 'forge' | 'check' | 'evidence';

export interface GroundTruth {
  intendedBehavior: string[];
  affectedDomains: string[];
  behavioralInvariants: string[];
  regressionRisks: string[];
}

export interface ForgeCliExecution {
  interface: 'forge_cli';
  arguments: string[];
  timeoutMs?: number;
  traceFile?: string;
}

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

export type ScenarioValidator = CommandValidator | ChangedPathsValidator;

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
  execution: ForgeCliExecution;
  validators: ScenarioValidator[];
  provenance?: {
    sourceCommit?: string;
    fixCommit?: string;
    note?: string;
  };
}

export interface CommandRecord {
  kind: CommandKind;
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
