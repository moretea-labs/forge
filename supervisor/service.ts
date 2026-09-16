import { createHash } from 'node:crypto';
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createPlatformServiceManagerHost } from '../src/runtime/platform/service-manager';
import { resolveWorkflowSupervisorForgeHome, workflowSupervisorRoot } from './store';

export interface WorkflowSupervisorServicePaths { serviceRoot: string; socketPath: string; stdoutPath: string; stderrPath: string; sourcePlistPath: string; label: string }
export function workflowSupervisorServicePaths(forgeHome?: string): WorkflowSupervisorServicePaths {
  const home = resolveWorkflowSupervisorForgeHome(forgeHome); const root = workflowSupervisorRoot(home); const suffix = createHash('sha256').update(home).digest('hex').slice(0, 12); const label = `com.moretea.forge.workflow-supervisor.${suffix}`;
  return { serviceRoot: root, socketPath: join(root, 'supervisor.sock'), stdoutPath: join(root, 'logs', 'stdout.log'), stderrPath: join(root, 'logs', 'stderr.log'), sourcePlistPath: join(root, `${label}.plist`), label };
}
function xml(value: string): string { return value.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;'); }
function atomicWrite(path: string, content: string): void { mkdirSync(dirname(path), { recursive: true, mode: 0o700 }); const tmp = `${path}.${process.pid}.tmp`; writeFileSync(tmp, content, { encoding: 'utf8', mode: 0o600 }); renameSync(tmp, path); }
export function renderWorkflowSupervisorLaunchd(input: { label: string; bunExecutable: string; entryPath: string; forgeHome: string; stdoutPath: string; stderrPath: string }): string {
  const args = [input.bunExecutable, input.entryPath, '--forge-home', input.forgeHome].map((v) => `<string>${xml(v)}</string>`).join('');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key><string>${xml(input.label)}</string><key>ProgramArguments</key><array>${args}</array><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>StandardOutPath</key><string>${xml(input.stdoutPath)}</string><key>StandardErrorPath</key><string>${xml(input.stderrPath)}</string></dict></plist>\n`;
}
export function writeWorkflowSupervisorServiceContract(input: { forgeHome?: string; bunExecutable: string; entryPath: string; platform?: NodeJS.Platform }): { kind: string; path: string; label: string } {
  const home = resolveWorkflowSupervisorForgeHome(input.forgeHome); const paths = workflowSupervisorServicePaths(home); const host = createPlatformServiceManagerHost({ platform: input.platform });
  if (host.selection.kind === 'launchd') { atomicWrite(paths.sourcePlistPath, renderWorkflowSupervisorLaunchd({ label: paths.label, bunExecutable: resolve(input.bunExecutable), entryPath: resolve(input.entryPath), forgeHome: home, stdoutPath: paths.stdoutPath, stderrPath: paths.stderrPath })); return { kind: 'launchd', path: paths.sourcePlistPath, label: paths.label }; }
  const unit = { description: 'Forge Workflow Supervisor', executable: resolve(input.bunExecutable), args: [resolve(input.entryPath), '--forge-home', home], environment: {}, restart: 'always' as const, restartSec: 1 };
  if (host.selection.kind === 'systemd-user') return { kind: 'systemd-user', path: host.writeSystemdUserUnit(`${paths.label}.service`, unit), label: paths.label };
  return { kind: 'portable', path: resolve(input.entryPath), label: paths.label };
}

export async function installWorkflowSupervisorService(input: { forgeHome?: string; bunExecutable: string; entryPath: string; platform?: NodeJS.Platform }): Promise<{ kind: string; label: string; diagnostics: string[] }> {
  const contract = writeWorkflowSupervisorServiceContract(input);
  const host = createPlatformServiceManagerHost({ platform: input.platform });
  if (contract.kind === 'launchd') {
    host.installLaunchd(contract.path, contract.label);
    const result = await host.bootstrapLaunchd({ label: contract.label, plistPath: host.launchdInstalledPath(contract.label) });
    return { kind: contract.kind, label: contract.label, diagnostics: result.diagnostics };
  }
  if (contract.kind === 'systemd-user') {
    const home = resolveWorkflowSupervisorForgeHome(input.forgeHome);
    const unit = { description: 'Forge Workflow Supervisor', executable: resolve(input.bunExecutable), args: [resolve(input.entryPath), '--forge-home', home], environment: {}, restart: 'always' as const, restartSec: 1 };
    const path = host.installSystemdUserUnit({ unitName: `${contract.label}.service`, unit, errorPrefix: 'WORKFLOW_SUPERVISOR_SYSTEMD_INSTALL_FAILED' });
    return { kind: contract.kind, label: contract.label, diagnostics: [`installed ${path}`] };
  }
  return { kind: contract.kind, label: contract.label, diagnostics: ['portable mode requires an explicit foreground or detached process owner'] };
}
