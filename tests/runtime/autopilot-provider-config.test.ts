import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { readAutopilotProviderApiKey, readAutopilotProviderProfile } from '../../src/runtime/autopilot/provider-config';

function fixtureHome(): string {
  return mkdtempSync(join(tmpdir(), 'forge-autopilot-provider-v2-'));
}

test('reads the schema-v2 Desktop default API profile used by the current Client', () => {
  const home = fixtureHome();
  try {
    const profileDir = join(home, 'Library', 'Application Support', 'com.moretea.forge.desktop');
    mkdirSync(profileDir, { recursive: true });
    writeFileSync(
      join(profileDir, 'local-api.json'),
      JSON.stringify({
        schemaVersion: 2,
        defaultProvider: 'api:deepseek-zro',
        apiProfiles: [
          {
            id: 'deepseek-zro',
            label: 'DeepSeek · Zro',
            endpoint: 'https://zro.moonmath.ai/v1',
            model: 'deepseek-v4.1-flash',
            apiProtocol: 'openai',
            credentialRef: 'managed-fixture-ref',
          },
        ],
        joyCodeModel: 'JoyAI-Code-1.6',
      }),
    );

    expect(readAutopilotProviderProfile(home)).toEqual({
      provider: 'deepseek',
      endpoint: 'https://zro.moonmath.ai/v1',
      protocol: 'chat_completions',
      model: 'deepseek-v4.1-flash',
      source: 'desktop-local-api',
    });

    const zroDir = join(home, '.config', 'zro');
    mkdirSync(zroDir, { recursive: true });
    const fixtureKey = ['fixture', 'zro', 'v2', 'key'].join('-');
    writeFileSync(join(zroDir, 'credentials.json'), JSON.stringify({ apiKey: fixtureKey }));
    expect(readAutopilotProviderApiKey('https://zro.moonmath.ai/v1', {}, home)).toBe(fixtureKey);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('uses the selected schema-v2 profile instead of the first API profile', () => {
  const home = fixtureHome();
  try {
    const profileDir = join(home, 'Library', 'Application Support', 'com.moretea.forge.desktop');
    mkdirSync(profileDir, { recursive: true });
    writeFileSync(
      join(profileDir, 'local-api.json'),
      JSON.stringify({
        schemaVersion: 2,
        defaultProvider: 'api:selected',
        apiProfiles: [
          {
            id: 'other',
            endpoint: 'https://example.invalid/v1',
            model: 'other-model',
            apiProtocol: 'responses',
          },
          {
            id: 'selected',
            endpoint: 'https://zro.moonmath.ai/v1',
            model: 'selected-model',
            apiProtocol: 'openai',
          },
        ],
      }),
    );

    expect(readAutopilotProviderProfile(home)).toMatchObject({
      endpoint: 'https://zro.moonmath.ai/v1',
      protocol: 'chat_completions',
      model: 'selected-model',
      source: 'desktop-local-api',
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
