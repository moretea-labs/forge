import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { spawnSync } from 'child_process';
import type { McpPolicy } from '../../src/cli/mcp/types';
import { buildControllerContextPack } from '../../src/cli/controller/context-pack';
import { controllerCheckSelection, listControllerChecks } from '../../src/cli/controller/check-runner';
import {
  GOVERNANCE_EXCEPTIONS_PATH,
  GOVERNANCE_MAX_SOURCE_BYTES,
  GOVERNANCE_MAX_SOURCE_BYTES_PER_FILE,
  GOVERNANCE_MAX_SOURCE_FILES,
  GOVERNANCE_RULES_PATH,
  resolveRepositoryGovernance,
} from '../../src/cli/controller/context/rule-resolution';

const roots: string[] = [];

const POLICY: McpPolicy = {
  profile: 'controller',
  readGlobs: ['**'],
  writeGlobs: ['**'],
  denyGlobs: [],
  maxFileBytes: 1024 * 1024,
  execution: {
    fixedWorkflowCheck: false,
    codexRunner: false,
    agentRunner: false,
    allowedAgents: [],
    runnerTimeoutMs: 60_000,
    runnerMaxTimeoutMs: 60_000,
  },
};

function repo(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), `${prefix}-`));
  roots.push(root);
  mkdirSync(join(root, '.ai/context'), { recursive: true });
  spawnSync('git', ['init', '-q'], { cwd: root });
  return root;
}

function writeJson(root: string, path: string, value: unknown): void {
  const absolute = join(root, path);
  mkdirSync(join(absolute, '..'), { recursive: true });
  writeFileSync(absolute, `${JSON.stringify(value, null, 2)}\n`);
}

function writeRules(root: string, rules: unknown[], exceptions: unknown[] = []): void {
  writeJson(root, GOVERNANCE_RULES_PATH, { version: 1, rules });
  writeJson(root, GOVERNANCE_EXCEPTIONS_PATH, { version: 1, exceptions });
}

function notificationRule(checkId = 'package:check:notify-architecture') {
  return {
    id: 'IOS-NOTIFY-001',
    title: 'Notification platform access boundary',
    level: 'capability',
    lifecycle: 'active',
    severity: 'error',
    invariant: 'Platform notification mutation stays behind the notification ownership boundary.',
    activation: {
      match: 'all',
      paths: ['ios/**'],
      symbols: ['UNUserNotificationCenter'],
    },
    validation: { checkIds: [checkId] },
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('repository governance resolution', () => {
  test('keeps repositories without a rule registry on the existing minimal path and does not parse exceptions', () => {
    const root = repo('forge-governance-none');
    writeFileSync(join(root, GOVERNANCE_EXCEPTIONS_PATH), '{ invalid json');
    const result = resolveRepositoryGovernance(root, POLICY, { targetPaths: ['src/app.ts'] });
    expect(result.status).toBe('none');
    expect(result.activeRules).toEqual([]);
    expect(result.metrics.filesScanned).toBe(0);
    expect(result.recommendedCheckIds).toEqual([]);
  });

  test('re-resolves current source so a symbol introduced after editing activates a rule and recommends but does not execute its check', () => {
    const root = repo('forge-governance-post-edit');
    mkdirSync(join(root, 'ios/Features/Profile'), { recursive: true });
    writeFileSync(join(root, 'ios/Features/Profile/ProfileView.swift'), 'struct ProfileView {}\n');
    writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: { 'check:notify-architecture': 'echo should-not-run-during-context' } }, null, 2));
    writeRules(root, [notificationRule()]);

    const before = buildControllerContextPack(root, POLICY, {
      description: 'Update the profile view',
      knownPaths: ['ios/Features/Profile/ProfileView.swift'],
      structuralContext: 'off',
      maxFiles: 4,
      maxSnippets: 8,
    });
    expect(before.governanceContext.activeRules).toHaveLength(0);
    expect(before.governanceContext.recommendedChecks).toHaveLength(0);

    writeFileSync(
      join(root, 'ios/Features/Profile/ProfileView.swift'),
      'import UserNotifications\nstruct ProfileView { func f() { _ = UNUserNotificationCenter.current() } }\n',
    );
    const after = buildControllerContextPack(root, POLICY, {
      description: 'Update the profile view',
      knownPaths: ['ios/Features/Profile/ProfileView.swift'],
      structuralContext: 'off',
      maxFiles: 4,
      maxSnippets: 8,
    });
    expect(after.governanceContext.activeRules.map((rule) => rule.id)).toEqual(['IOS-NOTIFY-001']);
    expect(after.governanceContext.activeRules[0]?.matchedSignals.some((signal) => signal.includes('symbol:UNUserNotificationCenter'))).toBe(true);
    expect(after.governanceContext.recommendedChecks).toEqual([
      expect.objectContaining({ checkId: 'package:check:notify-architecture', available: true, costClass: 'L1', phases: ['post_edit'] }),
    ]);
    expect(after.validation.checks).toEqual([]);
  });

  test('requires all path-local activation criteria to co-occur on the same evidence path', () => {
    const root = repo('forge-governance-cross-file');
    mkdirSync(join(root, 'ios/Features/Profile'), { recursive: true });
    mkdirSync(join(root, 'server'), { recursive: true });
    writeFileSync(join(root, 'ios/Features/Profile/ProfileView.swift'), 'struct ProfileView {}\n');
    writeFileSync(join(root, 'server/worker.ts'), 'const x = "UNUserNotificationCenter";\n');
    writeRules(root, [notificationRule()]);

    const result = resolveRepositoryGovernance(root, POLICY, {
      targetPaths: ['ios/Features/Profile/ProfileView.swift', 'server/worker.ts'],
    });
    expect(result.activeRules).toHaveLength(0);
    expect(result.recommendedCheckIds).toEqual([]);
  });

  test('applies scoped exceptions only to covered evidence and keeps invalid or expired exceptions from suppressing the rule', () => {
    const root = repo('forge-governance-exceptions');
    for (const path of ['ios/Legacy/Legacy.swift', 'ios/Features/New/New.swift']) {
      mkdirSync(join(root, path, '..'), { recursive: true });
      writeFileSync(join(root, path), 'UNUserNotificationCenter.current()\n');
    }
    writeRules(root, [notificationRule()], [
      {
        id: 'EX-LEGACY',
        ruleId: 'IOS-NOTIFY-001',
        paths: ['ios/Legacy/**'],
        reason: 'Legacy migration window',
        owner: 'ios',
        expiresAt: '2026-12-01T00:00:00.000Z',
      },
      {
        id: 'EX-EXPIRED',
        ruleId: 'IOS-NOTIFY-001',
        paths: ['ios/Features/**'],
        reason: 'Expired experiment',
        expiresAt: '2026-01-01T00:00:00.000Z',
      },
      {
        id: 'EX-INVALID-EXPIRY',
        ruleId: 'IOS-NOTIFY-001',
        paths: ['ios/Features/**'],
        reason: 'Malformed expiry must fail safe',
        expiresAt: 'not-a-date',
      },
    ]);
    const result = resolveRepositoryGovernance(root, POLICY, {
      targetPaths: ['ios/Legacy/Legacy.swift', 'ios/Features/New/New.swift'],
      now: new Date('2026-08-26T00:00:00.000Z'),
    });
    expect(result.activeRules).toHaveLength(1);
    expect(result.activeRules[0]?.matchedPaths).toEqual(['ios/Features/New/New.swift']);
    expect(result.activeRules[0]?.suppressedPaths).toEqual(['ios/Legacy/Legacy.swift']);
    expect(result.activeRules[0]?.partialExceptionIds).toEqual(['EX-LEGACY']);
    expect(result.expiredExceptionIds).toEqual(['EX-EXPIRED']);
    expect(result.coverageGaps).toContain('governance_exception_invalid_expiry:EX-INVALID-EXPIRY');

    const legacyOnly = resolveRepositoryGovernance(root, POLICY, {
      targetPaths: ['ios/Legacy/Legacy.swift'],
      now: new Date('2026-08-26T00:00:00.000Z'),
    });
    expect(legacyOnly.activeRules).toHaveLength(0);
    expect(legacyOnly.suppressedRules).toEqual([expect.objectContaining({ id: 'IOS-NOTIFY-001', exceptionIds: ['EX-LEGACY'] })]);
  });

  test('reads only a bounded prefix of large source files and reports truncation instead of skipping the file', () => {
    const root = repo('forge-governance-large-source');
    const path = 'ios/Large.swift';
    mkdirSync(join(root, 'ios'), { recursive: true });
    writeFileSync(join(root, path), `UNUserNotificationCenter.current()\n${'x'.repeat(GOVERNANCE_MAX_SOURCE_BYTES_PER_FILE + 4096)}`);
    writeRules(root, [notificationRule()]);

    const result = resolveRepositoryGovernance(root, POLICY, { targetPaths: [path] });
    expect(result.activeRules.map((rule) => rule.id)).toEqual(['IOS-NOTIFY-001']);
    expect(result.metrics.bytesScanned).toBeLessThanOrEqual(GOVERNANCE_MAX_SOURCE_BYTES_PER_FILE);
    expect(result.coverageGaps).toContain(`governance_source_truncated:${path}`);
  });

  test('hard-bounds source scanning instead of turning governance into another repository-wide analysis pass', () => {
    const root = repo('forge-governance-bounds');
    const paths: string[] = [];
    for (let index = 0; index < GOVERNANCE_MAX_SOURCE_FILES + 20; index += 1) {
      const path = `src/file-${index}.ts`;
      paths.push(path);
      mkdirSync(join(root, 'src'), { recursive: true });
      writeFileSync(join(root, path), 'export const value = 1;\n'.repeat(300));
    }
    writeRules(root, [{
      id: 'SCAN-BOUND-001',
      title: 'Bounded symbol scan',
      level: 'kernel',
      lifecycle: 'active',
      severity: 'warning',
      invariant: 'Governance source inspection remains bounded.',
      activation: { symbols: ['NeverPresentGovernanceSymbol'] },
      validation: { checkIds: [] },
    }]);
    const result = resolveRepositoryGovernance(root, POLICY, { targetPaths: paths });
    expect(result.metrics.filesScanned).toBeLessThanOrEqual(GOVERNANCE_MAX_SOURCE_FILES);
    expect(result.metrics.bytesScanned).toBeLessThanOrEqual(GOVERNANCE_MAX_SOURCE_BYTES);
    expect(result.coverageGaps).toContain('governance_source_scan_budget_reached');
  });

  test('check registry exposes selection cost/risk/phase metadata without changing command execution semantics', () => {
    const root = repo('forge-governance-check-meta');
    writeFileSync(join(root, 'package.json'), JSON.stringify({
      scripts: {
        'check:architecture-sync': 'echo architecture',
        'check:release': 'echo release',
      },
    }, null, 2));
    mkdirSync(join(root, '.forge'), { recursive: true });
    writeJson(root, '.forge/checks.json', {
      version: 1,
      checks: {
        'custom:integration': {
          command: ['echo', 'integration'],
          selection: { costClass: 'L2', riskFloor: 'medium', phases: ['post_edit', 'pre_finalize'] },
        },
      },
    });
    const checks = listControllerChecks(root);
    expect(controllerCheckSelection(checks.find((check) => check.id === 'package:check:architecture-sync')!)).toEqual({
      costClass: 'L0', riskFloor: 'low', phases: ['post_edit'],
    });
    expect(controllerCheckSelection(checks.find((check) => check.id === 'package:check:release')!)).toEqual({
      costClass: 'L4', riskFloor: 'high', phases: ['release'],
    });
    expect(controllerCheckSelection(checks.find((check) => check.id === 'custom:integration')!)).toEqual({
      costClass: 'L2', riskFloor: 'medium', phases: ['post_edit', 'pre_finalize'],
    });
  });
});
