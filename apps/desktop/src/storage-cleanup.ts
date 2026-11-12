import { invoke } from '@tauri-apps/api/core';

export type CleanupCategory = 'temp_dirs' | 'terminal_local_jobs' | 'legacy_runs';

export interface CleanupCandidate {
  kind: string;
  path?: string;
  reason: string;
  ageMinutes?: number;
  safe: boolean;
}

export interface CleanupPreview {
  runtime: {
    mode: 'preview';
    generatedAt: string;
    candidates: CleanupCandidate[];
    summary: { total: number; safe: number; unsafe: number };
    truncated?: { candidates?: boolean };
    warnings?: string[];
  };
  sqlite: { bytes: number | null; managedByRuntime: true };
  projectCaches?: {
    items: Array<{
      project: string;
      kind: string;
      path: string;
      logicalBytes: number;
      partial: boolean;
      eligible: false;
    }>;
    incomplete: boolean;
    measurement: 'bounded_logical_bytes';
  };
}

export const readDiskCleanupPreview = (repoId: string): Promise<CleanupPreview> =>
  invoke('read_disk_cleanup_preview', { repoId });

export const applyDiskCleanup = (repoId: string, categories: CleanupCategory[]): Promise<unknown> =>
  invoke('apply_disk_cleanup', { repoId, categories, confirmCleanup: true });

export function cleanupCategory(kind: string): CleanupCategory | null {
  if (kind === 'temp_dir') return 'temp_dirs';
  if (kind === 'local_job') return 'terminal_local_jobs';
  if (kind === 'legacy_run') return 'legacy_runs';
  return null;
}
