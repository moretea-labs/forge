import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const CLI = join(import.meta.dir, '../../src/cli/index.ts');

function invoke(root: string, args: string[]) {
  const child = spawnSync('bun', [CLI, 'chatgpt', ...args, '--repo', root], {
    encoding: 'utf8',
    timeout: 20_000,
  });
  expect(child.error).toBeUndefined();
  return { exitCode: child.status, result: JSON.parse(child.stdout) as {
    status: string;
    sessionId: string;
    error?: { code: string };
  } };
}

describe('ChatGPT browser CLI exit status', () => {
  test('failed consult exits nonzero while retaining a structured failure receipt', () => {
    const root = mkdtempSync(join(tmpdir(), 'forge-chatgpt-cli-status-'));
    try {
      // Unsupported Bridge model selection fails locally before any browser send.
      const call = invoke(root, ['browser-consult', '--provider', 'bridge', '--model', 'unsupported-model', '--prompt', 'do not send']);
      expect(call.exitCode).toBe(1);
      expect(call.result.status).toBe('failed');
      expect(call.result.error?.code).toBe('BRIDGE_MODEL_SELECTION_UNSUPPORTED');
      expect(call.result.sessionId).toBeTruthy();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('dry-run remains successful, while a failed follow-up exits nonzero', () => {
    const root = mkdtempSync(join(tmpdir(), 'forge-chatgpt-cli-followup-'));
    try {
      const preview = invoke(root, ['browser-consult', '--provider', 'bridge', '--prompt', 'do not send', '--dry-run']);
      expect(preview.exitCode).toBe(0);
      expect(preview.result.status).toBe('dry_run');

      const followup = invoke(root, ['browser-followup', '--session', preview.result.sessionId, '--provider', 'bridge', '--model', 'unsupported-model', '--prompt', 'do not send']);
      expect(followup.exitCode).toBe(1);
      expect(followup.result.status).toBe('failed');
      expect(followup.result.error?.code).toBe('BRIDGE_MODEL_SELECTION_UNSUPPORTED');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
