import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

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
});
