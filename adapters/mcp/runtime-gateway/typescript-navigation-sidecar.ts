#!/usr/bin/env bun
import { readFileSync } from 'fs';
import { resolve } from 'path';
import type { McpPolicy, McpProfileName } from '../types';
import { resolveMcpPath } from '../paths';
import { PROCESS_RUNTIME_RELEASE_CANARY_ARG } from '../../../src/runtime/execution/process-runtime/canary';
import {
  clearTypeScriptNavigationCache,
  extractTypeScriptSourceSymbols,
  navigateTypeScriptSymbol,
  type TypeScriptNavigationRequest,
} from '../../../src/runtime/context/typescript-navigation';
import type {
  SemanticNavigationOutcome,
  SemanticNavigationReadPolicy,
} from '../../../src/runtime/context/semantic-navigation-contract';

interface Envelope {
  schemaVersion: 1;
  operation?: 'navigation' | 'source_symbols';
  repoRoot?: string;
  requests?: TypeScriptNavigationRequest[];
  path?: string;
  source?: string;
  access?: {
    cacheScope: string;
    sourceIdentity?: string;
    profile: string;
    readPolicy: SemanticNavigationReadPolicy;
  };
}

function profile(value: string): McpProfileName {
  if (value === 'planner' || value === 'executor' || value === 'orchestrator' || value === 'controller') return value;
  throw new Error('TYPESCRIPT_NAVIGATION_POLICY_PROFILE_INVALID');
}

function readPolicy(input: SemanticNavigationReadPolicy): McpPolicy {
  return {
    profile: profile(input.profile),
    readGlobs: [...input.readGlobs],
    writeGlobs: [],
    denyGlobs: [...input.denyGlobs],
    maxFileBytes: input.maxFileBytes,
    execution: {
      fixedWorkflowCheck: false,
      codexRunner: false,
      agentRunner: false,
      allowedAgents: [],
      runnerTimeoutMs: 0,
      runnerMaxTimeoutMs: 0,
    },
  };
}

export function runTypeScriptNavigationSidecar(
  argv = process.argv.slice(2),
  input = readFileSync(0, 'utf8'),
): number {
  if (argv.includes(PROCESS_RUNTIME_RELEASE_CANARY_ARG)) {
    process.stdout.write('forge typescript-navigation release canary\n');
    return 0;
  }

  const envelope = JSON.parse(input) as Envelope;
  if (envelope.schemaVersion !== 1) throw new Error('TYPESCRIPT_NAVIGATION_REQUEST_INVALID');
  if (envelope.operation === 'source_symbols') {
    if (typeof envelope.path !== 'string' || typeof envelope.source !== 'string') {
      throw new Error('TYPESCRIPT_SOURCE_SYMBOL_REQUEST_INVALID');
    }
    process.stdout.write(`${JSON.stringify({
      schemaVersion: 1,
      symbols: extractTypeScriptSourceSymbols(envelope.path, envelope.source),
    })}\n`);
    return 0;
  }
  if (!envelope.repoRoot || !Array.isArray(envelope.requests) || !envelope.access) {
    throw new Error('TYPESCRIPT_NAVIGATION_REQUEST_INVALID');
  }
  const repoRoot = resolve(envelope.repoRoot);
  const policy = readPolicy(envelope.access.readPolicy);
  const outcomes: SemanticNavigationOutcome[] = [];
  try {
    for (const request of envelope.requests) {
      let policyDeniedReads = 0;
      const policyDeniedReadSamples = new Set<string>();
      try {
        const result = navigateTypeScriptSymbol(repoRoot, request, {
          cacheScope: envelope.access.cacheScope,
          sourceIdentity: envelope.access.sourceIdentity,
          allowRepositoryPath: (relativePath) => {
            const decision = resolveMcpPath(repoRoot, relativePath, policy, 'read');
            if (decision.ok) return true;
            policyDeniedReads += 1;
            if (policyDeniedReadSamples.size < 20) policyDeniedReadSamples.add(relativePath);
            return false;
          },
        });
        outcomes.push({
          ok: true,
          result: {
            providerId: 'typescript-language-service',
            language: 'typescript',
            navigation: result.navigation,
            target: result.target,
            locations: result.locations,
            policyDeniedReads,
            ...(policyDeniedReadSamples.size > 0 ? {
              details: { policyDeniedReadSamples: [...policyDeniedReadSamples] },
            } : {}),
          },
        });
      } catch (error) {
        outcomes.push({
          ok: false,
          code: 'SEMANTIC_NAVIGATION_FAILED',
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
  } finally {
    clearTypeScriptNavigationCache();
  }

  process.stdout.write(`${JSON.stringify({ schemaVersion: 1, outcomes })}\n`);
  return 0;
}

if (import.meta.main) {
  try {
    process.exitCode = runTypeScriptNavigationSidecar();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
