import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { installerNextSteps } from '../../src/cli/commands/plugin';

describe('official plugin catalog', () => {
  test('includes the pinned Forge Figma Bridge release', () => {
    const registry = JSON.parse(readFileSync(resolve(import.meta.dir, '../../assets/plugin-registry.v1.json'), 'utf8')) as { plugins: Array<Record<string, unknown>> };
    const figma = registry.plugins.find((entry) => entry.id === 'figma');
    expect(figma).toMatchObject({
      id: 'figma', version: '0.1.1', ref: 'v0.1.1', installer: 'forge-plugin-install.mjs',
      repository: 'https://github.com/moretea-labs/forge-figma-bridge.git', platforms: ['darwin'],
    });
  });

  test('bounds installer follow-up instructions before printing them', () => {
    expect(installerNextSteps({ nextSteps: ['  Open Figma\nDesktop  ', 4, '', ...Array.from({ length: 20 }, (_, i) => `step-${i}`)] })).toEqual([
      'Open Figma Desktop', 'step-0', 'step-1', 'step-2', 'step-3', 'step-4', 'step-5', 'step-6', 'step-7', 'step-8',
    ]);
    expect(installerNextSteps({ nextSteps: 'not-an-array' })).toEqual([]);
  });
});
