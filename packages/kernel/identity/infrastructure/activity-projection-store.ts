import { randomUUID } from 'crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, readdirSync } from 'fs';
import { dirname, join, resolve } from 'path';
import type { CapabilityActivityItem, UnifiedActivityView, WorkTreeProjectionNode } from '../domain/activity-projection';

function activityDir(controllerHome: string): string {
  const dir = resolve(controllerHome, 'activity-projection');
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return dir;
}

function activityFilePath(controllerHome: string, activityId: string): string {
  const sanitized = activityId.replace(/[^a-zA-Z0-9._-]/g, '_');
  return join(activityDir(controllerHome), `${sanitized}.json`);
}

export function recordDirectActivity(
  controllerHome: string,
  input: Omit<CapabilityActivityItem, 'activityId' | 'startedAt'> & { activityId?: string; startedAt?: string },
): CapabilityActivityItem {
  const now = new Date().toISOString();
  const activityId = input.activityId || `act-${randomUUID()}`;
  const item: CapabilityActivityItem = {
    ...input,
    activityId,
    startedAt: input.startedAt ?? now,
  };

  const filePath = activityFilePath(controllerHome, activityId);
  const tmpPath = `${filePath}.${randomUUID()}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(item, null, 2), 'utf8');
  renameSync(tmpPath, filePath);

  return item;
}

export function listDirectActivities(controllerHome: string, limit = 50): CapabilityActivityItem[] {
  const dir = activityDir(controllerHome);
  const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
  const items: CapabilityActivityItem[] = [];

  for (const file of files) {
    try {
      const content = readFileSync(join(dir, file), 'utf8');
      items.push(JSON.parse(content) as CapabilityActivityItem);
    } catch {
      // ignore corrupted file
    }
  }

  return items
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
    .slice(0, limit);
}

/**
 * Project unified activity view combining WorkTree with direct capability activities.
 * Direct capability activity that has no Work appears in directActivities rather than
 * being forced into synthetic Work.
 */
export function projectUnifiedActivityView(
  controllerHome: string,
  workTreeNodes: WorkTreeProjectionNode[],
  limitDirect = 50,
): UnifiedActivityView {
  const directActivities = listDirectActivities(controllerHome, limitDirect);
  const now = new Date();

  return {
    workTree: workTreeNodes,
    directActivities: directActivities.filter((act) => !act.associatedWorkId),
    observedAt: now.toISOString(),
    freshnessMs: 0,
  };
}
