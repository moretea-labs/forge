import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  FORGE_RECOVERY_DAEMON_LABEL,
  FORGE_RECOVERY_GATEWAY_LABEL,
  forgeConnectorPersistentServiceLabel,
  forgeRuntimePersistentServiceLabel,
} from '../src/runtime/platform/service-inventory';
import {
  classifyRecoveryMcpRequest,
  recoveryRuntimeRoleFromExecutable,
} from '../src/runtime/standalone-recovery/entry';
import { recentMcpTransportEvidence } from '../adapters/mcp/transports/http-observation';
import { recordMcpTransportEvent, readRecentMcpTransportEvents } from '../src/runtime/diagnostics/mcp-timing';

const controllerHome = mkdtempSync(join(tmpdir(), 'forge-control-plane-failure-domain-'));
try {
  // Main Runtime/MCP and Recovery must have distinct service identities. A
  // restart or crash fence for one must not name the other lifecycle owner.
  const runtimeLabel = forgeRuntimePersistentServiceLabel(controllerHome);
  const connectorLabel = forgeConnectorPersistentServiceLabel(controllerHome);
  assert.notEqual(runtimeLabel, FORGE_RECOVERY_DAEMON_LABEL);
  assert.notEqual(runtimeLabel, FORGE_RECOVERY_GATEWAY_LABEL);
  assert.notEqual(connectorLabel, FORGE_RECOVERY_DAEMON_LABEL);
  assert.notEqual(connectorLabel, FORGE_RECOVERY_GATEWAY_LABEL);
  assert.notEqual(FORGE_RECOVERY_DAEMON_LABEL, FORGE_RECOVERY_GATEWAY_LABEL);
  assert.equal(recoveryRuntimeRoleFromExecutable('/tmp/forge-recovery-gateway'), 'gateway');
  assert.equal(recoveryRuntimeRoleFromExecutable('/tmp/forge-recovery-watchdog'), 'watchdog');

  // Recovery owns its own MCP route. Main MCP being unavailable must not turn a
  // valid Recovery request into a route-level 404; authorization is evaluated
  // by the Recovery gateway itself.
  assert.equal(classifyRecoveryMcpRequest({
    method: 'POST',
    url: '/recovery/mcp',
    headers: { authorization: 'Bearer recovery-token' },
  } as any, 'recovery-token'), 'mcp');
  assert.equal(classifyRecoveryMcpRequest({
    method: 'POST',
    url: '/recovery/mcp',
    headers: {},
  } as any, 'recovery-token'), 'auth_required');
  assert.equal(classifyRecoveryMcpRequest({
    method: 'POST',
    url: '/main/mcp',
    headers: { authorization: 'Bearer recovery-token' },
  } as any, 'recovery-token'), 'not_mcp');

  // Current health and recent incident evidence are separate dimensions. A
  // successful reconnect does not erase the interruption that immediately
  // preceded it, and a later health probe may still truthfully be green.
  const interruptedAt = '2026-09-22T12:00:00.000Z';
  const recoveredAt = '2026-09-22T12:00:05.000Z';
  recordMcpTransportEvent(controllerHome, {
    kind: 'interruption',
    sessionId: 'mcp-before-outage',
    connectionId: 'connection-before-outage',
    route: '/mcp',
    principalId: 'chatgpt-controller',
    reason: 'transport_close',
    at: interruptedAt,
  });
  recordMcpTransportEvent(controllerHome, {
    kind: 'session_initialized',
    sessionId: 'mcp-after-outage',
    connectionId: 'connection-after-outage',
    route: '/mcp',
    principalId: 'chatgpt-controller',
    at: recoveredAt,
  });
  const evidence = recentMcpTransportEvidence(
    readRecentMcpTransportEvents(controllerHome),
    '2026-09-22T11:00:00.000Z',
    Date.parse('2026-09-22T12:01:00.000Z'),
  );
  assert.equal(evidence.current, 'healthy');
  assert.equal(evidence.recentStatus, 'recovered');
  assert.equal(evidence.lastInterruption?.at, interruptedAt);
  assert.equal(evidence.lastRecoveryAt, recoveredAt);

  console.log(JSON.stringify({
    status: 'ok',
    mainRuntimeLabel: runtimeLabel,
    mainConnectorLabel: connectorLabel,
    recoveryDaemonLabel: FORGE_RECOVERY_DAEMON_LABEL,
    recoveryGatewayLabel: FORGE_RECOVERY_GATEWAY_LABEL,
    recoveryRouteIndependent: true,
    health: evidence,
  }, null, 2));
} finally {
  rmSync(controllerHome, { recursive: true, force: true });
}
