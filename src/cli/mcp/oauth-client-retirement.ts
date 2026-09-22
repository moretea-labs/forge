import {
  mcpServiceOAuthTokenStoreFallbackPaths,
  mcpServiceOAuthTokenStorePath,
} from '../../../adapters/mcp/auth';
import {
  McpOAuthTokenStore,
  type McpOAuthClientRetirementResult,
} from '../../../adapters/mcp/oauth';
import {
  reconcilePluginCapabilityAuthorizations,
  type ReconcilePluginCapabilityAuthorizationsResult,
} from '../../runtime/plugins/capability-authorization-grants';

export interface RetireMcpOAuthClientOptions {
  now?: Date;
}

export interface RetireMcpOAuthClientResult {
  clientId: string;
  ownerScope: string;
  oauth: McpOAuthClientRetirementResult;
  capabilityAuthorizations: ReconcilePluginCapabilityAuthorizationsResult;
  changed: boolean;
}

function requiredClientId(clientId: string): string {
  const normalized = clientId.trim();
  if (!normalized) throw new Error('MCP_OAUTH_CLIENT_ID_REQUIRED');
  return normalized;
}

export function mcpOAuthClientOwnerScope(clientId: string): string {
  return `mcp:oauth-client:${requiredClientId(clientId)}`;
}

/**
 * Converge one retired MCP OAuth client across Forge's existing authorities.
 *
 * Ordering is deliberate and idempotent:
 * 1. revoke credentials and remove the OAuth registration in the OAuth store;
 * 2. once the client is absent from that authority, reclaim only its exact
 *    capability-grant owner scope while compacting already-dead grants.
 *
 * This is ordered convergence across two atomic stores, not a fabricated
 * cross-file transaction. A failure in step 2 can be retried safely: step 1
 * becomes a no-op and the exact retired owner is reconciled on the next call.
 */
export function retireMcpOAuthClient(
  controllerHome: string,
  clientId: string,
  options: RetireMcpOAuthClientOptions = {},
): RetireMcpOAuthClientResult {
  const normalizedClientId = requiredClientId(clientId);
  const store = new McpOAuthTokenStore(
    mcpServiceOAuthTokenStorePath(controllerHome),
    mcpServiceOAuthTokenStoreFallbackPaths(controllerHome),
  );
  store.load();

  const oauth = store.retireClient(normalizedClientId);
  const ownerScope = mcpOAuthClientOwnerScope(normalizedClientId);
  const capabilityAuthorizations = reconcilePluginCapabilityAuthorizations(controllerHome, {
    retiredOwnerScopes: [ownerScope],
    now: options.now,
  });

  return {
    clientId: normalizedClientId,
    ownerScope,
    oauth,
    capabilityAuthorizations,
    changed: oauth.changed || capabilityAuthorizations.changed,
  };
}
