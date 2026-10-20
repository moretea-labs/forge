#!/usr/bin/env node
import { createHash } from 'crypto';
import { readFileSync, rmSync, writeFileSync } from 'fs';
import { getRepository } from '../../cli/repositories/registry';
import type { AssistantPluginActionRequest } from './types';
import { PROCESS_RUNTIME_RELEASE_CANARY_ARG } from '../execution/process-runtime/canary';
import { submitAssistantPluginAction, submitControllerPluginAction } from './store';

interface Envelope {
  schemaVersion: 1;
  controllerHome: string;
  repoId?: string;
  scope?: { kind: 'controller' } | { kind: 'repository'; repoId: string };
  request: Omit<AssistantPluginActionRequest, 'signal'>;
}

function required(argv: string[], flag: string): string {
  const index = argv.indexOf(flag);
  const value = index >= 0 ? argv[index + 1]?.trim() : undefined;
  if (!value) throw new Error(`PLUGIN_ACTION_SIDECAR_USAGE: missing ${flag}`);
  return value;
}

export async function runPluginActionSidecar(argv = process.argv.slice(2)): Promise<number> {
  const requestPath = required(argv, '--request');
  const expectedSha256 = required(argv, '--expected-sha256');
  try {
    const bytes = readFileSync(requestPath, 'utf8');
    const actualSha256 = createHash('sha256').update(bytes).digest('hex');
    if (actualSha256 !== expectedSha256) {
      throw new Error('PLUGIN_ACTION_REQUEST_CHANGED: sidecar request fingerprint changed before execution');
    }
    const envelope = JSON.parse(bytes) as Envelope;
    if (envelope.schemaVersion !== 1) throw new Error('PLUGIN_ACTION_REQUEST_VERSION_UNSUPPORTED');
    const controllerScoped = envelope.scope?.kind === 'controller';
    const repoId = envelope.scope?.kind === 'repository' ? envelope.scope.repoId : envelope.repoId;
    const submitted = controllerScoped
      ? await submitControllerPluginAction(envelope.controllerHome, envelope.request)
      : await submitAssistantPluginAction(
          envelope.controllerHome,
          getRepository(repoId ?? '', envelope.controllerHome),
          envelope.request,
        );
    writeFileSync(1, `${JSON.stringify({
      ok: true,
      requestId: submitted.receipt.requestId,
      receiptId: submitted.receipt.receiptId,
      deduplicated: submitted.deduplicated,
    })}\n`);
    return 0;
  } finally {
    rmSync(requestPath, { force: true });
  }
}

if (process.argv.includes(PROCESS_RUNTIME_RELEASE_CANARY_ARG)) {
  writeFileSync(1, 'forge plugin-action sidecar release canary\n');
  process.exit(0);
}

const direct = typeof process.argv[1] === 'string' && process.argv[1].includes('plugin-action-sidecar');
if (direct) {
  void runPluginActionSidecar()
    .then((code) => { process.exit(code); })
    .catch((error) => {
      writeFileSync(2, `${error instanceof Error ? error.message : String(error)}\n`);
      process.exit(1);
    });
}
