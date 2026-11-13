import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { executeWorkflow, validateWorkflowRunInputs, workflowCapabilityDependencies } from '../../packages/workflow-runtime/api/index';
import {
  ensureReleaseGrowthWorkflowInstalled,
  materializedReleaseGrowthWorkflow,
  RELEASE_GROWTH_WORKFLOW_IDS,
} from '../../src/runtime/workflows/first-party/release-growth';

const homes: string[] = [];
afterEach(() => { while (homes.length) rmSync(homes.pop()!, { recursive: true, force: true }); });

function script(workflowId: string, scriptId: string, input: Record<string, unknown>) {
  const asset = materializedReleaseGrowthWorkflow(workflowId);
  const body = asset.scripts?.[scriptId]?.body;
  if (!body) throw new Error('SCRIPT_MISSING');
  const run = Bun.spawnSync(['node', '-e', body, JSON.stringify(input)], { stdout: 'pipe', stderr: 'pipe' });
  return { status: run.exitCode, output: new TextDecoder().decode(run.stdout),
    error: new TextDecoder().decode(run.stderr) };
}

describe('first-party release and growth Workflow assets (#652)', () => {
  test('authored assets install in existing Workflow registry; only supported read-only plugin capabilities are bound', () => {
    const controllerHome = mkdtempSync(join(tmpdir(), 'forge-release-growth-workflows-'));
    homes.push(controllerHome);
    for (const workflowId of Object.values(RELEASE_GROWTH_WORKFLOW_IDS)) {
      const asset = materializedReleaseGrowthWorkflow(workflowId);
      const installed = ensureReleaseGrowthWorkflowInstalled(controllerHome, workflowId);
      expect(installed.value.contentDigest).toBe(asset.contentDigest);
      expect(installed.value.bindings.map(binding => binding.capabilityId).sort()).toEqual(workflowCapabilityDependencies(asset));
      expect(installed.value.bindings.every(b => b.pluginId === 'browser' || b.pluginId === 'app_store_connect')).toBe(true);
      expect(installed.value.bindings.every(b => b.pluginId !== 'app_store_connect' || b.actionId === 'list_app_store_versions')).toBe(true);
      expect(asset.steps.every(step => step.idempotency !== 'non_idempotent')).toBe(true);
      expect(asset.publication).toBeUndefined();
      expect(asset.credentialRefs).toBeUndefined();
      const repeated = ensureReleaseGrowthWorkflowInstalled(controllerHome, workflowId);
      expect(repeated.value.contentDigest).toBe(asset.contentDigest);
      expect(repeated.value.bindings).toEqual(installed.value.bindings);
    }
  });

  test('changing App ID is just an input binding; country availability is separate from version approval', () => {
    const id = RELEASE_GROWTH_WORKFLOW_IDS.releaseObservation;
    const asset = materializedReleaseGrowthWorkflow(id);
    const a = validateWorkflowRunInputs(asset, { app_id: '6831952477', session_id: 'session-1' });
    const b = validateWorkflowRunInputs(asset, { app_id: '6796884084', session_id: 'session-1' });
    expect(a.app_id).not.toBe(b.app_id);
    expect(asset.steps.some(s => s.kind !== 'script' && s.capabilityId === 'asc.list_app_store_versions')).toBe(true);
    expect(asset.steps.some(s => s.kind !== 'script' && s.capabilityId === 'browser.query_all')).toBe(true);
    expect(asset.steps.some(s => s.stepId === 'classify-cn')).toBe(true);
    expect(script(id, 'validateAppId', { app_id: '6831952477' }).status).toBe(0);
    expect(script(id, 'validateAppId', { app_id: 'not-an-id' }).status).not.toBe(0);
    for (const [state, next] of [
      ['READY_FOR_DISTRIBUTION', 'verify_territories'],
      ['IN_REVIEW', 'await_or_inspect_review'],
      ['REJECTED', 'prepare_correction'],
    ]) {
      const classified = script(id, 'classifyVersion', { versions: [{ attributes: { appVersionState: state } }] });
      expect(classified.status).toBe(0);
      expect(JSON.parse(classified.output)).toEqual({ state, next_action: next });
    }
    const ambiguousVersion = script(id, 'classifyVersion', {
      versions: [{ attributes: { appVersionState: 'READY_FOR_DISTRIBUTION' } },
        { attributes: { appVersionState: 'IN_REVIEW' } }],
    });
    expect(JSON.parse(ambiguousVersion.output)).toEqual({ state: 'unknown', next_action: 'inspect_version' });
    expect(script(id, 'classifyVersion', { versions: 'untrusted' }).status).not.toBe(0);
    for (const [visible, expected] of [
      ['中国大陆\\n可供应', 'available'],
      ['中国大陆\\n正在处理为可用', 'processing'],
      ['中国大陆\\n缺少 ICP 备案号查看', 'icp_missing'],
    ]) {
      const outcome = script(id, 'classifyCn', { matches: [{ text: visible }] });
      expect(outcome.status).toBe(0);
      expect(JSON.parse(outcome.output)).toEqual({ territory: 'CHN', status: expected });
    }
    expect(script(id, 'classifyCn', { matches: [] }).status).not.toBe(0);
    expect(script(id, 'classifyCn', { matches: [{ text: '日本 可供应' }] }).status).not.toBe(0);
  });

  test('release observation runs through existing interpreter; unsafe ID never reaches external capabilities', async () => {
    const asset = materializedReleaseGrowthWorkflow(RELEASE_GROWTH_WORKFLOW_IDS.releaseObservation);
    const calls: string[] = [];
    const executeWith = async (appId: string, row: string) => executeWorkflow({
      asset,
      binding: { scopeId: 'repository:proof', runId: 'observation-' + appId + '-' + row.length },
      inputs: { app_id: appId, session_id: 'authorized-existing-session' },
    }, {
      executeCapability: async ({ step, arguments: args }) => {
        calls.push(step.stepId);
        if (step.stepId === 'read-version') return { outcome: 'succeeded', receiptRef: 'ASC-READ-EXISTING',
          output: { data: [{ attributes: { appVersionState: 'READY_FOR_DISTRIBUTION' } }] } };
        if (step.stepId === 'open-availability') {
          expect(args.url).toBe('https://appstoreconnect.apple.com/apps/' + appId + '/distribution/pricing/availability');
        }
        if (step.stepId === 'verify-location') return { outcome: 'succeeded', receiptRef: 'BROWSER-VERIFY-EXISTING',
          output: { matched: true, observedUrl: args.expected_url } };
        if (step.stepId === 'read-country-row') return { outcome: 'succeeded', receiptRef: 'BROWSER-ROW-EXISTING',
          output: { matches: row ? [{ text: row }] : [], count: row ? 1 : 0 } };
        return { outcome: 'succeeded', receiptRef: 'BROWSER-READ-EXISTING' };
      },
      executeScript: async ({ step, arguments: args }) => {
        const execution = script(asset.workflowId, step.scriptRef, args);
        return execution.status === 0
          ? { outcome: 'succeeded', receiptRef: 'SCRIPT-EXISTING', output: JSON.parse(execution.output) }
          : { outcome: 'failed', receiptRef: 'SCRIPT-FAIL-CLOSED' };
      },
    });
    const cnMissing = await executeWith('6796884084', '中国大陆\\n缺少 ICP 备案号查看');
    expect(cnMissing.status).toBe('succeeded');
    expect(cnMissing.outputs['classify-cn']).toEqual({ territory: 'CHN', status: 'icp_missing' });
    expect(cnMissing.outputs['classify-version']).toEqual({
      state: 'READY_FOR_DISTRIBUTION', next_action: 'verify_territories',
    });
    expect(calls).toContain('read-version');
    calls.length = 0;
    const bad = await executeWith('malicious/identifier', '中国大陆\\n可供应');
    expect(bad.status).toBe('failed');
    expect(calls.length).toBe(0);
    const missingRow = await executeWith('6831952477', '');
    expect(missingRow.status).toBe('failed');
    expect(missingRow.outputs['classify-cn']).toBeUndefined();
  });

  test('X metrics require an exact account/post URL and actual parseable counters', () => {
    const id = RELEASE_GROWTH_WORKFLOW_IDS.postMetrics;
    const asset = materializedReleaseGrowthWorkflow(id);
    expect(validateWorkflowRunInputs(asset, {
      account: 'developer_x', post_url: 'https://x.com/developer_x/status/1234567890', session_id: 'session-1',
    }).account).toBe('developer_x');
    const previews = asset.steps.find(step => step.stepId === 'read-reply-previews');
    expect(previews).toMatchObject({ capabilityId: 'browser.query_all',
      input: { selector: 'article[data-testid="tweet"]', limit: 15 } });
    expect(previews?.idempotency).not.toBe('non_idempotent');
    expect(script(id, 'validatePost', { account: 'developer_x', post_url: 'https://x.com/developer_x/status/1234567890' }).status).toBe(0);
    for (const post_url of [
      'https://x.com/wrong_account/status/1234567890',
      'https://evil.example/developer_x/status/1234567890',
      'https://x.com/developer_x/status/1234567890?danger=1',
      'http://x.com/developer_x/status/1234567890',
    ]) expect(script(id, 'validatePost', { account: 'developer_x', post_url }).status).not.toBe(0);
    const observed = script(id, 'deriveEngagement', { reply_label: '2 Replies. Reply', like_label: '1,234 Likes. Like' });
    expect(observed.status).toBe(0);
    expect(JSON.parse(observed.output)).toEqual({ reply_count: 2, like_count: 1234 });
    expect(script(id, 'deriveEngagement', { reply_label: '1.2K replies', like_label: '12 likes' }).status).not.toBe(0);
  });
});
