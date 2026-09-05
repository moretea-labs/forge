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

export function runValidators(input: {
  validators: ScenarioValidator[];
  cwd: string;
  changedFiles: string[];
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
