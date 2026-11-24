import { describe, expect, it } from 'bun:test';

import { runtimeToolDefinitions } from '../../adapters/mcp/runtime-gateway/runtime-tool-definitions';

type SchemaProperty = {
  type?: string;
  enum?: string[];
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
};

function toolProperties(name: string): {
  properties: Record<string, SchemaProperty>;
  additionalProperties: boolean;
} {
  const tool = runtimeToolDefinitions.find((entry) => entry.name === name);
  expect(tool).toBeDefined();
  return tool!.inputSchema as {
    properties: Record<string, SchemaProperty>;
    additionalProperties: boolean;
  };
}

describe('native Runtime cleanup tool contracts', () => {
  it('exposes bounded Process lifecycle fields for preview and apply', () => {
    for (const name of ['runtime_cleanup_preview', 'runtime_cleanup_apply']) {
      const schema = toolProperties(name);
      expect(schema.additionalProperties).toBe(false);
      expect(schema.properties.request_id).toMatchObject({
        type: 'string',
        minLength: 1,
        maxLength: 160,
      });
      expect(schema.properties.apply_mode).toMatchObject({
        type: 'string',
        enum: ['sync', 'async'],
      });
      expect(schema.properties.interactive_wait_ms).toMatchObject({
        type: 'number',
        minimum: 0,
        maximum: 5_000,
      });
    }
  });

  it('keeps apply confirmation-gated and excludes arbitrary path deletion', () => {
    const schema = toolProperties('runtime_cleanup_apply');
    expect(schema.properties.confirm_cleanup).toMatchObject({ type: 'boolean' });
    expect(schema.properties).not.toHaveProperty('path');
    expect(schema.properties).not.toHaveProperty('paths');
    expect(schema.properties).not.toHaveProperty('delete_path');
  });
});
