import { describe, expect, test } from 'bun:test';
import { materializeWorkflowGraphAsset, validateWorkflowGraphAsset, workflowGraphContentDigest, type WorkflowGraphAssetDraft } from '../../packages/workflow-runtime/api/index';

function graph(overrides:Partial<WorkflowGraphAssetDraft>={}):WorkflowGraphAssetDraft{return{schemaVersion:2,workflowId:'mail.followup.v2',version:'1',entryNodeId:'start',inputContract:{message_id:{type:'string',required:true}},nodes:[
 {kind:'capability',nodeId:'start',capabilityId:'mail.inspect',idempotency:'idempotent'},
 {kind:'capability',nodeId:'notify',capabilityId:'owner.notification',idempotency:'non_idempotent',reconcileWithCapabilityId:'owner.notification.lookup'},
 {kind:'workflow',nodeId:'child',workflowId:'asc.case.followup'},
 {kind:'join',nodeId:'join',policy:'all'},
 {kind:'wait_event',nodeId:'wait',sources:['agentmail.watch'],eventTypes:['mail.watch.matched'],correlation:{kind:'input',name:'message_id'},timeoutMs:3600000},
 {kind:'approval',nodeId:'approve',approvalKey:'mail-reply',prompt:'Approve sending the prepared reply?',timeoutMs:86400000},
 ],edges:[
 {edgeId:'e1',from:'start',to:'notify',on:'success'},
 {edgeId:'e2',from:'start',to:'child',on:'success'},
 {edgeId:'e3',from:'notify',to:'join',on:'success'},
 {edgeId:'e4',from:'child',to:'join',on:'success'},
 {edgeId:'e5',from:'join',to:'wait',on:'success'},
 {edgeId:'e6',from:'wait',to:'approve',on:'success'},
 ],...overrides};}

describe('Workflow Graph v2 contract',()=>{
 test('materializes a graph with parallel fan-out/join, wait_event, approval and child workflow',()=>{const asset=materializeWorkflowGraphAsset(graph());expect(asset.schemaVersion).toBe(2);expect(asset.contentDigest).toMatch(/^sha256:[a-f0-9]{64}$/);expect(asset.nodes.find(n=>n.nodeId==='join')).toMatchObject({kind:'join',policy:'all'});expect(asset.nodes.find(n=>n.nodeId==='wait')).toMatchObject({kind:'wait_event',timeoutMs:3600000});});
 test('supports deterministic branch edges with one default path',()=>{const draft=graph({nodes:[{kind:'branch',nodeId:'start'},{kind:'capability',nodeId:'apple',capabilityId:'mail.apple'},{kind:'capability',nodeId:'other',capabilityId:'mail.other'}],edges:[{edgeId:'apple',from:'start',to:'apple',on:'condition',condition:{kind:'compare',operator:'equals',left:{kind:'input',name:'message_id'},right:{kind:'literal',value:'apple'}}},{edgeId:'default',from:'start',to:'other',on:'default'}]});expect(materializeWorkflowGraphAsset(draft).edges).toHaveLength(2);});
 test('rejects cycles and unreachable nodes instead of creating implicit loops',()=>{const cyclic=materializeWorkflowGraphAsset(graph());const raw={...cyclic,edges:[...cyclic.edges,{edgeId:'cycle',from:'approve',to:'start',on:'success' as const}]};raw.contentDigest=workflowGraphContentDigest(raw);expect(()=>validateWorkflowGraphAsset(raw)).toThrow('WORKFLOW_GRAPH_CYCLE_FORBIDDEN');const draft=graph({nodes:[...graph().nodes,{kind:'capability',nodeId:'orphan',capabilityId:'x'}]});expect(()=>materializeWorkflowGraphAsset(draft)).toThrow('WORKFLOW_GRAPH_NODE_UNREACHABLE:orphan');});
 test('rejects malformed branch and incomplete joins',()=>{const badBranch=graph({nodes:[{kind:'branch',nodeId:'start'},{kind:'capability',nodeId:'a',capabilityId:'a'}],edges:[{edgeId:'only',from:'start',to:'a',on:'default'}]});expect(()=>materializeWorkflowGraphAsset(badBranch)).toThrow('WORKFLOW_GRAPH_BRANCH_EDGES_INVALID:start');const badJoin=graph({nodes:[{kind:'capability',nodeId:'start',capabilityId:'a'},{kind:'join',nodeId:'join',policy:'all'}],edges:[{edgeId:'one',from:'start',to:'join',on:'success'}]});expect(()=>materializeWorkflowGraphAsset(badJoin)).toThrow('WORKFLOW_GRAPH_JOIN_INPUTS_INSUFFICIENT:join');});
 test('requires reconciliation for non-idempotent effects and excludes outcome_unknown from retry classes',()=>{const unsafe=graph({nodes:[{kind:'capability',nodeId:'start',capabilityId:'mail.send',idempotency:'non_idempotent'}],edges:[]});expect(()=>materializeWorkflowGraphAsset(unsafe)).toThrow('WORKFLOW_GRAPH_NON_IDEMPOTENT_RECONCILIATION_REQUIRED');const retry=graph({nodes:[{kind:'capability',nodeId:'start',capabilityId:'mail.read',retry:{maxAttempts:2,strategy:'fixed',initialDelayMs:100,maxDelayMs:100,retryOn:['outcome_unknown' as never]}}],edges:[]});expect(()=>materializeWorkflowGraphAsset(retry)).toThrow('WORKFLOW_GRAPH_RETRY_CLASSES_INVALID');});
 test('validates quorum and mandatory wait/approval timeouts',()=>{const quorum=graph({nodes:[{kind:'capability',nodeId:'start',capabilityId:'a'},{kind:'capability',nodeId:'b',capabilityId:'b'},{kind:'join',nodeId:'join',policy:'quorum',quorum:3}],edges:[{edgeId:'s-b',from:'start',to:'b',on:'success'},{edgeId:'s-j',from:'start',to:'join',on:'success'},{edgeId:'b-j',from:'b',to:'join',on:'success'}]});expect(()=>materializeWorkflowGraphAsset(quorum)).toThrow('WORKFLOW_GRAPH_JOIN_QUORUM_EXCEEDS_INPUTS:join');const wait=graph({nodes:[{kind:'wait_event',nodeId:'start',sources:['mail'],correlation:{kind:'literal',value:'x'}}],edges:[]});expect(()=>materializeWorkflowGraphAsset(wait)).toThrow('WORKFLOW_GRAPH_WAIT_TIMEOUT_REQUIRED');});
});
