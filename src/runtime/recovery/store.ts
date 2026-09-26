import { mkdirSync, readdirSync } from 'fs';
import { join } from 'path';
import { controllerSystemRoot, repositoryControllerRoot } from '../../cli/repositories/controller-home';
import { readJsonFile, sanitizeFileComponent, writeJsonAtomic } from '../shared/json-files';
import type { RecoveryAuditRecord } from './types';

function repositoryRecoveryRoot(controllerHome: string, repoId: string): string {
  const root = join(repositoryControllerRoot(controllerHome, repoId), 'recovery');
  mkdirSync(root, { recursive: true });
  return root;
}

function instanceRecoveryRoot(controllerHome: string): string {
  const root = join(controllerSystemRoot(controllerHome), 'recovery');
  mkdirSync(root, { recursive: true });
  return root;
}

function auditRoot(root: string): string {
  const value = join(root, 'audit');
  mkdirSync(value, { recursive: true });
  return value;
}

function listAuditRecords(root: string, limit: number): RecoveryAuditRecord[] {
  return readdirSync(auditRoot(root))
    .filter((name) => name.endsWith('.json'))
    .sort()
    .reverse()
    .slice(0, Math.max(1, Math.min(Math.trunc(limit), 100)))
    .flatMap((name) => {
      try { return [readJsonFile<RecoveryAuditRecord>(join(auditRoot(root), name))]; }
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
