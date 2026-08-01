import { createHash } from 'crypto';

export const PREFERRED_AGENT_DEVICE_VERSION = '0.20.2';
export const MINIMUM_AGENT_DEVICE_VERSION = '0.19.3';
const REVIEWED_FALLBACK_VERSIONS = new Set(['0.19.3', '0.20.2', '0.20.3']);

export interface AgentDeviceSemanticVersion {
  major: number;
  minor: number;
  patch: number;
  raw: string;
}

export interface AgentDeviceHelpContract {
  root?: string;
  snapshot?: string;
  press?: string;
  fill?: string;
  batch?: string;
  keyboard?: string;
}

export interface AgentDeviceCapabilityProfile {
  version: string;
  versionSupported: boolean;
  source: 'help' | 'known-version' | 'unsupported';
  contractFingerprint: string;
  global: {
    costFlag?: '--cost';
  };
  snapshot: {
    interactiveFlag?: '-i';
    depthFlag?: '--depth';
    scopeFlag?: '--scope';
    rawFlag?: '--raw';
    forceFullFlag?: '--force-full';
  };
  press: {
    supported: boolean;
    settleFlag?: '--settle';
  };
  fill: {
    supported: boolean;
    settleFlag?: '--settle';
    delayFlag?: '--delay-ms';
    verifyFlag?: '--verify';
  };
  batch: {
    supported: boolean;
    stepsFlag?: '--steps';
    onErrorFlag?: '--on-error';
    maxStepsFlag?: '--max-steps';
  };
  keyboard: {
    returnSupported: boolean;
    dismissSupported: boolean;
  };
}

export interface SnapshotCommandOptions {
  interactiveOnly?: boolean;
  raw?: boolean;
  depth?: number;
  scope?: string;
  forceFull?: boolean;
}

export function parseAgentDeviceVersion(value: string | undefined): AgentDeviceSemanticVersion | undefined {
  const raw = value?.trim();
  if (!raw) return undefined;
  const match = raw.match(/^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/);
  if (!match) return undefined;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    raw,
  };
}

function compareVersion(left: AgentDeviceSemanticVersion, right: AgentDeviceSemanticVersion): number {
  return left.major - right.major || left.minor - right.minor || left.patch - right.patch;
}

export function isSupportedAgentDeviceVersion(value: string | undefined): boolean {
  const parsed = parseAgentDeviceVersion(value);
  const minimum = parseAgentDeviceVersion(MINIMUM_AGENT_DEVICE_VERSION)!;
  if (!parsed || compareVersion(parsed, minimum) < 0) return false;
  // The public Node/CLI contracts are still pre-1.0. Treat the next minor as a
  // compatibility boundary until its help/typed contract is reviewed.
  return parsed.major === 0 && parsed.minor <= 20;
}

function includesFlag(help: string | undefined, flag: string): boolean {
  return Boolean(help && new RegExp(`(^|[\\s,|\\[])${flag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=$|[\\s,|\\]<>])`, 'm').test(help));
}

function includesWord(help: string | undefined, word: string): boolean {
  return Boolean(help && new RegExp(`(^|[\\s|\\[])${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=$|[\\s|\\]])`, 'm').test(help));
}

function knownVersionProfile(version: string): Omit<AgentDeviceCapabilityProfile, 'contractFingerprint'> {
  // When command help cannot be parsed, fall back only for versions whose
  // concrete CLI contracts were inspected. A broad semver range is not enough
  // evidence for a pre-1.0 automation provider.
  const supported = REVIEWED_FALLBACK_VERSIONS.has(version);
  if (!supported) {
    return {
      version,
      versionSupported: false,
      source: 'unsupported',
      global: {},
      snapshot: {},
      press: { supported: false },
      fill: { supported: false },
      batch: { supported: false },
      keyboard: { returnSupported: false, dismissSupported: false },
    };
  }
  // Verified against the installed 0.19.3 and 0.20.2 help surfaces. Keep this
  // conservative: only capabilities used by the deterministic provider path.
  return {
    version,
    versionSupported: true,
    source: 'known-version',
    global: { costFlag: '--cost' },
    snapshot: {
      interactiveFlag: '-i',
      depthFlag: '--depth',
      scopeFlag: '--scope',
      rawFlag: '--raw',
      forceFullFlag: '--force-full',
    },
    press: {
      supported: true,
      settleFlag: '--settle',
    },
    fill: {
      supported: true,
      settleFlag: '--settle',
      delayFlag: '--delay-ms',
      verifyFlag: '--verify',
    },
    batch: {
      supported: true,
      stepsFlag: '--steps',
      onErrorFlag: '--on-error',
      maxStepsFlag: '--max-steps',
    },
    keyboard: { returnSupported: true, dismissSupported: true },
  };
}

export function detectAgentDeviceCapabilities(
  version: string,
  help: AgentDeviceHelpContract = {},
): AgentDeviceCapabilityProfile {
  const fallback = knownVersionProfile(version);
  const combinedHelp = Object.values(help).filter(Boolean).join('\n');
  const helpLooksUsable = /agent-device\s+(snapshot|press|fill|batch|keyboard)/.test(combinedHelp);
  const profile: Omit<AgentDeviceCapabilityProfile, 'contractFingerprint'> = !helpLooksUsable
    ? fallback
    : {
      version,
      versionSupported: isSupportedAgentDeviceVersion(version),
      source: isSupportedAgentDeviceVersion(version) ? 'help' : 'unsupported',
      global: {
        ...(includesFlag(help.root, '--cost') ? { costFlag: '--cost' as const } : {}),
      },
      snapshot: {
        ...(includesFlag(help.snapshot, '-i') ? { interactiveFlag: '-i' as const } : {}),
        ...(includesFlag(help.snapshot, '--depth') || includesFlag(help.snapshot, '-d') ? { depthFlag: '--depth' as const } : {}),
        ...(includesFlag(help.snapshot, '--scope') || includesFlag(help.snapshot, '-s') ? { scopeFlag: '--scope' as const } : {}),
        ...(includesFlag(help.snapshot, '--raw') ? { rawFlag: '--raw' as const } : {}),
        ...(includesFlag(help.snapshot, '--force-full') ? { forceFullFlag: '--force-full' as const } : {}),
      },
      press: {
        supported: /agent-device\s+press/.test(help.press ?? ''),
        ...(includesFlag(help.press, '--settle') ? { settleFlag: '--settle' as const } : {}),
      },
      fill: {
        supported: /agent-device\s+fill/.test(help.fill ?? ''),
        ...(includesFlag(help.fill, '--settle') ? { settleFlag: '--settle' as const } : {}),
        ...(includesFlag(help.fill, '--delay-ms') ? { delayFlag: '--delay-ms' as const } : {}),
        ...(includesFlag(help.fill, '--verify') ? { verifyFlag: '--verify' as const } : {}),
      },
      batch: {
        supported: /agent-device\s+batch/.test(help.batch ?? ''),
        ...(includesFlag(help.batch, '--steps') ? { stepsFlag: '--steps' as const } : {}),
        ...(includesFlag(help.batch, '--on-error') ? { onErrorFlag: '--on-error' as const } : {}),
        ...(includesFlag(help.batch, '--max-steps') ? { maxStepsFlag: '--max-steps' as const } : {}),
      },
      keyboard: {
        returnSupported: includesWord(help.keyboard, 'return') || includesWord(help.keyboard, 'enter'),
        dismissSupported: includesWord(help.keyboard, 'dismiss'),
      },
    };

  const fingerprintInput = JSON.stringify({ version, help, profile });
  return {
    ...profile,
    contractFingerprint: createHash('sha256').update(fingerprintInput).digest('hex'),
  };
}

export function compileSnapshotCommand(
  profile: AgentDeviceCapabilityProfile,
  options: SnapshotCommandOptions = {},
): string[] {
  const args = ['snapshot'];
  if (options.interactiveOnly) {
    if (!profile.snapshot.interactiveFlag) throw new Error('agent-device snapshot interactive mode is unsupported by the detected contract.');
    args.push(profile.snapshot.interactiveFlag);
  }
  if (options.raw) {
    if (!profile.snapshot.rawFlag) throw new Error('agent-device raw snapshots are unsupported by the detected contract.');
    args.push(profile.snapshot.rawFlag);
  }
  if (typeof options.depth === 'number') {
    if (!profile.snapshot.depthFlag) throw new Error('agent-device snapshot depth is unsupported by the detected contract.');
    args.push(profile.snapshot.depthFlag, String(Math.max(1, Math.min(20, Math.trunc(options.depth)))));
  }
  if (options.scope) {
    if (!profile.snapshot.scopeFlag) throw new Error('agent-device scoped snapshots are unsupported by the detected contract.');
    args.push(profile.snapshot.scopeFlag, options.scope);
  }
  if (options.forceFull) {
    if (!profile.snapshot.forceFullFlag) throw new Error('agent-device force-full snapshots are unsupported by the detected contract.');
    args.push(profile.snapshot.forceFullFlag);
  }
  return args;
}


export function compileBatchCommand(
  profile: AgentDeviceCapabilityProfile,
  steps: Array<{ command: string; input: Record<string, unknown> }>,
  maxSteps: number,
  options: { includeCost?: boolean } = {},
): string[] {
  if (!profile.batch.supported || !profile.batch.stepsFlag) {
    throw new Error('agent-device native batch execution is unsupported by the detected contract.');
  }
  const args = ['batch', profile.batch.stepsFlag, JSON.stringify(steps)];
  if (profile.batch.onErrorFlag) args.push(profile.batch.onErrorFlag, 'stop');
  if (profile.batch.maxStepsFlag) args.push(profile.batch.maxStepsFlag, String(maxSteps));
  if (options.includeCost && profile.global.costFlag) args.push(profile.global.costFlag);
  return args;
}

export function appendSettleFlag(
  profile: AgentDeviceCapabilityProfile,
  args: string[],
  operation: 'fill' | 'press' = 'fill',
): string[] {
  const flag = operation === 'press' ? profile.press.settleFlag : profile.fill.settleFlag;
  return flag ? [...args, flag] : [...args];
}
