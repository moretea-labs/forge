export interface McpPathDecision {
  ok: boolean;
  relativePath?: string;
  absolutePath?: string;
  reason?: string;
}

export type McpPathIntent = 'read' | 'write';

export interface McpAuditEntry {
  timestamp: string;
  tool: string;
  status: 'ok' | 'blocked' | 'failed';
  targetPath?: string;
  inputHash?: string;
  error?: string;
}
