import { expect, test } from 'bun:test';
import { spawnSync } from 'child_process';
import publishPostDraft from '../../assets/workflows/release-growth/x.publish-post.v1.draft.json' with { type: 'json' };

const validatePost = publishPostDraft.scripts.validatePost.body;

function validateAccount(account: string) {
  return spawnSync('node', ['-e', validatePost, JSON.stringify({
    account,
    text: 'TempoVela is live on the App Store.',
  })], { encoding: 'utf8' });
}

test('X publish validator accepts the visible @handle and emits the canonical bare account', () => {
  for (const account of ['greyson57569696', '@greyson57569696']) {
    const result = validateAccount(account);
    expect(result.status).toBe(0);
    const output = JSON.parse(result.stdout);
    expect(output.account).toBe('greyson57569696');
    expect(output.profile_url).toBe('https://x.com/greyson57569696');
  }
});

test('X publish validator still rejects malformed multiple-prefix handles', () => {
  const result = validateAccount('@@greyson57569696');
  expect(result.status).toBe(2);
  expect(result.stderr).toContain('X_ACCOUNT_INVALID');
});

test('all downstream account consumers use the normalized validator output', () => {
  const scriptSteps = publishPostDraft.steps.filter((step: any) => step.kind === 'script');
  const downstream = scriptSteps.filter((step: any) => step.stepId !== 'validate-post');
  expect(downstream.map((step: any) => step.input?.account)).toEqual([
    '{{output.validate-post.account}}',
    '{{output.validate-post.account}}',
    '{{output.validate-post.account}}',
    '{{output.validate-post.account}}',
  ]);
});
