import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { executeWorkflow, validateWorkflowRunInputs, workflowCapabilityDependencies } from '../../packages/workflow-runtime/api/index';
import {
  ensureReleaseGrowthWorkflowInstalled,
  materializedReleaseGrowthWorkflow,
  RELEASE_GROWTH_WORKFLOW_IDS,
  X_EFFECT_WORKFLOW_IDS,
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
  test('deployed bundle retains all four release and growth assets outside the source checkout', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'forge-release-growth-bundle-'));
    homes.push(directory);
    const entrypoint = join(directory, 'probe.ts');
    const modulePath = new URL('../../src/runtime/workflows/first-party/release-growth.ts', import.meta.url).pathname;
    writeFileSync(entrypoint, `import { materializedReleaseGrowthWorkflow, RELEASE_GROWTH_WORKFLOW_IDS, X_EFFECT_WORKFLOW_IDS } from ${JSON.stringify(modulePath)};\nconsole.log(JSON.stringify([...Object.values(RELEASE_GROWTH_WORKFLOW_IDS), ...Object.values(X_EFFECT_WORKFLOW_IDS)].map(id => materializedReleaseGrowthWorkflow(id).contentDigest)));`);
    const build = await Bun.build({ entrypoints: [entrypoint], outdir: directory, target: 'bun' });
    expect(build.success).toBe(true);
    const run = Bun.spawnSync([process.execPath, build.outputs[0].path], { cwd: directory, stdout: 'pipe', stderr: 'pipe' });
    expect({ exitCode: run.exitCode, stderr: run.stderr.toString() }).toEqual({ exitCode: 0, stderr: '' });
    expect(JSON.parse(run.stdout.toString())).toEqual([...Object.values(RELEASE_GROWTH_WORKFLOW_IDS), ...Object.values(X_EFFECT_WORKFLOW_IDS)]
      .map(id => materializedReleaseGrowthWorkflow(id).contentDigest));
  });

  test('authored assets install in existing Workflow registry; only supported read-only plugin capabilities are bound', () => {
    const controllerHome = mkdtempSync(join(tmpdir(), 'forge-release-growth-workflows-'));
    homes.push(controllerHome);
    for (const workflowId of Object.values(RELEASE_GROWTH_WORKFLOW_IDS)) {
      const asset = materializedReleaseGrowthWorkflow(workflowId);
      const installed = ensureReleaseGrowthWorkflowInstalled(controllerHome, workflowId);
      expect(installed.value.contentDigest).toBe(asset.contentDigest);
      expect(installed.value.bindings.map(binding => binding.capabilityId).sort()).toEqual(workflowCapabilityDependencies(asset));
      expect(installed.value.bindings.every(b => b.pluginId === 'browser' || b.pluginId === 'app_store_connect')).toBe(true);
      if (workflowId === RELEASE_GROWTH_WORKFLOW_IDS.releaseObservation || workflowId === RELEASE_GROWTH_WORKFLOW_IDS.postMetrics) {
        expect(installed.value.bindings.every(b => b.pluginId !== 'browser'
          || ['navigate', 'verify_state', 'wait_for_selector', 'query_all', 'get_attribute', 'get_text'].includes(b.actionId ?? ''))).toBe(true);
      }
      expect(installed.value.bindings.every(b => b.pluginId !== 'app_store_connect' || ['list_app_store_versions', 'list_app_territory_availabilities'].includes(b.actionId ?? ''))).toBe(true);
      if (workflowId === RELEASE_GROWTH_WORKFLOW_IDS.releaseObservation) {
        expect(installed.value.bindings.map(binding => binding.actionId)).toContain('list_app_territory_availabilities');
      }
      expect(asset.steps.every(step => step.idempotency !== 'non_idempotent')).toBe(true);
      expect(asset.publication).toBeUndefined();
      expect(asset.credentialRefs).toBeUndefined();
      const repeated = ensureReleaseGrowthWorkflowInstalled(controllerHome, workflowId);
      expect(repeated.value.contentDigest).toBe(asset.contentDigest);
      expect(repeated.value.bindings).toEqual(installed.value.bindings);
    }
  });

  test('App ID and version are exact inputs; version release state and typed CN availability remain separate', () => {
    const id = RELEASE_GROWTH_WORKFLOW_IDS.releaseObservation;
    const asset = materializedReleaseGrowthWorkflow(id);
    const a = validateWorkflowRunInputs(asset, { app_id: '6831952477', version_string: '1.2' });
    const b = validateWorkflowRunInputs(asset, { app_id: '6796884084', version_string: '1.0' });
    expect(a.app_id).not.toBe(b.app_id);
    expect(a.version_string).not.toBe(b.version_string);
    expect(asset.steps.some(s => s.kind !== 'script' && s.capabilityId === 'asc.list_app_store_versions')).toBe(true);
    expect(asset.steps.some(s => s.kind !== 'script' && s.capabilityId === 'asc.list_app_territory_availabilities')).toBe(true);
    expect(asset.steps.some(s => s.kind !== 'script' && s.capabilityId.startsWith('browser.'))).toBe(false);
    expect(asset.steps.some(s => s.stepId === 'classify-cn')).toBe(true);
    expect(script(id, 'validateAppVersion', { app_id: '6831952477', version_string: '1.2' }).status).toBe(0);
    expect(script(id, 'validateAppVersion', { app_id: 'not-an-id', version_string: '1.2' }).status).not.toBe(0);
    expect(script(id, 'validateAppVersion', { app_id: '6831952477', version_string: 'latest' }).status).not.toBe(0);

    const ready = script(id, 'classifyVersion', {
      version_string: '1.2',
      versions: [{ attributes: { versionString: '1.2', appStoreState: 'READY_FOR_SALE',
        appVersionState: 'READY_FOR_DISTRIBUTION', releaseType: 'MANUAL', downloadable: true } }],
      links: { next: null },
    });
    expect(ready.status).toBe(0);
    expect(JSON.parse(ready.output)).toEqual({
      version: '1.2', app_store_state: 'READY_FOR_SALE', app_version_state: 'READY_FOR_DISTRIBUTION',
      release_type: 'MANUAL', downloadable: true, next_action: 'verify_territories',
    });
    const manualRelease = script(id, 'classifyVersion', {
      version_string: '1.2',
      versions: [{ attributes: { versionString: '1.2', appStoreState: 'PENDING_DEVELOPER_RELEASE',
        appVersionState: 'READY_FOR_DISTRIBUTION', releaseType: 'MANUAL', downloadable: true } }],
      links: { next: null },
    });
    expect(JSON.parse(manualRelease.output).next_action).toBe('manual_release_required');
    const afterApproval = script(id, 'classifyVersion', {
      version_string: '1.0',
      versions: [{ attributes: { versionString: '1.0', appStoreState: 'PENDING_DEVELOPER_RELEASE',
        appVersionState: 'READY_FOR_DISTRIBUTION', releaseType: 'AFTER_APPROVAL', downloadable: true } }],
      links: { next: null },
    });
    expect(JSON.parse(afterApproval.output).next_action).toBe('await_apple_release');
    const ambiguousVersion = script(id, 'classifyVersion', {
      version_string: '1.2',
      versions: [{ attributes: { versionString: '1.2' } }, { attributes: { versionString: '1.2' } }],
      links: { next: null },
    });
    expect(ambiguousVersion.status).not.toBe(0);
    expect(script(id, 'classifyVersion', {
      version_string: '1.2', versions: [{ attributes: { versionString: '1.2' } }],
      links: { next: 'https://api.example/next' },
    }).status).not.toBe(0);

    const cnMissing = script(id, 'classifyCn', {
      data: [{ attributes: { available: true, contentStatuses: ['ICP_NUMBER_MISSING'], releaseDate: null },
        relationships: { territory: { data: { id: 'CHN', type: 'territories' } } } }],
      links: { next: null },
    });
    expect(cnMissing.status).toBe(0);
    expect(JSON.parse(cnMissing.output)).toEqual({
      territory: 'CHN', status: 'icp_missing', available: true,
      content_statuses: ['ICP_NUMBER_MISSING'], release_date: null,
    });
    const cnAvailable = script(id, 'classifyCn', {
      data: [{ attributes: { available: true, contentStatuses: ['AVAILABLE'], releaseDate: null },
        relationships: { territory: { data: { id: 'CHN', type: 'territories' } } } }],
      links: { next: null },
    });
    expect(JSON.parse(cnAvailable.output).status).toBe('available');
    const cnNotAvailable = script(id, 'classifyCn', {
      data: [{ attributes: { available: false, contentStatuses: [] },
        relationships: { territory: { data: { id: 'CHN', type: 'territories' } } } }],
      links: { next: null },
    });
    expect(JSON.parse(cnNotAvailable.output).status).toBe('not_available');
    expect(script(id, 'classifyCn', {
      data: [{ attributes: { available: true, contentStatuses: ['AVAILABLE'] },
        relationships: { territory: { data: { id: 'JPN', type: 'territories' } } } }],
      links: { next: null },
    }).status).not.toBe(0);
    expect(script(id, 'classifyCn', {
      data: [{ attributes: { available: true, contentStatuses: ['AVAILABLE'] },
        relationships: { territory: { data: { id: 'CHN', type: 'territories' } } } }],
      links: { next: 'https://api.example/next' },
    }).status).not.toBe(0);
  });

  test('typed release observation uses Apple version and CHN territory records; unsafe or incomplete inputs fail closed', async () => {
    const asset = materializedReleaseGrowthWorkflow(RELEASE_GROWTH_WORKFLOW_IDS.releaseObservation);
    const calls: string[] = [];
    const executeWith = async (
      appId: string,
      versionString: string,
      territoryRows: unknown[],
      nextPage: string | null = null,
    ) => executeWorkflow({
      asset,
      binding: { scopeId: 'repository:proof', runId: 'observation-' + appId.replace(/[^A-Za-z0-9]/g, '_') + '-' + versionString },
      inputs: { app_id: appId, version_string: versionString },
    }, {
      executeCapability: async ({ step }) => {
        calls.push(step.stepId);
        if (step.stepId === 'read-version') return {
          outcome: 'succeeded', receiptRef: 'ASC-VERSION-READ',
          output: {
            data: [{ attributes: { versionString, appStoreState: 'READY_FOR_SALE',
              appVersionState: 'READY_FOR_DISTRIBUTION', releaseType: 'AFTER_APPROVAL', downloadable: true } }],
            links: { next: null },
          },
        };
        if (step.stepId === 'read-territory-availability') return {
          outcome: 'succeeded', receiptRef: 'ASC-TERRITORY-READ',
          output: { data: territoryRows, links: { next: nextPage } },
        };
        throw new Error('UNEXPECTED_CAPABILITY:' + step.stepId);
      },
      executeScript: async ({ step, arguments: args }) => {
        const execution = script(asset.workflowId, step.scriptRef, args);
        return execution.status === 0
          ? { outcome: 'succeeded', receiptRef: 'SCRIPT-EXISTING', output: JSON.parse(execution.output) }
          : { outcome: 'failed', receiptRef: 'SCRIPT-FAIL-CLOSED' };
      },
    });
    const cnMissingRow = [{
      id: 'territory-row-cn',
      attributes: { available: true, contentStatuses: ['ICP_NUMBER_MISSING'], releaseDate: null },
      relationships: { territory: { data: { id: 'CHN', type: 'territories' } } },
    }];
    const cnMissing = await executeWith('6796884084', '1.0', cnMissingRow);
    expect(cnMissing.status).toBe('succeeded');
    expect(cnMissing.outputs['classify-cn']).toEqual({
      territory: 'CHN', status: 'icp_missing', available: true,
      content_statuses: ['ICP_NUMBER_MISSING'], release_date: null,
    });
    expect(cnMissing.outputs['classify-version']).toEqual({
      version: '1.0', app_store_state: 'READY_FOR_SALE', app_version_state: 'READY_FOR_DISTRIBUTION',
      release_type: 'AFTER_APPROVAL', downloadable: true, next_action: 'verify_territories',
    });
    expect(calls).toEqual(['read-version', 'read-territory-availability']);

    calls.length = 0;
    const bad = await executeWith('malicious/identifier', '1.0', cnMissingRow);
    expect(bad.status).toBe('failed');
    expect(calls.length).toBe(0);

    const missingRow = await executeWith('6831952477', '1.2', []);
    expect(missingRow.status).toBe('failed');
    expect(missingRow.outputs['classify-cn']).toBeUndefined();

    const paginationIncomplete = await executeWith('6831952477', '1.2', [{
      attributes: { available: true, contentStatuses: ['AVAILABLE'] },
      relationships: { territory: { data: { id: 'CHN', type: 'territories' } } },
    }], 'https://api.appstoreconnect.apple.com/v2/territoryAvailabilities?cursor=next');
    expect(paginationIncomplete.status).toBe('failed');
    expect(paginationIncomplete.outputs['classify-cn']).toBeUndefined();
  });

  test('X metrics require an exact account/post URL and actual parseable counters', () => {
    const id = RELEASE_GROWTH_WORKFLOW_IDS.postMetrics;
    const asset = materializedReleaseGrowthWorkflow(id);
    expect(validateWorkflowRunInputs(asset, {
      account: 'developer_x', post_url: 'https://x.com/developer_x/status/1234567890', session_id: 'session-1',
    }).account).toBe('developer_x');
    const previewStep = asset.steps.find(step => step.stepId === 'read-reply-previews');
    expect(previewStep).toMatchObject({ capabilityId: 'browser.query_all',
      input: { selector: 'article[data-testid="tweet"]', limit: 15 } });
    expect(previewStep?.idempotency).not.toBe('non_idempotent');
    expect(asset.steps.find(step => step.stepId === 'read-reply-preview-links')).toMatchObject({
      capabilityId: 'browser.query_all', input: { selector: 'article[data-testid="tweet"] a[href*="/status/"]:has(time)', limit: 15 },
    });
    expect(asset.steps.find(step => step.stepId === 'derive-reply-previews')).toMatchObject({
      kind: 'script', scriptRef: 'deriveReplyPreviews',
    });
    expect(asset.resources?.replyPolicy).toContain('substantive questions');
    expect(asset.resources?.replyPolicy).toContain('verified public product/store facts');
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
    const previews = script(id, 'deriveReplyPreviews', {
      account: 'developer_x', post_url: 'https://x.com/developer_x/status/1234567890',
      articles: [
        { text: 'Developer @developer_x · Nov 14 Original post' },
        { text: 'Alice @alice · Nov 14 This is a useful reply.' },
        { text: 'Developer @developer_x · Nov 14 Own follow-up' },
        { text: 'Bob @bob · Nov 14 Another reply.' },
      ],
      links: [
        { href: '/developer_x/status/1234567890' }, { href: '/alice/status/2222222222' },
        { href: '/developer_x/status/3333333333' }, { href: '/bob/status/4444444444' },
      ],
    });
    expect(previews.status).toBe(0);
    expect(JSON.parse(previews.output)).toEqual({
      previews: [
        { comment_url: 'https://x.com/alice/status/2222222222', comment_id: '2222222222',
          comment_author: 'alice', preview_text: 'Alice @alice · Nov 14 This is a useful reply.' },
        { comment_url: 'https://x.com/bob/status/4444444444', comment_id: '4444444444',
          comment_author: 'bob', preview_text: 'Bob @bob · Nov 14 Another reply.' },
      ], count: 2,
    });
    expect(script(id, 'deriveReplyPreviews', {
      account: 'developer_x', post_url: 'https://x.com/developer_x/status/1234567890',
      articles: [{ text: 'reply' }], links: [],
    }).status).not.toBe(0);
    expect(script(id, 'deriveReplyPreviews', {
      account: 'developer_x', post_url: 'https://x.com/developer_x/status/1234567890',
      articles: [{ text: 'reply' }], links: [{ href: 'https://evil.example/status/1' }],
    }).status).not.toBe(0);
  });
});
