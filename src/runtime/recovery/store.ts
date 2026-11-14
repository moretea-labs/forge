import { readdirSync } from 'fs';
import { join } from 'path';
import { controllerSystemRoot, repositoryControllerRoot } from '../../effects/controller-home';
import { readJsonFile, sanitizeFileComponent, writeJsonAtomic } from '../shared/json-files';
import type { RecoveryAuditRecord } from './types';

function repositoryRecoveryRoot(controllerHome: string, repoId: string): string {
  return join(repositoryControllerRoot(controllerHome, repoId), 'recovery');
}

function instanceRecoveryRoot(controllerHome: string): string {
  return join(controllerSystemRoot(controllerHome), 'recovery');
}

function auditRoot(root: string): string {
  return join(root, 'audit');
}

function listAuditRecords(root: string, limit: number): RecoveryAuditRecord[] {
  const directory = auditRoot(root);
  let names: string[];
  try { names = readdirSync(directory); } catch { return []; }
  return names
    .filter((name) => name.endsWith('.json'))
    .sort()
    .reverse()
    .slice(0, Math.max(1, Math.min(Math.trunc(limit), 100)))
    .flatMap((name) => {
      try { return [readJsonFile<RecoveryAuditRecord>(join(directory, name))]; }
      catch { return []; }
    });
}

export function writeRecoveryAuditRecord(controllerHome: string, repoId: string, record: RecoveryAuditRecord): RecoveryAuditRecord {
  writeJsonAtomic(join(auditRoot(repositoryRecoveryRoot(controllerHome, repoId)), `${sanitizeFileComponent(record.id)}.json`), record);
  return record;
}

export function listRecoveryAuditRecords(controllerHome: string, repoId: string, limit = 20): RecoveryAuditRecord[] {
  return listAuditRecords(repositoryRecoveryRoot(controllerHome, repoId), limit);
}

export function writeInstanceRecoveryAuditRecord(controllerHome: string, record: RecoveryAuditRecord): RecoveryAuditRecord {
  writeJsonAtomic(join(auditRoot(instanceRecoveryRoot(controllerHome)), `${sanitizeFileComponent(record.id)}.json`), record);
  return record;
}

export function listInstanceRecoveryAuditRecords(controllerHome: string, limit = 20): RecoveryAuditRecord[] {
  return listAuditRecords(instanceRecoveryRoot(controllerHome), limit);
}
