import { describe, expect, test } from 'bun:test';
import { adaptiveCandidateOrder, classifyAdaptiveStep, compareAdaptiveTrials, type AdaptiveTrial } from './adaptive-workflow.ts';

function trial(candidateIndex: number, active: number): AdaptiveTrial {
  return { workflowId:'investigation_direct', cacheMode:'cold', repetition:0, candidateIndex, candidateId:String(candidateIndex), goalSuccess:true, toolInteractions:1, retries:0, recoveryActions:0, restarts:0, harnessSetupMs:20, warmupMs:0, initialConnectMs:active-10, restartConnectMs:0, toolCallMs:10, candidateActiveMs:active, totalTrialMs:active+20, steps:[] };
}

describe('supplemental adaptive workflow', () => {
  test('classifies Direct, durable admission, and restart visibility from public payloads', () => {
    expect(classifyAdaptiveStep('investigation_direct','admit',{data:{mode:{mode:'direct_control'},workContractCreated:false},summary:'investigation'},false).success).toBe(true);
    expect(classifyAdaptiveStep('dependency_durable_admission','admit',{data:{mode:{mode:'goal_workloop'},workContractCreated:true,canonicalWorkRetained:true},summary:'CONTROLLER_AUTHENTICATED_SESSION_REQUIRED'},true).success).toBe(true);
    expect(classifyAdaptiveStep('restart_durable_work_visible','status',{data:{activeWork:[{objective:'Evaluation restart durable Work visibility'}]},summary:'RUNTIME_NOT_RUNNING'},true).success).toBe(true);
  });

  test('balances candidate-first ordering for four repetitions in every workflow/cache cell', () => {
    for (let workflow = 0; workflow < 3; workflow++) for (let cache = 0; cache < 2; cache++) {
      const first = [0,1,2,3].map((repetition) => adaptiveCandidateOrder(workflow, cache, repetition)[0]);
      expect(first.filter((value) => value === 0).length).toBe(2);
      expect(first.filter((value) => value === 1).length).toBe(2);
    }
  });

  test('aggregates paired candidate-active time separately from harness setup', () => {
    const result = compareAdaptiveTrials([trial(0,100), trial(1,125)], 'investigation_direct','cold');
    expect(result.pairCount).toBe(1);
    expect(result.baselineMeanCandidateActiveMs).toBe(100);
    expect(result.candidateMeanCandidateActiveMs).toBe(125);
    expect(result.candidateActiveDeltaMs).toBe(25);
    expect(result.baselineMeanHarnessSetupMs).toBe(20);
  });
});
