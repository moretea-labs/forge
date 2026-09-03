import { createHash } from 'crypto';
import { existsSync, readFileSync } from 'fs';
import { isAbsolute, relative, resolve, sep } from 'path';
import {
  DEFAULT_PROJECT_ENGINEERING_CONTRACT_PATH,
  validateProjectEngineeringContract,
  type ProjectEngineeringContract,
  type ProjectEngineeringContractReceipt,
} from '../../../packages/kernel/work/api/index';

export type ProjectEngineeringContractLoadResult =
  | { status: 'missing'; contractPath: string }
  | { status: 'ready'; contractPath: string; contract: ProjectEngineeringContract; receipt: ProjectEngineeringContractReceipt };

function boundedRepositoryPath(repoRoot: string, requested: string): { absolute: string; relative: string } {
  if (isAbsolute(requested)) throw new Error('PROJECT_ENGINEERING_CONTRACT_PATH_MUST_BE_REPOSITORY_RELATIVE');
  const root = resolve(repoRoot);
  const absolute = resolve(root, requested);
  const rel = relative(root, absolute).split(sep).join('/');
  if (!rel || rel.startsWith('../') || rel === '..') throw new Error('PROJECT_ENGINEERING_CONTRACT_PATH_OUTSIDE_REPOSITORY');
  return { absolute, relative: rel };
}

export function loadProjectEngineeringContract(input: {
  repoRoot: string;
  sourceRevision: string;
  contractPath?: string;
  now?: () => string;
}): ProjectEngineeringContractLoadResult {
  const sourceRevision = input.sourceRevision.trim();
  if (!sourceRevision) throw new Error('PROJECT_ENGINEERING_CONTRACT_SOURCE_REVISION_REQUIRED');
  const path = boundedRepositoryPath(input.repoRoot, input.contractPath ?? DEFAULT_PROJECT_ENGINEERING_CONTRACT_PATH);
  if (!existsSync(path.absolute)) return { status: 'missing', contractPath: path.relative };
  const raw = readFileSync(path.absolute, 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('PROJECT_ENGINEERING_CONTRACT_JSON_INVALID');
  }
  const contract = validateProjectEngineeringContract(parsed);
  return {
    status: 'ready',
    contractPath: path.relative,
    contract,
    receipt: {
      schemaVersion: 1,
      contractPath: path.relative,
      projectId: contract.projectId,
      contractId: contract.contractId,
      contractVersion: contract.contractVersion,
      sourceRevision,
      contentDigest: createHash('sha256').update(raw).digest('hex'),
      provenance: {
        source: 'repository',
        loadedAt: (input.now ?? (() => new Date().toISOString()))(),
      },
    },
  };
}
