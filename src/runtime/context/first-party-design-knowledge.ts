import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// One digest-checked, first-party Context source. No Design plugin, approval
// lifecycle, or repository-specific authority is created by these assets.
const MANIFEST_PATH = 'assets/knowledge-packs/v1/manifest.json';
const MAX_PACK_CHARS = 12_000;
const PACK_PATHS = {
  'design-ui-ux': 'assets/knowledge-packs/v1/design-ui-ux.md',
  'ios-engineering': 'assets/knowledge-packs/v1/ios-engineering.md',
} as const;

/**
 * Compiled Runtime binaries do not keep this module next to `assets/`. Prefer the
 * active immutable release package root from the Runtime environment, then fall
 * back to the source/package layout used by tests and unpacked checkouts (#640).
 */
export function resolveFirstPartyKnowledgePackageRoot(
  env: NodeJS.ProcessEnv = process.env,
  moduleUrl: string = import.meta.url,
): string {
  for (const key of ['FORGE_RELEASE_PATH', 'FORGE_CONTROLLER_RUNTIME_SOURCE_ROOT'] as const) {
    const releaseRoot = env[key]?.trim();
    if (!releaseRoot) continue;
    const packaged = resolve(releaseRoot, 'package');
    if (existsSync(resolve(packaged, MANIFEST_PATH))) return packaged;
    if (existsSync(resolve(releaseRoot, MANIFEST_PATH))) return releaseRoot;
  }
  return resolve(dirname(fileURLToPath(moduleUrl)), '../../..');
}

export type FirstPartyKnowledgeId = keyof typeof PACK_PATHS;
export const UI_UX_INTENT =
  /\b(?:ui|ux|swiftui|view|screen|layout|design|visual|style|sheet|form)\b|界面|页面|布局|设计|视觉|交互|样式|复刻|卡片|弹窗|图标|光学对齐/i;
export const IOS_ENGINEERING_INTENT =
  /\b(?:ios|ipados|swift|swiftui|xcode|xctest|iphone|ipad|coredevice|simctl|testflight|xcarchive|simulator|provisioning)\b|苹果开发|苹果应用|开发者证书|iOS签名|iOS构建|iPhone真机|iPhone模拟器|真机安装Beta/i;

export interface FirstPartyDesignKnowledge {
  id: FirstPartyKnowledgeId;
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

// All paths are selected from this fixed table, never from an untrusted
// manifest. A missing or tampered pack becomes visible degraded evidence.
export function readFirstPartyKnowledge(
  id: FirstPartyKnowledgeId,
  packageRoot = resolveFirstPartyKnowledgePackageRoot(),
): FirstPartyDesignKnowledge {
  const path = PACK_PATHS[id];
  const base = { id, authority: 'advisory' as const, source: 'forge_first_party' as const, path };
  let manifest: { schemaVersion?: unknown; packVersion?: unknown; packages?: Array<Record<string, unknown>> };
  try {
    manifest = JSON.parse(readFileSync(resolve(packageRoot, MANIFEST_PATH), 'utf8'));
  } catch {
    return { ...base, status: 'unavailable', reason: 'asset_unreadable' };
  }
  if (!manifest || !Array.isArray(manifest.packages)) {
    return { ...base, status: 'unavailable', reason: 'manifest_invalid' };
  }
  const entry = manifest.packages.find((candidate) => candidate?.id === id);
  if (
    manifest.schemaVersion !== 1 ||
    manifest.packVersion !== 'v1' ||
    entry?.path !== path ||
    entry?.authority !== 'advisory' ||
    entry?.pluginRequired !== false ||
    !Array.isArray(entry?.sourceProvenance) ||
    typeof entry.sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(entry.sha256)
  ) {
    return { ...base, status: 'unavailable', reason: 'manifest_invalid' };
  }
  let content: string;
  try {
    content = readFileSync(resolve(packageRoot, path), 'utf8');
  } catch {
    return { ...base, status: 'unavailable', reason: 'asset_unreadable' };
  }
  const digest = createHash('sha256').update(content, 'utf8').digest('hex');
  if (digest !== entry.sha256) return { ...base, status: 'unavailable', reason: 'digest_mismatch' };
  return {
    ...base,
    status: 'ready',
    packVersion: manifest.packVersion,
    digest: `sha256:${digest}`,
    sourceProvenance: entry.sourceProvenance.filter((item): item is string => typeof item === 'string').slice(0, 12),
    content: content.slice(0, MAX_PACK_CHARS),
    truncated: content.length > MAX_PACK_CHARS,
  };
}

export function readFirstPartyDesignKnowledge(
  packageRoot = resolveFirstPartyKnowledgePackageRoot(),
): FirstPartyDesignKnowledge {
  return readFirstPartyKnowledge('design-ui-ux', packageRoot);
}

export function readFirstPartyIosEngineeringKnowledge(
  packageRoot = resolveFirstPartyKnowledgePackageRoot(),
): FirstPartyDesignKnowledge {
  return readFirstPartyKnowledge('ios-engineering', packageRoot);
}
