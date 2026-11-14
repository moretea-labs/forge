import { expect, test } from 'bun:test';
import { execFileSync, spawn } from 'child_process';

const script = 'scripts/mac-tunnel-follow-system-proxy.py';

test('macOS Tunnel launcher follows system HTTP proxy changes without retaining inherited fixed port', () => {
  const run = (snapshot: string) => {
    const code = [
      'import importlib.util, json, sys',
      "spec = importlib.util.spec_from_file_location('tunnel', sys.argv[1])",
      'm = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)',
      "env = m.proxy_environment(sys.argv[2], {'HTTP_PROXY':'http://127.0.0.1:7890','HTTPS_PROXY':'http://127.0.0.1:7890','ALL_PROXY':'socks5://127.0.0.1:7890'})",
      "print(json.dumps({k:env.get(k) for k in ('HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','NO_PROXY')}))",
    ].join('; ');
    return JSON.parse(execFileSync('/usr/bin/python3', ['-c', code, script, snapshot], { encoding: 'utf8' }));
  };
  expect(run('HTTPEnable : 1\nHTTPProxy : 127.0.0.1\nHTTPPort : 6034\nHTTPSEnable : 1\nHTTPSProxy : 127.0.0.1\nHTTPSPort : 6034\n')).toMatchObject({
    HTTP_PROXY: 'http://127.0.0.1:6034', HTTPS_PROXY: 'http://127.0.0.1:6034', ALL_PROXY: null,
  });
  expect(run('HTTPEnable : 0\nHTTPSEnable : 0\nSOCKSEnable : 0\n')).toMatchObject({
    HTTP_PROXY: null, HTTPS_PROXY: null, ALL_PROXY: null,
  });
  expect(run('SOCKSEnable : 1\nSOCKSProxy : localhost\nSOCKSPort : 6501\n')).toMatchObject({
    HTTP_PROXY: 'socks5://localhost:6501', HTTPS_PROXY: 'socks5://localhost:6501',
  });
});

test('macOS Tunnel launcher delegates exit and keeps launchd as sole owner', async () => {
  const result = await new Promise<{ code: number | null; stdout: string }>((resolve, reject) => {
    const child = spawn('/usr/bin/python3', [script, '/usr/bin/python3', '-c', "print('child-exit')"], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    child.stdout.on('data', (data) => { stdout += data.toString(); });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout }));
  });
  expect(result.code).toBe(0);
  expect(result.stdout).toContain('child-exit');
});

test('macOS Tunnel launcher replaces only its child when the system proxy changes', () => {
  const python = [
    'import importlib.util, subprocess, sys, unittest.mock',
    "spec=importlib.util.spec_from_file_location('follow',sys.argv[1])",
    'm=importlib.util.module_from_spec(spec); spec.loader.exec_module(m)',
    'class FakeChild:',
    ' def __init__(self, first): self.first=first; self.stopped=False; self.done=False',
    ' def poll(self): return 0 if self.done else (-15 if self.stopped else None)',
    ' def terminate(self): self.stopped=True',
    ' def kill(self): self.stopped=True',
    ' def wait(self, timeout=None):',
    "  if self.first and not self.stopped: raise subprocess.TimeoutExpired('fake',timeout)",
    '  self.done=True',
    '  return 0 if not self.stopped else -15',
    'first=FakeChild(True); second=FakeChild(False)',
    "initial={'HTTP_PROXY':'http://127.0.0.1:7890','HTTPS_PROXY':'http://127.0.0.1:7890','NO_PROXY':'localhost'}",
    "changed={'HTTP_PROXY':'http://127.0.0.1:6034','HTTPS_PROXY':'http://127.0.0.1:6034','NO_PROXY':'localhost'}",
    "with unittest.mock.patch.object(m,'current_environment',side_effect=[initial,changed]):",
    " with unittest.mock.patch.object(m.subprocess,'Popen',side_effect=[first,second]) as spawned:",
    "  result=m.run(['fake-tunnel-client'],interval=1)",
    "  assert result==0 and first.stopped and second.done and spawned.call_count==2",
    "  assert spawned.call_args_list[0].kwargs['env']['HTTPS_PROXY'].endswith(':7890')",
    "  assert spawned.call_args_list[1].kwargs['env']['HTTPS_PROXY'].endswith(':6034')",
  ].join('\n');
  expect(execFileSync('/usr/bin/python3', ['-c', python, script], { encoding: 'utf8' })).toBe('');
});
