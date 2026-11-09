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

  test('discovers macOS user tools when a service process has a minimal PATH', () => {
    const local = discoverExecutable({
      id: 'tunnel-client',
      candidates: ['tunnel-client'],
      platform: 'darwin',
      env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: '/Users/greyson' },
      fileExists: (path) => path === '/Users/greyson/.local/bin/tunnel-client',
    });
    expect(local).toEqual({
      id: 'tunnel-client',
      status: 'ready',
      executable: '/Users/greyson/.local/bin/tunnel-client',
      source: 'path',
    });

    const homebrew = discoverExecutable({
      id: 'tunnel-client',
      candidates: ['tunnel-client'],
      platform: 'darwin',
      env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: '/Users/greyson' },
      fileExists: (path) => path === '/opt/homebrew/bin/tunnel-client',
    });
    expect(homebrew).toEqual({
      id: 'tunnel-client',
      status: 'ready',
      executable: '/opt/homebrew/bin/tunnel-client',
      source: 'path',
    });
  });

  test('distinguishes unsupported from missing and preserves a precise recovery action', () => {
    expect(discoverExecutable({ id: 'brew', candidates: ['brew'], platform: 'linux', supportedPlatforms: ['darwin'], recovery: 'Use native package management.' }))
      .toEqual({ id: 'brew', status: 'unsupported', recovery: 'Use native package management.' });
    expect(discoverExecutable({ id: 'cloudflared', candidates: ['cloudflared'], platform: 'linux', env: { PATH: '/usr/bin' }, fileExists: () => false, recovery: 'Install cloudflared.' }))
      .toEqual({ id: 'cloudflared', status: 'missing', recovery: 'Install cloudflared.' });
  });
});
