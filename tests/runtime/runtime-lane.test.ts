import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { inspectControlPlaneDatabase } from '../../src/runtime/control-plane/persistence/sqlite-store';
import { forgeRuntimeServicePaths, writeForgeRuntimeServiceConfig } from '../../src/runtime/root/service';
import {
  createCandidateExecutionLane,
  planCandidateExecutionLane,
  readStableExecutionLane,
  removeRetiredCandidateExecutionLane,
} from '../../src/runtime/root/runtime-lane';

const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

function stableFixture(): { root: string; stableHome: string } {
  const root = mkdtempSync(join(tmpdir(), 'forge-runtime-lane-'));
  roots.push(root);
  const stableHome = join(root, 'stable-controller');
  const repositoryRoot = join(root, 'source');
  const authTokenFile = join(stableHome, 'mcp', 'runtime-token');
  inspectControlPlaneDatabase(stableHome);
  mkdirSync(repositoryRoot, { recursive: true });
  mkdirSync(join(stableHome, 'mcp'), { recursive: true });
  writeFileSync(authTokenFile, 'stable-token\n', { mode: 0o600 });
  writeForgeRuntimeServiceConfig({
    schemaVersion: 1,
    controllerHome: stableHome,
    repositoryRoot,
    host: '127.0.0.1',
    port: 8765,
    authTokenFile,
  });
  return { root, stableHome };
}

describe('Stable A and Candidate B execution lanes', () => {
  test('derives a distinct Candidate B identity without writing or launching anything', () => {
    const fx = stableFixture();
    const stable = readStableExecutionLane(fx.stableHome);
    const candidateHome = join(fx.root, 'candidate-controller');

    const candidate = planCandidateExecutionLane({
      stable,
      candidateControllerHome: candidateHome,
      candidatePort: 8766,
      sessionId: 'release-session-12345678',
    });

    expect(candidate.controllerHome).toBe(resolve(candidateHome));
    expect(candidate.serviceLabel).not.toBe(stable.serviceLabel);
    expect(candidate.port).toBe(8766);
    expect(existsSync(candidateHome)).toBe(false);
  });

  test('creates only an isolated SQLite snapshot and service/token contract for Candidate B', () => {
    const fx = stableFixture();
    const candidateHome = join(fx.root, 'candidate-controller');
    const result = createCandidateExecutionLane({
      stableControllerHome: fx.stableHome,
      candidateControllerHome: candidateHome,
      candidatePort: 8766,
      sessionId: 'release-session-12345678',
    });

    expect(result.database.path).toBe(join(candidateHome, 'control-plane.sqlite'));
    expect(existsSync(result.candidate.databaseSnapshotPath)).toBe(true);
    expect(existsSync(join(candidateHome, 'runtime', 'releases', 'authority.json'))).toBe(false);
    expect(readFileSync(result.candidate.authTokenFile, 'utf8')).not.toBe('stable-token\n');
    expect(readFileSync(result.candidate.authTokenFile, 'utf8').trim().length).toBeGreaterThanOrEqual(32);
    const candidateConfig = JSON.parse(readFileSync(forgeRuntimeServicePaths(candidateHome).configPath, 'utf8'));
    expect(candidateConfig).toEqual({
      controllerHome: resolve(candidateHome),
      port: 8766,
      authTokenFile: result.candidate.authTokenFile,
      schemaVersion: 1,
      repositoryRoot: join(fx.root, 'source'),
      host: '127.0.0.1',
      topology: {
        schemaVersion: 1,
        remoteControllers: ['chatgpt'],
        capabilityIntents: [],
        persistentRuntimeRequired: true,
        components: {
          workflowSupervisor: true,
          workflowSupervisorNativeBrowser: false,
        },
      },
    });
  });

  test('rejects any Candidate identity that would share Stable A authority', () => {
    const fx = stableFixture();
    const stable = readStableExecutionLane(fx.stableHome);
    expect(() => planCandidateExecutionLane({
      stable,
      candidateControllerHome: fx.stableHome,
      candidatePort: 8766,
      sessionId: 'release-session-12345678',
    })).toThrow('RUNTIME_CANDIDATE_CONTROLLER_HOME_COLLIDES_WITH_STABLE');
    expect(() => planCandidateExecutionLane({
      stable,
      candidateControllerHome: join(fx.root, 'candidate-controller'),
      candidatePort: 8765,
      sessionId: 'release-session-12345678',
    })).toThrow('RUNTIME_CANDIDATE_PORT_COLLIDES_WITH_STABLE');
  });

  test('removes only a retired Candidate B home fenced to its session lane', () => {
    const fx = stableFixture();
    const stable = readStableExecutionLane(fx.stableHome);
    const candidateHome = join(fx.root, 'candidate-runtime-lanes', 'release-session-12345678');
    const candidate = planCandidateExecutionLane({
      stable,
      candidateControllerHome: candidateHome,
      candidatePort: 8766,
      sessionId: 'release-session-12345678',
    });
    mkdirSync(join(candidateHome, 'runtime'), { recursive: true });
    writeFileSync(join(candidateHome, 'runtime', 'marker'), 'candidate');

    removeRetiredCandidateExecutionLane(stable, candidate);

    expect(existsSync(candidateHome)).toBe(false);
    expect(() => removeRetiredCandidateExecutionLane(stable, {
      ...candidate,
      controllerHome: join(fx.root, 'other', candidate.sessionId),
    })).toThrow('RUNTIME_CANDIDATE_CLEANUP_PATH_INVALID');
  });
});
