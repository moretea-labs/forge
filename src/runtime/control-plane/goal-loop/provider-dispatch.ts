import type { StructuredProviderOutput } from './types';
import { assertNoSecretsInText, redactProviderSummary } from './provider-registry';

export interface ProviderDispatchRequest {
  providerId: string;
  objective: string;
  acceptanceCriteria: string[];
  allowedPaths?: string[];
  constraintsSummary?: string;
  failureContext?: string;
  /** Historical test fixture input. It is never executed by the Kernel. */
  mockResponse?: StructuredProviderOutput | 'unsafe' | 'empty';
}

export interface ProviderDispatchResult {
  ok: boolean;
  providerId: string;
  directDispatch: boolean;
  appliedByForge: boolean;
  output?: StructuredProviderOutput;
  rejectionReason?: string;
  summary: string;
  liveCallAttempted: boolean;
}

/**
 * Retained as a pure parser for historical records and external-controller
 * adapters. Provider selection, invocation, patch application, and retries are
 * intentionally outside the deterministic Kernel.
 */
export function validateStructuredProviderOutput(
  value: unknown,
): { ok: true; output: StructuredProviderOutput } | { ok: false; reason: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, reason: 'Provider output must be a structured object.' };
  }
  const record = value as Record<string, unknown>;
  const summary = typeof record.summary === 'string' ? record.summary.trim() : '';
  if (!summary) return { ok: false, reason: 'Provider output missing summary.' };
  if (!assertNoSecretsInText(summary)) {
    return { ok: false, reason: 'Provider output summary appears to contain secrets.' };
  }

  const changed_files = Array.isArray(record.changed_files)
    ? record.changed_files.map(String).filter(Boolean).slice(0, 50)
    : [];
  const verification_commands = Array.isArray(record.verification_commands)
    ? record.verification_commands.map(String).filter(Boolean).slice(0, 20)
    : [];
  const risk_notes = Array.isArray(record.risk_notes)
    ? record.risk_notes.map(String).filter(Boolean).slice(0, 20)
    : [];
  const proposed_patch = typeof record.proposed_patch === 'string' ? record.proposed_patch : undefined;
  const patch_instructions = typeof record.patch_instructions === 'string' ? record.patch_instructions : undefined;

  if (!proposed_patch && !patch_instructions && changed_files.length === 0) {
    return { ok: false, reason: 'Provider output has no patch, instructions, or changed_files.' };
  }
  if (proposed_patch && /rm\s+-rf\s+[\/~]/.test(proposed_patch)) {
    return { ok: false, reason: 'Unsafe provider output rejected (destructive shell pattern).' };
  }
  if (proposed_patch && !assertNoSecretsInText(proposed_patch)) {
    return { ok: false, reason: 'Provider patch appears to embed secrets.' };
  }
  if (record.execute_shell === true || record.mutate_files_directly === true) {
    return { ok: false, reason: 'Provider output attempted direct mutation/execution bypass.' };
  }

  return {
    ok: true,
    output: redactProviderSummary({
      summary: summary.slice(0, 2_000),
      proposed_patch: proposed_patch?.slice(0, 50_000),
      patch_instructions: patch_instructions?.slice(0, 10_000),
      changed_files,
      verification_commands,
      risk_notes,
    }) as StructuredProviderOutput,
  };
}

/** Provider execution moved to the external SuperController boundary. */
export function dispatchProvider(request: ProviderDispatchRequest): ProviderDispatchResult {
  return {
    ok: false,
    providerId: request.providerId,
    directDispatch: false,
    appliedByForge: false,
    rejectionReason: 'PROVIDER_DISPATCH_RETIRED',
    summary: 'Kernel Provider dispatch is retired. Create a HandoffItem and let an external SuperController claim the Work.',
    liveCallAttempted: false,
  };
}
