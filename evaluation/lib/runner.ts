import { resolve } from 'node:path';
import { buildReport, writeReport } from './report.ts';
import { loadExecutionEvidence } from './execution-evidence.ts';
import { assertOutsideSource, changedFiles, cleanupIsolatedSnapshot, createIsolatedSnapshot, inspectSourceState, isolatedEvaluationEnvironment, resolveSourcePath, type IsolatedSnapshot } from './sandbox.ts';
import { captureCommand, commandSucceeded } from './trace.ts';
import { runValidators } from './validators.ts';
import { TRACE_SCHEMA, type EvaluationReport, type EvaluationTrace, type RunEvaluationInput, type SourceState, type ValidationResult } from './types.ts';

function sameSourceState(left: SourceState, right: SourceState): boolean {
  return left.clean === right.clean && left.statusDigest === right.statusDigest;
}

export function runEvaluationInSnapshot(input: {
  scenario: RunEvaluationInput['scenario'];
  sandbox: IsolatedSnapshot;
  forgeCommand?: RunEvaluationInput['forgeCommand'];
  outputDirectory?: string;
  retained?: boolean;
  env?: NodeJS.ProcessEnv;
}): EvaluationReport {
  const retained = input.retained === true;
  const forgeCommand = input.forgeCommand ?? { executable: 'forge' };
  const environment = input.env ?? isolatedEvaluationEnvironment(input.sandbox);
  const commands = [...input.sandbox.setupCommands];
  const execution = captureCommand({
    kind: 'forge',
    command: forgeCommand.executable,
    arguments: [...(forgeCommand.prefixArguments ?? []), ...input.scenario.execution.arguments],
    cwd: input.sandbox.repository,
    timeoutMs: input.scenario.execution.timeoutMs ?? 60_000,
    env: environment,
  });
  commands.push(execution);
  const executionEvidence = loadExecutionEvidence(input.sandbox.repository, input.scenario.execution.traceFile);
  const changes = changedFiles(input.sandbox.repository);
  commands.push(...changes.commands);
  const traceArtifact = input.scenario.execution.traceFile?.replaceAll('\\', '/').replace(/^\.\//, '');
  const taskChangedFiles = changes.files.filter((path) => path !== traceArtifact);
  const validations = runValidators({
    validators: input.scenario.validators,
    cwd: input.sandbox.repository,
    changedFiles: taskChangedFiles,
    env: environment,
  });
  const sourceAfter = inspectSourceState(input.sandbox.source);
  const sourceStateAfter = sourceAfter.state;
  commands.push(sourceAfter.command);
  const isolation: ValidationResult = sameSourceState(input.sandbox.sourceStateBefore, sourceStateAfter)
    ? { id: 'source-repository-unchanged', kind: 'isolation', status: 'passed', summary: 'Source Git status was unchanged before and after the evaluation.' }
    : { id: 'source-repository-unchanged', kind: 'isolation', status: 'failed', summary: 'Source Git status changed during evaluation; do not trust this result.' };
  const validation = [
    ...validations.results,
    ...(executionEvidence.error ? [{ id: 'execution-trace', kind: 'behavior' as const, status: 'failed' as const, summary: executionEvidence.error }] : []),
    isolation,
  ];
  const forgeSucceeded = commandSucceeded(execution);
  const passed = forgeSucceeded && validation.every((result) => result.status === 'passed');
  const trace: EvaluationTrace = {
    schemaVersion: TRACE_SCHEMA,
    scenarioId: input.scenario.id,
    taskInput: input.scenario.userIntent,
    snapshot: {
      commit: input.scenario.snapshot.commit,
      sourceStateBefore: input.sandbox.sourceStateBefore,
      sourceStateAfter,
    },
    sandbox: { strategy: 'git-clone-no-local', retained, ...(retained ? { path: input.sandbox.root } : {}) },
    contextRetrieval: executionEvidence.evidence.contextRetrieval,
    inspectedEvidence: executionEvidence.evidence.inspectedEvidence,
    changedFiles: taskChangedFiles,
    commands,
    checks: validations.commands,
    toolInteractions: [
      { kind: 'forge_cli', name: forgeCommand.executable, outcome: forgeSucceeded ? 'success' : 'failure' },
      ...executionEvidence.evidence.toolInteractions,
      ...validations.commands.map((command) => ({ kind: 'check' as const, name: command.command, outcome: commandSucceeded(command) ? 'success' as const : 'failure' as const })),
    ],
    finalResult: {
      status: passed ? 'passed' : 'failed',
      summary: executionEvidence.evidence.finalResult
        ?? (passed ? 'Forge execution and all validators passed in an isolated snapshot.' : 'Forge execution or validation failed; inspect the trace and diagnosis.'),
    },
    validation,
  };
  const report = buildReport(input.scenario, trace);
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
