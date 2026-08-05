import { readFileSync } from 'fs';
import { resolve } from 'path';
import { Command } from 'commander';
import { ensureControllerHome } from '../repositories/controller-home';
import {
  controllerServiceStatus,
  formatControllerServiceStatus,
  stopControllerService,
} from '../controller/lifecycle';
import { requestControllerServiceRestart } from '../controller/restart-coordinator';
import { ensureControllerDaemon, readControllerDaemonStatus } from '../../runtime/control-plane/daemon-client';
import { findExecutionJob, listActiveExecutionJobs, listExecutionJobs } from '../../runtime/execution/jobs/store';
import { readJobEvents } from '../../runtime/evidence/event-ledger';
import { getRepository, listRepositories } from '../repositories/registry';
import { executeReadOnlyDiagnostic, isReadOnlyDiagnosticTool } from '../../runtime/diagnostics/read-only-tool';
import { rebuildRepositoryProjection } from '../../runtime/projections/materialized-view';
import { listOccurrences, listSchedules } from '../../runtime/workflow/schedules/store';
import { CanonicalRepoHarnessRuntime } from '../../runtime/root/runtime';

function output(value: unknown, json = true): void {
  console.log(json ? JSON.stringify(value, null, 2) : String(value));
}

export function buildRuntimeCommand(): Command {
  const command = new Command('runtime').description('Run the canonical Runtime or inspect legacy compatibility state');

  command.command('start')
    .description('Compatibility adapter: start the canonical repo-harness-runtime in this process')
    .requiredOption('--controller-home <path>', 'Explicit Controller Home')
    .requiredOption('--repo <path>', 'Explicit repository root')
    .requiredOption('--release-manifest <path>', 'Complete release manifest')
    .requiredOption('--host <host>', 'MCP listener host')
    .requiredOption('--port <port>', 'MCP listener port')
    .requiredOption('--auth-token-file <path>', 'Bearer token file')
    .option('--exclusive-work-id <id>', 'Persistently admit only this P0 Work')
    .action(async (opts: { controllerHome: string; repo: string; releaseManifest: string; host: string; port: string; authTokenFile: string; exclusiveWorkId?: string }) => {
      const port = Number(opts.port);
      if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error('RUNTIME_CONFIG_INVALID: port');
      const authToken = readFileSync(resolve(opts.authTokenFile), 'utf8').trim();
      if (!authToken) throw new Error('RUNTIME_CONFIG_REQUIRED: auth token file is empty');
      const runtime = new CanonicalRepoHarnessRuntime({
        controllerHome: resolve(opts.controllerHome),
        repositoryRoot: resolve(opts.repo),
        releaseManifestPath: resolve(opts.releaseManifest),
        host: opts.host,
        port,
        authToken,
        exclusiveWorkId: opts.exclusiveWorkId,
      });
      await runtime.start();
      output({ runtimeInstanceId: runtime.runtimeInstanceId, endpoint: runtime.endpoint(), readiness: runtime.readiness() });
      const stop = (signal: NodeJS.Signals): void => { void runtime.stop(`SIGNAL_${signal}`); };
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);
      await runtime.waitForStopped();
      process.off('SIGINT', stop);
      process.off('SIGTERM', stop);
    });

  command.command('status')
    .description('Show unified runtime readiness, active durable Jobs, and per-repository materialized projections')
    .option('--controller-home <path>', 'Controller state root')
    .option('--repo <path>', 'Repository root')
    .option('--log-file <path>', 'Combined runtime log file')
    .option('--json', 'Output JSON')
    .action(async (opts: { controllerHome?: string; repo?: string; logFile?: string; json?: boolean }) => {
      const service = await controllerServiceStatus(opts);
      const home = ensureControllerHome(service.controllerHome);
      const repositories = listRepositories(home, { includeRemoved: true });
      if (opts.json) {
        output({
          service,
          daemon: readControllerDaemonStatus(home),
          activeJobs: listActiveExecutionJobs(home),
          repositories: repositories.map((repository) => rebuildRepositoryProjection(home, repository.repoId)),
        });
        return;
      }
      console.log(formatControllerServiceStatus(service));
    });

  command.command('stop')
    .description('Stop the unified runtime supervisor')
    .option('--controller-home <path>', 'Controller state root')
    .option('--repo <path>', 'Repository root')
    .option('--log-file <path>', 'Combined runtime log file')
    .action(async (opts: { controllerHome?: string; repo?: string; logFile?: string }) => output(await stopControllerService(opts)));

  command.command('restart')
    .description('Restart the unified runtime supervisor')
    .option('--controller-home <path>', 'Controller state root')
    .option('--repo <path>', 'Repository root')
    .option('--log-file <path>', 'Combined runtime log file')
    .option('--request-id <id>', 'Idempotent restart request id')
    .option('--reason <text>', 'Bounded restart reason')
    .option('--detached', 'Always hand the restart to the out-of-band coordinator')
    .action(async (opts: { controllerHome?: string; repo?: string; logFile?: string; requestId?: string; reason?: string; detached?: boolean }) => output(await requestControllerServiceRestart({
      ...opts,
      requestedBy: 'runtime-cli',
      mode: opts.detached ? 'detached' : 'auto',
    })));

  command.command('doctor')
    .description('Run a bounded runtime diagnosis view')
    .option('--controller-home <path>', 'Controller state root')
    .option('--repo <path>', 'Repository root')
    .option('--log-file <path>', 'Combined runtime log file')
    .option('--json', 'Output JSON')
    .action(async (opts: { controllerHome?: string; repo?: string; logFile?: string; json?: boolean }) => {
      const service = await controllerServiceStatus(opts);
      if (opts.json) {
        output({ status: service }, true);
        return;
      }
      output(formatControllerServiceStatus(service), false);
    });

  command.command('job')
    .description('Inspect one durable Execution Job and its event ledger')
    .argument('<job-id>', 'Execution Job ID')
    .option('--controller-home <path>', 'Controller state root')
    .action((jobId: string, opts: { controllerHome?: string }) => {
      const home = ensureControllerHome(opts.controllerHome);
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
      const home = ensureControllerHome(opts.controllerHome);
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
      const home = ensureControllerHome(opts.controllerHome);
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
      const home = ensureControllerHome(opts.controllerHome);
      output({ schedules: listSchedules(home, opts.repoId), occurrences: listOccurrences(home, opts.repoId, undefined, 100) });
    });

  return command;
}
