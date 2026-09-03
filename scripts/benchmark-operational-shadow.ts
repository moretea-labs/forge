#!/usr/bin/env bun
import { performance } from 'node:perf_hooks';
import { rankOperationalShadowPriors, reduceOperationalObservations, type OperationalObservation, type OperationalShadowPrior } from '../packages/kernel/memory/api/index';
import { evaluateOperationalShadowPairs, freezeOperationalShadowProtocol, type OperationalShadowPair } from '../evaluation/lib/shadow-operational-prior';

interface Fixture { id:string; domainKind:'engineering'|'non_engineering'; operation:string; environment:string; expectedAction:'candidate' }
const fixtures:readonly Fixture[]=[
  {id:'engineering-check-ordering',domainKind:'engineering',operation:'check_ordering',environment:'portable-fixture-v1',expectedAction:'candidate'},
  {id:'research-source-ordering',domainKind:'non_engineering',operation:'source_ordering',environment:'portable-fixture-v1',expectedAction:'candidate'},
];
const asOf='2026-09-04T00:00:00.000Z',retainedUntil='2026-09-20T00:00:00.000Z';
function obs(f:Fixture,action:'baseline'|'candidate',index:number,value:number,outcome:'executed_success'|'contention_wait'='executed_success'):OperationalObservation{
 const requestId=`${f.id}:${action}:${index}`,observedAt=`2026-09-03T00:${String(index).padStart(2,'0')}:00.000Z`;
 return{schemaVersion:1,observationId:`obs:${requestId}:${outcome}`,signalId:'execution_job.terminal_mechanical',targetId:'mechanical_candidate_ordering',actionId:action,metricId:'latency_ms',scope:{schemaVersion:1,kind:'project',id:`fixture:${f.id}`},source:{schema:'execution_job/v1',sourceId:`source:${requestId}`,eventKind:outcome==='contention_wait'?'waiting_for_workspace':'succeeded',evidenceRef:`evidence:${requestId}`,requestId,observedAt,retainedUntil},attribution:{kind:'exact',consumerId:'shadow_evaluation',requestId,sourceId:`source:${requestId}`},outcomeClass:outcome,value,compatibility:{operation:f.operation,environment:f.environment}};
}
function fixtureObservations(f:Fixture){return[obs(f,'baseline',1,900),obs(f,'baseline',2,880),obs(f,'baseline',3,920),obs(f,'candidate',4,520),obs(f,'candidate',5,500),obs(f,'candidate',6,510),obs(f,'candidate',7,0,'contention_wait')]}
function retained(priors:readonly OperationalShadowPrior[]){return new Set(priors.flatMap(p=>p.supportEvidenceRefs))}
function select(priors:readonly OperationalShadowPrior[],f:Fixture){return rankOperationalShadowPriors({priors,compatibility:{operation:f.operation,environment:f.environment},retainedEvidenceRefs:retained(priors),asOf})[0]?.prior.actionId}
function benchmark(fn:()=>unknown,iterations=1200){for(let i=0;i<60;i++)fn();const start=performance.now();for(let i=0;i<iterations;i++)fn();return Math.max((performance.now()-start)/iterations,0.000001)}
function bytes(value:unknown){return Buffer.byteLength(JSON.stringify(value),'utf8')}
function pair(f:Fixture,candidateRevision:string):OperationalShadowPair{
 const observations=fixtureObservations(f);const shadowReduction=reduceOperationalObservations({observations,asOf});const priors=shadowReduction.priors;const coldSelect=()=>{const reduction=reduceOperationalObservations({observations,asOf});return select(reduction.priors,f)};const shadowSelect=()=>select(priors,f);const coldChoice=coldSelect(),shadowChoice=shadowSelect();
 const context={operation:f.operation,candidates:['baseline','candidate'],scope:`fixture:${f.id}`};const contextBytes=bytes(context),rawEvidenceBytes=bytes(observations),shadowBytes=bytes(priors);
 return{scenarioId:f.id,domainKind:f.domainKind,candidateRevision,cold:{controllerVisibleBytes:contextBytes+rawEvidenceBytes,contextBytes,shadowBytes:0,rhContextEvidenceBytes:rawEvidenceBytes,mechanicalRereads:observations.length,toolRoundTrips:observations.length,latencyMs:benchmark(coldSelect),staleNoValueRetrievals:shadowReduction.rejected.length,correctnessPassed:coldChoice===f.expectedAction},shadow:{controllerVisibleBytes:contextBytes+shadowBytes,contextBytes,shadowBytes,rhContextEvidenceBytes:0,mechanicalRereads:0,toolRoundTrips:1,latencyMs:benchmark(shadowSelect),staleNoValueRetrievals:0,correctnessPassed:shadowChoice===f.expectedAction}};
}
export function runOperationalShadowBenchmark(candidateRevision:string){const protocol=freezeOperationalShadowProtocol({candidateRevision,heldOutScenarioIds:fixtures.map(f=>f.id)});const pairs=fixtures.map(f=>pair(f,candidateRevision));const report=evaluateOperationalShadowPairs(protocol,pairs);return{schemaVersion:1 as const,protocol,pairs,report}}
function candidateArg(){const i=process.argv.indexOf('--candidate');return i>=0?process.argv[i+1]:undefined}
if(import.meta.main){const candidate=candidateArg();if(!candidate)throw new Error('Usage: bun scripts/benchmark-operational-shadow.ts --candidate <exact-revision>');const result=runOperationalShadowBenchmark(candidate);console.log(JSON.stringify(result,null,2));if(!result.report.passed)process.exitCode=1}
