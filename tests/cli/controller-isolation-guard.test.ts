import { afterEach, describe, expect, test } from 'bun:test';
import { join } from 'path';
import { homedir, tmpdir } from 'os';
import {
  assertIsolatedControllerEnv,
  createIsolatedControllerFixture,
  destroyAllIsolatedControllerFixtures,
  isolatedControllerEnv,
} from '../fixtures/isolated-controller-home';

afterEach(async () => {
  await destroyAllIsolatedControllerFixtures();
});

describe('controller isolation guards (level 1)', () => {
  test('fixture controllerHome is under temp and not the real home', async () => {
    const fixture = await createIsolatedControllerFixture();
    expect(fixture.controllerHome.startsWith(tmpdir()) || fixture.controllerHome.includes('/T/')).toBe(true);
    expect(fixture.controllerHome).not.toBe(join(homedir(), '.forge', 'controller'));
    expect(fixture.mcpPort).not.toBe(8765);
    expect(fixture.localControllerPort).not.toBe(8766);
    assertIsolatedControllerEnv(fixture.controllerHome);
    const env = isolatedControllerEnv(fixture);
    expect(env.FORGE_CONTROLLER_HOME).toBe(fixture.controllerHome);
    expect(env.FORGE_CONTROLLER_EXTERNAL_TUNNEL).toBe('none');
  });

  test('assertIsolatedControllerEnv rejects user global home', () => {
    const real = join(homedir(), '.forge', 'controller');
    expect(() => assertIsolatedControllerEnv(real)).toThrow(/TEST_GUARD/);
  });
});
