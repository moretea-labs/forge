export interface WindowsIncompatiblePath {
  path: string;
  problems: string[];
}

export function windowsPathProblems(path: string): string[];
export function findWindowsIncompatiblePaths(paths: Iterable<string>): WindowsIncompatiblePath[];
