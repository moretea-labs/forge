import { chmodSync, lstatSync, openSync, closeSync, readSync, readdirSync } from 'fs';
import { join, resolve } from 'path';

const EXCLUDED_DIRECTORIES = new Set([
  '.git',
  '.ai',
  '.forge',
  '_ops',
  'node_modules',
  'dist',
  'coverage',
]);

export interface ExecutableModeRepairResult {
  root: string;
  scannedFiles: number;
  shebangFiles: number;
  repaired: string[];
  missingExecutable: string[];
}

function hasShebang(path: string): boolean {
  let fd: number | undefined;
  try {
    fd = openSync(path, 'r');
    const buffer = Buffer.alloc(2);
    return readSync(fd, buffer, 0, 2, 0) === 2 && buffer.toString('utf8') === '#!';
  } catch {
    return false;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export function repairExecutableModes(repoRoot: string, checkOnly = false): ExecutableModeRepairResult {
  const root = resolve(repoRoot);
  const result: ExecutableModeRepairResult = {
    root,
    scannedFiles: 0,
    shebangFiles: 0,
    repaired: [],
    missingExecutable: [],
  };

  const visit = (directory: string, relativeDirectory = ''): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory() && EXCLUDED_DIRECTORIES.has(entry.name)) continue;
      const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      const absolutePath = join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(absolutePath, relativePath);
        continue;
      }
      if (!entry.isFile()) continue;
      result.scannedFiles += 1;
      if (!hasShebang(absolutePath)) continue;
      result.shebangFiles += 1;
      const mode = lstatSync(absolutePath).mode & 0o777;
      if ((mode & 0o111) !== 0) continue;
      result.missingExecutable.push(relativePath);
      if (!checkOnly) {
        chmodSync(absolutePath, mode | 0o111);
        result.repaired.push(relativePath);
      }
    }
  };

  visit(root);
  return result;
}
