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
    await client.connect(transport);
    const effectiveArgs = await recoveryToolArguments(client, name, args);
    const response = await client.callTool({ name, arguments: effectiveArgs });
    return recoveryStructuredPayload(response, name);
  } finally {
    await client.close().catch(() => undefined);
  }
}
