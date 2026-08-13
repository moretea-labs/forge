import { Command } from 'commander';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { resolveControllerHome, resolveRepoPreferredControllerHome } from '../repositories/controller-home';
import { findExecutionJob, listActiveExecutionJobs, listExecutionJobs } from '../../runtime/execution/jobs/store';
import { readJobEvents } from '../../runtime/evidence/event-ledger';
import { getRepository, listRepositories } from '../repositories/registry';
import { executeReadOnlyDiagnostic, isReadOnlyDiagnosticTool } from '../../runtime/diagnostics/read-only-tool';
import { readRepositoryProjection } from '../../runtime/projections/materialized-view';
import { listOccurrences, listSchedules } from '../../runtime/workflow/schedules/store';
import { observeRuntimeStatus } from '../../runtime/root/status';
import { readMcpServiceBearerToken } from '../mcp/auth';
import { publishRuntimeRelease } from '../../runtime/root/release-store';
import { installForgeRuntimeService } from '../../runtime/root/service';
import { installPackageRuntimeService } from '../../runtime/root/package-runtime-service';
import { assertRuntimeReleaseFiles, stageRuntimeReleaseFromCandidateSource } from '../../runtime/root/release-materialize';

function output(value: unknown, json = true): void {
  console.log(json ? JSON.stringify(value, null, 2) : String(value));
}

export function resolveRuntimeStateControllerHome(explicit?: string, cwd = process.cwd()): string {
  return resolveRepoPreferredControllerHome(cwd, explicit);
}

export function buildRuntimeCommand(): Command {
  const command = new Command('runtime').description('Inspect the canonical Runtime and durable execution state');

  const service = command.command('service')
    .description('Install or inspect the user-level Forge Runtime owner');

  service.command('install-package')
    .description('Install the current packaged Forge Runtime without requiring a Git checkout, Bun compilation, CodeGraph, or Standalone Recovery')
    .option('--controller-home <path>', 'Controller Home; defaults to the user-level Forge Controller Home')
    .option('--host <host>', 'MCP listener host', '127.0.0.1')
    .option('--port <port>', 'MCP listener port', '8765')
    .option('--auth-token-file <path>', 'Raw bearer token file (created from user-level MCP config when missing)')
    .option('--portable', 'Force a detached session process instead of launchd/systemd user persistence')
    .action(async (opts: { controllerHome?: string; host: string; port: string; authTokenFile?: string; portable?: boolean }) => {
      const home = resolveControllerHome(opts.controllerHome);
      const port = Number(opts.port);
      if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error('RUNTIME_SERVICE_PORT_INVALID');
      const tokenPath = resolve(opts.authTokenFile ?? join(home, 'mcp', 'runtime-token'));
      if (!existsSync(tokenPath)) {
        const token = readMcpServiceBearerToken(home);
        if (!token) throw new Error('RUNTIME_SERVICE_AUTH_TOKEN_UNAVAILABLE: run forge mcp setup chatgpt --user-level first');
        mkdirSync(dirname(tokenPath), { recursive: true, mode: 0o700 });
        writeFileSync(tokenPath, `${token}\n`, { mode: 0o600 });
      }
      const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
      const result = await installPackageRuntimeService({
        controllerHome: home,
        packageRoot,
        host: opts.host,
        port,
        authTokenFile: tokenPath,
        forcePortable: opts.portable === true,
      });
      output({
        status: result.status,
        mode: result.mode,
        persistent: result.persistent,
        controllerHome: result.controllerHome,
        release: {
          releaseId: result.release.releaseId,
          packageVersion: result.release.packageVersion,
          packageFingerprint: result.release.packageFingerprint,
          artifactIdentity: result.release.artifactIdentity,
          manifestPath: result.release.manifestPath,
          fileCount: result.release.fileCount,
        },
        servicePath: result.servicePath,
        pid: result.pid,
        warnings: result.warnings,
        next: `forge runtime status --controller-home ${home}`,
      });
    });

  service.command('install')
    .description('Advanced/source mode: build an immutable Git Runtime release and install the macOS launchd owner')
    .requiredOption('--controller-home <path>', 'Explicit Controller Home')
    .requiredOption('--repo <path>', 'Repository root used as the immutable release source')
    .option('--host <host>', 'MCP listener host', '127.0.0.1')
    .option('--port <port>', 'MCP listener port', '8765')
    .option('--stage-only', 'Build and validate the immutable Runtime release without publishing or activating it')
    .option('--auth-token-file <path>', 'Raw bearer token file (defaults to controllerHome/mcp/runtime-token, created from the MCP bearer token when missing)')
    .option('--exclusive-work-id <id>', 'Persistently admit only this P0 Work while migration is active')
    .option('--node-executable <path>', 'Executable launchd uses to run the Forge Runtime service runner', process.execPath)
    .option('--runner-path <path>', 'Forge Runtime service runner entry', join(resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..'), 'bin', 'forge-runtime-service.mjs'))
    .action(async (opts: {
      controllerHome: string;
      repo: string;
      host: string;
      port: string;
      authTokenFile?: string;
      exclusiveWorkId?: string;
      nodeExecutable: string;
      runnerPath: string;
      stageOnly?: boolean;
    }) => {
      const home = resolveControllerHome(opts.controllerHome);
      const repoRoot = resolve(opts.repo);
      if (!existsSync(repoRoot)) throw new Error(`RUNTIME_SERVICE_REPOSITORY_MISSING: ${repoRoot}`);
      const port = Number(opts.port);
      if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error('RUNTIME_SERVICE_PORT_INVALID');

      const staged = stageRuntimeReleaseFromCandidateSource({ controllerHome: home, sourceRoot: repoRoot });
      assertRuntimeReleaseFiles(staged);
      if (opts.stageOnly === true) {
        output({
          status: 'staged',
          release: {
            releaseId: staged.releaseId,
            sourceCommit: staged.sourceCommit,
            artifactIdentity: staged.artifactIdentity,
            manifestPath: staged.manifestPath,
            manifestSha256: staged.manifestSha256,
          },
          next: `forge recovery activate-runtime --controller-home ${home} --release-manifest ${staged.manifestPath}`,
        });
        return;
      }

      const tokenPath = resolve(opts.authTokenFile ?? join(home, 'mcp', 'runtime-token'));
      if (!existsSync(tokenPath)) {
        const token = readMcpServiceBearerToken(home, repoRoot);
        if (!token) throw new Error('RUNTIME_SERVICE_AUTH_TOKEN_UNAVAILABLE: run forge mcp setup chatgpt first');
        writeFileSync(tokenPath, `${token}\n`, { mode: 0o600 });
      }

      const authority = publishRuntimeRelease(home, staged.manifestPath, `runtime-service-install-${Date.now()}`);
      const paths = await installForgeRuntimeService({
        config: {
          schemaVersion: 1,
          controllerHome: home,
          repositoryRoot: repoRoot,
          host: opts.host,
          port,
          authTokenFile: tokenPath,
          ...(opts.exclusiveWorkId?.trim() ? { exclusiveWorkId: opts.exclusiveWorkId.trim() } : {}),
        },
        runnerPath: resolve(opts.runnerPath),
        nodeExecutable: resolve(opts.nodeExecutable),
      });
      output({
        status: 'installed',
        release: {
          releaseId: staged.releaseId,
          sourceCommit: staged.sourceCommit,
          artifactIdentity: staged.artifactIdentity,
          manifestPath: staged.manifestPath,
          manifestSha256: staged.manifestSha256,
          authorityRevision: authority.revision,
        },
        service: {
          label: paths.label,
          plist: paths.installedPlistPath,
          config: paths.configPath,
        },
        next: `forge runtime status --controller-home ${home}`,
      });
    });

  command.command('status')
    .description('Read the Runtime Root status projection, active durable Jobs, and materialized repository projections')
    .requiredOption('--controller-home <path>', 'Explicit Controller Home')
    .option('--json', 'Output JSON')
    .action((opts: { controllerHome: string; json?: boolean }) => {
      const home = resolveRuntimeStateControllerHome(opts.controllerHome);
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
      const home = resolveRuntimeStateControllerHome(opts.controllerHome);
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
      const home = resolveRuntimeStateControllerHome(opts.controllerHome);
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
      const home = resolveRuntimeStateControllerHome(opts.controllerHome);
      output({ schedules: listSchedules(home, opts.repoId), occurrences: listOccurrences(home, opts.repoId, undefined, 100) });
    });

  return command;
}
