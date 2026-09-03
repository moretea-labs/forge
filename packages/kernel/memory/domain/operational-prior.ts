import type { ScopeKind, ScopeRef } from '../../identity/api/index';

export const OPERATIONAL_SIGNAL_IDS = ['execution_job.terminal_mechanical','process_check.terminal_mechanical'] as const;
export type OperationalSignalId = (typeof OPERATIONAL_SIGNAL_IDS)[number];
export const OPERATIONAL_TARGET_IDS = ['mechanical_candidate_ordering','check_completion_grace'] as const;
export type OperationalTargetId = (typeof OPERATIONAL_TARGET_IDS)[number];
export const OPERATIONAL_ACTION_IDS = ['baseline','candidate','observed_check'] as const;
export type OperationalActionId = (typeof OPERATIONAL_ACTION_IDS)[number];
export const OPERATIONAL_METRIC_IDS = ['latency_ms','success_rate'] as const;
export type OperationalMetricId = (typeof OPERATIONAL_METRIC_IDS)[number];
export const OPERATIONAL_CONSUMER_IDS = ['shadow_evaluation','run_check_completion_grace'] as const;
export type OperationalConsumerId = (typeof OPERATIONAL_CONSUMER_IDS)[number];
export const OPERATIONAL_SOURCE_SCHEMAS = ['execution_job/v1','process_check_receipt/v1'] as const;
export type OperationalSourceSchema = (typeof OPERATIONAL_SOURCE_SCHEMAS)[number];
export const OPERATIONAL_COMPATIBILITY_DIMENSIONS = ['operation','environment'] as const;
export type OperationalCompatibilityDimension = (typeof OPERATIONAL_COMPATIBILITY_DIMENSIONS)[number];

export type OperationalOutcomeClass = 'executed_success'|'executed_failure'|'admission_wait'|'contention_wait'|'policy_denied'|'cancelled'|'timeout'|'infrastructure_failure'|'unknown';

export interface OperationalSignalDefinition {
  schemaVersion:1; signalId:OperationalSignalId; owner:'kernel.memory.shadow'; sourceSchema:OperationalSourceSchema;
  eventKinds:readonly string[]; extractorVersion:1; valueType:'number'; dataClass:'mechanical_telemetry';
  maxScopeCardinality:number; maxCompatibilityCardinality:number; retentionHorizonMs:number; invalidationDimensions:readonly OperationalCompatibilityDimension[];
}
export interface OperationalMetricDefinition {
  schemaVersion:1; metricId:OperationalMetricId; direction:'lower_is_better'|'higher_is_better';
  admissibleOutcomes:readonly OperationalOutcomeClass[]; decayHalfLifeMs:number;
}
export interface OperationalTargetDefinition {
  schemaVersion:1; targetId:OperationalTargetId; owner:'kernel.memory.shadow'; consumerId:OperationalConsumerId;
  actions:readonly OperationalActionId[]; metricIds:readonly OperationalMetricId[]; applicableScopeKinds:readonly ScopeKind[];
  compatibilityDimensions:readonly OperationalCompatibilityDimension[];
  forbiddenDecisions:readonly ['semantic_acceptance','lifecycle_transition','approval','authorization','external_effect','product_or_coding_strategy'];
  activationThreshold:{minSamples:number;minDistinctEvidence:number;maxSamples:number};
}
const DAY_MS=24*60*60*1000;
export const OPERATIONAL_SIGNAL_DEFINITIONS:Readonly<Record<OperationalSignalId,OperationalSignalDefinition>>=Object.freeze({
  'execution_job.terminal_mechanical':Object.freeze({schemaVersion:1,signalId:'execution_job.terminal_mechanical',owner:'kernel.memory.shadow',sourceSchema:'execution_job/v1',eventKinds:Object.freeze(['succeeded','failed','timed_out','cancelled','waiting_for_dependency','waiting_for_workspace','waiting_for_heavy_check','waiting_for_integration','waiting_for_release_barrier','waiting_for_approval']),extractorVersion:1,valueType:'number',dataClass:'mechanical_telemetry',maxScopeCardinality:128,maxCompatibilityCardinality:256,retentionHorizonMs:30*DAY_MS,invalidationDimensions:OPERATIONAL_COMPATIBILITY_DIMENSIONS}),
  'process_check.terminal_mechanical':Object.freeze({schemaVersion:1,signalId:'process_check.terminal_mechanical',owner:'kernel.memory.shadow',sourceSchema:'process_check_receipt/v1',eventKinds:Object.freeze(['passed','failed','timed_out','cancelled']),extractorVersion:1,valueType:'number',dataClass:'mechanical_telemetry',maxScopeCardinality:128,maxCompatibilityCardinality:256,retentionHorizonMs:7*DAY_MS,invalidationDimensions:OPERATIONAL_COMPATIBILITY_DIMENSIONS}),
});
export const OPERATIONAL_METRIC_DEFINITIONS:Readonly<Record<OperationalMetricId,OperationalMetricDefinition>>=Object.freeze({
  latency_ms:Object.freeze({schemaVersion:1,metricId:'latency_ms',direction:'lower_is_better',admissibleOutcomes:['executed_success','executed_failure','timeout'] as const,decayHalfLifeMs:7*DAY_MS}),
  success_rate:Object.freeze({schemaVersion:1,metricId:'success_rate',direction:'higher_is_better',admissibleOutcomes:['executed_success','executed_failure'] as const,decayHalfLifeMs:14*DAY_MS}),
});
export const OPERATIONAL_TARGET_DEFINITIONS:Readonly<Record<OperationalTargetId,OperationalTargetDefinition>>=Object.freeze({
  mechanical_candidate_ordering:Object.freeze({schemaVersion:1,targetId:'mechanical_candidate_ordering',owner:'kernel.memory.shadow',consumerId:'shadow_evaluation',actions:['baseline','candidate'] as const,metricIds:OPERATIONAL_METRIC_IDS,applicableScopeKinds:['workspace','project','requirement','plan','plan_step','work'] as const,compatibilityDimensions:OPERATIONAL_COMPATIBILITY_DIMENSIONS,forbiddenDecisions:['semantic_acceptance','lifecycle_transition','approval','authorization','external_effect','product_or_coding_strategy'] as const,activationThreshold:Object.freeze({minSamples:3,minDistinctEvidence:3,maxSamples:64})}),
  check_completion_grace:Object.freeze({schemaVersion:1,targetId:'check_completion_grace',owner:'kernel.memory.shadow',consumerId:'run_check_completion_grace',actions:['observed_check'] as const,metricIds:['latency_ms'] as const,applicableScopeKinds:['project'] as const,compatibilityDimensions:OPERATIONAL_COMPATIBILITY_DIMENSIONS,forbiddenDecisions:['semantic_acceptance','lifecycle_transition','approval','authorization','external_effect','product_or_coding_strategy'] as const,activationThreshold:Object.freeze({minSamples:3,minDistinctEvidence:3,maxSamples:32})}),
});

export interface OperationalObservation {
  schemaVersion:1; observationId:string; signalId:OperationalSignalId; targetId:OperationalTargetId; actionId:OperationalActionId;
  metricId:OperationalMetricId; scope:ScopeRef;
  source:{schema:OperationalSourceSchema;sourceId:string;eventKind:string;evidenceRef:string;requestId:string;observedAt:string;retainedUntil:string};
  attribution:{kind:'exact'|'ambiguous';consumerId:OperationalConsumerId;requestId:string;sourceId:string};
  outcomeClass:OperationalOutcomeClass; value:number; compatibility:Readonly<Record<OperationalCompatibilityDimension,string>>;
}
export type OperationalObservationRejectionReason='unregistered_signal'|'source_schema_mismatch'|'unregistered_event_kind'|'unregistered_target'|'unregistered_action'|'unregistered_metric'|'scope_not_applicable'|'ambiguous_attribution'|'attribution_identity_mismatch'|'invalid_value'|'invalid_compatibility'|'inadmissible_outcome'|'replay_expired'|'retention_horizon_exceeded'|'scope_cardinality_exceeded'|'compatibility_cardinality_exceeded'|'duplicate_evidence'|'sample_cap_exceeded';
export interface OperationalShadowPrior {schemaVersion:1;mode:'shadow';targetId:OperationalTargetId;actionId:OperationalActionId;metricId:OperationalMetricId;scope:ScopeRef;compatibility:Readonly<Record<OperationalCompatibilityDimension,string>>;estimate:number;sampleCount:number;distinctEvidenceCount:number;latestObservedAt:string;replayHorizonEndsAt:string;supportEvidenceRefs:readonly string[];sourceObservationIds:readonly string[];readiness:'insufficient_samples'|'shadow_candidate'}
export interface OperationalPriorReduction {priors:OperationalShadowPrior[];rejected:Array<{observationId:string;reason:OperationalObservationRejectionReason}>}
function validInstant(v:string){const n=Date.parse(v);return Number.isFinite(n)?n:undefined}
function boundedIdentity(v:string){return v.trim().length>0&&v.length<=256}
function scopeKey(s:ScopeRef){return `${s.kind}:${s.id}`}
function compatibilityKey(v:Readonly<Record<OperationalCompatibilityDimension,string>>){return OPERATIONAL_COMPATIBILITY_DIMENSIONS.map(d=>`${d}=${v[d]}`).join('|')}
function validateObservation(o:OperationalObservation,asOfMs:number):OperationalObservationRejectionReason|undefined{
  const signal=OPERATIONAL_SIGNAL_DEFINITIONS[o.signalId]; if(!signal)return'unregistered_signal';
  if(o.source.schema!==signal.sourceSchema)return'source_schema_mismatch'; if(!signal.eventKinds.includes(o.source.eventKind))return'unregistered_event_kind';
  const target=OPERATIONAL_TARGET_DEFINITIONS[o.targetId]; if(!target)return'unregistered_target';
  if(!target.actions.includes(o.actionId))return'unregistered_action'; if(!target.metricIds.includes(o.metricId))return'unregistered_metric';
  if(!target.applicableScopeKinds.includes(o.scope.kind))return'scope_not_applicable'; if(o.attribution.kind!=='exact')return'ambiguous_attribution';
  if(o.attribution.consumerId!==target.consumerId||o.attribution.requestId!==o.source.requestId||o.attribution.sourceId!==o.source.sourceId)return'attribution_identity_mismatch';
  if(!Number.isFinite(o.value)||o.value<0)return'invalid_value'; if(o.metricId==='success_rate'&&o.value!==0&&o.value!==1)return'invalid_value';
  for(const d of target.compatibilityDimensions)if(!boundedIdentity(o.compatibility[d]))return'invalid_compatibility';
  const metric=OPERATIONAL_METRIC_DEFINITIONS[o.metricId]; if(!metric.admissibleOutcomes.includes(o.outcomeClass))return'inadmissible_outcome';
  const observed=validInstant(o.source.observedAt), retained=validInstant(o.source.retainedUntil); if(observed===undefined||retained===undefined||retained<=observed||retained<=asOfMs)return'replay_expired';if(retained-observed>signal.retentionHorizonMs)return'retention_horizon_exceeded';
  if(![o.observationId,o.source.sourceId,o.source.evidenceRef,o.source.requestId].every(boundedIdentity))return'attribution_identity_mismatch';
}
export function reduceOperationalObservations(input:{observations:readonly OperationalObservation[];asOf:string}):OperationalPriorReduction{
  const asOfMs=validInstant(input.asOf); if(asOfMs===undefined)throw new Error('OPERATIONAL_PRIOR_INVALID_AS_OF');
  const rejected:OperationalPriorReduction['rejected']=[]; const scopesBySignal=new Map<OperationalSignalId,Set<string>>(); const compatibilityBySignal=new Map<OperationalSignalId,Set<string>>(); const buckets=new Map<string,{observation:OperationalObservation;sum:number;count:number;evidenceRefs:Set<string>;observationIds:Set<string>;latestObservedAt:string;replayHorizonEndsAt:string}>();
  const ordered=[...input.observations].sort((a,b)=>a.source.observedAt.localeCompare(b.source.observedAt)||a.source.evidenceRef.localeCompare(b.source.evidenceRef)||a.observationId.localeCompare(b.observationId));
  for(const o of ordered){const reason=validateObservation(o,asOfMs);if(reason){rejected.push({observationId:o.observationId,reason});continue}const signalScopes=scopesBySignal.get(o.signalId)??new Set<string>();const observedScope=scopeKey(o.scope);if(!signalScopes.has(observedScope)&&signalScopes.size>=OPERATIONAL_SIGNAL_DEFINITIONS[o.signalId].maxScopeCardinality){rejected.push({observationId:o.observationId,reason:'scope_cardinality_exceeded'});continue}signalScopes.add(observedScope);scopesBySignal.set(o.signalId,signalScopes);const compat=compatibilityKey(o.compatibility);const signalCompatibility=compatibilityBySignal.get(o.signalId)??new Set<string>();if(!signalCompatibility.has(compat)&&signalCompatibility.size>=OPERATIONAL_SIGNAL_DEFINITIONS[o.signalId].maxCompatibilityCardinality){rejected.push({observationId:o.observationId,reason:'compatibility_cardinality_exceeded'});continue}signalCompatibility.add(compat);compatibilityBySignal.set(o.signalId,signalCompatibility);const key=[o.targetId,o.actionId,o.metricId,scopeKey(o.scope),compat].join('|');const x=buckets.get(key);if(!x){buckets.set(key,{observation:o,sum:o.value,count:1,evidenceRefs:new Set([o.source.evidenceRef]),observationIds:new Set([o.observationId]),latestObservedAt:o.source.observedAt,replayHorizonEndsAt:o.source.retainedUntil});continue}if(x.observationIds.has(o.observationId)||x.evidenceRefs.has(o.source.evidenceRef)){rejected.push({observationId:o.observationId,reason:'duplicate_evidence'});continue}if(x.count>=OPERATIONAL_TARGET_DEFINITIONS[o.targetId].activationThreshold.maxSamples){rejected.push({observationId:o.observationId,reason:'sample_cap_exceeded'});continue}x.sum+=o.value;x.count++;x.evidenceRefs.add(o.source.evidenceRef);x.observationIds.add(o.observationId);if(o.source.observedAt>x.latestObservedAt)x.latestObservedAt=o.source.observedAt;if(o.source.retainedUntil<x.replayHorizonEndsAt)x.replayHorizonEndsAt=o.source.retainedUntil}
  const priors=[...buckets.values()].map((b):OperationalShadowPrior=>{const target=OPERATIONAL_TARGET_DEFINITIONS[b.observation.targetId];const refs=[...b.evidenceRefs].sort();return{schemaVersion:1,mode:'shadow',targetId:b.observation.targetId,actionId:b.observation.actionId,metricId:b.observation.metricId,scope:b.observation.scope,compatibility:b.observation.compatibility,estimate:b.sum/b.count,sampleCount:b.count,distinctEvidenceCount:refs.length,latestObservedAt:b.latestObservedAt,replayHorizonEndsAt:b.replayHorizonEndsAt,supportEvidenceRefs:refs,sourceObservationIds:[...b.observationIds].sort(),readiness:b.count>=target.activationThreshold.minSamples&&refs.length>=target.activationThreshold.minDistinctEvidence?'shadow_candidate':'insufficient_samples'}}).sort((a,b)=>a.targetId.localeCompare(b.targetId)||a.metricId.localeCompare(b.metricId)||a.actionId.localeCompare(b.actionId)||scopeKey(a.scope).localeCompare(scopeKey(b.scope))||compatibilityKey(a.compatibility).localeCompare(compatibilityKey(b.compatibility)));
  return{priors,rejected};
}
export interface ResolvedOperationalShadowPrior{prior:OperationalShadowPrior;status:'insufficient_samples'|'shadow_candidate'|'invalidated'|'replay_gap';ageWeight:number;effectiveSampleCount:number}
export function resolveOperationalShadowPrior(input:{prior:OperationalShadowPrior;compatibility:Readonly<Record<OperationalCompatibilityDimension,string>>;retainedEvidenceRefs:ReadonlySet<string>;asOf:string}):ResolvedOperationalShadowPrior{
  const target=OPERATIONAL_TARGET_DEFINITIONS[input.prior.targetId];for(const d of target.compatibilityDimensions)if(input.prior.compatibility[d]!==input.compatibility[d])return{prior:input.prior,status:'invalidated',ageWeight:0,effectiveSampleCount:0};
  if(input.prior.supportEvidenceRefs.some(r=>!input.retainedEvidenceRefs.has(r)))return{prior:input.prior,status:'replay_gap',ageWeight:0,effectiveSampleCount:0};
  const now=validInstant(input.asOf),observed=validInstant(input.prior.latestObservedAt);if(now===undefined||observed===undefined)throw new Error('OPERATIONAL_PRIOR_INVALID_RESOLUTION_TIME');const metric=OPERATIONAL_METRIC_DEFINITIONS[input.prior.metricId];const age=Math.max(0,now-observed);const ageWeight=Math.pow(.5,age/metric.decayHalfLifeMs);return{prior:input.prior,status:input.prior.readiness,ageWeight,effectiveSampleCount:input.prior.sampleCount*ageWeight};
}
export function rankOperationalShadowPriors(input:{priors:readonly OperationalShadowPrior[];compatibility:Readonly<Record<OperationalCompatibilityDimension,string>>;retainedEvidenceRefs:ReadonlySet<string>;asOf:string}){return input.priors.map(prior=>resolveOperationalShadowPrior({prior,compatibility:input.compatibility,retainedEvidenceRefs:input.retainedEvidenceRefs,asOf:input.asOf})).filter(x=>x.status==='shadow_candidate').sort((a,b)=>{const m=OPERATIONAL_METRIC_DEFINITIONS[a.prior.metricId];const d=m.direction==='lower_is_better'?a.prior.estimate-b.prior.estimate:b.prior.estimate-a.prior.estimate;return d||a.prior.actionId.localeCompare(b.prior.actionId)})}
export function replayOperationalPriors(input:{observations:readonly OperationalObservation[];asOf:string}){return reduceOperationalObservations(input)}
