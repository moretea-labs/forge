import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  readFirstPartyDesignKnowledge,
  readFirstPartyIosEngineeringKnowledge,
  resolveFirstPartyKnowledgePackageRoot,
} from '../../src/runtime/context/first-party-design-knowledge';

const root = resolve(import.meta.dir, '../..');
const manifest = JSON.parse(readFileSync(resolve(root, 'assets/knowledge-packs/v1/manifest.json'), 'utf8')) as {
  schemaVersion: number;
  packVersion: string;
  packages: Array<{
    id: string;
    path: string;
    sha256: string;
    authority: string;
    pluginRequired: boolean;
    sourceProvenance: string[];
  }>;
};

describe('first-party Design knowledge package', () => {
  test('tracks its canonical content and source without requiring Forge Design plugin', () => {
    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.packVersion).toBe('v1');
    expect(manifest.packages.map((entry) => entry.id)).toEqual(['design-ui-ux', 'ios-engineering']);
    const entry = manifest.packages[0]!;
    expect(entry.path).toBe('assets/knowledge-packs/v1/design-ui-ux.md');
    expect(entry.authority).toBe('advisory');
    expect(entry.pluginRequired).toBe(false);
    expect(entry.sourceProvenance.length).toBeGreaterThanOrEqual(3);
    const content = readFileSync(resolve(root, entry.path));
    expect(createHash('sha256').update(content).digest('hex')).toBe(entry.sha256);
    const text = content.toString('utf8');
    for (const required of [
      'User Job',
      'Optical centering differs from geometry',
      'Visual Reviewed',
      'frozen',
      'real rendered screen',
      'project-specific source is still sovereign',
    ]) {
      expect(text).toContain(required);
    }
  });

  test('loads a digest-verified packaged body and its original provenance', () => {
    const result = readFirstPartyDesignKnowledge();
    expect(result.status).toBe('ready');
    expect(result.digest).toBe(`sha256:${manifest.packages[0]!.sha256}`);
    expect(result.content).toContain('Optical centering differs from geometry');
    expect(result.sourceProvenance).toContain('moretea-labs/forge-design:docs/PRODUCT_DESIGN_WORKFLOW.md');
    expect(result.truncated).toBe(false);
  });

  test('pins iOS Engineering separately from Design while using the same verified loader', () => {
    const entry = manifest.packages.find((pack) => pack.id === 'ios-engineering')!;
    const content = readFileSync(resolve(root, entry.path), 'utf8');
    expect(entry.path).toBe('assets/knowledge-packs/v1/ios-engineering.md');
    expect(entry.authority).toBe('advisory');
    expect(entry.pluginRequired).toBe(false);
    expect(createHash('sha256').update(content).digest('hex')).toBe(entry.sha256);
    const ios = readFirstPartyIosEngineeringKnowledge();
    expect(ios).toMatchObject({
      id: 'ios-engineering',
      status: 'ready',
      source: 'forge_first_party',
      digest: `sha256:${entry.sha256}`,
      truncated: false,
    });
    expect(ios.sourceProvenance).toContain('moretea-labs/forge:docs/architecture/CURRENT.md');
    expect(ios.content).toContain('Simulator build is not a physical-device build');
    expect(ios.content).toContain('Optical centering is not proof');
  });

  test('resolves packaged assets from FORGE_RELEASE_PATH when import.meta no longer sits beside assets (#640)', () => {
    const releaseRoot = mkdtempSync(resolve(tmpdir(), 'forge-design-release-'));
    const packageRoot = join(releaseRoot, 'package');
    const assetDir = join(packageRoot, 'assets', 'knowledge-packs', 'v1');
    try {
      mkdirSync(assetDir, { recursive: true });
      for (const name of ['manifest.json', 'design-ui-ux.md', 'ios-engineering.md']) {
        copyFileSync(resolve(root, 'assets/knowledge-packs/v1', name), join(assetDir, name));
      }
      const orphanModuleUrl = pathToFileURL(
        join(releaseRoot, 'compiled', 'context', 'first-party-design-knowledge.js'),
      ).href;
      const resolved = resolveFirstPartyKnowledgePackageRoot({ FORGE_RELEASE_PATH: releaseRoot }, orphanModuleUrl);
      expect(resolved).toBe(packageRoot);
      expect(readFirstPartyDesignKnowledge(resolved)).toMatchObject({
        status: 'ready',
        digest: `sha256:${manifest.packages[0]!.sha256}`,
      });
      expect(readFirstPartyIosEngineeringKnowledge(resolved).status).toBe('ready');
      // Without the release env, an orphan compiled module path must not invent a ready pack.
      expect(resolveFirstPartyKnowledgePackageRoot({}, orphanModuleUrl)).not.toBe(packageRoot);
    } finally {
      rmSync(releaseRoot, { recursive: true, force: true });
    }
  });

  test('fails visibly on corrupt or path-forged manifests; never follows an injected path', () => {
    const fakeRoot = mkdtempSync(resolve(tmpdir(), 'forge-design-asset-'));
    const base = resolve(fakeRoot, 'assets/knowledge-packs/v1');
    try {
      mkdirSync(base, { recursive: true });
      const manifestPath = resolve(base, 'manifest.json');
      const original = manifest.packages[0]!;
      writeFileSync(manifestPath, 'null');
      expect(readFirstPartyDesignKnowledge(fakeRoot).reason).toBe('manifest_invalid');
      writeFileSync(
        manifestPath,
        JSON.stringify({ ...manifest, packages: [{ ...original, path: '../../outside.md' }] }),
      );
      expect(readFirstPartyDesignKnowledge(fakeRoot).reason).toBe('manifest_invalid');
      writeFileSync(manifestPath, JSON.stringify(manifest));
      writeFileSync(resolve(base, 'design-ui-ux.md'), 'modified content');
      expect(readFirstPartyDesignKnowledge(fakeRoot).reason).toBe('digest_mismatch');
      // A forged ios-engineering path must never be opened. A tampered
      // iOS body must be detected independently of the Design pack.
      const iosEntry = manifest.packages.find((pack) => pack.id === 'ios-engineering')!;
      writeFileSync(
        manifestPath,
        JSON.stringify({
          ...manifest,
          packages: [{ ...iosEntry, path: '../../outside-ios.md' }],
        }),
      );
      expect(readFirstPartyIosEngineeringKnowledge(fakeRoot).reason).toBe('manifest_invalid');
      writeFileSync(manifestPath, JSON.stringify(manifest));
      writeFileSync(resolve(base, 'ios-engineering.md'), 'modified iOS body');
      expect(readFirstPartyIosEngineeringKnowledge(fakeRoot).reason).toBe('digest_mismatch');
    } finally {
      rmSync(fakeRoot, { recursive: true, force: true });
    }
  });
});
