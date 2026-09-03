import { createHash } from 'crypto';
import type { ContextClosureReceipt } from './engineering-contracts';

export function contextClosureReceiptIdentity(value: ContextClosureReceipt): string {
  const unique = (values: string[], limit: number): string[] => {
    const out = [...new Set(values.map((entry) => entry.trim()).filter(Boolean))];
    if (out.length > limit) throw new Error('CONTEXT_CLOSURE_RECEIPT_BOUNDS_INVALID');
    return out;
  };
  const core = {
    sourceRevision: value.sourceRevision.trim(),
    projectContractDigest: value.projectContract?.contentDigest ?? null,
    currentPaths: unique(value.sourceEvidence.currentPaths, 48),
    testPaths: unique(value.sourceEvidence.testPaths, 24),
    languages: unique(value.detected.languages, 16).sort(),
    platforms: unique(value.detected.platforms, 16).sort(),
    skillIds: value.skills.resolved.map((skill) => `${skill.id.trim()}@${skill.version?.trim() ?? ''}`),
    semanticProviders: value.semanticTools.providers.map((provider) => `${provider.providerId.trim()}:${provider.status}`),
    reasonCodes: unique(value.readiness.reasonCodes, 80),
  };
  return `context_closure_${createHash('sha256').update(JSON.stringify(core)).digest('hex').slice(0, 32)}`;
}

export function validateContextClosureReceipt(value: ContextClosureReceipt): ContextClosureReceipt {
  if (value.schemaVersion !== 1) throw new Error('CONTEXT_CLOSURE_RECEIPT_SCHEMA_INVALID');
  if (!value.sourceRevision?.trim()) throw new Error('CONTEXT_CLOSURE_SOURCE_REQUIRED');
  if (!Number.isFinite(Date.parse(value.generatedAt))) throw new Error('CONTEXT_CLOSURE_GENERATED_AT_INVALID');
  if (value.provenance?.source !== 'rh_context' || !Number.isFinite(Date.parse(value.provenance.contextGeneratedAt))) throw new Error('CONTEXT_CLOSURE_PROVENANCE_INVALID');
  if (!['ready', 'degraded', 'insufficient'].includes(value.readiness.status)) throw new Error('CONTEXT_CLOSURE_READINESS_INVALID');
  if (value.receiptId !== contextClosureReceiptIdentity(value)) throw new Error('CONTEXT_CLOSURE_RECEIPT_ID_INVALID');
  return value;
}
