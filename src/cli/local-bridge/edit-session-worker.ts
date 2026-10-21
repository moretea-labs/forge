/** Local Bridge editing runs off-thread while its caller retains the single repository lock. */
import { isMainThread, parentPort, workerData, Worker } from 'worker_threads';
import { fileURLToPath } from 'url';
import { finalizeEditSession, rollbackEditSession, type EditSession } from '../editing/edit-session';

export type EditSessionWorkerInput =
  | { kind: 'finalize'; repoRoot: string; sessionId: string; reviewer: string; note?: string }
  | { kind: 'rollback'; repoRoot: string; sessionId: string; toRevision?: number; savepoint?: string };
type Reply = { ok: true; session: EditSession } | { ok: false; message: string };

export function runEditSessionMutationInWorker(input: EditSessionWorkerInput): Promise<EditSession> {
  return new Promise((resolve, reject) => {
    let worker: Worker;
    try {
      worker = new Worker(fileURLToPath(import.meta.url), { workerData: input });
    } catch (error) {
      reject(error);
      return;
    }
    let settled = false;
    worker.once('message', (reply: Reply) => {
      if (settled) return;
      settled = true;
      if (reply.ok) resolve(reply.session);
      else reject(new Error(reply.message));
    });
    const unknown = (cause: string) => {
      if (settled) return;
      settled = true;
      reject(new Error(`EDIT_SESSION_MUTATION_OUTCOME_UNKNOWN: ${cause}; inspect durable session before retry`));
    };
    worker.once('error', (error) => unknown(error instanceof Error ? error.message : String(error)));
    worker.once('exit', (code) => unknown(`worker exited ${code} before result`));
  });
}

if (!isMainThread && parentPort) {
  const input = workerData as EditSessionWorkerInput;
  try {
    const session = input.kind === 'finalize'
      ? finalizeEditSession(input.repoRoot, input.sessionId, { reviewer: input.reviewer, note: input.note })
      : rollbackEditSession(input.repoRoot, input.sessionId, { toRevision: input.toRevision, savepoint: input.savepoint });
    parentPort.postMessage({ ok: true, session } satisfies Reply);
  } catch (error) {
    parentPort.postMessage({ ok: false, message: error instanceof Error ? error.message : String(error) } satisfies Reply);
  }
}
