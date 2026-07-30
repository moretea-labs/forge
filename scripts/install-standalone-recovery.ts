import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, isAbsolute, join, resolve } from 'path';
import { spawn } from 'child_process';
import { initializeStandaloneRecovery } from '../src/runtime/standalone-recovery/core';

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function compileRecoveryBinary(bun: string, output: string): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolveCompile, rejectCompile) => {
    const child = spawn(bun, ['build', join(process.cwd(), 'src/runtime/standalone-recovery/entry.ts'), '--compile', '--outfile', output], {
      cwd: process.cwd(), shell: false, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = (value: { status: number | null; stdout: string; stderr: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      resolveCompile(value);
    };
    const stop = () => {
      if (!child.pid || child.exitCode != null) return;
      try { process.kill(child.pid, 'SIGTERM'); } catch { /* already exited */ }
      killTimer = setTimeout(() => { try { if (child.pid && child.exitCode == null) process.kill(child.pid, 'SIGKILL'); } catch { /* already exited */ } }, 1_000);
    };
    const timeout = setTimeout(stop, 180_000);
    child.stdout.on('data', (chunk: Buffer) => { stdoutBytes += chunk.length; if (stdoutBytes <= 512 * 1024) stdout.push(Buffer.from(chunk)); else stop(); });
    child.stderr.on('data', (chunk: Buffer) => { stderrBytes += chunk.length; if (stderrBytes <= 512 * 1024) stderr.push(Buffer.from(chunk)); else stop(); });
    child.once('error', () => rejectCompile(new Error('RECOVERY_BUILD_SPAWN_FAILED')));
    child.once('close', (status) => finish({ status, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') }));
  });
}

const homeIndex = process.argv.indexOf('--controller-home');
const controllerHome = resolve(homeIndex >= 0 ? process.argv[homeIndex + 1] : process.env.REPO_HARNESS_CONTROLLER_HOME ?? '');
if (!controllerHome || controllerHome === resolve('.')) throw new Error('RECOVERY_CONTROLLER_HOME_REQUIRED');
const portIndex = process.argv.indexOf('--port');
const port = portIndex >= 0 ? Number(process.argv[portIndex + 1]) : 8787;
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('RECOVERY_GATEWAY_PORT_INVALID');
const publicTunnelLabel = option('--public-tunnel-service-label');
const publicTunnelPlist = option('--public-tunnel-service-plist');
if (publicTunnelPlist && !publicTunnelLabel) throw new Error('RECOVERY_PUBLIC_TUNNEL_SERVICE_LABEL_REQUIRED');
if (publicTunnelLabel && !/^com\.[A-Za-z0-9._-]{1,180}$/.test(publicTunnelLabel)) throw new Error('RECOVERY_PUBLIC_TUNNEL_SERVICE_LABEL_INVALID');
if (publicTunnelPlist && !isAbsolute(publicTunnelPlist)) throw new Error('RECOVERY_PUBLIC_TUNNEL_SERVICE_PLIST_ABSOLUTE_REQUIRED');
const bin = join(controllerHome, 'recovery', 'bin', 'repo-harness-recovery');
const gatewayBin = join(controllerHome, 'recovery', 'bin', 'repo-harness-recovery-gateway');
const watchdogBin = join(controllerHome, 'recovery', 'bin', 'repo-harness-recovery-watchdog');
mkdirSync(dirname(bin), { recursive: true, mode: 0o700 });
const bun = process.execPath;
for (const output of [bin, gatewayBin, watchdogBin]) {
  const result = await compileRecoveryBinary(bun, output);
  if (result.status !== 0) throw new Error(`RECOVERY_BUILD_FAILED: ${(result.stderr || result.stdout).slice(0, 800)}`);
  chmodSync(output, 0o700);
}
const config = initializeStandaloneRecovery(controllerHome, port, publicTunnelLabel
  ? { platform: 'launchd', label: publicTunnelLabel, ...(publicTunnelPlist ? { plistPath: publicTunnelPlist } : {}) }
  : undefined);
const grokPrompt = join(controllerHome, 'recovery', 'prompts', 'grok-recovery.md');
mkdirSync(dirname(grokPrompt), { recursive: true, mode: 0o700 });
writeFileSync(grokPrompt, readFileSync(join(process.cwd(), 'recovery', 'prompts', 'grok-recovery.md')), { mode: 0o600 });
const grokWrapper = join(controllerHome, 'recovery', 'bin', 'repo-harness-recover-with-grok');
writeFileSync(grokWrapper, `#!/bin/sh
set -eu
BIN=${JSON.stringify(bin)}
PROMPT=${JSON.stringify(grokPrompt)}
STATUS="$($BIN status --controller-home ${JSON.stringify(controllerHome)})"
VERIFY="$($BIN verify --controller-home ${JSON.stringify(controllerHome)})"
DECISION="$(grok --no-memory --no-subagents --disable-web-search --permission-mode plan --max-turns 1 --output-format json --json-schema '{"type":"object","properties":{"action":{"enum":["stop","rollback-previous","reconnect-main"]},"reason":{"type":"string","maxLength":300}},"required":["action","reason"],"additionalProperties":false}' -p "$(cat \"$PROMPT\")\n\nSTATUS:\n$STATUS\n\nVERIFY:\n$VERIFY")"
ACTION="$(printf '%s' "$DECISION" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const x=JSON.parse(s); if(!["stop","rollback-previous","reconnect-main"].includes(x.action)) process.exit(2); process.stdout.write(x.action)})')"
case "$ACTION" in
  stop) printf '%s\\n' "$DECISION" ;;
  rollback-previous) "$BIN" rollback-previous --controller-home ${JSON.stringify(controllerHome)} ; "$BIN" verify --controller-home ${JSON.stringify(controllerHome)} ; "$BIN" reconnect-main --controller-home ${JSON.stringify(controllerHome)} ;;
  reconnect-main) "$BIN" reconnect-main --controller-home ${JSON.stringify(controllerHome)} ;;
  *) exit 2 ;;
esac
`, { mode: 0o700 });
chmodSync(grokWrapper, 0o700);
const launchd = join(controllerHome, 'recovery', 'launchd', 'com.moretea.repo-harness-recovery-gateway.plist');
mkdirSync(dirname(launchd), { recursive: true, mode: 0o700 });
const plist = (label: string, executable: string, command: string, log: string) => `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key><string>${label}</string><key>ProgramArguments</key><array><string>/usr/bin/env</string><string>-i</string><string>PATH=/usr/bin:/bin:/usr/sbin:/sbin</string><string>${executable}</string><string>${command}</string><string>--controller-home</string><string>${controllerHome}</string></array><key>RunAtLoad</key><true/><key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict><key>ThrottleInterval</key><integer>5</integer><key>StandardOutPath</key><string>${log}</string><key>StandardErrorPath</key><string>${log}</string></dict></plist>\n`;
writeFileSync(launchd, plist('com.moretea.repo-harness-recovery-gateway', gatewayBin, 'gateway', join(controllerHome, 'recovery', 'audit', 'gateway.log')), { mode: 0o600 });
const watchdogLaunchd = join(controllerHome, 'recovery', 'launchd', 'com.moretea.repo-harness-recovery-watchdog.plist');
writeFileSync(watchdogLaunchd, plist('com.moretea.repo-harness-recovery-watchdog', watchdogBin, 'watchdog', join(controllerHome, 'recovery', 'audit', 'watchdog.log')), { mode: 0o600 });
console.log(JSON.stringify({ status: 'installed', binary: bin, supportingBinaries: [gatewayBin, watchdogBin], launchdPlists: [launchd, watchdogLaunchd], config: { controllerHome: config.controllerHome, gateway: { host: config.gateway?.host, port: config.gateway?.port }, publicTunnelService: config.publicTunnelService ? { platform: config.publicTunnelService.platform, label: config.publicTunnelService.label, plistPath: config.publicTunnelService.plistPath } : undefined } }, null, 2));
