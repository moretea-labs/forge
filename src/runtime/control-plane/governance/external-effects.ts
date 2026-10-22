const EXPLICIT_AUTHORIZATION_OPERATIONS = new Set([
  'publish_issue_to_github',
  'close_github_issue',
  'repository_remove',
  'repository_disable',
  'execute_command',
]);


const AUTOMATED_REQUIREMENT_OPERATIONS = new Set([
  'create_issue',
  'append_task',
]);

const DANGEROUS_COMMAND_PATTERNS = [
  /\bgit\s+(?:push|merge|rebase|reset|branch\s+-[dD]|tag\s+-d)\b/i,
  /\bgh\s+(?:pr\s+(?:merge|close)|issue\s+close|release\s+(?:create|delete))\b/i,
  /\b(?:npm|pnpm|yarn|bun)\s+(?:publish|unpublish)\b/i,
  /\b(?:kubectl|helm)\b.*\b(?:apply|delete|upgrade|rollback)\b/i,
  /\b(?:drop|truncate|delete\s+from)\b/i,
  /\b(?:deploy|publish)\b/i,
];

export function operationRequiresHumanAuthorization(operation: string, args: Record<string, unknown> = {}): boolean {
  if (EXPLICIT_AUTHORIZATION_OPERATIONS.has(operation)) return true;
  const command = typeof args.command === 'string' ? args.command : '';
  const gitArgs = Array.isArray(args.args) ? args.args.map(String).join(' ') : '';
  const text = `${operation} ${command} ${gitArgs}`;
  return DANGEROUS_COMMAND_PATTERNS.some((pattern) => pattern.test(text));
}

export function assertAutomatedOperationAllowed(operation: string, args: Record<string, unknown> = {}): void {
  if (AUTOMATED_REQUIREMENT_OPERATIONS.has(operation)) {
    throw new Error(`AUTOMATED_REQUIREMENT_REQUIRES_CANDIDATE: ${operation} must first create a candidate finding for human promotion`);
  }
  if (operationRequiresHumanAuthorization(operation, args)) {
    throw new Error(`EXTERNAL_EFFECT_AUTHORIZATION_REQUIRED: ${operation} cannot be executed by a Schedule, Portfolio workflow, or reconciliation loop`);
  }
}
