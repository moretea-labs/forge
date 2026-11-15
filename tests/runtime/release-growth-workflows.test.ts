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
      expect(installed.value.bindings.every(b => b.pluginId === 'computer' || b.pluginId === 'app_store_connect')).toBe(true);
      if (workflowId === RELEASE_GROWTH_WORKFLOW_IDS.releaseObservation || workflowId === RELEASE_GROWTH_WORKFLOW_IDS.postMetrics) {
        expect(installed.value.bindings.every(b => b.pluginId !== 'computer'
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
    expect(asset.version).toBe('2');
    expect(asset.steps.some(s => s.stepId === 'decide-verified-next-action')).toBe(true);
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
    expect(cnMissing.status...