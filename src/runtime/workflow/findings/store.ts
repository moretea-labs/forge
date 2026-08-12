import { createHash, randomUUID } from 'crypto';
import { readdirSync } from 'fs';
import { join } from 'path';
import { repositoryControllerRoot } from '../../../cli/repositories/controller-home';
import {
  listControlPlaneRecords,
  mutateControlPlaneRecord,
  readOrImportControlPlaneRecord,
} from '../../control-plane/persistence/sqlite-store';
import { appendRuntimeEvent } from '../../evidence/event-ledger';
import { readJsonFile, sanitizeFileComponent } from '../../shared/json-files';
import type { CandidateFinding, RecordCandidateFindingInput } from './types';

const FINDING_NAMESPACE = 'candidate_finding';
const FINDING_SCHEMA_VERSION = 1;
const MAX_EVIDENCE = 100;
const MAX_FINDINGS = 5_000;

function legacyRoot(controllerHome: string, repoId: string): string {
  return join(repositoryControllerRoot(controllerHome, repoId), 'candidate-findings');
}
function legacyRecordPath(controllerHome: string, repoId: string, findingId: string): string {
  return join(legacyRoot(controllerHome, repoId), 'records', `${sanitizeFileComponent(findingId)}.json`);
}
function legacySemanticPath(controllerHome: string, repoId: string, semanticKey: string): string {
  return join(legacyRoot(controllerHome, repoId), 'indexes', 'semantic', `${findingKey(semanticKey)}.json`);
}
function findingKey(semanticKey: string): string {
  return createHash('sha256').update(semanticKey).digest('hex');
}
function legacyFinding(controllerHome: string, repoId: string, findingId: string): CandidateFinding | undefined {
  try { return readJsonFile<CandidateFinding>(legacyRecordPath(controllerHome, repoId, findingId)); } catch { return undefined; }
}
function legacyFindingForSemanticKey(controllerHome: string, repoId: string, semanticKey: string): CandidateFinding | undefined {
  try {
    const reference = readJsonFile<{ findingId?: string }>(legacySemanticPath(controllerHome, repoId, semanticKey));
    return typeof reference.findingId === 'string' ? legacyFinding(controllerHome, repoId, reference.findingId) : undefined;
  } catch {
    return undefined;
  }
}
function records(controllerHome: string, repoId: string): CandidateFinding[] {
  return listControlPlaneRecords<CandidateFinding>(controllerHome, {
    namespace: FINDING_NAMESPACE,
    scope: repoId,
    limit: MAX_FINDINGS,
  }).map((record) => record.value);
}
function importLegacyFinding(controllerHome: string, repoId: string, finding: CandidateFinding): CandidateFinding {
  return readOrImportControlPlaneRecord<CandidateFinding>(controllerHome, {
    namespace: FINDING_NAMESPACE,
    scope: repoId,
    key: findingKey(finding.semanticKey),
    schemaVersion: FINDING_SCHEMA_VERSION,
    readLegacy: () => finding,
  })!.value;
}
function importLegacyFindings(controllerHome: string, repoId: string): CandidateFinding[] {
  const directory = join(legacyRoot(controllerHome, repoId), 'records');
  try {
    for (const name of readdirSync(directory).filter((entry) => entry.endsWith('.json')).slice(0, MAX_FINDINGS)) {
      const finding = legacyFinding(controllerHome, repoId, name.slice(0, -'.json'.length));
      if (finding?.repoId === repoId && finding.semanticKey) importLegacyFinding(controllerHome, repoId, finding);
    }
  } catch {
    // No legacy records is the normal v2 path.
  }
  return records(controllerHome, repoId);
}
function existingFinding(controllerHome: string, repoId: string, findingId: string): CandidateFinding | undefined {
  return records(controllerHome, repoId).find((finding) => finding.findingId === findingId)
    ?? (() => {
      const legacy = legacyFinding(controllerHome, repoId, findingId);
      return legacy?.repoId === repoId ? importLegacyFinding(controllerHome, repoId, legacy) : undefined;
    })();
}

export function getCandidateFinding(controllerHome: string, repoId: string, findingId: string): CandidateFinding {
  const finding = existingFinding(controllerHome, repoId, findingId);
  if (!finding) throw new Error(`CANDIDATE_FINDING_NOT_FOUND: ${findingId}`);
  return finding;
}

export function recordCandidateFinding(controllerHome: string, input: RecordCandidateFindingInput): CandidateFinding {
  const semanticKey = input.semanticKey.trim();
  const title = input.title.trim();
  const requestId = input.requestId.trim();
  if (!semanticKey) throw new Error('CANDIDATE_SEMANTIC_KEY_REQUIRED');
  if (!title) throw new Error('CANDIDATE_TITLE_REQUIRED');
  if (!requestId) throw new Error('CANDIDATE_REQUEST_ID_REQUIRED');
  const timestamp = input.evidence?.observedAt ?? new Date().toISOString();
  const record = mutateControlPlaneRecord<CandidateFinding>(controllerHome, {
    namespace: FINDING_NAMESPACE,
    scope: input.repoId,
    key: findingKey(semanticKey),
    schemaVersion: FINDING_SCHEMA_VERSION,
    action: 'candidate_finding_observed',
    readLegacy: () => legacyFindingForSemanticKey(controllerHome, input.repoId, semanticKey),
    mutate: (current) => {
      const previous = current?.value;
      const evidence = input.evidence
        ? [...(previous?.evidence ?? []), { ...input.evidence, observedAt: timestamp }].slice(-MAX_EVIDENCE)
        : previous?.evidence ?? [];
      return previous ? {
        ...previous,
        revision: previous.revision + 1,
        title,
        summary: input.summary ?? previous.summary,
        severity: input.severity ?? previous.severity,
        status: previous.status === 'dismissed' ? 'candidate' : previous.status,
        observationCount: previous.observationCount + 1,
        evidence,
        lastSeenAt: timestamp,
        dismissedReason: previous.status === 'dismissed' ? undefined : previous.dismissedReason,
        requirementId: input.requirementId ?? previous.requirementId,
        kind: input.kind ?? previous.kind,
        sourceRepoId: input.sourceRepoId ?? previous.sourceRepoId,
        sourceWorkId: input.sourceWorkId ?? previous.sourceWorkId,
        sourceProcessId: input.sourceProcessId ?? previous.sourceProcessId,
        sourcePluginId: input.sourcePluginId ?? previous.sourcePluginId,
        externalRefs: input.externalRefs ?? previous.externalRefs,
      } : {
        schemaVersion: 1,
        revision: 1,
        findingId: `FIND-${Date.now()}-${randomUUID().slice(0, 8)}`,
        repoId: input.repoId,
        semanticKey,
        title,
        summary: input.summary,
        severity: input.severity ?? 'medium',
        status: 'candidate',
        observationCount: 1,
        evidence,
        firstSeenAt: timestamp,
        lastSeenAt: timestamp,
        requirementId: input.requirementId,
        kind: input.kind,
        sourceRepoId: input.sourceRepoId,
        sourceWorkId: input.sourceWorkId,
        sourceProcessId: input.sourceProcessId,
        sourcePluginId: input.sourcePluginId,
        externalRefs: input.externalRefs,
      };
    },
  });
  const finding = record.value;
  appendRuntimeEvent(controllerHome, {
    repoId: finding.repoId,
    entityType: 'candidate-finding',
    entityId: finding.findingId,
    eventType: finding.observationCount === 1 ? 'candidate_finding_created' : 'candidate_finding_observed',
    requestId,
    revision: finding.revision,
    data: { semanticKey, observationCount: finding.observationCount, severity: finding.severity },
  });
  return finding;
}

export function updateCandidateFinding(
  controllerHome: string,
  repoId: string,
  findingId: string,
  updater: (current: CandidateFinding) => CandidateFinding,
  requestId: string,
  eventType: string,
): CandidateFinding {
  const existing = getCandidateFinding(controllerHome, repoId, findingId);
  const record = mutateControlPlaneRecord<CandidateFinding>(controllerHome, {
    namespace: FINDING_NAMESPACE,
    scope: repoId,
    key: findingKey(existing.semanticKey),
    schemaVersion: FINDING_SCHEMA_VERSION,
    action: eventType,
    mutate: (current) => {
      const previous = current?.value ?? existing;
      const next = updater(structuredClone(previous));
      if (next.findingId !== previous.findingId || next.repoId !== previous.repoId || next.semanticKey !== previous.semanticKey) {
        throw new Error('CANDIDATE_IDENTITY_IMMUTABLE');
      }
      return { ...next, revision: previous.revision + 1, lastSeenAt: new Date().toISOString() };
    },
  });
  const finding = record.value;
  appendRuntimeEvent(controllerHome, {
    repoId,
    entityType: 'candidate-finding',
    entityId: findingId,
    eventType,
    requestId,
    revision: finding.revision,
    data: { status: finding.status, promotedJobId: finding.promotedJobId },
  });
  return finding;
}

export function listCandidateFindings(controllerHome: string, repoId: string, options: { includeTerminal?: boolean; limit?: number } = {}): CandidateFinding[] {
  const bounded = Math.max(1, Math.min(options.limit ?? 100, 1000));
  const stored = records(controllerHome, repoId);
  const all = stored.length > 0 ? stored : importLegacyFindings(controllerHome, repoId);
  return all
    .filter((finding) => options.includeTerminal || finding.status === 'candidate')
    .sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt))
    .slice(0, bounded);
}
