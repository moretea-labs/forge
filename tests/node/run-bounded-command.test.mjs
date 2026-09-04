import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const runner = fileURLToPath(new URL('../../scripts/run-bounded-command.mjs', import.meta.url));

test('bounded command preserves a successful child exit', () => {
  const result = spawnSync(process.execPath, [runner, '--timeout-ms', '1000', '--', process.execPath, '-e', 'process.exit(0)'], {
    encoding: 'utf8',
    timeout: 10_000,
  });
  assert.equal(result.status, 0, result.stderr);
});

test('bounded command ends a hung child with a deterministic timeout exit', () => {
  const result = spawnSync(process.execPath, [runner, '--timeout-ms', '50', '--', process.execPath, '-e', 'setInterval(() => {}, 1_000)'], {
    encoding: 'utf8',
    timeout: 10_000,
  });
  assert.equal(result.status, 124, result.stderr);
  assert.match(result.stderr, /Timed out after 50ms/);
});

test('bounded command reports a start failure as an ordinary command failure', () => {
  const result = spawnSync(process.execPath, [runner, '--timeout-ms', '1000', '--', '/definitely-not-a-command'], {
    encoding: 'utf8',
    timeout: 10_000,
  });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /Failed to start/);
});
