import { readFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

export const FORGE_PRODUCT_ID = 'forge';

function readForgeVersion(): string {
  const buildVersion = process.env.FORGE_BUILD_VERSION?.trim();
  if (buildVersion) return buildVersion;
  const packagePath = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'package.json');
  try {
    const parsed = JSON.parse(readFileSync(packagePath, 'utf8')) as { version?: unknown };
    if (typeof parsed.version === 'string' && parsed.version.trim()) return parsed.version.trim();
  } catch {
    // Partial installs may omit package metadata; keep diagnostics explicit rather than inventing a component version.
  }
  return '0.0.0-unknown';
}

/** One product version for CLI, Runtime, Recovery, MCP and Connector diagnostics. */
export const FORGE_VERSION = readForgeVersion();
