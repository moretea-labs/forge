import { expect, test } from 'bun:test';
import { withChatgptProviderDispatchLane } from '../../adapters/chatgpt/provider-delivery';

test('account-level provider lane serializes sends without requiring serialized preparation', async () => {
  const scope = 'provider-lane-serial-test';
  const events: string[] = [];
  let enteredFirst!: () => void;
  let finishFirst!: () => void;
  const firstEntered = new Promise<void>((resolve) => { enteredFirst = resolve; });
  const firstCanDispatch = new Promise<void>((resolve) => { finishFirst = resolve; });

  events.push('conversation:prepare');
  events.push('bootstrap:prepare');
  const first = withChatgptProviderDispatchLane(scope, async () => {
    enteredFirst();
    await firstCanDispatch;
    events.push('conversation:dispatch');
    return { providerAccepted: true };
  }, (outcome) => outcome);
  await firstEntered;
  const second = withChatgptProviderDispatchLane(scope, async () => {
    events.push('bootstrap:dispatch');
    return { providerAccepted: true };
  }, (outcome) => outcome);
  await Promise.resolve();
  expect(events).toEqual(['conversation:prepare', 'bootstrap:prepare']);
  finishFirst();
  await Promise.all([first, second]);
  expect(events).toEqual(['conversation:prepare', 'bootstrap:prepare', 'conversation:dispatch', 'bootstrap:dispatch']);
});

test('an unconfirmed provider submission is not replayed by the shared lane', async () => {
  let submissions = 0;
  const result = await withChatgptProviderDispatchLane('provider-lane-unknown-no-replay-test', async () => {
    submissions++;
    return { providerAccepted: false };
  }, (outcome) => outcome);
  expect(result.providerAccepted).toBe(false);
  expect(submissions).toBe(1);
});
