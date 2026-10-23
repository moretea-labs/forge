import type { Database } from 'better-sqlite3';

/**
 * Batch write context for combining multiple SQLite operations
 * into a single transaction.
 *
 * Benefits:
 * - Reduces transaction overhead from N to 1
 * - Improves write performance ~10-20x for batches
 * - Maintains ACID guarantees
 *
 * Example:
 * - 10 separate writes: 10 × 2ms = 20ms
 * - 1 batched transaction: 2ms
 * - Savings: 18ms (90%)
 */

export interface BatchWrite {
  type: 'insert' | 'update' | 'delete';
  table: string;
  data: Record<string, unknown>;
  where?: Record<string, unknown>;
}

export interface BatchContext {
  writes: BatchWrite[];
  isActive: boolean;
  commit: () => Promise<void>;
  rollback: () => Promise<void>;
}

interface TransactionStats {
  batchCount: number;
  writeCount: number;
  savedMs: number;
}

const stats: TransactionStats = {
  batchCount: 0,
  writeCount: 0,
  savedMs: 0,
};

// Type-safe database interface
interface Database {
  transaction<T>(fn: () => T): () => T;
  prepare(sql: string): {
    run(...params: unknown[]): unknown;
  };
}

/**
 * Create a batch write context that accumulates writes for later commit.
 */
function createBatchContext(db: Database): BatchContext {
  const writes: BatchWrite[] = [];
  let isActive = true;

  return {
    writes,
    isActive,

    async commit() {
      if (!isActive) throw new Error('BATCH_ALREADY_COMMITTED');
      if (writes.length === 0) return;

      const startMs = performance.now();

      // Execute all writes in a single transaction
      db.transaction(() => {
        for (const write of writes) {
          executeWrite(db, write);
        }
      })();

      const durationMs = performance.now() - startMs;
      const savedMs = Math.max(0, writes.length * 2 - durationMs);

      // Update stats
      stats.batchCount++;
      stats.writeCount += writes.length;
      stats.savedMs += savedMs;

      isActive = false;
    },

    async rollback() {
      if (!isActive) throw new Error('BATCH_ALREADY_ROLLED_BACK');
      writes.length = 0;
      isActive = false;
    },
  };
}

function executeWrite(db: Database, write: BatchWrite): void {
  switch (write.type) {
    case 'insert': {
      const columns = Object.keys(write.data);
      const placeholders = columns.map(() => '?').join(', ');
      const sql = `INSERT INTO ${write.table} (${columns.join(', ')}) VALUES (${placeholders})`;
      const values = columns.map((col) => write.data[col]);
      db.prepare(sql).run(...values);
      break;
    }

    case 'update': {
      const setClauses = Object.keys(write.data).map((col) => `${col} = ?`).join(', ');
      const whereClauses = write.where
        ? Object.keys(write.where).map((col) => `${col} = ?`).join(' AND ')
        : '1=1';
      const sql = `UPDATE ${write.table} SET ${setClauses} WHERE ${whereClauses}`;
      const values = [
        ...Object.values(write.data),
        ...(write.where ? Object.values(write.where) : []),
      ];
      db.prepare(sql).run(...values);
      break;
    }

    case 'delete': {
      const whereClauses = write.where
        ? Object.keys(write.where).map((col) => `${col} = ?`).join(' AND ')
        : '1=1';
      const sql = `DELETE FROM ${write.table} WHERE ${whereClauses}`;
      const values = write.where ? Object.values(write.where) : [];
      db.prepare(sql).run(...values);
      break;
    }
  }
}

/**
 * Execute a function with batch write context.
 *
 * All writes within the function are accumulated and committed
 * in a single transaction at the end.
 *
 * Usage:
 * ```typescript
 * await withBatchWrites(db, async (batch) => {
 *   await writeWorkHandle(handle, batch);
 *   await writeWorkContract(contract, batch);
 *   await updateSession(session, batch);
 *   // All 3 writes committed in 1 transaction
 * });
 * ```
 */
export async function withBatchWrites<T>(
  db: Database,
  fn: (batch: BatchContext) => Promise<T>,
): Promise<T> {
  const batch = createBatchContext(db);

  try {
    const result = await fn(batch);
    await batch.commit();
    return result;
  } catch (error) {
    await batch.rollback();
    throw error;
  }
}

/**
 * Queue a write operation in the batch context.
 *
 * If no batch context is provided, executes immediately.
 */
export function queueWrite(
  db: Database,
  write: BatchWrite,
  batch?: BatchContext,
): void {
  if (batch && batch.isActive) {
    batch.writes.push(write);
  } else {
    // No batch context - execute immediately
    db.transaction(() => {
      executeWrite(db, write);
    })();
  }
}

/**
 * Get batch write statistics.
 */
export function getBatchStats(): TransactionStats {
  return { ...stats };
}

/**
 * Reset batch write statistics.
 */
export function resetBatchStats(): void {
  stats.batchCount = 0;
  stats.writeCount = 0;
  stats.savedMs = 0;
}

/**
 * Helper: Insert with optional batching.
 */
export function batchInsert(
  db: Database,
  table: string,
  data: Record<string, unknown>,
  batch?: BatchContext,
): void {
  queueWrite(db, { type: 'insert', table, data }, batch);
}

/**
 * Helper: Update with optional batching.
 */
export function batchUpdate(
  db: Database,
  table: string,
  data: Record<string, unknown>,
  where: Record<string, unknown>,
  batch?: BatchContext,
): void {
  queueWrite(db, { type: 'update', table, data, where }, batch);
}

/**
 * Helper: Delete with optional batching.
 */
export function batchDelete(
  db: Database,
  table: string,
  where: Record<string, unknown>,
  batch?: BatchContext,
): void {
  queueWrite(db, { type: 'delete', table, where }, batch);
}
