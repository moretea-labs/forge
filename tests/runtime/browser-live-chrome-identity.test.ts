import { describe, expect, test } from 'bun:test';
import { assertUniqueGuiChromeProcess, chromeMainInstances } from '../live/chrome-process-identity';

const gui = '97438 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const headless = '28434 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome --headless=new --user-data-dir=/tmp/test-profile';
const helper = '3939 /Applications/Google Chrome.app/Contents/Frameworks/Google Chrome Framework.framework/Helpers/Google Chrome Helper.app/Contents/MacOS/Google Chrome Helper (Renderer) --type=renderer';

describe('live Chrome Apple Events process-target guard', () => {
  test('one signed-in GUI root is an eligible unique scripting target', () => {
    expect(chromeMainInstances(gui + '\n' + helper)).toEqual([{ pid: 97438, headless: false }]);
    expect(assertUniqueGuiChromeProcess(gui + '\n' + helper)).toEqual({ pid: 97438 });
  });
  test('multiple distinct roots refuse script dispatch even when a GUI Chrome exists', () => {
    expect(() => assertUniqueGuiChromeProcess(gui + '\n' + headless)).toThrow('CHROME_APPLE_EVENTS_TARGET_AMBIGUOUS');
  });
  test('headless-only, no Chrome, or two GUI roots cannot impersonate the user tab', () => {
    for (const sample of [headless, helper, gui + '\n' + gui.replace('97438', '12345')]) {
      expect(() => assertUniqueGuiChromeProcess(sample)).toThrow('CHROME_APPLE_EVENTS_TARGET_AMBIGUOUS');
    }
  });
});
