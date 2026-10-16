import { randomUUID } from 'crypto';
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'fs';
import { dirname } from 'path';

/**
 * The single atomic text writer for Forge-managed service and release files.
 * Create private parent directories, use a collision-resistant temporary file,
 * preserve the caller-selected target mode, and remove abandoned temp files
 * after a failed write or rename. An atomic rename is not an fsync guarantee.
 */
export function writeAtomicTextFile(path: string, content: string, mode = 0o600): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, content, { encoding: 'utf8', mode, flag: 'wx' });
    renameSync(temporary, path);
  } catch (error) {
    try { rmSync(temporary, { force: true }); } catch { /* preserve original write failure */ }
    throw error;
  }
}
