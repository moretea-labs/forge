import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { readFirstPartyDesignKnowledge } from '../../src/runtime/context/first-party-design-knowledge';

const root = resolve(import.meta.dir, '../..');
const manifest = JSON.parse(readFileSync(resolve(root, 'assets/knowledge-packs/v1/manifest.json'), 'utf8')) as {
  schemaVersion: number;
  packVersion: string;
  packages: Array<{ id: string; path: string; sha256: string; authority: string; pluginRequired: boolean; sourceProvenance: string[] }>;
};

describe('first-party Design knowledge package', () => {
  test('tracks its canonical content and source without requiring Forge Design plugin', () => {
    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.packVersion).toBe('v1');
    expect(manifest.packages.map(entry => entry.id)).toEqual(['design-ui-ux']);
    const entry = manifest.packages[0]!;
    expect(entry.path).toBe('assets/knowledge-packs/v1/design-ui-ux.md');
    expect(entry.authority).toBe('advisory');
    expect(entry.pluginRequired).toBe(false);
    expect(entry.sourceProvenance.length).toBeGreaterThanOrEqual(3);
    const content = readFileSync(resolve(root, entry.path));
    expect(createHash('sha256').update(content).digest('hex')).toBe(entry.sha256);
    const text = content.toString('utf8');
    for (const required of [
      'User Job', 'Optical centering differs from geometry',
      'Visual Reviewed', 'frozen', 'real rendered screen',
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

  test('fails visibly on corrupt or path-forged manifests; never follows an injected path', () => {
    const fakeRoot = mkdtempSync(resolve(tmpdir(), 'forge-design-asset-'));
    const base = resolve(fakeRoot, 'assets/knowledge-packs/v1');
    try {
      mkdirSync(base, { recursive: true });
      const manifestPath = resolve(base, 'manifest.json');
      const original = manifest.packages[0]!;
      writeFileSync(manifestPath, 'null');
      expect(readFirstPartyDesignKnowledge(fakeRoot).reason).toBe('manifest_invalid');
      writeFileSync(manifestPath, JSON.stringify({ ...manifest, packages: [{ ...original, path: '../../outside.md' }] }));
      expect(readFirstPartyDesignKnowledge(fakeRoot).reason).toBe('manifest_invalid');
      writeFileSync(manifestPath, JSON.stringify(manifest));
      writeFileSync(resolve(base, 'design-ui-ux.md'), 'modified content');
      expect(readFirstPartyDesignKnowledge(fakeRoot).reason).toBe('digest_mismatch');
    } finally {
      rmSync(fakeRoot, { recursive: true, force: true });
    }
  });
});
