import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Packaged beside Forge source in both npm distributions and immutable Runtime
// releases. This is the existing Context Plane's advisory input, not a Plugin
// or a new lifecycle/approval authority.
const DEFAULT_PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const MANIFEST_PATH = 'assets/knowledge-packs/v1/manifest.json';
const DESIGN_PATH = 'assets/knowledge-packs/v1/design-ui-ux.md';
const MAX_DESIGN_CHARS = 12_000;

export const UI_UX_INTENT = /\b(?:ui|ux|swiftui|view|screen|layout|design|visual|style|sheet|form)\b|界面|页面|布局|设计|视觉|交互|样式|复刻|卡片|弹窗|图标|光学对齐/i;

export interface FirstPartyDesignKnowledge {
  id: 'design-ui-ux';
  status: 'ready' | 'unavailable';
  authority: 'advisory';
  source: 'forge_first_party';
  path: string;
  packVersion?: string;
  digest?: string;
  sourceProvenance?: string[];
  content?: string;
  truncated?: boolean;
  reason?: 'manifest_invalid' | 'asset_unreadable' | 'digest_mismatch';
}

// A narrow, deterministic materializer. Only the packaged, pinned file can be
// read: a forged manifest path may not open an arbitrary local file. Missing or
// tampered content is visible to the caller and never silently accepted.
export function readFirstPartyDesignKnowledge(packageRoot = DEFAULT_PACKAGE_ROOT): FirstPartyDesignKnowledge {
  const base = {
    id: 'design-ui-ux' as const,
    authority: 'advisory' as const,
    source: 'forge_first_party' as const,
    path: DESIGN_PATH,
  };
  let manifest: {
    schemaVersion?: unknown;
    packVersion?: unknown;
    packages?: Array<Record<string, unknown>>;
  };
  try {
    manifest = JSON.parse(readFileSync(resolve(packageRoot, MANIFEST_PATH), 'utf8'));
  } catch {
    return { ...base, status: 'unavailable', reason: 'asset_unreadable' };
  }
  if (!manifest || !Array.isArray(manifest.packages)) {
    return { ...base, status: 'unavailable', reason: 'manifest_invalid' };
  }
  const entry = manifest.packages.find(candidate => candidate?.id === base.id);
  if (manifest.schemaVersion !== 1 || manifest.packVersion !== 'v1'
    || entry?.path !== DESIGN_PATH || entry?.authority !== 'advisory'
    || entry?.pluginRequired !== false || !Array.isArray(entry?.sourceProvenance)
    || typeof entry.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(entry.sha256)) {
    return { ...base, status: 'unavailable', reason: 'manifest_invalid' };
  }
  let content: string;
  try {
    content = readFileSync(resolve(packageRoot, DESIGN_PATH), 'utf8');
  } catch {
    return { ...base, status: 'unavailable', reason: 'asset_unreadable' };
  }
  const digest = createHash('sha256').update(content, 'utf8').digest('hex');
  if (digest !== entry.sha256) {
    return { ...base, status: 'unavailable', reason: 'digest_mismatch' };
  }
  return {
    ...base,
    status: 'ready',
    packVersion: manifest.packVersion,
    digest: `sha256:${digest}`,
    sourceProvenance: entry.sourceProvenance.filter((item): item is string => typeof item === 'string').slice(0, 12),
    content: content.slice(0, MAX_DESIGN_CHARS),
    truncated: content.length > MAX_DESIGN_CHARS,
  };
}
