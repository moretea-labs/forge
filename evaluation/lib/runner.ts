import { resolve } from 'node:path';
import { buildReport, writeReport } from './report.ts';
import { loadExecutionEvidence } from './execution-evidence.ts';
import { assertOutsideSource, changedFiles, cleanupIsolatedSnapshot, createIsolatedSnapshot, inspectSourceState, resolveSourcePath } from './sandbox.ts';
import { captureCommand, commandSucceeded } from './trace.ts';
import { runValidators } from './validators.ts';
import { TRACE_SCHEMA, type EvaluationReport, type EvaluationTrace, type RunEvaluationInput, type SourceState, type ValidationResult } from './types.ts';

function sameSourceState(left: SourceState, right: SourceState): boolean {
  return left.clean === right.clean && left.statusDigest === right.statusDigest;
}

export function runEvaluation(input: RunEvaluationInput): EvaluationReport {
  const repositoryRoot = resolve(input.repositoryRoot ?? process.cwd());
  const source = resolveSourcePath(repositoryRoot, input.scenario.snapshot.source);
  if (input.outputDirectory) assertOutsideSource(source, input.outputDirectory);
  const sandbox = createIsolatedSnapshot(source, input.scenario.snapshot.commit);
  const commands = [...sandbox.setupCommands];
  const retained = input.keepSandbox === true;
  try {
    const forgeCommand = input.forgeCommand ?? { executable: 'forge' };
    const execution = captureCommand({
      kind: 'forge',
      command: forgeCommand.executable,
      arguments: [...(forgeCommand.prefixArguments ?? []), ...input.scenario.execution.arguments],
      cwd: sandbox.repository,
      timeoutMs: input.scenario.execution.timeoutMs ?? 60_000,
      env: {
        ...process.env,
        FORGE_EVALUATION: '1',
        FORGE_EVALUATION_SANDBOX: sandbox.repository,
      },
    });
    commands.push(execution);
    const executionEvidence = loadExecutionEvidence(sandbox.repository, input.scenario.execution.traceFile);
    const changes = changedFiles(sandbox.repository);
    commands.push(...changes.commands);
    const traceArtifact = input.scenario.execution.traceFile?.replaceAll('\\', '/').replace(/^\.\//, '');
    const taskChangedFiles = changes.files.filter((path) => path !== traceArtifact);
    const validations = runValidators({
      validators: input.scenario.validators,
      cwd: sandbox.repository,
      changedFiles: taskChangedFiles,
    });
    const sourceAfter = inspectSourceState(source);
    const sourceStateAfter = sourceAfter.state;
    commands.push(sourceAfter.command);
    const isolation: ValidationResult = sameSourceState(sandbox.sourceStateBefore, sourceStateAfter)
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
        sourceStateBefore: sandbox.sourceStateBefore,
        sourceStateAfter,
      },
      sandbox: { strategy: 'git-clone-no-local', retained, ...(retained ? { path: sandbox.root } : {}) },
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
  } finally {
    if (!retained) cleanupIsolatedSnapshot(sandbox.root);
  }
}
