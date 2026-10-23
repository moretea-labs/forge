import { describe, test, expect } from 'bun:test';
import {
  createBatchContext,
  queueWrite,
  getBatchWrites,
  completeBatch,
  batchInsert,
  batchUpdate,
  batchDelete,
  isBatchActive,
  getBatchStats,
  resetBatchStats,
} from '../../src/runtime/control-plane/persistence/batch-writes';

describe('BatchWrites', () => {
  describe('createBatchContext', () => {
    test('creates active batch context', () => {
      const batch = createBatchContext();

      expect(batch.isActive).toBe(true);
      expect(batch.writes).toEqual([]);
      expect(batch.executeCount).toBe(0);
    });
  });

  describe('queueWrite', () => {
    test('queues write operations', () => {
      const batch = createBatchContext();

      queueWrite(batch, {
        type: 'insert',
        table: 'test_table',
        data: { id: 1, name: 'test' },
      });

      expect(batch.writes.length).toBe(1);
      expect(batch.writes[0].type).toBe('insert');
    });

    test('throws error on inactive batch', () => {
      const batch = createBatchContext();
      completeBatch(batch, 0);

      expect(() => {
        queueWrite(batch, {
          type: 'insert',
          table: 'test_table',
          data: { id: 1 },
        });
      }).toThrow('BATCH_NOT_ACTIVE');
    });
  });

  describe('batchInsert', () => {
    test('queues insert operation', () => {
      const batch = createBatchContext();

      batchInsert(batch, 'users', { id: 1, name: 'Alice' });

      const writes = getBatchWrites(batch);
      expect(writes.length).toBe(1);
      expect(writes[0]).toEqual({
        type: 'insert',
        table: 'users',
        data: { id: 1, name: 'Alice' },
      });
    });

    test('handles undefined batch gracefully', () => {
      expect(() => {
        batchInsert(undefined, 'users', { id: 1 });
      }).not.toThrow();
    });
  });

  describe('batchUpdate', () => {
    test('queues update operation', () => {
      const batch = createBatchContext();

      batchUpdate(batch, 'users', { name: 'Bob' }, { id: 1 });

      const writes = getBatchWrites(batch);
      expect(writes.length).toBe(1);
      expect(writes[0]).toEqual({
        type: 'update',
        table: 'users',
        data: { name: 'Bob' },
        where: { id: 1 },
      });
    });
  });

  describe('batchDelete', () => {
    test('queues delete operation', () => {
      const batch = createBatchContext();

      batchDelete(batch, 'users', { id: 1 });

      const writes = getBatchWrites(batch);
      expect(writes.length).toBe(1);
      expect(writes[0]).toEqual({
        type: 'delete',
        table: 'users',
        where: { id: 1 },
      });
    });
  });

  describe('getBatchWrites', () => {
    test('returns copy of writes', () => {
      const batch = createBatchContext();

      batchInsert(batch, 'users', { id: 1 });
      const writes1 = getBatchWrites(batch);

      batchInsert(batch, 'users', { id: 2 });
      const writes2 = getBatchWrites(batch);

      expect(writes1.length).toBe(1);
      expect(writes2.length).toBe(2);
    });
  });

  describe('completeBatch', () => {
    test('marks batch as completed', () => {
      const batch = createBatchContext();

      batchInsert(batch, 'users', { id: 1 });
      batchInsert(batch, 'users', { id: 2 });

      completeBatch(batch, 2);

      expect(batch.isActive).toBe(false);
      expect(batch.executeCount).toBe(2);
    });
  });

  describe('isBatchActive', () => {
    test('returns true for active batch', () => {
      const batch = createBatchContext();
      expect(isBatchActive(batch)).toBe(true);
    });

    test('returns false for completed batch', () => {
      const batch = createBatchContext();
      completeBatch(batch, 0);
      expect(isBatchActive(batch)).toBe(false);
    });

    test('returns false for undefined batch', () => {
      expect(isBatchActive(undefined)).toBe(false);
    });
  });

  describe('statistics', () => {
    test('tracks batch statistics', () => {
      resetBatchStats();

      const batch1 = createBatchContext();
      batchInsert(batch1, 'users', { id: 1 });
      batchInsert(batch1, 'users', { id: 2 });
      completeBatch(batch1, 2);

      const batch2 = createBatchContext();
      batchInsert(batch2, 'posts', { id: 1 });
      completeBatch(batch2, 1);

      const stats = getBatchStats();
      expect(stats.batchCount).toBe(2);
      expect(stats.writeCount).toBe(3);
      expect(stats.savedMs).toBeGreaterThan(0);
    });

    test('calculates time savings', () => {
      resetBatchStats();

      const batch = createBatchContext();
      for (let i = 0; i < 10; i++) {
        batchInsert(batch, 'users', { id: i });
      }
      completeBatch(batch, 10);

      const stats = getBatchStats();
      // 10 individual writes would take ~20ms (10 × 2ms)
      // 1 batch write takes ~2ms
      // Savings: 18ms
      expect(stats.savedMs).toBe(18);
    });
  });
});
