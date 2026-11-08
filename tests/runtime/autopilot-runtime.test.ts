import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ensureControllerHome } from '../../src/effects/controller-home';
import { registerRepository } from '../../src/cli/repositories/registry';
import {
  createRequirement,
  reviseRequirementSemantic,
} from '../../src/runtime/control-plane/persistence/requirement-store';
import { createPlanSemanticContext } from '../../src/runtime/control-plane/facade/plan-contract-store';
import {
  activeAutopilotGrant,
  authorizeAutopilot,
  resumeAutopilot,
  startAutopilot,
} from '../../src/runtime/autopilot/service';
import {
  createAutopilotRun,
  defaultAutopilotPolicy,
  readAutopilotRun,
} from '../../src/runtime/autopilot/store';
import { runAutopilotLoop } from '../../src/runtime/autopilot/runner';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root,{recursive:true,force:true});
});

function tempRoot(prefix:string): string {
  const root = mkdtempSync(join(tmpdir(),prefix));
  roots.push(root);
  return root;
}
function git(root:string,...args:string[]): string {
  return execFileSync('git',args,{cwd:root,encoding:'utf8'}).trim();
}
function fixture(name:string) {
  const controllerHome=tempRoot(`forge-autopilot-${name}-home-`);
  const repoRoot=tempRoot(`forge-autopilot-${name}-repo-`);
  mkdirSync(join(repoRoot,'src'),{recursive:true});
  writeFileSync(join(repoRoot,'src','index.ts'),'export const ready = true;\n');
  git(repoRoot,'init','-b','main');
  git(repoRoot,'config','user.email','test@example.com');
  git(repoRoot,'config','user.name','Forge Test');
  git(repoRoot,'add','.');
  git(repoRoot,'commit','-m','init');
  ensureControllerHome(controllerHome);
  const repository=registerRepository({path:repoRoot,controllerHome,displayName:name});
  createRequirement({controllerHome},{
    requirementId:'REQ-AUTO',
    title:'Autopilot',
    outcomeStatement:'Deliver the approved autonomous slice.',
    acceptanceCriteria:['Keep ordinary Forge use Requirement-optional.'],
  });
  return {controllerHome,repoRoot,repository};
}
function response(toolName:string,args:Record<string,unknown>,usage={prompt_tokens:10,completion_tokens:5,total_tokens:15}) {
  return new Response(JSON.stringify({
    choices:[{message:{
      role:'assistant',
      content:null,
      tool_calls:[{id:'call-1',type:'function',function:{name:toolName,arguments:JSON.stringify(args)}}],
    }}],
    usage,
  }),{status:200,headers:{'content-type':'application/json'}});
}
const executeCommandDefinition=[{
  name:'execute_command',
  description:'Execute a bounded repository command.',
  inputSchema:{type:'object',properties:{command:{}}},
}];

describe('Requirement Autopilot',() => {
  test('requires explicit authorization, binds the exact Requirement revision, and replaces prior grants',() => {
    const fx=fixture('authorization');
    expect(() => authorizeAutopilot({
      controllerHome:fx.controllerHome,
      repoId:fx.repository.repoId,
      requirementId:'REQ-AUTO',
      confirmAuthorization:false,
    })).toThrow('AUTOPILOT_AUTHORIZATION_CONFIRMATION_REQUIRED');

    const first=authorizeAutopilot({
      controllerHome:fx.controllerHome,
      repoId:fx.repository.repoId,
      requirementId:'REQ-AUTO',
      confirmAuthorization:true,
      policy:{maxTotalTokens:12_000,maxTurns:4,maxToolCalls:6},
    });
    expect(first.grant.constraints?.requirementRevision).toBe(1);
    expect(first.grant.riskCeiling).toBe('workspace_write');

    const second=authorizeAutopilot({
      controllerHome:fx.controllerHome,
      repoId:fx.repository.repoId,
      requirementId:'REQ-AUTO',
      confirmAuthorization:true,
      policy:{maxTotalTokens:20_000,maxTurns:5,maxToolCalls:8},
    });
    expect(second.grant.grantId).not.toBe(first.grant.grantId);
    expect(activeAutopilotGrant(fx.controllerHome,fx.repository.repoId,'REQ-AUTO')?.grantId)
      .toBe(second.grant.grantId);
  });

  test('requires reapproval after the Requirement semantic revision changes',() => {
    const fx=fixture('revision');
    authorizeAutopilot({
      controllerHome:fx.controllerHome,
      repoId:fx.repository.repoId,
      requirementId:'REQ-AUTO',
      confirmAuthorization:true,
    });
    reviseRequirementSemantic({controllerHome:fx.controllerHome},'REQ-AUTO',{
      expectedRevision:1,
      outcomeStatement:'Deliver the revised approved autonomous slice.',
    });
    expect(() => startAutopilot({
      controllerHome:fx.controllerHome,
      repoId:fx.repository.repoId,
      requirementId:'REQ-AUTO',
      dependencies:{apiKey:'test',toolDefinitions:[],executeTool:async()=>({})},
    })).toThrow('AUTOPILOT_REQUIREMENT_REVISION_REAPPROVAL_REQUIRED');
  });

  test('pauses at an explicit Plan checkpoint and records provider usage',async() => {
    const fx=fixture('checkpoint');
    createPlanSemanticContext({controllerHome:fx.controllerHome,repoId:fx.repository.repoId},{
      planId:'PLAN-CHECK',
      repoId:fx.repository.repoId,
      requirementId:'REQ-AUTO',
      scopeKey:'checkpoint-plan',
      sourceBasisRevision:git(fx.repoRoot,'rev-parse','HEAD'),
      goal:'Pause for human acceptance.',
      items:[],
    });
    const enrolled=authorizeAutopilot({
      controllerHome:fx.controllerHome,
      repoId:fx.repository.repoId,
      requirementId:'REQ-AUTO',
      confirmAuthorization:true,
      policy:{checkpointPlanIds:['PLAN-CHECK'],maxTurns:3,maxToolCalls:3,maxTotalTokens:10_000},
    });
    createAutopilotRun(fx.controllerHome,{
      repoId:fx.repository.repoId,
      checkoutId:enrolled.checkoutId,
      requirementId:'REQ-AUTO',
      requirementRevision:1,
      grantId:enrolled.grant.grantId,
      policy:enrolled.policy,
    });
    await runAutopilotLoop(
      fx.controllerHome,fx.repository.repoId,'REQ-AUTO',new AbortController().signal,
      {
        apiKey:'test',
        toolDefinitions:[],
        executeTool:async()=>({}),
        validateAuthorization:()=>({ok:true}),
        fetchImpl:async()=>response('forge_autopilot_decision',{
          action:'continue',
          summary:'Checkpoint implementation is ready for acceptance.',
          current_plan_id:'PLAN-CHECK',
          evidence_refs:['commit:abc'],
        }),
      },
    );
    const run=readAutopilotRun(fx.controllerHome,fx.repository.repoId,'REQ-AUTO')!.value;
    expect(run.status).toBe('paused');
    expect(run.stopReason).toBe('human_checkpoint:PLAN-CHECK');
    expect(run.usage).toMatchObject({promptTokens:10,completionTokens:5,totalTokens:15,turns:1,toolCalls:1});
    expect(run.evidenceRefs).toEqual(['commit:abc']);
  });

  test('resumes a persisted running run after Runtime restart without creating a second lifecycle owner',async() => {
    const fx=fixture('restart');
    const enrolled=authorizeAutopilot({
      controllerHome:fx.controllerHome,
      repoId:fx.repository.repoId,
      requirementId:'REQ-AUTO',
      confirmAuthorization:true,
      policy:{maxTurns:3,maxToolCalls:3,maxTotalTokens:10_000},
    });
    createAutopilotRun(fx.controllerHome,{
      repoId:fx.repository.repoId,
      checkoutId:enrolled.checkoutId,
      requirementId:'REQ-AUTO',
      requirementRevision:1,
      grantId:enrolled.grant.grantId,
      policy:enrolled.policy,
    });

    resumeAutopilot({
      controllerHome:fx.controllerHome,
      repoId:fx.repository.repoId,
      requirementId:'REQ-AUTO',
      dependencies:{
        apiKey:'test',toolDefinitions:[],executeTool:async()=>({}),
        fetchImpl:async()=>response('forge_autopilot_decision',{
          action:'complete',summary:'Recovered persisted run completed safely.',evidence_refs:['commit:restart'],
        }),
      },
    });

    for (let attempt=0;attempt<50;attempt+=1) {
      if (readAutopilotRun(fx.controllerHome,fx.repository.repoId,'REQ-AUTO')?.value.status === 'completed') break;
      await Bun.sleep(10);
    }
    const run=readAutopilotRun(fx.controllerHome,fx.repository.repoId,'REQ-AUTO')!.value;
    expect(run.status).toBe('completed');
    expect(run.evidenceRefs).toEqual(['commit:restart']);
  });

  test('rejects a remote-write command before the existing repository executor is invoked',async() => {
    const fx=fixture('risk');
    const enrolled=authorizeAutopilot({
      controllerHome:fx.controllerHome,
      repoId:fx.repository.repoId,
      requirementId:'REQ-AUTO',
      confirmAuthorization:true,
      policy:{maxTurns:3,maxToolCalls:3,maxTotalTokens:10_000},
    });
    createAutopilotRun(fx.controllerHome,{
      repoId:fx.repository.repoId,
      checkoutId:enrolled.checkoutId,
      requirementId:'REQ-AUTO',
      requirementRevision:1,
      grantId:enrolled.grant.grantId,
      policy:defaultAutopilotPolicy({maxTurns:3,maxToolCalls:3,maxTotalTokens:10_000}),
    });
    let fetchCount=0;
    let executorCalls=0;
    await runAutopilotLoop(
      fx.controllerHome,fx.repository.repoId,'REQ-AUTO',new AbortController().signal,
      {
        apiKey:'test',
        toolDefinitions:executeCommandDefinition,
        executeTool:async()=>{ executorCalls += 1; return {ok:true}; },
        validateAuthorization:()=>({ok:true}),
        fetchImpl:async()=>{
          fetchCount += 1;
          if (fetchCount === 1) return response('execute_command',{command:['git','push','origin','main']});
          return response('forge_autopilot_decision',{action:'blocked',summary:'Remote write is outside the authorization.'});
        },
      },
    );
    expect(executorCalls).toBe(0);
    const run=readAutopilotRun(fx.controllerHome,fx.repository.repoId,'REQ-AUTO')!.value;
    expect(run.status).toBe('blocked');
    expect(run.usage.turns).toBe(2);
    expect(run.usage.toolCalls).toBe(1);
  });
});
