import { createHash, randomUUID } from 'crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { processLogDir } from './store';

export interface PersistedCheckResultReceipt {
  schemaVersion: 1;
  receiptId: string;
  checkId: string;
  cacheKey: string;
  ok: boolean;
  status: number;
  timedOut: boolean;
  failureClass?: 'acceptance_failure' | 'infrastructure_failure';
  validatedRevision?: string;
  executedAt: string;
  originalExecutedAt?: string;
  cacheHit?: boolean;
}

export function allocatePersistedCheckResultReceiptPath(controllerHome: string, repoId: string): string {
  const root = join(processLogDir(controllerHome, repoId), 'check-results');
  mkdirSync(root, { recursive: true });
  return join(root, `${randomUUID()}.json`);
}

export function writePersistedCheckResultReceipt(path: string, input: Omit<PersistedCheckResultReceipt, 'schemaVersion' | 'receiptId'>): PersistedCheckResultReceipt {
  const digest = createHash('sha256').update(JSON.stringify(input)).digest('hex');
  const receipt: PersistedCheckResultReceipt = { schemaVersion: 1, receiptId: `check_result_${digest.slice(0, 24)}`, ...input };
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
  return receipt;
}

export function readPersistedCheckResultReceipt(path: string | undefined): PersistedCheckResultReceipt | undefined {
  if (!path || !existsSync(path)) return undefined;
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as PersistedCheckResultReceipt;
    return value?.schemaVersion === 1 && typeof value.receiptId === 'string' && typeof value.cacheKey === 'string' ? value : undefined;
  } catch {
    return undefined;
  }
}
