import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { gatewayToken, loadRecoveryConfig } from '../../../src/runtime/standalone-recovery/core';
import {
  assertCompleteExplicitRecoveryIdentity,
  hydrateRecoveryToolArguments,
  isRecoveryStatusDerivableField,
  recoveryToolRequiredFields,
  recoveryToolSchemaUnrepresentableError,
  recoveryToolUnrepresentableRequiredFields,
} from './recovery-tool-contract';

export function recoveryStructuredPayload(
  response: Awaited<ReturnType<Client['callTool']>>,
  operation: string,
): Record<string, unknown> {
  if (response.isError) throw new Error(`RECOVERY_TOOL_FAILED: ${operation}`);
  const payload = response.structuredContent;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error(`RECOVERY_TOOL_PROTOCOL_INVALID: ${operation}`);
  }
  return payload as Record<string, unknown>;
}

export async function recoveryToolArguments(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const listed = await client.listTools();
  const descriptor = listed.tools.find((tool) => tool.name === name);
  if (!descriptor) throw new Error(`RECOVERY_TOOL_UNKNOWN: ${name}`);
  assertCompleteExplicitRecoveryIdentity(name, args);
  const required = recoveryToolRequiredFields(descriptor.inputSchema);
  const missing = required.filter((field) => !Object.prototype.hasOwnProperty.call(args, field));
  if (missing.length === 0) return args;
  const unrepresentable = recoveryToolUnrepresentableRequiredFields(descriptor.inputSchema, args);
  if (unrepresentable.length) throw recoveryToolSchemaUnrepresentableError(name, unrepresentable);
  const needsStatus = missing.some(isRecoveryStatusDerivableField);
  const status = needsStatus
    ? recoveryStructuredPayload(await client.callTool({ name: 'runtime_status', arguments: {} }), 'runtime_status')
    : undefined;
  return hydrateRecoveryToolArguments({ toolName: name, inputSchema: descriptor.inputSchema, args, status });
}

function recoveryGatewayAccessFailure(error: unknown): Error | undefined {
  const detail = error instanceof Error ? error.message : String(error);
  const status = typeof error === 'object' && error !== null && 'status' in error
    ? (error as { status?: unknown }).status
    : undefined;
  const statusMatch = detail.match(/\bHTTP\s+(401|403)\b/i)?.[1];
  const rejectedStatus = status === 401 || status === 403
    ? status
    : statusMatch
      ? Number(statusMatch)
      : undefined;
  if (rejectedStatus === 401 || (rejectedStatus === undefined && /invalid_token|unauthorized/i.test(detail))) {
    return new Error('RECOVERY_GATEWAY_AUTH_REJECTED: HTTP 401 Unauthorized');
  }
  if (rejectedStatus === 403 || (rejectedStatus === undefined && /forbidden/i.test(detail))) {
    return new Error('RECOVERY_GATEWAY_ACCESS_DENIED: HTTP 403 Forbidden');
  }
  return undefined;
}

function recoveryGatewayUnavailable(error: unknown): Error | undefined {
  const detail = error instanceof Error ? error.message : String(error);
  if (!/unable to connect|fetch failed|ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENETUNREACH|ETIMEDOUT|socket hang up/i.test(detail)) {
    return undefined;
  }
  return new Error(`RECOVERY_GATEWAY_UNAVAILABLE: ${detail}`);
}

/** Transport-only bridge to the standalone Recovery Gateway. */
export async function callStandaloneRecoveryTool(
  controllerHome: string,
  name: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const config = loadRecoveryConfig(controllerHome);
  const gateway = config.gateway;
  if (!gateway || gateway.host !== '127.0.0.1') {
    throw new Error('RECOVERY_GATEWAY_UNAVAILABLE: loopback Recovery Gateway is not configured');
  }
  const token = gatewayToken(config);
  if (!token) throw new Error('RECOVERY_GATEWAY_AUTH_UNAVAILABLE');
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${gateway.port}/recovery/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  const client = new Client({ name: 'forge-runtime-lifecycle-handoff', version: '1.0.0' });
  try {
    let effectiveArgs: Record<string, unknown>;
    try {
      await client.connect(transport);
      effectiveArgs = await recoveryToolArguments(client, name, args);
    } catch (error) {
      const accessFailure = recoveryGatewayAccessFailure(error);
      if (accessFailure) throw accessFailure;
      const unavailable = recoveryGatewayUnavailable(error);
      if (unavailable) throw unavailable;
      throw error;
    }

    // Do not relabel a post-dispatch transport failure as Gateway unavailability:
    // a mutation may have run before its response was lost. Its outcome remains
    // owned by the existing request/Process authority; this adapter never replays it.
    const response = await client.callTool({ name, arguments: effectiveArgs });
    return recoveryStructuredPayload(response, name);
  } finally {
    await client.close().catch(() => undefined);
  }
}
