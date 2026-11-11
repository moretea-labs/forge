import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ensureControllerHome } from '../../src/effects/controller-home';
import { registerRepository } from '../../src/cli/repositories/registry';
import { ensureForgeInstanceIdentity } from '../../packages/kernel/identity/api/index';
import {
  writeWorkspaceIdentity,
  writeProjectIdentity,
  writeProjectPlacement,
} from '../../src/runtime/control-plane/workspace/workspace-store';

const roots: string[] = [];
afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});
const sourceRoot = resolve(import.meta.dir, '../..');
const script = join(sourceRoot, 'apps/desktop/src-tauri/resources/forge-local-tool.mjs');

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'forge-native-cognitive-'));
  roots.push(root);
  const controllerHome = join(root, 'controller');
  const repoRoot = join(root, 'repo');
  mkdirSync(repoRoot);
  ensureControllerHome(controllerHome);
  writeFileSync(join(repoRoot, 'README.md'), 'Native Cognitive test\n');
  const git = spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot, encoding: 'utf8' });
  expect(git.status).toBe(0);
  const repository = registerRepository({ path: repoRoot, controllerHome, displayName: 'Native Cognition' });
  const instance = ensureForgeInstanceIdentity({
    controllerHome, preferredInstanceId: 'forge-native-cognitive-test',
    now: () => new Date().toISOString(), label: 'Native Cognition',
  });
  writeWorkspaceIdentity({ controllerHome,
    value: { workspaceId: 'workspace-native-cognition', title: 'Native Cognitive Test' } });
  writeProjectIdentity({ controllerHome,
    value: { projectId: 'project-native-cognition', workspaceId: 'workspace-native-cognition', displayName: 'Native Cognition' } });
  writeProjectPlacement({ controllerHome, value: {
    projectId: 'project-native-cognition', forgeInstanceId: instance.instanceId,
    repositoryId: repository.repoId, checkoutId: repository.activeCheckoutId,
  } });
  return { controllerHome, repository };
}

function invoke(
  fx: ReturnType<typeof fixture>, tool: string, conversationId: string,
  args: Record<string, unknown>, allowEffects = false,
): { ok: boolean; error?: string; result?: Record<string, any> } {
  const payload = JSON.stringify({
    tool, repoId: fx.repository.repoId, checkoutId: fx.repository.activeCheckoutId,
    conversationId, controllerHome: fx.controllerHome, sourceRoot, allowEffects, arguments: args,
  });
  const result = spawnSync(process.execPath, [script], {
    input: payload, encoding: 'utf8', maxBuffer: 256 * 1024, timeout: 12_000,
  });
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout.trim());
}

describe('Native Agent model-authored Cognition without Work', () => {
  test('rejects secret-like memory without partially writing a mixed batch', () => {
    const fx = fixture();
    const ordinary = {
      scope_kind: 'project', kind: 'design-correction', valence: 'positive',
      summary: 'Keep medicine stock surfaces visually quiet.',
      concepts: ['medication', 'inventory'], admission_source: 'explicit_human',
      portability: 'local', salience: 1, confidence: 1, utility: 1,
    };
    const secret = {
      ...ordinary,
      scope_kind: 'workspace',
      portability: 'portable',
      summary: 'Do not share this placeholder credential sk-TESTONLY0123456789abcdef0123456789',
    };
    const refused = invoke(fx, 'record_learning', 'agent-security',
      { signals: [ordinary, secret] }, true);
    expect(refused.ok).toBe(false);
    expect(refused.error).toContain('CONTROL_PLANE_METADATA_SECRET_REFUSED');
    const recall = invoke(fx, 'recall_knowledge', 'agent-next', { query: 'medicine stock surfaces' });
    expect(recall.ok, recall.error).toBe(true);
    expect(recall.result?.items).toHaveLength(0);
  });

  test('keeps Project memory isolated while reusing portable Workspace guidance', () => {
    const fx = fixture();
    const secondRoot = join(roots.at(-1)!, 'repo2');
    mkdirSync(secondRoot);
    writeFileSync(join(secondRoot, 'README.md'), 'Another project.\\n');
    expect(spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: secondRoot }).status).toBe(0);
    const second = registerRepository({
      path: secondRoot, controllerHome: fx.controllerHome, displayName: 'Independent Project',
    });
    writeProjectIdentity({
      controllerHome: fx.controllerHome,
      value: {
        projectId: 'project-unrelated', workspaceId: 'workspace-native-cognition',
        displayName: 'Independent Project',
      },
    });
    writeProjectPlacement({
      controllerHome: fx.controllerHome,
      value: {
        projectId: 'project-unrelated', forgeInstanceId: 'forge-native-cognitive-test',
        repositoryId: second.repoId, checkoutId: second.activeCheckoutId,
      },
    });
    const base = {
      kind: 'design-correction', valence: 'positive',
      concepts: ['inventory', 'cards'], admission_source: 'explicit_human',
      salience: 1, confidence: 1, utility: 1,
    };
    const signals = [
      { ...base, scope_kind: 'project', portability: 'local',
        summary: 'Project one inventory card detail is different.' },
      { ...base, scope_kind: 'workspace', portability: 'portable',
        summary: 'All workspace inventory cards should remain readable.' },
    ];
    const saved = invoke(fx, 'record_learning', 'agent-save', { signals }, true);
    expect(saved.ok, saved.error).toBe(true);
    expect(saved.result?.storedMemoryIds).toHaveLength(2);
    const foreign = invoke({ controllerHome: fx.controllerHome, repository: second },
      'recall_knowledge', 'agent-foreign', { query: 'workspace inventory cards remain readable' });
    expect(foreign.ok, foreign.error).toBe(true);
    const phrases = foreign.result?.items?.map((item: any) => item.text) ?? [];
    expect(phrases).toContain('All workspace inventory cards should remain readable.');
    expect(phrases.some((t: string) => t.includes('Project one inventory card'))).toBe(false);
  });

  test('read/record/re-recall/reject uses the same Project authority and preserves grants', () => {
    const fx = fixture();
    const signals = [{
      scope_kind: 'project', kind: 'design-correction', valence: 'positive',
      summary: 'Preserve flat inventory cards in the medication UI and avoid ornamental shadows.',
      concepts: ['medication', 'inventory', 'flat-card'], facets: ['ui', 'design'],
      admission_source: 'explicit_human', portability: 'local', salience: 1,
      confidence: 1, utility: 1,
    }];
    const denied = invoke(fx, 'record_learning', 'agent-a', { signals });
    expect(denied).toMatchObject({ ok: false, error: 'LOCAL_FORGE_TOOL_REQUIRES_USER_APPROVAL' });

    const recorded = invoke(fx, 'record_learning', 'agent-a', { signals }, true);
    expect(recorded.ok, recorded.error).toBe(true);
    expect(recorded.result?.storedMemoryIds).toHaveLength(1);

    const recalled = invoke(fx, 'recall_knowledge', 'agent-b',
      { query: 'medication inventory flat cards' });
    expect(recalled.ok, recalled.error).toBe(true);
    const match = recalled.result?.items?.find(
      (item: any) => item.text?.includes('Preserve flat inventory cards'),
    );
    expect(match?.memoryId).toBeTruthy();

    const unsafeFeedback = invoke(fx, 'memory_feedback', 'agent-b', { feedback: [{
      memory_address: match.memoryId, decision: 'used',
      reason: 'Avoid storing this synthetic credential sk-TESTONLY0123456789abcdef0123456789',
    }] }, true);
    expect(unsafeFeedback.ok).toBe(false);
    expect(unsafeFeedback.error).toContain('CONTROL_PLANE_METADATA_SECRET_REFUSED');

    expect(invoke(fx, 'memory_feedback', 'agent-b', { feedback: [{
      memory_address: match.memoryId, decision: 'rejected',
      rejection_kind: 'stale', reason: 'Current user correction supersedes that earlier layout.',
    }] })).toMatchObject({ ok: false, error: 'LOCAL_FORGE_TOOL_REQUIRES_USER_APPROVAL' });

    const feedback = invoke(fx, 'memory_feedback', 'agent-b', { feedback: [{
      memory_address: match.memoryId, decision: 'rejected',
      rejection_kind: 'stale', reason: 'Current user correction supersedes that earlier layout.',
    }] }, true);
    expect(feedback.ok, feedback.error).toBe(true);
    expect(feedback.result?.observationIds).toHaveLength(1);

    const after = invoke(fx, 'recall_knowledge', 'agent-c',
      { query: 'medication inventory flat cards' });
    expect(after.ok, after.error).toBe(true);
    const updated = after.result?.items?.find((item: any) => item.memoryId === match.memoryId);
    // Rejection is advisory evidence rather than a destructive deletion.
    expect(updated?.recentUsage?.staleCount).toBe(1);
    expect(updated?.recentUsage?.rejectedCount).toBe(1);
  });
});
