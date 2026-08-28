#!/usr/bin/env bun
import { realpathSync } from 'fs';
import { resolve } from 'path';
import { assertRuntimeReleaseFiles, stageRuntimeRelease, type CandidateRuntimeStageReceiptV1 } from '../src/runtime/root/release-materialize';

function option(args: string[], name: string): string | undefined {
  const index = args.lastIndexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function requiredOption(args: string[], name: string): string {
  const value = option(args, name)?.trim();
  if (!value) throw new Error(`RUNTIME_RELEASE_CANDIDATE_OPTION_REQUIRED: ${name}`);
  return value;
}

const args = process.argv.slice(2);
const controllerHome = resolve(requiredOption(args, '--controller-home'));
const sourceRoot = resolve(requiredOption(args, '--source-root'));
const expectedHead = requiredOption(args, '--expected-head');
if (!/^[a-f0-9]{40}$/i.test(expectedHead)) throw new Error('RUNTIME_RELEASE_CANDIDATE_EXPECTED_HEAD_INVALID');
if (realpathSync(sourceRoot) !== realpathSync(process.cwd())) throw new Error('RUNTIME_RELEASE_CANDIDATE_CWD_MISMATCH');

const staged = stageRuntimeRelease({ controllerHome, sourceRoot });
assertRuntimeReleaseFiles(staged);
if (staged.sourceCommit !== expectedHead) {
  throw new Error(`RUNTIME_RELEASE_CANDIDATE_SOURCE_MISMATCH: expected ${expectedHead}, got ${staged.sourceCommit}`);
}

const receipt: CandidateRuntimeStageReceiptV1 = {
  schemaVersion: 1,
  releasePath: staged.releasePath,
  manifestPath: staged.manifestPath,
  releaseId: staged.releaseId,
  artifactIdentity: staged.artifactIdentity,
  manifestSha256: staged.manifestSha256,
  sourceCommit: staged.sourceCommit,
};
process.stdout.write(`${JSON.stringify(receipt)}\n`);
