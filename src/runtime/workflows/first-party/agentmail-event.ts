import {
  materializeWorkflowAsset,
  type WorkflowAssetDefinition,
  type WorkflowAssetDraft,
} from '../../../../packages/workflow-runtime/api/index';
import { writeWorkflowAssetContent } from '../../control-plane/persistence/workflow-content-store';
import {
  readWorkflowRegistryEntry,
  recordWorkflowBindings,
  registerWorkflowAsset,
} from '../../control-plane/persistence/workflow-registry-store';

export const AGENTMAIL_EVENT_WORKFLOW_ID = 'agentmail.mail-watch-event';

/**
 * Canonical App Store Connect routing owner for AgentMail Case events.
 * Events must carry an explicit app_id; never infer a target from mail content,
 * sender, rule, or account identity.
 */
export const AGENTMAIL_APP_CASE_BINDINGS = [
  { appId: '6771288893', caseId: '30000012066543' },
  { appId: '6831952477', caseId: '30000012078130' },
  { appId: '6796884084', caseId: '30000015896615' },
] as const;

export interface AgentMailAppCaseBinding {
  readonly appId: string;
  readonly caseId: string;
}

export interface AgentMailAppCaseRoute {
  app_id: string;
  case_id: string;
}

/** Resolve one explicit App ID to its unique canonical Case ID; reject unknown or ambiguous maps. */
export function resolveAgentMailAppCaseRoute(
  appId: string,
  bindings: readonly AgentMailAppCaseBinding[] = AGENTMAIL_APP_CASE_BINDINGS,
): AgentMailAppCaseRoute {
  if (!/^\d{10}$/.test(appId)) throw new Error('AGENTMAIL_APP_ID_INVALID');

  const appIDs = new Set<string>();
  const caseIDs = new Set<string>();
  for (const binding of bindings) {
    if (!/^\d{10}$/.test(binding.appId) || !/^\d{14}$/.test(binding.caseId)) {
      throw new Error('AGENTMAIL_APP_CASE_BINDING_INVALID');
    }
    if (appIDs.has(binding.appId) || caseIDs.has(binding.caseId)) {
      throw new Error('AGENTMAIL_APP_CASE_BINDING_AMBIGUOUS');
    }
    appIDs.add(binding.appId);
    caseIDs.add(binding.caseId);
  }

  const matches = bindings.filter((binding) => binding.appId === appId);
  if (matches.length === 0) throw new Error('AGENTMAIL_APP_CASE_BINDING_UNKNOWN');
  if (matches.length !== 1) throw new Error('AGENTMAIL_APP_CASE_BINDING_AMBIGUOUS');

  return { app_id: matches[0]!.appId, case_id: matches[0]!.caseId };
}

const appCaseBindingsForScript = JSON.stringify(
  AGENTMAIL_APP_CASE_BINDINGS.map(({ appId, caseId }) => ({ app_id: appId, case_id: caseId })),
);

const DRAFT: WorkflowAssetDraft = {
  schemaVersion: 1,
  workflowId: AGENTMAIL_EVENT_WORKFLOW_ID,
  version: '4',
  title: 'AgentMail Watch event receipt',
  description:
    'Persist a replay-safe AgentMail event receipt with a validated transport-neutral Event Envelope and resolve optional explicit App IDs through canonical App-to-Case bindings. Message bodies and credentials are not accepted.',
  inputContract: {
    source: { type: 'string', required: true },
    event_id: { type: 'string', required: true },
    observed_at: { type: 'string', required: true },
    ref: { type: 'json', required: true },
    summary: { type: 'json', required: true },
    event_envelope: { type: 'json', required: true },
    route: { type: 'json', default: null },
  },
  steps: [
    {
      kind: 'script',
      stepId: 'validate-event',
      scriptRef: 'validateEvent',
      input: {
        source: '{{input.source}}',
        event_id: '{{input.event_id}}',
        observed_at: '{{input.observed_at}}',
        ref: '{{input.ref}}',
        summary: '{{input.summary}}',
        event_envelope: '{{input.event_envelope}}',
        route: '{{input.route}}',
      },
      outputContract: {
        source: { type: 'string', required: true },
        event_id: { type: 'string', required: true },
        observed_at: { type: 'string', required: true },
        ref: { type: 'json', required: true },
        summary: { type: 'json', required: true },
        event_envelope: { type: 'json', required: true },
        route: { type: 'json', required: false },
      },
    },
  ],
  scripts: {
    validateEvent: {
      runtime: 'node',
      deterministic: true,
      outputFormat: 'json',
      body: [
        "const a=JSON.parse(process.argv[1]||'{}');",
        `const bindings=${appCaseBindingsForScript};`,
        'const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;',
        "const text=(v,max,empty=false)=>typeof v==='string'&&v.length<=max&&(empty||v.length>0);",
        "const record=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);",
        'const exactKeys=(v,keys)=>{const actual=Object.keys(v).sort(),expected=[...keys].sort();return actual.length===expected.length&&actual.every((key,index)=>key===expected[index])};',
        "const sha256=value=>require('crypto').createHash('sha256').update(value).digest('hex');",
        "if(a.source!=='mail.watch.matched'||!text(a.event_id,4096)||!text(a.observed_at,64)||!Number.isFinite(Date.parse(a.observed_at)))process.exit(2);",
        "if(!record(a.ref)||!exactKeys(a.ref,['provider','account_id','provider_message_id']))process.exit(2);",
        "if(a.ref.provider!=='agentmail'||!uuid.test(a.ref.account_id)||!text(a.ref.provider_message_id,1024))process.exit(2);",
        "if(!record(a.summary)||!exactKeys(a.summary,['rule_id','sender_email']))process.exit(2);",
        'if(!uuid.test(a.summary.rule_id)||!text(a.summary.sender_email,320,true))process.exit(2);',
        'const e=a.event_envelope;',
        "if(!record(e)||!exactKeys(e,['schemaVersion','eventId','source','provider','eventType','occurredAt','receivedAt','scope','subject','idempotencyKey','payloadRef'])||e.schemaVersion!==1||e.eventId!==a.event_id||e.source!=='agentmail.watch'||e.provider!=='agentmail'||e.eventType!==a.source||e.occurredAt!==a.observed_at||e.receivedAt!==a.observed_at||e.idempotencyKey!==sha256(a.event_id))process.exit(5);",
        "if(!record(e.scope)||!exactKeys(e.scope,['kind','id'])||e.scope.kind!=='account'||e.scope.id!==a.ref.account_id)process.exit(5);",
        "if(!record(e.subject)||!exactKeys(e.subject,['kind','id'])||e.subject.kind!=='mail.message'||e.subject.id!==a.ref.provider_message_id)process.exit(5);",
        'const eventPayload=JSON.stringify({source:a.source,event_id:a.event_id,observed_at:a.observed_at,ref:{provider:a.ref.provider,account_id:a.ref.account_id,provider_message_id:a.ref.provider_message_id},summary:{rule_id:a.summary.rule_id,sender_email:a.summary.sender_email}});',
        "const eventReference=Buffer.from(a.event_id,'utf8').toString('base64url');",
        "if(!record(e.payloadRef)||!exactKeys(e.payloadRef,['store','key','mediaType','schemaVersion','digest'])||e.payloadRef.store!=='provider'||e.payloadRef.key!=='agentmail://watch-events/'+eventReference||e.payloadRef.mediaType!=='application/json'||e.payloadRef.schemaVersion!==1)process.exit(5);",
        "if(!record(e.payloadRef.digest)||!exactKeys(e.payloadRef.digest,['algorithm','value','bytes'])||e.payloadRef.digest.algorithm!=='sha256'||e.payloadRef.digest.value!==sha256(eventPayload)||e.payloadRef.digest.bytes!==Buffer.byteLength(eventPayload,'utf8'))process.exit(5);",
        'let route;',
        'if(a.route!==undefined&&a.route!==null){',
        "if(!record(a.route)||!exactKeys(a.route,['app_id','case_id'])||!text(a.route.app_id,10)||!/^[0-9]{10}$/.test(a.route.app_id)||!text(a.route.case_id,14)||!/^[0-9]{14}$/.test(a.route.case_id))process.exit(2);",
        'if(new Set(bindings.map(binding=>binding.app_id)).size!==bindings.length||new Set(bindings.map(binding=>binding.case_id)).size!==bindings.length)process.exit(4);',
        'const matches=bindings.filter(binding=>binding.app_id===a.route.app_id);',
        'if(matches.length===0)process.exit(3);',
        'if(matches.length!==1||matches[0].case_id!==a.route.case_id||bindings.filter(binding=>binding.case_id===a.route.case_id).length!==1)process.exit(4);',
        'route={app_id:matches[0].app_id,case_id:matches[0].case_id};',
        '}',
        'const output={source:a.source,event_id:a.event_id,observed_at:a.observed_at,ref:{provider:a.ref.provider,account_id:a.ref.account_id,provider_message_id:a.ref.provider_message_id},summary:{rule_id:a.summary.rule_id,sender_email:a.summary.sender_email},event_envelope:e};',
        'if(route)output.route=route;',
        'process.stdout.write(JSON.stringify(output));',
      ].join('\n'),
    },
  },
};

export function materializedAgentMailEventWorkflow(): WorkflowAssetDefinition {
  return materializeWorkflowAsset(DRAFT);
}

export function ensureAgentMailEventWorkflowInstalled(controllerHome: string) {
  const draft = structuredClone(DRAFT);
  const written = writeWorkflowAssetContent({ kind: 'controller', controllerHome }, draft);
  const scope = { kind: 'controller' } as const;
  const existing = readWorkflowRegistryEntry(controllerHome, scope, AGENTMAIL_EVENT_WORKFLOW_ID);
  const registered = registerWorkflowAsset({
    controllerHome,
    scope,
    asset: written.asset,
    contentLocation: { kind: 'controller', path: written.path },
    status: 'active',
    expectedRevision: existing?.revision ?? null,
  });
  return recordWorkflowBindings({
    controllerHome,
    scope,
    expectedIdentity: written.asset,
    bindings: [],
    expectedRevision: registered.revision,
  });
}
