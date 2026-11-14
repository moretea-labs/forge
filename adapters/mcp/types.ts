export type { McpPathDecision, McpPathIntent } from '../../src/runtime/safe-tooling/path-policy';

export interface McpAuditEntry {
  timestamp: string;
  tool: string;
  status: 'ok' | 'blocked' | 'failed';
  targetPath?: string;
  inputHash?: string;
  error?: string;
}
