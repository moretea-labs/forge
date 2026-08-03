#!/usr/bin/env bun
import { existsSync, mkdirSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { spawnSync } from 'child_process';
import { listIssues } from '../src/cli/controller/issue-store';
import {
  REQUIREMENT_PORTFOLIO_MIGRATION_ID,
  applyRequirementPortfolioMigration,
  previewRequirementPortfolioMigration,
} from '../src/cli/controller/requirement-portfolio-migration';
import { resolveRepoPreferredControllerHome } from '../src/cli/repositories/controller-home';
import { backupControlPlaneDatabase } from '../src/runtime/control-plane/persistence/sqlite-store';

interface Args {
  repoRoot: string;
  repoId?: string;
  controllerHome?: string;
  sourceRevision?: string;
  backupPath?: string;
  apply: boolean;
  json: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { repoRoot: process.cwd(), apply: false, json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--apply') args.apply = true;
    else if (value === '--json') args.json = true;
    else if (value === '--repo') args.repoRoot = resolve(argv[++index] ?? '');
    else if (value === '--repo-id') args.repoId = argv[++index];
    else if (value === '--controller-home') args.controllerHome = resolve(argv[++index] ?? '');
    else if (value === '--source-revision') args.sourceRevision = argv[++index];
    else if (value === '--backup-path') args.backupPath = resolve(argv[++index] ?? '');
    else throw new Error(`unknown argument: ${value}`);
  }
  return args;
}

function gitHead(repoRoot: string): string {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`unable to resolve Git HEAD: ${String(result.stderr).trim()}`);
  return String(result.stdout).trim();
}

function resolveRepoId(explicit: string | undefined, issues: ReturnType<typeof listIssues>): string {
  if (explicit?.trim()) return explicit.trim();
  const ids = [...new Set(issues.map((issue) => issue.repoId).filter((value): value is string => Boolean(value)))];
  if (ids.length !== 1) throw new Error(`--repo-id is required; discovered ${ids.length} repository identities`);
  return ids[0];
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const issues = listIssues(args.repoRoot, { includeEphemeral: false });
  const repoId = resolveRepoId(args.repoId, issues);
  const controllerHome = resolveRepoPreferredControllerHome(args.repoRoot, args.controllerHome);
  const sourceRevision = args.sourceRevision?.trim() || gitHead(args.repoRoot);
  const input = { controllerHome, repoId, sourceRevision, issues };
  let backupPath: string | undefined;
  let result;
  if (args.apply) {
    backupPath = args.backupPath ?? join(controllerHome, 'backups', `${REQUIREMENT_PORTFOLIO_MIGRATION_ID}-${sourceRevision.slice(0, 12)}.sqlite`);
    if (!existsSync(backupPath)) {
      mkdirSync(dirname(backupPath), { recursive: true });
      backupControlPlaneDatabase(controllerHome, backupPath);
    }
    result = applyRequirementPortfolioMigration(input);
  } else {
    result = previewRequirementPortfolioMigration(input);
  }
  const output = { ...result, controllerHome, repoRoot: args.repoRoot, backupPath, writesApplied: args.apply };
  if (args.json) console.log(JSON.stringify(output, null, 2));
  else {
    console.log(`[requirement-portfolio] ${result.status}: ${result.requirementCount} Requirements, ${result.planCount} Plans, ${result.sourceIssueCount} source Issues.`);
    if (!args.apply) console.log('[requirement-portfolio] Preview only; pass --apply to write SQLite authority.');
    if (backupPath) console.log(`[requirement-portfolio] Backup: ${backupPath}`);
  }
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
