import { spawn } from 'child_process';
import { createHash } from 'crypto';
import { lstatSync, readFileSync } from 'fs';
import { dirname, join, resolve } from 'path';

export const RUNTIME_BUNDLE_ENTRYPOINT = 'forge-runtime-bundle.js' as const;
export const RUNTIME_INTERPRETER_ENTRYPOINT = process.platform === 'win32'
  ? 'forge-runtime-bun.exe' as const
  : 'forge-runtime-bun' as const;

interface RuntimeBundleManifestRecord {
  runtimeBundleEntrypoint?: unknown;
  runtimeBundleArtifactIdentity?: unknown;
  runtimeInterpreterEntrypoint?: unknown;
  runtimeInterpreterArtifactIdentity?: unknown;
}

function releaseManifestPath(argv: readonly string[]): string {
  const index = argv.indexOf('--release-manifest');
  const value = index >= 0 ? argv[index + 1] : undefined;
  if (!value?.trim()) throw new Error('RUNTIME_RELEASE_MANIFEST_ARGUMENT_REQUIRED');
  return resolve(value);
}

export function resolveCompiledRuntimeBundle(argv: readonly string[] = process.argv): {
  manifestPath: string;
  bundlePath: string;
  artifactIdentity: string;
  interpreterPath: string;
  interpreterArtifactIdentity: string;
} {
  const manifestPath = releaseManifestPath(argv);
  let manifest: RuntimeBundleManifestRecord;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as RuntimeBundleManifestRecord;
  } catch (error) {
    throw new Error(`RUNTIME_RELEASE_LOADER_MANIFEST_INVALID: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (manifest.runtimeBundleEntrypoint !== RUNTIME_BUNDLE_ENTRYPOINT) {
    throw new Error(`RUNTIME_RELEASE_BUNDLE_ENTRYPOINT_INVALID: expected ${RUNTIME_BUNDLE_ENTRYPOINT}`);
  }
  const artifactIdentity = typeof manifest.runtimeBundleArtifactIdentity === 'string'
    ? manifest.runtimeBundleArtifactIdentity.trim().toLowerCase()
    : '';
  if (!/^sha256:[a-f0-9]{64}$/.test(artifactIdentity)) {
    throw new Error('RUNTIME_RELEASE_BUNDLE_IDENTITY_INVALID');
  }
  const releaseRoot = dirname(manifestPath);
  const bundlePath = join(releaseRoot, RUNTIME_BUNDLE_ENTRYPOINT);
  let actualIdentity: string;
  try {
    const status = lstatSync(bundlePath);
    if (status.isSymbolicLink() || !status.isFile()) {
      throw new Error('bundle must be a regular file');
    }
    actualIdentity = `sha256:${createHash('sha256').update(readFileSync(bundlePath)).digest('hex')}`;
  } catch (error) {
    throw new Error(`RUNTIME_RELEASE_BUNDLE_READ_FAILED: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (actualIdentity !== artifactIdentity) {
    throw new Error('RUNTIME_RELEASE_BUNDLE_ARTIFACT_IDENTITY_MISMATCH');
  }
  if (manifest.runtimeInterpreterEntrypoint !== RUNTIME_INTERPRETER_ENTRYPOINT) {
    throw new Error(`RUNTIME_RELEASE_INTERPRETER_ENTRYPOINT_INVALID: expected ${RUNTIME_INTERPRETER_ENTRYPOINT}`);
  }
  const interpreterArtifactIdentity = typeof manifest.runtimeInterpreterArtifactIdentity === 'string'
    ? manifest.runtimeInterpreterArtifactIdentity.trim().toLowerCase()
    : '';
  if (!/^sha256:[a-f0-9]{64}$/.test(interpreterArtifactIdentity)) {
    throw new Error('RUNTIME_RELEASE_INTERPRETER_IDENTITY_INVALID');
  }
  const interpreterPath = join(releaseRoot, RUNTIME_INTERPRETER_ENTRYPOINT);
  let actualInterpreterIdentity: string;
  try {
    const status = lstatSync(interpreterPath);
    if (status.isSymbolicLink() || !status.isFile() || (status.mode & 0o111) === 0) {
      throw new Error('interpreter must be a regular executable file');
    }
    actualInterpreterIdentity = `sha256:${createHash('sha256').update(readFileSync(interpreterPath)).digest('hex')}`;
  } catch (error) {
    throw new Error(`RUNTIME_RELEASE_INTERPRETER_READ_FAILED: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (actualInterpreterIdentity !== interpreterArtifactIdentity) {
    throw new Error('RUNTIME_RELEASE_INTERPRETER_ARTIFACT_IDENTITY_MISMATCH');
  }
  return { manifestPath, bundlePath, artifactIdentity, interpreterPath, interpreterArtifactIdentity };
}

function runtimeChildArgs(argv: readonly string[]): string[] {
  const firstRuntimeArgument = argv.findIndex((argument) => argument.startsWith('--'));
  if (firstRuntimeArgument < 0 || !argv.includes('--controller-home')) {
    throw new Error('RUNTIME_CONTROLLER_HOME_ARGUMENT_REQUIRED');
  }
  return argv.slice(firstRuntimeArgument);
}

export async function runCompiledRuntimeLoader(argv: string[] = process.argv): Promise<void> {
  const bundle = resolveCompiledRuntimeBundle(argv);
  const child = spawn(bundle.interpreterPath, [bundle.bundlePath, ...runtimeChildArgs(argv)], {
    cwd: dirname(bundle.manifestPath),
    stdio: 'inherit',
    env: process.env,
  });
  let childExited = false;
  const forwardSignal = (signal: NodeJS.Signals): void => {
    if (childExited) return;
    try { child.kill(signal); } catch { /* child lifecycle reconciliation owns terminal state */ }
  };
  const terminateChildOnLauncherExit = (): void => {
    if (childExited) return;
    try { child.kill('SIGTERM'); } catch { /* launcher is already exiting */ }
  };
  const forwardedSignals: NodeJS.Signals[] = process.platform === 'win32'
    ? ['SIGINT', 'SIGTERM']
    : ['SIGINT', 'SIGTERM', 'SIGUSR1', 'SIGUSR2'];
  const signalHandlers = new Map<NodeJS.Signals, () => void>();
  for (const signal of forwardedSignals) {
    const handler = () => forwardSignal(signal);
    signalHandlers.set(signal, handler);
    process.on(signal, handler);
  }
  process.once('exit', terminateChildOnLauncherExit);
  try {
    const outcome = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveChild, rejectChild) => {
      child.once('error', rejectChild);
      child.once('exit', (code, signal) => {
        childExited = true;
        resolveChild({ code, signal });
      });
    });
    if (outcome.signal) {
      for (const [signal, handler] of signalHandlers) process.off(signal, handler);
      signalHandlers.clear();
      process.off('exit', terminateChildOnLauncherExit);
      process.kill(process.pid, outcome.signal);
      return;
    }
    if (outcome.code !== 0) process.exitCode = outcome.code ?? 1;
  } finally {
    for (const [signal, handler] of signalHandlers) process.off(signal, handler);
    process.off('exit', terminateChildOnLauncherExit);
  }
}

if (import.meta.main) {
  runCompiledRuntimeLoader().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
