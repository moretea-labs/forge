import { afterEach, expect, test } from 'bun:test';
import { spawn, type ChildProcess } from 'child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { withControllerLock } from '../../src/cli/repositories/locks';
import {
  createWorkContract,
  getWorkContract,
  type VerificationRecord,
  type WorkContract,
} from '../../packages/kernel/work/api/index';
import {
  readControlPlaneRecord,
  writeControlPlaneRecord,
} from '../../src/runtime/control-plane/persistence/sqlite-store';

const homes: string[] = [];

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function fixture(suffix: string) {
  const controllerHome = mkdtempSync(join(tmpdir(), `forge-work-atomicity-${suffix}-`));
  homes.push(controllerHome);
  const repoId = `repo-work-atomicity-${suffix}`;
  const workId = `work-atomicity-${suffix}`;
  createWorkContract({ controllerHome, repoId }, {
    workId,
    repoId,
    checkoutId: `checkout-${suffix}`,
    baseRevision: 'revision-atomicity',
    mode: 'goal_workloop',
    objective: 'Prove WorkContract read-modify-write authority is atomic.',
    acceptanceCriteria: ['Preserve compatible concurrent mutations.'],
    allowedPaths: ['src/**'],
    forbiddenPaths: [],
    checks: ['check:atomic-a', 'check:atomic-b'],
    constraints: { requireHandoffOnAmbiguity: true },
    requestedBy: 'chatgpt',
    workKind: 'repository_change',
    status: 'running',
    phase: 'implementation',
  });
  return { controllerHome, repoId, workId };
}

function verificationRecord(input: {
  repoId: string;
  workId: string;
  checkId: string;
  receiptId: string;
}): VerificationRecord {
  const recordedAt = '2026-09-14T03:40:00.000Z';
  return {
    checkId: input.checkId,
    outcome: 'valid_pass',
    summary: `verification ${input.receiptId}`,
    recordedAt,
    sourceRevision: 'revision-atomicity',
    workspaceFingerprint: 'workspace-atomicity',
    verificationInputFingerprint: `verification-${input.checkId}`,
    receipt: {
      schemaVersion: 1,
      receiptId: input.receiptId,
      resultDigest: `digest-${input.receiptId}`,
      repoId: input.repoId,
      checkoutId: 'checkout-atomicity',
      workId: input.workId,
      checkId: input.checkId,
      processId: `process-${input.receiptId}`,
      commandId: input.checkId,
      status: 'passed',
      runtimeStatus: 'succeeded',
      ok: true,
      exitCode: 0,
      timedOut: false,
      cancelled: false,
      artifactPath: `.ai/harness/checks/${input.receiptId}.json`,
      summary: 'atomicity verification fixture',
      startedAt: recordedAt,
      finishedAt: recordedAt,
    },
  };
}

interface ChildSpec {
  operation: 'verification' | 'scope';
  value: string;
  record?: VerificationRecord;
}

async function runConcurrentMutations(input: {
  controllerHome: string;
  repoId: string;
  workId: string;
  children: [ChildSpec, ChildSpec];
}): Promise<void> {
  const startFile = join(input.controllerHome, `start-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const moduleUrl = new URL('../../packages/kernel/work/api/index.ts', import.meta.url).href;
  const script = `
    import { existsSync, writeFileSync } from 'fs';
    writeFileSync(process.env.READY_FILE, 'ready\\n');
    while (!existsSync(process.env.START_FILE)) await Bun.sleep(1);
    const work = await import(process.env.WORK_MODULE);
    const options = { controllerHome: process.env.CONTROLLER_HOME, repoId: process.env.REPO_ID };
    let lastError = '';
    for (let attempt = 0; attempt < 200; attempt += 1) {
      try {
        if (process.env.OPERATION === 'verification') {
          work.appendVerificationRecord(options, process.env.WORK_ID, JSON.parse(process.env.RECORD));
        } else {
          work.recordWorkScopeEvidence(options, process.env.WORK_ID, { inspectedPaths: [process.env.VALUE] });
        }
        console.log(JSON.stringify({ ok: true, attempts: attempt + 1 }));
        process.exit(0);
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
        if (!lastError.startsWith('LOCK_HELD:')) break;
        await Bun.sleep(5);
      }
    }
    console.log(JSON.stringify({ ok: false, error: lastError || 'mutation retry budget exhausted' }));
  `;
  const spawned: ChildProcess[] = [];
  const readyFiles = input.children.map((_, index) => join(input.controllerHome, `ready-${index}-${Date.now()}-${Math.random().toString(16).slice(2)}`));
  const pause = new Int32Array(new SharedArrayBuffer(4));
  const resource = `work-contract-store-${input.repoId}`;

  withControllerLock(input.controllerHome, { scope: 'global', resource }, `atomicity-test-fence:${input.workId}`, () => {
    for (const [index, child] of input.children.entries()) {
      spawned.push(spawn(process.execPath, ['-e', script], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          READY_FILE: readyFiles[index],
          START_FILE: startFile,
          WORK_MODULE: moduleUrl,
          CONTROLLER_HOME: input.controllerHome,
          REPO_ID: input.repoId,
          WORK_ID: input.workId,
          OPERATION: child.operation,
          VALUE: child.value,
          RECORD: child.record ? JSON.stringify(child.record) : '',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      }));
    }
    const deadline = Date.now() + 5_000;
    while (readyFiles.some((path) => !existsSync(path))) {
      if (Date.now() >= deadline) throw new Error('WORK_ATOMICITY_CHILD_READY_TIMEOUT');
      Atomics.wait(pause, 0, 0, 5);
    }
    writeFileSync(startFile, 'go\n');
    // Old code could read Work before reaching this writer fence. Current code
    // reaches the fail-fast lock before its semantic read; retryable contention
    // therefore forces a fresh read after the predecessor mutation completes.
    Atomics.wait(pause, 0, 0, 200);
  }, undefined, 5_000);

  await Promise.all(spawned.map((child) => new Promise<void>((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk) => { stdout += chunk; });
    child.stderr?.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code) => {
      if (code !== 0) {
        reject(new Error(`Work atomicity child exited ${code}: ${stderr || stdout}`));
        return;
      }
      const line = stdout.trim().split('\n').filter(Boolean).at(-1);
      const result = line ? JSON.parse(line) as { ok: boolean; error?: string } : undefined;
      if (!result?.ok) {
        reject(new Error(`Work atomicity child failed: ${result?.error ?? stderr ?? 'missing result'}`));
        return;
      }
      resolve();
    });
  })));
}

test('serializes cross-process VerificationRecord append read-modify-write under the Work writer lock', async () => {
  const fx = fixture('verification');
  const first = verificationRecord({ repoId: fx.repoId, workId: fx.workId, checkId: 'check:atomic-a', receiptId: 'receipt-atomic-a' });
  const second = verificationRecord({ repoId: fx.repoId, workId: fx.workId, checkId: 'check:atomic-b', receiptId: 'receipt-atomic-b' });

  await runConcurrentMutations({
    ...fx,
    children: [
      { operation: 'verification', value: 'a', record: first },
      { operation: 'verification', value: 'b', record: second },
    ],
  });

  const current = getWorkContract({ controllerHome: fx.controllerHome, repoId: fx.repoId }, fx.workId)!;
  expect(new Set(current.checkRefs.map((record) => record.receipt?.receiptId))).toEqual(new Set(['receipt-atomic-a', 'receipt-atomic-b']));
});

test('serializes cross-process scope evidence merges instead of overwriting a stale nested snapshot', async () => {
  const fx = fixture('scope');
  await runConcurrentMutations({
    ...fx,
    children: [
      { operation: 'scope', value: 'src/alpha.ts' },
      { operation: 'scope', value: 'src/beta.ts' },
    ],
  });

  const current = getWorkContract({ controllerHome: fx.controllerHome, repoId: fx.repoId }, fx.workId)!;
  expect(new Set(current.scopeEvidence?.inspectedPaths ?? [])).toEqual(new Set(['src/alpha.ts', 'src/beta.ts']));
});

test('persists the exact historical v3 review-gap migration once and rejects broader malformed v3 rows', () => {
  const fx = fixture('legacy-review-gap');
  const options = { controllerHome: fx.controllerHome, repoId: fx.repoId };
  const record = readControlPlaneRecord<WorkContract>(fx.controllerHome, 'work_contract', fx.repoId, fx.workId)!;
  const historical = structuredClone(record.value);
  const historicalPhaseEvidence = historical.phaseEvidence as Partial<WorkContract['phaseEvidence']>;
  delete historicalPhaseEvidence.review;
  writeControlPlaneRecord(fx.controllerHome, {
    namespace: 'work_contract', scope: fx.repoId, key: fx.workId, schemaVersion: 3,
    value: historical, action: 'fixture_v3_review_gap', expectedRevision: record.revision,
  });
  const seeded = readControlPlaneRecord<WorkContract>(fx.controllerHome, 'work_contract', fx.repoId, fx.workId)!;

  const migrated = getWorkContract(options, fx.workId)!;
  expect(migrated.phaseEvidence.review).toBeDefined();
  const persisted = readControlPlaneRecord<WorkContract>(fx.controllerHome, 'work_contract', fx.repoId, fx.workId)!;
  expect(persisted.revision).toBe(seeded.revision + 1);
  expect(persisted.value.phaseEvidence.review).toEqual(migrated.phaseEvidence.review);
  expect(getWorkContract(options, fx.workId)?.phaseEvidence.review).toEqual(persisted.value.phaseEvidence.review);
  expect(readControlPlaneRecord<WorkContract>(fx.controllerHome, 'work_contract', fx.repoId, fx.workId)?.revision).toBe(persisted.revision);

  const malformedId = 'work-malformed-current-v3';
  createWorkContract(options, {
    workId: malformedId,
    repoId: fx.repoId,
    mode: 'goal_workloop',
    objective: 'Malformed current-schema fixture.',
    acceptanceCriteria: [],
    allowedPaths: [],
    forbiddenPaths: [],
    checks: [],
    constraints: { requireHandoffOnAmbiguity: true },
    requestedBy: 'chatgpt',
    status: 'running',
  });
  const malformedRecord = readControlPlaneRecord<WorkContract>(fx.controllerHome, 'work_contract', fx.repoId, malformedId)!;
  const malformed = structuredClone(malformedRecord.value);
  const malformedPhaseEvidence = malformed.phaseEvidence as Partial<WorkContract['phaseEvidence']>;
  delete malformedPhaseEvidence.review;
  delete malformedPhaseEvidence.verification;
  writeControlPlaneRecord(fx.controllerHome, {
    namespace: 'work_contract', scope: fx.repoId, key: malformedId, schemaVersion: 3,
    value: malformed, action: 'fixture_malformed_current_v3', expectedRevision: malformedRecord.revision,
  });
  expect(() => getWorkContract(options, malformedId)).toThrow();
});
