import { existsSync } from 'fs';
import { homedir } from 'os';
import { join, win32 as windowsPath } from 'path';
import { discoverExecutable } from './executable-discovery';
import type { NativeBrowserChannel } from '../../cli/chatgpt-browser/types';

export type BrowserProductDiscoverySource = 'explicit' | 'path' | 'fallback';

export interface NativeBrowserProduct {
  channel: NativeBrowserChannel;
  appName: string;
  executable: string;
  source: BrowserProductDiscoverySource;
  defaultUserDataDir?: string;
}

export interface NativeBrowserProductDescriptor {
  appName: string;
  defaultUserDataDir?: string;
}

interface BrowserProductFallback extends NativeBrowserProductDescriptor {
  appName: string;
  pathNames: string[];
  executableFallbacks: string[];
  defaultUserDataDir?: string;
}

function channelSuffix(channel: NativeBrowserChannel): { mac: string; win: string; linux: string; profile: string } {
  if (channel === 'chrome') return { mac: '', win: '', linux: '', profile: 'Chrome' };
  if (channel === 'chrome-beta') return { mac: ' Beta', win: ' Beta', linux: '-beta', profile: 'Chrome Beta' };
  if (channel === 'chrome-dev') return { mac: ' Dev', win: ' Dev', linux: '-unstable', profile: 'Chrome Dev' };
  return { mac: ' Canary', win: ' SxS', linux: '-unstable', profile: 'Chrome Canary' };
}

function fallbackFor(channel: NativeBrowserChannel, platform: NodeJS.Platform, env: NodeJS.ProcessEnv): BrowserProductFallback | undefined {
  const suffix = channelSuffix(channel);
  if (platform === 'darwin') {
    const appName = `Google Chrome${suffix.mac}`;
    return {
      appName,
      pathNames: channel === 'chrome' ? ['google-chrome', 'chrome'] : [`google-chrome${suffix.linux}`],
      executableFallbacks: [`/Applications/${appName}.app/Contents/MacOS/${appName}`],
      defaultUserDataDir: join(env.HOME ?? homedir(), 'Library', 'Application Support', 'Google', suffix.profile),
    };
  }
  if (platform === 'win32') {
    const productRoot = channel === 'chrome-canary' ? 'Chrome SxS' : suffix.profile;
    const relativeExecutable = windowsPath.join('Google', productRoot, 'Application', 'chrome.exe');
    const programRoots = [env.ProgramFiles, env['ProgramFiles(x86)']].map((value) => value?.trim()).filter((value): value is string => Boolean(value));
    const localAppData = env.LOCALAPPDATA?.trim() || windowsPath.join(env.USERPROFILE?.trim() || homedir(), 'AppData', 'Local');
    const profileFolder = channel === 'chrome-canary' ? 'Chrome SxS' : suffix.profile;
    return {
      appName: channel === 'chrome' ? 'Google Chrome' : `Google Chrome${suffix.mac}`,
      pathNames: ['chrome.exe', 'chrome'],
      executableFallbacks: programRoots.map((root) => windowsPath.join(root, relativeExecutable)),
      defaultUserDataDir: windowsPath.join(localAppData, 'Google', profileFolder, 'User Data'),
    };
  }
  if (platform === 'linux') {
    const command = channel === 'chrome' ? 'google-chrome' : `google-chrome${suffix.linux}`;
    const configRoot = env.XDG_CONFIG_HOME?.trim() || join(env.HOME ?? homedir(), '.config');
    return {
      appName: channel === 'chrome' ? 'Google Chrome' : `Google Chrome${suffix.mac}`,
      pathNames: channel === 'chrome' ? ['google-chrome', 'google-chrome-stable'] : [command],
      executableFallbacks: [],
      defaultUserDataDir: join(configRoot, command),
    };
  }
  return undefined;
}


export function describeNativeBrowserProduct(input: {
  channel: NativeBrowserChannel;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
}): NativeBrowserProductDescriptor | undefined {
  const fallback = fallbackFor(input.channel, input.platform ?? process.platform, input.env ?? process.env);
  return fallback ? { appName: fallback.appName, defaultUserDataDir: fallback.defaultUserDataDir } : undefined;
}

export function discoverNativeBrowserProduct(input: {
  channel: NativeBrowserChannel;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  explicitExecutable?: string;
  explicitUserDataDir?: string;
  fileExists?: (path: string) => boolean;
}): NativeBrowserProduct | undefined {
  const platform = input.platform ?? process.platform;
  const env = input.env ?? process.env;
  const fallback = fallbackFor(input.channel, platform, env);
  if (!fallback) return undefined;
  const explicitExecutable = input.explicitExecutable?.trim() || env.FORGE_BROWSER_EXECUTABLE?.trim();
  const explicitUserDataDir = input.explicitUserDataDir?.trim() || env.FORGE_BROWSER_USER_DATA_DIR?.trim();
  const fileExists = input.fileExists ?? existsSync;
  if (explicitExecutable) {
    const resolution = discoverExecutable({ id: `browser:${input.channel}`, candidates: [], platform, env, explicitPath: explicitExecutable, fileExists });
    if (resolution.status !== 'ready' || !resolution.executable) return undefined;
    return { channel: input.channel, appName: fallback.appName, executable: resolution.executable, source: 'explicit', defaultUserDataDir: explicitUserDataDir || fallback.defaultUserDataDir };
  }
  const onPath = discoverExecutable({ id: `browser:${input.channel}`, candidates: fallback.pathNames, platform, env, fileExists });
  if (onPath.status === 'ready' && onPath.executable) {
    return { channel: input.channel, appName: fallback.appName, executable: onPath.executable, source: 'path', defaultUserDataDir: explicitUserDataDir || fallback.defaultUserDataDir };
  }
  const executable = fallback.executableFallbacks.find((candidate) => fileExists(candidate));
  if (!executable) return undefined;
  return { channel: input.channel, appName: fallback.appName, executable, source: 'fallback', defaultUserDataDir: explicitUserDataDir || fallback.defaultUserDataDir };
}
