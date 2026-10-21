#!/usr/bin/env bun
import { readFileSync } from 'fs';
import { resolve } from 'path';
import type { McpPolicy, McpProfileName } from '../types';
import { buildControllerContextPackAsync } from '../../../src/cli/controller/context-pack';
import type { ControllerContextPackOptions } from '../../../src/cli/controller/context/types';
import { PROCESS_RUNTIME_RELEASE_CANARY_ARG } from '../../../src/runtime/execution/process-runtime/canary';

interface ContextPackEnvelope {
  schemaVersion: 1;
  repoRoot: string;
  policy: McpPolicy;
  options: ControllerContextPackOptions;
}

function profile(value: unknown): McpProfileName {
  if (value === 'planner' || value === 'executor' || value === 'controller') return value;
  throw new Error('CONTEXT_PACK_POLICY_PROFILE_INVALID');
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new Error('CONTEXT_PACK_POLICY_GLOBS_INVALID');
  }
  return value.map(String);
}

function policy(value: unknown): McpPolicy {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('CONTEXT_PACK_POLICY_INVALID');
  const input = value as Record<string, unknown>;
  const execution = input.execution;
  if (!execution || typeof execution !== 'object' || Array.isArray(execution)) throw new Error('CONTEXT_PACK_POLICY_EXECUTION_INVALID');
  const e = execution as Record<string, unknown>;
  const maxFileBytes = Number(input.maxFileBytes);
  if (!Number.isFinite(maxFileBytes) || maxFileBytes <= 0) throw new Error('CONTEXT_PACK_POLICY_MAX_FILE_BYTES_INVALID');
  return {
    profile: profile(input.profile),
    readGlobs: stringList(input.readGlobs),
    writeGlobs: stringList(input.writeGlobs),
    denyGlobs: stringList(input.denyGlobs),
    maxFileBytes,
    execution: {
      agentRunner: e.agentRunner === true,
      allowedAgents: Array.isArray(e.allowedAgents)
        ? e.allowedAgents.filter((entry): entry is 'claude' => entry === 'claude')
        : [],
      runnerTimeoutMs: Number(e.runnerTimeoutMs) || 0,
      runnerMaxTimeoutMs: Number(e.runnerMaxTimeoutMs) || 0,
    },
  };
}

export async function runContextPackSidecar(
  argv = process.argv.slice(2),
  input = readFileSync(0, 'utf8'),
): Promise<number> {
  if (argv.includes(PROCESS_RUNTIME_RELEASE_CANARY_ARG)) {
    process.stdout.write('forge context-pack release canary\n');
    return 0;
  }
  const envelope = JSON.parse(input) as ContextPackEnvelope;
  if (envelope.schemaVersion !== 1 || typeof envelope.repoRoot !== 'string' || !envelope.repoRoot.trim()) {
    throw new Error('CONTEXT_PACK_REQUEST_INVALID');
  }
  const pack = await buildControllerContextPackAsync(
    resolve(envelope.repoRoot),
    policy(envelope.policy),
    envelope.options && typeof envelope.options === 'object' ? envelope.options : {},
  );
  process.stdout.write(`${JSON.stringify({ schemaVersion: 1, pack })}\n`);
  return 0;
}

if (import.meta.main) {
  try {
    process.exitCode = await runContextPackSidecar();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
