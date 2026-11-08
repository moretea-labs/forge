import { execFileSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

export type AutopilotProviderProtocol = 'chat_completions' | 'responses';

export interface AutopilotProviderProfile {
  endpoint: string;
  protocol: AutopilotProviderProtocol;
  model: string;
  source: 'desktop-local-api' | 'default';
}

const KEYCHAIN_SERVICE = 'com.moretea.forge.desktop.api';
const ZRO_ENDPOINT = 'https://zro.moonmath.ai/v1';
const DEFAULT_PROFILE: AutopilotProviderProfile = {
  endpoint: 'https://api.deepseek.com',
  protocol: 'chat_completions',
  model: 'deepseek-chat',
  source: 'default',
};

function profilePath(homeDir: string): string {
  return join(homeDir, 'Library', 'Application Support', 'com.moretea.forge.desktop', 'local-api.json');
}

function validatedEndpoint(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) return undefined;
    return url.toString().replace(/\/$/, '');
  } catch {
    return undefined;
  }
}

export function readAutopilotProviderProfile(homeDir = homedir()): AutopilotProviderProfile {
  const path = profilePath(homeDir);
  if (!existsSync(path)) return { ...DEFAULT_PROFILE };
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    const endpoint = validatedEndpoint(parsed.endpoint);
    const model = typeof parsed.model === 'string' ? parsed.model.trim() : '';
    const protocol = parsed.apiProtocol === 'responses'
      ? 'responses'
      : parsed.apiProtocol === 'openai'
        ? 'chat_completions'
        : undefined;
    if (!endpoint || !model || model.length > 120 || !protocol) return { ...DEFAULT_PROFILE };
    return { endpoint, protocol, model, source: 'desktop-local-api' };
  } catch {
    return { ...DEFAULT_PROFILE };
  }
}

function readZroApiKey(homeDir: string): string | undefined {
  const path = join(homeDir, '.config', 'zro', 'credentials.json');
  if (!existsSync(path)) return undefined;
  try {
    const text = readFileSync(path, 'utf8');
    if (text.length > 64 * 1024) return undefined;
    const parsed = JSON.parse(text) as Record<string, unknown>;
    const key = typeof parsed.apiKey === 'string' ? parsed.apiKey.trim() : '';
    return key && key.length <= 4096 ? key : undefined;
  } catch {
    return undefined;
  }
}

export function readAutopilotProviderApiKey(
  endpoint: string,
  env: NodeJS.ProcessEnv = process.env,
  homeDir = homedir(),
): string | undefined {
  if (endpoint === ZRO_ENDPOINT) {
    const zroKey = readZroApiKey(homeDir);
    if (zroKey) return zroKey;
  }
  if (process.platform === 'darwin') {
    try {
      const value = execFileSync('/usr/bin/security', [
        'find-generic-password',
        '-s', KEYCHAIN_SERVICE,
        '-a', endpoint,
        '-w',
      ], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 2_000,
      }).trim();
      if (value) return value;
    } catch {
      // Keychain is preferred; environment support remains for non-Desktop Runtime installs.
    }
  }
  return env.FORGE_DEEPSEEK_API_KEY?.trim()
    || env.DEEPSEEK_API_KEY?.trim()
    || undefined;
}

export function autopilotProviderReadiness(): {
  profile: AutopilotProviderProfile;
  ready: boolean;
  credentialSource: 'zro-local-config' | 'macos-keychain-or-env' | 'missing';
} {
  const profile = readAutopilotProviderProfile();
  const ready = Boolean(readAutopilotProviderApiKey(profile.endpoint));
  const credentialSource = ready
    ? profile.endpoint === ZRO_ENDPOINT ? 'zro-local-config' : 'macos-keychain-or-env'
    : 'missing';
  return { profile, ready, credentialSource };
}
