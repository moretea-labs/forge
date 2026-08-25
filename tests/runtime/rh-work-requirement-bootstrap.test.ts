import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { getMcpPolicy } from '../../src/cli/mcp/policy';
import type { MultiRepositoryMcpToolContext } from '../../src/cli/mcp/multi-repository';
import { ensureControllerHome } from '../../src/cli/repositories/controller-home';
import { registerRepository } from '../../src/cli/repositories/registry';
import { readRequirement } from '../../src/runtime/control-plane/persistence/requirement-store';
import { callRuntimeTool } from '../../src/runtime/gateway/mcp/runtime-tools';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function git(repoRoot: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' }).trim();
}

function initRepo(repoRoot: string): string {
  mkdirSync(join(repoRoot, 'src'), { recursive: true });
  writeFileSync(join(repoRoot, 'package.json'), JSON.stringify({ name: 'requirement-bootstrap-fixture' }, null, 2));
  writeFileSync(join(repoRoot, 'src', 'index.ts'), 'export const ready = true;\n');
  git(repoRoot, 'init', '-b', 'main');
  git(repoRoot, 'config', 'user.email', 'test@example.com');
  git(repoRoot, 'config', 'user.name', 'Forge Test');
  git(repoRoot, 'add', '.');
  git(repoRoot, 'commit', '-m', 'init');
  return git(repoRoot, 'rev-parse', 'HEAD');
}

function mcpContext(controllerHome: string, repository: ReturnType<typeof registerRepository>): MultiRepositoryMcpToolContext {
  return {
    repoRoot: repository.canonicalRoot,
    controllerHome,
    policy: getMcpPolicy('controller', { repoRoot: repository.canonicalRoot }),
    toolset: 'core',
    enableChatgptBrowser: false,
    explicitRepository: repository,
    audit: () => undefined,
  } as unknown as MultiRepositoryMcpToolContext;
}

function structured(result: Awaited<ReturnType<typeof callRuntimeTool>>): Record<string, any> {
  expect(result).toBeTruthy();
  return (result!.structuredContent
    ?? JSON.parse(result!.content[0] && 'text' in result!.content[0] ? String(result!.content[0].text) : '{}')) as Record<string, any>;
}

describe('rh_work Requirement bootstrap', () => {
  test('creates Requirement authority idempotently without implying Plan and still permits explicit Plan creation', async () => {
    const repoRoot = tempRoot('forge-requirement-repo-');
    const controllerHome = tempRoot('forge-requirement-home-');
    const sourceRevision = initRepo(repoRoot);
    ensureControllerHome(controllerHome);
    const repository = registerRepository({ path: repoRoot, controllerHome, displayName: 'Requirement fixture' });
    const ctx = mcpContext(controllerHome, repository);

    const requirementArgs = {
      repo_id: repository.repoId,
      operation: 'requirement_create',
      requirement_id: 'REQ-ANDROID-NATIVE-V1',
      requirement_title: 'Android native delivery',
      requirement_outcome: 'Deliver Android through contract-first native implementation.',
      requirement_acceptance_criteria: ['Foundation gates exist before production source.'],
    };

    const created = structured(await callRuntimeTool(ctx, 'rh_work', requirementArgs));
    expect(created.status).toBe('ok');
    expect(created.data.requirementCreated).toBe(true);
    expect(created.summary).toContain('does not imply a Plan');
    expect(created.suggestedNextActions ?? []).toEqual([]);
    expect(readRequirement({ controllerHome }, 'REQ-ANDROID-NATIVE-V1')?.value.title).toBe('Android native delivery');

    const retried = structured(await callRuntimeTool(ctx, 'rh_work', requirementArgs));
    expect(retried.status).toBe('ok');
    expect(retried.data.requirementCreated).toBe(false);
    expect(retried.data.admissionDecision).toBe('reuse_existing');
    expect(retried.summary).toContain('does not imply a Plan');
    expect(retried.suggestedNextActions ?? []).toEqual([]);

    const conflict = structured(await callRuntimeTool(ctx, 'rh_work', {
      ...requirementArgs,
      requirement_outcome: 'Conflicting replacement outcome.',
    }));
    expect(conflict.status).toBe('blocked');
    expect(conflict.summary).toContain('REQUIREMENT_ALREADY_EXISTS_CONFLICT');
    expect(readRequirement({ controllerHome }, 'REQ-ANDROID-NATIVE-V1')?.value.outcomeStatement)
      .toBe('Deliver Android through contract-first native implementation.');

    const planned = structured(await callRuntimeTool(ctx, 'rh_work', {
      repo_id: repository.repoId,
      operation: 'plan_create',
      plan_id: 'PLAN-ANDROID-NATIVE-V1',
      requirement_id: 'REQ-ANDROID-NATIVE-V1',
      scope_key: 'android-native-v1',
      source_revision: sourceRevision,
      objective: 'Bootstrap Android governance.',
      plan_steps: [{
        id: 'governance',
        objective: 'Create governance gates.',
        dependencies: [],
        authoritative_files: [],
        allowed_paths: ['android/**'],
        forbidden_paths: ['ios/**'],
        check_ids: [],
        acceptance_criteria: ['Governance is machine enforced.'],
      }],
    }));
    expect(planned.status).toBe('ok');
    expect(planned.data.planContractCreated).toBe(true);
  }, 15_000);
});
