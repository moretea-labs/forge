import { createHash } from 'crypto';
import type { VerificationRecord } from '../facade/types';

export interface VerificationEvidenceIdentity {
  sourceRevision: string;
  checkId: string;
  requestedChecks: string[];
  commandId?: string;
}

export interface EffectiveVerificationEvidence {
  record: VerificationRecord;
  current: boolean;
  staleReason?: string;
}

/** Stable identity for inputs that make a check result reusable. */
export function verificationInputFingerprint(input: VerificationEvidenceIdentity): string {
  return createHash('sha256').update(JSON.stringify({
    sourceRevision: input.sourceRevision,
    checkId: input.checkId,
    requestedChecks: [...input.requestedChecks].sort(),
    commandId: input.commandId ?? null,
  })).digest('hex');
}

export function commandFingerprint(checkId: string, commandId: string | undefined): string {
  return createHash('sha256').update(JSON.stringify({ checkId, commandId: commandId ?? null })).digest('hex');
}

/**
 * Keeps historical evidence auditable while preventing a previous revision or
 * changed check inputs from being selected as proof for the current Work.
 */
export function effectiveVerificationEvidence(
  records: VerificationRecord[],
  expected: Pick<VerificationEvidenceIdentity, 'sourceRevision' | 'checkId' | 'requestedChecks'>,
): EffectiveVerificationEvidence[] {
  const expectedFingerprint = verificationInputFingerprint({ ...expected });
  return records
    .filter((record) => record.checkId === expected.checkId)
    .map((record) => {
      if (record.supersedes) return { record, current: false, staleReason: 'superseded' };
      if (!record.sourceRevision || !record.verificationInputFingerprint) {
        return { record, current: false, staleReason: 'legacy evidence has no exact input identity' };
      }
      if (record.sourceRevision !== expected.sourceRevision) {
        return { record, current: false, staleReason: `source revision changed: ${record.sourceRevision} -> ${expected.sourceRevision}` };
      }
      if (record.verificationInputFingerprint !== expectedFingerprint) {
        return { record, current: false, staleReason: 'verification inputs changed' };
      }
      return { record, current: true };
    });
}
