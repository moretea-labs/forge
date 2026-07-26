import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { spawnSync } from 'child_process';
import { initializeStandaloneRecovery } from '../src/runtime/standalone-recovery/core';

const homeIndex = process.argv.indexOf('--controller-home');
const controllerHome = resolve(homeIndex >= 0 ? process.argv[homeIndex + 1] : process.env.REPO_HARNESS_CONTROLLER_HOME ?? '');
if (!controllerHome || controllerHome === resolve('.')) throw new Error('RECOVERY_CONTROLLER_HOME_REQUIRED');
const portIndex = process.argv.indexOf('--port');
const port = portIndex >= 0 ? Number(process.argv[portIndex + 1]) : 8787;
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('RECOVERY_GATEWAY_PORT_INVALID');
const bin = join(controllerHome, 'recovery', 'bin', 'repo-harness-recovery');
mkdirSync(dirname(bin), { recursive: true, mode: 0o700 });
const bun = process.execPath;
const result = spawnSync(bun, ['build', join(process.cwd(), 'src/runtime/standalone-recovery/entry.ts'), '--compile', '--outfile', bin], { cwd: process.cwd(), encoding: 'utf8', timeout: 180_000 });
if (result.status !== 0) throw new Error(`RECOVERY_BUILD_FAILED: ${(result.stderr || result.stdout).slice(0, 800)}`);
chmodSync(bin, 0o700);
const config = initializeStandaloneRecovery(controllerHome, port);
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
const plist = (label: string, command: string, log: string) => `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key><string>${label}</string><key>ProgramArguments</key><array><string>${bin}</string><string>${command}</string><string>--controller-home</string><string>${controllerHome}</string></array><key>RunAtLoad</key><true/><key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict><key>ThrottleInterval</key><integer>5</integer><key>StandardOutPath</key><string>${log}</string><key>StandardErrorPath</key><string>${log}</string></dict></plist>\n`;
writeFileSync(launchd, plist('com.moretea.repo-harness-recovery-gateway', 'gateway', join(controllerHome, 'recovery', 'audit', 'gateway.log')), { mode: 0o600 });
const watchdogLaunchd = join(controllerHome, 'recovery', 'launchd', 'com.moretea.repo-harness-recovery-watchdog.plist');
writeFileSync(watchdogLaunchd, plist('com.moretea.repo-harness-recovery-watchdog', 'watchdog', join(controllerHome, 'recovery', 'audit', 'watchdog.log')), { mode: 0o600 });
console.log(JSON.stringify({ status: 'installed', binary: bin, launchdPlists: [launchd, watchdogLaunchd], config: { controllerHome: config.controllerHome, gateway: { host: config.gateway?.host, port: config.gateway?.port } } }, null, 2));
