import { describe, expect, test } from 'bun:test';
import { getCoreCapabilityExecutionSchema } from '../../src/runtime/control-plane/facade/capability-registry';
import { FACADE_TOOLS } from '../../src/runtime/control-plane/facade/types';

describe('repository.git stable facade', () => {
  test('exposes exact remote branch CAS deletion without widening the top-level MCP surface', () => {
    const schema = getCoreCapabilityExecutionSchema('repository.git') as {
      executeWith?: string;
      actions?: Record<string, {
        readOnly?: boolean;
        risk?: string;
        argumentsSchema?: {
          required?: string[];
          properties?: Record<string, unknown>;
        };
      }>;
    } | undefined;

    expect(schema?.executeWith).toBe('capability_execute');
    const action = schema?.actions?.delete_remote_branch;
    expect(action).toMatchObject({ readOnly: false, risk: 'destructive_remote' });
    expect(action?.argumentsSchema?.required).toEqual(['branch', 'expected_remote_sha']);
    expect(action?.argumentsSchema?.properties).toHaveProperty('approval_request_id');
    expect(action?.argumentsSchema?.properties).not.toHaveProperty('remote');
    expect(action?.argumentsSchema?.properties).not.toHaveProperty('force');
    expect(FACADE_TOOLS).toEqual([
      'rh_access', 'rh_status', 'rh_inbox', 'rh_context', 'rh_work', 'capability_execute',
    ]);
  });
});
