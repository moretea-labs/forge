import { readFileSync } from 'fs';
import { posix, resolve } from 'path';
import type { McpPolicy } from '../../../../adapters/mcp/types';
import { readableFile } from './known-paths';

const CONTRACT_NAMES = ['AGENTS.md', 'CLAUDE.md'] as const;
// UI sources need the repository's existing design rules as read evidence,
// not a second policy store or a new design-approval gate.
const UI_INTENT = /\b(?:ui|ux|swiftui|view|screen|layout|design|visual|style|sheet|form)\b|界面|页面|布局|设计|视觉|交互|样式|复刻|卡片|弹窗/i;
const DESIGN_REFERENCE = /\x60([^\x60\n]+\.md)\x60/g;
const DEFAULT_MAX_TARGETS = 12;
const DEFAULT_MAX_CONTRACTS = 12;
const DEFAULT_MAX_CHARS_PER_CONTRACT = 12_000;
const DEFAULT_MAX_TOTAL_CHARS = 48_000;

export interface RepositoryInstructionContract {
  path: string;
  appliesTo: string[];
  content: string;
  truncated: boolean;
}

export interface RepositoryInstructionContext {
  status: 'none' | 'ready' | 'degraded';
  authority: 'guidance_only';
  targetPaths: string[];
  contracts: RepositoryInstructionContract[];
  coverageGaps: string[];
  truncated: boolean;
}

function isInstructionContract(path: string): boolean {
  const name = posix.basename(path);
  return name === 'AGENTS.md' || name === 'CLAUDE.md';
}

function directoryChain(path: string): string[] {
  const directory = posix.dirname(path);
  if (directory === '.' || directory === '/') return [''];
  const segments = directory.split('/').filter(Boolean);
  const chain = [''];
  for (let index = 1; index <= segments.length; index += 1) chain.push(segments.slice(0, index).join('/'));
  return chain;
}

export function buildRepositoryInstructionContext(
  repoRoot: string,
  policy: McpPolicy,
  targetPaths: string[],
  options: { maxTargets?: number; maxContracts?: number; maxCharsPerContract?: number; maxTotalChars?: number; uiIntent?: string } = {},
): RepositoryInstructionContext {
  const maxTargets = Math.max(1, Math.min(30, Math.trunc(options.maxTargets ?? DEFAULT_MAX_TARGETS)));
  const maxContracts = Math.max(1, Math.min(30, Math.trunc(options.maxContracts ?? DEFAULT_MAX_CONTRACTS)));
  const maxCharsPerContract = Math.max(500, Math.min(50_000, Math.trunc(options.maxCharsPerContract ?? DEFAULT_MAX_CHARS_PER_CONTRACT)));
  const maxTotalChars = Math.max(2_000, Math.min(100_000, Math.trunc(options.maxTotalChars ?? DEFAULT_MAX_TOTAL_CHARS)));
  const allTargets = [...new Set(targetPaths.map((path) => path.trim()).filter(Boolean).filter((path) => !isInstructionContract(path)))];
  // Requirement-only lookup may know just AGENTS.md (root or module)
  // before finding any source file. Preserve that explicitly named guide as
  // a scope anchor; excluding it otherwise drops the applicable rules.
  const explicitGuide = targetPaths.find((path) => isInstructionContract(path.trim()));
  const targets = allTargets.length > 0
    ? allTargets.slice(0, maxTargets)
    : explicitGuide ? [explicitGuide.trim()] : [];
  const coverageGaps: string[] = [];
  if (allTargets.length > targets.length) coverageGaps.push(`instruction_targets_truncated:${allTargets.length - targets.length}`);

  const contractTargets = new Map<string, Set<string>>();
  const denied = new Set<string>();
  for (const target of targets) {
    for (const directory of directoryChain(target)) {
      for (const name of CONTRACT_NAMES) {
        const candidate = directory ? `${directory}/${name}` : name;
        const readable = readableFile(repoRoot, policy, candidate);
        if (!readable.ok) {
          if (!readable.reason.startsWith('path does not exist')) denied.add(`${candidate}:${readable.reason}`);
          continue;
        }
        const appliesTo = contractTargets.get(readable.path) ?? new Set<string>();
        appliesTo.add(target);
        contractTargets.set(readable.path, appliesTo);
      }
    }
  }
  // Opt-in by the user's UI/design task or a concrete View owner. Only read
  // design paths already declared by repository guidance, plus root DESIGN.md.
  // Policy and byte limits are the same as for AGENTS.md.
  const isUiTask = UI_INTENT.test(options.uiIntent ?? '')
    || targets.some(path => /(?:\/Views?\/|(?:View|Screen)\.(?:swift|tsx|jsx)$)/i.test(path));
  if (isUiTask && targets.length > 0) {
    const designPaths = new Set<string>();
    const declaredGuidance = [...contractTargets.keys()];
      // Never derive product facts or design requirements from the retriever.
    for (const guidePath of declaredGuidance) {
      try {
        const text = readFileSync(resolve(repoRoot, guidePath), 'utf8').slice(0, 64_000);
        for (const match of text.matchAll(DESIGN_REFERENCE)) {
          const reference = match[1]?.trim();
          if (!reference || !/(?:^|\/)(?:design\/|design-rules\.md$)|^DESIGN\.md$/i.test(reference)) continue;
          if (reference.startsWith('/') || reference.includes('..')) continue;
          for (const candidate of [
            reference,
            posix.normalize(posix.join(posix.dirname(guidePath), reference)),
          ]) {
            const readable = readableFile(repoRoot, policy, candidate);
            if (readable.ok) { designPaths.add(readable.path); break; }
          }
          if (designPaths.size >= 4) break;
        }
      } catch {
        coverageGaps.push(`instruction_contract_read_failed:${guidePath}`);
      }
      if (designPaths.size >= 4) break;
    }
    const rootDesign = readableFile(repoRoot, policy, 'DESIGN.md');
    if (rootDesign.ok) designPaths.add(rootDesign.path);
    for (const path of designPaths) {
      const appliesTo = contractTargets.get(path) ?? new Set<string>();
      targets.forEach(target => appliesTo.add(target));
      contractTargets.set(path, appliesTo);
    }
  }
  if (denied.size > 0) coverageGaps.push(...[...denied].sort().map((entry) => `instruction_contract_unreadable:${entry}`));

  const orderedPaths = [...contractTargets.keys()].sort((left, right) => {
    const leftDepth = left.split('/').length;
    const rightDepth = right.split('/').length;
    if (leftDepth !== rightDepth) return leftDepth - rightDepth;
    const leftName = posix.basename(left);
    const rightName = posix.basename(right);
    if (leftName !== rightName) return CONTRACT_NAMES.indexOf(leftName as typeof CONTRACT_NAMES[number]) - CONTRACT_NAMES.indexOf(rightName as typeof CONTRACT_NAMES[number]);
    return left.localeCompare(right);
  });
  const selectedPaths = orderedPaths.slice(0, maxContracts);
  if (orderedPaths.length > selectedPaths.length) coverageGaps.push(`instruction_contracts_truncated:${orderedPaths.length - selectedPaths.length}`);

  const contracts: RepositoryInstructionContract[] = [];
  const fairContractBudget = Math.max(500, Math.min(maxCharsPerContract, Math.floor(maxTotalChars / Math.max(1, selectedPaths.length))));
  for (const path of selectedPaths) {
    try {
      const raw = readFileSync(resolve(repoRoot, path), 'utf8');
      const truncated = raw.length > fairContractBudget;
      contracts.push({
        path,
        appliesTo: [...(contractTargets.get(path) ?? new Set<string>())].sort(),
        content: truncated ? raw.slice(0, fairContractBudget) : raw,
        truncated,
      });
      if (truncated) coverageGaps.push(`instruction_contract_content_truncated:${path}`);
    } catch (error) {
      coverageGaps.push(`instruction_contract_read_failed:${path}:${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return {
    status: coverageGaps.length > 0 ? 'degraded' : contracts.length > 0 ? 'ready' : 'none',
    authority: 'guidance_only',
    targetPaths: targets,
    contracts,
    coverageGaps: coverageGaps.slice(0, 30),
    truncated: allTargets.length > targets.length || orderedPaths.length > selectedPaths.length || contracts.some((entry) => entry.truncated),
  };
}
