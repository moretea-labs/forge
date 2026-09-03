import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { routeWorkStart } from '../../src/runtime/control-plane/facade/goal-workloop';
import { selectExecutionMode } from '../../src/runtime/control-plane/facade/types';
import { readControlPlaneRecord, writeControlPlaneRecord } from '../../src/runtime/control-plane/persistence/sqlite-store';
import {
  renderContextPlane,
  resolveContextPlane,
  writeContextRecord,
  type ContextRecord,
} from '../../src/runtime/context/context-plane';

function record(input: Partial<ContextRecord> & Pick<ContextRecord, 'contextId' | 'value'>): ContextRecord {
  return {
    schemaVersion: 1,
    contextId: input.contextId,
    scope: input.scope ?? { schemaVersion: 1, kind: 'global', id: 'global' },
    priority: input.priority ?? 50,
    value: input.value,
    provenance: input.provenance ?? { source: 'user', recordedAt: '2026-09-03T00:00:00.000Z' },
    updatedAt: input.updatedAt ?? '2026-09-03T00:00:00.000Z',
    ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
  };
}

const providers = [
  { providerId: 'provider-a', kind: 'local_cli' as const, status: 'ready', capabilities: ['code_patch'], directDispatch: true },
  { providerId: 'provider-b', kind: 'remote_api' as const, status: 'ready', capabilities: ['code_patch'], directDispatch: true },
];

function routeInput(preferredProviderId?: string) {
  return {
    intent: { objective: 'Implement a bounded change', scopeClear: true, mutation: true, taskIntent: 'implementation', ...(preferredProviderId ? { preferredProviderId } : {}) },
    workspace: {},
    policy: {},
    capabilities: { providers },
    recovery: {},
  } as const;
}

describe('Kernel V2 structured Context Plane', () => {
  test('stores typed credential references but refuses raw secret material', () => {
    const home = mkdtempSync(join(tmpdir(), 'forge-v2-context-'));
    try {
      const stored = writeContextRecord({
        controllerHome: home,
        expectedRevision: null,
        record: record({
          contextId: 'openai-credential-ref',
          value: { type: 'credential_reference', reference: { kind: 'env', reference: 'OPENAI_API_KEY', provider: 'openai' } },
        }),
      });
      expect(stored.revision).toBe(1);
      expect(JSON.stringify(stored.value)).not.toContain('sk-');
      expect(() => writeContextRecord({
        controllerHome: home,
        expectedRevision: null,
        record: record({ contextId: 'raw-secret', value: { type: 'policy', statement: 'Use sk-123456789012345678901234567890 for access.' } }),
      })).toThrow('CONTROL_PLANE_METADATA_SECRET_REFUSED');
      expect(() => writeContextRecord({
        controllerHome: home,
        expectedRevision: null,
        record: record({ contextId: 'bad-env-ref', value: { type: 'credential_reference', reference: { kind: 'env', reference: 'sk-123456789012345678901234567890' } } }),
      })).toThrow('CONTEXT_CREDENTIAL_ENV_REFERENCE_INVALID');
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  test('ranks scoped explicit preferences deterministically and enforces hard resolver budgets', () => {
    const home = mkdtempSync(join(tmpdir(), 'forge-v2-context-'));
    try {
      writeContextRecord({ controllerHome: home, expectedRevision: null, record: record({ contextId: 'global-provider', value: { type: 'routing_preference', intent: 'implementation', preferredProviderId: 'provider-a' } }) });
      writeContextRecord({ controllerHome: home, expectedRevision: null, record: record({
        contextId: 'requirement-provider', scope: { schemaVersion: 1, kind: 'requirement', id: 'REQ-1' },
        value: { type: 'routing_preference', intent: 'implementation', preferredProviderId: 'provider-b' },
      }) });
      for (let index = 0; index < 10; index += 1) {
        writeContextRecord({ controllerHome: home, expectedRevision: null, record: record({ contextId: `policy-${index}`, priority: 1, value: { type: 'policy', statement: `Policy ${index}` } }) });
      }
      const resolution = resolveContextPlane({
        controllerHome: home,
        scopes: [{ schemaVersion: 1, kind: 'requirement', id: 'REQ-1' }],
        intent: 'implementation',
        now: '2026-09-03T01:00:00.000Z',
        maxItems: 3,
      });
      expect(resolution.records).toHaveLength(3);
      expect(resolution.truncated).toBe(true);
      expect(resolution.routeHints.preferredProviderId).toBe('provider-b');
      expect(resolution.records[0]?.record.contextId).toBe('requirement-provider');
      const rendered = renderContextPlane(resolution);
      expect(rendered).toContain('cannot override AGENTS.md');
      expect(rendered).toContain('[context-budget]');
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  test('stored routing preference affects selection but current explicit intent remains authoritative', () => {
    const home = mkdtempSync(join(tmpdir(), 'forge-v2-context-'));
    try {
      writeContextRecord({ controllerHome: home, expectedRevision: null, record: record({
        contextId: 'prefer-b', value: { type: 'routing_preference', intent: 'implementation', preferredProviderId: 'provider-b' },
      }) });
      const resolution = resolveContextPlane({ controllerHome: home, intent: 'implementation', now: '2026-09-03T01:00:00.000Z' });
      const fromContext = selectExecutionMode({ scopeClear: true, routePolicyInput: routeInput(), contextRouteHints: resolution.routeHints }).routeDecision;
      expect(fromContext.selectedProviderId).toBe('provider-b');
      const explicitWins = selectExecutionMode({ scopeClear: true, routePolicyInput: routeInput('provider-a'), contextRouteHints: resolution.routeHints }).routeDecision;
      expect(explicitWins.selectedProviderId).toBe('provider-a');
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  test('GoalWorkloop resolves Controller Home preferences on demand before provider routing', () => {
    const root = mkdtempSync(join(tmpdir(), 'forge-v2-context-goal-'));
    try {
      const controllerHome = join(root, 'controller');
      writeContextRecord({ controllerHome, expectedRevision: null, record: record({
        contextId: 'goal-prefer-b', value: { type: 'routing_preference', intent: 'implementation', preferredProviderId: 'provider-b' },
      }) });
      const result = routeWorkStart({
        workStore: { controllerHome, repoId: 'repo-context-goal' },
        handoffStore: { root: join(root, 'handoff') },
        repoId: 'repo-context-goal',
        sourceRevision: 'revision-a',
      }, {
        objective: 'Apply a tiny context-routed change.',
        modeInput: { scopeClear: true, routePolicyInput: routeInput() },
      });
      const mode = (result.data as { mode?: { routeDecision?: { selectedProviderId?: string | null } } }).mode;
      expect(mode?.routeDecision?.selectedProviderId).toBe('provider-b');
      expect(readControlPlaneRecord(controllerHome, 'work_contract', 'repo-context-goal', 'WORK-any')).toBeUndefined();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('missing or malformed Context remains advisory and cannot mutate Work authority', () => {
    const home = mkdtempSync(join(tmpdir(), 'forge-v2-context-'));
    try {
      const workValue = { schemaVersion: 2, workId: 'WORK-AUTHORITY', status: 'running', objective: 'Keep authority unchanged.' };
      writeControlPlaneRecord(home, { namespace: 'work_contract', scope: 'repo-1', key: 'WORK-AUTHORITY', schemaVersion: 2, value: workValue, expectedRevision: null });
      writeControlPlaneRecord(home, { namespace: 'context_record', scope: 'global:global', key: 'malformed', schemaVersion: 1, value: { schemaVersion: 999, raw: true }, expectedRevision: null });
      const resolution = resolveContextPlane({ controllerHome: home, intent: 'implementation', now: '2026-09-03T01:00:00.000Z' });
      expect(resolution.records).toEqual([]);
      expect(resolution.routeHints).toEqual({});
      expect(readControlPlaneRecord(home, 'work_contract', 'repo-1', 'WORK-AUTHORITY')?.value).toEqual(workValue);
      const baseline = selectExecutionMode({ scopeClear: true, routePolicyInput: routeInput() }).routeDecision;
      expect(baseline.selectedProviderId).toBe('provider-a');
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
});
