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
import { repositoryControllerRoot } from '../../cli/repositories/controller-home';

const DEFAULT_GENERATED_CACHE_GRACE_MS = 6 * 60 * 60_000;
const DEFAULT_BROWSER_UPLOAD_GRACE_MS = 24 * 60 * 60_000;
const DEFAULT_BROWSER_SCREENSHOT_GRACE_MS = 7 * 24 * 60 * 60_000;
const DEFAULT_BROWSER_ARTIFACT_ACTIVE_GRACE_MS = 60 * 60_000;
const DEFAULT_SCAN_BUDGET = 1_000;
const DEFAULT_REMOVAL_BUDGET = 8;
const DEFAULT_BROWSER_ARTIFACT_SCAN_BUDGET = 1_000;
const DEFAULT_BROWSER_ARTIFACT_REMOVAL_BUDGET = 16;

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

export type BrowserDisposableArtifactKind = 'screenshots' | 'downloads' | 'diagnostics';

export interface BrowserArtifactRetentionOptions {
  nowMs?: number;
  activeGraceMs?: number;
  graceMs?: number;
  maxEntries?: number;
  maxRemovals?: number;
  maxCountPerClass?: number;
  maxBytesPerClass?: number;
}

export interface BrowserArtifactClassRetentionReport {
  inspected: number;
  eligible: number;
  removedCount: number;
  removedBytes: number;
  retainedCount: number;
  totalBytesBefore: number;
  totalBytesAfter: number;
  overCapacity: boolean;
  blockers: string[];
}

export interface BrowserArtifactRetentionReport {
  policyVersion: 'browser-disposable-artifact-retention-v1';
  inspected: number;
  removedPaths: string[];
  removedBytes: number;
  skippedByReason: Record<string, number>;
  errors: string[];
  budgetExhausted: boolean;
  classes: Record<BrowserDisposableArtifactKind, BrowserArtifactClassRetentionReport>;
}

export interface XCTestDeviceCleanupReport {
  attempted: boolean;
  removedDevices: number;
  skippedReason?: string;
  error?: string;
}

interface Candidate {
  path: string;
  kind:
    | 'forge_ios_derived_data'
    | 'harness_derived_data'
    | 'repo_harness_derived_data'
    | 'tmp_derived_data'
    | 'forge_browser_upload'
    | 'forge_browser_screenshot';
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
  const rawAbsolute = resolve(path);
  const canonicalAbsolute = canonical(path);
  const rawRelative = relative(resolve(repoRoot), rawAbsolute).replace(/\\/g, '/');
  const canonicalRelative = relative(canonical(repoRoot), canonicalAbsolute).replace(/\\/g, '/');
  return commands.some((command) => command.includes(rawAbsolute)
    || command.includes(canonicalAbsolute)
    || (rawRelative && command.includes(rawRelative))
    || (canonicalRelative && command.includes(canonicalRelative)));
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

function directChildFiles(root: string, budget: { remaining: number }): string[] {
  if (!existsSync(root) || budget.remaining <= 0) return [];
  const found: string[] = [];
  let entries;
  try { entries = readdirSync(root, { withFileTypes: true }); } catch { return found; }
  for (const entry of entries) {
    if (budget.remaining <= 0) break;
    budget.remaining -= 1;
    if (entry.isFile()) found.push(join(root, entry.name));
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

  // Browser artifacts are direct children of small, explicitly owned roots.
  // Scan them before recursively walking potentially high-cardinality cache
  // trees so cache history cannot starve their retention policy.
  for (const path of directChildFiles(join(root, '.forge', 'browser', 'uploads'), budget)) {
    candidates.push({ path, kind: 'forge_browser_upload' });
  }
  for (const path of directChildFiles(join(root, '.forge', 'browser', 'screenshots'), budget)) {
    candidates.push({ path, kind: 'forge_browser_screenshot' });
  }
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

function retentionGraceMs(candidate: Candidate, explicitGraceMs: number | undefined): number {
  if (explicitGraceMs !== undefined) return Math.max(60_000, Math.floor(explicitGraceMs));
  if (candidate.kind === 'forge_browser_upload') return DEFAULT_BROWSER_UPLOAD_GRACE_MS;
  if (candidate.kind === 'forge_browser_screenshot') return DEFAULT_BROWSER_SCREENSHOT_GRACE_MS;
  return DEFAULT_GENERATED_CACHE_GRACE_MS;
}

function candidateOwnedRoot(repoRoot: string, candidate: Candidate): string {
  switch (candidate.kind) {
    case 'forge_ios_derived_data': return join(repoRoot, '.forge', 'ios', 'DerivedData');
    case 'harness_derived_data': return join(repoRoot, '.ai', 'harness');
    case 'repo_harness_derived_data': return join(repoRoot, '.repo-harness');
    case 'tmp_derived_data': return join(repoRoot, '.tmp');
    case 'forge_browser_upload': return join(repoRoot, '.forge', 'browser', 'uploads');
    case 'forge_browser_screenshot': return join(repoRoot, '.forge', 'browser', 'screenshots');
  }
}

/**
 * Reclaim only rebuildable DerivedData and bounded browser artifacts under
 * Forge-owned namespaces. Browser uploads are temporary staging (24 hours);
 * screenshots remain review evidence for seven days. Result bundles, logs,
 * profiles, downloads, edit-session metadata, and all tracked files remain
 * deliberately outside this cleanup surface.
 */
export function cleanupGeneratedRepositoryCaches(
  repoRoot: string,
  options: GeneratedCacheRetentionOptions = {},
): GeneratedCacheRetentionReport {
  const nowMs = options.nowMs ?? Date.now();
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
    const ownedRoot = candidateOwnedRoot(repoRoot, candidate);
    const fileCandidate = candidate.kind === 'forge_browser_upload' || candidate.kind === 'forge_browser_screenshot';
    try {
      const stat = lstatSync(candidate.path);
      if ((fileCandidate ? !stat.isFile() : !stat.isDirectory()) || stat.isSymbolicLink() || !pathInside(ownedRoot, candidate.path)) {
        increment(report.skippedByReason, 'ownership_unproven');
        report.retainedPaths.push(relative(repoRoot, candidate.path));
        continue;
      }
      if (nowMs - stat.mtimeMs < retentionGraceMs(candidate, options.graceMs)) {
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

function emptyBrowserArtifactClassReport(): BrowserArtifactClassRetentionReport {
  return {
    inspected: 0,
    eligible: 0,
    removedCount: 0,
    removedBytes: 0,
    retainedCount: 0,
    totalBytesBefore: 0,
    totalBytesAfter: 0,
    overCapacity: false,
    blockers: [],
  };
}

function browserArtifactPolicy(kind: BrowserDisposableArtifactKind): { graceMs: number; maxCount: number; maxBytes: number } {
  switch (kind) {
    case 'screenshots': return { graceMs: 7 * 24 * 60 * 60_000, maxCount: 500, maxBytes: 512 * 1024 * 1024 };
    case 'downloads': return { graceMs: 7 * 24 * 60 * 60_000, maxCount: 200, maxBytes: 2 * 1024 * 1024 * 1024 };
    case 'diagnostics': return { graceMs: 24 * 60 * 60_000, maxCount: 200, maxBytes: 256 * 1024 * 1024 };
  }
}

/**
 * Bound disposable Browser provider artifacts below the Controller Home repository
 * namespace. Session/profile authority is deliberately excluded: this cleanup is
 * only for screenshots, downloads and diagnostics that can disappear without
 * changing provider-effect or ControllerRound semantics.
 */
export function cleanupControllerHomeBrowserArtifacts(
  controllerHome: string,
  repoId: string,
  options: BrowserArtifactRetentionOptions = {},
): BrowserArtifactRetentionReport {
  const nowMs = options.nowMs ?? Date.now();
  const activeGraceMs = Math.max(60_000, Math.floor(options.activeGraceMs ?? DEFAULT_BROWSER_ARTIFACT_ACTIVE_GRACE_MS));
  let remainingScan = Math.max(1, Math.floor(options.maxEntries ?? DEFAULT_BROWSER_ARTIFACT_SCAN_BUDGET));
  let remainingRemovals = Math.max(0, Math.floor(options.maxRemovals ?? DEFAULT_BROWSER_ARTIFACT_REMOVAL_BUDGET));
  const browserRoot = join(repositoryControllerRoot(controllerHome, repoId), 'browser');
  const report: BrowserArtifactRetentionReport = {
    policyVersion: 'browser-disposable-artifact-retention-v1',
    inspected: 0,
    removedPaths: [],
    removedBytes: 0,
    skippedByReason: {},
    errors: [],
    budgetExhausted: false,
    classes: {
      screenshots: emptyBrowserArtifactClassReport(),
      downloads: emptyBrowserArtifactClassReport(),
      diagnostics: emptyBrowserArtifactClassReport(),
    },
  };

  for (const kind of ['screenshots', 'downloads', 'diagnostics'] as const) {
    const classReport = report.classes[kind];
    const root = join(browserRoot, kind);
    const defaults = browserArtifactPolicy(kind);
    const graceMs = Math.max(activeGraceMs, Math.floor(options.graceMs ?? defaults.graceMs));
    const maxCount = Math.max(1, Math.floor(options.maxCountPerClass ?? defaults.maxCount));
    const maxBytes = Math.max(1, Math.floor(options.maxBytesPerClass ?? defaults.maxBytes));
    if (!existsSync(root) || remainingScan <= 0) continue;

    let entries;
    try { entries = readdirSync(root, { withFileTypes: true }); } catch (error) {
      report.errors.push(`${kind}:scan: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    const candidates: Array<{ path: string; mtimeMs: number; size: number; ageMs: number }> = [];
    for (const entry of entries) {
      if (remainingScan <= 0) {
        report.budgetExhausted = true;
        increment(report.skippedByReason, 'scan_budget_exhausted');
        break;
      }
      remainingScan -= 1;
      report.inspected += 1;
      classReport.inspected += 1;
      const path = join(root, String(entry.name));
      try {
        const stat = lstatSync(path);
        if (!entry.isFile() || !stat.isFile() || stat.isSymbolicLink() || !pathInside(root, path)) {
          increment(report.skippedByReason, 'ownership_unproven');
          classReport.blockers.push(`ownership_unproven:${String(entry.name)}`);
          continue;
        }
        const size = Math.max(0, stat.size);
        candidates.push({ path, mtimeMs: stat.mtimeMs, size, ageMs: Math.max(0, nowMs - stat.mtimeMs) });
        classReport.totalBytesBefore += size;
      } catch (error) {
        report.errors.push(`${kind}:${String(entry.name)}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    candidates.sort((left, right) => left.mtimeMs - right.mtimeMs || left.path.localeCompare(right.path));
    let projectedCount = candidates.length;
    let projectedBytes = classReport.totalBytesBefore;
    for (const candidate of candidates) {
      const ttlExpired = candidate.ageMs >= graceMs;
      const countPressure = projectedCount > maxCount;
      const bytePressure = projectedBytes > maxBytes;
      if (!ttlExpired && !countPressure && !bytePressure) continue;
      if (candidate.ageMs < activeGraceMs) {
        increment(report.skippedByReason, 'active_grace');
        classReport.blockers.push(`active_grace:${basename(candidate.path)}`);
        continue;
      }
      classReport.eligible += 1;
      if (remainingRemovals <= 0) {
        report.budgetExhausted = true;
        increment(report.skippedByReason, 'cleanup_budget_exhausted');
        continue;
      }
      try {
        rmSync(candidate.path, { force: true });
        remainingRemovals -= 1;
        projectedCount -= 1;
        projectedBytes = Math.max(0, projectedBytes - candidate.size);
        classReport.removedCount += 1;
        classReport.removedBytes += candidate.size;
        report.removedBytes += candidate.size;
        report.removedPaths.push(relative(browserRoot, candidate.path).replace(/\\/g, '/'));
      } catch (error) {
        report.errors.push(`${kind}:${basename(candidate.path)}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    classReport.retainedCount = projectedCount;
    classReport.totalBytesAfter = projectedBytes;
    classReport.overCapacity = projectedCount > maxCount || projectedBytes > maxBytes;
    if (classReport.overCapacity) classReport.blockers.push('capacity_remains_above_limit');
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
