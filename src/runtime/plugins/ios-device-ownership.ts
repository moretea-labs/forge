import {
  acquireControllerLock,
  ControllerLockContentionError,
  readControllerLock,
  releaseControllerLock,
  renewControllerLock,
  type ControllerLockRecord,
} from '../../cli/repositories/locks';

const IOS_DEVICE_LOCK_PREFIX = 'ios-device:';
const IOS_DEVICE_LOCK_TTL_MS = 2 * 60 * 60_000;

export interface IosDeviceOwnershipResult {
  acquired: boolean;
  lock?: ControllerLockRecord;
  blocker?: Pick<ControllerLockRecord, 'lockId' | 'owner' | 'pid' | 'acquiredAt' | 'heartbeatAt' | 'expiresAt'>;
}

function deviceResourceKey(deviceIdentifier: string): string {
  const normalized = deviceIdentifier.trim();
  if (!normalized) throw new Error('IOS_DEVICE_IDENTIFIER_REQUIRED');
  return `${IOS_DEVICE_LOCK_PREFIX}${normalized}`;
}

function sessionOwner(repoId: string, interactionId: string): string {
  const repo = repoId.trim();
  const interaction = interactionId.trim();
  if (!repo || !interaction) throw new Error('IOS_DEVICE_OWNERSHIP_ID_REQUIRED');
  return `ios-device-session:${repo}:${interaction}`;
}

function blocker(lock: ControllerLockRecord) {
  return {
    lockId: lock.lockId,
    owner: lock.owner,
    pid: lock.pid,
    acquiredAt: lock.acquiredAt,
    heartbeatAt: lock.heartbeatAt,
    ...(lock.expiresAt ? { expiresAt: lock.expiresAt } : {}),
  } satisfies IosDeviceOwnershipResult['blocker'];
}

export function ensureIosDeviceOwnership(
  controllerHome: string,
  repoId: string,
  interactionId: string,
  deviceIdentifier: string,
): IosDeviceOwnershipResult {
  const key = { scope: 'global' as const, resource: deviceResourceKey(deviceIdentifier) };
  const owner = sessionOwner(repoId, interactionId);
  const current = readControllerLock(controllerHome, key);
  if (current) {
    if (current.owner !== owner) return { acquired: false, blocker: blocker(current) };
    return { acquired: true, lock: renewControllerLock(controllerHome, key, current.lockId, IOS_DEVICE_LOCK_TTL_MS) };
  }
  try {
    return { acquired: true, lock: acquireControllerLock(controllerHome, key, owner, IOS_DEVICE_LOCK_TTL_MS) };
  } catch (error) {
    if (!(error instanceof ControllerLockContentionError)) throw error;
    const raced = readControllerLock(controllerHome, key);
    if (!raced) return { acquired: false };
    if (raced.owner !== owner) return { acquired: false, blocker: blocker(raced) };
    return { acquired: true, lock: renewControllerLock(controllerHome, key, raced.lockId, IOS_DEVICE_LOCK_TTL_MS) };
  }
}

export function releaseIosDeviceOwnership(
  controllerHome: string,
  repoId: string,
  interactionId: string,
  deviceIdentifier: string,
): boolean {
  const key = { scope: 'global' as const, resource: deviceResourceKey(deviceIdentifier) };
  const current = readControllerLock(controllerHome, key);
  if (!current || current.owner !== sessionOwner(repoId, interactionId)) return false;
  releaseControllerLock(controllerHome, key, current.lockId);
  return true;
}

export async function withIosDeviceTransientOwnership<T>(
  controllerHome: string,
  repoId: string,
  requestId: string,
  deviceIdentifier: string,
  operation: () => T | Promise<T>,
): Promise<T> {
  const key = { scope: 'global' as const, resource: deviceResourceKey(deviceIdentifier) };
  const owner = `ios-device-transient:${repoId}:${requestId}`;
  const lock = acquireControllerLock(controllerHome, key, owner, undefined);
  try {
    return await operation();
  } finally {
    releaseControllerLock(controllerHome, key, lock.lockId);
  }
}
