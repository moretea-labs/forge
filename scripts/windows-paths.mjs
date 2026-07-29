const RESERVED_BASENAMES = new Set([
  "CON", "PRN", "AUX", "NUL",
  ...Array.from({ length: 9 }, (_, index) => `COM${index + 1}`),
  ...Array.from({ length: 9 }, (_, index) => `LPT${index + 1}`),
]);

export function windowsPathProblems(path) {
  const problems = [];
  for (const segment of String(path).split("/")) {
    if (!segment) continue;
    if (/[\u0001-\u001f<>:"\\|?*]/u.test(segment)) {
      problems.push(`invalid character in ${JSON.stringify(segment)}`);
    }
    if (/[. ]$/u.test(segment)) {
      problems.push(`trailing dot or space in ${JSON.stringify(segment)}`);
    }
    const base = segment.split(".", 1)[0].trim().toUpperCase();
    if (RESERVED_BASENAMES.has(base)) {
      problems.push(`reserved Windows device name in ${JSON.stringify(segment)}`);
    }
  }
  return problems;
}

export function findWindowsIncompatiblePaths(paths) {
  return Array.from(paths, (path) => ({ path, problems: windowsPathProblems(path) }))
    .filter((entry) => entry.problems.length > 0);
}
