import { readFileSync, realpathSync, statSync } from 'fs';
import { isAbsolute, relative, resolve, sep } from 'path';
import type { CallToolResult as SdkCallToolResult } from '@modelcontextprotocol/client';
import type { CallToolResult } from '../../../packages/protocols/mcp/tool-contract';
import {
  CONTROLLER_SCOPE_REPO_ID,
  FORGE_INSTANCE_SCOPE_KEY,
  controllerSystemRoot,
  repositoryControllerRoot,
} from '../../../src/effects/controller-home';
import { redactMcpText } from '../redaction';

/** Transport-only MCP result envelope. No lifecycle or domain mutation belongs here. */
export function result(value: Record<string, unknown>, isError = false, serializedText?: string): CallToolResult {
  return {
    content: [{ type: 'text', text: serializedText ?? JSON.stringify(value) }],
    structuredContent: value,
    ...(isError ? { isError: true } : {}),
  };
}

export function serializeResultPayload(value: Record<string, unknown>): { text: string; byteLength: number } {
  const serialized = JSON.stringify(value);
  if (typeof serialized !== 'string') throw new Error('MCP_RESPONSE_NOT_SERIALIZABLE');
  const marker = '"structuredPayloadBytes":0';
  const markerIndex = serialized.lastIndexOf(marker);
  if (markerIndex < 0) return { text: serialized, byteLength: Buffer.byteLength(serialized, 'utf8') };

  let byteLength = Buffer.byteLength(serialized, 'utf8');
  let text = serialized;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const replacement = `"structuredPayloadBytes":${byteLength}`;
    text = serialized.slice(0, markerIndex) + replacement + serialized.slice(markerIndex + marker.length);
    const measured = Buffer.byteLength(text, 'utf8');
    if (measured === byteLength) break;
    byteLength = measured;
  }
  if (Buffer.byteLength(text, 'utf8') !== byteLength) throw new Error('MCP_RESPONSE_BYTE_COUNT_UNSTABLE');
  const responseMeta = value.responseMeta;
  if (responseMeta && typeof responseMeta === 'object' && !Array.isArray(responseMeta)) {
    (responseMeta as Record<string, unknown>).structuredPayloadBytes = byteLength;
  }
  return { text, byteLength };
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
  const nestedResult =
    pluginResult.result && typeof pluginResult.result === 'object' && !Array.isArray(pluginResult.result)
      ? (pluginResult.result as Record<string, unknown>)
      : undefined;
  const candidates = [
    ...(Array.isArray(pluginResult.artifactCandidates) ? pluginResult.artifactCandidates : []),
    ...(nestedResult && Array.isArray(nestedResult.artifactCandidates) ? nestedResult.artifactCandidates : []),
  ];
  if (candidates.length === 0) return [];
  const instanceScoped = repoId === FORGE_INSTANCE_SCOPE_KEY || repoId === CONTROLLER_SCOPE_REPO_ID;
  const allowedRoots = instanceScoped
    ? [
        resolve(controllerSystemRoot(controllerHome)),
        resolve(repositoryControllerRoot(controllerHome, CONTROLLER_SCOPE_REPO_ID)),
      ]
    : [resolve(repositoryControllerRoot(controllerHome, repoId))];
  const images: McpImageContent[] = [];
  const seenPaths = new Set<string>();

  for (const candidate of candidates) {
    if (images.length >= MAX_INLINE_PLUGIN_IMAGES) break;
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue;
    const record = candidate as Record<string, unknown>;
    const mediaType = typeof record.mediaType === 'string' ? record.mediaType : '';
    const path = typeof record.path === 'string' ? record.path : '';
    if (!INLINE_PLUGIN_IMAGE_MEDIA_TYPES.has(mediaType) || !path) continue;

    try {
      const resolvedPath = realpathSync(path);
      if (seenPaths.has(resolvedPath)) continue;
      const contained = allowedRoots.some((allowedRoot) => {
        // Compare physical paths: a controller-local symlink must not expose
        // a screenshot (or any file) outside the selected storage authority.
        let root: string;
        try {
          root = realpathSync(allowedRoot);
        } catch {
          return false;
        }
        const rel = relative(root, resolvedPath);
        return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
      });
      if (!contained) continue;
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

const SCREENSHOT_ARTIFACT_KINDS = new Set(['ios_simulator_screenshot', 'ios_agent_device_screenshot']);

function hasScreenshotArtifact(value: Record<string, unknown> | undefined): boolean {
  if (!value) return false;
  const nested =
    value.result && typeof value.result === 'object' && !Array.isArray(value.result)
      ? (value.result as Record<string, unknown>)
      : undefined;
  const candidates = [
    ...(Array.isArray(value.artifactCandidates) ? value.artifactCandidates : []),
    ...(nested && Array.isArray(nested.artifactCandidates) ? nested.artifactCandidates : []),
  ];
  return candidates.some(
    (candidate) =>
      candidate &&
      typeof candidate === 'object' &&
      !Array.isArray(candidate) &&
      [candidate.kind, candidate.artifactType].some(
        (kind) => typeof kind === 'string' && SCREENSHOT_ARTIFACT_KINDS.has(kind),
      ),
  );
}

function compactSubmittedPluginPayload(
  value: Record<string, unknown>,
  screenshotArtifact = false,
): Record<string, unknown> {
  const compact = { ...value };
  delete compact.artifactCandidates;
  if (screenshotArtifact || SCREENSHOT_ARTIFACT_KINDS.has(String(compact.artifactType ?? ''))) {
    // The portable screenshot reference is enough; local paths and shell argv stay controller-owned.
    delete compact.absolutePath;
    delete compact.command;
  }
  return compact;
}

/** Compact submitted provider metadata while extracting images from its original envelope. */
export function resultWithSubmittedPluginActionImages(
  value: Record<string, unknown>,
  controllerHome: string,
  repoId: string,
  submittedResult: Record<string, unknown> | undefined,
): CallToolResult {
  const nested = submittedResult?.result;
  const screenshotArtifact = hasScreenshotArtifact(submittedResult);
  const compactNested =
    nested && typeof nested === 'object' && !Array.isArray(nested)
      ? compactSubmittedPluginPayload(nested as Record<string, unknown>, screenshotArtifact)
      : undefined;
  const compactResult = compactNested
    ? {
        ...compactNested,
        ...(submittedResult?.work && typeof submittedResult.work === 'object' && !Array.isArray(submittedResult.work)
          ? { work: submittedResult.work }
          : {}),
      }
    : submittedResult
      ? compactSubmittedPluginPayload(submittedResult, screenshotArtifact)
      : undefined;
  const compactValue = compactResult ? { ...value, result: compactResult } : value;
  return resultWithPluginArtifactImages(compactValue, controllerHome, repoId, submittedResult);
}

export function scrubPathText(text: string, replacements: string[]): string {
  let output = text;
  for (const replacement of [...new Set(replacements.filter((entry) => entry.startsWith('/')))].sort(
    (left, right) => right.length - left.length,
  )) {
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
