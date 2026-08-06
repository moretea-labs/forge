/**
 * Temporary source-compatibility facade.
 *
 * Write authority is owned by the Canonical Runtime owner and whole-release
 * authority. Blue/green slot, generation and writer-authority files are not
 * consulted. Callers should migrate imports to runtime/root/write-fence.
 */
import {
  assertRuntimeMayWrite,
  assertRuntimeMayWriteOrThrow,
  bindInheritedRuntimeWriteClaimFromEnvironment,
  bindRuntimeWriteClaim,
  clearRuntimeWriteClaimForTests,
  getRuntimeWriteClaim,
  type RuntimeWriteAction,
  type RuntimeWriteClaim,
  type RuntimeWriteFenceCheck,
} from '../../../runtime/root/write-fence';
import type { RuntimeReleaseAuthority } from '../../../runtime/root/release-store';

export type PassiveForbiddenAction = RuntimeWriteAction;
export type RuntimeWriterClaim = RuntimeWriteClaim;
export type WriterFenceCheck = RuntimeWriteFenceCheck;
export type WriterAuthority = RuntimeReleaseAuthority;

export const getRuntimeWriterClaim = getRuntimeWriteClaim;
export { clearRuntimeWriteClaimForTests };

export function bindInheritedRuntimeWriterClaimFromEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): RuntimeWriterClaim | undefined {
  return bindInheritedRuntimeWriteClaimFromEnvironment(env);
}

export function bindRuntimeWriterClaim(input: {
  controllerHome: string;
  runtimeInstanceId?: string;
  ownerPid?: number;
  releaseAuthorityRevision?: number;
  releaseFencingToken?: string;
  releaseId?: string;
  artifactIdentity?: string;
  workerProtocolVersion?: number;
  instanceId?: string;
  adoptCurrentRuntime?: boolean;
  adoptCurrentAuthority?: boolean;
  allowUnmanagedMissing?: boolean;
  allowLegacyMissing?: boolean;
  slot?: 'blue' | 'green';
  generation?: string;
  epoch?: string;
  fencingToken?: string;
}): RuntimeWriterClaim {
  if (input.slot || input.generation || input.epoch || input.fencingToken) {
    const ownerPresent = Boolean(input.runtimeInstanceId ?? input.instanceId);
    if (!ownerPresent && !input.allowLegacyMissing && !input.allowUnmanagedMissing) {
      throw new Error('LEGACY_WRITER_CLAIM_RETIRED: slot/generation/epoch claims are no longer authoritative');
    }
  }
  return bindRuntimeWriteClaim({
    controllerHome: input.controllerHome,
    runtimeInstanceId: input.runtimeInstanceId ?? input.instanceId,
    ownerPid: input.ownerPid,
    releaseAuthorityRevision: input.releaseAuthorityRevision,
    releaseFencingToken: input.releaseFencingToken,
    releaseId: input.releaseId,
    artifactIdentity: input.artifactIdentity,
    workerProtocolVersion: input.workerProtocolVersion,
    adoptCurrentRuntime: input.adoptCurrentRuntime ?? input.adoptCurrentAuthority,
    allowUnmanagedMissing: input.allowUnmanagedMissing ?? input.allowLegacyMissing,
  });
}

export const requireRuntimeWriterClaim = (): RuntimeWriterClaim => {
  const claim = getRuntimeWriteClaim();
  if (!claim) throw new Error('WRITER_CLAIM_UNBOUND: bind the Canonical Runtime write claim at startup');
  return claim;
};

export const assertThisRuntimeMayWrite = assertRuntimeMayWrite;
export const assertThisRuntimeMayWriteOrThrow = assertRuntimeMayWriteOrThrow;
