import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { DEFAULT_AGENT_TIMEOUT_MS, defaultLocalAgentRunners, MAX_AGENT_TIMEOUT_MS } from './runtime-config';


export type ToolProfileName = 'planner' | 'executor' | 'controller';
export type ToolAgentRunnerName = 'claude';

export interface ToolPolicy {
  profile: ToolProfileName;
  readGlobs: string[];
  writeGlobs: string[];
  denyGlobs: string[];
  maxFileBytes: number;
  execution: {
    agentRunner: boolean;
    allowedAgents: ToolAgentRunnerName[];
    runnerTimeoutMs: number;
    runnerMaxTimeoutMs: number;
  };
}

const COMMON_DENY_GLOBS = [
  '.env',
  '.env.*',
  '*.pem',
  '*.key',
  '*.p12',
  '*.pfx',
  '.ssh/**',
  '.git/**',
  'node_modules/**',
  'dist/**',
  'build/**',
  'coverage/**',
  'secrets/**',
  'credentials/**',
  'private/**',
  '.cache/**',
  '.DS_Store',
];

export const PLANNER_READ_GLOBS = [
  'AGENTS.md',
  'CLAUDE.md',
  'SKILL.md',
  'docs/spec.md',
  'docs/reference-configs/**',
  'plans/**',
  'tasks/current.md',
  'tasks/contracts/**',
  'tasks/reviews/**',
  'tasks/notes/**',
  '.ai/context/**',
  '.ai/harness/session/**',
  '.ai/harness/controller/packets/**',
  '.ai/harness/projections/**',
  '.ai/harness/checks/**',
];

export const PLANNER_WRITE_GLOBS = [
  'plans/prds/**',
  'plans/sprints/**',
  'plans/plan-*.md',
];

export interface ToolPolicyOptions {
  devAgentRunner?: boolean;
  allowedAgents?: ToolAgentRunnerName[];
  runnerTimeoutMs?: number;
  runnerMaxTimeoutMs?: number;
  repoRoot?: string;
}

interface ToolPolicyOverrideProfile {
  readGlobs?: string[];
  writeGlobs?: string[];
  denyGlobs?: string[];
  appendReadGlobs?: string[];
  appendWriteGlobs?: string[];
  appendDenyGlobs?: string[];
  maxFileBytes?: number;
}

interface ToolPolicyOverrideFile {
  profiles?: Partial<Record<ToolProfileName, ToolPolicyOverrideProfile>>;
}

function executionPolicy(overrides: Partial<ToolPolicy['execution']> = {}): ToolPolicy['execution'] {
  return {
    agentRunner: false,
    allowedAgents: [],
    runnerTimeoutMs: DEFAULT_AGENT_TIMEOUT_MS,
    runnerMaxTimeoutMs: MAX_AGENT_TIMEOUT_MS,
    ...overrides,
  };
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values.filter((value) => value.trim().length > 0)));
}

function parseStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const normalized = value.map((entry) => String(entry).trim()).filter((entry) => entry.length > 0);
  return normalized;
}

function loadToolPolicyOverrides(repoRoot?: string): ToolPolicyOverrideFile | undefined {
  if (!repoRoot) return undefined;
  const path = // Data-file name kept for existing repository config compatibility.
			join(repoRoot, '.forge', 'mcp.policy.json');
  if (!existsSync(path)) return undefined;
  const raw = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>;
  const profilesRaw = raw.profiles;
  if (!profilesRaw || typeof profilesRaw !== 'object' || Array.isArray(profilesRaw)) return undefined;
  const profiles: Partial<Record<ToolProfileName, ToolPolicyOverrideProfile>> = {};
  for (const profile of ['planner', 'executor', 'controller'] as const) {
    const entry = (profilesRaw as Record<string, unknown>)[profile];
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    const maxFileBytes = typeof record.maxFileBytes === 'number' && Number.isFinite(record.maxFileBytes)
      ? Math.trunc(record.maxFileBytes)
      : undefined;
    profiles[profile] = {
      readGlobs: parseStringArray(record.readGlobs),
      writeGlobs: parseStringArray(record.writeGlobs),
      denyGlobs: parseStringArray(record.denyGlobs),
      appendReadGlobs: parseStringArray(record.appendReadGlobs),
      appendWriteGlobs: parseStringArray(record.appendWriteGlobs),
      appendDenyGlobs: parseStringArray(record.appendDenyGlobs),
      maxFileBytes,
    };
  }
  return { profiles };
}

function applyPolicyOverrides(
  base: ToolPolicy,
  profile: ToolProfileName,
  repoRoot?: string,
): ToolPolicy {
  const override = loadToolPolicyOverrides(repoRoot)?.profiles?.[profile];
  if (!override) return base;
  return {
    ...base,
    readGlobs: uniqueStrings([...(override.readGlobs ?? base.readGlobs), ...(override.appendReadGlobs ?? [])]),
    writeGlobs: uniqueStrings([...(override.writeGlobs ?? base.writeGlobs), ...(override.appendWriteGlobs ?? [])]),
    denyGlobs: uniqueStrings([...COMMON_DENY_GLOBS, ...(override.denyGlobs ?? base.denyGlobs), ...(override.appendDenyGlobs ?? [])]),
    maxFileBytes: override.maxFileBytes ?? base.maxFileBytes,
  };
}

export function getToolPolicy(profile: ToolProfileName, opts: ToolPolicyOptions = {}): ToolPolicy {
  if (profile === 'planner') {
    return applyPolicyOverrides({
      profile,
      readGlobs: PLANNER_READ_GLOBS,
      writeGlobs: PLANNER_WRITE_GLOBS,
      denyGlobs: [
        ...COMMON_DENY_GLOBS,
        'src/**',
        'app/**',
        'packages/**',
        'package.json',
        'bun.lock',
        'package-lock.json',
        'pnpm-lock.yaml',
        'yarn.lock',
        '.github/workflows/**',
      ],
      maxFileBytes: 512 * 1024,
      execution: executionPolicy(),
    }, profile, opts.repoRoot);
  }

  if (profile === 'executor') {
    return applyPolicyOverrides({
      profile,
      readGlobs: ['plans/**', 'tasks/**', 'docs/spec.md', '.ai/context/**', '.ai/harness/**'],
      writeGlobs: ['tasks/reviews/**', '.ai/harness/checks/**', '.ai/harness/session/**', '.ai/harness/controller/packets/**'],
      denyGlobs: COMMON_DENY_GLOBS,
      maxFileBytes: 512 * 1024,
      execution: executionPolicy(),
    }, profile, opts.repoRoot);
  }

  if (profile === 'controller') {
    const devRunner = opts.devAgentRunner === true;
    return applyPolicyOverrides({
      profile,
      readGlobs: ['**'],
      writeGlobs: ['**'],
      denyGlobs: [
        ...COMMON_DENY_GLOBS,
        '.forge/**',
        '.ai/harness/security/**',
        '.codex/**',
        '.claude/**',
        'package-lock.json',
        'pnpm-lock.yaml',
        'yarn.lock',
        'bun.lock',
        '.github/workflows/**',
      ],
      maxFileBytes: 2 * 1024 * 1024,
      execution: executionPolicy({
        agentRunner: devRunner,
        allowedAgents: devRunner ? (opts.allowedAgents?.length ? opts.allowedAgents : defaultLocalAgentRunners()) : [],
        runnerTimeoutMs: opts.runnerTimeoutMs ?? DEFAULT_AGENT_TIMEOUT_MS,
        runnerMaxTimeoutMs: opts.runnerMaxTimeoutMs ?? MAX_AGENT_TIMEOUT_MS,
      }),
    }, profile, opts.repoRoot);
  }

  throw new Error(`unknown MCP profile: ${String(profile)}`);
}

export function parseToolProfile(value: string): ToolProfileName {
  if (value === 'planner' || value === 'executor' || value === 'controller') return value;
  throw new Error(`invalid MCP profile "${value}" (expected: planner, executor, controller)`);
}
