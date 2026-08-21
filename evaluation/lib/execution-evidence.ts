import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import type { EvidenceRecord, ExecutionEvidence, ToolInteraction } from './types.ts';

function records(value: unknown, path: string): EvidenceRecord[] {
  if (!Array.isArray(value)) throw new Error(`${path} must be an array`);
  return value.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error(`${path}[${index}] must be an object`);
    const record = entry as Record<string, unknown>;
    for (const key of ['domain', 'source', 'summary'] as const) {
      if (typeof record[key] !== 'string' || record[key].trim().length === 0) throw new Error(`${path}[${index}].${key} must be a non-empty string`);
    }
    return { domain: record.domain as string, source: record.source as string, summary: record.summary as string };
  });
}

function interactions(value: unknown): ToolInteraction[] {
  if (!Array.isArray(value)) throw new Error('toolInteractions must be an array');
  return value.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error(`toolInteractions[${index}] must be an object`);
    const record = entry as Record<string, unknown>;
    if (typeof record.name !== 'string' || record.name.trim().length === 0) throw new Error(`toolInteractions[${index}].name must be a non-empty string`);
    if (record.outcome !== 'success' && record.outcome !== 'failure') throw new Error(`toolInteractions[${index}].outcome must be success or failure`);
    return { kind: 'forge_tool', name: record.name, outcome: record.outcome };
  });
}

export function loadExecutionEvidence(repository: string, traceFile: string | undefined): { evidence: ExecutionEvidence; error?: string } {
  const empty: ExecutionEvidence = { contextRetrieval: [], inspectedEvidence: [], toolInteractions: [] };
  if (!traceFile) return { evidence: empty };
  const absolute = resolve(repository, traceFile);
  const path = relative(repository, absolute);
  if (isAbsolute(traceFile) || path === '' || path.startsWith('..') || isAbsolute(path)) {
    return { evidence: empty, error: `execution.traceFile must resolve inside the sandbox: ${traceFile}` };
  }
  if (!existsSync(absolute)) return { evidence: empty, error: `execution trace file was not produced: ${traceFile}` };
  try {
    const value = JSON.parse(readFileSync(absolute, 'utf8')) as Record<string, unknown>;
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('trace root must be an object');
    const finalResult = value.finalResult;
    if (finalResult !== undefined && (typeof finalResult !== 'string' || finalResult.trim().length === 0)) {
      throw new Error('finalResult must be a non-empty string when supplied');
    }
    return {
      evidence: {
        contextRetrieval: records(value.contextRetrieval ?? [], 'contextRetrieval'),
        inspectedEvidence: records(value.inspectedEvidence ?? [], 'inspectedEvidence'),
        toolInteractions: interactions(value.toolInteractions ?? []),
        finalResult: finalResult as string | undefined,
      },
    };
  } catch (error) {
    return { evidence: empty, error: `invalid execution trace file ${traceFile}: ${error instanceof Error ? error.message : String(error)}` };
  }
}
