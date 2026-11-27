import { existsSync, readFileSync } from 'fs';
import { isAbsolute, join, normalize, sep } from 'path';

export const IOS_WORKFLOW_CONFIG_RELATIVE_PATH = '.forge/ios-workflow.json';

export type IosWorkflowTarget = 'simulator' | 'physical_device';
export type IosWorkflowCleanupPolicy = 'keep' | 'shutdown_on_success' | 'shutdown_always';

export interface IosWorkflowConfig {
  schemaVersion: 1;
  project?: { workspace?: string; project?: string; scheme?: string; configuration?: string; bundleId?: string };
  preview?: {
    target?: IosWorkflowTarget;
    simulator?: { udid?: string; name?: string };
    physicalDevice?: { udid?: string; selector?: string };
    cleanupPolicy?: IosWorkflowCleanupPolicy;
    launchWaitMs?: number;
    screenshotLabel?: string;
  };
  tests?: {
    scheme?: string;
    configuration?: string;
    simulator?: { udid?: string; name?: string };
    onlyTesting?: string[];
    parallelTesting?: boolean;
    maxParallelTestingWorkers?: number;
  };
}

export type IosWorkflowConfigResult =
  | { ready: true; configured: boolean; path: string; config: IosWorkflowConfig }
  | { ready: false; configured: true; path: string; error: { code: 'IOS_WORKFLOW_CONFIG_INVALID'; message: string } };

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function assertAllowedKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) throw new Error(label + ' contains unsupported field(s): ' + unknown.join(', '));
}

function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || !value.trim()) throw new Error(label + ' must be a non-empty string');
  return value.trim();
}

function optionalRelativePath(value: unknown, label: string): string | undefined {
  const candidate = optionalString(value, label);
  if (!candidate) return undefined;
  const normalized = normalize(candidate);
  if (isAbsolute(candidate) || normalized === '..' || normalized.startsWith('..' + sep)) {
    throw new Error(label + ' must stay inside the repository and be relative');
  }
  return candidate;
}

function optionalObject(value: unknown, label: string): Record<string, unknown> | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) throw new Error(label + ' must be an object');
  return value;
}

function parseSimulator(value: unknown, label: string): { udid?: string; name?: string } | undefined {
  const raw = optionalObject(value, label);
  if (!raw) return undefined;
  assertAllowedKeys(raw, ['udid', 'name'], label);
  return {
    udid: optionalString(raw.udid, label + '.udid'),
    name: optionalString(raw.name, label + '.name'),
  };
}

function parseConfig(value: unknown): IosWorkflowConfig {
  if (!isRecord(value)) throw new Error('root must be a JSON object');
  assertAllowedKeys(value, ['schemaVersion', 'project', 'preview', 'tests'], 'root');
  if (value.schemaVersion !== 1) throw new Error('schemaVersion must be 1');

  const projectRaw = optionalObject(value.project, 'project');
  if (projectRaw)
    assertAllowedKeys(projectRaw, ['workspace', 'project', 'scheme', 'configuration', 'bundleId'], 'project');
  const project = projectRaw
    ? {
        workspace: optionalRelativePath(projectRaw.workspace, 'project.workspace'),
        project: optionalRelativePath(projectRaw.project, 'project.project'),
        scheme: optionalString(projectRaw.scheme, 'project.scheme'),
        configuration: optionalString(projectRaw.configuration, 'project.configuration'),
        bundleId: optionalString(projectRaw.bundleId, 'project.bundleId'),
      }
    : undefined;

  const previewRaw = optionalObject(value.preview, 'preview');
  if (previewRaw)
    assertAllowedKeys(
      previewRaw,
      ['target', 'simulator', 'physicalDevice', 'cleanupPolicy', 'launchWaitMs', 'screenshotLabel'],
      'preview',
    );
  const target = previewRaw?.target;
  if (target !== undefined && target !== 'simulator' && target !== 'physical_device') {
    throw new Error('preview.target must be simulator or physical_device');
  }
  const cleanupPolicy = previewRaw?.cleanupPolicy;
  if (
    cleanupPolicy !== undefined &&
    cleanupPolicy !== 'keep' &&
    cleanupPolicy !== 'shutdown_on_success' &&
    cleanupPolicy !== 'shutdown_always'
  ) {
    throw new Error('preview.cleanupPolicy must be keep, shutdown_on_success, or shutdown_always');
  }
  const launchWaitMs = previewRaw?.launchWaitMs;
  if (
    launchWaitMs !== undefined &&
    (typeof launchWaitMs !== 'number' || !Number.isInteger(launchWaitMs) || launchWaitMs < 0 || launchWaitMs > 30_000)
  ) {
    throw new Error('preview.launchWaitMs must be an integer between 0 and 30000');
  }
  const physicalRaw = optionalObject(previewRaw?.physicalDevice, 'preview.physicalDevice');
  if (physicalRaw) assertAllowedKeys(physicalRaw, ['udid', 'selector'], 'preview.physicalDevice');
  if (target === 'physical_device' && !physicalRaw?.udid) {
    throw new Error('preview.physicalDevice.udid is required for an iOS device build destination');
  }
  const preview = previewRaw
    ? {
        target: (target as IosWorkflowTarget | undefined) ?? 'simulator',
        simulator: parseSimulator(previewRaw.simulator, 'preview.simulator'),
        physicalDevice: physicalRaw
          ? {
              udid: optionalString(physicalRaw.udid, 'preview.physicalDevice.udid'),
              selector: optionalString(physicalRaw.selector, 'preview.physicalDevice.selector'),
            }
          : undefined,
        cleanupPolicy: (cleanupPolicy as IosWorkflowCleanupPolicy | undefined) ?? 'keep',
        launchWaitMs: launchWaitMs as number | undefined,
        screenshotLabel: optionalString(previewRaw.screenshotLabel, 'preview.screenshotLabel'),
      }
    : undefined;

  const testsRaw = optionalObject(value.tests, 'tests');
  if (testsRaw)
    assertAllowedKeys(
      testsRaw,
      ['scheme', 'configuration', 'simulator', 'onlyTesting', 'parallelTesting', 'maxParallelTestingWorkers'],
      'tests',
    );
  const onlyTesting = testsRaw?.onlyTesting;
  if (
    onlyTesting !== undefined &&
    (!Array.isArray(onlyTesting) ||
      onlyTesting.length > 50 ||
      onlyTesting.some((entry) => typeof entry !== 'string' || !entry.trim()))
  ) {
    throw new Error('tests.onlyTesting must be an array of at most 50 non-empty strings');
  }
  if (testsRaw?.parallelTesting !== undefined && typeof testsRaw.parallelTesting !== 'boolean') {
    throw new Error('tests.parallelTesting must be a boolean');
  }
  const maxWorkers = testsRaw?.maxParallelTestingWorkers;
  if (
    maxWorkers !== undefined &&
    (typeof maxWorkers !== 'number' || !Number.isInteger(maxWorkers) || maxWorkers < 1 || maxWorkers > 2)
  ) {
    throw new Error('tests.maxParallelTestingWorkers must be 1 or 2');
  }
  const tests = testsRaw
    ? {
        scheme: optionalString(testsRaw.scheme, 'tests.scheme'),
        configuration: optionalString(testsRaw.configuration, 'tests.configuration'),
        simulator: parseSimulator(testsRaw.simulator, 'tests.simulator'),
        onlyTesting: (onlyTesting as string[] | undefined)?.map((entry) => entry.trim()),
        parallelTesting: testsRaw.parallelTesting as boolean | undefined,
        maxParallelTestingWorkers: maxWorkers as number | undefined,
      }
    : undefined;

  return { schemaVersion: 1, project, preview, tests };
}

/** Optional repository-owned defaults for Forge's shared iOS workflow. */
export function readIosWorkflowConfig(repoRoot: string): IosWorkflowConfigResult {
  const path = join(repoRoot, IOS_WORKFLOW_CONFIG_RELATIVE_PATH);
  if (!existsSync(path)) return { ready: true, configured: false, path, config: { schemaVersion: 1 } };
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    return { ready: true, configured: true, path, config: parseConfig(parsed) };
  } catch (error) {
    return {
      ready: false,
      configured: true,
      path,
      error: {
        code: 'IOS_WORKFLOW_CONFIG_INVALID',
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}
