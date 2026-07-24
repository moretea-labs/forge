import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

const ROOT = join(import.meta.dir, '../..');

describe('legacy worker lifecycle hardening', () => {
  test('retired Agent worker entrypoint is absent and excluded from packaged releases', () => {
    expect(existsSync(join(ROOT, 'src/cli/agent-jobs/job-worker.ts'))).toBe(false);
    const installer = readFileSync(join(ROOT, 'src/runtime/supervisor/installer.ts'), 'utf8');
    expect(installer).not.toContain('agent-worker.js');
  });
});
