#!/usr/bin/env bun
import { mkdirSync, writeFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { resolveRepoPreferredControllerHome } from '../src/cli/repositories/controller-home';
import { listRepositories } from '../src/cli/repositories/registry';
import { migrateChatgptAutomationSchedule } from '../src/runtime/workflow/schedules/chatgpt-automation-migration';
import { listSchedules, saveSchedule } from '../packages/kernel/scheduler/api/index';
import type { RepositorySchedule } from '../packages/kernel/scheduler/api/index';

interface Args { controllerHome?: string; apply: boolean; json: boolean; }

function parseArgs(argv: string[]): Args {
  const args: Args = { apply: false, json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--apply') args.apply = true;
    else if (value === '--json') args.json = true;
    else if (value === '--controller-home') args.controllerHome = resolve(argv[++index] ?? '');
    else throw new Error(`unknown argument: ${value}`);
  }
  return args;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const controllerHome = resolveRepoPreferredControllerHome(process.cwd(), args.controllerHome);
  const repositories = listRepositories(controllerHome, { includeRemoved: true });
  const candidates: Array<{ repositoryName: string; original: RepositorySchedule; migrated: RepositorySchedule }> = [];
  for (const repository of repositories) {
    for (const schedule of listSchedules(controllerHome, repository.repoId)) {
      const result = migrateChatgptAutomationSchedule(schedule);
      if (result.changed) candidates.push({ repositoryName: repository.displayName, original: schedule, migrated: result.schedule });
    }
  }

  let backupPath: string | undefined;
  if (args.apply && candidates.length > 0) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    backupPath = join(controllerHome, 'backups', `chatgpt-automation-schedules-${stamp}.json`);
    mkdirSync(dirname(backupPath), { recursive: true });
    writeFileSync(backupPath, `${JSON.stringify({ schemaVersion: 1, createdAt: new Date().toISOString(), schedules: candidates.map((item) => item.original) }, null, 2)}\n`);
    for (const candidate of candidates) saveSchedule(controllerHome, candidate.migrated);
  }

  const output = {
    schemaVersion: 1,
    controllerHome,
    repositoryCount: repositories.length,
    migratedCount: candidates.length,
    writesApplied: args.apply,
    backupPath,
    schedules: candidates.map((item) => ({ repoId: item.original.repoId, repositoryName: item.repositoryName, scheduleId: item.original.scheduleId, name: item.original.name })),
  };
  if (args.json) console.log(JSON.stringify(output, null, 2));
  else {
    console.log(`[chatgpt-automation-migration] ${candidates.length} schedule(s) eligible across ${repositories.length} repository record(s).`);
    console.log(args.apply ? `[chatgpt-automation-migration] Applied. Backup: ${backupPath ?? 'not needed'}` : '[chatgpt-automation-migration] Preview only; pass --apply after the new Runtime baseline is active.');
  }
}

try { main(); } catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
