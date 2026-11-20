import { spawnSync } from 'child_process';
import { existsSync } from 'fs';
import { homedir } from 'os';
import { basename, delimiter, isAbsolute, join } from 'path';

/**
 * Environment boundary for repository-owned child processes.
 *
 * Controller/Supervisor authority, topology, and process identity belong to
 * the hosting runtime and must never be inherited by repository commands,
 * checks, or their children.
 */

const RUNTIME_PRIVATE_ENV_PREFIXES = [
  'FORGE_CONTROLLER_',
  'FORGE_DAEMON_',
  'FORGE_PROCESS_RUNNER',
  'FORGE_RELEASE_',
  'FORGE_RUNTIME_',
  'FORGE_SUPERVISOR_',
  'FORGE_WRITER_',
] as const;

const RUNTIME_PRIVATE_ENV_KEYS = new Set([
  'FORGE_BUILD_VERSION',
  'FORGE_INSTANCE_ID',
  'FORGE_MCP_INSTANCE_ID',
  'FORGE_MCP_PUBLIC_ORIGIN',
  'FORGE_STABLE_SUPERVISOR',
]);

/**
 * Remove the hosting Runtime's private authority before starting a service or
 * child. Callers may then add the exact contract they own. This prevents an
 * ambient writer slot/claim from becoming an accidental second writer.
 */
export function runtimeAuthorityFreeEnvironment(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const sanitized = { ...env };
  for (const key of Object.keys(sanitized)) {
    if (RUNTIME_PRIVATE_ENV_KEYS.has(key) || RUNTIME_PRIVATE_ENV_PREFIXES.some((prefix) => key.startsWith(prefix)))
      delete sanitized[key];
  }
  return sanitized;
}

export type RuntimeOutboundProxyPolicy =
  | { mode: 'direct'; noProxy?: string }
  | { mode: 'macos-system'; noProxy?: string }
  | { mode: 'explicit'; httpProxy?: string; httpsProxy?: string; allProxy?: string; noProxy?: string };

const PROXY_ENVIRONMENT_KEYS = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY'] as const;

function removeProxyEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const next = { ...environment };
  const keys = new Set(PROXY_ENVIRONMENT_KEYS.flatMap((key) => [key, key.toLowerCase()]));
  for (const key of Object.keys(next)) {
    if (keys.has(key.toUpperCase())) delete next[key];
  }
  return next;
}

function normalizedNoProxy(...values: Array<string | undefined>): string {
  const entries = values.flatMap((value) => {
    if (!value) return [];
    if (/\0|\r|\n/.test(value)) throw new Error('FORGE_OUTBOUND_PROXY_NO_PROXY_INVALID');
    return value
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
  });
  entries.push('localhost', '127.0.0.1', '::1');
  const seen = new Set<string>();
  return entries
    .filter((entry) => {
      const key = entry.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .join(',');
}

function validateProxyEndpoint(value: string, errorCode = 'FORGE_OUTBOUND_PROXY_URL_INVALID'): string {
  const candidate = value.trim();
  try {
    const url = new URL(candidate);
    if (
      !['http:', 'https:', 'socks5:', 'socks5h:'].includes(url.protocol) ||
      !url.hostname ||
      url.username ||
      url.password ||
      (url.pathname !== '' && url.pathname !== '/') ||
      url.search ||
      url.hash
    )
      throw new Error(errorCode);
    return candidate.replace(/\/$/, '');
  } catch {
    throw new Error(errorCode);
  }
}

export function normalizeRuntimeOutboundProxyPolicy(
  policy: RuntimeOutboundProxyPolicy | undefined,
): RuntimeOutboundProxyPolicy | undefined {
  if (!policy) return undefined;
  if (policy.mode === 'direct' || policy.mode === 'macos-system') {
    return {
      mode: policy.mode,
      ...(policy.noProxy ? { noProxy: normalizedNoProxy(policy.noProxy) } : {}),
    };
  }
  if (policy.mode !== 'explicit') throw new Error('FORGE_RUNTIME_OUTBOUND_PROXY_POLICY_INVALID');
  const httpProxy = policy.httpProxy ? validateProxyEndpoint(policy.httpProxy) : undefined;
  const httpsProxy = policy.httpsProxy ? validateProxyEndpoint(policy.httpsProxy) : undefined;
  const allProxy = policy.allProxy ? validateProxyEndpoint(policy.allProxy) : undefined;
  if (!httpProxy && !httpsProxy && !allProxy) throw new Error('FORGE_RUNTIME_OUTBOUND_PROXY_ENDPOINT_REQUIRED');
  return {
    mode: 'explicit',
    ...(httpProxy ? { httpProxy } : {}),
    ...(httpsProxy ? { httpsProxy } : {}),
    ...(allProxy ? { allProxy } : {}),
    ...(policy.noProxy ? { noProxy: normalizedNoProxy(policy.noProxy) } : {}),
  };
}

export function allowlistedProxyEnvironment(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const value = (upper: string): string | undefined => {
    const selected = env[upper]?.trim() || env[upper.toLowerCase()]?.trim();
    return selected ? validateProxyEndpoint(selected) : undefined;
  };
  const result: NodeJS.ProcessEnv = {};
  const httpProxy = value('HTTP_PROXY');
  const httpsProxy = value('HTTPS_PROXY');
  const allProxy = value('ALL_PROXY');
  if (httpProxy) result.HTTP_PROXY = httpProxy;
  if (httpsProxy) result.HTTPS_PROXY = httpsProxy;
  if (allProxy) result.ALL_PROXY = allProxy;
  result.NO_PROXY = normalizedNoProxy(env.NO_PROXY, env.no_proxy);
  return result;
}

/** Parse the current macOS System Settings proxy snapshot without trusting inherited proxy URLs. */
export function macSystemProxyEnvironment(snapshot: string, inherited: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const settings = new Map<string, string>();
  for (const line of snapshot.split(/\r?\n/)) {
    const match = /^\s*([A-Za-z][A-Za-z0-9]*)\s*:\s*(.*?)\s*$/.exec(line);
    if (match) settings.set(match[1], match[2]);
  }
  if (settings.size === 0) throw new Error('MACOS_SYSTEM_PROXY_INVALID');
  const endpoint = (prefix: 'HTTPS' | 'HTTP' | 'SOCKS', scheme: string): string | undefined => {
    if (settings.get(`${prefix}Enable`) !== '1') return undefined;
    const host = settings.get(`${prefix}Proxy`)?.trim() ?? '';
    const port = Number(settings.get(`${prefix}Port`));
    if (!/^[A-Za-z0-9.\-:\[\]]+$/.test(host) || !Number.isInteger(port) || port < 1 || port > 65_535) {
      throw new Error('MACOS_SYSTEM_PROXY_INVALID');
    }
    const name = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
    return validateProxyEndpoint(`${scheme}://${name}:${port}`, 'MACOS_SYSTEM_PROXY_INVALID');
  };
  const https = endpoint('HTTPS', 'http');
  const http = endpoint('HTTP', 'http');
  const socks = endpoint('SOCKS', 'socks5');
  if (!https && !http && !socks && settings.get('ProxyAutoConfigEnable') === '1') {
    throw new Error('MACOS_SYSTEM_PROXY_PAC_UNSUPPORTED');
  }
  const next = removeProxyEnvironment(inherited);
  const httpSelected = http ?? https ?? socks;
  const httpsSelected = https ?? http ?? socks;
  if (httpSelected) next.HTTP_PROXY = httpSelected;
  if (httpsSelected) next.HTTPS_PROXY = httpsSelected;
  next.NO_PROXY = normalizedNoProxy(inherited.NO_PROXY, inherited.no_proxy);
  return next;
}

function readMacSystemProxySnapshot(): string {
  const result = spawnSync('/usr/sbin/scutil', ['--proxy'], {
    encoding: 'utf8',
    timeout: 2_500,
    maxBuffer: 64 * 1024,
    windowsHide: true,
  });
  if (result.error || result.status !== 0) throw new Error('FORGE_RUNTIME_OUTBOUND_PROXY_SYSTEM_QUERY_FAILED');
  return result.stdout ?? '';
}

/**
 * Build the hosting Runtime environment from an explicit policy. Missing policy
 * retains the legacy allowlisted inherited proxy behavior; configured policies
 * never silently fall back to direct egress.
 */
export function resolveRuntimeOutboundProxyEnvironment(
  policy: RuntimeOutboundProxyPolicy | undefined,
  inherited: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  systemProxySnapshot?: string,
): NodeJS.ProcessEnv {
  const base = removeProxyEnvironment(runtimeAuthorityFreeEnvironment(inherited));
  if (!policy) return { ...base, ...allowlistedProxyEnvironment(inherited) };
  const normalized = normalizeRuntimeOutboundProxyPolicy(policy)!;
  if (normalized.mode === 'direct') {
    return { ...base, NO_PROXY: normalizedNoProxy(normalized.noProxy) };
  }
  if (normalized.mode === 'macos-system') {
    if (platform !== 'darwin') throw new Error('FORGE_RUNTIME_OUTBOUND_PROXY_PLATFORM_UNSUPPORTED');
    const snapshot = systemProxySnapshot ?? readMacSystemProxySnapshot();
    const resolved = macSystemProxyEnvironment(snapshot, {
      ...base,
      NO_PROXY: normalizedNoProxy(normalized.noProxy, inherited.NO_PROXY, inherited.no_proxy),
    });
    if (!resolved.HTTP_PROXY && !resolved.HTTPS_PROXY) {
      throw new Error('FORGE_RUNTIME_OUTBOUND_PROXY_SYSTEM_NOT_CONFIGURED');
    }
    return resolved;
  }
  const httpProxy = normalized.httpProxy ?? normalized.allProxy ?? normalized.httpsProxy;
  const httpsProxy = normalized.httpsProxy ?? normalized.allProxy ?? normalized.httpProxy;
  return {
    ...base,
    ...(httpProxy ? { HTTP_PROXY: httpProxy } : {}),
    ...(httpsProxy ? { HTTPS_PROXY: httpsProxy } : {}),
    ...(normalized.allProxy ? { ALL_PROXY: normalized.allProxy } : {}),
    NO_PROXY: normalizedNoProxy(normalized.noProxy, inherited.NO_PROXY, inherited.no_proxy),
  };
}

function appendExecutableDirectory(pathEntries: string[], candidate: string | undefined): void {
  if (!candidate || !isAbsolute(candidate) || pathEntries.includes(candidate)) return;
  pathEntries.push(candidate);
}

function validBunExecutable(candidate: string | undefined): string | undefined {
  const value = candidate?.trim();
  if (!value) return undefined;
  const executable = basename(value).toLowerCase();
  if (executable !== 'bun' && executable !== 'bun.exe') return undefined;
  if (isAbsolute(value) && !existsSync(value)) return undefined;
  return value;
}

export function resolveBunExecutable(
  execPath: string = process.execPath,
  env: NodeJS.ProcessEnv = process.env,
  accountHome: string = homedir(),
): string {
  const configured = validBunExecutable(env.FORGE_BUN_EXECUTABLE);
  if (configured) return configured;
  const executable = basename(execPath).toLowerCase();
  if (executable === 'bun' || executable === 'bun.exe') return execPath;

  const binary = process.platform === 'win32' ? 'bun.exe' : 'bun';
  const bunInstall = env.BUN_INSTALL?.trim();
  const home = env.HOME?.trim() || env.USERPROFILE?.trim() || accountHome.trim();
  const candidates = [
    bunInstall ? join(bunInstall, 'bin', binary) : undefined,
    home ? join(home, '.bun', 'bin', binary) : undefined,
    process.platform === 'darwin' ? join('/opt/homebrew/bin', binary) : undefined,
    process.platform !== 'win32' ? join('/usr/local/bin', binary) : undefined,
  ];
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  return binary;
}

export function repositoryChildProcessEnvironment(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  const sanitized = removeProxyEnvironment(runtimeAuthorityFreeEnvironment(env));
  Object.assign(sanitized, allowlistedProxyEnvironment(env));

  if (platform === 'win32') {
    let inheritedPath: string | undefined;
    for (const key of Object.keys(sanitized)) {
      if (key.toLowerCase() !== 'path') continue;
      const candidate = sanitized[key];
      if (candidate?.trim()) inheritedPath = candidate;
      delete sanitized[key];
    }
    if (inheritedPath !== undefined) sanitized.PATH = inheritedPath;
  }

  const pathDelimiter = platform === 'win32' ? ';' : delimiter;
  const pathEntries = (sanitized.PATH ?? '').split(pathDelimiter).filter(Boolean);
  const bunInstall = sanitized.BUN_INSTALL?.trim();
  const home = sanitized.HOME?.trim() || sanitized.USERPROFILE?.trim();
  const voltaHome = sanitized.VOLTA_HOME?.trim();
  const nvmBin = sanitized.NVM_BIN?.trim();
  const pnpmHome = sanitized.PNPM_HOME?.trim();
  appendExecutableDirectory(pathEntries, bunInstall ? join(bunInstall, 'bin') : undefined);
  appendExecutableDirectory(pathEntries, home ? join(home, '.bun', 'bin') : undefined);
  appendExecutableDirectory(pathEntries, nvmBin);
  appendExecutableDirectory(pathEntries, voltaHome ? join(voltaHome, 'bin') : undefined);
  appendExecutableDirectory(pathEntries, pnpmHome);
  appendExecutableDirectory(pathEntries, home ? join(home, '.local', 'bin') : undefined);
  if (platform === 'darwin') appendExecutableDirectory(pathEntries, '/opt/homebrew/bin');
  if (platform !== 'win32') appendExecutableDirectory(pathEntries, '/usr/local/bin');
  sanitized.PATH = pathEntries.join(pathDelimiter);

  return sanitized;
}
