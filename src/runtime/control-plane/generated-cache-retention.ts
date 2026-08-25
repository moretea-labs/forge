import { execFileSync } from 'child_process';
import {
  existsSync,
  lstatSync,
  readdirSync,
  realpathSync,
  rmSync,
} from 'fs';
import { homedir } from 'os';
import { basename, join, relative, resolve, sep } from 'path';

const DEFAULT_GENERATED_CACHE_GRACE_MS = 6 * 60 * 60_000;
const DEFAULT_SCAN_BUDGET = 1_000;
const DEFAULT_REMOVAL_BUDGET = 8;

export interface GeneratedCacheRetentionOptions {
  nowMs?: number;
  graceMs?: number;
  maxEntries?: number;
  maxRemovals?: number;
  processCommands?: string[];
}

export interface GeneratedCacheRetentionReport {
  inspected: number;
  eligible: number;
  removedPaths: string[];
  retainedPaths: string[];
  skippedByReason: Record<string, number>;
  errors: string[];
  budgetExhausted: boolean;
}

export interface XCTestDeviceCleanupReport {
  attempted: boolean;
  removedDevices: number;
  skippedReason?: string;
  error?: string;
}

interface Candidate {
  path: string;
  kind: 'forge_ios_derived_data' | 'harness_derived_data' | 'repo_harness_derived_data' | 'tmp_derived_data';
}

function increment(counts: Record<string, number>, reason: string): void {
  counts[reason] = (counts[reason] ?? 0) + 1;
}

function canonical(path: string): string {
  try { return realpathSync(path); } catch { return resolve(path); }
}

function pathInside(root: string, path: string): boolean {
  const base = canonical(root);
  const target = canonical(path);
  const rel = relative(base, target);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`);
}

function collectProcessCommands(): string[] {
  try {
    return execFileSync('ps', ['-axo', 'command='], {
      encoding: 'utf8',
      timeout: 2_000,
      maxBuffer: 2 * 1024 * 1024,
    }).split('\n').map((line) => line.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

function commandReferencesPath(commands: readonly string[], repoRoot: string, path: string): boolean {
  const absolute = canonical(path);
  const rel = relative(resolve(repoRoot), absolute).replace(/\\/g, '/');
  return commands.some((command) => command.includes(absolute) || (rel && command.includes(rel)));
}

function containsTrackedFiles(repoRoot: string, path: string): boolean {
  const rel = relative(resolve(repoRoot), resolve(path));
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`)) return true;
  try {
    const output = execFileSync('git', ['-C', repoRoot, 'ls-files', '--', rel], {
      encoding: 'utf8',
      timeout: 2_000,
      maxBuffer: 256 * 1024,
    });
    return output.trim().length > 0;
  } catch {
    // If repository identity cannot be proven, fail closed.
    return true;
  }
}

function directChildDirectories(root: string, predicate: (name: string) => boolean, budget: { remaining: number }): string[] {
  if (!existsSync(root) || budget.remaining <= 0) return [];
  const found: string[] = [];
  let entries;
  try { entries = readdirSync(root, { withFileTypes: true }); } catch { return found; }
  for (const entry of entries) {
    if (budget.remaining <= 0) break;
    budget.remaining -= 1;
    const name = String(entry.name);
    if (entry.isDirectory() && predicate(name)) found.push(join(root, name));
  }
  return found;
}

function nestedDerivedDataDirectories(root: string, maxDepth: number, budget: { remaining: number }): string[] {
  if (!existsSync(root) || budget.remaining <= 0) return [];
  const found: string[] = [];
  const visit = (dir: string, depth: number): void => {
    if (depth > maxDepth || budget.remaining <= 0) return;
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (budget.remaining <= 0) return;
      budget.remaining -= 1;
      if (!entry.isDirectory()) continue;
      const path = join(dir, String(entry.name));
      if (String(entry.name) === 'DerivedData') {
        found.push(path);
        continue;
      }
      visit(path, depth + 1);
    }
  };
  visit(root, 0);
  return found;
}

function discoverCandidates(repoRoot: string, maxEntries: number): { candidates: Candidate[]; inspected: number; truncated: boolean } {
  const root = resolve(repoRoot);
  const budget = { remaining: Math.max(1, maxEntries) };
  const initial = budget.remaining;
  const candidates: Candidate[] = [];

  for (const path of directChildDirectories(join(root, '.forge', 'ios', 'DerivedData'), () => true, budget)) {
    candidates.push({ path, kind: 'forge_ios_derived_data' });
  }
  for (const path of directChildDirectories(join(root, '.ai', 'harness'), (name) => name.startsWith('deriveddata-'), budget)) {
    candidates.push({ path, kind: 'harness_derived_data' });
  }
  for (const path of nestedDerivedDataDirectories(join(root, '.repo-harness'), 5, budget)) {
    candidates.push({ path, kind: 'repo_harness_derived_data' });
  }
  for (const path of nestedDerivedDataDirectories(join(root, '.tmp'), 6, budget)) {
    candidates.push({ path, kind: 'tmp_derived_data' });
  }

  return {
    candidates: candidates.filter((candidate, index, values) => values.findIndex((item) => resolve(item.path) === resolve(candidate.path)) === index),
    inspected: initial - budget.remaining,
    truncated: budget.remaining <= 0,
  };
}

/**
 * Reclaim only rebuildable Xcode DerivedData under Forge/repo-harness-owned
 * namespaces. Result bundles, logs, edit-session metadata, and all tracked files
 * are deliberately outside this cleanup surface.
 */
export function cleanupGeneratedRepositoryCaches(
  repoRoot: string,
  options: GeneratedCacheRetentionOptions = {},
): GeneratedCacheRetentionReport {
  const nowMs = options.nowMs ?? Date.now();
  const graceMs = Math.max(60_000, Math.floor(options.graceMs ?? DEFAULT_GENERATED_CACHE_GRACE_MS));
  const maxEntries = Math.max(1, Math.floor(options.maxEntries ?? DEFAULT_SCAN_BUDGET));
  let remainingRemovals = Math.max(1, Math.floor(options.maxRemovals ?? DEFAULT_REMOVAL_BUDGET));
  const commands = options.processCommands ?? collectProcessCommands();
  const discovered = discoverCandidates(repoRoot, maxEntries);
  const report: GeneratedCacheRetentionReport = {
    inspected: discovered.inspected,
    eligible: 0,
    removedPaths: [],
    retainedPaths: [],
    skippedByReason: {},
    errors: [],
    budgetExhausted: discovered.truncated,
  };

  for (const candidate of discovered.candidates) {
    const ownedRoot = candidate.kind === 'forge_ios_derived_data'
      ? join(repoRoot, '.forge', 'ios', 'DerivedData')
      : candidate.kind === 'harness_derived_data'
        ? join(repoRoot, '.ai', 'harness')
        : candidate.kind === 'repo_harness_derived_data'
          ? join(repoRoot, '.repo-harness')
          : join(repoRoot, '.tmp');
    try {
      const stat = lstatSync(candidate.path);
      if (!stat.isDirectory() || stat.isSymbolicLink() || !pathInside(ownedRoot, candidate.path)) {
        increment(report.skippedByReason, 'ownership_unproven');
        report.retainedPaths.push(relative(repoRoot, candidate.path));
        continue;
      }
      if (nowMs - stat.mtimeMs < graceMs) {
        increment(report.skippedByReason, 'retention_grace');
        continue;
      }
      if (commandReferencesPath(commands, repoRoot, candidate.path)) {
        increment(report.skippedByReason, 'active_process');
        report.retainedPaths.push(relative(repoRoot, candidate.path));
        continue;
      }
      if (containsTrackedFiles(repoRoot, candidate.path)) {
        increment(report.skippedByReason, 'tracked_content');
        report.retainedPaths.push(relative(repoRoot, candidate.path));
        continue;
      }
      report.eligible += 1;
      if (remainingRemovals <= 0) {
        report.budgetExhausted = true;
        increment(report.skippedByReason, 'cleanup_budget_exhausted');
        continue;
      }
      remainingRemovals -= 1;
      rmSync(candidate.path, { recursive: true, force: true });
      report.removedPaths.push(relative(repoRoot, candidate.path).replace(/\\/g, '/'));
    } catch (error) {
      report.errors.push(`${candidate.kind}:${relative(repoRoot, candidate.path)}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return report;
}

/**
 * XCTest's private device set is separate from the user's normal CoreSimulator
 * devices. When Forge is idle, delete only that dedicated set through simctl so
 * XCTest clones cannot accumulate indefinitely. Never rm the device set.
 */
export function cleanupIdleXCTestDevices(controllerHome: string): XCTestDeviceCleanupReport {
  if (process.platform !== 'darwin') return { attempted: false, removedDevices: 0, skippedReason: 'not_darwin' };
  const normalizedControllerHome = resolve(controllerHome).replace(/\\/g, '/');
  if (!normalizedControllerHome.includes('/.forge/controller')) {
    return { attempted: false, removedDevices: 0, skippedReason: 'nonstandard_controller_home' };
  }
  const deviceSet = join(homedir(), 'Library', 'Developer', 'XCTestDevices');
  if (!existsSync(deviceSet)) return { attempted: false, removedDevices: 0, skippedReason: 'device_set_missing' };
  let deviceDirectories = 0;
  try {
    deviceDirectories = readdirSync(deviceSet, { withFileTypes: true }).filter((entry) => entry.isDirectory()).length;
  } catch (error) {
    return { attempted: false, removedDevices: 0, error: error instanceof Error ? error.message : String(error) };
  }
  if (deviceDirectories <= 4) return { attempted: false, removedDevices: 0, skippedReason: 'below_cleanup_threshold' };

  const commands = collectProcessCommands();
  if (commands.some((command) => /(?:^|\/)(?:xcodebuild|xctest|swiftc)(?:\s|$)/.test(command))) {
    return { attempted: false, removedDevices: 0, skippedReason: 'active_xcode_process' };
  }
  try {
    const listed = execFileSync('xcrun', ['simctl', '--set', deviceSet, 'list', 'devices', '--json'], {
      encoding: 'utf8',
      timeout: 10_000,
      maxBuffer: 2 * 1024 * 1024,
    });
    const parsed = JSON.parse(listed) as { devices?: Record<string, Array<{ state?: string }>> };
    const devices = Object.values(parsed.devices ?? {}).flat();
    if (devices.some((device) => device.state === 'Booted')) {
      return { attempted: false, removedDevices: 0, skippedReason: 'booted_xctest_device' };
    }
    execFileSync('xcrun', ['simctl', '--set', deviceSet, 'shutdown', 'all'], { timeout: 15_000, stdio: 'ignore' });
    execFileSync('xcrun', ['simctl', '--set', deviceSet, 'delete', 'all'], { timeout: 30_000, stdio: 'ignore' });
    return { attempted: true, removedDevices: devices.length };
  } catch (error) {
    return { attempted: true, removedDevices: 0, error: error instanceof Error ? error.message : String(error) };
  }
}
