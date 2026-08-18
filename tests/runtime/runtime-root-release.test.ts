import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { spawnSync } from 'child_process';
import { FORGE_MACOS_RUNTIME_SIGNING_IDENTIFIER, assertRuntimeReleaseFiles, stageRuntimeRelease, stageRuntimeReleaseFromCandidateSource, type MacOSRuntimeCodeSigning } from '../../src/runtime/root/release-materialize';
import { loadRuntimeReleaseManifest } from '../../src/runtime/root/release-manifest';
import { cleanupControllerReleaseHistory } from '../../src/runtime/control-plane/release-retention';

const roots: string[] = [];

const STABLE_MACOS_SIGNING: MacOSRuntimeCodeSigning = {
  identifier: FORGE_MACOS_RUNTIME_SIGNING_IDENTIFIER,
  teamIdentifier: 'K848A29AJ5',
  authority: 'Developer ID Application: Guilian Zhang (K848A29AJ5)',
  designatedRequirement: 'identifier \"com.moretea.forge.runtime\" and anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] exists and certificate leaf[field.1.2.840.113635.100.6.1.13] exists and certificate leaf[subject.OU] = K848A29AJ5',
};

function retentionRelease(home: string, releaseId: string): string {
  const releaseRoot = join(home, 'runtime', 'releases', releaseId);
  mkdirSync(releaseRoot, { recursive: true });
  writeFileSync(join(releaseRoot, 'manifest.json'), '{}\n');
  return releaseRoot;
}

function writeRetentionRuntimeAuthority(home: string, activeId: string, previousId: string): void {
  const releasesRoot = join(home, 'runtime', 'releases');
  writeFileSync(join(releasesRoot, 'authority.json'), `${JSON.stringify({
    schemaVersion: 1,
    status: 'committed',
    revision: 1,
    active: { releaseId: activeId, manifestPath: join(releasesRoot, activeId, 'manifest.json') },
    previous: { releaseId: previousId, manifestPath: join(releasesRoot, previousId, 'manifest.json') },
  }, null, 2)}\n`);
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function sourceFixture() {
  const root = mkdtempSync(join(tmpdir(), 'forge-runtime-release-source-'));
  const controllerHome = mkdtempSync(join(tmpdir(), 'forge-runtime-release-controller-'));
  roots.push(root, controllerHome);
  mkdirSync(join(root, 'src/runtime/plugins'), { recursive: true });
  mkdirSync(join(root, 'src/cli/local-bridge/ui-dist'), { recursive: true });
  mkdirSync(join(root, 'bin'), { recursive: true });
  mkdirSync(join(root, 'scripts'), { recursive: true });
  writeFileSync(join(root, 'README.md'), 'fixture\n');
  writeFileSync(join(root, 'src/runtime/plugins/browser-node-bridge-host.ts'), 'console.log("host");\n');
  writeFileSync(join(root, 'src/runtime/plugins/browser-handoff-host.ts'), 'console.log("handoff");\n');
  writeFileSync(join(root, 'src/runtime/plugins/external-unix-socket-probe.cjs'), 'console.log("probe");\n');
  writeFileSync(join(root, 'src/cli/local-bridge/ui-dist/app.js'), 'console.log("ui");\n');
  writeFileSync(join(root, 'src/cli/local-bridge/ui-dist/app.css'), ':root { color-scheme: light; }\n');
  writeFileSync(join(root, 'scripts/stage-runtime-release.ts'), '// candidate-owned stager fixture\n');
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

function sha256Text(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

describe('compiled runtime UI assets', () => {
  test('reads controller UI assets co-located with a Bun compiled executable', () => {
    const root = mkdtempSync(join(tmpdir(), 'forge-runtime-ui-compiled-'));
    roots.push(root);
    const uiRoot = join(root, 'ui-dist');
    mkdirSync(uiRoot, { recursive: true });
    writeFileSync(join(uiRoot, 'app.js'), 'compiled-ui-marker');
    const entryPath = join(root, 'entry.ts');
    const helperPath = join(import.meta.dir, '../../src/cli/local-bridge/console-assets.ts');
    writeFileSync(entryPath, `import { readConsoleAsset } from ${JSON.stringify(helperPath)};\nprocess.stdout.write(readConsoleAsset("app.js"));\n`);
    const executable = join(root, 'forge-runtime-ui-smoke');
    const compile = spawnSync(process.execPath, ['build', entryPath, '--compile', '--outfile', executable], {
      cwd: root,
      encoding: 'utf8',
    });
    expect(compile.status).toBe(0);
    const run = spawnSync(executable, [], { cwd: root, encoding: 'utf8' });
    expect(run.status).toBe(0);
    expect(run.stdout).toBe('compiled-ui-marker');
  });
});

describe('persistent Gateway release retention', () => {
  test('pins the Runtime release backing a persistent public Gateway even after it is neither active nor previous', () => {
    const home = mkdtempSync(join(tmpdir(), 'forge-gateway-retention-'));
    roots.push(home);
    const active = retentionRelease(home, 'active-release');
    const previous = retentionRelease(home, 'previous-release');
    const gateway = retentionRelease(home, 'gateway-release');
    const stale = retentionRelease(home, 'stale-release');
    writeRetentionRuntimeAuthority(home, 'active-release', 'previous-release');
    const connectorRoot = join(home, 'runtime', 'connector-service');
    mkdirSync(connectorRoot, { recursive: true });
    writeFileSync(join(connectorRoot, 'authority.json'), `${JSON.stringify({
      schemaVersion: 1,
      endpoint: 'http://127.0.0.1:8767/mcp',
      releaseId: 'gateway-release',
      releaseRoot: gateway,
      packageRoot: join(home, 'packages', 'forge'),
      mode: 'launchd',
      persistent: true,
      installedAt: '2026-08-18T00:00:00.000Z',
    }, null, 2)}\n`);

    const report = cleanupControllerReleaseHistory(home, { nowMs: Date.now() + 1_000, graceMs: 0, stagingGraceMs: 0, maxRemovals: 20 });
    expect(existsSync(active)).toBe(true);
    expect(existsSync(previous)).toBe(true);
    expect(existsSync(gateway)).toBe(true);
    expect(existsSync(stale)).toBe(false);
    expect(report.removedPaths).toContain('runtime/releases/stale-release');
    expect(report.skippedByReason.release_authority).toBe(3);
  });

  test('fails runtime release cleanup closed when a configured Gateway authority is missing or malformed', () => {
    for (const mode of ['missing', 'malformed'] as const) {
      const home = mkdtempSync(join(tmpdir(), `forge-gateway-retention-${mode}-`));
      roots.push(home);
      retentionRelease(home, 'active-release');
      retentionRelease(home, 'previous-release');
      const stale = retentionRelease(home, 'stale-release');
      writeRetentionRuntimeAuthority(home, 'active-release', 'previous-release');
      const connectorRoot = join(home, 'runtime', 'connector-service');
      mkdirSync(connectorRoot, { recursive: true });
      if (mode === 'malformed') writeFileSync(join(connectorRoot, 'authority.json'), '{"schemaVersion":1,"releaseId":""}\n');

      const report = cleanupControllerReleaseHistory(home, { nowMs: Date.now() + 1_000, graceMs: 0, maxRemovals: 20 });
      expect(existsSync(stale)).toBe(true);
      expect(report.removedPaths).toEqual([]);
      expect(report.skippedByReason.authority_unavailable).toBe(1);
      expect(report.errors.some((entry) => entry.includes('package connector release authority'))).toBe(true);
    }
  });
});

describe('runtime release materialization', () => {
  test('accepts a first-generation candidate release with a parent-unknown sidecar', () => {
    const { root, controllerHome } = sourceFixture();
    const sourceCommit = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout.trim();
    const releaseId = `future-${sourceCommit}`, releasePath = join(controllerHome, 'runtime', 'releases', releaseId);
    const runtime = 'candidate-runtime', artifactIdentity = `sha256:${sha256Text(runtime)}`;
    mkdirSync(releasePath, { recursive: true });
    writeFileSync(join(releasePath, 'forge-runtime'), runtime); writeFileSync(join(releasePath, 'future-sidecar-v2'), 'future');
    const manifestPath = join(releasePath, 'manifest.json');
    const manifestText = `${JSON.stringify({ schemaVersion: 1, releaseId, artifactIdentity, entrypoint: 'forge-runtime', futureSidecarEntrypoint: 'future-sidecar-v2', arguments: [], configurationSchemaVersion: 1, controllerHome, databaseSchemaCompatibility: { minimum: 1, maximum: 1 }, workerProtocolVersion: 1, sourceCommit, createdAt: '2026-08-10T00:00:00.000Z' })}\n`;
    writeFileSync(manifestPath, manifestText);
    const staged = stageRuntimeReleaseFromCandidateSource({ controllerHome, sourceRoot: root }, { platform: 'linux', runCandidateStager: (request) => {
      expect([request.scriptPath, request.sourceRoot, request.expectedHead]).toEqual([join(root, 'scripts', 'stage-runtime-release.ts'), root, sourceCommit]);
      return { ok: true, stdout: JSON.stringify({ schemaVersion: 1, releasePath, manifestPath, releaseId, artifactIdentity, manifestSha256: sha256Text(manifestText), sourceCommit, futureSidecarEntrypoint: 'future-sidecar-v2' }) };
    } });
    expect(existsSync(join(staged.releasePath, 'future-sidecar-v2'))).toBe(true);
    expect(loadRuntimeReleaseManifest(staged.manifestPath, controllerHome).releaseId).toBe(releaseId);
  });

  test.each([
    ['outside release root', 'RUNTIME_RELEASE_CANDIDATE_PATH_OUTSIDE_RELEASE_ROOT', false],
    ['different source HEAD', 'RUNTIME_RELEASE_CANDIDATE_SOURCE_MISMATCH', true],
  ])('rejects candidate receipt with %s', (_case, error, wrongHead) => {
    const { root, controllerHome } = sourceFixture();
    const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout.trim();
    const releaseId = wrongHead ? 'wrong-head' : 'outside-release';
    const releasePath = wrongHead ? join(controllerHome, 'runtime', 'releases', releaseId) : mkdtempSync(join(tmpdir(), 'forge-runtime-release-outside-'));
    if (!wrongHead) roots.push(releasePath);
    expect(() => stageRuntimeReleaseFromCandidateSource({ controllerHome, sourceRoot: root }, { runCandidateStager: () => ({ ok: true, stdout: JSON.stringify({ schemaVersion: 1, releasePath, manifestPath: join(releasePath, 'manifest.json'), releaseId, artifactIdentity: `sha256:${'a'.repeat(64)}`, manifestSha256: 'c'.repeat(64), sourceCommit: wrongHead ? 'b'.repeat(40) : head }) }) })).toThrow(error);
  });

  test('stages and hashes browser/runtime sidecar artifacts beside immutable runtime executables', () => {
    const { root, controllerHome } = sourceFixture();
    const staged = stageRuntimeRelease({ controllerHome, sourceRoot: root }, {
      platform: 'linux',
      now: () => 1_700_000_000_000,
      uuid: () => 'release-test',
      compileBinary: ({ outputPath, entryPath }) => {
        const kind = entryPath?.endsWith('check-runner-sidecar.ts')
          ? 'check-runner-binary'
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
    expect(existsSync(join(staged.releasePath, 'browser-automation-helper'))).toBe(false);
    const externalPluginProbePath = join(staged.releasePath, 'external-unix-socket-probe.cjs');
    expect(existsSync(externalPluginProbePath)).toBe(true);
    expect(readFileSync(externalPluginProbePath, 'utf8')).toContain('probe');
    expect(staged.externalPluginProbeArtifactIdentity).toMatch(/^sha256:/);
    expect(existsSync(join(staged.releasePath, 'forge-desktop-helper.mjs'))).toBe(false);
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
    expect(manifest.desktopHelperEntrypoint).toBeUndefined();
    expect(manifest.desktopHelperArtifactIdentity).toBeUndefined();
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
    expect(existsSync(join(staged.releasePath, 'ui-dist', 'app.js'))).toBe(true);
    expect(existsSync(join(staged.releasePath, 'ui-dist', 'app.css'))).toBe(true);
    expect(readFileSync(join(staged.releasePath, 'ui-dist', 'app.js'), 'utf8')).toContain('console.log');
    expect(staged.controllerUiArtifactIdentity).toMatch(/^sha256:/);
    expect(manifest.controllerUiRoot).toBe('ui-dist');
    expect(manifest.controllerUiArtifactIdentity).toBe(staged.controllerUiArtifactIdentity);
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

  test('signs macOS Runtime before hashing and preserves one stable code identity across changed releases', () => {
    const { root, controllerHome } = sourceFixture();
    let runtimeBuild = 0;
    const materialize = (now: number) => stageRuntimeRelease({ controllerHome, sourceRoot: root }, {
      platform: 'darwin',
      now: () => now,
      uuid: () => `signed-${now}`,
      compileBinary: ({ outputPath, entryPath }) => {
        const isRuntime = entryPath?.endsWith('src/runtime/root/entry.ts');
        writeFileSync(outputPath, isRuntime ? `runtime-build-${++runtimeBuild}` : 'sidecar-binary');
        return { ok: true };
      },
      signMacOSRuntime: ({ executable }) => {
        writeFileSync(executable, `${readFileSync(executable, 'utf8')}|developer-id-signature`);
        return STABLE_MACOS_SIGNING;
      },
      bundleNodeHost: ({ outputPath }) => { writeFileSync(outputPath, 'node-host-bundle'); return { ok: true }; },
      bundleProcessRunner: ({ outputPath }) => { writeFileSync(outputPath, 'process-runner-bundle'); return { ok: true }; },
      materializeCodeGraphRuntime: materializeFakeCodeGraphRuntime,
    });

    const first = materialize(1_700_000_000_001);
    const second = materialize(1_700_000_000_002);
    expect(first.macosCodeSigning).toEqual(STABLE_MACOS_SIGNING);
    expect(second.macosCodeSigning).toEqual(STABLE_MACOS_SIGNING);
    expect(first.macosCodeSigning?.designatedRequirement).toBe(second.macosCodeSigning?.designatedRequirement);
    expect(first.artifactIdentity).toBe(`sha256:${sha256Text(readFileSync(join(first.releasePath, 'forge-runtime'), 'utf8'))}`);
    expect(second.artifactIdentity).toBe(`sha256:${sha256Text(readFileSync(join(second.releasePath, 'forge-runtime'), 'utf8'))}`);
    expect(first.artifactIdentity).not.toBe(second.artifactIdentity);
    const firstManifest = JSON.parse(readFileSync(first.manifestPath, 'utf8'));
    expect(firstManifest.macosCodeSigning).toEqual(STABLE_MACOS_SIGNING);
    expect(firstManifest.artifactIdentity).toBe(first.artifactIdentity);

    expect(() => assertRuntimeReleaseFiles(first, {
      platform: 'darwin',
      inspectMacOSRuntime: () => ({ ...STABLE_MACOS_SIGNING, teamIdentifier: 'AAAAAAAAAA', designatedRequirement: STABLE_MACOS_SIGNING.designatedRequirement.replaceAll('K848A29AJ5', 'AAAAAAAAAA') }),
    })).toThrow('RUNTIME_RELEASE_MACOS_SIGNING_MISMATCH');
  });

  test('rejects a macOS candidate that omits the stable signing contract', () => {
    const { root, controllerHome } = sourceFixture();
    const sourceCommit = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout.trim();
    const releaseId = `unsigned-${sourceCommit}`, releasePath = join(controllerHome, 'runtime', 'releases', releaseId);
    const runtime = 'unsigned-runtime', artifactIdentity = `sha256:${sha256Text(runtime)}`;
    mkdirSync(releasePath, { recursive: true });
    writeFileSync(join(releasePath, 'forge-runtime'), runtime);
    const manifestPath = join(releasePath, 'manifest.json');
    const manifestText = `${JSON.stringify({ schemaVersion: 1, releaseId, artifactIdentity, entrypoint: 'forge-runtime', arguments: [], configurationSchemaVersion: 1, controllerHome, databaseSchemaCompatibility: { minimum: 1, maximum: 1 }, workerProtocolVersion: 1, sourceCommit, createdAt: '2026-08-14T00:00:00.000Z' })}\n`;
    writeFileSync(manifestPath, manifestText);
    expect(() => stageRuntimeReleaseFromCandidateSource({ controllerHome, sourceRoot: root }, {
      platform: 'darwin',
      runCandidateStager: () => ({ ok: true, stdout: JSON.stringify({ schemaVersion: 1, releasePath, manifestPath, releaseId, artifactIdentity, manifestSha256: sha256Text(manifestText), sourceCommit }) }),
    })).toThrow('RUNTIME_RELEASE_CANDIDATE_MACOS_SIGNING_REQUIRED');
  });

  test('keeps legacy Browser Automation helper fields parseable for rollback compatibility', () => {
    const { root, controllerHome } = sourceFixture();
    const manifestPath = join(root, 'legacy-browser-automation-helper-manifest.json');
    writeFileSync(manifestPath, `${JSON.stringify({
      schemaVersion: 1, releaseId: 'release-legacy-browser-helper', artifactIdentity: 'sha256:runtime', entrypoint: 'forge-runtime',
      browserAutomationHelperEntrypoint: 'browser-automation-helper', browserAutomationHelperArtifactIdentity: `sha256:${'a'.repeat(64)}`,
      browserAutomationHelperContractIdentity: `sha256:${'b'.repeat(64)}`, arguments: [], configurationSchemaVersion: 1, controllerHome,
      databaseSchemaCompatibility: { minimum: 1, maximum: 1 }, workerProtocolVersion: 1, createdAt: new Date().toISOString(),
    }, null, 2)}\n`);
    expect(loadRuntimeReleaseManifest(manifestPath, controllerHome)).toMatchObject({
      browserAutomationHelperEntrypoint: 'browser-automation-helper',
      browserAutomationHelperArtifactIdentity: `sha256:${'a'.repeat(64)}`,
      browserAutomationHelperContractIdentity: `sha256:${'b'.repeat(64)}`,
    });
  });

  test('rejects a partial Browser Automation helper declaration in an immutable release manifest', () => {
    const { root, controllerHome } = sourceFixture();
    const manifestPath = join(root, 'partial-browser-automation-helper-manifest.json');
    writeFileSync(manifestPath, `${JSON.stringify({
      schemaVersion: 1,
      releaseId: 'release-partial-browser-helper',
      artifactIdentity: 'sha256:runtime',
      entrypoint: 'forge-runtime',
      browserAutomationHelperEntrypoint: 'browser-automation-helper',
      arguments: [],
      configurationSchemaVersion: 1,
      controllerHome,
      databaseSchemaCompatibility: { minimum: 1, maximum: 1 },
      workerProtocolVersion: 1,
      createdAt: new Date().toISOString(),
    }, null, 2)}\n`);
    expect(() => loadRuntimeReleaseManifest(manifestPath, controllerHome))
      .toThrow('browserAutomationHelperArtifactIdentity is required');
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
      platform: 'linux',
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

  test('release assertion fails closed when the declared Browser handoff host is missing', () => {
    const { root, controllerHome } = sourceFixture();
    const staged = stageRuntimeRelease({ controllerHome, sourceRoot: root }, {
      platform: 'linux',
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
