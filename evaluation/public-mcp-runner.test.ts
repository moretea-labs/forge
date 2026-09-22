import { describe, expect, test } from 'bun:test';
import { sampleMcpProcessResource } from './lib/public-mcp-runner.ts';

describe('public MCP resource accounting', () => {
  test('samples evaluator-owned CPU and RSS for a live child process', () => {
    const sample = sampleMcpProcessResource(process.pid);
    expect(sample).toBeDefined();
    expect(sample?.userCpuMs).toBeGreaterThanOrEqual(0);
    expect(sample?.systemCpuMs).toBeGreaterThanOrEqual(0);
    expect(sample?.peakRssBytes).toBeGreaterThan(0);
  });

  test('leaves unsupported or exited processes unmeasured', () => {
    expect(sampleMcpProcessResource(null)).toBeUndefined();
    expect(sampleMcpProcessResource(-1)).toBeUndefined();
  });
});
