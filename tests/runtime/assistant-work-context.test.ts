import { execFileSync } from 'child_process';
import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { recordCognitiveMemory, type CognitiveWriteAuthorityPort } from '../../packages/kernel/cognition/api/index';
import { createWorkContract } from '../../packages/kernel/work/api/index';
import { ensureControllerHome } from '../../src/cli/repositories/controller-home';
import { registerRepository } from '../../src/cli/repositories/registry';
import { prepareAssistantWorkContext } from '../../src/runtime/context/assistant-work-context';
import { cognitionMemoryStore } from '../../src/runtime/control-plane/persistence/cognition-store';

describe('assistant context for Controller Work', () => {
  test('does not block an unbound Work when optional Project knowledge is unavailable', () => {
    const root = mkdtempSync(join(tmpdir(), 'forge-assistant-work-context-'));
    try {
      const controllerHome = join(root, 'controller');
      const repoRoot = join(root, 'repo');
      ensureControllerHome(controllerHome);
      mkdirSync(repoRoot, { recursive: true });
      execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
      execFileSync('git', ['config', 'user.email', 'assistant-context@example.test'], { cwd: repoRoot });
      execFileSync('git', ['config', 'user.name', 'Assistant Context Test'], { cwd: repoRoot });
      writeFileSync(join(repoRoot, 'README.md'), 'assistant context fixture\n');
      execFileSync('git', ['add', '.'], { cwd: repoRoot });
      execFileSync('git', ['commit', '-qm', 'fixture'], { cwd: repoRoot });
      const repository = registerRepository({ path: repoRoot, controllerHome, displayName: 'assistant context fixture' });
      createWorkContract({ controllerHome, repoId: repository.repoId }, {
        workId: 'work-unbound-assistant-context',
        repoId: repository.repoId,
        checkoutId: repository.activeCheckoutId,
        mode: 'goal_workloop',
        objective: 'Continue a durable Work without optional Project knowledge.',
        acceptanceCriteria: [],
        constraints: { workspaceMode: 'current', requireWorktree: false },
        allowedPaths: [],
        forbiddenPaths: [],
        checks: [],
        requestedBy: 'chatgpt',
        status: 'running',
      });

      const authority: CognitiveWriteAuthorityPort = {
        assertMemoryWrite() {},
        assertEdgeWrite() {},
        evidenceAvailable(ref) { return ref === 'E-projectless'; },
      };
      recordCognitiveMemory(cognitionMemoryStore(controllerHome), authority, {
        id: 'mem:projectless-work',
        scope: { schemaVersion: 1, kind: 'work', id: 'work-unbound-assistant-context' },
        facets: ['knowledge'],
        canonicalText: 'Durable Work context is available without optional Project knowledge.',
        concepts: ['projectless.work'],
        provenance: { sourceKind: 'system', recordedAt: '2026-09-19T00:00:00.000Z', evidenceRefs: ['E-projectless'] },
        confidence: 0.9,
        utility: 0.9,
        tier: 'hot',
        validFrom: '2026-09-19T00:00:00.000Z',
        counterEvidenceRefs: [],
      });

      const context = prepareAssistantWorkContext({
        controllerHome,
        repoId: repository.repoId,
        workId: 'work-unbound-assistant-context',
        now: '2026-09-19T12:00:00.000Z',
      });
      expect(context).toBeDefined();
      expect(context?.projectId).toBeUndefined();
      expect(context?.items.some(item => item.text.includes('Durable Work context is available'))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
