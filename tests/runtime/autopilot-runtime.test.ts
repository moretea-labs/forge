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
import { readAutopilotProviderApiKey, readAutopilotProviderProfile } from '../../src/runtime/autopilot/provider-config';

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
function responsesResponse(toolName:string,args:Record<string,unknown>,usage={input_tokens:17,output_tokens:5,total_tokens:22}) {
  return new Response(JSON.stringify({
    output:[{
      type:'function_call',
      id:'fc-1',
      call_id:'call-r1',
      name:toolName,
      arguments:JSON.stringify(args),
    }],
    usage,
  }),{status:200,headers:{'content-type':'application/json'}});
}

const executeCommandDefinition=[{
  name:'execute_command',
  description:'Execute a bounded repository command.',
  inputSchema:{type:'object',properties:{command:{}}},
}];

describe('Requirement Autopilot',() => {
  test('reads the shared Desktop provider profile without copying credentials',() => {
    const home=tempRoot('forge-autopilot-provider-home-');
    const profileDir=join(home,'Library','Application Support','com.moretea.forge.desktop');
    mkdirSync(profileDir,{recursive:true});
    writeFileSync(join(profileDir,'local-api.json'),JSON.stringify({
      provider:'joycode',
      endpoint:'https://zro.moonmath.ai/v1',
      model:'deepseek-v4.1-flash',
      apiProtocol:'responses',
      joyCodeModel:'JoyAI-Code-1.6',
    }));
    expect(readAutopilotProviderProfile(home)).toEqual({
      provider:'joycode',
      endpoint:'https://api-ai.jd.com',
      protocol:'chat_completions',
      model:'JoyAI-Code-1.6',
      source:'desktop-joycode',
    });
    const zroDir=join(home,'.config','zro');
    mkdirSync(zroDir,{recursive:true});
    writeFileSync(join(zroDir,'credentials.json'),JSON.stringify({apiKey:'fixture-zro-key'}));
    expect(readAutopilotProviderApiKey('https://zro.moonmath.ai/v1',{},home)).toBe('fixture-zro-key');
  });

  test('runs an authorized JoyCode policy through the Desktop model-round authority without an API key',async() => {
    const fx=fixture('joycode');
    const enrolled=authorizeAutopilot({
      controllerHome:fx.controllerHome,
      repoId:fx.repository.repoId,
      requirementId:'REQ-AUTO',
      confirmAuthorization:true,
      policy:{
        provider:'joycode',
        endpoint:'https://api-ai.jd.com',
        protocol:'chat_completions',
        model:'JoyAI-Code-1.6',
        maxTurns:2,
        maxToolCalls:2,
        maxTotalTokens:4000,
      },
    });
    expect(enrolled.grant.constraints).toMatchObject({
      provider:'joycode',
      endpoint:'https://api-ai.jd.com',
      model:'JoyAI-Code-1.6',
    });
    let observed:Record<string,unknown>|undefined;
    startAutopilot({
      controllerHome:fx.controllerHome,
      repoId:fx.repository.repoId,
      requirementId:'REQ-AUTO',
      dependencies:{
        toolDefinitions:[],
        executeTool:async()=>({ok:true}),
        modelRound:async(input)=>{
          observed=input.body;
          return {
            choices:[{message:{
              role:'assistant',
              content:null,
              tool_calls:[{
                id:'joycode-decision',
                type:'function',
                function:{
                  name:'forge_autopilot_decision',
                  arguments:JSON.stringify({
                    action:'complete',
                    summary:'JoyCode completed the authorized slice.',
                    evidence_refs:['commit:joycode'],
                  }),
                },
              }],
            }}],
            usage:{prompt_tokens:10,completion_tokens:5,total_tokens:15},
          };
        },
      },
    });
    for (let attempt=0;attempt<50;attempt+=1) {
      if (readAutopilotRun(fx.controllerHome,fx.repository.repoId,'REQ-AUTO')?.value.status === 'completed') break;
      await Bun.sleep(10);
    }
    expect(observed?.model).toBe('JoyAI-Code-1.6');
    expect(Array.isArray(observed?.tools)).toBe(true);
    const run=readAutopilotRun(fx.controllerHome,fx.repository.repoId,'REQ-AUTO')!.value;
    expect(run.status).toBe('completed');
    expect(run.policy.provider).toBe('joycode');
    expect(run.evidenceRefs).toEqual(['commit:joycode']);
  });

  test('bounds JoyCode context by projecting Requirement state and retaining only recent tool rounds',async() => {
    const fx=fixture('bounded-context');
    reviseRequirementSemantic({controllerHome:fx.controllerHome},'REQ-AUTO',{
      expectedRevision:1,
      progressSummary:'progress-secret-marker '.repeat(600),
      remainingWork:['remaining-work-marker'],
      acceptedEvidenceRefs:Array.from({length:40},(_,index)=>'accepted-evidence-marker-'+index),
    });
    const enrolled=authorizeAutopilot({
      controllerHome:fx.controllerHome,
      repoId:fx.repository.repoId,
      requirementId:'REQ-AUTO',
      confirmAuthorization:true,
      policy:{
        provider:'joycode',
        endpoint:'https://api-ai.jd.com',
        protocol:'chat_completions',
        model:'JoyAI-Code-1.6',
        maxTurns:8,
        maxToolCalls:12,
        maxTotalTokens:20_000,
      },
    });
    createAutopilotRun(fx.controllerHome,{
      repoId:fx.repository.repoId,
      checkoutId:enrolled.checkoutId,
      requirementId:'REQ-AUTO',
      requirementRevision:2,
      grantId:enrolled.grant.grantId,
      policy:enrolled.policy,
    });
    const observedBodies:Record<string,unknown>[]=[];
    let round=0;
    await runAutopilotLoop(
      fx.controllerHome,fx.repository.repoId,'REQ-AUTO',new AbortController().signal,
      {
        toolDefinitions:executeCommandDefinition,
        executeTool:async()=>({ok:true,large:'x'.repeat(20_000)}),
        validateAuthorization:()=>({ok:true}),
        modelRound:async(input)=>{
          observedBodies.push(input.body);
          round+=1;
          const decision=round >= 5;
          return {
            choices:[{message:{
              role:'assistant',
              content:null,
              tool_calls:[{
                id:'call-'+round,
                type:'function',
                function:{
                  name:decision ? 'forge_autopilot_decision' : 'execute_command',
                  arguments:JSON.stringify(decision
                    ? {action:'complete',summary:'bounded context verified'}
                    : {command:['git','status','--short']}),
                },
              }],
            }}],
            usage:{prompt_tokens:100,completion_tokens:20,total_tokens:120},
          };
        },
      },
    );
    const firstMessages=observedBodies[0].messages as Array<Record<string,unknown>>;
    const system=String(firstMessages[0]?.content ?? '');
    expect(system).toContain('remaining-work-marker');
    expect(system).not.toContain('progress-secret-marker');
    expect(system).not.toContain('accepted-evidence-marker');
    const finalMessages=observedBodies.at(-1)?.messages as Array<Record<string,unknown>>;
    expect(finalMessages.length).toBeLessThanOrEqual(7);
    const toolContents=finalMessages.filter((message)=>message.role==='tool').map((message)=>String(message.content ?? ''));
    expect(toolContents.every((content)=>content.length <= 6_000)).toBe(true);
  });

  test('reauthorizes a budget-paused run in place and preserves its lifecycle identity',async() => {
    const fx=fixture('budget-refresh');
    const first=authorizeAutopilot({
      controllerHome:fx.controllerHome,
      repoId:fx.repository.repoId,
      requirementId:'REQ-AUTO',
      confirmAuthorization:true,
      policy:{maxTotalTokens:1_000,maxTurns:4,maxToolCalls:6},
    });
    createAutopilotRun(fx.controllerHome,{
      repoId:fx.repository.repoId,
      checkoutId:first.checkoutId,
      requirementId:'REQ-AUTO',
      requirementRevision:1,
      grantId:first.grant.grantId,
      policy:first.policy,
    });
    await runAutopilotLoop(
      fx.controllerHome,fx.repository.repoId,'REQ-AUTO',new AbortController().signal,
      {
        apiKey:'fixture-key',
        toolDefinitions:[],
        executeTool:async()=>({}),
        validateAuthorization:()=>({ok:true}),
        fetchImpl:async()=>response('forge_autopilot_decision',{
          action:'continue',summary:'continue after budget refresh',
        },{prompt_tokens:900,completion_tokens:200,total_tokens:1_100}),
      },
    );
    const paused=readAutopilotRun(fx.controllerHome,fx.repository.repoId,'REQ-AUTO')!.value;
    expect(paused.status).toBe('paused');
    expect(paused.stopReason).toBe('max_total_tokens_reached');
    const runId=paused.runId;
    const usage={...paused.usage};

    const second=authorizeAutopilot({
      controllerHome:fx.controllerHome,
      repoId:fx.repository.repoId,
      requirementId:'REQ-AUTO',
      confirmAuthorization:true,
      policy:{maxTotalTokens:4_000,maxTurns:6,maxToolCalls:8},
    });
    const refreshed=readAutopilotRun(fx.controllerHome,fx.repository.repoId,'REQ-AUTO')!.value;
    expect(refreshed.runId).toBe(runId);
    expect(refreshed.grantId).toBe(second.grant.grantId);
    expect(refreshed.usage).toEqual(usage);
    expect(refreshed.policy.maxTotalTokens).toBe(4_000);
    expect(refreshed.status).toBe('paused');

    resumeAutopilot({
      controllerHome:fx.controllerHome,
      repoId:fx.repository.repoId,
      requirementId:'REQ-AUTO',
      dependencies:{
        apiKey:'fixture-key',toolDefinitions:[],executeTool:async()=>({}),
        fetchImpl:async()=>response('forge_autopilot_decision',{
          action:'complete',summary:'same run completed after budget refresh',
        }),
      },
    });
    for (let attempt=0;attempt<50;attempt+=1) {
      if (readAutopilotRun(fx.controllerHome,fx.repository.repoId,'REQ-AUTO')?.value.status === 'completed') break;
      await Bun.sleep(10);
    }
    const completed=readAutopilotRun(fx.controllerHome,fx.repository.repoId,'REQ-AUTO')!.value;
    expect(completed.runId).toBe(runId);
    expect(completed.status).toBe('completed');
  });

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

  test('uses the enrolled Responses endpoint, flattens tools, and normalizes provider usage',async() => {
    const fx=fixture('responses');
    const enrolled=authorizeAutopilot({
      controllerHome:fx.controllerHome,
      repoId:fx.repository.repoId,
      requirementId:'REQ-AUTO',
      confirmAuthorization:true,
      policy:{
        endpoint:'https://zro.moonmath.ai/v1',
        protocol:'responses',
        model:'deepseek-v4.1-flash',
        maxTurns:2,
        maxToolCalls:2,
        maxTotalTokens:1000,
      },
    });
    expect(enrolled.grant.constraints).toMatchObject({
      endpoint:'https://zro.moonmath.ai/v1',
      protocol:'responses',
      model:'deepseek-v4.1-flash',
    });
    createAutopilotRun(fx.controllerHome,{
      repoId:fx.repository.repoId,
      checkoutId:enrolled.checkoutId,
      requirementId:'REQ-AUTO',
      requirementRevision:1,
      grantId:enrolled.grant.grantId,
      policy:enrolled.policy,
    });
    let observedUrl='';
    let observedBody:Record<string,unknown>={};
    await runAutopilotLoop(
      fx.controllerHome,fx.repository.repoId,'REQ-AUTO',new AbortController().signal,
      {
        apiKey:'test-key',
        toolDefinitions:executeCommandDefinition,
        executeTool:async()=>({ok:true}),
        validateAuthorization:()=>({ok:true}),
        fetchImpl:async(input,init)=>{
          observedUrl=String(input);
          observedBody=JSON.parse(String(init?.body ?? '{}')) as Record<string,unknown>;
          return responsesResponse('forge_autopilot_decision',{
            action:'complete',
            summary:'Responses provider completed the bounded slice.',
            evidence_refs:['commit:responses'],
          });
        },
      },
    );
    expect(observedUrl).toBe('https://zro.moonmath.ai/v1/responses');
    expect(observedBody.model).toBe('deepseek-v4.1-flash');
    expect(typeof observedBody.instructions).toBe('string');
    expect(Array.isArray(observedBody.input)).toBe(true);
    expect((observedBody.input as Array<Record<string,unknown>>)[0]?.role).toBe('user');
    const tools=observedBody.tools as Array<Record<string,unknown>>;
    expect(tools.some((tool)=>tool.name==='execute_command' && !('function' in tool))).toBe(true);
    const run=readAutopilotRun(fx.controllerHome,fx.repository.repoId,'REQ-AUTO')!.value;
    expect(run.status).toBe('completed');
    expect(run.usage).toMatchObject({promptTokens:17,completionTokens:5,totalTokens:22,turns:1,toolCalls:1});
    expect(run.evidenceRefs).toEqual(['commit:responses']);
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
