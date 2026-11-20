import { describe, expect, test } from 'bun:test';
import { claimsForRepositoryCommand } from '../../src/runtime/execution/process-runtime/resource-claims';
import { claimsConflict } from '../../src/runtime/resources/claims/conflicts';

describe('Runtime release build resource claims', () => {
  test('stage-only builds use an immutable source observation, not a checkout writer', () => {
    const command = [
      'bun', 'bin/forge.mjs', 'runtime', 'service', 'install',
      '--controller-home', '/home/greyson/.forge/controller',
      '--repo', '/home/greyson/src/forge-wsl-parity-20261117',
      '--stage-only',
    ];
    const claims = claimsForRepositoryCommand(command, 'repo1', 'co1');
    expect(claims).toContainEqual({ resourceKey: 'validation-input:co1', mode: 'read' });
    expect(claims).toContainEqual({ resourceKey: 'build-cache:repo1', mode: 'write' });
    expect(claims).toContainEqual({ resourceKey: 'heavy-check:repo1', mode: 'exclusive' });
    expect(claims.some((claim) => claim.resourceKey === 'workspace:co1')).toBe(false);
    expect(claimsConflict(
      { resourceKey: 'path:co1:src/runtime/example.ts', mode: 'write' },
      { resourceKey: 'validation-input:co1', mode: 'read' },
    )).toBe(false);

    const activation = claimsForRepositoryCommand(command.filter((part) => part !== '--stage-only'), 'repo1', 'co1');
    expect(activation.some((claim) => claim.resourceKey === 'validation-input:co1')).toBe(false);
  });
});
