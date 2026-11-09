import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
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
  updateAutopilotRun,
} from '../../src/runtime/autopilot/store';
import { autopilotPendingProcess, autopilotTerminalProcessEvidence, runAutopilotLoop } from '../../src/runtime/autopilot/runner';
import type { ProcessHandle } from '../../src/runtime/execution/process-runtime/types';
import { spawnManagedProcess } from '../../src/runtime/execution/process-runtime/runtime';
import { startLightweightRepositoryCommand } from '../../src/runtime/execution/process-runtime/lightweight-managed';
import { executionIdentityForRepository } from '../../src/runtime/control-plane/execution/execution-identity';
import { waitRepositoryCommandProcess } from '../../src/runtime/execution/process-runtime/command-facade';
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
  test('distinguishes accepted Process handles from terminal command evidence',() => {
    expect(autopilotPendingProcess({structuredContent:{accepted:true,status:'running',processId:'proc_test_123',timeoutMs:300_000}}))
      .toEqual({pending:true,processId:'proc_test_123',timeoutMs:300_000});
    expect(autopilotPendingProcess({accepted:true,status:'succeeded',processId:'proc_test_123'}))
      .toEqual({pending:false});
    expect(autopilotPendingProcess({accepted:true,status:'running',processId:'bad-id'}))
      .toEqual({pending:true});
    const lightweightId = 'lightweight:12345678-1234-1234-1234-123456789abc';
    expect(autopilotPendingProcess({structuredContent:{accepted:true,status:'running',processId:lightweightId}}))
      .toEqual({pending:true,processId:lightweightId});
    const terminal = (status:string,completed:boolean,exitCode:number): ProcessHandle => ({
      processId:'proc_test_123',commandId:'test',status:status as ProcessHandle['status'],
      completed,exitCode,ok:status==='succeeded',route:'managed',contractStatus:'succeeded',
      startedAt:'2026-11-09T00:00:00Z',interactiveWaitMs:0,timeoutMs:30_000,
      durableSideEffects:{executionJobCount:0,localJobCount:0,workerSpawnCount:0,projectionUpdateCount:0},
    });
    expect(autopilotTerminalProcessEvidence(terminal('running',false,0))).toBeUndefined();
    expect(autopilotTerminalProcessEvidence(terminal('completed_unknown',true,0))).toBeUndefined();
    expect(autopilotTerminalProcessEvidence(terminal('succeeded',true,0)))?.toMatchObject({
      completed:true,status:'succeeded',ok:true,processId:'proc_test_123',exitCode:0,
    });
    expect(autopilotTerminalProcessEvidence(terminal('failed',true,1)))?.toMatchObject({
      completed:true,status:'failed',ok:false,processId:'proc_test_123',exitCode:1,
    });
  });

  test('pauses on an accepted command with missing Process identity instead of treating it as completed',async() => {
    const fx=fixture('pending-without-identity');
    const enrolled=authorizeAutopilot({controllerHome:fx.controllerHome,repoId:fx.repository.repoId,checkoutId:fx.repository.activeCheckoutId,
      requirementId:'REQ-AUTO',confirmAuthorization:true,policy:{
        provider:'joycode',endpoint:'https://api-ai.jd.com',protocol:'chat_completions',model:'JoyAI-Code-1.6',
        maxTurns:3,maxToolCalls:3,maxTotalTokens:20_000,
      }});
    createAutopilotRun(fx.controllerHome,{
      repoId:fx.repository.repoId,checkoutId:enrolled.checkoutId,
      requirementId:'REQ-AUTO',requirementRevision:1,grantId:enrolled.grant.grantId,policy:enrolled.policy,
    });
    let modelRounds=0;
    await runAutopilotLoop(fx.controllerHome,fx.repository.repoId,'REQ-AUTO',new AbortController().signal,{
      toolDefinitions:executeCommandDefinition,
      executeTool:async()=>({structuredContent:{accepted:true,status:'running'}}),
      validateAuthorization:()=>({ok:true}),
      modelRound:async()=>{
        modelRounds+=1;
        return {choices:[{message:{role:'assistant',content:null,tool_calls:[{
          id:'call-running',type:'function',function:{name:'execute_command',arguments:JSON.stringify({command:['cargo','test']})},
        }]}}],usage:{prompt_tokens:100,completion_tokens:30,total_tokens:130}};
      },
    });
    const run=readAutopilotRun(fx.controllerHome,fx.repository.repoId,'REQ-AUTO')?.value;
    expect(modelRounds).toBe(1);
    expect(run?.status).toBe('paused');
    expect(run?.stopReason).toBe('process_identity_missing');
  });
  test('joins a real managed Process terminal before the model makes a completion decision',async() => {
    const fx=fixture('real-process-join');
    const enrolled=authorizeAutopilot({controllerHome:fx.controllerHome,repoId:fx.repository.repoId,checkoutId:fx.repository.activeCheckoutId,
      requirementId:'REQ-AUTO',confirmAuthorization:true,policy:{
        provider:'joycode',endpoint:'https://api-ai.jd.com',protocol:'chat_completions',model:'JoyAI-Code-1.6',
        maxTurns:3,maxToolCalls:3,maxTotalTokens:20_000,
      }});
    createAutopilotRun(fx.controllerHome,{
      repoId:fx.repository.repoId,checkoutId:enrolled.checkoutId,
      requirementId:'REQ-AUTO',requirementRevision:1,grantId:enrolled.grant.grantId,policy:enrolled.policy,
    });
    let modelRounds=0;
    let acceptedProcessId:string|undefined;
    await runAutopilotLoop(fx.controllerHome,fx.repository.repoId,'REQ-AUTO',new AbortController().signal,{
      toolDefinitions:executeCommandDefinition,
      validateAuthorization:()=>({ok:true}),
      executeTool:async()=>{
        const process=await spawnManagedProcess({
          controllerHome:fx.controllerHome,repoId:fx.repository.repoId,checkoutId:fx.repository.activeCheckoutId,
          executionIdentity:executionIdentityForRepository(fx.repository),
          command:{kind:'argv',executable:'node',
            args:['-e','setTimeout(()=>{process.stdout.write("autopilot-joined");},100)'],
            cwd:fx.repoRoot},
          interactiveWaitMs:0,timeoutMs:15_000,returnHandleImmediately:true,
        });
        acceptedProcessId=process.processId;
        return {structuredContent:{accepted:true,status:'running',processId:process.processId,timeoutMs:process.timeoutMs}};
      },
      modelRound:async(input)=>{
        modelRounds+=1;
        if (modelRounds===2) {
          const messages=input.body.messages as Array<{role:string;content?:string}>;
          const terminal=JSON.parse(messages.find((message)=>message.role==='tool')?.content ?? '{}');
          expect(terminal).toMatchObject({
            processId:acceptedProcessId,completed:true,status:'succeeded',ok:true,exitCode:0,
          });
          expect(terminal.stdoutTail).toContain('autopilot-joined');
        }
        const name=modelRounds===1 ? 'execute_command' : 'forge_autopilot_decision';
        const args=modelRounds===1 ? {command:['node','-e','process.stdout.write("autopilot-joined")']}
          : {action:'complete',summary:'Real Process terminal receipt was observed.'};
        return {choices:[{message:{role:'assistant',content:null,tool_calls:[{
          id:'call-'+modelRounds,type:'function',function:{name,arguments:JSON.stringify(args)},
        }]}}],usage:{prompt_tokens:100,completion_tokens:30,total_tokens:130}};
      },
    });
    expect(modelRounds).toBe(2);
    const run=readAutopilotRun(fx.controllerHome,fx.repository.repoId,'REQ-AUTO')?.value;
    expect(run?.status).toBe('completed');
    expect(run?.usage.toolCalls).toBe(2);
  });

  test('joins a real lightweight repository Process without duplicating the command',async() => {
    const fx=fixture('lightweight-process-join');
    const enrolled=authorizeAutopilot({
      controllerHome:fx.controllerHome,repoId:fx.repository.repoId,checkoutId:fx.repository.activeCheckoutId,
      requirementId:'REQ-AUTO',confirmAuthorization:true,
      policy:{provider:'joycode',endpoint:'https://api-ai.jd.com',protocol:'chat_completions',
        model:'JoyAI-Code-1.6',maxTurns:3,maxToolCalls:3,maxTotalTokens:20_000},
    });
    createAutopilotRun(fx.controllerHome,{
      repoId:fx.repository.repoId,checkoutId:enrolled.checkoutId,
      requirementId:'REQ-AUTO',requirementRevision:1,grantId:enrolled.grant.grantId,policy:enrolled.policy,
    });
    let invoked=0;
    let round=0;
    let processId='';
    await runAutopilotLoop(fx.controllerHome,fx.repository.repoId,'REQ-AUTO',new AbortController().signal,{
      toolDefinitions:executeCommandDefinition,validateAuthorization:()=>({ok:true}),
      executeTool:async()=>{
        invoked+=1;
        const started=await startLightweightRepositoryCommand({
          controllerHome:fx.controllerHome,repository:fx.repository,
          execution:{command:['node','-e','setTimeout(()=>console.log("lightweight-joined"),120)']},
          interactiveWaitMs:0,timeoutMs:15_000,deferStart:true,
        });
        processId=started.handle.processId;
        expect(processId).toStartWith('lightweight:');
        return {structuredContent:{accepted:true,status:'running',processId,timeoutMs:15_000}};
      },
      modelRound:async(input)=>{
        round+=1;
        if(round===2){
          const messages=input.body.messages as Array<{role:string;content?:string}>;
          const terminal=JSON.parse(messages.find((message)=>message.role==='tool')?.content??'{}');
          expect(terminal).toMatchObject({
            processId,completed:true,status:'succeeded',ok:true,exitCode:0,
          });
          expect(terminal.stdoutTail).toContain('lightweight-joined');
          expect(messages.some((message)=>message.role==='tool'
            && message.content?.includes('AUTOPILOT_PROCESS_RESULT_REQUIRES_NEXT_MODEL_ROUND'))).toBe(true);
          expect(readAutopilotRun(fx.controllerHome,fx.repository.repoId,'REQ-AUTO')?.value.pendingProcessId)
            .toBe(processId);
        }
        return {choices:[{message:{
          role:'assistant',content:null,tool_calls:[{
            id:'lightweight-round-'+round,type:'function',function:{
              name:round===1?'execute_command':'forge_autopilot_decision',
              arguments:JSON.stringify(round===1?
                {command:['node','-e','console.log("lightweight-joined")']}:
                {action:'complete',summary:'Canonical lightweight Process terminal confirmed.'}),
            },
          },...(round===1?[{
            id:'later-command-skipped',type:'function',function:{
              name:'execute_command',
              arguments:JSON.stringify({command:['node','-e','console.log("SHOULD_NOT_RUN")']}),
            },
          }]:[])],
        }}],usage:{prompt_tokens:100,completion_tokens:30,total_tokens:130}};
      },
    });
    expect(round).toBe(2);
    expect(invoked).toBe(1);
    expect(readAutopilotRun(fx.controllerHome,fx.repository.repoId,'REQ-AUTO')?.value.status).toBe('completed');
    expect(readAutopilotRun(fx.controllerHome,fx.repository.repoId,'REQ-AUTO')?.value.pendingProcessId).toBeUndefined();
  });

  test('reconciles persisted lightweight Process after interrupted Agent loop without replay',async() => {
    const fx=fixture('interrupted-process-join');
    const enrolled=authorizeAutopilot({
      controllerHome:fx.controllerHome,repoId:fx.repository.repoId,checkoutId:fx.repository.activeCheckoutId,
      requirementId:'REQ-AUTO',confirmAuthorization:true,
      policy:{provider:'joycode',endpoint:'https://api-ai.jd.com',protocol:'chat_completions',
        model:'JoyAI-Code-1.6',maxTurns:3,maxToolCalls:3,maxTotalTokens:20_000},
    });
    createAutopilotRun(fx.controllerHome,{
      repoId:fx.repository.repoId,checkoutId:enrolled.checkoutId,
      requirementId:'REQ-AUTO',requirementRevision:1,grantId:enrolled.grant.grantId,policy:enrolled.policy,
    });
    let invoked=0;
    let processId='';
    const interruption=new AbortController();
    await runAutopilotLoop(fx.controllerHome,fx.repository.repoId,'REQ-AUTO',interruption.signal,{
      toolDefinitions:executeCommandDefinition,validateAuthorization:()=>({ok:true}),
      executeTool:async()=>{
        invoked+=1;
        const started=await startLightweightRepositoryCommand({
          controllerHome:fx.controllerHome,repository:fx.repository,
          execution:{command:['node','-e','setTimeout(()=>console.log("restarted-agent-evidence"),120)']},
          interactiveWaitMs:0,timeoutMs:15_000,deferStart:true,
        });
        processId=started.handle.processId;
        interruption.abort(); // Transport/Agent stops after admission, not the Process.
        return {structuredContent:{accepted:true,status:'running',processId,timeoutMs:15_000}};
      },
      modelRound:async()=>({choices:[{message:{role:'assistant',content:null,tool_calls:[{
        id:'interrupted-command',type:'function',function:{
          name:'execute_command',arguments:JSON.stringify({command:['node','-e','console.log("restarted-agent-evidence")']}),
        },
      }]}}],usage:{prompt_tokens:100,completion_tokens:30,total_tokens:130}}),
    });
    expect(readAutopilotRun(fx.controllerHome,fx.repository.repoId,'REQ-AUTO')?.value.pendingProcessId).toBe(processId);
    expect(readAutopilotRun(fx.controllerHome,fx.repository.repoId,'REQ-AUTO')?.value.status).toBe('running');

    let recoveryRounds=0;
    await runAutopilotLoop(fx.controllerHome,fx.repository.repoId,'REQ-AUTO',new AbortController().signal,{
      toolDefinitions:executeCommandDefinition,validateAuthorization:()=>({ok:true}),
      executeTool:async()=>{ invoked+=1; throw new Error('MUST_NOT_REPLAY_PREVIOUS_COMMAND'); },
      modelRound:async(input)=>{
        recoveryRounds+=1;
        const messages=input.body.messages as Array<{role:string;content?:string}>;
        const receipt=messages.find((message)=>message.content?.includes('Recovered terminal receipt'));
        expect(receipt?.content).toContain(processId);
        expect(receipt?.content).toContain('restarted-agent-evidence');
        expect(receipt?.content).toContain('"status":"succeeded"');
        return {choices:[{message:{role:'assistant',content:null,tool_calls:[{
          id:'recovered-decision',type:'function',function:{
            name:'forge_autopilot_decision',arguments:JSON.stringify({
              action:'complete',summary:'Prior command terminal receipt reconciled from Process authority.',
            }),
          },
        }]}}],usage:{prompt_tokens:100,completion_tokens:30,total_tokens:130}};
      },
    });
    expect(invoked).toBe(1);
    expect(recoveryRounds).toBe(1);
    const completed=readAutopilotRun(fx.controllerHome,fx.repository.repoId,'REQ-AUTO')?.value;
    expect(completed?.status).toBe('completed');
    expect(completed?.pendingProcessId).toBeUndefined();
  });

  test('fails closed on an unavailable persisted Process and does not run model or tools',async() => {
    const fx=fixture('unknown-process-on-resume');
    const enrolled=authorizeAutopilot({
      controllerHome:fx.controllerHome,repoId:fx.repository.repoId,checkoutId:fx.repository.activeCheckoutId,
      requirementId:'REQ-AUTO',confirmAuthorization:true,
      policy:{provider:'joycode',endpoint:'https://api-ai.jd.com',protocol:'chat_completions',
        model:'JoyAI-Code-1.6',maxTurns:3,maxToolCalls:3,maxTotalTokens:20_000},
    });
    createAutopilotRun(fx.controllerHome,{
      repoId:fx.repository.repoId,checkoutId:enrolled.checkoutId,
      requirementId:'REQ-AUTO',requirementRevision:1,grantId:enrolled.grant.grantId,policy:enrolled.policy,
    });
    const missing='lightweight:12345678-1234-1234-1234-123456789abc';
    updateAutopilotRun(fx.controllerHome,fx.repository.repoId,'REQ-AUTO',run=>({
      ...run,pendingProcessId:missing,
    }));
    let calls=0;
    const deps={
      toolDefinitions:executeCommandDefinition,validateAuthorization:()=>({ok:true}),
      executeTool:async()=>{calls+=1;throw new Error('UNEXPECTED_REPLAY');},
      modelRound:async()=>{calls+=1;throw new Error('UNEXPECTED_MODEL_ROUND');},
    };
    await runAutopilotLoop(fx.controllerHome,fx.repository.repoId,'REQ-AUTO',new AbortController().signal,deps);
    const paused=readAutopilotRun(fx.controllerHome,fx.repository.repoId,'REQ-AUTO')?.value;
    expect(calls).toBe(0);
    expect(paused?.status).toBe('paused');
    expect(paused?.stopReason).toBe('process_terminal_unconfirmed:'+missing);
    expect(paused?.pendingProcessId).toBe(missing);
    await runAutopilotLoop(fx.controllerHome,fx.repository.repoId,'REQ-AUTO',new AbortController().signal,deps);
    expect(calls).toBe(0);
  });

  test('persists the request identity before command admission and never replays when its receipt is lost',async() => {
    const fx=fixture('lost-command-receipt');
    const enrolled=authorizeAutopilot({
      controllerHome:fx.controllerHome,repoId:fx.repository.repoId,checkoutId:fx.repository.activeCheckoutId,
      requirementId:'REQ-AUTO',confirmAuthorization:true,
      policy:{provider:'joycode',endpoint:'https://api-ai.jd.com',protocol:'chat_completions',
        model:'JoyAI-Code-1.6',maxTurns:3,maxToolCalls:3,maxTotalTokens:20_000},
    });
    createAutopilotRun(fx.controllerHome,{
      repoId:fx.repository.repoId,checkoutId:enrolled.checkoutId,
      requirementId:'REQ-AUTO',requirementRevision:1,grantId:enrolled.grant.grantId,policy:enrolled.policy,
    });
    const command=['node','-e',"require('fs').appendFileSync('once.txt','x')"];
    let admittedProcessId='';
    let admittedRequestId='';
    let toolCalls=0;
    const firstModel=async()=>({choices:[{message:{role:'assistant',content:null,tool_calls:[{
      id:'lost-command',type:'function',function:{name:'execute_command',arguments:JSON.stringify({command})},
    }]}}],usage:{prompt_tokens:100,completion_tokens:30,total_tokens:130}});
    await expect(runAutopilotLoop(
      fx.controllerHome,fx.repository.repoId,'REQ-AUTO',new AbortController().signal,{
        toolDefinitions:executeCommandDefinition,validateAuthorization:()=>({ok:true}),modelRound:firstModel,
        executeTool:async(name,args)=>{
          expect(name).toBe('execute_command');
          toolCalls+=1;
          admittedRequestId=String(args.request_id??'');
          expect(admittedRequestId).toStartWith('autopilot_');
          expect(readAutopilotRun(fx.controllerHome,fx.repository.repoId,'REQ-AUTO')?.value.pendingCommandRequestId)
            .toBe(admittedRequestId);
          const started=await startLightweightRepositoryCommand({
            controllerHome:fx.controllerHome,repository:fx.repository,
            execution:{command},commandId:admittedRequestId,
            interactiveWaitMs:0,timeoutMs:15_000,deferStart:true,
          });
          admittedProcessId=started.handle.processId;
          throw new Error('SIMULATED_TOOL_RESPONSE_LOST_AFTER_ADMISSION');
        },
      }
    )).rejects.toThrow('SIMULATED_TOOL_RESPONSE_LOST_AFTER_ADMISSION');
    const interrupted=readAutopilotRun(fx.controllerHome,fx.repository.repoId,'REQ-AUTO')?.value;
    expect(interrupted?.pendingCommandRequestId).toBe(admittedRequestId);
    expect(interrupted?.pendingProcessId).toBeUndefined();
    expect(interrupted?.status).toBe('running');

    let restartedModelCalls=0;
    await runAutopilotLoop(fx.controllerHome,fx.repository.repoId,'REQ-AUTO',new AbortController().signal,{
      toolDefinitions:executeCommandDefinition,validateAuthorization:()=>({ok:true}),
      modelRound:async()=>{restartedModelCalls+=1;throw new Error('RESTART_MUST_NOT_INVOKE_MODEL');},
      executeTool:async()=>{toolCalls+=1;throw new Error('RESTART_MUST_NOT_INVOKE_TOOL');},
    });
    const halted=readAutopilotRun(fx.controllerHome,fx.repository.repoId,'REQ-AUTO')?.value;
    expect(halted?.status).toBe('paused');
    expect(halted?.stopReason).toBe('process_admission_unconfirmed:'+admittedRequestId);
    expect(toolCalls).toBe(1);
    expect(restartedModelCalls).toBe(0);
    const original=await waitRepositoryCommandProcess(fx.controllerHome,fx.repository.repoId,admittedProcessId,{timeoutMs:5_000});
    expect(original).toMatchObject({completed:true,status:'succeeded',ok:true,exitCode:0});
    expect(readFileSync(join(fx.repoRoot,'once.txt'),'utf8')).toBe('x');
    // Canonical Process Runtime must also bind the same request/command identity
    // back to the original receipt, never start a second physical command.
    const retried=await startLightweightRepositoryCommand({
      controllerHome:fx.controllerHome,repository:fx.repository,
      execution:{command},commandId:admittedRequestId,
      interactiveWaitMs:0,timeoutMs:15_000,deferStart:true,
    });
    expect(retried.handle.processId).toBe(admittedProcessId);
    expect(readFileSync(join(fx.repoRoot,'once.txt'),'utf8')).toBe('x');
  });

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
      repoId:fx.repository.repoId,checkoutId:fx.repository.activeCheckoutId,
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
      repoId:fx.repository.repoId,checkoutId:fx.repository.activeCheckoutId,
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

  test('normalizes JoyCode argv strings and stops repeated read-only exploration after six calls',async() => {
    const fx=fixture('inspection-guard');
    const enrolled=authorizeAutopilot({
      controllerHome:fx.controllerHome,
      repoId:fx.repository.repoId,checkoutId:fx.repository.activeCheckoutId,
      requirementId:'REQ-AUTO',
      confirmAuthorization:true,
      policy:{
        provider:'joycode',
        endpoint:'https://api-ai.jd.com',
        protocol:'chat_completions',
        model:'JoyAI-Code-1.6',
        maxTurns:10,
        maxToolCalls:12,
        maxTotalTokens:20_000,
      },
    });
    createAutopilotRun(fx.controllerHome,{
      repoId:fx.repository.repoId,
      checkoutId:enrolled.checkoutId,
      requirementId:'REQ-AUTO',
      requirementRevision:1,
      grantId:enrolled.grant.grantId,
      policy:enrolled.policy,
    });
    const observedCommands:unknown[]=[];
    let round=0;
    await runAutopilotLoop(
      fx.controllerHome,fx.repository.repoId,'REQ-AUTO',new AbortController().signal,
      {
        toolDefinitions:executeCommandDefinition,
        validateAuthorization:()=>({ok:true}),
        executeTool:async(_name,args)=>{
          observedCommands.push(args.command);
          return {ok:true};
        },
        modelRound:async()=>{
          round+=1;
          const decision=round >= 8;
          return {
            choices:[{message:{
              role:'assistant',
              content:null,
              tool_calls:[{
                id:'guard-'+round,
                type:'function',
                function:{
                  name:decision ? 'forge_autopilot_decision' : 'execute_command',
                  arguments:JSON.stringify(decision
                    ? {action:'complete',summary:'inspection guard converged'}
                    : {command:JSON.stringify(['git','status','--short'])}),
                },
              }],
            }}],
            usage:{prompt_tokens:100,completion_tokens:20,total_tokens:120},
          };
        },
      },
    );
    expect(observedCommands).toHaveLength(6);
    expect(observedCommands[0]).toEqual(['git','status','--short']);
    const run=readAutopilotRun(fx.controllerHome,fx.repository.repoId,'REQ-AUTO')!.value;
    expect(run.status).toBe('completed');
    expect(run.inspectionStreak).toBe(0);
    expect(run.recentToolNames).toContain('execute_command:inspection_blocked');
    expect(run.recentToolNames?.at(-1)).toBe('forge_autopilot_decision');
  });

  test('reauthorizes a budget-paused run in place and preserves its lifecycle identity',async() => {
    const fx=fixture('budget-refresh');
    const first=authorizeAutopilot({
      controllerHome:fx.controllerHome,
      repoId:fx.repository.repoId,checkoutId:fx.repository.activeCheckoutId,
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
      repoId:fx.repository.repoId,checkoutId:fx.repository.activeCheckoutId,
      requirementId:'REQ-AUTO',
      confirmAuthorization:true,
      policy:{maxTotalTokens:4_000,maxTurns:6,maxToolCalls:8},
    });
    const refreshed=readAutopilotRun(fx.controllerHome,fx.repository.repoId,'REQ-AUTO')!.value;
    expect(refreshed.runId).toBe(runId);
    expect(refreshed.grantId).toBe(second.grant.grantId);
    expect(refreshed.usage).toEqual(usage);
    expect(refreshed.policy.maxTotalTokens).toBe(4_000);
    expect(refreshed.budgetBaseline).toEqual({
      totalTokens: usage.totalTokens,
      turns: usage.turns,
      toolCalls: usage.toolCalls,
    });
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

  test('opens a new bounded budget window even when lifetime usage exceeds the policy hard caps',async() => {
    const fx=fixture('budget-window');
    const first=authorizeAutopilot({
      controllerHome:fx.controllerHome,
      repoId:fx.repository.repoId,checkoutId:fx.repository.activeCheckoutId,
      requirementId:'REQ-AUTO',
      confirmAuthorization:true,
      policy:{maxTotalTokens:500_000,maxTurns:48,maxToolCalls:128},
    });
    createAutopilotRun(fx.controllerHome,{
      repoId:fx.repository.repoId,
      checkoutId:first.checkoutId,
      requirementId:'REQ-AUTO',
      requirementRevision:1,
      grantId:first.grant.grantId,
      policy:first.policy,
    });
    updateAutopilotRun(fx.controllerHome,fx.repository.repoId,'REQ-AUTO',(run)=>({
      ...run,
      status:'paused',
      stopReason:'max_total_tokens_reached',
      usage:{promptTokens:610_000,completionTokens:15_000,totalTokens:625_000,turns:61,toolCalls:151},
    }),'test_budget_window_fixture');
    const runId=readAutopilotRun(fx.controllerHome,fx.repository.repoId,'REQ-AUTO')!.value.runId;
    const second=authorizeAutopilot({
      controllerHome:fx.controllerHome,
      repoId:fx.repository.repoId,checkoutId:fx.repository.activeCheckoutId,
      requirementId:'REQ-AUTO',
      confirmAuthorization:true,
      policy:{maxTotalTokens:500_000,maxTurns:48,maxToolCalls:128},
    });
    const refreshed=readAutopilotRun(fx.controllerHome,fx.repository.repoId,'REQ-AUTO')!.value;
    expect(refreshed.runId).toBe(runId);
    expect(refreshed.grantId).toBe(second.grant.grantId);
    expect(refreshed.budgetBaseline).toEqual({totalTokens:625_000,turns:61,toolCalls:151});
    expect(refreshed.usage.totalTokens).toBe(625_000);

    resumeAutopilot({
      controllerHome:fx.controllerHome,
      repoId:fx.repository.repoId,
      requirementId:'REQ-AUTO',
      dependencies:{
        apiKey:'fixture-key',toolDefinitions:[],executeTool:async()=>({}),
        fetchImpl:async()=>response('forge_autopilot_decision',{
          action:'complete',summary:'new budget window completed',
        },{prompt_tokens:100,completion_tokens:20,total_tokens:120}),
      },
    });
    for (let attempt=0;attempt<50;attempt+=1) {
      if (readAutopilotRun(fx.controllerHome,fx.repository.repoId,'REQ-AUTO')?.value.status === 'completed') break;
      await Bun.sleep(10);
    }
    const completed=readAutopilotRun(fx.controllerHome,fx.repository.repoId,'REQ-AUTO')!.value;
    expect(completed.runId).toBe(runId);
    expect(completed.status).toBe('completed');
    expect(completed.usage.totalTokens).toBe(625_120);
  });

  test('requires explicit authorization, binds the exact Requirement revision, and replaces prior grants',() => {
    const fx=fixture('authorization');
    expect(() => authorizeAutopilot({
      controllerHome:fx.controllerHome,
      repoId:fx.repository.repoId,checkoutId:fx.repository.activeCheckoutId,
      requirementId:'REQ-AUTO',
      confirmAuthorization:false,
    })).toThrow('AUTOPILOT_AUTHORIZATION_CONFIRMATION_REQUIRED');

    const first=authorizeAutopilot({
      controllerHome:fx.controllerHome,
      repoId:fx.repository.repoId,checkoutId:fx.repository.activeCheckoutId,
      requirementId:'REQ-AUTO',
      confirmAuthorization:true,
      policy:{maxTotalTokens:12_000,maxTurns:4,maxToolCalls:6},
    });
    expect(first.grant.constraints?.requirementRevision).toBe(1);
    expect(first.grant.riskCeiling).toBe('workspace_write');

    const second=authorizeAutopilot({
      controllerHome:fx.controllerHome,
      repoId:fx.repository.repoId,checkoutId:fx.repository.activeCheckoutId,
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
      repoId:fx.repository.repoId,checkoutId:fx.repository.activeCheckoutId,
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
      repoId:fx.repository.repoId,checkoutId:fx.repository.activeCheckoutId,
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
      repoId:fx.repository.repoId,checkoutId:fx.repository.activeCheckoutId,
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
      repoId:fx.repository.repoId,checkoutId:fx.repository.activeCheckoutId,
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
      repoId:fx.repository.repoId,checkoutId:fx.repository.activeCheckoutId,
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
    expect(run.usage.toolCalls).toBe(2);
  });
});
