import type { SuggestedNextAction } from './types';

export interface CheckDefinitionLike {
  id: string;
}

export interface NormalizedCheckIds {
  validCheckIds: string[];
  invalidCheckIds: string[];
  warnings: string[];
  suggestedNextActions: SuggestedNextAction[];
}

function aliasesFor(availableIds: readonly string[]): Map<string, string> {
  const aliases = new Map<string, string>();
  for (const id of availableIds) {
    aliases.set(id, id);
    if (id.startsWith('package:')) aliases.set(id.slice('package:'.length), id);
  }
  const preferred: Array<[string, string[]]> = [
    ['typecheck', ['package:check:type', 'package:typecheck', 'package:check:types']],
    ['type', ['package:check:type', 'package:typecheck']],
    ['test', ['package:test', 'package:test:bun']],
    ['tests', ['package:test', 'package:test:bun']],
    ['lint', ['package:lint', 'package:check:lint']],
    ['forge-runtime', ['package:check:forge-runtime']],
    ['docs', ['package:check:docs', 'check:docs']],
  ];
  for (const [alias, candidates] of preferred) {
    const match = candidates.find((candidate) => availableIds.includes(candidate));
    if (match) aliases.set(alias, match);
  }
  return aliases;
}

export function normalizeCheckId(input: string, available: readonly CheckDefinitionLike[]): string | undefined {
  const availableIds = available.map((check) => check.id);
  const aliasMap = aliasesFor(availableIds);
  const requestedId = String(input).trim();
  if (!requestedId) return undefined;
  return aliasMap.get(requestedId);
}

export function validateCheckIdAgainstRegistry(
  checkId: string,
  available: readonly CheckDefinitionLike[],
): { valid: boolean; normalizedCheckId?: string; warning?: string } {
  const normalized = normalizeCheckId(checkId, available);
  if (normalized) return { valid: true, normalizedCheckId: normalized };
  return {
    valid: false,
    warning: `invalid_check_id: ${checkId} is not registered; it is classified as verification infrastructure metadata, not an actual check failure.`,
  };
}

export function normalizeCheckIds(
  requested: readonly string[],
  available: readonly CheckDefinitionLike[],
): NormalizedCheckIds {
  const valid: string[] = [];
  const invalid: string[] = [];
  for (const raw of requested) {
    const validation = validateCheckIdAgainstRegistry(raw, available);
    if (validation.valid && validation.normalizedCheckId) valid.push(validation.normalizedCheckId);
    else if (String(raw).trim()) invalid.push(String(raw).trim());
  }
  const validCheckIds = [...new Set(valid)];
  const invalidCheckIds = [...new Set(invalid)];
  const warnings = invalidCheckIds.map((id) => `invalid_check_id: ${id} is not registered; it is classified as verification infrastructure metadata, not an actual check failure.`);
  return {
    validCheckIds,
    invalidCheckIds,
    warnings,
    // Registered check ids are evidence for the model to invoke run_check directly.
    // The facade does not translate them back into a retired Work verification verb.
    suggestedNextActions: [],
  };
}
