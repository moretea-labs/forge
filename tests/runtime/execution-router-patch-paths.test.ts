import { expect, test } from 'bun:test';
import { claimPathWrites } from '../../src/runtime/execution/process-runtime/resource-claims';
import { extractPatchPaths } from '../../src/runtime/execution/thin-harness/execution-router';

test('move mutation claims include both source and destination paths', () => {
  const paths = extractPatchPaths([
    { type: 'replace', path: 'src\\ordinary.ts' },
    { type: 'move', path: 'src/old.ts', to_path: 'src/new.ts' },
    { type: 'move', path: 'src/legacy.ts', toPath: 'src/new.ts' },
  ]);

  expect(paths).toEqual([
    'src/ordinary.ts',
    'src/old.ts',
    'src/new.ts',
    'src/legacy.ts',
  ]);
  expect(claimPathWrites(paths, 'checkout-1', 'repo-1')).toEqual([
    { resourceKey: 'path:checkout-1:src/ordinary.ts', mode: 'write' },
    { resourceKey: 'path:checkout-1:src/old.ts', mode: 'write' },
    { resourceKey: 'path:checkout-1:src/new.ts', mode: 'write' },
    { resourceKey: 'path:checkout-1:src/legacy.ts', mode: 'write' },
  ]);
});
