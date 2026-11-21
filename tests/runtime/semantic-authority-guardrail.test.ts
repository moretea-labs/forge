import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'child_process';
import { resolve } from 'path';

const root = resolve(import.meta.dir, '../..');
const script = resolve(root, 'scripts/check-runtime-architecture.mjs');

function runFixture(sources: Array<{ path: string; source: string }>, allowed: string[]) {
  return spawnSync(process.execPath, [script], {
    cwd: root,
    env: {
      ...process.env,
      FORGE_SEMANTIC_AUTHORITY_GUARDRAIL_FIXTURE: JSON.stringify({ sources, allowed }),
    },
    encoding: 'utf8',
  });
}

function runInteractionAuthorityFixture(sources: Array<{ path: string; source: string }>) {
  return spawnSync(process.execPath, [script], {
    cwd: root,
    env: {
      ...process.env,
      FORGE_INTERACTION_AUTHORITY_GUARDRAIL_FIXTURE: JSON.stringify({ sources }),
    },
    encoding: 'utf8',
  });
}

function runSupervisorComputerBoundaryFixture(sources: Array<{ path: string; source: string }>) {
  return spawnSync(process.execPath, [script], {
    cwd: root,
    env: {
      ...process.env,
      FORGE_SUPERVISOR_COMPUTER_BOUNDARY_FIXTURE: JSON.stringify({ sources }),
    },
    encoding: 'utf8',
  });
}

function ownerGraphFixture(sources: Array<{ path: string; source: string }>) {
  return spawnSync(process.execPath, [script], {
    cwd: root,
    env: { ...process.env, FORGE_ARCHITECTURE_OWNER_GRAPH_FIXTURE: JSON.stringify({ sources }) },
    encoding: 'utf8',
  });
}

describe('Semantic Authority Guardrail', () => {
  test('denies second durable mutation Owner declarations but permits callers', () => {
    for (const [path, source, symbol] of [
      ['src/runtime/rogue.ts', 'export function updateRequirement() {}', 'updateRequirement'],
      ['src/runtime/rogue.tsx', 'export const saveSchedule = () => null;', 'saveSchedule'],
      ['src/runtime/rogue.mts', 'export function recordCanonicalGrant() {}', 'recordCanonicalGrant'],
      ['src/runtime/rogue.cts', 'export function publishRuntimeRelease() {}', 'publishRuntimeRelease'],
    ]) {
      const result = ownerGraphFixture([{ path, source }]);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(`second mutation owner ${symbol}`);
    }
    expect(
      ownerGraphFixture([
        {
          path: 'src/runtime/consumer.ts',
          source: "import { updateSchedule } from '../../packages/kernel/scheduler/infrastructure/schedule-store';",
        },
      ]).status,
    ).toBe(0);
  });

  test('denies direct Requirement namespace writes but allows other namespace writes', () => {
    const invalid = ownerGraphFixture([
      {
        path: 'src/runtime/rogue.ts',
        source:
          "const NAMESPACE = 'requirement'; writeControlPlaneRecordWithinTransaction(db, { namespace: NAMESPACE, key: 'x' });",
      },
    ]);
    expect(invalid.status).toBe(1);
    expect(invalid.stderr).toContain('direct requirement persistence writer');
    expect(
      ownerGraphFixture([
        {
          path: 'src/runtime/audit.ts',
          source: "writeControlPlaneRecordWithinTransaction(db, { namespace: 'audit' });",
        },
      ]).status,
    ).toBe(0);
  });

  test('resolves TSX JSX and MTS/CTS runtime-suffix dependencies', () => {
    const result = ownerGraphFixture([
      {
        path: 'src/graph/view.tsx',
        source:
          "import { a } from './a.mjs'; import { b } from './b.cjs'; import { C } from './c'; export const View = () => <C>{a + b}</C>;",
      },
      { path: 'src/graph/a.mts', source: 'export const a = 1;' },
      { path: 'src/graph/b.cts', source: 'export const b = 2;' },
      { path: 'src/graph/c.tsx', source: 'export const C = () => <div />;' },
    ]);
    expect(result.status).toBe(0);
    for (const suffix of ['a.mts', 'b.cts', 'c.tsx']) {
      expect(result.stdout).toContain(`src/graph/view.tsx -> src/graph/${suffix}`);
    }
  });

  test('rejects TSX kernel-domain import of src runtime through MJS-to-MTS edge', () => {
    const result = ownerGraphFixture([
      {
        path: 'packages/kernel/sample/domain/rogue.tsx',
        source: "import { x } from '../../../../src/runtime/sample/a.mjs'; export const A = () => <div>{x}</div>;",
      },
      { path: 'src/runtime/sample/a.mts', source: 'export const x = 1;' },
    ]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Kernel domain/application must depend only on Kernel/protocol ports');
    expect(result.stderr).toContain('rogue.tsx -> src/runtime/sample/a.mts');
  });

  test('rejects a new human-readable string branch in an authority-critical shape', () => {
    const violation = `src/runtime/control-plane/fake.ts::message.includes('network')`;
    const result = runFixture(
      [
        {
          path: 'src/runtime/control-plane/fake.ts',
          source: `if (message.includes('network')) retry();`,
        },
      ],
      [],
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('introduced forbidden entry');
    expect(result.stderr).toContain(violation);
  });

  test('allows an explicitly frozen debt entry but forces the ledger to shrink after retirement', () => {
    const debt = `src/runtime/execution/fake.ts::reason.startsWith('legacy:')`;
    const accepted = runFixture(
      [
        {
          path: 'src/runtime/execution/fake.ts',
          source: `if (reason.startsWith('legacy:')) reconcile();`,
        },
      ],
      [debt],
    );
    expect(accepted.status).toBe(0);

    const retired = runFixture([], [debt]);
    expect(retired.status).toBe(1);
    expect(retired.stderr).toContain('allowlist contains retired entry');
    expect(retired.stderr).toContain(debt);
  });

  test('does not confuse typed code decisions with human-readable string heuristics', () => {
    const result = runFixture(
      [
        {
          path: 'src/runtime/control-plane/fake.ts',
          source: `if (failure.code === 'ETIMEDOUT') retry();`,
        },
      ],
      [],
    );

    expect(result.status).toBe(0);
  });

  test('rejects Browser/Desktop durable interaction authority outside Computer target authority', () => {
    const result = runInteractionAuthorityFixture([
      {
        path: 'src/runtime/plugins/fake-browser-owner.ts',
        source: `export interface BrowserSurfacePersistence { save(): void }`,
      },
    ]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'Browser/Desktop durable interaction authority must live only in Computer target authority',
    );
    expect(result.stderr).toContain('BrowserSurfacePersistence');
  });

  test('rejects Workflow Supervisor imports of concrete Browser transports', () => {
    const result = runSupervisorComputerBoundaryFixture([
      {
        path: 'supervisor/fake-consumer.ts',
        source: `import { listMacOsBrowserTabs } from '../src/runtime/plugins/browser-macos-bridge';\nexport function run() { return listMacOsBrowserTabs; }`,
      },
    ]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Workflow Supervisor semantic code must depend on Computer target ports');
    expect(result.stderr).toContain('browser-macos-bridge');
  });

  test('allows Workflow Supervisor to depend on the typed Computer target port', () => {
    const result = runSupervisorComputerBoundaryFixture([
      {
        path: 'supervisor/fake-consumer.ts',
        source: `import type { ComputerChatgptConversationTargetPort } from '../packages/plugin-runtime/computer';\nexport type Port = ComputerChatgptConversationTargetPort;`,
      },
    ]);

    expect(result.status).toBe(0);
  });

  test('catches regex tests against check ids so naming cannot silently become lifecycle authority again', () => {
    const violation = `src/runtime/execution/fake.ts::/(?:release|deploy)/i.test(checkId)`;
    const result = runFixture(
      [
        {
          path: 'src/runtime/execution/fake.ts',
          source: `if (/(?:release|deploy)/i.test(checkId)) requireDurable();`,
        },
      ],
      [],
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(violation);
  });
});
