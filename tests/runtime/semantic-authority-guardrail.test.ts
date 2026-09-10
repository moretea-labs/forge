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

describe('Semantic Authority Guardrail', () => {
  test('rejects a new human-readable string branch in an authority-critical shape', () => {
    const violation = `src/runtime/control-plane/fake.ts::message.includes('network')`;
    const result = runFixture([
      {
        path: 'src/runtime/control-plane/fake.ts',
        source: `if (message.includes('network')) retry();`,
      },
    ], []);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('introduced forbidden entry');
    expect(result.stderr).toContain(violation);
  });

  test('allows an explicitly frozen debt entry but forces the ledger to shrink after retirement', () => {
    const debt = `src/runtime/execution/fake.ts::reason.startsWith('legacy:')`;
    const accepted = runFixture([
      {
        path: 'src/runtime/execution/fake.ts',
        source: `if (reason.startsWith('legacy:')) reconcile();`,
      },
    ], [debt]);
    expect(accepted.status).toBe(0);

    const retired = runFixture([], [debt]);
    expect(retired.status).toBe(1);
    expect(retired.stderr).toContain('allowlist contains retired entry');
    expect(retired.stderr).toContain(debt);
  });

  test('does not confuse typed code decisions with human-readable string heuristics', () => {
    const result = runFixture([
      {
        path: 'src/runtime/control-plane/fake.ts',
        source: `if (failure.code === 'ETIMEDOUT') retry();`,
      },
    ], []);

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
    expect(result.stderr).toContain('Browser/Desktop durable interaction authority must live only in Computer target authority');
    expect(result.stderr).toContain('BrowserSurfacePersistence');
  });

  test('catches regex tests against check ids so naming cannot silently become lifecycle authority again', () => {
    const violation = `src/runtime/execution/fake.ts::/(?:release|deploy)/i.test(checkId)`;
    const result = runFixture([
      {
        path: 'src/runtime/execution/fake.ts',
        source: `if (/(?:release|deploy)/i.test(checkId)) requireDurable();`,
      },
    ], []);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(violation);
  });
});
