import { spawnSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

export interface WindowsHostEnvironment {
  commandExecutable: string;
  userProfileWindows: string;
  userProfile: string;
  localAppDataWindows?: string;
  localAppData?: string;
  programFilesWindows: string[];
  programFiles: string[];
  programDataWindows?: string;
  programData?: string;
  systemRootWindows?: string;
  systemRoot?: string;
  driveMounts: Readonly<Record<string, string>>;
}

export interface WindowsHostDiscoveryOptions {
  fileExists?: typeof existsSync;
  readText?: (path: string) => string;
  commandCandidates?: readonly string[];
  runCommand?: (executable: string, args: readonly string[]) => { status: number | null; stdout: string };
  mountTable?: string;
}

function unescapeMount(value: string): string {
  return value.replace(/\\040/g, ' ').replace(/\\011/g, '\t').replace(/\\134/g, '\\');
}

export function discoverWslWindowsDriveMounts(mountTable: string): Record<string, string> {
  const mounts: Record<string, string> = {};
  for (const line of mountTable.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const fields = line.split(' ');
    const source = unescapeMount(fields[0] ?? '');
    const mountPoint = unescapeMount(fields[1] ?? '');
    const fsType = fields[2] ?? '';
    const sourceDrive = /^([A-Za-z]):(?:\\|$)/.exec(source)?.[1]?.toLowerCase();
    const optionDrive = /(?:^|,)aname=drvfs;path=([A-Za-z]):(?:\\|,|$)/.exec(fields.slice(3).join(' '))?.[1]?.toLowerCase();
    const drive = sourceDrive ?? optionDrive;
    if (drive && mountPoint.startsWith('/') && (fsType === '9p' || fsType === 'drvfs')) mounts[drive] = mountPoint;
  }
  return mounts;
}

export function windowsPathToHostPath(value: string, driveMounts: Readonly<Record<string, string>>): string | undefined {
  if (value.startsWith('/')) return value;
  const normalized = value.trim().replace(/^"|"$/g, '').replace(/\\/g, '/');
  const match = /^([A-Za-z]):\/(.*)$/.exec(normalized);
  if (!match) return undefined;
  const mount = driveMounts[match[1]!.toLowerCase()];
  return mount ? join(mount, match[2]!) : undefined;
}


export function hostPathToWindowsPath(value: string, driveMounts: Readonly<Record<string, string>>): string | undefined {
  const normalized = value.replace(/\\/g, '/');
  const entries = Object.entries(driveMounts).sort((left, right) => right[1].length - left[1].length);
  for (const [drive, mountRoot] of entries) {
    const root = mountRoot.endsWith('/') ? mountRoot.slice(0, -1) : mountRoot;
    if (normalized === root) return `${drive.toUpperCase()}:\\`;
    if (normalized.startsWith(`${root}/`)) return `${drive.toUpperCase()}:\\${normalized.slice(root.length + 1).replace(/\//g, '\\')}`;
  }
  return undefined;
}

function parseEnvironment(stdout: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of stdout.split(/\r?\n/)) {
    const match = /^FORGE_([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (match && match[2]!.trim() && !/%[^%]+%/.test(match[2]!)) result[match[1]!] = match[2]!.trim();
  }
  return result;
}

export function discoverWslWindowsHostEnvironment(options: WindowsHostDiscoveryOptions = {}): WindowsHostEnvironment | undefined {
  const fileExists = options.fileExists ?? existsSync;
  const readText = options.readText ?? ((path: string) => readFileSync(path, 'utf8'));
  let mountTable = options.mountTable;
  if (mountTable === undefined) {
    try { mountTable = readText('/proc/mounts'); } catch { mountTable = ''; }
  }
  const driveMounts = discoverWslWindowsDriveMounts(mountTable);
  const discoveredCmd = Object.entries(driveMounts)
    .map(([, root]) => join(root, 'Windows', 'System32', 'cmd.exe'))
    .find(fileExists);
  const commandExecutable = options.commandCandidates?.find(fileExists) ?? discoveredCmd;
  if (!commandExecutable) return undefined;
  const runCommand = options.runCommand ?? ((executable: string, args: readonly string[]) => {
    const result = spawnSync(executable, [...args], { encoding: 'utf8', windowsHide: true, timeout: 5_000 });
    return { status: result.status, stdout: result.stdout ?? '' };
  });
  const observed = runCommand(commandExecutable, ['/d', '/s', '/c', 'echo FORGE_USERPROFILE=%USERPROFILE%&&echo FORGE_LOCALAPPDATA=%LOCALAPPDATA%&&echo FORGE_PROGRAMFILES=%ProgramFiles%&&echo FORGE_PROGRAMFILES_X86=%ProgramFiles(x86)%&&echo FORGE_PROGRAMDATA=%ProgramData%&&echo FORGE_SYSTEMROOT=%SystemRoot%']);
  if (observed.status !== 0) return undefined;
  const env = parseEnvironment(observed.stdout);
  const userProfileWindows = env.USERPROFILE;
  if (!userProfileWindows) return undefined;
  const userProfile = windowsPathToHostPath(userProfileWindows, driveMounts);
  if (!userProfile) return undefined;
  const localAppDataWindows = env.LOCALAPPDATA;
  const localAppData = localAppDataWindows ? windowsPathToHostPath(localAppDataWindows, driveMounts) : undefined;
  const programFilesWindows = [env.PROGRAMFILES, env.PROGRAMFILES_X86].filter((value): value is string => Boolean(value));
  const programFiles = programFilesWindows.map((value) => windowsPathToHostPath(value, driveMounts)).filter((value): value is string => Boolean(value));
  const programDataWindows = env.PROGRAMDATA;
  const programData = programDataWindows ? windowsPathToHostPath(programDataWindows, driveMounts) : undefined;
  const systemRootWindows = env.SYSTEMROOT;
  const systemRoot = systemRootWindows ? windowsPathToHostPath(systemRootWindows, driveMounts) : undefined;
  return {
    commandExecutable, userProfileWindows, userProfile,
    ...(localAppDataWindows ? { localAppDataWindows } : {}), ...(localAppData ? { localAppData } : {}),
    programFilesWindows, programFiles,
    ...(programDataWindows ? { programDataWindows } : {}), ...(programData ? { programData } : {}),
    ...(systemRootWindows ? { systemRootWindows } : {}), ...(systemRoot ? { systemRoot } : {}),
    driveMounts,
  };
}
