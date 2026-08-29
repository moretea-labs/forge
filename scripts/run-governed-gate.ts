#!/usr/bin/env bun
import { createHash } from 'crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { runBoundedChild } from '../src/runtime/shared/bounded-child-supervisor';
import { testContentDigest, workspaceMutationDigest } from '../src/testing/test-governance';

export type Gate = 'task' | 'main' | 'release';
interface CommandStep { label: string; command: string; args: string[]; timeoutMs: number }
interface GateStep { label: string; gate: Gate }
type Step = CommandStep | GateStep;

const ROOT = resolve(import.meta.dir, '..');
const RECEIPT_ROOT = join(ROOT, '.ai/harness/checks/gates');

export function stepsFor(gate: Gate): Step[] {
  if (gate === 'task') return [
    { label: 'typecheck', command: 'bun', args: ['run', 'check:type'], timeoutMs: 10 * 60_000 },
    { label: 'static architecture', command: 'bun', args: ['run', 'check:runtime-architecture'], timeoutMs: 5 * 60_000 },
    { label: 'generated authority', command: 'node', args: ['scripts/sync-generated-authority.mjs', '--check'], timeoutMs: 2 * 60_000 },
    { label: 'source duplication', command: 'node', args: ['scripts/check-source-duplication.mjs'], timeoutMs: 2 * 60_000 },
    { label: 'controller UI bundle', command: 'bun', args: ['run', 'check:controller-ui'], timeoutMs: 5 * 60_000 },
    { label: 'test manifest', command: 'bun', args: ['run', 'check:test-governance'], timeoutMs: 5 * 60_000 },
    { label: 'affected tests', command: 'bun', args: ['run', 'test'], timeoutMs: 30 * 60_000 },
  ];
  if (gate === 'main') return [
    { label: 'focused task receipt', gate: 'task' },
    { label: 'core regression', command: 'bun', args: ['run', 'test:core'], timeoutMs: 20 * 60_000 },
    { label: 'runtime smoke', command: 'bun', args: ['run', 'check:smoke'], timeoutMs: 10 * 60_000 },
  ];
  return [
    { label: 'main candidate receipt', gate: 'main' },
    { label: 'release surface and tarball', command: 'bash', args: ['scripts/check-release-readiness.sh'], timeoutMs: 30 * 60_000 },
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
    steps: stepsFor(gate).map((step) => 'gate' in step
      ? { label: step.label, gate: step.gate, definition: definitionValue(step.gate) }
      : step),
    bun: Bun.version,
    node: process.version,
  };
}

export function gateDefinitionDigest(gate: Gate): string {
  return createHash('sha256').update(JSON.stringify(definitionValue(gate))).digest('hex');
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

function passedReceipt(gate: Gate, contentDigest: string, definitionDigest: string): boolean {
  const receiptPath = join(RECEIPT_ROOT, `${contentDigest}-${gate}.json`);
  if (!existsSync(receiptPath)) return false;
  try {
    const receipt = JSON.parse(readFileSync(receiptPath, 'utf8')) as { status?: string; definitionDigest?: string };
    return receipt.status === 'passed'
      && receipt.definitionDigest === definitionDigest
      && (gate !== 'release' || releaseArtifactAvailable());
  } catch (_error) {
    return false;
  }
}

async function runGate(gate: Gate, contentDigest: string, baselineWorkspace: string): Promise<number> {
  const definitionDigest = gateDefinitionDigest(gate);
  const receiptPath = join(RECEIPT_ROOT, `${contentDigest}-${gate}.json`);
  if (passedReceipt(gate, contentDigest, definitionDigest)) {
    console.error(`[gate:${gate}] content receipt hit ${contentDigest.slice(0, 12)}`);
    return 0;
  }

  const startedAt = performance.now();
  for (const step of stepsFor(gate)) {
    console.error(`[gate:${gate}] ${step.label}`);
    let status: number;
    if ('gate' in step) {
      status = await runGate(step.gate, contentDigest, baselineWorkspace);
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
    if (workspaceMutationDigest(ROOT) !== baselineWorkspace) {
      console.error(`[gate:${gate}] TEST_INFRA_WORKTREE_MUTATION: candidate delta changed during ${step.label}`);
      return 1;
    }
  }

  atomicJson(receiptPath, {
    version: 2,
    gate,
    status: 'passed',
    contentDigest,
    definitionDigest,
    dependencies: stepsFor(gate).filter((step): step is GateStep => 'gate' in step).map((step) => step.gate),
    durationMs: Math.round(performance.now() - startedAt),
    completedAt: new Date().toISOString(),
  });
  console.error(`[gate:${gate}] passed; receipt=${receiptPath}`);
  return 0;
}

export async function main(args = process.argv.slice(2)): Promise<number> {
  const gate = args[0] as Gate;
  if (!['task', 'main', 'release'].includes(gate)) throw new Error('expected gate: task, main, or release');
  const contentDigest = testContentDigest(ROOT);
  const baselineWorkspace = workspaceMutationDigest(ROOT);
  const status = await runGate(gate, contentDigest, baselineWorkspace);
  if (status !== 0) return status;
  if (testContentDigest(ROOT) !== contentDigest) {
    console.error(`[gate:${gate}] candidate content changed; refusing stale receipt`);
    return 1;
  }
  return 0;
}

if (import.meta.main) process.exitCode = await main();
