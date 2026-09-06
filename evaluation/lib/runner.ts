import { resolve } from 'node:path';
import { buildReport, writeReport } from './report.ts';
import { loadExecutionEvidence } from './execution-evidence.ts';
import { assertOutsideSource, changedFiles, cleanupIsolatedSnapshot, createIsolatedSnapshot, inspectSourceState, isolatedEvaluationEnvironment, resolveSourcePath, type IsolatedSnapshot } from './sandbox.ts';
import { candidateTimeRemaining, captureCommand, commandSucceeded } from './trace.ts';
import { runValidators } from './validators.ts';
import { TRACE_SCHEMA, type CommandRecord, type EvaluationReport, type EvaluationTrace, type ForgeCliExecutionStep, type RunEvaluationInput, type SourceState, type ValidationResult } from './types.ts';

function sameSourceState(left: SourceState, right: SourceState): boolean {
  return left.clean === right.clean && left.statusDigest === right.statusDigest;
}

function executionSteps(input: RunEvaluationInput['scenario']): ForgeCliExecutionStep[] {
  if (input.execution.interface !== 'forge_cli') throw new Error(`Evaluation scenario ${input.id} uses ${input.execution.interface}; use the matching public-surface runner.`);
  if (input.execution.steps) return input.execution.steps.map((step) => ({ ...step, arguments: [...step.arguments] }));
  if (!input.execution.arguments) throw new Error(`Evaluation scenario ${input.id} has no executable CLI arguments.`);
  return [{
    id: 'default',
    arguments: [...input.execution.arguments],
    timeoutMs: input.execution.timeoutMs,
    expectedExitCode: 0,
    traceFile: input.execution.traceFile,
  }];
}

export function runEvaluationInSnapshot(input: {
  executionTimeoutMs?: number;
  scenario: RunEvaluationInput['scenario'];
  sandbox: IsolatedSnapshot;
  forgeCommand?: RunEvaluationInput['forgeCommand'];
  outputDirectory?: string;
  retained?: boolean;
  env?: NodeJS.ProcessEnv;
}): EvaluationReport {
  const retained = input.retained === true;
  const scenario = input.scenario;
  const executionConfig = scenario.execution;
  if (executionConfig.interface !== 'forge_cli') throw new Error(`Evaluation scenario ${scenario.id} requires the public MCP runner.`);
  const forgeCommand = input.forgeCommand ?? { executable: 'forge' };
  const environment = input.env ?? isolatedEvaluationEnvironment(input.sandbox);
  const commands = [...input.sandbox.setupCommands];
  const executions: CommandRecord[] = [];
  const evidenceRecords = [] as ReturnType<typeof loadExecutionEvidence>[];
  let executionPassed = true;
  const deadline = performance.now() + (input.executionTimeoutMs ?? Infinity);

  for (const step of executionSteps(scenario)) {
    const execution = {
      ...captureCommand({
        kind: 'forge',
        command: forgeCommand.executable,
        arguments: [...(forgeCommand.prefixArguments ?? []), ...step.arguments],
        cwd: input.sandbox.repository,
        timeoutMs: Math.min(candidateTimeRemaining(deadline), step.timeoutMs ?? executionConfig.timeoutMs ?? 60_000),
        env: environment,
      }),
      stepId: step.id,
    };
    commands.push(execution);
    executions.push(execution);
    if (execution.timedOut && input.executionTimeoutMs !== undefined) throw new Error('EVALUATION_CANDIDATE_TIMEOUT:cli_execution');
    const expectedExitCode = step.expectedExitCode ?? 0;
    if (!commandSucceeded(execution, expectedExitCode)) executionPassed = false;
    const traceFile = step.traceFile ?? executionConfig.traceFile;
    if (traceFile) evidenceRecords.push(loadExecutionEvidence(input.sandbox.repository, traceFile));
  }

  const changes = changedFiles(input.sandbox.repository);
  commands.push(...changes.commands);
  const traceArtifacts = new Set(
    executionSteps(scenario)
      .map((step) => step.traceFile ?? executionConfig.traceFile)
      .filter((value): value is string => Boolean(value))
      .map((value) => value.replaceAll('\\', '/').replace(/^\.\//, '')),
  );
  const taskChangedFiles = changes.files.filter((path) => !traceArtifacts.has(path));
  const validations = runValidators({
    validators: scenario.validators,
    cwd: input.sandbox.repository,
    changedFiles: taskChangedFiles,
    executionCommands: executions,
    env: environment,
  });
  const sourceAfter = inspectSourceState(input.sandbox.source);
  const sourceStateAfter = sourceAfter.state;
  commands.push(sourceAfter.command);
  const isolation: ValidationResult = sameSourceState(input.sandbox.sourceStateBefore, sourceStateAfter)
    ? { id: 'source-repository-unchanged', kind: 'isolation', status: 'passed', summary: 'Source Git status was unchanged before and after the evaluation.' }
    : { id: 'source-repository-unchanged', kind: 'isolation', status: 'failed', summary: 'Source Git status changed during evaluation; do not trust this result.' };
  const evidenceErrors = evidenceRecords
    .map((entry) => entry.error)
    .filter((value): value is string => Boolean(value));
  const validation = [
    ...validations.results,
    ...evidenceErrors.map((error, index) => ({ id: `execution-trace-${index + 1}`, kind: 'behavior' as const, status: 'failed' as const, summary: error })),
    isolation,
  ];
  const passed = executionPassed && validation.every((result) => result.status === 'passed');
  const trace: EvaluationTrace = {
    schemaVersion: TRACE_SCHEMA,
    scenarioId: scenario.id,
    taskInput: scenario.userIntent,
    snapshot: {
      commit: scenario.snapshot.commit,
      sourceStateBefore: input.sandbox.sourceStateBefore,
      sourceStateAfter,
    },
    sandbox: { strategy: 'git-clone-no-local', retained, ...(retained ? { path: input.sandbox.root } : {}) },
    contextRetrieval: evidenceRecords.flatMap((entry) => entry.evidence.contextRetrieval),
    inspectedEvidence: evidenceRecords.flatMap((entry) => entry.evidence.inspectedEvidence),
    changedFiles: taskChangedFiles,
    commands,
    checks: validations.commands,
    toolInteractions: [
      ...executions.map((execution) => ({ kind: 'forge_cli' as const, name: execution.stepId ?? forgeCommand.executable, outcome: commandSucceeded(execution, executionConfig.steps?.find((step) => step.id === execution.stepId)?.expectedExitCode ?? 0) ? 'success' as const : 'failure' as const })),
      ...evidenceRecords.flatMap((entry) => entry.evidence.toolInteractions),
      ...validations.commands.map((command) => ({ kind: 'check' as const, name: command.command, outcome: commandSucceeded(command) ? 'success' as const : 'failure' as const })),
    ],
    finalResult: {
      status: passed ? 'passed' : 'failed',
      summary: [...evidenceRecords].reverse().find((entry) => entry.evidence.finalResult)?.evidence.finalResult
        ?? (passed ? 'Forge execution and all validators passed in an isolated snapshot.' : 'Forge execution or validation failed; inspect the trace and diagnosis.'),
    },
    validation,
  };
  const report = buildReport(scenario, trace);
  if (input.outputDirectory) writeReport(input.outputDirectory, report);
  return report;
}

export function runEvaluation(input: RunEvaluationInput): EvaluationReport {
  const repositoryRoot = resolve(input.repositoryRoot ?? process.cwd());
  const source = resolveSourcePath(repositoryRoot, input.scenario.snapshot.source);
  if (input.outputDirectory) assertOutsideSource(source, input.outputDirectory);
  const sandbox = createIsolatedSnapshot(source, input.scenario.snapshot.commit);
  const retained = input.keepSandbox === true;
  try {
    return runEvaluationInSnapshot({
      scenario: input.scenario,
      sandbox,
      forgeCommand: input.forgeCommand,
      outputDirectory: input.outputDirectory,
      retained,
      env: isolatedEvaluationEnvironment(sandbox),
    });
  } finally {
    if (!retained) cleanupIsolatedSnapshot(sandbox.root);
  }
}
