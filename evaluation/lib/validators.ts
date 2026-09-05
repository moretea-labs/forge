import { captureCommand, commandSucceeded } from './trace.ts';
import type { CommandRecord, ScenarioValidator, ValidationResult } from './types.ts';

function globMatches(path: string, pattern: string): boolean {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, ':::DOUBLE_STAR:::')
    .replace(/\*/g, '[^/]*')
    .replace(/:::DOUBLE_STAR:::/g, '.*');
  return new RegExp(`^${escaped}$`).test(path);
}

function outputFor(command: CommandRecord, stream: 'stdout' | 'stderr' | 'combined'): string {
  if (stream === 'stderr') return command.stderr;
  if (stream === 'combined') return `${command.stdout}\n${command.stderr}`;
  return command.stdout;
}

export function runValidators(input: {
  validators: ScenarioValidator[];
  cwd: string;
  changedFiles: string[];
  executionCommands?: CommandRecord[];
  env?: NodeJS.ProcessEnv;
}): { results: ValidationResult[]; commands: CommandRecord[] } {
  const results: ValidationResult[] = [];
  const commands: CommandRecord[] = [];
  for (const validator of input.validators) {
    if (validator.type === 'command') {
      const command = captureCommand({
        kind: 'check',
        command: validator.command,
        arguments: validator.arguments ?? [],
        cwd: input.cwd,
        timeoutMs: validator.timeoutMs ?? 60_000,
        env: input.env,
      });
      commands.push(command);
      const expected = validator.expectedExitCode ?? 0;
      const passed = commandSucceeded(command, expected);
      results.push({
        id: validator.id,
        kind: validator.kind,
        status: passed ? 'passed' : 'failed',
        summary: passed
          ? `Command exited ${expected} as expected.`
          : `Expected exit ${expected}; received ${command.exitCode ?? 'no exit'}${command.timedOut ? ' (timed out)' : ''}.`,
      });
      continue;
    }

    if (validator.type === 'execution_output') {
      const executionCommands = input.executionCommands ?? [];
      const command = validator.stepId
        ? executionCommands.find((entry) => entry.stepId === validator.stepId)
        : executionCommands.at(-1);
      if (!command) {
        results.push({ id: validator.id, kind: validator.kind, status: 'failed', summary: `Execution step ${validator.stepId ?? '(last)'} was not captured.` });
        continue;
      }
      const stream = validator.stream ?? 'stdout';
      const output = outputFor(command, stream);
      const missing = (validator.includes ?? []).filter((needle) => !output.includes(needle));
      const forbidden = (validator.excludes ?? []).filter((needle) => output.includes(needle));
      const exitMatches = validator.expectedExitCode === undefined || command.exitCode === validator.expectedExitCode;
      const passed = missing.length === 0 && forbidden.length === 0 && exitMatches && !command.timedOut;
      results.push({
        id: validator.id,
        kind: validator.kind,
        status: passed ? 'passed' : 'failed',
        summary: passed
          ? `Captured ${stream} matched the evaluator-owned execution oracle.`
          : [
              ...(missing.length > 0 ? [`Missing output token(s): ${missing.join(', ')}`] : []),
              ...(forbidden.length > 0 ? [`Forbidden output token(s): ${forbidden.join(', ')}`] : []),
              ...(!exitMatches ? [`Expected exit ${validator.expectedExitCode}; received ${command.exitCode ?? 'no exit'}.`] : []),
              ...(command.timedOut ? ['Execution timed out.'] : []),
            ].join('; '),
      });
      continue;
    }

    const requiredGlobs = validator.requiredGlobs ?? [];
    const forbiddenGlobs = validator.forbiddenGlobs ?? [];
    const missingRequired = requiredGlobs.filter((glob) => !input.changedFiles.some((path) => globMatches(path, glob)));
    const forbiddenMatches = input.changedFiles.filter((path) => forbiddenGlobs.some((glob) => globMatches(path, glob)));
    const passed = missingRequired.length === 0 && forbiddenMatches.length === 0;
    results.push({
      id: validator.id,
      kind: validator.kind,
      status: passed ? 'passed' : 'failed',
      summary: passed
        ? 'Required changed paths were present and no protected path changed.'
        : [
            ...(missingRequired.length > 0 ? [`Missing required changed path pattern(s): ${missingRequired.join(', ')}`] : []),
            ...(forbiddenMatches.length > 0 ? [`Changed protected path(s): ${forbiddenMatches.join(', ')}`] : []),
          ].join('; '),
    });
  }
  return { results, commands };
}
