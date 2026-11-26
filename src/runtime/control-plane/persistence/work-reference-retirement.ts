interface RetirementStatement {
  all(...parameters: unknown[]): unknown[];
  run(...parameters: unknown[]): unknown;
  finalize?(): void;
}

interface RetirementDatabase {
  prepare(sql: string): RetirementStatement;
}

// #483: only these historically observed namespace/schema/path combinations
// are retired. Native session, Plan, Process and effect facts stay in their
// original records, including revision and audit identity.
const RETIRED_PATHS = new Set([
  'assistant_outcome_observation:$.sourceWorkId',
  'chatgpt_controller_binding:$.workId',
  'chatgpt_controller_round_settlement:$.workId',
  'controller_home_migration:$.archivedOnly.terminalWorkContracts',
  'controller_round_relay:$.originWorkId',
  'controller_round_relay:$.predecessorWorkId',
  'controller_round_relay:$.successorWorkId',
  'controller_round_relay:$.observationWindow[].workId',
  'controller_session_binding:$.workId',
  'controller_session_claim_store:$.sessions[].workId',
  'controller_session_identity:$.session.workId',
  'execution_edit_validation_run:$.receipts[].workId',
  'execution_session:$.activeWorkId',
  'execution_session:$.goalDelegation.workId',
  'external_controller_launch_reservation:$.workId',
  'plan_contract:$.steps[].workId',
  'plan_revision:$.steps[].workId',
  'process_controller_binding:$.workId',
  'scheduler_continuation_dispatch:$.workId',
]);

const CANDIDATE_SQL = `SELECT r.rowid AS row_id, r.namespace, r.schema_version, j.fullkey AS path
  FROM control_plane_records r, json_tree(r.payload) j
  WHERE j.key IN ('workId', 'activeWorkId', 'sourceWorkId', 'originWorkId',
                  'predecessorWorkId', 'successorWorkId', 'terminalWorkContracts')
  ORDER BY r.rowid, j.fullkey`;

interface Candidate {
  row_id: number;
  namespace: string;
  schema_version: number;
  path: string;
}

function candidates(database: RetirementDatabase): Candidate[] {
  const statement = database.prepare(CANDIDATE_SQL);
  try {
    return statement.all() as Candidate[];
  } finally {
    statement.finalize?.();
  }
}

/** Only called on an exclusive, disposable backup copy inside its transaction. */
export function removeRetiredWorkReferences(database: RetirementDatabase): { recordCount: number; fieldCount: number } {
  const found = candidates(database);
  const pathsByRow = new Map<number, string[]>();
  // Validate the entire inventory before modifying even one record.
  for (const row of found) {
    const normalized = row.path.replace(/\[\d+\]/g, '[]');
    if (row.schema_version !== 1 || !RETIRED_PATHS.has(row.namespace + ':' + normalized)) {
      throw new Error('WORK_REFERENCE_RETIREMENT_UNCLASSIFIED:' + row.namespace + ':' + row.path);
    }
    const paths = pathsByRow.get(row.row_id) ?? [];
    paths.push(row.path);
    pathsByRow.set(row.row_id, paths);
  }
  for (const [rowId, paths] of pathsByRow) {
    // Remove only object fields, never array elements or entire native records.
    // One path per statement also avoids the SQLite variable-count ceiling.
    const statement = database.prepare(
      'UPDATE control_plane_records SET payload = json_remove(payload, ?) WHERE rowid = ?',
    );
    try {
      for (const path of paths) statement.run(path, rowId);
    } finally {
      statement.finalize?.();
    }
  }
  if (candidates(database).length !== 0) throw new Error('WORK_REFERENCE_RETIREMENT_RESIDUAL');
  return { recordCount: pathsByRow.size, fieldCount: found.length };
}
