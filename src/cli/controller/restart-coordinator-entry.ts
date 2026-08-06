#!/usr/bin/env bun

export interface RetiredRestartCoordinatorResult {
  ok: false;
  code: 'RUNTIME_LIFECYCLE_ACTION_RETIRED';
  message: string;
}

export function retiredRestartCoordinatorResult(): RetiredRestartCoordinatorResult {
  return {
    ok: false,
    code: 'RUNTIME_LIFECYCLE_ACTION_RETIRED',
    message: 'Runtime restart is owned exclusively by the canonical Runtime service.',
  };
}

if (import.meta.main) {
  const result = retiredRestartCoordinatorResult();
  if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else console.error(`${result.code}: ${result.message}`);
  process.exitCode = 2;
}
