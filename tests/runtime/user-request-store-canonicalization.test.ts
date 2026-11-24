import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listUserRequests } from '../../packages/kernel/identity/api/index';

describe('UserRequest canonicalization', () => {
  test('selects the newest duplicate and lets the later row win timestamp ties', () => {
    const root = mkdtempSync(join(tmpdir(), 'forge-user-request-canonical-order-'));
    const controllerHome = join(root, 'controller-home');
    const storePath = join(controllerHome, 'system', 'user-requests', 'requests.json');
    const base = {
      schemaVersion: 1,
      kind: 'user_decision_request',
      rootCauseKey: 'canonical-test',
      summary: 'Canonical selection fixture.',
      actionRequired: 'product_decision',
      createdAt: '2026-01-01T00:00:00.000Z',
    };

    try {
      mkdirSync(join(controllerHome, 'system', 'user-requests'), { recursive: true });
      writeFileSync(
        storePath,
        JSON.stringify({
          schemaVersion: 1,
          requests: [
            {
              ...base,
              requestId: 'duplicate',
              title: 'Older pending',
              status: 'pending',
              updatedAt: '2026-01-01T00:00:00.000Z',
            },
            {
              ...base,
              requestId: 'duplicate',
              title: 'Newer resolved',
              status: 'resolved',
              updatedAt: '2026-01-02T00:00:00.000Z',
            },
            {
              ...base,
              requestId: 'tie',
              title: 'Earlier tie',
              status: 'resolved',
              updatedAt: '2026-01-03T00:00:00.000Z',
            },
            { ...base, requestId: 'tie', title: 'Later tie', status: 'pending', updatedAt: '2026-01-03T00:00:00.000Z' },
            {
              ...base,
              requestId: 'unique',
              title: 'Unique pending',
              status: 'pending',
              updatedAt: '2026-01-04T00:00:00.000Z',
            },
          ],
        }),
      );

      const pending = listUserRequests(controllerHome, 'pending');
      expect(pending.map((request) => [request.requestId, request.title])).toEqual([
        ['unique', 'Unique pending'],
        ['tie', 'Later tie'],
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
