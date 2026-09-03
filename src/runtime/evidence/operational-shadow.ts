import type { ProcessCheckReceiptEvidence } from '../../../packages/kernel/work/api/index';
import type { ScopeRef } from '../../../packages/kernel/identity/api/index';
import type { OperationalActionId, OperationalMetricId, OperationalObservation, OperationalOutcomeClass, OperationalTargetId } from '../../../packages/kernel/memory/api/index';
import type { ExecutionJob } from '../execution/jobs/types';

interface ShadowExtractionIdentity {
  targetId: OperationalTargetId;
  actionId: OperationalActionId;
  metricId: OperationalMetricId;
  scope: ScopeRef;
  consumerRequestId: string;
  retainedUntil: string;
  environmentFingerprint: string;
}
function elapsedMs(startedAt:string,finishedAt:string){const start=Date.parse(startedAt),finish=Date.parse(finishedAt);return Number.isFinite(start)&&Number.isFinite(finish)&&finish>=start?finish-start:0}
function jobOutcomeClass(job:ExecutionJob):OperationalOutcomeClass{
  if(job.status==='waiting_for_approval')return'admission_wait';
  if(job.status.startsWith('waiting_for_'))return'contention_wait';
  if(job.status==='cancelled')return'cancelled';
  if(job.status==='timed_out')return'timeout';
  if(job.status==='failed'&&job.outcome?.policy?.decision==='rejected')return'policy_denied';
  if(job.status==='failed'&&job.outcome?.failureClass==='infrastructure_failure')return'infrastructure_failure';
  if(job.status==='failed')return'executed_failure';
  if(job.status==='succeeded')return'executed_success';
  return'unknown';
}
function checkOutcomeClass(receipt:ProcessCheckReceiptEvidence):OperationalOutcomeClass{
  if(receipt.status==='cancelled')return'cancelled';if(receipt.status==='timed_out')return'timeout';if(receipt.status==='failed')return'executed_failure';if(receipt.status==='passed')return'executed_success';return'unknown';
}
function valueForMetric(metric:OperationalMetricId,outcome:OperationalOutcomeClass,elapsed:number){return metric==='latency_ms'?elapsed:outcome==='executed_success'?1:0}
export function extractExecutionJobShadowObservation(job:ExecutionJob,identity:ShadowExtractionIdentity):OperationalObservation{
  const outcomeClass=jobOutcomeClass(job),observedAt=job.finishedAt??job.updatedAt,startAt=job.startedAt??job.queuedAt;
  return{schemaVersion:1,observationId:`execution_job:${job.jobId}:${job.revision}:${identity.targetId}:${identity.actionId}:${identity.metricId}`,signalId:'execution_job.terminal_mechanical',targetId:identity.targetId,actionId:identity.actionId,metricId:identity.metricId,scope:identity.scope,source:{schema:'execution_job/v1',sourceId:job.jobId,eventKind:job.status,evidenceRef:`execution_job:${job.jobId}:${job.revision}`,requestId:job.requestId,observedAt,retainedUntil:identity.retainedUntil},attribution:{kind:identity.consumerRequestId===job.requestId?'exact':'ambiguous',consumerId:'shadow_evaluation',requestId:identity.consumerRequestId,sourceId:job.jobId},outcomeClass,value:valueForMetric(identity.metricId,outcomeClass,elapsedMs(startAt,observedAt)),compatibility:{operation:job.payload.operation,environment:identity.environmentFingerprint}};
}
export function extractProcessCheckShadowObservation(receipt:ProcessCheckReceiptEvidence,identity:ShadowExtractionIdentity):OperationalObservation{
  const outcomeClass=checkOutcomeClass(receipt),requestId=receipt.requestId??'';
  return{schemaVersion:1,observationId:`process_check:${receipt.receiptId}:${identity.targetId}:${identity.actionId}:${identity.metricId}`,signalId:'process_check.terminal_mechanical',targetId:identity.targetId,actionId:identity.actionId,metricId:identity.metricId,scope:identity.scope,source:{schema:'process_check_receipt/v1',sourceId:receipt.receiptId,eventKind:receipt.status,evidenceRef:`process_check_receipt:${receipt.receiptId}`,requestId,observedAt:receipt.finishedAt,retainedUntil:identity.retainedUntil},attribution:{kind:requestId.length>0&&identity.consumerRequestId===requestId?'exact':'ambiguous',consumerId:'shadow_evaluation',requestId:identity.consumerRequestId,sourceId:receipt.receiptId},outcomeClass,value:valueForMetric(identity.metricId,outcomeClass,elapsedMs(receipt.startedAt,receipt.finishedAt)),compatibility:{operation:`check:${receipt.checkId}`,environment:receipt.checkEnvironmentFingerprint??identity.environmentFingerprint}};
}
