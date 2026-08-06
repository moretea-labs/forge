import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { createMobileIntentDevice } from '../src/cli/local-bridge/mobile-intents';
import { startLocalBridgeServer } from '../src/cli/local-bridge/server';
import { resolveRepoPreferredControllerHome } from '../src/cli/repositories/controller-home';

interface StoredMonitorCredential {
  deviceId: string;
  token: string;
}

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

const scriptRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const repoRoot = resolve(process.env.FORGE_REPO_ROOT?.trim() || scriptRoot);
const controllerHome = resolveRepoPreferredControllerHome(repoRoot);
const runtimeDir = resolve(process.env.FORGE_MONITOR_RUNTIME?.trim()
  || resolve(repoRoot, '.forge/mobile-monitor-runtime'));
const host = process.env.FORGE_MONITOR_HOST?.trim() || '0.0.0.0';
const port = Number(process.env.FORGE_MONITOR_PORT?.trim() || '8766');
const defaultRepoId = process.env.FORGE_MONITOR_REPO_ID?.trim() || '';
const credentialPath = resolve(runtimeDir, 'device.json');

mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });

let credential: StoredMonitorCredential;
if (existsSync(credentialPath)) {
  credential = JSON.parse(readFileSync(credentialPath, 'utf8')) as StoredMonitorCredential;
} else {
  const created = createMobileIntentDevice(repoRoot, {
    name: 'Redmi K50 Monitor',
    deviceId: 'redmi-k50-monitor',
    scopes: ['monitor:read'],
    rateLimitPerMinute: 180,
  });
  credential = { deviceId: created.device.deviceId, token: created.token };
  writeFileSync(credentialPath, `${JSON.stringify(credential)}\n`, { mode: 0o600 });
  chmodSync(credentialPath, 0o600);
}

const handle = await startLocalBridgeServer({
  repoRoot,
  controllerHome,
  defaultRepoId,
  host,
  port,
  openBrowser: false,
  allowLanMobileIntents: true,
  mode: 'standalone',
});

console.log(JSON.stringify({
  ready: true,
  host: handle.host,
  port: handle.port,
  deviceId: credential.deviceId,
  credentialPath,
}));

const shutdown = async () => {
  await handle.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
await new Promise(() => {});
