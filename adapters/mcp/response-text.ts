/** Preserve the intentional text-channel budget when adding response metadata. */
export const MCP_TRUNCATED_TEXT_MESSAGE =
  'Text channel truncated to response budget; use structuredContent or detail APIs.';

export function refreshMcpTextMirror(
  previousText: string,
  structuredContent: Record<string, unknown>,
  metadata: Record<string, unknown>,
): string {
  // Only inspect a bounded, explicitly marked summary, not arbitrary large text.
  if (previousText.length <= 16 * 1024 && previousText.includes(MCP_TRUNCATED_TEXT_MESSAGE)) {
    try {
      const summary = JSON.parse(previousText) as Record<string, unknown> | null;
      if (summary?.truncatedTextChannel === true && summary.message === MCP_TRUNCATED_TEXT_MESSAGE) {
        return JSON.stringify({ ...summary, ...metadata });
      }
    } catch {
      // Ordinary or non-JSON text retains the existing mirror behavior.
    }
  }
  return JSON.stringify(structuredContent);
}
