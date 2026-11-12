import { expect, test } from 'bun:test';
import { cleanupCategory } from '../src/storage-cleanup';

test('runtime cleanup kinds map only to explicitly supported desktop categories', () => {
  expect(cleanupCategory('temp_dir')).toBe('temp_dirs');
  expect(cleanupCategory('local_job')).toBe('terminal_local_jobs');
  expect(cleanupCategory('legacy_run')).toBe('legacy_runs');
  expect(cleanupCategory('attention_marker')).toBeNull();
  expect(cleanupCategory('forge_database')).toBeNull();
  expect(cleanupCategory('unknown')).toBeNull();
});
