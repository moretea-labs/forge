import { redactSensitiveText } from '../../runtime/evidence/sensitive-output';

export interface McpRedaction {
  type: string;
  count: number;
}

export interface McpRedactionResult {
  text: string;
  redactions: McpRedaction[];
}

/**
 * MCP is a presentation boundary, not a separate secret-detection engine.
 * Reuse the same bounded patterns as Process Runtime persistence so a value
 * cannot be safe in one tool surface and exposed in another.
 */
export function redactMcpText(input: string): McpRedactionResult {
  const result = redactSensitiveText(input);
  return { text: result.text, redactions: result.redactions };
}
