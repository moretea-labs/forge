import { resolve } from 'node:path';
import { readAndEvaluateV2Certification } from './lib/certification.ts';

const path = process.argv[2];
if (!path) {
  console.error('usage: bun evaluation/check-v2-certification.ts <external-certification-manifest.json>');
  process.exit(2);
}

try {
  const result = readAndEvaluateV2Certification(resolve(path));
  console.log(JSON.stringify(result, null, 2));
  if (result.verdict !== 'go') process.exit(1);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(2);
}
