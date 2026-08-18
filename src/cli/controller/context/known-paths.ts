import { existsSync, lstatSync, readdirSync, statSync } from 'fs';
import { globMatches, resolveMcpPath } from '../../mcp/paths';
import type { McpPolicy } from '../../mcp/types';

export function looksLikeGlob(path: string): boolean { return /[*?{[]/.test(path); }
export function coveredByGlob(path: string, globs: string[]): boolean {
  return globs.length === 0 || globs.some((glob) => globMatches(glob, path));
}
export function addReason(
  map: Map<string, { reasons: Set<string>; lines: Set<number> }>,
  path: string,
  reason: string,
  line?: number,
): void {
  const entry = map.get(path) ?? { reasons: new Set<string>(), lines: new Set<number>() };
  entry.reasons.add(reason);
  if (typeof line === 'number' && Number.isFinite(line)) entry.lines.add(Math.max(1, Math.trunc(line)));
  map.set(path, entry);
}

export function readableFile(repoRoot: string, policy: McpPolicy, path: string): { ok: true; path: string } | { ok: false; path: string; reason: string } {
  const decision = resolveMcpPath(repoRoot, path, policy, 'read');
  if (!decision.ok || !decision.relativePath || !decision.absolutePath) {
    return { ok: false, path: decision.relativePath ?? path, reason: decision.reason ?? 'path denied' };
  }
  if (!existsSync(decision.absolutePath)) return { ok: false, path: decision.relativePath, reason: 'path does not exist' };
  if (!statSync(decision.absolutePath).isFile()) return { ok: false, path: decision.relativePath, reason: 'path is not a file' };
  return { ok: true, path: decision.relativePath };
}

export interface ExpandedKnownPath {
  files: string[];
  denied: Array<{ path: string; reason: string }>;
  directory?: string;
  truncated: boolean;
}

export function expandKnownPath(repoRoot: string, policy: McpPolicy, path: string, maxFiles: number): ExpandedKnownPath {
  const decision = resolveMcpPath(repoRoot, path, policy, 'read');
  if (!decision.ok || !decision.relativePath || !decision.absolutePath) {
    return { files: [], denied: [{ path: decision.relativePath ?? path, reason: decision.reason ?? 'path denied' }], truncated: false };
  }
  if (!existsSync(decision.absolutePath)) return { files: [], denied: [{ path: decision.relativePath, reason: 'path does not exist' }], truncated: false };
  const rootStat = lstatSync(decision.absolutePath);
  if (rootStat.isSymbolicLink()) return { files: [], denied: [{ path: decision.relativePath, reason: 'symbolic links are not followed' }], truncated: false };
  if (rootStat.isFile()) return { files: [decision.relativePath], denied: [], truncated: false };
  if (!rootStat.isDirectory()) return { files: [], denied: [{ path: decision.relativePath, reason: 'path is neither a regular file nor directory' }], truncated: false };

  const files: string[] = [];
  const denied: Array<{ path: string; reason: string }> = [];
  let truncated = false;
  const walk = (relativeDirectory: string, depth: number): void => {
    if (files.length >= maxFiles) { truncated = true; return; }
    if (depth > 8) { denied.push({ path: relativeDirectory, reason: 'directory recursion depth exceeded' }); return; }
    const directory = resolveMcpPath(repoRoot, relativeDirectory, policy, 'read');
    if (!directory.ok || !directory.absolutePath || !directory.relativePath) {
      denied.push({ path: directory.relativePath ?? relativeDirectory, reason: directory.reason ?? 'path denied' });
      return;
    }
    let entries;
    try { entries = readdirSync(directory.absolutePath, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name)); }
    catch (error) { denied.push({ path: directory.relativePath, reason: error instanceof Error ? error.message : String(error) }); return; }
    for (const entry of entries) {
      if (files.length >= maxFiles) { truncated = true; break; }
      const child = `${directory.relativePath}/${entry.name}`.replace(/^\.\//, '');
      if (entry.isSymbolicLink()) denied.push({ path: child, reason: 'symbolic links are not followed' });
      else if (entry.isDirectory()) walk(child, depth + 1);
      else if (entry.isFile()) {
        const readable = readableFile(repoRoot, policy, child);
        if (readable.ok) files.push(readable.path); else denied.push(readable);
      }
    }
  };
  walk(decision.relativePath, 0);
  return { files, denied, directory: decision.relativePath, truncated };
}
