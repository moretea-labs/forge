import { currentControllerInstanceId, startExecutionSession } from '../../../src/runtime/control-plane/execution/session-store';
import { writeControllerResult } from '../../../src/runtime/evidence/result-store';

const MAX_INLINE_DIRECT_RESULT_BYTES = 64 * 1024;

export interface BoundedRuntimeResultScope {
  controllerHome: string;
  repoId?: string;
  sessionId?: string;
  principalId?: string;
  controllerInstanceId?: string;
  workId?: string;
}

/**
 * Mechanical transport bounding for runtime-aware MCP adapters. Large values
 * are persisted through the existing Result Store; no lifecycle or semantic
 * completion authority is introduced here.
 */
export function boundedRuntimeResult(
  scope: BoundedRuntimeResultScope,
  value: unknown,
): { value: unknown; externalized: boolean } {
  const serialized = JSON.stringify(value, null, 2);
  if (typeof serialized !== 'string' || Buffer.byteLength(serialized, 'utf8') <= MAX_INLINE_DIRECT_RESULT_BYTES) {
    return { value, externalized: false };
  }
  const controllerInstanceId = scope.controllerInstanceId?.trim() || currentControllerInstanceId();
  const principalId = scope.principalId?.trim() || `controller-issued:${controllerInstanceId}`;
  const session = startExecutionSession(scope.controllerHome, {
    sessionId: scope.sessionId?.trim() || undefined,
    principalId,
    controllerInstanceId,
    capabilitySnapshotVersion: 1,
  });
  const stored = writeControllerResult({
    controllerHome: scope.controllerHome,
    repoId: scope.repoId,
    sessionId: session.sessionId,
    principalId: session.principalId,
    workId: scope.workId,
    kind: 'generic',
    value,
  });
  return {
    externalized: true,
    value: {
      externalized: true,
      truncated: true,
      byteLength: stored.byteLength,
      resultRef: stored.resultRef,
      resultId: stored.resultId,
      sessionId: session.sessionId,
      preview: serialized.slice(0, 4_096),
      detailPointer: {
        tool: 'result_read',
        arguments: { session_id: session.sessionId, result_ref: stored.resultRef, limit: 16 },
      },
      next: 'Use result_read or result_search with this session_id/result_ref for additional bounded detail.',
    },
  };
}
