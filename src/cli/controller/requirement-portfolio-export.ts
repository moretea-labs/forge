import { createHash, randomBytes } from 'crypto';
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'fs';
import { dirname, join, relative, resolve } from 'path';
import type { Requirement } from '../../runtime/control-plane/persistence/requirement-store';
import type { PlanContract } from '../../runtime/control-plane/facade/types';
import { listControlPlaneRecords, readControlPlaneRecord } from '../../runtime/control-plane/persistence/sqlite-store';
import { assertControlPlaneMetadataPayload } from '../../runtime/control-plane/persistence/metadata-payload-policy';
import {
  REQUIREMENT_PORTFOLIO_MIGRATION_ID,
  type RequirementPortfolioMigrationRecord,
} from './requirement-portfolio-migration';

export interface RequirementPortfolioExportOptions {
  controllerHome: string;
  repoId: string;
  outputDir: string;
  repoRoot?: string;
  /** Deterministic test-only failure before an export file is published. */
  faultInjection?: { failAfterWrites?: number };
}

export interface RequirementPortfolioExportManifest {
  schemaVersion: 1;
  kind: 'requirement_portfolio_offline_export';
  compatibility: 'deprecated_frozen_projection';
  direction: 'sqlite_to_offline_only';
  authority: 'controller-home-sqlite';
  replayAllowed: false;
  migrationId: string;
  repoId: string;
  sourceRevision: string;
  sourceFingerprint: string;
  mappingFingerprint: string;
  sqliteRevisions: { requirements: Record<string, number>; plans: Record<string, number> };
  requirementCount: number;
  planCount: number;
  contentFingerprint: string;
  generatedFromMigrationAt: string;
}

function stableJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function assertOutputBoundary(options: RequirementPortfolioExportOptions): string {
  const outputDir = resolve(options.outputDir);
  if (!options.repoRoot) return outputDir;
  const legacyRoot = resolve(options.repoRoot, 'tasks/issues');
  const relation = relative(legacyRoot, outputDir);
  if (relation === '' || (!relation.startsWith('..') && !relation.startsWith('/'))) {
    throw new Error('REQUIREMENT_EXPORT_LEGACY_AUTHORITY_PATH_REFUSED: choose an explicit offline directory outside tasks/issues');
  }
  return outputDir;
}

function publishDirectory(staging: string, outputDir: string): void {
  const previous = `${outputDir}.previous-${process.pid}-${randomBytes(4).toString('hex')}`;
  const hadPrevious = existsSync(outputDir);
  if (hadPrevious) renameSync(outputDir, previous);
  try {
    renameSync(staging, outputDir);
    if (hadPrevious) rmSync(previous, { recursive: true, force: true });
  } catch (error) {
    if (existsSync(outputDir)) rmSync(outputDir, { recursive: true, force: true });
    if (hadPrevious && existsSync(previous)) renameSync(previous, outputDir);
    throw error;
  }
}

export function exportRequirementPortfolio(options: RequirementPortfolioExportOptions): RequirementPortfolioExportManifest {
  const outputDir = assertOutputBoundary(options);
  const migration = readControlPlaneRecord<RequirementPortfolioMigrationRecord>(
    options.controllerHome,
    'requirement_portfolio_migration',
    options.repoId,
    REQUIREMENT_PORTFOLIO_MIGRATION_ID,
  );
  if (!migration) throw new Error('REQUIREMENT_PORTFOLIO_MIGRATION_NOT_FOUND');
  const requirements = listControlPlaneRecords<Requirement>(options.controllerHome, {
    namespace: 'requirement', scope: 'controller', limit: 5_000,
  }).sort((left, right) => left.key.localeCompare(right.key));
  const plans = listControlPlaneRecords<PlanContract>(options.controllerHome, {
    namespace: 'plan_contract', scope: options.repoId, limit: 5_000,
  }).sort((left, right) => left.key.localeCompare(right.key));
  if (requirements.length !== migration.value.requirementIds.length || plans.length !== migration.value.planIds.length) {
    throw new Error(`REQUIREMENT_EXPORT_AUTHORITY_COUNT_MISMATCH: requirements=${requirements.length}/${migration.value.requirementIds.length} plans=${plans.length}/${migration.value.planIds.length}`);
  }
  const content = {
    migration: migration.value,
    requirements: requirements.map((record) => ({ key: record.key, revision: record.revision, value: record.value })),
    plans: plans.map((record) => ({ key: record.key, revision: record.revision, value: record.value })),
  };
  assertControlPlaneMetadataPayload(content, 'requirement_portfolio_export');
  const contentFingerprint = sha256(stableJson(content));
  const manifest: RequirementPortfolioExportManifest = {
    schemaVersion: 1,
    kind: 'requirement_portfolio_offline_export',
    compatibility: 'deprecated_frozen_projection',
    direction: 'sqlite_to_offline_only',
    authority: 'controller-home-sqlite',
    replayAllowed: false,
    migrationId: migration.value.migrationId,
    repoId: options.repoId,
    sourceRevision: migration.value.sourceRevision,
    sourceFingerprint: migration.value.sourceFingerprint,
    mappingFingerprint: migration.value.mappingFingerprint,
    sqliteRevisions: {
      requirements: Object.fromEntries(requirements.map((record) => [record.key, record.revision])),
      plans: Object.fromEntries(plans.map((record) => [record.key, record.revision])),
    },
    requirementCount: requirements.length,
    planCount: plans.length,
    contentFingerprint,
    generatedFromMigrationAt: migration.value.appliedAt,
  };

  mkdirSync(dirname(outputDir), { recursive: true, mode: 0o700 });
  const staging = `${outputDir}.staging-${process.pid}-${randomBytes(4).toString('hex')}`;
  let writes = 0;
  const write = (path: string, value: unknown): void => {
    writeFileSync(path, stableJson(value), 'utf8');
    writes += 1;
    if (options.faultInjection?.failAfterWrites === writes) {
      throw new Error(`REQUIREMENT_EXPORT_FAULT_INJECTED: after_write=${writes}`);
    }
  };
  try {
    mkdirSync(join(staging, 'requirements'), { recursive: true, mode: 0o700 });
    mkdirSync(join(staging, 'plans'), { recursive: true, mode: 0o700 });
    for (const record of requirements) {
      write(join(staging, 'requirements', `${record.key}.json`), { revision: record.revision, value: record.value });
    }
    for (const record of plans) {
      write(join(staging, 'plans', `${record.key}.json`), { revision: record.revision, value: record.value });
    }
    write(join(staging, 'manifest.json'), manifest);
    publishDirectory(staging, outputDir);
    return manifest;
  } finally {
    if (existsSync(staging)) rmSync(staging, { recursive: true, force: true });
  }
}
