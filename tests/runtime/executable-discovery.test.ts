import { describe, expect, test } from 'bun:test';
import { discoverExecutable } from '../../src/runtime/platform/executable-discovery';

describe('platform executable discovery', () => {
  test('resolves PATH candidates without shell execution', () => {
    const result = discoverExecutable({
      id: 'tool', candidates: ['tool'], platform: 'linux', env: { PATH: '/opt/bin:/usr/bin' },
      fileExists: (path) => path === '/opt/bin/tool',
    });
    expect(result).toEqual({ id: 'tool', status: 'ready', executable: '/opt/bin/tool', source: 'path' });
  });

  test('distinguishes unsupported from missing and preserves a precise recovery action', () => {
    expect(discoverExecutable({ id: 'brew', candidates: ['brew'], platform: 'linux', supportedPlatforms: ['darwin'], recovery: 'Use native package management.' }))
      .toEqual({ id: 'brew', status: 'unsupported', recovery: 'Use native package management.' });
    expect(discoverExecutable({ id: 'cloudflared', candidates: ['cloudflared'], platform: 'linux', env: { PATH: '/usr/bin' }, fileExists: () => false, recovery: 'Install cloudflared.' }))
      .toEqual({ id: 'cloudflared', status: 'missing', recovery: 'Install cloudflared.' });
  });
});
