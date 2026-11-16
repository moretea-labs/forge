import type { WorkflowAssetDraft } from '../../../../packages/workflow-runtime/api/index';
import { writeWorkflowAssetContent } from '../../control-plane/persistence/workflow-content-store';
import {
  readWorkflowRegistryEntry,
  recordWorkflowBindings,
  registerWorkflowAsset,
} from '../../control-plane/persistence/workflow-registry-store';

export const AGENTMAIL_EVENT_WORKFLOW_ID = 'agentmail.mail-watch-event';

const DRAFT: WorkflowAssetDraft = {
  schemaVersion: 1,
  workflowId: AGENTMAIL_EVENT_WORKFLOW_ID,
  version: '1',
  title: 'AgentMail Watch event receipt',
  description: 'Persist a minimal, replay-safe email event receipt in the canonical WorkflowRun store. Message bodies and credentials are not accepted.',
  inputContract: {
    source: { type: 'string', required: true },
    event_id: { type: 'string', required: true },
    observed_at: { type: 'string', required: true },
    rule_id: { type: 'string', required: true },
    provider_message_id: { type: 'string', required: true },
    sender_email: { type: 'string', default: '' },
  },
  steps: [{
    kind: 'script',
    stepId: 'validate-event',
    scriptRef: 'validateEvent',
    input: {
      source: '{{input.source}}',
      event_id: '{{input.event_id}}',
      observed_at: '{{input.observed_at}}',
      rule_id: '{{input.rule_id}}',
      provider_message_id: '{{input.provider_message_id}}',
      sender_email: '{{input.sender_email}}',
    },
    outputContract: {
      source: { type: 'string', required: true },
      event_id: { type: 'string', required: true },
      observed_at: { type: 'string', required: true },
      rule_id: { type: 'string', required: true },
      provider_message_id: { type: 'string', required: true },
      sender_email: { type: 'string' },
    },
  }],
  scripts: {
    validateEvent: {
      runtime: 'node',
      deterministic: true,
      outputFormat: 'json',
      body: `const a=JSON.parse(process.argv[1]||'{}');
const required=['source','event_id','observed_at','rule_id','provider_message_id'];
for(const key of required){if(typeof a[key]!=='string'||!a[key].trim())process.exit(2)}
if(a.source!=='agentmail'||a.event_id.length>512||a.provider_message_id.length>1024)process.exit(2);
if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(a.rule_id))process.exit(2);
if(!Number.isFinite(Date.parse(a.observed_at)))process.exit(2);
if(a.sender_email!==undefined&&(typeof a.sender_email!=='string'||a.sender_email.length>320))process.exit(2);
const output={source:a.source,event_id:a.event_id,observed_at:a.observed_at,rule_id:a.rule_id,provider_message_id:a.provider_message_id};
if(a.sender_email!==undefined)output.sender_email=a.sender_email;
process.stdout.write(JSON.stringify(output));`,
    },
  },
};

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
