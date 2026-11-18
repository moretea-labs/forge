import { applyRuntimeCleanupArguments } from '../runtime/maintenance/cleanup';
import { resolve } from 'path';
import { getRepository, resolveRepositorySelection } from '../runtime/repositories/registry';
import { executeReadOnlyDiagnostic, isReadOnlyDiagnosticTool } from '../runtime/diagnostics/read-only-tool';

function requiredOption(argv: string[], name: string): string {
  const index = argv.indexOf(name);
  const value = index >= 0 ? argv[index + 1]?.trim() : undefined;
  if (!value) throw new Error(`DIAGNOSTIC_OPTION_REQUIRED: ${name}`);
  return value;
}

export async function runImmutableDiagnosticCli(argv = process.argv.slice(1)): Promise<void> {
  const commandIndex = argv.indexOf('runtime');
  if (commandIndex < 0 || !['diagnostic-read', 'maintenance-apply'].includes(argv[commandIndex + 1] ?? '')) {
    throw new Error('DIAGNOSTIC_USAGE: runtime diagnostic-read --controller-home <path> --repo-id <id> --tool <name> --args-base64 <payload>');
  }
  const controllerHome = resolve(requiredOption(argv, '--controller-home'));
  const repoId = requiredOption(argv, '--repo-id');
  const tool = requiredOption(argv, '--tool');
  const argsBase64 = requiredOption(argv, '--args-base64');
  const cleanup = argv[commandIndex + 1] === 'maintenance-apply';
  if (cleanup ? tool !== 'runtime_cleanup_apply' : !isReadOnlyDiagnosticTool(tool)) throw new Error(`DIAGNOSTIC_TOOL_UNSUPPORTED: ${tool}`);
  const repository = getRepository(repoId, controllerHome);
  if (!repository) throw new Error(`REPOSITORY_NOT_FOUND: ${repoId}`);
  let args: Record<string, unknown>;
  try {
    const decoded = JSON.parse(Buffer.from(argsBase64, 'base64url').toString('utf8')) as unknown;
    if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) throw new Error('arguments must be a JSON object');
    args = decoded as Record<string, unknown>;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`DIAGNOSTIC_ARGUMENTS_INVALID: ${detail}`);
  }
  const selected = cleanup ? resolveRepositorySelection({ controllerHome, repoId, checkoutId: typeof args.checkout_id === 'string' ? args.checkout_id : undefined }) : repository;
  if (!selected) throw new Error(`REPOSITORY_NOT_FOUND: ${repoId}`);
  process.stdout.write(JSON.stringify(cleanup
    ? applyRuntimeCleanupArguments(controllerHome, selected.canonicalRoot, args)
    : await executeReadOnlyDiagnostic(tool as import('../runtime/diagnostics/read-only-tool').ReadOnlyDiagnosticTool, controllerHome, selected, args)));
}

void runImmutableDiagnosticCli().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
