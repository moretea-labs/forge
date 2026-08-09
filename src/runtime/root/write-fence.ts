import { resolve } from 'path';
import { resolveControllerHome } from '../../cli/repositories/controller-home';
import { isProcessAlive } from '../shared/process-tree';
import { readRuntimeOwner, type RuntimeOwnerRecord } from './ownership';
import {
  readRuntimeReleaseAuthority,
  type RuntimeReleaseAuthority,
} from './release-store';

export const RUNTIME_WRITE_ACTIONS = [
  'consume_queue',
  'renew_lease',
  'release_lease',
  'write_process_terminal',
  'write_workflow_terminal',
  'write_operation_receipt',
  'remote_side_effect',
  'cleanup',
  'update_active_projection',
  'scheduler_write',
  'integrate_worktree',
  'release_mutation',
  'bootstrap_mutation',
  'cancel_process',
] as const;

export type RuntimeWriteAction = (typeof RUNTIME_WRITE_ACTIONS)[number];

export interface RuntimeWriteClaim {
  controllerHome: string;
  runtimeInstanceId: string;
  ownerPid: number;
  releaseAuthorityRevision: number;
  releaseFencingToken: string;
  releaseId: string;
  artifactIdentity: string;
  workerProtocolVersion: number;
  capturedAt: string;
  /** Development/test-only claim accepted only while no Runtime authority exists. */
  unmanaged?: boolean;
}

export interface RuntimeWriteFenceCheck {
  allowed: boolean;
  reason?: string;
  owner?: RuntimeOwnerRecord;
  authority?: RuntimeReleaseAuthority;
}

export const RUNTIME_WRITE_CLAIM_ENV = {
  controllerHome: 'FORGE_CONTROLLER_HOME',
  runtimeInstanceId: 'FORGE_RUNTIME_INSTANCE_ID',
  ownerPid: 'FORGE_RUNTIME_OWNER_PID',
  releaseAuthorityRevision: 'FORGE_RELEASE_AUTHORITY_REVISION',
  releaseFencingToken: 'FORGE_RELEASE_FENCING_TOKEN',
  releaseId: 'FORGE_RELEASE_ID',
  artifactIdentity: 'FORGE_ARTIFACT_IDENTITY',
  workerProtocolVersion: 'FORGE_WORKER_PROTOCOL_VERSION',
} as const;

let processClaim: RuntimeWriteClaim | undefined;
let previousClaimEnvironment: Partial<Record<(typeof RUNTIME_WRITE_CLAIM_ENV)[keyof typeof RUNTIME_WRITE_CLAIM_ENV], string | undefined>> | undefined;

function positiveInteger(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function claimFromAuthority(
  controllerHome: string,
  owner: RuntimeOwnerRecord,
  authority: RuntimeReleaseAuthority,
): RuntimeWriteClaim {
  return {
    controllerHome: resolveControllerHome(controllerHome),
    runtimeInstanceId: owner.runtimeInstanceId,
    ownerPid: owner.pid,
    releaseAuthorityRevision: authority.revision,
    releaseFencingToken: authority.fencingToken,
    releaseId: authority.active.releaseId,
    artifactIdentity: authority.active.artifactIdentity,
    workerProtocolVersion: authority.active.workerProtocolVersion,
    capturedAt: new Date().toISOString(),
  };
}

export function runtimeWriteClaimEnvironment(claim: RuntimeWriteClaim): Record<string, string> {
  if (claim.unmanaged) return {};
  return {
    [RUNTIME_WRITE_CLAIM_ENV.controllerHome]: claim.controllerHome,
    [RUNTIME_WRITE_CLAIM_ENV.runtimeInstanceId]: claim.runtimeInstanceId,
    [RUNTIME_WRITE_CLAIM_ENV.ownerPid]: String(claim.ownerPid),
    [RUNTIME_WRITE_CLAIM_ENV.releaseAuthorityRevision]: String(claim.releaseAuthorityRevision),
    [RUNTIME_WRITE_CLAIM_ENV.releaseFencingToken]: claim.releaseFencingToken,
    [RUNTIME_WRITE_CLAIM_ENV.releaseId]: claim.releaseId,
    [RUNTIME_WRITE_CLAIM_ENV.artifactIdentity]: claim.artifactIdentity,
    [RUNTIME_WRITE_CLAIM_ENV.workerProtocolVersion]: String(claim.workerProtocolVersion),
  };
}

function installClaim(claim: RuntimeWriteClaim): RuntimeWriteClaim {
  if (!previousClaimEnvironment) {
    previousClaimEnvironment = Object.fromEntries(
      Object.values(RUNTIME_WRITE_CLAIM_ENV).map((key) => [key, process.env[key]]),
    );
  }
  processClaim = claim;
  for (const [key, value] of Object.entries(runtimeWriteClaimEnvironment(claim))) process.env[key] = value;
  return claim;
}

export function getRuntimeWriteClaim(): RuntimeWriteClaim | undefined {
  return processClaim;
}

export function clearRuntimeWriteClaim(expectedRuntimeInstanceId?: string): void {
  if (expectedRuntimeInstanceId && processClaim?.runtimeInstanceId !== expectedRuntimeInstanceId) return;
  processClaim = undefined;
  for (const key of Object.values(RUNTIME_WRITE_CLAIM_ENV)) {
    const previous = previousClaimEnvironment?.[key];
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  }
  previousClaimEnvironment = undefined;
}

export const clearRuntimeWriteClaimForTests = clearRuntimeWriteClaim;

export function bindRuntimeWriteClaim(input: {
  controllerHome: string;
  runtimeInstanceId?: string;
  ownerPid?: number;
  releaseAuthorityRevision?: number;
  releaseFencingToken?: string;
  releaseId?: string;
  artifactIdentity?: string;
  workerProtocolVersion?: number;
  owner?: RuntimeOwnerRecord;
  authority?: RuntimeReleaseAuthority;
  adoptCurrentRuntime?: boolean;
  allowUnmanagedMissing?: boolean;
}): RuntimeWriteClaim {
  const home = resolveControllerHome(input.controllerHome);
  if (input.owner && input.authority) return installClaim(claimFromAuthority(home, input.owner, input.authority));

  const explicit = {
    runtimeInstanceId: input.runtimeInstanceId?.trim(),
    ownerPid: input.ownerPid,
    releaseAuthorityRevision: input.releaseAuthorityRevision,
    releaseFencingToken: input.releaseFencingToken?.trim(),
    releaseId: input.releaseId?.trim(),
    artifactIdentity: input.artifactIdentity?.trim(),
    workerProtocolVersion: input.workerProtocolVersion,
  };
  const explicitValues = Object.values(explicit);
  const hasAnyExplicit = explicitValues.some((value) => value !== undefined && value !== '');
  const hasFullExplicit = Boolean(
    explicit.runtimeInstanceId
    && Number.isInteger(explicit.ownerPid) && explicit.ownerPid! > 0
    && Number.isInteger(explicit.releaseAuthorityRevision) && explicit.releaseAuthorityRevision! > 0
    && explicit.releaseFencingToken
    && explicit.releaseId
    && explicit.artifactIdentity
    && Number.isInteger(explicit.workerProtocolVersion) && explicit.workerProtocolVersion! > 0,
  );
  if (hasAnyExplicit) {
    if (!hasFullExplicit) throw new Error('RUNTIME_WRITE_CLAIM_BIND_FAILED: inherited claim is incomplete');
    return installClaim({
      controllerHome: home,
      runtimeInstanceId: explicit.runtimeInstanceId!,
      ownerPid: explicit.ownerPid!,
      releaseAuthorityRevision: explicit.releaseAuthorityRevision!,
      releaseFencingToken: explicit.releaseFencingToken!,
      releaseId: explicit.releaseId!,
      artifactIdentity: explicit.artifactIdentity!,
      workerProtocolVersion: explicit.workerProtocolVersion!,
      capturedAt: new Date().toISOString(),
    });
  }

  const owner = readRuntimeOwner(home);
  const authority = readRuntimeReleaseAuthority(home);
  if (input.adoptCurrentRuntime) {
    if (!owner || !authority) throw new Error('RUNTIME_WRITE_CLAIM_BIND_FAILED: Runtime owner or release authority is missing');
    if (owner.pid !== process.pid) throw new Error('RUNTIME_WRITE_CLAIM_BIND_FAILED: current process is not the Runtime owner');
    return installClaim(claimFromAuthority(home, owner, authority));
  }
  if (input.allowUnmanagedMissing && !owner && !authority) {
    return installClaim({
      controllerHome: home,
      runtimeInstanceId: `unmanaged-${process.pid}`,
      ownerPid: process.pid,
      releaseAuthorityRevision: 0,
      releaseFencingToken: 'unmanaged',
      releaseId: 'unmanaged',
      artifactIdentity: 'unmanaged',
      workerProtocolVersion: 1,
      capturedAt: new Date().toISOString(),
      unmanaged: true,
    });
  }
  throw new Error('RUNTIME_WRITE_CLAIM_BIND_FAILED: explicit inherited claim or active Runtime ownership is required');
}

export function bindInheritedRuntimeWriteClaimFromEnvironment(
  env: NodeJS.ProcessEnv = process.env,
  controllerHomeOverride?: string,
): RuntimeWriteClaim | undefined {
  const runtimeInstanceId = env[RUNTIME_WRITE_CLAIM_ENV.runtimeInstanceId]?.trim();
  const hasCanonicalClaim = Object.values(RUNTIME_WRITE_CLAIM_ENV)
    .filter((key) => key !== RUNTIME_WRITE_CLAIM_ENV.controllerHome)
    .some((key) => Boolean(env[key]?.trim()));
  if (!hasCanonicalClaim) {
    if (!controllerHomeOverride) return undefined;
    return bindRuntimeWriteClaim({ controllerHome: controllerHomeOverride, allowUnmanagedMissing: true });
  }
  const controllerHome = controllerHomeOverride ?? env[RUNTIME_WRITE_CLAIM_ENV.controllerHome]?.trim();
  if (!controllerHome) throw new Error('RUNTIME_WRITE_CLAIM_BIND_FAILED: inherited controller home is missing');
  return bindRuntimeWriteClaim({
    controllerHome,
    runtimeInstanceId,
    ownerPid: positiveInteger(env[RUNTIME_WRITE_CLAIM_ENV.ownerPid]),
    releaseAuthorityRevision: positiveInteger(env[RUNTIME_WRITE_CLAIM_ENV.releaseAuthorityRevision]),
    releaseFencingToken: env[RUNTIME_WRITE_CLAIM_ENV.releaseFencingToken]?.trim(),
    releaseId: env[RUNTIME_WRITE_CLAIM_ENV.releaseId]?.trim(),
    artifactIdentity: env[RUNTIME_WRITE_CLAIM_ENV.artifactIdentity]?.trim(),
    workerProtocolVersion: positiveInteger(env[RUNTIME_WRITE_CLAIM_ENV.workerProtocolVersion]),
  });
}

export function assertRuntimeMayWrite(
  _action?: RuntimeWriteAction,
  controllerHomeOverride?: string,
): RuntimeWriteFenceCheck {
  let claim = processClaim;
  const explicitHome = controllerHomeOverride
    ? resolveControllerHome(controllerHomeOverride)
    : undefined;
  // An explicitly selected Controller Home with no Runtime owner and no release
  // authority is isolated by definition: there is no canonical writer to fence.
  // Check this before parsing inherited claim environment, because long-lived
  // parent processes can legitimately pass a stale claim for a different home
  // into short-lived test/sandbox children.
  if (!claim && explicitHome) {
    const explicitOwner = readRuntimeOwner(explicitHome);
    const explicitAuthority = readRuntimeReleaseAuthority(explicitHome);
    if (!explicitOwner && !explicitAuthority) {
      return { allowed: true, reason: 'unbound_no_runtime_authority' };
    }
  }
  if (!claim) {
    try { claim = bindInheritedRuntimeWriteClaimFromEnvironment(); }
    catch { return { allowed: false, reason: 'inherited_runtime_write_claim_invalid' }; }
  }
  const home = explicitHome ?? claim?.controllerHome;
  if (!home) return { allowed: true, reason: 'unbound_no_controller_home' };
  const owner = readRuntimeOwner(home);
  const authority = readRuntimeReleaseAuthority(home);
  if (!claim) {
    if (!owner && !authority) return { allowed: true, reason: 'unbound_no_runtime_authority' };
    return { allowed: false, reason: 'runtime_write_claim_unbound_while_authority_present', owner, authority };
  }
  if (resolve(claim.controllerHome) !== resolve(home)) {
    // A canonical Runtime child may intentionally create/use an isolated
    // Controller Home for tests or bounded local tooling. If that target has no
    // owner and no release authority, there is no competing writer to fence.
    // The moment an authority exists there, exact Controller Home identity is
    // required again and the inherited claim remains fenced.
    if (!owner && !authority) return { allowed: true, reason: 'isolated_controller_home_without_runtime_authority' };
    return { allowed: false, reason: 'controller_home_mismatch', owner, authority };
  }
  if (claim.unmanaged) {
    if (!owner && !authority) return { allowed: true, reason: 'unmanaged_no_runtime_authority' };
    return { allowed: false, reason: 'runtime_authority_appeared_after_unmanaged_bind', owner, authority };
  }
  if (!owner) return { allowed: false, reason: 'runtime_owner_missing', authority };
  if (!isProcessAlive(owner.pid)) return { allowed: false, reason: 'runtime_owner_dead', owner, authority };
  if (owner.runtimeInstanceId !== claim.runtimeInstanceId) {
    return { allowed: false, reason: 'runtime_instance_fenced', owner, authority };
  }
  if (owner.pid !== claim.ownerPid) return { allowed: false, reason: 'runtime_owner_pid_fenced', owner, authority };
  if (!authority) return { allowed: false, reason: 'runtime_release_authority_missing', owner };
  if (authority.revision !== claim.releaseAuthorityRevision) {
    return { allowed: false, reason: 'release_authority_revision_fenced', owner, authority };
  }
  if (authority.fencingToken !== claim.releaseFencingToken) {
    return { allowed: false, reason: 'release_fencing_token_mismatch', owner, authority };
  }
  if (authority.active.releaseId !== claim.releaseId) {
    return { allowed: false, reason: 'release_id_fenced', owner, authority };
  }
  if (authority.active.artifactIdentity !== claim.artifactIdentity) {
    return { allowed: false, reason: 'artifact_identity_fenced', owner, authority };
  }
  if (authority.active.workerProtocolVersion !== claim.workerProtocolVersion) {
    return { allowed: false, reason: 'worker_protocol_fenced', owner, authority };
  }
  return { allowed: true, owner, authority };
}

export function assertRuntimeMayWriteOrThrow(
  action: RuntimeWriteAction,
  controllerHomeOverride?: string,
): RuntimeReleaseAuthority | undefined {
  const check = assertRuntimeMayWrite(action, controllerHomeOverride);
  if (!check.allowed) throw new Error(`WRITER_FENCED:${action}:${check.reason ?? 'denied'}`);
  return check.authority;
}
