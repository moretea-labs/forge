import type { EngineeringRiskClass, ProjectEngineeringContractReceipt } from './engineering-contracts';

export const PROJECT_ENGINEERING_CONTRACT_SCHEMA_VERSION = 1 as const;
export const DEFAULT_PROJECT_ENGINEERING_CONTRACT_PATH = '.forge/project-engineering.json' as const;
const MAX_CONTRACT_ITEMS = 128;
const MAX_TEXT = 2_000;

export interface ProjectEngineeringContractCheck {
  id: string;
  purpose?: string;
}

export interface ProjectEngineeringContractJourney {
  id: string;
  purpose: string;
  requiredFor?: EngineeringRiskClass[];
}

export interface ProjectEngineeringContractToolingRequirement {
  id: string;
  purpose?: string;
  requiredFor?: EngineeringRiskClass[];
}

export interface ProjectEngineeringContractException {
  id: string;
  scope: string;
  rationale: string;
}

/**
 * Source-controlled project facts consumed by the generic Engineering Workloop.
 * Generic language/debug/review method belongs in EngineeringWorkProfile/Skills,
 * never in this project-owned contract.
 */
export interface ProjectEngineeringContract {
  schemaVersion: 1;
  contractId: string;
  contractVersion: string;
  projectId: string;
  authority: {
    product?: string[];
    architecture?: string[];
    source?: string[];
  };
  quality: {
    ux?: string[];
    performance?: string[];
    nonRegression?: string[];
  };
  checks: ProjectEngineeringContractCheck[];
  journeys: ProjectEngineeringContractJourney[];
  platforms?: string[];
  tooling?: ProjectEngineeringContractToolingRequirement[];
  skillRefs?: string[];
  exceptions?: ProjectEngineeringContractException[];
}

function text(value: unknown, code: string): string {
  if (typeof value !== 'string') throw new Error(code);
  const normalized = value.trim();
  if (!normalized || normalized.length > MAX_TEXT) throw new Error(code);
  return normalized;
}

function stringList(value: unknown, code: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_CONTRACT_ITEMS) throw new Error(code);
  const normalized = value.map((item) => text(item, code));
  if (new Set(normalized).size !== normalized.length) throw new Error(`${code}_DUPLICATE`);
  return normalized;
}

function riskClasses(value: unknown, code: string): EngineeringRiskClass[] | undefined {
  if (value === undefined) return undefined;
  const values = stringList(value, code);
  const allowed = new Set<EngineeringRiskClass>(['low', 'normal', 'high', 'critical']);
  for (const item of values) if (!allowed.has(item as EngineeringRiskClass)) throw new Error(code);
  return values as EngineeringRiskClass[];
}

function object(value: unknown, code: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(code);
  return value as Record<string, unknown>;
}

function objectList(value: unknown, code: string): Record<string, unknown>[] {
  if (!Array.isArray(value) || value.length > MAX_CONTRACT_ITEMS) throw new Error(code);
  return value.map((item) => object(item, code));
}

export function validateProjectEngineeringContractReceipt(value: ProjectEngineeringContractReceipt): ProjectEngineeringContractReceipt {
  if (value.schemaVersion !== 1) throw new Error('PROJECT_ENGINEERING_CONTRACT_RECEIPT_SCHEMA_INVALID');
  const contractPath = text(value.contractPath, 'PROJECT_ENGINEERING_CONTRACT_RECEIPT_PATH_INVALID');
  if (contractPath.startsWith('/') || contractPath.split('/').includes('..')) throw new Error('PROJECT_ENGINEERING_CONTRACT_RECEIPT_PATH_INVALID');
  const sourceRevision = text(value.sourceRevision, 'PROJECT_ENGINEERING_CONTRACT_RECEIPT_SOURCE_INVALID');
  const contentDigest = text(value.contentDigest, 'PROJECT_ENGINEERING_CONTRACT_RECEIPT_DIGEST_INVALID');
  if (!/^[a-f0-9]{64}$/.test(contentDigest)) throw new Error('PROJECT_ENGINEERING_CONTRACT_RECEIPT_DIGEST_INVALID');
  if (value.provenance?.source !== 'repository' || !Number.isFinite(Date.parse(value.provenance.loadedAt))) {
    throw new Error('PROJECT_ENGINEERING_CONTRACT_RECEIPT_PROVENANCE_INVALID');
  }
  return {
    schemaVersion: 1,
    contractPath,
    projectId: text(value.projectId, 'PROJECT_ENGINEERING_CONTRACT_RECEIPT_PROJECT_INVALID'),
    contractId: text(value.contractId, 'PROJECT_ENGINEERING_CONTRACT_RECEIPT_CONTRACT_INVALID'),
    contractVersion: text(value.contractVersion, 'PROJECT_ENGINEERING_CONTRACT_RECEIPT_VERSION_INVALID'),
    sourceRevision,
    contentDigest,
    provenance: { source: 'repository', loadedAt: value.provenance.loadedAt },
  };
}

export function validateProjectEngineeringContract(value: unknown): ProjectEngineeringContract {
  const root = object(value, 'PROJECT_ENGINEERING_CONTRACT_INVALID');
  if (root.schemaVersion !== PROJECT_ENGINEERING_CONTRACT_SCHEMA_VERSION) {
    throw new Error('PROJECT_ENGINEERING_CONTRACT_SCHEMA_UNSUPPORTED');
  }
  const authority = object(root.authority ?? {}, 'PROJECT_ENGINEERING_CONTRACT_AUTHORITY_INVALID');
  const quality = object(root.quality ?? {}, 'PROJECT_ENGINEERING_CONTRACT_QUALITY_INVALID');
  const checks = objectList(root.checks ?? [], 'PROJECT_ENGINEERING_CONTRACT_CHECKS_INVALID').map((item) => ({
    id: text(item.id, 'PROJECT_ENGINEERING_CONTRACT_CHECK_ID_INVALID'),
    ...(item.purpose === undefined ? {} : { purpose: text(item.purpose, 'PROJECT_ENGINEERING_CONTRACT_CHECK_PURPOSE_INVALID') }),
  }));
  const journeys = objectList(root.journeys ?? [], 'PROJECT_ENGINEERING_CONTRACT_JOURNEYS_INVALID').map((item) => ({
    id: text(item.id, 'PROJECT_ENGINEERING_CONTRACT_JOURNEY_ID_INVALID'),
    purpose: text(item.purpose, 'PROJECT_ENGINEERING_CONTRACT_JOURNEY_PURPOSE_INVALID'),
    ...(item.requiredFor === undefined ? {} : { requiredFor: riskClasses(item.requiredFor, 'PROJECT_ENGINEERING_CONTRACT_JOURNEY_RISK_INVALID') }),
  }));
  const tooling = root.tooling === undefined ? [] : objectList(root.tooling, 'PROJECT_ENGINEERING_CONTRACT_TOOLING_INVALID').map((item) => ({
    id: text(item.id, 'PROJECT_ENGINEERING_CONTRACT_TOOLING_ID_INVALID'),
    ...(item.purpose === undefined ? {} : { purpose: text(item.purpose, 'PROJECT_ENGINEERING_CONTRACT_TOOLING_PURPOSE_INVALID') }),
    ...(item.requiredFor === undefined ? {} : { requiredFor: riskClasses(item.requiredFor, 'PROJECT_ENGINEERING_CONTRACT_TOOLING_RISK_INVALID') }),
  }));
  const exceptions = root.exceptions === undefined ? [] : objectList(root.exceptions, 'PROJECT_ENGINEERING_CONTRACT_EXCEPTIONS_INVALID').map((item) => ({
    id: text(item.id, 'PROJECT_ENGINEERING_CONTRACT_EXCEPTION_ID_INVALID'),
    scope: text(item.scope, 'PROJECT_ENGINEERING_CONTRACT_EXCEPTION_SCOPE_INVALID'),
    rationale: text(item.rationale, 'PROJECT_ENGINEERING_CONTRACT_EXCEPTION_RATIONALE_INVALID'),
  }));
  for (const [kind, items] of [['check', checks], ['journey', journeys], ['tooling', tooling], ['exception', exceptions]] as const) {
    const ids = items.map((item) => item.id);
    if (new Set(ids).size !== ids.length) throw new Error(`PROJECT_ENGINEERING_CONTRACT_${kind.toUpperCase()}_ID_DUPLICATE`);
  }
  return {
    schemaVersion: 1,
    contractId: text(root.contractId, 'PROJECT_ENGINEERING_CONTRACT_ID_INVALID'),
    contractVersion: text(root.contractVersion, 'PROJECT_ENGINEERING_CONTRACT_VERSION_INVALID'),
    projectId: text(root.projectId, 'PROJECT_ENGINEERING_CONTRACT_PROJECT_ID_INVALID'),
    authority: {
      product: stringList(authority.product, 'PROJECT_ENGINEERING_CONTRACT_PRODUCT_AUTHORITY_INVALID'),
      architecture: stringList(authority.architecture, 'PROJECT_ENGINEERING_CONTRACT_ARCHITECTURE_AUTHORITY_INVALID'),
      source: stringList(authority.source, 'PROJECT_ENGINEERING_CONTRACT_SOURCE_AUTHORITY_INVALID'),
    },
    quality: {
      ux: stringList(quality.ux, 'PROJECT_ENGINEERING_CONTRACT_UX_INVALID'),
      performance: stringList(quality.performance, 'PROJECT_ENGINEERING_CONTRACT_PERFORMANCE_INVALID'),
      nonRegression: stringList(quality.nonRegression, 'PROJECT_ENGINEERING_CONTRACT_NON_REGRESSION_INVALID'),
    },
    checks,
    journeys,
    platforms: stringList(root.platforms, 'PROJECT_ENGINEERING_CONTRACT_PLATFORMS_INVALID'),
    tooling,
    skillRefs: stringList(root.skillRefs, 'PROJECT_ENGINEERING_CONTRACT_SKILLS_INVALID'),
    exceptions,
  };
}
