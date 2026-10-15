/** Read-only, pre-Automation guard for Chrome's AppleScript application-name
 * resolution. A second Chrome root (e.g. headless CDP with its own profile)
 * shares com.google.Chrome and can consume Apple Events intended for the GUI.
 * Never guess which root will answer or force-terminate another owner's Chrome.
 */
export function chromeMainInstances(psOutput: string): Array<{ pid: number; headless: boolean }> {
  const instances: Array<{ pid: number; headless: boolean }> = [];
  for (const line of psOutput.split('\n')) {
    const match = /^\s*(\d+)\s+.+?\/Google Chrome\.app\/Contents\/MacOS\/Google Chrome(?=\s|$)/.exec(line);
    if (!match) continue;
    // Match the executable itself; helpers and renderers belong to their main
    // process and must not be counted as independent app/profile roots.
    instances.push({ pid: Number(match[1]), headless: /(?:^|\s)--headless(?:[=\s]|$)/.test(line) });
  }
  return instances;
}

export function assertUniqueGuiChromeProcess(psOutput: string): { pid: number } {
  const instances = chromeMainInstances(psOutput);
  if (instances.length !== 1 || instances[0]?.headless) {
    throw new Error(
      'CHROME_APPLE_EVENTS_TARGET_AMBIGUOUS: exact signed-in GUI Chrome process cannot be proven. ' +
      'Chrome roots=' + instances.length + ', headless roots=' + instances.filter((instance) => instance.headless).length +
      '. Refusing to script a possibly different Chrome profile; do not change Chrome privacy settings or terminate another owner\'s instance.',
    );
  }
  return { pid: instances[0].pid };
}
