import { describe, expect, test } from 'bun:test';
import { forgeToolSurfaceFingerprint } from '../../src/cli/controller/runtime-config';
import { mcpSessionToolSurfaceFingerprintIsCurrent } from '../../src/cli/mcp/transports/http';
import { injectDurableCommandFields } from '../../src/runtime/gateway/mcp/router';

describe('MCP canonical Runtime schema fencing', () => {
  test('changes only when the exposed schema changes, not when a release identity changes', () => {
    const surface = [{
      name: 'rh_work',
      description: 'Stable facade.',
      inputSchema: { type: 'object', properties: { operation: { type: 'string' } } },
      annotations: { readOnlyHint: false },
    }];
    const baseline = forgeToolSurfaceFingerprint(surface);
    expect(forgeToolSurfaceFingerprint(structuredClone(surface))).toBe(baseline);
    expect(mcpSessionToolSurfaceFingerprintIsCurrent(baseline, baseline)).toBe(true);
  });

  test('invalidates a session when discovery schema changes', () => {
    const before = forgeToolSurfaceFingerprint([{ name: 'rh_status', inputSchema: { type: 'object' } }]);
    const after = forgeToolSurfaceFingerprint([{ name: 'rh_context', inputSchema: { type: 'object' } }]);
    expect(before).not.toBe(after);
    expect(mcpSessionToolSurfaceFingerprintIsCurrent(before, after)).toBe(false);
  });

  test('includes durable fields that tools/list adds to the discovery schema', () => {
    const source = [{ name: 'rh_status', description: 'Runtime status.', inputSchema: { type: 'object', properties: {} } }];
    const listed = source.map(injectDurableCommandFields);

    expect(forgeToolSurfaceFingerprint(listed)).not.toBe(forgeToolSurfaceFingerprint(source));
    expect(mcpSessionToolSurfaceFingerprintIsCurrent(
      forgeToolSurfaceFingerprint(listed),
      forgeToolSurfaceFingerprint(listed),
    )).toBe(true);
  });
});
