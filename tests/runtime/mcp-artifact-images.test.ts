import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { MultiRepositoryMcpToolContext } from '../../adapters/mcp/multi-repository';
import { callRuntimeObservationAdapter } from '../../adapters/mcp/runtime-gateway/runtime-observation-adapter';
import { resultWithPluginArtifactImages, resultWithSubmittedPluginActionImages } from '../../adapters/mcp/runtime-gateway/result-adapter';
import { repositoryControllerRoot } from '../../src/effects/controller-home';
import { writeExecutionArtifact } from '../../src/runtime/evidence/artifact-store';
import type { ExecutionJob } from '../../src/runtime/execution/jobs/types';

const roots: string[] = [];
// Decodeable fixture only; this is not Simulator visual acceptance evidence.
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN1sAAAAASUVORK5CYII=', 'base64');
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture() {
  const controllerHome = mkdtempSync(join(tmpdir(), 'forge-mcp-images-'));
  roots.push(controllerHome);
  const repoId = 'repo-images';
  const dir = join(repositoryControllerRoot(controllerHome, repoId), 'artifacts', 'ios');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'screen.png');
  writeFileSync(path, png);
  const candidate = { artifactType: 'ios_simulator_screenshot', mediaType: 'image/png', path, boundedToControllerStorage: true };
  const job = { jobId: 'screenshot-test', repoId, origin: { actor: 'owner' } } as ExecutionJob;
  const ctx = { controllerHome, principalId: 'owner' } as MultiRepositoryMcpToolContext;
  const read = (value: unknown = candidate, args: Record<string, unknown> = {}, kind: 'evidence' | 'job-result' = 'evidence') => {
    const artifact = writeExecutionArtifact(controllerHome, job, kind, value);
    return callRuntimeObservationAdapter(ctx, 'get_artifact', { artifact_id: artifact.artifactId, ...args });
  };
  return { controllerHome, repoId, path, candidate, job, ctx, read };
}

test('saved screenshot evidence reads back as MCP image with exact PNG bytes', async () => {
  const f = fixture();
  const output = await f.read();
  expect(output?.content as unknown[]).toContainEqual({ type: 'image', mimeType: 'image/png', data: png.toString('base64') });
  expect(output?.structuredContent).toMatchObject({ referenceType: 'artifact', truncated: false, content: f.candidate });
});

test('direct screenshot candidates still return the same image bytes', () => {
  const f = fixture();
  for (const pluginResult of [{ artifactCandidates: [f.candidate] }, { result: { artifactCandidates: [f.candidate] } }]) {
    expect(resultWithPluginArtifactImages({}, f.controllerHome, f.repoId, pluginResult).content as unknown[])
      .toContainEqual({ type: 'image', mimeType: 'image/png', data: png.toString('base64') });
  }
});

test('artifact image readback preserves principal access checks', async () => {
  const f = fixture();
  const artifact = writeExecutionArtifact(f.controllerHome, f.job, 'evidence', f.candidate);
  const output = await callRuntimeObservationAdapter({ ...f.ctx, principalId: 'other' }, 'get_artifact', { artifact_id: artifact.artifactId });
  expect(output?.isError).toBe(true);
  expect(output?.structuredContent).toMatchObject({ error: { code: 'ARTIFACT_ACCESS_DENIED' } });
  expect(output?.content).toHaveLength(1);
});

test('submitted agent-device screenshot compacts metadata and inlines the original envelope image', () => {
  const f = fixture();
  const providerResult = {
    provider: 'agent-device',
    interaction: { interactionId: 'visual-review' },
    result: { status: 'captured', artifactCandidates: [f.candidate] },
    artifactCandidates: [f.candidate],
    work: { workId: 'preserved-work-lineage' },
  };
  const output = resultWithSubmittedPluginActionImages(
    { requestId: 'visual-review-request' }, f.controllerHome, f.repoId, providerResult,
  );

  expect(output.content as unknown[]).toContainEqual({ type: 'image', mimeType: 'image/png', data: png.toString('base64') });
  expect((output.content as unknown as Array<{ type?: string }>).filter((item) => item.type === 'image')).toHaveLength(1);
  expect(output.structuredContent).toEqual({
    requestId: 'visual-review-request',
    result: { status: 'captured', work: providerResult.work },
  });
  expect(JSON.stringify(output.structuredContent)).not.toContain(f.path);
});

test('simulator screenshot receipts inline the PNG without exposing local absolutePath or command argv', () => {
  const f = fixture();
  const screenshot = {
    ready: true,
    screenshot: 'controller-artifacts/ios/screenshots/current.png',
    absolutePath: f.path,
    command: ['xcrun', 'simctl', 'io', 'exact-device-id', 'screenshot', f.path],
    artifactType: 'ios_simulator_screenshot',
    udid: 'exact-device-id',
    artifactCandidates: [f.candidate],
  };
  for (const providerResult of [screenshot, { result: screenshot, work: { workId: 'screenshot-work' } }]) {
    const output = resultWithSubmittedPluginActionImages(
      { requestId: 'live-screenshot' }, f.controllerHome, f.repoId, providerResult,
    );
    expect(output.content as unknown[]).toContainEqual({ type: 'image', mimeType: 'image/png', data: png.toString('base64') });
    expect(output.structuredContent).toMatchObject({
      requestId: 'live-screenshot',
      result: { ready: true, screenshot: screenshot.screenshot, udid: screenshot.udid },
    });
    expect(JSON.stringify(output.structuredContent)).not.toContain(f.path);
    expect(JSON.stringify(output.structuredContent)).not.toContain('absolutePath');
    expect(JSON.stringify(output.structuredContent)).not.toContain('command');
  }
});

test('agent-device screenshot receipts redact nested command argv while preserving command outcome', () => {
  const f = fixture();
  const screenshotPath = f.path;
  const providerResult = {
    provider: 'agent-device',
    interaction: { interactionId: 'visual-review' },
    result: { ok: true, status: 0, stdout: 'captured', stderr: '', command: ['agent-device', 'screenshot', screenshotPath] },
    artifactCandidates: [{ kind: 'ios_agent_device_screenshot', mediaType: 'image/png', path: screenshotPath }],
    work: { workId: 'agent-device-screenshot-work' },
  };
  const output = resultWithSubmittedPluginActionImages(
    { requestId: 'agent-device-screenshot' }, f.controllerHome, f.repoId, providerResult,
  );
  expect(output.content as unknown[]).toContainEqual({ type: 'image', mimeType: 'image/png', data: png.toString('base64') });
  expect(output.structuredContent).toMatchObject({
    requestId: 'agent-device-screenshot',
    result: { ok: true, status: 0, stdout: 'captured', stderr: '', work: providerResult.work },
  });
  expect(JSON.stringify(output.structuredContent)).not.toContain(screenshotPath);
  expect(JSON.stringify(output.structuredContent)).not.toContain('command');
});

test('non-evidence, truncated, missing and oversized image artifacts stay text-only', async () => {
  const f = fixture();
  const outputs = [await f.read(f.candidate, {}, 'job-result'), await f.read({ ...f.candidate, padding: 'x'.repeat(2048) }, { max_bytes: 1024 }),
    await f.read({ ...f.candidate, path: join(f.path, 'missing') }), await f.read({ ...f.candidate, mediaType: 'text/plain' })];
  writeFileSync(f.path, Buffer.alloc(8 * 1024 * 1024 + 1));
  outputs.push(await f.read());
  for (const output of outputs) expect(output?.content.filter((item) => String(item.type) === 'image')).toHaveLength(0);
});

test('image readback rejects foreign repository paths and symlink escapes', async () => {
  const f = fixture();
  const outside = join(f.controllerHome, 'foreign.png');
  writeFileSync(outside, png);
  const link = join(f.path, '..', 'link.png');
  symlinkSync(outside, link);
  for (const path of [outside, link]) {
    const output = await f.read({ ...f.candidate, path });
    expect(output?.content.filter((item) => String(item.type) === 'image')).toHaveLength(0);
  }
});
