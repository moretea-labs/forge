import { PROCESS_RUNTIME_RELEASE_CANARY_ARG } from '../../execution/process-runtime/canary';

// Immutable standalone releases compile this wrapper as the Scheduler worker
// executable. Canary mode must terminate before the real Worker module reads
// Controller/Job arguments or binds write authority.
if (process.argv.includes(PROCESS_RUNTIME_RELEASE_CANARY_ARG)) {
  process.exit(0);
}

await import('../../execution/workers/worker-entry');
