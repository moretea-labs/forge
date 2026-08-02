#!/usr/bin/env bun
import { createHash } from 'crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { runBoundedChild } from '../src/runtime/shared/bounded-child-supervisor';
import { testContentDigest, trackedTreeDigest } from '../src/testing/test-governance';

type Gate = 'task' | 'main' | 'release';
interface GateCommand { label: string; command: string; args: string[]; timeoutMs: number }

const ROOT = resolve(import.meta.dir, '..');
const RECEIPT_ROOT = join(ROOT, '.ai/harness/checks/gates');

function commandsFor(gate: Gate): GateCommand[] {
  if (gate === 'task') return [
    { label: 'typecheck', command: 'bun', args: ['run', 'check:type'], timeoutMs: 10 * 60_000 },
    { label: 'static architecture', command: 'bun', args: ['run', 'check:runtime-architecture'], timeoutMs: 5 * 60_000 },
    { label: 'test budget', command: 'bun', args: ['run', 'check:test-governance'], timeoutMs: 5 * 60_000 },
    { label: 'affected tests', command: 'bun', args: ['run', 'test'], timeoutMs: 30 * 60_000 },
  ];
  if (gate === 'main') return [
    { label: 'focused task receipt', command: 'bun', args: ['run', 'check:task'], timeoutMs: 45 * 60_000 },
    { label: 'runtime smoke', command: 'bun', args: ['run', 'check:smoke'], timeoutMs: 10 * 60_000 },
  ];
  return [
    { label: 'main candidate receipt', command: 'bun', args: ['run', 'check:main'], timeoutMs: 70 * 60_000 },
    { label: 'release surface and tarball', command: 'bash', args: ['scripts/check-release-readiness.sh'], timeoutMs: 30 * 60_000 },
  ];
}

function atomicJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(temporary, path);
}

function definitionDigest(gate: Gate, commands: GateCommand[]): string {
  return createHash('sha256').update(JSON.stringify({ gate, commands, bun: Bun.version, node: process.version })).digest('hex');
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

async function main(): Promise<number> {
  const gate = process.argv[2] as Gate;
  if (!['task', 'main', 'release'].includes(gate)) throw new Error('expected gate: task, main, or release');
  const commands = commandsFor(gate);
  const contentDigest = testContentDigest(ROOT);
  const definition = definitionDigest(gate, commands);
  const receiptPath = join(RECEIPT_ROOT, `${contentDigest}-${gate}.json`);
  if (existsSync(receiptPath)) {
    try {
      const receipt = JSON.parse(readFileSync(receiptPath, 'utf8')) as { status?: string; definitionDigest?: string };
      if (receipt.status === 'passed'
        && receipt.definitionDigest === definition
        && (gate !== 'release' || releaseArtifactAvailable())) {
        console.error(`[gate:${gate}] content receipt hit ${contentDigest.slice(0, 12)}`);
        return 0;
      }
    } catch (_error) {
      // Invalid evidence is ignored and replaced by a fresh run.
    }
  }

  const trackedBefore = trackedTreeDigest(ROOT);
  const startedAt = performance.now();
  for (const step of commands) {
    console.error(`[gate:${gate}] ${step.label}`);
    const result = await runBoundedChild(step.command, step.args, {
      cwd: ROOT,
      env: process.env,
      timeoutMs: step.timeoutMs,
      stdio: 'inherit',
      forwardSignals: true,
    });
    if (result.status !== 0 || result.failureCode) {
      console.error(`[gate:${gate}] failed: ${step.label}${result.failureCode ? ` (${result.failureCode})` : ''}`);
      return result.status || 1;
    }
    if (trackedTreeDigest(ROOT) !== trackedBefore) {
      console.error(`[gate:${gate}] TEST_INFRA_WORKTREE_MUTATION: tracked content changed during ${step.label}`);
      return 1;
    }
  }
  if (testContentDigest(ROOT) !== contentDigest) {
    console.error(`[gate:${gate}] candidate content changed; refusing stale receipt`);
    return 1;
  }
  atomicJson(receiptPath, {
    version: 1,
    gate,
    status: 'passed',
    contentDigest,
    definitionDigest: definition,
    durationMs: Math.round(performance.now() - startedAt),
    completedAt: new Date().toISOString(),
  });
  console.error(`[gate:${gate}] passed; receipt=${receiptPath}`);
  return 0;
}

process.exitCode = await main();
