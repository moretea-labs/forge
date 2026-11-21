#!/usr/bin/env bun
import { createHash } from 'crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { runBoundedChild } from '../src/runtime/shared/bounded-child-supervisor';
import { testContentDigest } from '../src/testing/test-governance';
import { resolveControllerHome } from '../src/effects/controller-home';

export type Gate = 'task' | 'main' | 'release';
interface CommandStep {
  label: string;
  command: string;
  args: string[];
  timeoutMs: number;
}
interface GateStep {
  label: string;
  gate: Gate;
}
type Step = CommandStep | GateStep;

const ROOT = resolve(import.meta.dir, '..');
const REPOSITORY_CACHE_KEY = createHash('sha256').update(ROOT).digest('hex').slice(0, 24);
const CACHE_ROOT = join(resolveControllerHome(), 'cache', 'governed-gates', REPOSITORY_CACHE_KEY);

export function stepsFor(gate: Gate): Step[] {
  if (gate === 'task')
    return [
      { label: 'typecheck', command: 'bun', args: ['run', 'check:type'], timeoutMs: 10 * 60_000 },
      {
        label: 'source quality (format, lint, complexity)',
        command: 'bun',
        args: ['run', 'check:source-quality'],
        timeoutMs: 5 * 60_000,
      },
      {
        label: 'static architecture',
        command: 'bun',
        args: ['run', 'check:runtime-architecture'],
        timeoutMs: 5 * 60_000,
      },
      {
        label: 'module boundaries',
        command: 'node',
        args: ['scripts/check-module-boundaries.mjs'],
        timeoutMs: 2 * 60_000,
      },
      {
        label: 'repository hygiene',
        command: 'node',
        args: ['scripts/check-repository-hygiene.mjs'],
        timeoutMs: 2 * 60_000,
      },
      {
        label: 'main synchronization contract',
        command: 'bash',
        args: ['scripts/test-sync-main.sh'],
        timeoutMs: 2 * 60_000,
      },
      {
        label: 'PR closing-reference intent',
        command: 'node',
        args: ['scripts/check-pr-closing-intent.mjs'],
        timeoutMs: 30_000,
      },
      {
        label: 'generated authority',
        command: 'node',
        args: ['scripts/sync-generated-authority.mjs', '--check'],
        timeoutMs: 2 * 60_000,
      },
      {
        label: 'source duplication',
        command: 'node',
        args: ['scripts/check-source-duplication.mjs'],
        timeoutMs: 2 * 60_000,
      },
      { label: 'test manifest', command: 'bun', args: ['run', 'check:test-governance'], timeoutMs: 5 * 60_000 },
      {
        label: 'context pack readiness regression',
        command: 'bun',
        args: ['test', 'tests/runtime/context-pack-readiness.test.ts'],
        timeoutMs: 2 * 60_000,
      },
      { label: 'affected tests', command: 'bun', args: ['run', 'test'], timeoutMs: 30 * 60_000 },
    ];
  if (gate === 'main')
    return [
      { label: 'task checks', gate: 'task' },
      {
        label: 'frozen MCP tool contract',
        command: 'bun',
        args: ['run', 'check:mcp-compatibility'],
        timeoutMs: 2 * 60_000,
      },
      {
        label: 'quality harness benchmark',
        command: 'bun',
        args: ['run', 'check:quality-harness'],
        timeoutMs: 2 * 60_000,
      },
      { label: 'core regression', command: 'bun', args: ['run', 'test:core'], timeoutMs: 20 * 60_000 },
      { label: 'runtime smoke', command: 'bun', args: ['run', 'check:smoke'], timeoutMs: 10 * 60_000 },
      // The affected-test selector excludes some Recovery process-tree suites. Keep one
      // explicit main-gate boundary for exact rollback safety plus the current
      // recoverability-only known-good authority.
      {
        label: 'Recovery rollback and known-good authority',
        command: 'bun',
        args: [
          'test',
          'tests/runtime/standalone-recovery.test.ts',
          '--test-name-pattern',
          'restores only the attested previous whole-Runtime release while Runtime is stopped|independent CPU rejection does not own ReleaseSession rollback or known-good|long soak and absent Supervisor proof do not veto mechanical known-good',
        ],
        timeoutMs: 5 * 60_000,
      },
    ];
  return [
    { label: 'main checks', gate: 'main' },
    {
      label: 'release surface and tarball',
      command: 'bash',
      args: ['scripts/check-release-readiness.sh'],
      timeoutMs: 30 * 60_000,
    },
  ];
}

function atomicJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(temporary, path);
}

function definitionValue(gate: Gate): unknown {
  return {
    gate,
    steps: stepsFor(gate).map((step) =>
      'gate' in step ? { label: step.label, gate: step.gate, definition: definitionValue(step.gate) } : step,
    ),
    bun: Bun.version,
    node: process.version,
  };
}

export function gateDefinitionDigest(gate: Gate): string {
  return createHash('sha256')
    .update(JSON.stringify(definitionValue(gate)))
    .digest('hex');
}

function releaseArtifactAvailable(): boolean {
  const pointer = join(ROOT, '.ai/harness/artifacts/release/latest-tarball.txt');
  if (!existsSync(pointer)) return false;
  try {
    return existsSync(readFileSync(pointer, 'utf8').trim());
  } catch (_error) {
    return false;
  }
}

function hasReusableGateCache(gate: Gate, contentDigest: string, definitionDigest: string): boolean {
  const cachePath = join(CACHE_ROOT, `${contentDigest}-${gate}.json`);
  if (!existsSync(cachePath)) return false;
  try {
    const cached = JSON.parse(readFileSync(cachePath, 'utf8')) as { status?: string; definitionDigest?: string };
    return (
      cached.status === 'passed' &&
      cached.definitionDigest === definitionDigest &&
      (gate !== 'release' || releaseArtifactAvailable())
    );
  } catch (_error) {
    return false;
  }
}

async function runGate(gate: Gate, contentDigest: string): Promise<number> {
  const definitionDigest = gateDefinitionDigest(gate);
  const cachePath = join(CACHE_ROOT, `${contentDigest}-${gate}.json`);
  if (hasReusableGateCache(gate, contentDigest, definitionDigest)) {
    console.error(`[gate:${gate}] cached candidate checks hit ${contentDigest.slice(0, 12)}`);
    return 0;
  }

  const startedAt = performance.now();
  for (const step of stepsFor(gate)) {
    console.error(`[gate:${gate}] ${step.label}`);
    let status: number;
    if ('gate' in step) {
      status = await runGate(step.gate, contentDigest);
    } else {
      const child = await runBoundedChild(step.command, step.args, {
        cwd: ROOT,
        env: process.env,
        timeoutMs: step.timeoutMs,
        stdio: 'inherit',
        forwardSignals: true,
      });
      status = child.status !== 0 || child.failureCode ? child.status || 1 : 0;
    }
    if (status !== 0) {
      console.error(`[gate:${gate}] failed: ${step.label}`);
      return status || 1;
    }
  }

  // A different Writer may change unrelated files between steps. Do not
  // repeatedly scan and veto the entire Git delta after every command.
  // Only cache a full Gate result if its input candidate is still identical.
  if (testContentDigest(ROOT) !== contentDigest) {
    console.error(`[gate:${gate}] candidate content changed; run checks against the current candidate`);
    return 1;
  }

  atomicJson(cachePath, {
    version: 2,
    gate,
    status: 'passed',
    contentDigest,
    definitionDigest,
    dependencies: stepsFor(gate)
      .filter((step): step is GateStep => 'gate' in step)
      .map((step) => step.gate),
    durationMs: Math.round(performance.now() - startedAt),
    completedAt: new Date().toISOString(),
  });
  console.error(`[gate:${gate}] passed; cached result=${cachePath}`);
  return 0;
}

export async function main(args = process.argv.slice(2)): Promise<number> {
  const gate = args[0] as Gate;
  if (!['task', 'main', 'release'].includes(gate)) throw new Error('expected gate: task, main, or release');
  const contentDigest = testContentDigest(ROOT);
  const status = await runGate(gate, contentDigest);
  if (status !== 0) return status;
  if (testContentDigest(ROOT) !== contentDigest) {
    console.error(`[gate:${gate}] candidate content changed; current candidate requires checks`);
    return 1;
  }
  return 0;
}

if (import.meta.main) process.exitCode = await main();
