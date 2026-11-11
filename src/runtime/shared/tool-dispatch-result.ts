/**
 * SDK-independent result envelope shared by Forge tool dispatchers.
 *
 * Transport adapters may expose this shape as their native tool response, but
 * execution owners must not import an adapter's protocol SDK to describe it.
 */
export interface ToolDispatchResult {
  [key: string]: unknown;
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}
