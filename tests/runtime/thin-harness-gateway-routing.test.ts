import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { createHash } from 'crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { spawnSync } from 'child_process';
import {
  classifyGatewayExecutionPath,
  gatewayRouteBehaviorSnapshot,
  routeDurableMcpCall,
} from '../../adapters/mcp/runtime-gateway/router';
import { executeGatewayRoutedOperation } from '../../adapters/mcp/runtime-gateway/gateway-execution-adapter';
import { callCoreCapabilityAdapter } from '../../adapters/mcp/runtime-gateway/core-capability-adapter';
import { createMcpToolContext } from '../../adapters/mcp/server';
import { callMultiRepositoryTool } from '../../adapters/mcp/multi-repository';
import { ensureControllerHome } from '../../src/effects/controller-home';
import { addRepositoryCheckout, getRepository, refreshRepositoryCheckoutGitMetadata, registerRepository, selectRepositoryCheckout, setRepositoryCheckoutLifecycle } from '../../src/cli/repositories/registry';
import { repositoryGitStatus } from '../../src/cli/repositories/structured-git';
import { commitSelectedPaths } from '../../src/cli/repositories/selected-path-actions';
import { ensureRepositoryRuntimeStorageBinding } from '../../src/cli/repositories/runtime-storage';
import { listExecutionJobs } from '../../src/runtime/execution/jobs/store';
import { listLocalBridgeJobSnapshots } from '../../src/cli/local-bridge/job-store';
import { callRepositoryTool } from '../../adapters/mcp/tool-mapping/repository-tools';
import { callExecutionTool } from '../../adapters/mcp/runtime-gateway/execution-tools';
import { callRuntimeTool } from '../../adapters/mcp/runtime-gateway/runtime-tools';
import { callProcessTool } from '../../adapters/mcp/runtime-gateway/process-tools';
import { classifyRepositoryCommand } from '../../src/cli/repositories/command-classifier';
import { classifyRepositoryCommandRoute, waitRepositoryCommandProcess } from '../../src/runtime/execution/process-runtime/command-facade';
import { routeExecution, isFastEligibleTool } from '../../src/runtime/execution/thin-harness';
import { getProcessRecord, listProcessRecords } from '../../src/runtime/execution/process-runtime/store';
import { getProcessHandle, waitForProcess } from '../../src/runtime/execution/process-runtime/runtime';
import { readControlPlaneRecord } from '../../src/runtime/control-plane/persistence/sqlite-store';
import { runPersistedCheckViaProcessRuntime } from '../../src/runtime/execution/process-runtime/persisted-check';
import { readPersistedCheckResultReceipt } from '../../src/runtime/execution/process-runtime/check-result';
import { resolveRepositoryCheckStorage } from '../../src/runtime/execution/process-runtime/check-storage';
import { appendControllerWorklogEvent, listControllerWorklogEvents, resolveControllerWorklogStorage } from '../../src/cli/controller/worklog';
import { executionIdentityForRepository } from '../../src/runtime/control-plane/execution/execution-identity';
import { runReadOnlyDiagnosticViaProcessRuntime } from '../../src/runtime/diagnostics/process-facade';
import { MCP_SERVER_INSTRUCTIONS } from '../../adapters/mcp/instructions';
import {
  applyEditOperations,
  assertEditSessionDurableBinding,
  beginEditSession,
  finalizeEditSession,
  reconcileEditSession,
  getEditSession,
} from '../../src/cli/editing/edit-session';
import { getMcpPolicy } from '../../adapters/mcp/policy';
import {
  reconcilePendingEditValidations,
  startOrJoinEditValidation,
} from '../../src/runtime/control-plane/execution/edit-validation-coordinator';
import { getWorkContract } from '../../src/runtime/control-plane/facade/work-contract-store';
import { snapshotControllerCheck } from '../../src/cli/controller/check-runner';
import { readWorkHandle } from '../../src/runtime/control-plane/execution/work-handle-store';
import { principalFor } from '../../src/runtime/control-plane/execution/session-execution-support';
import { verificationInputFingerprint, workspaceValidationFingerprint } from '../../src/runtime/control-plane/execution/verification-evidence';
import { resolveAuthorizationRequest } from '../../src/runtime/control-plane/governance/authorization';

import { startExecutionSession, updateExecutionSession, readExecutionSession, type ExecutionSessionContext } from '../../src/runtime/control-plane/execution/session-store';
import { listActiveLeases } from '../../src/runtime/resources/leases/store';
import { seedHistoricalWorkContract } from '../helpers/historical-work-contract';

function git(root: string, args: string[]): string {
  const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf-8' });
  if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(' ')} failed`);
  return String(result.stdout ?? '').trim();
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'thin-gw-route-'));
  const controllerHome = join(root, 'controller');
  const repoRoot = join(root, 'repo');
  const originRoot = join(root, 'origin.git');
  mkdirSync(controllerHome, { recursive: true });
  mkdirSync(join(repoRoot, 'src'), { recursive: true });
  mkdirSync(join(repoRoot, '.forge'), { recursive: true });
  mkdirSync(originRoot, { recursive: true });
  git(originRoot, ['init', '--bare']);
  git(originRoot, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
  git(repoRoot, ['init', '-b', 'main']);
  git(repoRoot, ['config', 'user.name', 'Test']);
  git(repoRoot, ['config', 'user.email', 'test@example.com']);
  writeFileSync(join(repoRoot, 'README.md'), 'gateway routing fixture\n');
  writeFileSync(join(repoRoot, 'src', 'lib.ts'), 'export const n = 1;\n');
  writeFileSync(join(repoRoot, '.forge', 'checks.json'), JSON.stringify({
    version: 1,
    checks: {
      slow: {
        description: 'slow managed check',
        command: [process.execPath, '-e', 'setTimeout(() => { console.log("slow-ok"); process.exit(0); }, 1200)'],
        timeoutMs: 10_000,
      },
      'type-focused': {
        description: 'fast TypeScript focused check',
        command: [process.execPath, '-e', 'process.exit(0)'],
        timeoutMs: 10_000,
      },
    },
  }, null, 2));
  git(repoRoot, ['add', '.']);
  git(repoRoot, ['commit', '-m', 'init']);
  git(repoRoot, ['remote', 'add', 'origin', originRoot]);
  git(repoRoot, ['push', '--set-upstream', 'origin', 'main']);
  ensureControllerHome(controllerHome);
  const repository = registerRepository({ path: repoRoot, controllerHome, displayName: 'gw-route' });
  const ctx = createMcpToolContext({
    controllerHome,
    profile: 'controller',
    repo: repoRoot,
  });
  return { root, controllerHome, repoRoot, originRoot, repository, ctx };
}

const roots: string[] = [];

beforeEach(() => {
  // no-op; fixtures cleaned in afterEach
});

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe('controller.plugins capability', () => {
  test('adapts the typed management snapshot into the MCP structured result', async () => {
    const fx = fixture();
    roots.push(fx.root);

    const response = await callCoreCapabilityAdapter(fx.ctx, 'capability_execute', {
      capability_id: 'controller.plugins',
      action: 'get',
      arguments: {},
    });

    expect(response?.isError).not.toBe(true);
    const payload = response?.structuredContent as { schemaVersion?: number; plugins?: unknown[] };
    expect(payload.schemaVersion).toBe(1);
    expect(Array.isArray(payload.plugins)).toBe(true);
  });
});

describe('repository.direct_edit capability', () => {
  test('routes apply through the existing Safe Patch/EditSession owner', async () => {
    const fx = fixture();
    roots.push(fx.root);

    const edited = await callCoreCapabilityAdapter(fx.ctx, 'capability_execute', {
      repo_id: fx.repository.repoId,
      capability_id: 'repository.direct_edit',
      action: 'apply',
      request_id: 'direct-edit-capability-apply',
      arguments: {
        purpose: 'Exercise the canonical direct-edit capability route.',
        operations: [{
          type: 'replace',
...