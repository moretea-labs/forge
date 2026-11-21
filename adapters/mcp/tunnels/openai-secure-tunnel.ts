/** Compatibility re-export: OpenAI secure tunnel helpers live in Runtime, not MCP adapters. */
export {
  OPENAI_SECURE_TUNNEL_PLATFORM,
  isOpenAiTunnelId,
  isOpenAiTunnelAlias,
  isOpenAiRuntimeApiKeyRef,
  tunnelRuntimeProfileTargetsEndpoint,
  openAiSecureTunnelStatusArgs,
  openAiSecureTunnelConnectArgs,
  parseOpenAiSecureTunnelRuntimeStatus,
} from '../../../src/runtime/standalone-recovery/openai-secure-tunnel';
export type {
  OpenAiSecureTunnelRuntimeConfig,
  OpenAiSecureTunnelRuntimeStatusPayload,
  OpenAiSecureTunnelRuntimeObservation,
} from '../../../src/runtime/standalone-recovery/openai-secure-tunnel';
