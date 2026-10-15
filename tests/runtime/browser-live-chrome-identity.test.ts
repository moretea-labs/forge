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
  test('one GUI Chrome remains exact even when independent headless CDP roots coexist', () => {
    expect(assertUniqueGuiChromeProcess(gui + '\n' + headless)).toEqual({ pid: 97438 });
    expect(assertUniqueGuiChromeProcess(gui + '\n' + headless + '\n' + headless.replace('28434', '55220'))).toEqual({ pid: 97438 });
  });
  test('headless-only, no Chrome, or two GUI roots cannot impersonate the user tab', () => {
    for (const sample of [headless, helper, gui + '\n' + gui.replace('97438', '12345'), gui + '\n' + headless + '\n' + gui.replace('97438', '12345')]) {
      expect(() => assertUniqueGuiChromeProcess(sample)).toThrow('CHROME_APPLE_EVENTS_TARGET_AMBIGUOUS');
    }
  });
});
