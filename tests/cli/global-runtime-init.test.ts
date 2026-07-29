import { describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { delimiter, join } from 'path';
import { spawnSync } from 'child_process';
import { runGlobalRuntimeSetup } from '../../src/cli/commands/global-runtime';

const ROOT = join(import.meta.dir, '..', '..');
const CLI = join(ROOT, 'src/cli/index.ts');

function writeExecutable(filePath: string, content: string): void {
  writeFileSync(filePath, content);
  chmodSync(filePath, 0o755);
}

function prependPath(fakeBin: string): string {
  return [fakeBin, process.env.PATH ?? ''].filter(Boolean).join(delimiter);
}

function writeNodeCommand(fakeBin: string, name: string, source: string): void {
  const scriptPath = join(fakeBin, `${name}.mjs`);
  writeFileSync(scriptPath, source);
  if (process.platform === 'win32') {
    writeFileSync(join(fakeBin, `${name}.cmd`), `@echo off\r\n"${process.execPath}" "${scriptPath}" %*\r\n`);
    return;
  }
  writeExecutable(join(fakeBin, name), `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(scriptPath)} "$@"\n`);
}

function setupFakeSource(root: string): void {
  mkdirSync(join(root, 'scripts'), { recursive: true });
  mkdirSync(join(root, 'assets', 'skills', 'codex-review'), { recursive: true });
  mkdirSync(join(root, 'assets', 'skills', 'claude-review'), { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'repo-harness', version: '9.9.9' }, null, 2));
  writeFileSync(join(root, 'assets', 'skills', 'codex-review', 'SKILL.md'), 'codex-review\n');
  writeFileSync(join(root, 'assets', 'skills', 'claude-review', 'SKILL.md'), 'claude-review\n');
  writeExecutable(
    join(root, 'scripts', 'sync-codex-installed-copies.sh'),
    '#!/bin/bash\nset -euo pipefail\necho "sync runtime link=${AGENTIC_DEV_LINK_INSTALLED_COPIES:-unset}"\n',
  );
}

function writeFakeCodegraph(fakeBin: string, logFile: string): void {
  writeNodeCommand(
    fakeBin,
    'codegraph',
    [
      "import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';",
      "import { join } from 'node:path';",
      `const logFile = ${JSON.stringify(logFile)};`,
      "const args = process.argv.slice(2);",
      "appendFileSync(logFile, `codegraph ${args.join(' ')}\\n`);",
      "if (args[0] === '--version') { console.log('0.9.6'); process.exit(0); }",
      "if (args[0] === 'status') { console.log('CodeGraph Status'); console.log('Index is up to date'); process.exit(0); }",
      "if (args[0] === 'install') {",
      "  const targetIndex = args.indexOf('--target');",
      "  if (targetIndex >= 0 && args[targetIndex + 1] === 'codex') {",
      "    const home = process.env.HOME ?? process.env.USERPROFILE ?? '';",
      "    const codexDir = join(home, '.codex');",
      "    mkdirSync(codexDir, { recursive: true });",
      "    writeFileSync(join(codexDir, 'config.toml'), '[mcp_servers.codegraph]\\ncommand = \\\"codegraph\\\"\\nargs = [\\\"serve\\\", \\\"--mcp\\\"]\\n');",
      "  }",
      "  console.log('installed');",
      "  process.exit(0);",
      "}",
      "process.exit(1);",
      "",
    ].join('\n'),
  );
}

describe('init command global runtime bootstrap', () => {
  test('installs CLI, hooks, Waza, brain root, and CodeGraph without setup-plugins.sh', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'repo-harness-global-init-'));
    const source = join(tmp, 'node_modules', 'repo-harness');
    const home = join(tmp, 'home');
    const repo = join(tmp, 'repo');
    const fakeBin = join(tmp, 'bin');
    const bunLog = join(tmp, 'bun.log');
    const npxLog = join(tmp, 'npx.log');
    const codegraphLog = join(tmp, 'codegraph.log');
    try {
      mkdirSync(source, { recursive: true });
      mkdirSync(home, { recursive: true });
      mkdirSync(repo, { recursive: true });
      mkdirSync(fakeBin, { recursive: true });
      setupFakeSource(source);
      writeFakeCodegraph(fakeBin, codegraphLog);
      writeNodeCommand(
        fakeBin,
        'bun',
        [
          "import { appendFileSync } from 'node:fs';",
          "import { spawnSync } from 'node:child_process';",
          `const logFile = ${JSON.stringify(bunLog)};`,
          "const args = process.argv.slice(2);",
          "if (args[0] === 'add' && args[1] === '-g') { appendFileSync(logFile, args.join(' ') + '\\n'); process.exit(0); }",
          "const child = spawnSync(process.execPath, args, { stdio: 'inherit' });",
          "process.exit(child.status ?? 1);",
          "",
        ].join('\n'),
      );
      writeNodeCommand(
        fakeBin,
        'npx',
        [
          "import { appendFileSync } from 'node:fs';",
          `const logFile = ${JSON.stringify(npxLog)};`,
          "const args = process.argv.slice(2);",
          "const joined = args.join(' ');",
          "appendFileSync(logFile, joined + '\\n');",
          "if (joined.includes('skills ls -g --json')) console.log('[]');",
          "process.exit(0);",
          "",
        ].join('\n'),
      );

      const result = runGlobalRuntimeSetup({
        sourceRoot: source,
        cwd: repo,
        target: 'codex',
        env: {
          ...process.env,
          HOME: home,
          PATH: prependPath(fakeBin),
          AGENTIC_DEV_CODEGRAPH_ALLOW_REPO_LOCAL: '0',
        },
      });

      expect(result.exitCode).toBe(0);
      expect(readFileSync(bunLog, 'utf-8')).toContain(`add -g ${source}`);
      expect(result.steps.find((step) => step.step === 'sync repo-harness skill runtime')?.stdout).toContain(
        'sync runtime',
      );
      expect(existsSync(join(home, '.codex', 'hooks.json'))).toBe(true);
      expect(readFileSync(npxLog, 'utf-8')).toContain(
        '-y skills add tw93/Waza -g -a codex -s think hunt check health -y',
      );
      expect(readFileSync(npxLog, 'utf-8')).toContain(
        '-y skills add BfdCampos/dotfiles -g -a codex -s mermaid -y',
      );
      expect(existsSync(join(home, '.codex', 'skills', 'claude-review', 'SKILL.md'))).toBe(true);
      expect(existsSync(join(home, '.claude', 'skills', 'codex-review', 'SKILL.md'))).toBe(false);
      expect(readFileSync(npxLog, 'utf-8')).not.toContain('feature-dev');
      expect(JSON.parse(readFileSync(join(home, '.repo-harness', 'config.json'), 'utf-8')).brainRoot).toBe(
        join(home, 'Documents', 'brain'),
      );
      expect(readFileSync(codegraphLog, 'utf-8')).toContain('codegraph install --target codex --location global --yes');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }, 15000);

  test('npx cache sources force copy-based installed skill sync', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'repo-harness-global-init-npx-'));
    const source = join(tmp, '_npx', 'abc123', 'node_modules', 'repo-harness');
    const home = join(tmp, 'home');
    const fakeBin = join(tmp, 'bin');
    try {
      mkdirSync(source, { recursive: true });
      mkdirSync(home, { recursive: true });
      mkdirSync(fakeBin, { recursive: true });
      setupFakeSource(source);
      writeNodeCommand(fakeBin, 'bun', 'process.exit(0);\n');
      writeNodeCommand(fakeBin, 'npx', 'process.exit(0);\n');

      const result = runGlobalRuntimeSetup({
        sourceRoot: source,
        installCli: false,
        hostAdapters: false,
        externalSkills: false,
        codegraph: false,
        env: {
          ...process.env,
          HOME: home,
          PATH: prependPath(fakeBin),
        },
      });

      expect(result.exitCode).toBe(0);
      expect(result.steps.find((step) => step.step === 'sync repo-harness skill runtime')?.stdout).toContain(
        'link=0',
      );
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('CLI exposes init help for npx users without legacy plugin options', () => {
    const res = spawnSync('bun', [CLI, 'init', '--help'], {
      cwd: ROOT,
      encoding: 'utf-8',
    });
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('Usage: matea init');
    expect(res.stdout).toContain('--target <target>');
    expect(res.stdout).toContain('--no-cli');
    expect(res.stdout).toContain('--brain-root <path>');
    expect(res.stdout).toContain('--refresh');
    expect(res.stdout).not.toContain('--with-optional');
    expect(res.stdout).not.toContain('--project-type');
    expect(res.stdout).not.toContain('setup-plugins');
  });

  test('CLI update refreshes user-level runtime without touching the current repo', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'repo-harness-cli-update-'));
    const home = join(tmp, 'home');
    const repo = join(tmp, 'repo');
    const fakeBin = join(tmp, 'bin');
    const bunLog = join(tmp, 'bun.log');
    try {
      mkdirSync(home, { recursive: true });
      mkdirSync(repo, { recursive: true });
      mkdirSync(fakeBin, { recursive: true });
      writeNodeCommand(
        fakeBin,
        'bun',
        [
          "import { appendFileSync } from 'node:fs';",
          `const logFile = ${JSON.stringify(bunLog)};`,
          "appendFileSync(logFile, process.argv.slice(2).join(' ') + '\\n');",
          "process.exit(0);",
          "",
        ].join('\n'),
      );

      const res = spawnSync(
        process.execPath,
        [
          CLI,
          'update',
          '--no-sync-skill',
          '--no-hooks',
          '--no-external-skills',
          '--no-codegraph',
          '--json',
        ],
        {
          cwd: repo,
          encoding: 'utf-8',
          env: { ...process.env, HOME: home, PATH: prependPath(fakeBin) },
        },
      );

      expect(res.status).toBe(0);
      const result = JSON.parse(res.stdout);
      expect(readFileSync(bunLog, 'utf-8')).toContain('add -g @moretea-labs/matea@latest');
      expect(result.steps.find((step: { step: string }) => step.step === 'configure brain root')?.status).toBe('ok');
      expect(existsSync(join(home, '.repo-harness', 'config.json'))).toBe(true);
      expect(existsSync(join(repo, '.ai'))).toBe(false);
      expect(existsSync(join(repo, 'tasks'))).toBe(false);
      expect(existsSync(join(repo, 'plans'))).toBe(false);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('CLI update --version installs the requested package version', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'repo-harness-cli-update-version-'));
    const home = join(tmp, 'home');
    const repo = join(tmp, 'repo');
    const fakeBin = join(tmp, 'bin');
    const bunLog = join(tmp, 'bun.log');
    try {
      mkdirSync(home, { recursive: true });
      mkdirSync(repo, { recursive: true });
      mkdirSync(fakeBin, { recursive: true });
      writeNodeCommand(
        fakeBin,
        'bun',
        [
          "import { appendFileSync } from 'node:fs';",
          `const logFile = ${JSON.stringify(bunLog)};`,
          "appendFileSync(logFile, process.argv.slice(2).join(' ') + '\\n');",
          "process.exit(0);",
          "",
        ].join('\n'),
      );

      const res = spawnSync(
        process.execPath,
        [
          CLI,
          'update',
          '--version',
          '9.9.9',
          '--no-sync-skill',
          '--no-hooks',
          '--no-external-skills',
          '--no-codegraph',
          '--json',
        ],
        {
          cwd: repo,
          encoding: 'utf-8',
          env: { ...process.env, HOME: home, PATH: prependPath(fakeBin) },
        },
      );

      expect(res.status).toBe(0);
      expect(JSON.parse(res.stdout).steps.find((step: { step: string }) => step.step === 'install repo-harness CLI')?.detail).toBe(
        'spec=@moretea-labs/matea@9.9.9',
      );
      expect(readFileSync(bunLog, 'utf-8')).toContain('add -g @moretea-labs/matea@9.9.9');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('CLI top-level --version still prints the CLI version', () => {
    const res = spawnSync(process.execPath, [CLI, '--version'], {
      cwd: ROOT,
      encoding: 'utf-8',
    });

    expect(res.status).toBe(0);
    expect(res.stdout.trim()).toMatch(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
  });

  test('CLI update --check is read-only setup readiness output', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'repo-harness-cli-update-check-'));
    const home = join(tmp, 'home');
    const repo = join(tmp, 'repo');
    try {
      mkdirSync(home, { recursive: true });
      mkdirSync(repo, { recursive: true });

      const res = spawnSync('bun', [CLI, 'update', '--check', '--target', 'codex', '--json'], {
        cwd: repo,
        encoding: 'utf-8',
        env: { ...process.env, HOME: home },
      });

      expect([0, 1]).toContain(res.status ?? -1);
      const report = JSON.parse(res.stdout);
      expect(report.version).toBe(1);
      expect(report.target).toBe('codex');
      expect(existsSync(join(home, '.repo-harness'))).toBe(false);
      expect(existsSync(join(repo, '.ai'))).toBe(false);
      expect(existsSync(join(repo, 'tasks'))).toBe(false);
      expect(existsSync(join(repo, 'plans'))).toBe(false);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }, 15000);

  test('native Windows keeps the runtime bootstrap usable without Bash or automatic CodeGraph setup', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'repo-harness-global-init-windows-'));
    const source = join(tmp, 'node_modules', 'repo-harness');
    const home = join(tmp, 'home');
    const repo = join(tmp, 'repo');
    try {
      mkdirSync(source, { recursive: true });
      mkdirSync(home, { recursive: true });
      mkdirSync(repo, { recursive: true });
      setupFakeSource(source);

      const result = runGlobalRuntimeSetup({
        sourceRoot: source,
        cwd: repo,
        platform: 'win32',
        installCli: false,
        hostAdapters: false,
        externalSkills: false,
        env: { ...process.env, HOME: home },
      });

      expect(result.exitCode).toBe(0);
      expect(result.steps.find((step) => step.step === 'sync repo-harness skill runtime')).toMatchObject({
        status: 'skipped',
      });
      expect(result.steps.find((step) => step.step === 'ensure CodeGraph CLI')).toMatchObject({
        status: 'skipped',
      });
      expect(result.stdout).toContain('use WSL2');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('CLI exposes update help for user-level refresh', () => {
    const res = spawnSync('bun', [CLI, 'update', '--help'], {
      cwd: ROOT,
      encoding: 'utf-8',
    });
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('Usage: matea update');
    expect(res.stdout).toContain('--version <version>');
    expect(res.stdout).toContain('--channel <channel>');
    expect(res.stdout).toContain('--check');
    expect(res.stdout).toContain('--no-runtime-refresh');
    expect(res.stdout).toContain('--with-external-skills');
    expect(res.stdout).toContain('--configure-codegraph');
    expect(res.stdout).toContain('--no-cli');
    expect(res.stdout).toContain('Deprecated: use matea adopt --repo <path>');
  });
});
