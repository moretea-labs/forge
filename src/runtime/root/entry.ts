import { readFileSync } from 'fs';
import { resolve } from 'path';
import { pathToFileURL } from 'url';
import { Command } from 'commander';
import { CanonicalForgeRuntime } from './runtime';

interface CliOptions {
  controllerHome: string;
  repo: string;
  releaseManifest: string;
  host: string;
  port: string;
  authTokenFile: string;
  exclusiveWorkId?: string;
}

function readAuthToken(path: string): string {
  const token = readFileSync(resolve(path), 'utf8').trim();
  if (!token) throw new Error('RUNTIME_CONFIG_REQUIRED: auth token file is empty');
  return token;
}

export async function runCanonicalRuntimeCli(argv = process.argv): Promise<void> {
  const command = new Command('forge-runtime')
    .description('Run the canonical single Forge Runtime root process')
    .requiredOption('--controller-home <path>', 'Explicit Controller Home')
    .requiredOption('--repo <path>', 'Explicit repository root')
    .requiredOption('--release-manifest <path>', 'Complete immutable release manifest')
    .requiredOption('--host <host>', 'MCP listener host')
    .requiredOption('--port <port>', 'MCP listener port')
    .requiredOption('--auth-token-file <path>', 'Bearer token file')
    .option('--exclusive-work-id <id>', 'Persistently admit only this P0 Work while migration is active');
  command.parse(argv);
  const options = command.opts<CliOptions>();
  const port = Number(options.port);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error('RUNTIME_CONFIG_INVALID: port');
  const runtime = new CanonicalForgeRuntime({
    controllerHome: resolve(options.controllerHome),
    repositoryRoot: resolve(options.repo),
    releaseManifestPath: resolve(options.releaseManifest),
    host: options.host,
    port,
    authToken: readAuthToken(options.authTokenFile),
    exclusiveWorkId: options.exclusiveWorkId,
  });
  await runtime.start();
  process.stderr.write(`${JSON.stringify({
    event: 'forge_runtime_started',
    forgeInstanceId: runtime.forgeInstanceId,
    runtimeInstanceId: runtime.runtimeInstanceId,
    endpoint: runtime.endpoint(),
    readiness: runtime.readiness(),
  })}\n`);

  const stopForSignal = (signal: NodeJS.Signals): void => {
    void runtime.stop(`SIGNAL_${signal}`);
  };
  process.once('SIGINT', stopForSignal);
  process.once('SIGTERM', stopForSignal);
  await runtime.waitForStopped();
  process.off('SIGINT', stopForSignal);
  process.off('SIGTERM', stopForSignal);
  if (runtime.lastExit && !runtime.lastExit.reasonCode.startsWith('SIGNAL_')) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runCanonicalRuntimeCli().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
