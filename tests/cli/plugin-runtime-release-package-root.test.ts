import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { pathToFileURL } from 'url';
import { resolveOfficialPluginPackageRoot } from '../../src/cli/commands/plugin';
import { CONTROL_PLANE_SCHEMA_VERSION } from '../../src/runtime/control-plane/persistence/sqlite-store';

const roots:string[]=[];
afterEach(()=>{while(roots.length)rmSync(roots.pop()!,{recursive:true,force:true});});

describe('official plugin package root',()=>{
  test('keeps the source/install module-relative root when no Runtime release manifest is active',()=>{
    const moduleUrl=pathToFileURL('/tmp/forge-source/src/cli/commands/plugin.ts').href;
    expect(resolveOfficialPluginPackageRoot(['bun','forge'],moduleUrl)).toBe(resolve('/tmp/forge-source'));
  });

  test('uses the manifest-owned package snapshot inside a bundled immutable Runtime release',()=>{
    const controllerHome=mkdtempSync(join(tmpdir(),'forge-plugin-release-root-'));
    roots.push(controllerHome);
    const releaseRoot=join(controllerHome,'runtime','releases','release-test');
    const packageRoot=join(releaseRoot,'package');
    mkdirSync(packageRoot,{recursive:true});
    const manifestPath=join(releaseRoot,'manifest.json');
    writeFileSync(manifestPath,JSON.stringify({
      schemaVersion:1,
      releaseId:'release-test',
      artifactIdentity:`sha256:${'a'.repeat(64)}`,
      entrypoint:'forge-runtime',
      packageRoot:'package',
      packageArtifactIdentity:`sha256:${'b'.repeat(64)}`,
      arguments:[],
      configurationSchemaVersion:1,
      deploymentScope:'portable',
      databaseSchemaCompatibility:{minimum:CONTROL_PLANE_SCHEMA_VERSION,maximum:CONTROL_PLANE_SCHEMA_VERSION},
      workerProtocolVersion:1,
      createdAt:'2026-11-24T00:00:00.000Z',
    }));

    expect(resolveOfficialPluginPackageRoot([
      'forge-runtime-bun',
      join(releaseRoot,'forge-runtime-bundle.js'),
      '--controller-home',controllerHome,
      '--release-manifest',manifestPath,
    ])).toBe(packageRoot);
  });
});
