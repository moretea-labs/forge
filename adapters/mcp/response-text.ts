/** Preserve the intentional text-channel budget when adding response metadata. */
export const MCP_TRUNCATED_TEXT_MESSAGE =
  'Text channel truncated to response budget; use structuredContent or detail APIs.';

export const MCP_TEXT_MIRROR_BUDGET_BYTES = 16 * 1024;

export function budgetMcpTextMirror(
  text: string,
  structuredContent: Record<string, unknown>,
  isError = false,
  budgetBytes = MCP_TEXT_MIRROR_BUDGET_BYTES,
): string {
  if (isError || Buffer.byteLength(text, 'utf8') <= budgetBytes) return text;
  const process =
    structuredContent.process &&
    typeof structuredContent.process === 'object' &&
    !Array.isArray(structuredContent.process)
      ? (structuredContent.process as Record<string, unknown>)
      : undefined;
  return JSON.stringify({
    repoId: structuredContent.repoId ?? structuredContent.repo_id,
    processId: structuredContent.processId ?? structuredContent.process_id ?? process?.processId,
    summary: typeof structuredContent.summary === 'string' ? structuredContent.summary : undefined,
    status: structuredContent.status ?? structuredContent.phase ?? process?.status,
    jobId: structuredContent.jobId,
    next: structuredContent.next,
    responseMeta: structuredContent.responseMeta,
    truncatedTextChannel: true,
    message: MCP_TRUNCATED_TEXT_MESSAGE,
  });
}

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
