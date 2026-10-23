import { expect, test } from 'bun:test';
import { withChatgptProviderDispatchLane } from '../../adapters/chatgpt/provider-delivery';

/**
 * Supervisor sends and bootstraps both use this single existing account lane.
 * Hold the lane from prepare until the dispatch outcome; a second task must
 * never modify the shared editor during the first task's preparation.
 */
test('Supervisor conversation send and bootstrap execute prepare through dispatch serially', async () => {
  const scope = 'supervisor-prepare-send-serial-test';
  const events: string[] = [];
  let enteredFirst!: () => void;
  let finishFirst!: () => void;
  const firstEntered = new Promise<void>((resolve) => { enteredFirst = resolve; });
  const firstCanDispatch = new Promise<void>((resolve) => { finishFirst = resolve; });

  const first = withChatgptProviderDispatchLane(scope, async () => {
    events.push('conversation:prepare');
    enteredFirst();
    await firstCanDispatch;
    events.push('conversation:dispatch');
    return { providerAccepted: true };
  }, (outcome) => outcome);
  await firstEntered;

  const second = withChatgptProviderDispatchLane(scope, async () => {
    events.push('bootstrap:prepare');
    events.push('bootstrap:dispatch');
    return { providerAccepted: true };
  }, (outcome) => outcome);
  await Promise.resolve();
  expect(events).toEqual(['conversation:prepare']);
  finishFirst();
  await Promise.all([first, second]);
  expect(events).toEqual([
    'conversation:prepare',
    'conversation:dispatch',
    'bootstrap:prepare',
    'bootstrap:dispatch',
  ]);
});

test('an unconfirmed provider submission is not replayed by the shared lane', async () => {
  let submissions = 0;
  const result = await withChatgptProviderDispatchLane('supervisor-unknown-no-replay-test', async () => {
    submissions++;
    return { providerAccepted: false };
  }, (outcome) => outcome);
  expect(result.providerAccepted).toBe(false);
  expect(submissions).toBe(1);
});
