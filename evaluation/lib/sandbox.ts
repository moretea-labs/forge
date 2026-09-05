import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { captureCommand, commandSucceeded } from './trace.ts';
import type { CommandRecord, SourceState } from './types.ts';

export interface IsolatedSnapshot {
  root: string;
  repository: string;
  source: string;
  sourceStateBefore: SourceState;
  setupCommands: CommandRecord[];
  home: string;
  controllerHome: string;
  stateHome: string;
  cacheHome: string;
  configHome: string;
  runtimeRoot: string;
  logRoot: string;
  traceRoot: string;
  tempRoot: string;
  artifactRoot: string;
}

export interface EvaluationIsolationIdentity {
  root: string;
  repository: string;
  home: string;
  controllerHome: string;
  stateHome: string;
  cacheHome: string;
  configHome: string;
  runtimeRoot: string;
  logRoot: string;
  traceRoot: string;
  tempRoot: string;
  artifactRoot: string;
}

function createIsolationDirectories(root: string): Omit<EvaluationIsolationIdentity, 'root' | 'repository'> {
  const paths = {
    home: join(root, 'home'),
    controllerHome: join(root, 'controller-home'),
    stateHome: join(root, 'state'),
    cacheHome: join(root, 'cache'),
    configHome: join(root, 'config'),
    runtimeRoot: join(root, 'runtime'),
    logRoot: join(root, 'logs'),
    traceRoot: join(root, 'traces'),
    tempRoot: join(root, 'tmp'),
    artifactRoot: join(root, 'artifacts'),
  };
  for (const path of Object.values(paths)) mkdirSync(path, { recursive: true });
  return paths;
}

export function evaluationIsolationIdentity(snapshot: IsolatedSnapshot): EvaluationIsolationIdentity {
  return {
    root: snapshot.root,
    repository: snapshot.repository,
    home: snapshot.home,
    controllerHome: snapshot.controllerHome,
    stateHome: snapshot.stateHome,
    cacheHome: snapshot.cacheHome,
    configHome: snapshot.configHome,
    runtimeRoot: snapshot.runtimeRoot,
    logRoot: snapshot.logRoot,
    traceRoot: snapshot.traceRoot,
    tempRoot: snapshot.tempRoot,
    artifactRoot: snapshot.artifactRoot,
  };
}

export function isolatedEvaluationEnvironment(snapshot: IsolatedSnapshot, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return {
    ...base,
    HOME: snapshot.home,
    FORGE_CONTROLLER_HOME: snapshot.controllerHome,
    XDG_STATE_HOME: snapshot.stateHome,
    XDG_CACHE_HOME: snapshot.cacheHome,
    XDG_CONFIG_HOME: snapshot.configHome,
    TMPDIR: snapshot.tempRoot,
    TMP: snapshot.tempRoot,
    TEMP: snapshot.tempRoot,
    FORGE_EVALUATION: '1',
    FORGE_EVALUATION_SANDBOX: snapshot.repository,
    FORGE_EVALUATION_RUNTIME_ROOT: snapshot.runtimeRoot,
    FORGE_EVALUATION_LOG_ROOT: snapshot.logRoot,
    FORGE_EVALUATION_TRACE_ROOT: snapshot.traceRoot,
    FORGE_EVALUATION_ARTIFACT_ROOT: snapshot.artifactRoot,
  };
}

function gitRecord(cwd: string, arguments_: string[]): CommandRecord {
  return captureCommand({ kind: 'sandbox_setup', command: 'git', arguments: arguments_, cwd, timeoutMs: 60_000 });
}

function requireSuccessful(record: CommandRecord, action: string): void {
  if (!commandSucceeded(record)) throw new Error(`${action} failed: ${record.stderr || record.stdout || 'unknown error'}`);
}

export function inspectSourceState(source: string): { state: SourceState; command: CommandRecord } {
  const record = captureCommand({
    kind: 'evidence',
    command: 'git',
    arguments: ['status', '--porcelain=v1', '--untracked-files=all'],
    cwd: source,
    timeoutMs: 30_000,
  });
  requireSuccessful(record, `Could not inspect source repository ${source}`);
  return {
    state: {
      clean: record.stdout.trim().length === 0,
      statusDigest: createHash('sha256').update(record.stdout).digest('hex'),
    },
    command: record,
  };
}

export function resolveSourcePath(repositoryRoot: string, source: string): string {
  return isAbsolute(source) ? resolve(source) : resolve(repositoryRoot, source);
}

export function assertOutsideSource(source: string, candidate: string): void {
  const normalizedSource = realpathSync(source);
  const normalizedCandidate = resolveExistingParent(candidate);
  const path = relative(normalizedSource, normalizedCandidate);
  if (path === '' || (!path.startsWith('..') && !isAbsolute(path))) {
    throw new Error(`Evaluation output must be outside the source repository: ${normalizedCandidate}`);
  }
}

function resolveExistingParent(path: string): string {
  let cursor = resolve(path);
  const missing: string[] = [];
  while (!existsSync(cursor)) {
    missing.unshift(basename(cursor));
    const parent = dirname(cursor);
    if (parent === cursor) throw new Error(`Unable to resolve evaluation output path: ${path}`);
    cursor = parent;
  }
  return resolve(realpathSync(cursor), ...missing);
}

export function createIsolatedSnapshot(source: string, commit: string): IsolatedSnapshot {
  if (!existsSync(source)) throw new Error(`Snapshot source does not exist: ${source}`);
  const before = inspectSourceState(source);
  const sourceStateBefore = before.state;
  const commands: CommandRecord[] = [before.command];
  const verify = gitRecord(source, ['rev-parse', '--verify', `${commit}^{commit}`]);
  commands.push(verify);
  requireSuccessful(verify, `Snapshot commit ${commit} is unavailable from ${source}`);

  const root = mkdtempSync(join(tmpdir(), 'forge-evaluation-'));
  const repository = join(root, 'repository');
  const isolation = createIsolationDirectories(root);
  try {
    const clone = gitRecord(root, ['clone', '--no-local', '--no-checkout', source, repository]);
    commands.push(clone);
    requireSuccessful(clone, 'Isolated snapshot clone');
    const checkout = gitRecord(repository, ['checkout', '--detach', commit]);
    commands.push(checkout);
    requireSuccessful(checkout, `Snapshot checkout ${commit}`);
    const removeOrigin = gitRecord(repository, ['remote', 'remove', 'origin']);
    commands.push(removeOrigin);
    requireSuccessful(removeOrigin, 'Sandbox remote removal');
    return { root, repository, source, sourceStateBefore, setupCommands: commands, ...isolation };
  } catch (error) {
    cleanupIsolatedSnapshot(root);
    throw error;
  }
}

export function changedFiles(repository: string): { files: string[]; commands: CommandRecord[] } {
  const diff = captureCommand({
    kind: 'evidence',
    command: 'git',
    arguments: ['diff', '--name-only', '--diff-filter=ACMRTUXB'],
    cwd: repository,
    timeoutMs: 30_000,
  });
  const untracked = captureCommand({
    kind: 'evidence',
    command: 'git',
    arguments: ['ls-files', '--others', '--exclude-standard'],
    cwd: repository,
    timeoutMs: 30_000,
  });
  requireSuccessful(diff, 'Changed-file collection');
  requireSuccessful(untracked, 'Untracked-file collection');
  return {
    files: [...new Set([...diff.stdout.split('\n'), ...untracked.stdout.split('\n')].map((file) => file.trim()).filter(Boolean))].sort(),
    commands: [diff, untracked],
  };
}

export function cleanupIsolatedSnapshot(root: string): void {
  const tempRoot = resolve(tmpdir());
  const target = resolve(root);
  const withinTemp = relative(tempRoot, target);
  if (withinTemp === '' || withinTemp.startsWith('..') || isAbsolute(withinTemp) || !basename(target).startsWith('forge-evaluation-')) {
    throw new Error(`Refusing to remove a non-evaluation sandbox: ${target}`);
  }
  rmSync(target, { recursive: true, force: true });
}
