import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readPlanContractStore } from '../../src/runtime/control-plane/facade/plan-contract-store';
import {
  readOutputHandleIndexEntry,
  recordOutputHandleIndexEntry,
} from '../../src/runtime/evidence/output-handle-index';
import {
  inspectRetiredWorkPurge,
  purgeRetiredWork,
  RETIRED_WORK_NAMESPACES,
} from '../../src/runtime/control-plane/persistence/retired-work-purge';
import {
  readWorkflowRun,
  writeWorkflowRunCheckpoint,
  workflowRunEvidenceRef,
} from '../../src/runtime/control-plane/persistence/workflow-run-store';
import {
  readControlPlaneRecord,
  withControlPlaneReadDatabase,
  withControlPlaneTransaction,
  writeControlPlaneRecord,
} from '../../src/runtime/control-plane/persistence/sqlite-store';

const tempRoots: string[] = [];
afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { force: true, recursive: true });
});

describe('full retired Work data erasure', () => {
  test('deletes old records and their audit chain without touching Plan, Process or UserRequest', () => {
    const home = mkdtempSync(join(tmpdir(), 'forge-retired-work-purge-'));
    tempRoots.push(home);
    const retiredCount = RETIRED_WORK_NAMESPACES.length;
    expect(RETIRED_WORK_NAMESPACES).toEqual([
      'work_contract',
      'work_semantic_revision',
      'execution_work_handle',
      'execution_work_validation_index',
      'work_prepare_request',
      'controller_work_binding',
      'chatgpt_work_conversation_binding',
      'assistant_experience',
      'assistant_outcome_observation',
    ]);
    for (const namespace of RETIRED_WORK_NAMESPACES) {
      writeControlPlaneRecord(home, {
        namespace,
        scope: 'repo-1',
        key: 'old-work',
        schemaVersion: 1,
        value: { legacyWorkId: 'old-work' },
        expectedRevision: null,
      });
      writeControlPlaneRecord(home, {
        namespace,
        scope: 'repo-1',
        key: 'old-work',
        schemaVersion: 1,
        value: { legacyWorkId: 'old-work', revision: 2 },
        expectedRevision: 1,
      });
    }
    for (const namespace of [
      'plan_contract',
      'process_request_binding',
      'user_request',
      'workflow_run',
      'workflow_registry',
      'workspace_semantic',
    ]) {
      writeControlPlaneRecord(home, {
        namespace,
        scope: 'repo-1',
        key: 'retain',
        schemaVersion: 1,
        value: { id: namespace },
        expectedRevision: null,
      });
    }
    withControlPlaneTransaction(home, (db) => {
      for (const namespace of RETIRED_WORK_NAMESPACES) {
        db.prepare(
          'INSERT INTO control_plane_audit_floor(namespace,scope,record_key,floor_revision,updated_at) VALUES(?,?,?,?,?)',
        ).run(namespace, 'repo-1', 'old-work', 2, '2026-11-21');
        db.prepare(
          'INSERT INTO control_plane_audit_record_cursor(name,namespace,scope,record_key,updated_at) VALUES(?,?,?,?,?)',
        ).run('cursor-' + namespace, namespace, 'repo-1', 'old-work', '2026-11-21');
      }
    });
    const dir = join(home, 'repositories', 'repo-1', 'work-handles');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'old-work.json'), '{}');
    const oldIndex = join(home, 'indexes', 'work-contracts', 'requests');
    mkdirSync(oldIndex, { recursive: true });
    writeFileSync(join(oldIndex, 'legacy.json'), '{}');
    const preview = inspectRetiredWorkPurge(home);
    expect(preview).toMatchObject({
      applied: false,
      records: retiredCount,
      auditEvents: retiredCount * 2,
      auditFloors: retiredCount,
      auditRecordCursors: retiredCount,
    });
    expect(preview.directories).toHaveLength(2);
    const erased = purgeRetiredWork(home);
    expect(erased).toMatchObject({ applied: true, records: retiredCount, auditEvents: retiredCount * 2 });
    expect(existsSync(dir)).toBe(false);
    expect(existsSync(oldIndex)).toBe(false);
    // No retained raw Work payload in compacted SQLite pages/WAL.
    expect(readFileSync(join(home, 'control-plane.sqlite')).includes(Buffer.from('legacyWorkId'))).toBe(false);
    const wal = join(home, 'control-plane.sqlite-wal');
    if (existsSync(wal)) expect(readFileSync(wal).length).toBe(0);
    expect(inspectRetiredWorkPurge(home)).toMatchObject({
      applied: false,
      records: 0,
      auditEvents: 0,
      auditFloors: 0,
      auditRecordCursors: 0,
      directories: [],
    });
    expect(
      withControlPlaneReadDatabase(home, (db) =>
        RETIRED_WORK_NAMESPACES.map((namespace) =>
          db.prepare('SELECT COUNT(*) AS count FROM control_plane_audit WHERE namespace = ?').get(namespace),
        ),
      ),
    ).toEqual(RETIRED_WORK_NAMESPACES.map(() => ({ count: 0 })));
    for (const namespace of [
      'plan_contract',
      'process_request_binding',
      'user_request',
      'workflow_run',
      'workflow_registry',
      'workspace_semantic',
    ]) {
      expect(readControlPlaneRecord(home, namespace, 'repo-1', 'retain')?.value).toEqual({ id: namespace });
    }
    expect(purgeRetiredWork(home)).toMatchObject({ applied: true, records: 0, auditEvents: 0 });
  });

  test('physically removes legacy cognition Work provenance columns while preserving current memories', () => {
    const home = mkdtempSync(join(tmpdir(), 'forge-retired-cognition-provenance-'));
    tempRoots.push(home);
    withControlPlaneTransaction(home, (db) => {
      db.exec(`
        CREATE TABLE cognition_memory_units (
          memory_id TEXT PRIMARY KEY,
          source_kind TEXT NOT NULL,
          source_work_id TEXT,
          source_round_id TEXT
        );
        CREATE TABLE cognition_memory_edges (
          edge_id TEXT PRIMARY KEY,
          relation TEXT NOT NULL,
          source_work_id TEXT,
          source_round_id TEXT
        );
      `);
      db.prepare('INSERT INTO cognition_memory_units VALUES (?, ?, ?, ?)').run(
        'memory-current',
        'user',
        'WORK-LEGACY-UNIQUE-93f4',
        'ROUND-LEGACY-UNIQUE-93f4',
      );
      db.prepare('INSERT INTO cognition_memory_edges VALUES (?, ?, ?, ?)').run(
        'edge-current',
        'supports',
        'WORK-LEGACY-UNIQUE-93f4',
        'ROUND-LEGACY-UNIQUE-93f4',
      );
    });
    const schema = (table: string) =>
      withControlPlaneReadDatabase(home, (db) =>
        (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((column) => column.name),
      );
    expect(schema('cognition_memory_units')).toContain('source_work_id');
    expect(schema('cognition_memory_edges')).toContain('source_round_id');
    expect(purgeRetiredWork(home)).toMatchObject({ applied: true });
    for (const table of ['cognition_memory_units', 'cognition_memory_edges']) {
      expect(schema(table)).not.toContain('source_work_id');
      expect(schema(table)).not.toContain('source_round_id');
    }
    const surviving = withControlPlaneReadDatabase(home, (db) => ({
      memory: db.prepare('SELECT memory_id, source_kind FROM cognition_memory_units').get(),
      edge: db.prepare('SELECT edge_id, relation FROM cognition_memory_edges').get(),
    }));
    expect(surviving).toEqual({
      memory: { memory_id: 'memory-current', source_kind: 'user' },
      edge: { edge_id: 'edge-current', relation: 'supports' },
    });
    const compacted = readFileSync(join(home, 'control-plane.sqlite'));
    expect(compacted.includes(Buffer.from('WORK-LEGACY-UNIQUE-93f4'))).toBe(false);
    expect(compacted.includes(Buffer.from('ROUND-LEGACY-UNIQUE-93f4'))).toBe(false);
    expect(purgeRetiredWork(home)).toMatchObject({ applied: true, records: 0 });
  });

  test('WorkflowRun store rejects retired workId scope and requires native scopeId (#483)', () => {
    const home = mkdtempSync(join(tmpdir(), 'forge-workflow-run-no-work-'));
    tempRoots.push(home);
    const legacyContent = {
      schemaVersion: 1 as const,
      runId: 'legacy-only',
      workId: 'WORK-LEGACY-SCOPE',
      workflowId: 'wf',
      version: '1',
      contentDigest: 'digest',
      inputDigest: 'input',
      status: 'succeeded' as const,
      nextStepIndex: 0,
      receipts: [] as [],
      updatedAt: '2026-11-22T00:00:00.000Z',
      outputs: {},
    };
    writeControlPlaneRecord(home, {
      namespace: 'workflow_run',
      scope: 'legacy-work-scope',
      key: 'legacy-only',
      schemaVersion: 1,
      value: {
        ...legacyContent,
        evidenceRef: workflowRunEvidenceRef(legacyContent as never),
      },
      expectedRevision: null,
    });
    expect(() => readWorkflowRun(home, 'legacy-work-scope', 'legacy-only')).toThrow('WORKFLOW_RUN_RETIRED_WORK_SCOPE');

    const written = writeWorkflowRunCheckpoint({
      controllerHome: home,
      checkpoint: {
        schemaVersion: 1,
        binding: { scopeId: 'repository:native', runId: 'native-run' },
        workflowId: 'wf',
        version: '1',
        contentDigest: 'digest',
        status: 'succeeded',
        nextStepIndex: 0,
        receipts: [],
        outputs: {},
      },
      expectedRevision: null,
      now: new Date('2026-11-22T00:00:00.000Z'),
    });
    expect(written.value.scopeId).toBe('repository:native');
    expect(Object.hasOwn(written.value, 'workId')).toBe(false);
    expect(readWorkflowRun(home, 'repository:native', 'native-run')?.value.runId).toBe('native-run');
  });

  test('erases Work-scoped WorkflowRun history but preserves native WorkflowRun records', () => {
    const home = mkdtempSync(join(tmpdir(), 'forge-retired-workflow-run-'));
    tempRoots.push(home);
    const workMarker = 'WORKFLOW-WORK-ONLY-OLD-93fe';
    writeControlPlaneRecord(home, {
      namespace: 'workflow_run',
      scope: 'legacy-work-scope',
      key: 'legacy-workflow-run',
      schemaVersion: 1,
      value: { schemaVersion: 1, runId: 'legacy-workflow-run', workId: workMarker },
      expectedRevision: null,
    });
    writeControlPlaneRecord(home, {
      namespace: 'workflow_run',
      scope: 'repository:modern-workflow',
      key: 'modern-workflow-run',
      schemaVersion: 1,
      value: { schemaVersion: 1, runId: 'modern-workflow-run', scopeId: 'repository:modern-workflow' },
      expectedRevision: null,
    });
    withControlPlaneTransaction(home, (db) => {
      db.prepare(
        'INSERT INTO control_plane_audit_floor(namespace,scope,record_key,floor_revision,updated_at) VALUES(?,?,?,?,?)',
      ).run('workflow_run', 'legacy-work-scope', 'legacy-workflow-run', 1, '2026-11-22');
      db.prepare(
        'INSERT INTO control_plane_audit_record_cursor(name,namespace,scope,record_key,updated_at) VALUES(?,?,?,?,?)',
      ).run('old-workflow-cursor', 'workflow_run', 'legacy-work-scope', 'legacy-workflow-run', '2026-11-22');
    });
    expect(() => readWorkflowRun(home, 'legacy-work-scope', 'legacy-workflow-run')).toThrow(
      'WORKFLOW_RUN_RETIRED_WORK_SCOPE',
    );
    expect(inspectRetiredWorkPurge(home)).toMatchObject({
      records: 1,
      auditEvents: 1,
      auditFloors: 1,
      auditRecordCursors: 1,
    });
    expect(purgeRetiredWork(home)).toMatchObject({ applied: true, records: 1 });
    expect(readControlPlaneRecord(home, 'workflow_run', 'legacy-work-scope', 'legacy-workflow-run')).toBeUndefined();
    expect(
      readControlPlaneRecord(home, 'workflow_run', 'repository:modern-workflow', 'modern-workflow-run')?.value,
    ).toMatchObject({ scopeId: 'repository:modern-workflow', runId: 'modern-workflow-run' });
    expect(inspectRetiredWorkPurge(home)).toMatchObject({
      records: 0,
      auditEvents: 0,
      auditFloors: 0,
      auditRecordCursors: 0,
    });
    const compacted = readFileSync(join(home, 'control-plane.sqlite'));
    expect(compacted.includes(Buffer.from(workMarker))).toBe(false);
    expect(purgeRetiredWork(home)).toMatchObject({ applied: true, records: 0 });
  });

  test('erases Work-attributed Process handle locators and their audit without deleting native Process facts', () => {
    const home = mkdtempSync(join(tmpdir(), 'forge-retired-process-locator-'));
    tempRoots.push(home);
    const oldMarker = 'PROCESS-INDEX-WORK-ONLY-efb37b';
    writeControlPlaneRecord(home, {
      namespace: 'process_handle_index',
      scope: 'instance',
      key: 'proc-old-work',
      schemaVersion: 1,
      value: { schemaVersion: 1, processId: 'proc-old-work', workId: oldMarker },
      expectedRevision: null,
    });
    writeControlPlaneRecord(home, {
      namespace: 'process_handle_index',
      scope: 'instance',
      key: 'proc-native',
      schemaVersion: 1,
      value: {
        schemaVersion: 1,
        processId: 'proc-native',
        lane: 'managed',
        target: { schemaVersion: 1, scope: 'forge_instance' },
      },
      expectedRevision: null,
    });
    writeControlPlaneRecord(home, {
      namespace: 'process_request_binding',
      scope: 'instance',
      key: 'proc-old-work',
      schemaVersion: 1,
      value: { processId: 'proc-old-work', authority: 'process_runtime' },
      expectedRevision: null,
    });
    withControlPlaneTransaction(home, (db) => {
      db.prepare(
        'INSERT INTO control_plane_audit_floor(namespace,scope,record_key,floor_revision,updated_at) VALUES(?,?,?,?,?)',
      ).run('process_handle_index', 'instance', 'proc-old-work', 1, '2026-11-22');
      db.prepare(
        'INSERT INTO control_plane_audit_record_cursor(name,namespace,scope,record_key,updated_at) VALUES(?,?,?,?,?)',
      ).run('retired-locator-cursor', 'process_handle_index', 'instance', 'proc-old-work', '2026-11-22');
    });
    expect(inspectRetiredWorkPurge(home)).toMatchObject({
      records: 1,
      auditEvents: 1,
      auditFloors: 1,
      auditRecordCursors: 1,
    });
    expect(purgeRetiredWork(home)).toMatchObject({ applied: true, records: 1 });
    expect(readControlPlaneRecord(home, 'process_handle_index', 'instance', 'proc-old-work')).toBeUndefined();
    expect(readControlPlaneRecord(home, 'process_handle_index', 'instance', 'proc-native')?.value).toMatchObject({
      processId: 'proc-native',
    });
    expect(readControlPlaneRecord(home, 'process_request_binding', 'instance', 'proc-old-work')?.value).toEqual({
      processId: 'proc-old-work',
      authority: 'process_runtime',
    });
    expect(inspectRetiredWorkPurge(home)).toMatchObject({
      records: 0,
      auditEvents: 0,
      auditFloors: 0,
      auditRecordCursors: 0,
    });
    expect(readFileSync(join(home, 'control-plane.sqlite')).includes(Buffer.from(oldMarker))).toBe(false);
    expect(purgeRetiredWork(home)).toMatchObject({ applied: true, records: 0 });
  });

  test('rejects Work-attributed output locators and physically erases their history without deleting native output handles', () => {
    const home = mkdtempSync(join(tmpdir(), 'forge-retired-output-locator-'));
    tempRoots.push(home);
    const marker = 'OUTPUT-INDEX-WORK-ONLY-7cf95a';
    writeControlPlaneRecord(home, {
      namespace: 'output_handle_index',
      scope: 'instance',
      key: 'old-output',
      schemaVersion: 1,
      value: {
        schemaVersion: 1,
        handleId: 'old-output',
        kind: 'result',
        storage: { scope: 'instance' },
        fingerprint: 'old-fingerprint',
        recordedAt: '2026-11-22',
        updatedAt: '2026-11-22',
        workId: marker,
      },
      expectedRevision: null,
    });
    recordOutputHandleIndexEntry(home, {
      handleId: 'native-output',
      kind: 'result',
      storage: { scope: 'instance' },
      fingerprint: 'native-fingerprint',
      now: '2026-11-22',
    });
    withControlPlaneTransaction(home, (db) => {
      db.prepare(
        'INSERT INTO control_plane_audit_floor(namespace,scope,record_key,floor_revision,updated_at) VALUES(?,?,?,?,?)',
      ).run('output_handle_index', 'instance', 'old-output', 1, '2026-11-22');
      db.prepare(
        'INSERT INTO control_plane_audit_record_cursor(name,namespace,scope,record_key,updated_at) VALUES(?,?,?,?,?)',
      ).run('retired-output-cursor', 'output_handle_index', 'instance', 'old-output', '2026-11-22');
    });
    expect(() => readOutputHandleIndexEntry(home, 'old-output')).toThrow('OUTPUT_HANDLE_RETIRED_WORK_SCOPE');
    expect(() =>
      recordOutputHandleIndexEntry(home, {
        handleId: 'old-output',
        kind: 'result',
        storage: { scope: 'instance' },
        fingerprint: 'old-fingerprint',
      }),
    ).toThrow('OUTPUT_HANDLE_RETIRED_WORK_SCOPE');
    expect(inspectRetiredWorkPurge(home)).toMatchObject({
      records: 1,
      auditEvents: 1,
      auditFloors: 1,
      auditRecordCursors: 1,
    });
    expect(purgeRetiredWork(home)).toMatchObject({ applied: true, records: 1 });
    expect(readControlPlaneRecord(home, 'output_handle_index', 'instance', 'old-output')).toBeUndefined();
    expect(readOutputHandleIndexEntry(home, 'native-output')).toMatchObject({
      handleId: 'native-output',
      fingerprint: 'native-fingerprint',
    });
    expect(inspectRetiredWorkPurge(home)).toMatchObject({
      records: 0,
      auditEvents: 0,
      auditFloors: 0,
      auditRecordCursors: 0,
    });
    expect(readFileSync(join(home, 'control-plane.sqlite')).includes(Buffer.from(marker))).toBe(false);
    expect(purgeRetiredWork(home)).toMatchObject({ applied: true, records: 0 });
  });

  test('offline removal of retired Work fields preserves native Plan identity, revision, audit and content', () => {
    const home = mkdtempSync(join(tmpdir(), 'forge-retired-plan-fields-'));
    tempRoots.push(home);
    const marker = 'PLAN-WORK-MARKER-6e09f2';
    const sourcePlan = {
      schemaVersion: 1,
      planId: 'plan-native',
      revision: 3,
      scopeKey: 'repo-plan',
      sourceRevision: 'a1b2c3',
      goal: 'Keep the Plan.',
      status: 'draft',
      workId: marker,
      steps: [{ id: 'step-one', objective: 'Deliver a feature', workId: marker }],
      deliveryCarries: [{ predecessorPlanId: 'old-plan', workId: marker }],
    };
    writeControlPlaneRecord(home, {
      namespace: 'plan_contract',
      scope: 'repo-plan',
      key: sourcePlan.planId,
      schemaVersion: 1,
      value: sourcePlan,
      expectedRevision: null,
    });
    writeControlPlaneRecord(home, {
      namespace: 'plan_contract',
      scope: 'repo-plan',
      key: 'plan-clean',
      schemaVersion: 1,
      value: { schemaVersion: 1, planId: 'plan-clean', steps: [], goal: 'Keep unchanged' },
      expectedRevision: null,
    });
    const before = readControlPlaneRecord(home, 'plan_contract', 'repo-plan', sourcePlan.planId);
    expect(() => readPlanContractStore({ controllerHome: home, repoId: 'repo-plan' })).toThrow(
      'PLAN_RETIRED_WORK_SCOPE',
    );
    expect(inspectRetiredWorkPurge(home).planRecordsCleaned).toBe(1);
    expect(purgeRetiredWork(home)).toMatchObject({ applied: true, planRecordsCleaned: 1 });
    const after = readControlPlaneRecord(home, 'plan_contract', 'repo-plan', sourcePlan.planId);
    expect(after?.revision).toBe(before?.revision);
    expect(after?.value).toMatchObject({ planId: 'plan-native', revision: 3, goal: 'Keep the Plan.' });
    expect(after?.value).not.toHaveProperty('workId');
    expect(after?.value).not.toHaveProperty('steps.0.workId');
    expect(after?.value).not.toHaveProperty('deliveryCarries.0.workId');
    expect(readPlanContractStore({ controllerHome: home, repoId: 'repo-plan' }).contracts).toHaveLength(2);
    expect(readControlPlaneRecord(home, 'plan_contract', 'repo-plan', 'plan-clean')?.value).toMatchObject({
      planId: 'plan-clean',
      goal: 'Keep unchanged',
    });
    expect(
      withControlPlaneReadDatabase(
        home,
        (db) =>
          (
            db
              .prepare('SELECT COUNT(*) AS count FROM control_plane_audit WHERE namespace = ? AND record_key = ?')
              .get('plan_contract', 'plan-native') as { count: number }
          ).count,
      ),
    ).toBe(1);
    expect(readFileSync(join(home, 'control-plane.sqlite')).includes(Buffer.from(marker))).toBe(false);
    expect(inspectRetiredWorkPurge(home).planRecordsCleaned).toBe(0);
    expect(purgeRetiredWork(home)).toMatchObject({ planRecordsCleaned: 0 });
  });

  test('rejects retired Work attribution on a Plan step or delivery carry without a top-level workId', () => {
    for (const field of ['steps', 'deliveryCarries'] as const) {
      const home = mkdtempSync(join(tmpdir(), 'forge-retired-plan-child-'));
      tempRoots.push(home);
      writeControlPlaneRecord(home, {
        namespace: 'plan_contract',
        scope: 'repo-child',
        key: 'native-plan',
        schemaVersion: 1,
        value: {
          schemaVersion: 1,
          planId: 'native-plan',
          goal: 'Keep native Plan behavior',
          steps: [{ id: 'step', objective: 'Ship', ...(field === 'steps' ? { workId: 'retired' } : {}) }],
          deliveryCarries: [
            { predecessorPlanId: 'older', ...(field === 'deliveryCarries' ? { workId: 'retired' } : {}) },
          ],
        },
        expectedRevision: null,
      });
      expect(() => readPlanContractStore({ controllerHome: home, repoId: 'repo-child' })).toThrow(
        'PLAN_RETIRED_WORK_SCOPE',
      );
      expect(inspectRetiredWorkPurge(home).planRecordsCleaned).toBe(1);
    }
  });

  test('CLI defaults to preview, refuses active-Runtime apply and erases only with offline flag', () => {
    const home = mkdtempSync(join(tmpdir(), 'forge-retired-work-cli-'));
    tempRoots.push(home);
    writeControlPlaneRecord(home, {
      namespace: 'work_contract',
      scope: 'repo-cli',
      key: 'legacy-id',
      schemaVersion: 1,
      value: { objective: 'retired' },
      expectedRevision: null,
    });
    const run = (...args: string[]) =>
      spawnSync(
        process.execPath,
        ['bin/forge.mjs', 'runtime', 'purge-retired-work', '--controller-home', home, ...args],
        { cwd: join(import.meta.dir, '../..'), encoding: 'utf8', timeout: 15_000 },
      );
    const preview = run();
    expect(preview.status).toBe(0);
    expect(JSON.parse(preview.stdout)).toMatchObject({ applied: false, records: 1 });
    expect(readControlPlaneRecord(home, 'work_contract', 'repo-cli', 'legacy-id')).toBeDefined();
    const denied = run('--apply');
    expect(denied.status).not.toBe(0);
    expect(denied.stderr).toContain('RETIRED_WORK_PURGE_REQUIRES_STOPPED_RUNTIME');
    const applied = run('--apply', '--runtime-stopped');
    expect(applied.status).toBe(0);
    expect(JSON.parse(applied.stdout)).toMatchObject({ applied: true, records: 1 });
    expect(readControlPlaneRecord(home, 'work_contract', 'repo-cli', 'legacy-id')).toBeUndefined();
  });

  test('removes Work-only sync replicas and journal keys without deleting Plan replicas', () => {
    const home = mkdtempSync(join(tmpdir(), 'forge-retired-work-mixed-'));
    tempRoots.push(home);
    const scope = 'workspace:project';
    writeControlPlaneRecord(home, {
      namespace: 'semantic_sync_replica',
      scope,
      key: 'work:legacy',
      schemaVersion: 1,
      value: { schemaVersion: 1, record: { kind: 'work', id: 'legacy' } },
      expectedRevision: null,
    });
    writeControlPlaneRecord(home, {
      namespace: 'semantic_sync_replica',
      scope,
      key: 'work:legacy',
      schemaVersion: 1,
      value: { schemaVersion: 1, record: { kind: 'work', id: 'legacy', revision: 2 } },
      expectedRevision: 1,
    });
    writeControlPlaneRecord(home, {
      namespace: 'semantic_sync_replica',
      scope,
      key: 'plan:current',
      schemaVersion: 1,
      value: { schemaVersion: 1, record: { kind: 'plan', id: 'current' } },
      expectedRevision: null,
    });
    writeControlPlaneRecord(home, {
      namespace: 'semantic_sync_journal',
      scope,
      key: 'journal',
      schemaVersion: 1,
      value: {
        schemaVersion: 1,
        entries: [
          { schemaVersion: 1, sampledKeys: ['work:legacy', 'plan:current'], appliedCount: 2, convergedCount: 0 },
        ],
      },
      expectedRevision: null,
    });
    withControlPlaneTransaction(home, (db) => {
      db.prepare(
        'INSERT INTO control_plane_audit_floor(namespace,scope,record_key,floor_revision,updated_at) VALUES(?,?,?,?,?)',
      ).run('semantic_sync_replica', scope, 'work:legacy', 2, '2026-11-21');
      db.prepare(
        'INSERT INTO control_plane_audit_record_cursor(name,namespace,scope,record_key,updated_at) VALUES(?,?,?,?,?)',
      ).run('legacy-sync-cursor', 'semantic_sync_replica', scope, 'work:legacy', '2026-11-21');
    });
    const preview = inspectRetiredWorkPurge(home);
    expect(preview).toMatchObject({
      applied: false,
      records: 1,
      auditEvents: 2,
      auditFloors: 1,
      auditRecordCursors: 1,
      journalReferences: 1,
    });
    expect(purgeRetiredWork(home)).toMatchObject({ applied: true, records: 1, journalReferences: 1 });
    expect(readControlPlaneRecord(home, 'semantic_sync_replica', scope, 'work:legacy')).toBeUndefined();
    expect(readControlPlaneRecord(home, 'semantic_sync_replica', scope, 'plan:current')?.value).toEqual({
      schemaVersion: 1,
      record: { kind: 'plan', id: 'current' },
    });
    expect(
      readControlPlaneRecord<{ entries: Array<{ sampledKeys: string[] }> }>(
        home,
        'semantic_sync_journal',
        scope,
        'journal',
      )?.value.entries[0]?.sampledKeys,
    ).toEqual(['plan:current']);
    expect(inspectRetiredWorkPurge(home)).toMatchObject({
      records: 0,
      auditEvents: 0,
      auditFloors: 0,
      auditRecordCursors: 0,
      journalReferences: 0,
    });
    expect(readFileSync(join(home, 'control-plane.sqlite')).includes(Buffer.from('work:legacy'))).toBe(false);
    expect(purgeRetiredWork(home).journalReferences).toBe(0);
  });

  test('fails closed before deleting records when a legacy sync journal is malformed', () => {
    const home = mkdtempSync(join(tmpdir(), 'forge-retired-work-invalid-journal-'));
    tempRoots.push(home);
    writeControlPlaneRecord(home, {
      namespace: 'work_contract',
      scope: 'repo-invalid',
      key: 'old-work',
      schemaVersion: 1,
      value: { workId: 'old-work' },
      expectedRevision: null,
    });
    writeControlPlaneRecord(home, {
      namespace: 'semantic_sync_journal',
      scope: 'workspace:project',
      key: 'journal',
      schemaVersion: 1,
      value: { schemaVersion: 1, entries: null },
      expectedRevision: null,
    });
    expect(() => purgeRetiredWork(home)).toThrow('RETIRED_WORK_JOURNAL_INVALID');
    expect(readControlPlaneRecord(home, 'work_contract', 'repo-invalid', 'old-work')).toBeDefined();
  });

  test('refuses symbolic-link ancestor roots without removing external data', () => {
    const home = mkdtempSync(join(tmpdir(), 'forge-retired-work-symlink-home-'));
    const external = mkdtempSync(join(tmpdir(), 'forge-retired-work-symlink-external-'));
    tempRoots.push(home, external);
    const foreignWorkDir = join(external, 'work-handles');
    mkdirSync(foreignWorkDir);
    const marker = join(foreignWorkDir, 'outside.txt');
    writeFileSync(marker, 'retain external source');

    symlinkSync(external, join(home, 'semantic'));
    expect(() => inspectRetiredWorkPurge(home)).toThrow('RETIRED_WORK_UNSAFE_LEGACY_PATH');
    expect(() => purgeRetiredWork(home)).toThrow('RETIRED_WORK_UNSAFE_LEGACY_PATH');
    expect(readFileSync(marker, 'utf8')).toBe('retain external source');
  });

  test('refuses symlinked intermediate indexes directory before any DB deletion', () => {
    const home = mkdtempSync(join(tmpdir(), 'forge-retired-work-index-symlink-home-'));
    const external = mkdtempSync(join(tmpdir(), 'forge-retired-work-index-symlink-external-'));
    tempRoots.push(home, external);
    const foreignIndex = join(external, 'work-contracts');
    mkdirSync(foreignIndex);
    const marker = join(foreignIndex, 'foreign-index.json');
    writeFileSync(marker, 'retain external index');
    symlinkSync(external, join(home, 'indexes'));
    writeControlPlaneRecord(home, {
      namespace: 'work_contract',
      scope: 'repo-legacy',
      key: 'old',
      schemaVersion: 1,
      value: { marker: 'must-not-be-deleted' },
      expectedRevision: null,
    });
    expect(() => inspectRetiredWorkPurge(home)).toThrow('RETIRED_WORK_UNSAFE_LEGACY_PATH');
    expect(() => purgeRetiredWork(home)).toThrow('RETIRED_WORK_UNSAFE_LEGACY_PATH');
    expect(readControlPlaneRecord(home, 'work_contract', 'repo-legacy', 'old')).toBeDefined();
    expect(readFileSync(marker, 'utf8')).toBe('retain external index');
  });

  test('does not create a database for an empty Controller Home', () => {
    const home = mkdtempSync(join(tmpdir(), 'forge-empty-retired-purge-'));
    tempRoots.push(home);
    expect(purgeRetiredWork(home)).toMatchObject({ records: 0, auditEvents: 0, directories: [] });
    expect(existsSync(join(home, 'control-plane.sqlite'))).toBe(false);
  });
});
