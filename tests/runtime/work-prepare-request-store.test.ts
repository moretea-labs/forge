import { afterEach, describe, expect, test } from 'bun:test';
import { spawn } from 'child_process';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { pathToFileURL } from 'url';
import { withWorkPrepareRequest } from '../../src/runtime/control-plane/execution/work-prepare-request-store';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

interface ClaimResult {
  workId: string;
  reused: boolean;
}

function claimFromProcess(controllerHome: string, proposedWorkId: string): Promise<ClaimResult> {
  const moduleUrl = pathToFileURL(join(process.cwd(), 'src/runtime/control-plane/execution/work-prepare-request-store.ts')).href;
  const input = {
    controllerHome,
    repoId: 'repo-work-prepare-race',
    sessionId: 'session-work-prepare-race',
    principalId: 'principal-work-prepare-race',
    requestId: 'request-work-prepare-race',
    fingerprint: 'fingerprint-work-prepare-race',
    proposedWorkId,
  };
  const source = `
    import { withWorkPrepareRequest } from ${JSON.stringify(moduleUrl)};
    const input = ${JSON.stringify(input)};
    const result = withWorkPrepareRequest(input, (record, reused) => {
      if (!reused) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 150);
      return { workId: record.workId, reused };
    });
    process.stdout.write(JSON.stringify(result));
  `;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', source], {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code) => {
      if (code !== 0) {
        reject(new Error(stderr || `work prepare claimant exited ${code}`));
        return;
      }
      resolve(JSON.parse(stdout) as ClaimResult);
    });
  });
}

describe('work_prepare request store', () => {
  test('retains the original owner when preparation fails before completion', () => {
    const controllerHome = mkdtempSync(join(tmpdir(), 'repo-harness-work-prepare-recovery-'));
    roots.push(controllerHome);
    const input = {
      controllerHome,
      repoId: 'repo-work-prepare-recovery',
      sessionId: 'session-work-prepare-recovery',
      principalId: 'principal-work-prepare-recovery',
      requestId: 'request-work-prepare-recovery',
      fingerprint: 'fingerprint-work-prepare-recovery',
      proposedWorkId: 'work-original-owner',
    };

    expect(() => withWorkPrepareRequest(input, () => {
      throw new Error('simulated preparation interruption');
    })).toThrow('simulated preparation interruption');

    const recovered = withWorkPrepareRequest(
      { ...input, proposedWorkId: 'work-must-not-win' },
      (record, reused) => ({ workId: record.workId, status: record.status, reused }),
    );
    expect(recovered).toEqual({ workId: 'work-original-owner', status: 'claimed', reused: true });

    const afterCompletion = withWorkPrepareRequest(
      { ...input, proposedWorkId: 'work-still-must-not-win' },
      (record, reused) => ({ workId: record.workId, status: record.status, reused }),
    );
    expect(afterCompletion).toEqual({ workId: 'work-original-owner', status: 'prepared', reused: true });
  });

  test('serializes competing processes and reuses the durable owner after restart', async () => {
    const controllerHome = mkdtempSync(join(tmpdir(), 'repo-harness-work-prepare-race-'));
    roots.push(controllerHome);

    const [left, right] = await Promise.all([
      claimFromProcess(controllerHome, 'work-left'),
      claimFromProcess(controllerHome, 'work-right'),
    ]);

    expect(left.workId).toBe(right.workId);
    expect(new Set([left.workId, right.workId]).size).toBe(1);
    expect(['work-left', 'work-right']).toContain(left.workId);
    expect([left.reused, right.reused].filter((value) => value === false)).toHaveLength(1);
    expect([left.reused, right.reused].filter((value) => value === true)).toHaveLength(1);

    const afterRestart = await claimFromProcess(controllerHome, 'work-after-restart');
    expect(afterRestart).toEqual({ workId: left.workId, reused: true });
  });
});
