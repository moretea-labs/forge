import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, isAbsolute, join, resolve } from 'path';
import { installStandaloneRecovery } from '../src/runtime/standalone-recovery/installer';

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
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
const stageOnly = process.argv.includes('--stage-only');
const result = await installStandaloneRecovery({
  controllerHome,
  repoRoot: process.cwd(),
  sourceRoot: process.cwd(),
  port,
  stageOnly,
  publicTunnelService: publicTunnelLabel
    ? { platform: 'launchd', label: publicTunnelLabel, ...(publicTunnelPlist ? { plistPath: publicTunnelPlist } : {}) }
    : undefined,
});
const config = result.config;
const bin = join(controllerHome, 'recovery', 'bin', 'repo-harness-recovery');
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
console.log(JSON.stringify({
  status: stageOnly ? 'staged' : 'installed',
  controllerHome,
  stagedRelease: result.staged.release,
  activation: result.activated,
  binary: bin,
  config: {
    controllerHome: config.controllerHome,
    gateway: { host: config.gateway?.host, port: config.gateway?.port },
    publicTunnelService: config.publicTunnelService
      ? { platform: config.publicTunnelService.platform, label: config.publicTunnelService.label, plistPath: config.publicTunnelService.plistPath }
      : undefined,
  },
}, null, 2));
