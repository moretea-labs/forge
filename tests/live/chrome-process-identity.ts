/** Read-only preflight for Desktop Operator's process-ID-addressed Chrome
 * ScriptingBridge transport. One GUI Chrome process may coexist with multiple
 * independent headless Chrome profiles; two GUI roots remain ambiguous.
 * Never select a GUI by URL/title or terminate another owner's Chrome.
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
  const guiRoots = instances.filter((instance) => !instance.headless);
  if (guiRoots.length !== 1) {
    throw new Error(
      'CHROME_APPLE_EVENTS_TARGET_AMBIGUOUS: exact signed-in GUI Chrome process cannot be proven. ' +
      'Chrome roots=' + instances.length + ', headless roots=' + instances.filter((instance) => instance.headless).length +
      '. Refusing to bind an unproven GUI Chrome process; do not change Chrome privacy settings or terminate another owner\'s instance.',
    );
  }
  return { pid: guiRoots[0].pid };
}
