// Compatibility import path. Persisted check execution belongs to Process Runtime
// so Scheduler reconciliation can advance validation without depending on Gateway.
export * from '../../../src/runtime/execution/process-runtime/persisted-check';
