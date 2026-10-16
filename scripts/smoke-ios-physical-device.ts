import { existsSync, readFileSync } from 'fs';
import { createHash } from 'crypto';
import { spawnSync } from 'child_process';
import { computerPluginAdapter } from '../src/runtime/plugins/computer-registration';
import { resolveRepoPreferredControllerHome } from '../src/cli/repositories/controller-home';

const repoRoot = process.cwd();

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 && typeof process.argv[index + 1] === 'string'
    ? process.argv[index + 1]!.trim()
    : undefined;
}

const repoId = option('--repo-id') ?? process.env.FORGE_IOS_DEVICE_SMOKE_REPO_ID?.trim();
const deviceSelector = option('--device') ?? process.env.FORGE_IOS_DEVICE_SMOKE_DEVICE?.trim();
const bundleId = option('--bundle-id') ?? process.env.FORGE_IOS_DEVICE_SMOKE_BUNDLE_ID?.trim();
const controllerHome = resolveRepoPreferredControllerHome(repoRoot, option('--controller-home'));

if (!repoId || !deviceSelector || !bundleId) {
  throw new Error('Pass --repo-id, --device, and --bundle-id, or set the corresponding FORGE_IOS_DEVICE_SMOKE_* environment variables.');
}
if (!/^[A-Za-z0-9][A-Za-z0-9.-]+$/.test(bundleId) || !bundleId.includes('.') || bundleId.includes('://')) {
  throw new Error('FORGE_IOS_DEVICE_SMOKE_BUNDLE_ID must be an exact bundle identifier, not a URL or deep link.');
}


const common = {
  controllerHome,
  repoId,
  repoRoot,
  pluginId: 'computer',
  origin: { surface: 'local-ui' as const, actor: 'physical-ios-live-smoke' },
};

async function invoke(actionId: string, args: Record<string, unknown>) {
  return computerPluginAdapter.executeAction({
    ...common,
    actionId,
    args,
    requestId: `physical-ios-smoke-${actionId}-${Date.now()}`,
  });
}

let interactionId: string | undefined;
let reusedSession = false;
try {
  const listed = await invoke('physical_device_list', {});
  const devices = Array.isArray(listed.devices) ? listed.devices as Array<Record<string, unknown>> : [];
  const matches = devices.filter((entry) =>
    entry.identifier === deviceSelector || entry.udid === deviceSelector || entry.name === deviceSelector);
  if (matches.length !== 1) throw new Error(`Expected exactly one physical iPhone for selector ${deviceSelector}; found ${matches.length}.`);
  const device = matches[0]!;
  if (device.connected !== true || device.screenshotAvailable !== true) {
    throw new Error(`The selected iPhone ${deviceSelector} has no connected CoreDevice screenshot transport. No app inspection or activation was attempted.`);
  }
  const info = await invoke('physical_device_info', { device: device.identifier });
  const apps = await invoke('physical_device_apps', { device: device.identifier, bundle_id: bundleId });
  const installed = Array.isArray(apps.apps) ? apps.apps as Array<Record<string, unknown>> : [];
  if (installed.length !== 1) throw new Error(`The exact bundle identifier ${bundleId} is not installed on the selected iPhone.`);

  const opened = await invoke('physical_device_open', {
    device: device.identifier,
    bundle_id: bundleId,
    relaunch: false,
    observe_after_open: true,
    // This is a one-shot open/capture receipt; do not retain a HID worker.
    prewarm_input: false,
  });
  const interaction = opened.interaction as Record<string, unknown> | undefined;
  interactionId = typeof interaction?.interactionId === 'string' ? interaction.interactionId : undefined;
  if (!interactionId) throw new Error('The physical provider did not return an interaction id.');
  reusedSession = opened.reusedSession === true;

  const screenshot = await invoke('physical_device_screenshot', {
    interaction_id: interactionId,
    label: 'live-smoke',
  });
  const artifacts = Array.isArray(screenshot.artifactCandidates)
    ? screenshot.artifactCandidates as Array<Record<string, unknown>>
    : [];
  const artifact = artifacts[0];
  const path = typeof artifact?.path === 'string' ? artifact.path : '';
  if (!path || !existsSync(path)) throw new Error('The physical provider did not create a screenshot artifact.');
  // Bind the local evidence to this exact CoreDevice observation without
  // claiming what App, SKU or checkout price is actually visible.
  const observation = screenshot.observation as Record<string, unknown> | undefined;
  const image = readFileSync(path);
  const screenshotSha256 = createHash('sha256').update(image).digest('hex');
  const observationId = typeof observation?.observationId === 'string' ? observation.observationId : undefined;
  if (!observationId || artifact?.sha256 !== screenshotSha256 || artifact?.bytes !== image.length
    || observation?.screenshotSha256 !== screenshotSha256 || observation?.screenshotBytes !== image.length) {
    throw new Error('The screenshot file and CoreDevice observation receipts do not match.');
  }
  const metadata = spawnSync('sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', '-g', 'format', path], { encoding: 'utf8' }).stdout;
  const width = metadata.match(/pixelWidth:\s*(\d+)/)?.[1];
  const height = metadata.match(/pixelHeight:\s*(\d+)/)?.[1];
  const format = metadata.match(/format:\s*(\S+)/)?.[1];

  const closed = reusedSession ? undefined : await invoke('physical_device_close', { interaction_id: interactionId });
  interactionId = undefined;
  const app = installed[0]!;
  console.log(JSON.stringify({
    verificationLevel: 'source_computer_adapter_open_and_capture_only',
    device: {
      name: device.name,
      model: device.model,
      osVersion: device.osVersion,
      paired: device.pairingState === 'paired',
      connected: device.connected === true,
      screenshotAvailable: device.screenshotAvailable === true,
    },
    app: {
      installed: true,
      name: app.name,
      bundleVersion: app.bundleVersion,
      version: app.version,
    },
    launchStatus: interaction?.status,
    reusedSession,
    controlPlane: opened.controlPlane,
    coreDeviceCapabilities: info.capabilities,
    screenViewingURLAvailable: typeof info.screenViewingURL === 'string',
    screenshot: {
      created: true,
      path,
      sha256: screenshotSha256,
      bytes: image.length,
      observationId,
      observedAt: observation?.observedAt,
      semanticPriceVerified: false,
      width: width ? Number(width) : undefined,
      height: height ? Number(height) : undefined,
      format,
    },
    closeStatus: (closed?.interaction as Record<string, unknown> | undefined)?.status,
    deviceUnmodified: closed?.deviceUnmodified === true,
  }, null, 2));
} finally {
  if (interactionId && !reusedSession) {
    try { await invoke('physical_device_close', { interaction_id: interactionId }); } catch {}
  }
}
