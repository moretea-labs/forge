import { existsSync, readFileSync, statSync } from 'fs';
import { isAbsolute, relative, resolve, sep } from 'path';
import type { CallToolResult as SdkCallToolResult } from "@modelcontextprotocol/client";
import type { CallToolResult } from '../../../packages/protocols/mcp/tool-contract';
import { repositoryControllerRoot } from '../../../src/cli/repositories/controller-home';
import { redactMcpText } from '../redaction';

/** Transport-only MCP result envelope. No lifecycle or domain mutation belongs here. */
export function result(value: Record<string, unknown>, isError = false): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    structuredContent: value,
    ...(isError ? { isError: true } : {}),
  };
}

const MAX_INLINE_PLUGIN_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_INLINE_PLUGIN_IMAGES = 4;
const INLINE_PLUGIN_IMAGE_MEDIA_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);

type McpImageContent = Extract<SdkCallToolResult['content'][number], { type: 'image' }>;

export function boundedPluginArtifactImageContent(
  controllerHome: string,
  repoId: string,
  pluginResult: Record<string, unknown> | undefined,
): McpImageContent[] {
  if (!pluginResult) return [];
  const nestedResult = pluginResult.result && typeof pluginResult.result === 'object' && !Array.isArray(pluginResult.result)
    ? pluginResult.result as Record<string, unknown>
    : undefined;
  const candidates = [
    ...(Array.isArray(pluginResult.artifactCandidates) ? pluginResult.artifactCandidates : []),
    ...(nestedResult && Array.isArray(nestedResult.artifactCandidates) ? nestedResult.artifactCandidates : []),
  ];
  if (candidates.length === 0) return [];
  const allowedRoot = resolve(repositoryControllerRoot(controllerHome, repoId));
  const images: McpImageContent[] = [];
  const seenPaths = new Set<string>();

  for (const candidate of candidates) {
    if (images.length >= MAX_INLINE_PLUGIN_IMAGES) break;
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue;
    const record = candidate as Record<string, unknown>;
    const mediaType = typeof record.mediaType === 'string' ? record.mediaType : '';
    const path = typeof record.path === 'string' ? record.path : '';
    if (!INLINE_PLUGIN_IMAGE_MEDIA_TYPES.has(mediaType) || !path) continue;

    const resolvedPath = resolve(path);
    if (seenPaths.has(resolvedPath)) continue;
    const rel = relative(allowedRoot, resolvedPath);
    if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) continue;
    if (!existsSync(resolvedPath)) continue;

    try {
      const stat = statSync(resolvedPath);
      if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_INLINE_PLUGIN_IMAGE_BYTES) continue;
      images.push({
        type: 'image',
        data: readFileSync(resolvedPath).toString('base64'),
        mimeType: mediaType,
      });
      seenPaths.add(resolvedPath);
    } catch {
      // Structured plugin output remains authoritative when an artifact cannot be inlined.
    }
  }

  return images;
}

export function resultWithPluginArtifactImages(
  value: Record<string, unknown>,
  controllerHome: string,
  repoId: string,
  pluginResult: Record<string, unknown> | undefined,
): CallToolResult {
  const images = boundedPluginArtifactImageContent(controllerHome, repoId, pluginResult);
  const richResult: SdkCallToolResult = {
    content: [{ type: 'text', text: JSON.stringify(value) }, ...images],
    structuredContent: value,
  };
  return richResult as unknown as CallToolResult;
}

export function scrubPathText(text: string, replacements: string[]): string {
  let output = text;
  for (const replacement of [...new Set(replacements.filter((entry) => entry.startsWith('/')))].sort((left, right) => right.length - left.length)) {
    output = output.split(replacement).join('<repo>');
  }
  return output
    .replace(/\/(?:private\/)?tmp\/[^\s"']+/g, '<abs-path>')
    .replace(/\/(?:private\/)?var\/folders\/[^\s"']+/g, '<abs-path>')
    .replace(/\/Users\/[^\s"']+/g, '<abs-path>')
    .replace(/[A-Za-z]:\\[^\s"']+/g, '<abs-path>');
}

export function jsonPreview(
  value: unknown,
  maxChars = 800,
  replacements: string[] = [],
): { preview: string; truncated: boolean; byteLength: number } {
  const serialized = JSON.stringify(value);
  const redacted = redactMcpText(scrubPathText(serialized, replacements)).text;
  const byteLength = Buffer.byteLength(serialized);
  if (redacted.length <= maxChars) return { preview: redacted, truncated: false, byteLength };
  return { preview: `${redacted.slice(0, maxChars)}...`, truncated: true, byteLength };
}
