import { resolve } from 'path';
import { resolveRepoPreferredControllerHome } from '../../src/effects/controller-home';
import { getToolPolicy, parseToolProfile } from '../../src/runtime/control-plane/tool-policy';
import type { McpToolContext } from './tool-mapping/tools';
import type { McpServerOptions } from './multi-repository';

export function createLegacyMcpToolContext(opts: McpServerOptions): McpToolContext {
  const repoRoot = resolve(opts.repo?.trim() || '.');
  return {
    repoRoot,
    runtimeControllerHome: resolveRepoPreferredControllerHome(repoRoot, opts.controllerHome),
    policy: getToolPolicy(parseToolProfile(opts.profile ?? 'planner'), { repoRoot }),
    enableChatgptBrowser: opts.enableChatgptBrowser === true,
    sessionId: opts.sessionId,
    principalId: opts.principalId,
    controllerInstanceId: opts.controllerInstanceId,
  };
}
