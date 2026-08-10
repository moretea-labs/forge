import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { spawnSync } from 'child_process';
import { assertRuntimeReleaseFiles, stageRuntimeRelease } from '../../src/runtime/root/release-materialize';
import { loadRuntimeReleaseManifest } from '../../src/runtime/root/release-manifest';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function sourceFixture() {
  const root = mkdtempSync(join(tmpdir(), 'forge-runtime-release-source-'));
  const controllerHome = mkdtempSync(join(tmpdir(), 'forge-runtime-release-controller-'));
  roots.push(root, controllerHome);
  mkdirSync(join(root, 'src/runtime/plugins'), { recursive: true });
  mkdirSync(join(root, 'bin'), { recursive: true });
  writeFileSync(join(root, 'README.md'), 'fixture\n');
  writeFileSync(join(root, 'src/runtime/plugins/browser-node-bridge-host.ts'), 'console.log("host");\n');
  writeFileSync(join(root, 'src/runtime/plugins/browser-handoff-host.ts'), 'console.log("handoff");\n');
  writeFileSync(join(root, 'src/runtime/plugins/browser-automation-helper.ts'), 'console.log("browser-automation-helper");\n');
  writeFileSync(join(root, 'src/runtime/plugins/external-unix-socket-probe.cjs'), 'console.log("probe");\n');
  writeFileSync(join(root, 'bin/forge-desktop-helper.mjs'), '#!/usr/bin/env node\nconsole.log("desktop-helper");\n');
  spawnSync('git', ['init', '-b', 'main'], { cwd: root, stdio: 'ignore' });
  spawnSync('git', ['config', 'user.email', 'forge-test@example.invalid'], { cwd: root, stdio: 'ignore' });
  spawnSync('git', ['config', 'user.name', 'Forge Test'], { cwd: root, stdio: 'ignore' });
  spawnSync('git', ['add', '.'], { cwd: root, stdio: 'ignore' });
  spawnSync('git', ['commit', '-m', 'fixture'], { cwd: root, stdio: 'ignore' });
  return { root, controllerHome };
}

function materializeFakeCodeGraphRuntime(input: {
  nodeOutputPath: string;
  sidecarOutputPath: string;
  libraryOutputPath: string;
}) {
  writeFileSync(input.nodeOutputPath, 'codegraph-node');
  writeFileSync(input.sidecarOutputPath, 'codegraph-sidecar');
  mkdirSync(join(input.libraryOutputPath, 'dist'), { recursive: true });
  writeFileSync(join(input.libraryOutputPath, 'dist', 'index.js'), 'module.exports = {}');
  return { ok: true };
}

describe('runtime release materialization', () => {
  test('stages and hashes Browser and Desktop helper artifacts beside immutable runtime executables', () => {
    const { root, controllerHome } = sourceFixture();
    const staged = stageRuntimeRelease({ controllerHome, sourceRoot: root }, {
      now: () => 1_700_000_000_000,
      uuid: () => 'release-test',
      compileBinary: ({ outputPath, entryPath }) => {
        const kind = entryPath?.endsWith('check-runner-sidecar.ts')
          ? 'check-runner-binary'
          : entryPath?.endsWith('browser-automation-helper.ts')
            ? 'browser-automation-helper-binary'
            : entryPath?.endsWith('cli-sidecar.ts')
              ? 'cli-binary'
              : 'runtime-binary';
        writeFileSync(outputPath, kind);
        return { ok: true };
      },
      bundleNodeHost: ({ outputPath, entryPath }) => {
        const nodeBridge = entryPath.endsWith('src/runtime/plugins/browser-node-bridge-host.ts');
        const handoff = entryPath.endsWith('src/runtime/plugins/browser-handoff-host.ts');
        expect(nodeBridge || handoff).toBe(true);
        writeFileSync(outputPath, nodeBridge ? 'node-host-bundle' : 'handoff-host-bundle');
        return { ok: true };
      },
      bundleProcessRunner: ({ outputPath, entryPath }) => {
        expect(entryPath.endsWith('src/runtime/execution/process-runtime/process-runner-entry.ts')).toBe(true);
        writeFileSync(outputPath, 'process-runner-bundle');
        return { ok: true };
      },
      materializeCodeGraphRuntime: materializeFakeCodeGraphRuntime,
    });

    const hostPath = join(staged.releasePath, 'browser-node-bridge-host.js');
    expect(existsSync(hostPath)).toBe(true);
    expect(readFileSync(hostPath, 'utf8')).toBe('node-host-bundle');
    expect(staged.browserNodeBridgeArtifactIdentity).toMatch(/^sha256:/);
    const handoffHostPath = join(staged.releasePath, 'browser-handoff-host.js');
    expect(existsSync(handoffHostPath)).toBe(true);
    expect(readFileSync(handoffHostPath, 'utf8')).toBe('handoff-host-bundle');
    expect(staged.browserHandoffArtifactIdentity).toMatch(/^sha256:/);
    const browserAutomationHelperPath = join(staged.releasePath, 'browser-automation-helper');
    expect(existsSync(browserAutomationHelperPath)).toBe(true);
    expect(readFileSync(browserAutomationHelperPath, 'utf8')).toBe('browser-automation-helper-binary');
    expect(staged.browserAutomationHelperArtifactIdentity).toMatch(/^sha256:/);
    expect(staged.browserAutomationHelperContractIdentity).toMatch(/^sha256:/);
    const externalPluginProbePath = join(staged.releasePath, 'external-unix-socket-probe.cjs');
    expect(existsSync(externalPluginProbePath)).toBe(true);
    expect(readFileSync(externalPluginProbePath, 'utf8')).toContain('probe');
    expect(staged.externalPluginProbeArtifactIdentity).toMatch(/^sha256:/);
    const desktopHelperPath = join(staged.releasePath, 'forge-desktop-helper.mjs');
    expect(existsSync(desktopHelperPath)).toBe(true);
    expect(readFileSync(desktopHelperPath, 'utf8')).toContain('desktop-helper');
    expect(staged.desktopHelperArtifactIdentity).toMatch(/^sha256:/);
    const processRunnerPath = join(staged.releasePath, 'process-runner.js');
    expect(existsSync(processRunnerPath)).toBe(true);
    expect(readFileSync(processRunnerPath, 'utf8')).toBe('process-runner-bundle');
    expect(staged.processRunnerArtifactIdentity).toMatch(/^sha256:/);
    const checkRunnerPath = join(staged.releasePath, 'forge-check-runner');
    expect(existsSync(checkRunnerPath)).toBe(true);
    expect(readFileSync(checkRunnerPath, 'utf8')).toBe('check-runner-binary');
    expect(staged.checkRunnerArtifactIdentity).toMatch(/^sha256:/);
    const manifest = JSON.parse(readFileSync(staged.manifestPath, 'utf8')) as Record<string, unknown>;
    expect(manifest.browserNodeBridgeEntrypoint).toBe('browser-node-bridge-host.js');
    expect(manifest.browserNodeBridgeArtifactIdentity).toBe(staged.browserNodeBridgeArtifactIdentity);
    expect(manifest.browserHandoffEntrypoint).toBe('browser-handoff-host.js');
    expect(manifest.browserHandoffArtifactIdentity).toBe(staged.browserHandoffArtifactIdentity);
    expect(manifest.browserAutomationHelperEntrypoint).toBe('browser-automation-helper');
    expect(manifest.browserAutomationHelperArtifactIdentity).toBe(staged.browserAutomationHelperArtifactIdentity);
    expect(manifest.browserAutomationHelperContractIdentity).toBe(staged.browserAutomationHelperContractIdentity);
    expect(manifest.desktopHelperEntrypoint).toBe('forge-desktop-helper.mjs');
    expect(manifest.desktopHelperArtifactIdentity).toBe(staged.desktopHelperArtifactIdentity);
    expect(manifest.processRunnerEntrypoint).toBe('process-runner.js');
    expect(manifest.processRunnerArtifactIdentity).toBe(staged.processRunnerArtifactIdentity);
    expect(manifest.checkRunnerEntrypoint).toBe('forge-check-runner');
    expect(manifest.checkRunnerArtifactIdentity).toBe(staged.checkRunnerArtifactIdentity);
    expect(manifest.externalPluginProbeEntrypoint).toBe('external-unix-socket-probe.cjs');
    expect(manifest.externalPluginProbeArtifactIdentity).toBe(staged.externalPluginProbeArtifactIdentity);
    expect(existsSync(join(staged.releasePath, 'codegraph-node'))).toBe(true);
    expect(existsSync(join(staged.releasePath, 'codegraph-sidecar.cjs'))).toBe(true);
    expect(existsSync(join(staged.releasePath, 'codegraph-lib', 'dist', 'index.js'))).toBe(true);
    expect(staged.codeGraphNodeArtifactIdentity).toMatch(/^sha256:/);
    expect(staged.codeGraphSidecarArtifactIdentity).toMatch(/^sha256:/);
    expect(staged.codeGraphLibraryArtifactIdentity).toMatch(/^sha256:/);
    expect(manifest.codeGraphNodeEntrypoint).toBe('codegraph-node');
    expect(manifest.codeGraphNodeArtifactIdentity).toBe(staged.codeGraphNodeArtifactIdentity);
    expect(manifest.codeGraphSidecarEntrypoint).toBe('codegraph-sidecar.cjs');
    expect(manifest.codeGraphSidecarArtifactIdentity).toBe(staged.codeGraphSidecarArtifactIdentity);
    expect(manifest.codeGraphLibraryRoot).toBe('codegraph-lib');
    expect(manifest.codeGraphLibraryArtifactIdentity).toBe(staged.codeGraphLibraryArtifactIdentity);
    expect(loadRuntimeReleaseManifest(staged.manifestPath, controllerHome)).toMatchObject({
      codeGraphNodeEntrypoint: 'codegraph-node',
      codeGraphNodeArtifactIdentity: staged.codeGraphNodeArtifactIdentity,
      codeGraphSidecarEntrypoint: 'codegraph-sidecar.cjs',
      codeGraphSidecarArtifactIdentity: staged.codeGraphSidecarArtifactIdentity,
      codeGraphLibraryRoot: 'codegraph-lib',
      codeGraphLibraryArtifactIdentity: staged.codeGraphLibraryArtifactIdentity,
    });
    assertRuntimeReleaseFiles(staged);
  });

  test('rejects a partial CodeGraph runtime declaration in an immutable release manifest', () => {
    const { root, controllerHome } = sourceFixture();
    const manifestPath = join(root, 'partial-codegraph-manifest.json');
    writeFileSync(manifestPath, `${JSON.stringify({
      schemaVersion: 1,
      releaseId: 'release-partial-codegraph',
      artifactIdentity: 'sha256:runtime',
      entrypoint: 'forge-runtime',
      codeGraphNodeEntrypoint: 'codegraph-node',
      arguments: [],
      configurationSchemaVersion: 1,
      controllerHome,
      databaseSchemaCompatibility: { minimum: 1, maximum: 1 },
      workerProtocolVersion: 1,
      createdAt: new Date().toISOString(),
    }, null, 2)}\n`);
    expect(() => loadRuntimeReleaseManifest(manifestPath, controllerHome))
      .toThrow('codeGraphSidecarEntrypoint is required');
  });

  test('release assertion fails closed when the declared Browser Node bridge host is missing', () => {
    const { root, controllerHome } = sourceFixture();
    const staged = stageRuntimeRelease({ controllerHome, sourceRoot: root }, {
      compileBinary: ({ outputPath }) => {
        writeFileSync(outputPath, 'binary');
        return { ok: true };
      },
      bundleNodeHost: ({ outputPath }) => {
        writeFileSync(outputPath, 'node-host-bundle');
        return { ok: true };
      },
      bundleProcessRunner: ({ outputPath }) => {
        writeFileSync(outputPath, 'process-runner-bundle');
        return { ok: true };
      },
      materializeCodeGraphRuntime: materializeFakeCodeGraphRuntime,
    });
    rmSync(join(staged.releasePath, 'browser-node-bridge-host.js'));
    expect(() => assertRuntimeReleaseFiles(staged)).toThrow('RUNTIME_RELEASE_BROWSER_NODE_HOST_MISSING');
  });

  test('release assertion fails closed when the declared Browser Automation helper is missing', () => {
    const { root, controllerHome } = sourceFixture();
    const staged = stageRuntimeRelease({ controllerHome, sourceRoot: root }, {
      compileBinary: ({ outputPath }) => {
        writeFileSync(outputPath, 'binary');
        return { ok: true };
      },
      bundleNodeHost: ({ outputPath }) => {
        writeFileSync(outputPath, 'node-host-bundle');
        return { ok: true };
      },
      bundleProcessRunner: ({ outputPath }) => {
        writeFileSync(outputPath, 'process-runner-bundle');
        return { ok: true };
      },
      materializeCodeGraphRuntime: materializeFakeCodeGraphRuntime,
    });
    rmSync(join(staged.releasePath, 'browser-automation-helper'));
    expect(() => assertRuntimeReleaseFiles(staged)).toThrow('RUNTIME_RELEASE_BROWSER_AUTOMATION_HELPER_MISSING');
  });

  test('release assertion fails closed when the declared Browser handoff host is missing', () => {
    const { root, controllerHome } = sourceFixture();
    const staged = stageRuntimeRelease({ controllerHome, sourceRoot: root }, {
      compileBinary: ({ outputPath }) => {
        writeFileSync(outputPath, 'binary');
        return { ok: true };
      },
      bundleNodeHost: ({ outputPath }) => {
        writeFileSync(outputPath, 'node-host-bundle');
        return { ok: true };
      },
      bundleProcessRunner: ({ outputPath }) => {
        writeFileSync(outputPath, 'process-runner-bundle');
        return { ok: true };
      },
      materializeCodeGraphRuntime: materializeFakeCodeGraphRuntime,
    });
    rmSync(join(staged.releasePath, 'browser-handoff-host.js'));
    expect(() => assertRuntimeReleaseFiles(staged)).toThrow('RUNTIME_RELEASE_BROWSER_HANDOFF_HOST_MISSING');
  });
});
