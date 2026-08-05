import { Command } from 'commander';
import { resolveControllerHome } from '../repositories/controller-home';
import { findExecutionJob, listActiveExecutionJobs, listExecutionJobs } from '../../runtime/execution/jobs/store';
import { readJobEvents } from '../../runtime/evidence/event-ledger';
import { getRepository, listRepositories } from '../repositories/registry';
import { executeReadOnlyDiagnostic, isReadOnlyDiagnosticTool } from '../../runtime/diagnostics/read-only-tool';
import { readRepositoryProjection } from '../../runtime/projections/materialized-view';
import { listOccurrences, listSchedules } from '../../runtime/workflow/schedules/store';
import { observeRuntimeStatus } from '../../runtime/root/status';

function output(value: unknown, json = true): void {
  console.log(json ? JSON.stringify(value, null, 2) : String(value));
}

export function buildRuntimeCommand(): Command {
  const command = new Command('runtime').description('Inspect the canonical Runtime and durable execution state');

  command.command('status')
    .description('Read the Runtime Root status projection, active durable Jobs, and materialized repository projections')
    .requiredOption('--controller-home <path>', 'Explicit Controller Home')
    .option('--json', 'Output JSON')
    .action((opts: { controllerHome: string; json?: boolean }) => {
      const home = resolveControllerHome(opts.controllerHome);
      const runtime = observeRuntimeStatus(home);
      const repositories = listRepositories(home, { includeRemoved: true });
      const value = {
        runtime,
        activeJobs: listActiveExecutionJobs(home),
        repositories: repositories.map((repository) => readRepositoryProjection(home, repository.repoId)),
      };
      if (opts.json) return output(value);
      console.log([
        `runtime: ${runtime.running ? 'running' : 'not running'}`,
        `ready: ${String(runtime.ready)}`,
        `instance: ${runtime.snapshot?.runtimeInstanceId ?? 'none'}`,
        `release: ${runtime.snapshot?.releaseId ?? 'none'}`,
        `reasons: ${runtime.reasonCodes.join(', ') || 'none'}`,
      ].join('\n'));
    });

  command.command('job')
    .description('Inspect one durable Execution Job and its event ledger')
    .argument('<job-id>', 'Execution Job ID')
    .option('--controller-home <path>', 'Controller state root')
    .action((jobId: string, opts: { controllerHome?: string }) => {
      const home = resolveControllerHome(opts.controllerHome);
      const job = findExecutionJob(home, jobId);
      if (!job) throw new Error(`JOB_NOT_FOUND: ${jobId}`);
      output({ job, events: readJobEvents(home, job.repoId, job.jobId) });
    });

  command.command('jobs')
    .description('List durable Execution Jobs')
    .option('--controller-home <path>', 'Controller state root')
    .option('--repo-id <id>', 'Repository id')
    .option('--limit <count>', 'Maximum records', '100')
    .action((opts: { controllerHome?: string; repoId?: string; limit?: string }) => {
      const home = resolveControllerHome(opts.controllerHome);
      if (opts.repoId) return output({ jobs: listExecutionJobs(home, opts.repoId, Number(opts.limit ?? 100)) });
      output({ jobs: listActiveExecutionJobs(home) });
    });

  command.command('diagnostic-read', { hidden: true })
    .description('Internal isolated read-only diagnostic process entry')
    .requiredOption('--controller-home <path>', 'Controller state root')
    .requiredOption('--repo-id <id>', 'Repository id')
    .requiredOption('--tool <name>', 'Read-only diagnostic tool name')
    .requiredOption('--args-base64 <payload>', 'Base64url JSON arguments')
    .action(async (opts: { controllerHome: string; repoId: string; tool: string; argsBase64: string }) => {
      const home = resolveControllerHome(opts.controllerHome);
      const repository = getRepository(opts.repoId, home);
      if (!repository) throw new Error(`REPOSITORY_NOT_FOUND: ${opts.repoId}`);
      if (!isReadOnlyDiagnosticTool(opts.tool)) throw new Error(`DIAGNOSTIC_TOOL_UNSUPPORTED: ${opts.tool}`);
      let args: Record<string, unknown>;
      try {
        const decoded = JSON.parse(Buffer.from(opts.argsBase64, 'base64url').toString('utf8')) as unknown;
        if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) throw new Error('arguments must be a JSON object');
        args = decoded as Record<string, unknown>;
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(`DIAGNOSTIC_ARGUMENTS_INVALID: ${detail}`);
      }
      process.stdout.write(JSON.stringify(await executeReadOnlyDiagnostic(opts.tool, home, repository, args)));
    });

  command.command('schedules')
    .description('List bounded Schedules and Occurrences')
    .requiredOption('--repo-id <id>', 'Repository id')
    .option('--controller-home <path>', 'Controller state root')
    .action((opts: { controllerHome?: string; repoId: string }) => {
      const home = resolveControllerHome(opts.controllerHome);
      output({ schedules: listSchedules(home, opts.repoId), occurrences: listOccurrences(home, opts.repoId, undefined, 100) });
    });

  return command;
}
