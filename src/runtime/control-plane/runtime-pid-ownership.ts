import { existsSync, readFileSync } from 'fs';

export function forgeRuntimeOwnsPidFile(pidPath: string, pid = process.pid): boolean {
  if (!existsSync(pidPath)) return false;
  try {
    const recordedPid = Number.parseInt(readFileSync(pidPath, 'utf8').trim(), 10);
    return Number.isInteger(recordedPid) && recordedPid === pid;
  } catch {
    return false;
  }
}
