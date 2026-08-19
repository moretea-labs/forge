import { describe, expect, test } from 'bun:test';
import { buildV81Program } from '../../src/cli/v81-entry';

describe('v81 CLI entry', () => {
  test('reuses the canonical program without duplicating top-level commands', () => {
    const commands = buildV81Program().commands.map((command) => command.name());
    expect(commands.filter((name) => name === 'repo')).toHaveLength(1);
    expect(commands.filter((name) => name === 'recovery')).toHaveLength(1);
  });
});
