import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const read = (path: string) => readFileSync(join(root, path), 'utf8');

test('production ChatGPT exact-target path is native Browser attach, not an extension runtime', () => {
  const registration = read('src/runtime/plugins/computer-registration.ts');
  const runtime = read('src/runtime/root/runtime.ts');
  const target = read('src/runtime/root/computer-chatgpt-target.ts');

  expect(registration).toContain("from '../root/computer-chatgpt-target'");
  expect(registration).not.toContain("from '../root/computer-chatgpt-extension'");
  expect(runtime).toContain("from './computer-chatgpt-target'");
  expect(runtime).not.toContain("from './computer-chatgpt-extension'");
  expect(target).toContain('MacOsChatgptConversationTargetPort');
  expect(target).toContain('../plugins/browser-chatgpt-target');
  expect(target).not.toContain('ChromeExtensionChatgptConversationTargetPort');
  expect(target).not.toContain('projectComputerChatgptExtension');
});
