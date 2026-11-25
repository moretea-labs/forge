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

test('optional native browser absence does not poison exact-target inventory completeness', () => {
  const target = read('src/runtime/plugins/browser-chatgpt-target.ts');
  expect(target).toContain("error.code === 'PLUGIN_BROWSER_NATIVE_APP_NOT_RUNNING'");
  expect(target).toContain("error.code === 'PLUGIN_BROWSER_NATIVE_APP_NOT_INSTALLED'");
});

test('fresh root bootstrap isolates only inherited foreign Supervisor drafts', () => {
  const target = read('src/runtime/plugins/browser-chatgpt-target.ts');
  expect(target).toContain('FRESH_ROOT_INHERITED_DRAFT_WINDOW_MS = 180_000');
  expect(target).toContain('SUPERVISOR_BOOTSTRAP_KEY');
  expect(target).toContain("status: 'unrecognized_draft'");
  expect(target).toContain("status: 'same_lane_draft'");
  expect(target).toContain("status: 'has_transcript'");
  expect(target).toContain("status: 'generating'");
  expect(target).toContain("'foreign_supervisor_draft_cleared'");
  expect(target).toContain("expectedUrl.pathname === '/' || expectedUrl.pathname === ''");
});
