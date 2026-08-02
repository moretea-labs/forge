import { describe, expect, test } from 'bun:test';
import {
  classifyBunTestExit,
  cleanupClosedChildProcessGroup,
  TEST_FAILURE_CODES,
  type ClosedChildProcessGroupOperations,
} from '../../scripts/run-bun-test-file';

describe('test runner state', () => {
  test('maps a non-zero Bun exit to a source failure without retry policy', () => {
    expect(classifyBunTestExit(0)).toBeUndefined();
    expect(classifyBunTestExit(1)).toEqual({
      failureClass: 'source',
      failureCode: TEST_FAILURE_CODES.SOURCE_ASSERTION_FAILED,
    });
    expect(classifyBunTestExit(1, 'TEST_FIXTURE_FAILURE')).toEqual({
      failureClass: 'fixture',
      failureCode: TEST_FAILURE_CODES.FIXTURE_OR_FLAKY_FAILED,
    });
  });

  test('does not inspect or signal a reused PID', async () => {
    let listCalls = 0;
    let terminateCalls = 0;
    const operations: ClosedChildProcessGroupOperations = {
      isProcessAlive: () => true,
      signalProcessTree: () => true,
      listProcessTreeMembers: () => {
        listCalls += 1;
        return [42, 43];
      },
      terminateProcessTree: async () => {
        terminateCalls += 1;
        return { pid: 42, signaled: true, escalated: false, exited: true, remainingPids: [] };
      },
    };

    const result = await cleanupClosedChildProcessGroup(42, 'reused-pid.test.ts', 0, operations);

    expect(result).toEqual({
      exitCode: 0,
      lingeringPids: [],
      remainingPids: [],
      pidReuseFenced: true,
    });
    expect(listCalls).toBe(0);
    expect(terminateCalls).toBe(0);
  });

  test('reports an infrastructure failure when residual cleanup does not converge', async () => {
    let aliveCalls = 0;
    let terminateCalls = 0;
    const operations: ClosedChildProcessGroupOperations = {
      isProcessAlive: () => {
        aliveCalls += 1;
        return false;
      },
      signalProcessTree: () => true,
      listProcessTreeMembers: () => [42, 43, 44],
      terminateProcessTree: async () => {
        terminateCalls += 1;
        return { pid: 42, signaled: true, escalated: true, exited: false, remainingPids: [44] };
      },
    };

    const result = await cleanupClosedChildProcessGroup(42, 'leaky.test.ts', 0, operations);

    expect(aliveCalls).toBe(2);
    expect(terminateCalls).toBe(1);
    expect(result).toEqual({
      exitCode: 1,
      lingeringPids: [43, 44],
      remainingPids: [44],
      pidReuseFenced: false,
      failureClass: 'infrastructure',
      failureCode: TEST_FAILURE_CODES.INFRA_RUNNER_DID_NOT_CONVERGE,
    });
  });
});
