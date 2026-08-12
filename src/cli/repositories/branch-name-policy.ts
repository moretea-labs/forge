export const MAX_SAFE_BRANCH_NAME_LENGTH = 180;

export interface BranchNamePolicyOptions {
  readonly maxLength?: number;
  readonly purpose?: string;
}

const UNSAFE_BRANCH_CHARS = /[\s~^:?*[\\\]\0]/;

function reason(message: string, purpose?: string): Error {
  return new Error(`${purpose ?? 'GIT_BRANCH'}_INVALID: ${message}`);
}

export function branchSlugSegment(value: string, maxLength = 48): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[.-]+|[.-]+$/g, '')
    .replace(/\.{2,}/g, '.')
    .replace(/-{2,}/g, '-')
    .slice(0, maxLength)
    .replace(/[.-]+$/g, '');
  return slug || 'automation';
}

export function validateBranchName(raw: unknown, options: BranchNamePolicyOptions = {}): string {
  const branch = String(raw ?? '').trim();
  const maxLength = options.maxLength ?? MAX_SAFE_BRANCH_NAME_LENGTH;
  const purpose = options.purpose ?? 'GIT_BRANCH';
  if (!branch) throw reason('branch name is required', purpose);
  if (branch.length > maxLength) throw reason(`branch name exceeds ${maxLength} characters: ${branch}`, purpose);
  if (branch.startsWith('-')) throw reason(`branch name must not start with '-': ${branch}`, purpose);
  if (branch.startsWith('/') || branch.endsWith('/')) throw reason(`branch name must not start or end with '/': ${branch}`, purpose);
  if (branch.startsWith('refs/')) throw reason(`branch name must be relative, not a full ref: ${branch}`, purpose);
  if (branch === '@' || branch.includes('@{')) throw reason(`branch name contains forbidden @ syntax: ${branch}`, purpose);
  if (branch.includes('..')) throw reason(`branch name contains '..': ${branch}`, purpose);
  if (branch.endsWith('.')) throw reason(`branch name must not end with '.': ${branch}`, purpose);
  if (branch.endsWith('.lock')) throw reason(`branch name must not end with '.lock': ${branch}`, purpose);
  if (UNSAFE_BRANCH_CHARS.test(branch)) throw reason(`branch name contains unsafe characters: ${branch}`, purpose);
  for (const segment of branch.split('/')) {
    if (!segment) throw reason(`branch name contains an empty path segment: ${branch}`, purpose);
    if (segment.startsWith('.')) throw reason(`branch segment must not start with '.': ${branch}`, purpose);
    if (segment.endsWith('.lock')) throw reason(`branch segment must not end with '.lock': ${branch}`, purpose);
  }
  return branch;
}

export function branchRef(branch: unknown, options: BranchNamePolicyOptions = {}): string {
  return `refs/heads/${validateBranchName(branch, options)}`;
}
