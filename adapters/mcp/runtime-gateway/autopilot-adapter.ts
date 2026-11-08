import type { CallToolResult } from '../../../packages/protocols/mcp/tool-contract';
import type { MultiRepositoryMcpToolContext } from '../multi-repository';
import {
  authorizeAutopilot,
  autopilotStatus,
  pauseAutopilot,
  resumeAutopilot,
  revokeAutopilot,
  startAutopilot,
} from '../../../src/runtime/autopilot';
import { callRepositoryTool, repositoryToolDefinitions } from '../tool-mapping/repository-tools';
import { result } from './result-adapter';
import { selected } from './shared-adapter';

function requirementId(args: Record<string, unknown>): string {
  const value = typeof args.requirement_id === 'string' ? args.requirement_id.trim() : '';
  if (!value) throw new Error('AUTOPILOT_REQUIREMENT_ID_REQUIRED');
  return value;
}

export async function callAutopilotAdapter(
  ctx: MultiRepositoryMcpToolContext,
  name: string,
  args: Record<string, unknown>,
): Promise<CallToolResult | undefined> {
  if (name !== 'rh_autopilot') return undefined;
  try {
    const operation = typeof args.operation === 'string' ? args.operation : 'status';
    const repository = selected(ctx, args);
    const reqId = requirementId(args);
    switch (operation) {
      case 'status':
        return result({
          ...autopilotStatus(ctx.controllerHome, repository.repoId, reqId),
          provider: 'deepseek',
          providerReady: Boolean(process.env.FORGE_DEEPSEEK_API_KEY?.trim() || process.env.DEEPSEEK_API_KEY?.trim()),
          authority: {
            approval: 'canonical-authorization-grant',
            execution: 'runtime-autopilot',
            semantic: 'requirement-plan',
            sourceProgress: 'github-project-issue',
          },
        });
      case 'authorize': {
        const enrolled = authorizeAutopilot({
          controllerHome: ctx.controllerHome,
          repoId: repository.repoId,
          checkoutId: repository.activeCheckoutId,
          requirementId: reqId,
          principalId: ctx.principalId,
          confirmAuthorization: args.confirm_authorization === true,
          expiresInMinutes: typeof args.expires_in_minutes === 'number' ? args.expires_in_minutes : undefined,
          policy: {
            provider: 'deepseek',
            model: typeof args.model === 'string' ? args.model : undefined,
            maxTotalTokens: typeof args.max_total_tokens === 'number' ? args.max_total_tokens : undefined,
            maxTurns: typeof args.max_turns === 'number' ? args.max_turns : undefined,
            maxToolCalls: typeof args.max_tool_calls === 'number' ? args.max_tool_calls : undefined,
            checkpointPlanIds: Array.isArray(args.checkpoint_plan_ids)
              ? args.checkpoint_plan_ids.map(String)
              : undefined,
          },
        });
        return result({
          authorization: enrolled.grant,
          policy: enrolled.policy,
          requirement: enrolled.requirement,
          checkoutId: enrolled.checkoutId,
          note: 'Authorization is bound to this exact Requirement revision. Creating or revising a Requirement does not authorize Autopilot.',
        });
      }
      case 'start':
        return result({
          run:startAutopilot({
            controllerHome:ctx.controllerHome,repoId:repository.repoId,requirementId:reqId,
            dependencies:{
              toolDefinitions:repositoryToolDefinitions,
              executeTool:(tool,args) => callRepositoryTool(ctx.controllerHome,tool,args,{
                sessionId:ctx.sessionId,principalId:ctx.principalId,controllerInstanceId:ctx.controllerInstanceId,
              }),
            },
          }).value,
        });
      case 'pause':
        return result({ run: pauseAutopilot(ctx.controllerHome, repository.repoId, reqId).value });
      case 'resume':
        return result({
          run:resumeAutopilot({
            controllerHome:ctx.controllerHome,repoId:repository.repoId,requirementId:reqId,
            dependencies:{
              toolDefinitions:repositoryToolDefinitions,
              executeTool:(tool,args) => callRepositoryTool(ctx.controllerHome,tool,args,{
                sessionId:ctx.sessionId,principalId:ctx.principalId,controllerInstanceId:ctx.controllerInstanceId,
              }),
            },
          }).value,
        });
      case 'revoke':
        return result({
          authorization: revokeAutopilot({
            controllerHome: ctx.controllerHome,
            repoId: repository.repoId,
            requirementId: reqId,
            reason: typeof args.reason === 'string' ? args.reason : undefined,
          }),
        });
      default:
        throw new Error(`AUTOPILOT_OPERATION_UNSUPPORTED: ${operation}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const code = /^([A-Z][A-Z0-9_]+)(?::|$)/.exec(message)?.[1] ?? 'AUTOPILOT_FAILED';
    return result({ error: { code, message } }, true);
  }
}
