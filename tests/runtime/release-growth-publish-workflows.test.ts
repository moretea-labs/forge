import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { spawnSync } from 'child_process';
import { executeWorkflow, workflowCapabilityDependencies } from '../../packages/workflow-runtime/api/index';
import { registerRepository } from '../../src/runtime/repositories/registry';
import { readWorkflowRegistryEntry } from '../../src/runtime/control-plane/persistence/workflow-registry-store';
import { callRhWorkWorkflowOperation } from '../../adapters/mcp/runtime-gateway/work-workflow-operations';
import type { MultiRepositoryMcpToolContext } from '../../adapters/mcp/multi-repository';
import {
  ensureReleaseGrowthWorkflowInstalled,
  materializedReleaseGrowthWorkflow,
  X_EFFECT_WORKFLOW_IDS,
} from '../../src/runtime/workflows/first-party/release-growth';

const homes: string[] = [];
afterEach(() => { while (homes.length) rmSync(homes.pop()!, { recursive: true, force: true }); });

function runScript(workflowId: string, scriptId: string, input: Record<string, unknown>) {
  const asset = materializedReleaseGrowthWorkflow(workflowId);
  const body = asset.scripts?.[scriptId]?.body;
  if (!body) throw new Error('SCRIPT_MISSING');
  const run = Bun.spawnSync(['node', '-e', body, JSON.stringify(input)], { stdout: 'pipe', stderr: 'pipe' });
  return {
    status: run.exitCode,
    output: new TextDecoder().decode(run.stdout),
    error: new TextDecoder().decode(run.stderr),
  };
}

const account = 'greyson57569696';
const sessionId = 'browser-session-x';
const postText = 'A practical update on shipping reliable iOS apps, with a focus on real user workflows.';
const parentId = '2096041354891874406';
const commentId = '2097000000000000001';
const replyText = 'Thanks for raising this. The release is not complete until the public storefront is verified.';

function capabilityOutput(stepId: string, mode: 'success' | 'unknown-submit' | 'unknown-composer' | 'duplicate' | 'wrong-comment-page' | 'wrong-parent' = 'success') {
  const profileUrl = 'https://x.com/' + account;
  const parentUrl = profileUrl + '/status/' + parentId;
  const commentUrl = 'https://x.com/other_user/status/' + commentId;
  const replyUrl = profileUrl + '/status/2097000000000000002';
  const ownArticle = (text: string) => ({ text: 'Greyson @' + account + ' · Nov 14 ' + text });
  const ownLink = (id: string) => ({ href: '/' + account + '/status/' + id });

  switch (stepId) {
    case 'verify-account':
      return { matched: true, observedUrl: profileUrl };
    case 'read-account':
      return { matches: [{ text: 'Greyson\n@' + account }], count: 1 };
    case 'read-existing-posts':
      return mode === 'duplicate' ? { matches: [ownArticle(postText)], count: 1 } : { matches: [], count: 0 };
    case 'read-existing-links':
      return mode === 'duplicate' ? { matches: [ownLink(parentId)], count: 1 } : { matches: [], count: 0 };
    case 'verify-composer':
      return { matched: true, observedUrl: 'https://x.com/compose/post' };
    case 'verify-submit-enabled':
      return { matched: true, observedUrl: 'https://x.com/compose/post' };
    case 'submit-post':
      return mode === 'unknown-submit'
        ? { outcome: 'outcome_unknown', error: { code: 'BROWSER_EFFECT_OUTCOME_UNKNOWN', message: 'Submit outcome is unknown.' } }
        : { outcome: 'succeeded', receiptRef: 'X-POST-EFFECT-1' };
    case 'verify-post-page':
      return { matched: true, observedUrl: profileUrl };
    case 'read-published-posts':
      return { matches: [ownArticle(postText)], count: 1 };
    case 'read-published-links':
      return { matches: [ownLink('2097000000000000003')], count: 1 };
    case 'verify-exact-post':
      return { matched: true, observedUrl: profileUrl + '/status/2097000000000000003' };
    case 'verify-comment-url':
      return mode === 'wrong-comment-page'
        ? { matched: false, observedUrl: 'https://x.com/' + 'i/flow/login' }
        : { matched: true, observedUrl: commentUrl };
    case 'read-parent':
      return mode === 'wrong-parent'
        ? { matches: [{ href: '/wrong_account/status/999' }], count: 1 }
        : { matches: [{ href: '/' + account + '/status/' + parentId }], count: 1 };
    case 'read-comment':
      return { text: 'Other User @other_user · Nov 14 The release notes were clear and useful.' };
    case 'read-own-replies-before':
      return { matches: [ownArticle('Original post text.')], count: 1 };
    case 'read-own-links-before':
      return { matches: [ownLink(parentId)], count: 1 };
    case 'open-reply-composer':
      return mode === 'unknown-composer'
        ? { outcome: 'outcome_unknown', error: { code: 'BROWSER_EFFECT_OUTCOME_UNKNOWN', message: 'Composer state is unknown.' } }
        : { outcome: 'succeeded', receiptRef: 'X-REPLY-COMPOSER-1' };
    case 'verify-reply-composer':
      return { matched: true, observedUrl: commentUrl };
    case 'submit-reply':
      return mode === 'unknown-submit'
        ? { outcome: 'outcome_unknown', error: { code: 'BROWSER_EFFECT_OUTCOME_UNKNOWN', message: 'Reply submit outcome is unknown.' } }
        : { outcome: 'succeeded', receiptRef: 'X-REPLY-EFFECT-1' };
    case 'verify-thread-after-reply':
      return { matched: true, observedUrl: commentUrl };
    case 'read-own-replies-after':
      return { matches: [ownArticle('Original post text.'), ownArticle(replyText)], count: 2 };
    case 'read-own-links-after':
      return { matches: [ownLink(parentId), ownLink('2097000000000000002')], count: 2 };
    case 'verify-exact-reply':
      return { matched: true, observedUrl: replyUrl };
    case 'verify-comment-context':
      return { matched: true, observedUrl: replyUrl };
    default:
      return {};
  }
}

async function executeAsset(
  workflowId: string,
  inputs: Record<string, string>,
  mode: 'success' | 'unknown-submit' | 'unknown-composer' | 'duplicate' | 'wrong-comment-page' | 'wrong-parent' = 'success',
) {
  const asset = materializedReleaseGrowthWorkflow(workflowId);
  const calls: string[] = [];
  const result = await executeWorkflow({
    asset,
    binding: { scopeId: 'repository:release-growth-test', runId: workflowId + '-' + mode },
    inputs,
  }, {
    executeCapability: async ({ step }) => {
      calls.push(step.stepId);
      const output = capabilityOutput(step.stepId, mode);
      if (output && typeof output === 'object' && 'outcome' in output) return output as any;
      return {
        outcome: 'succeeded' as const,
        receiptRef: 'CAP-' + step.stepId,
        output: output as Record<string, unknown>,
      };
    },
    executeScript: async ({ step, arguments: args }) => {
      const scriptRef = step.scriptRef;
      if (!scriptRef) throw new Error('SCRIPT_REF_MISSING');
      const execution = runScript(asset.workflowId, scriptRef, args);
      return execution.status === 0
        ? { outcome: 'succeeded' as const, receiptRef: 'SCRIPT-' + step.stepId, output: JSON.parse(execution.output) }
        : { outcome: 'failed' as const, receiptRef: 'SCRIPT-FAIL-' + step.stepId, error: { code: 'SCRIPT_FAIL_CLOSED', message: execution.error } };
    },
  });
  return { result, calls };
}

describe('first-party X publication and reply workflows (#652)', () => {
  test('account verification rejects another handle with the approved handle as a prefix', () => {
    for (const workflowId of Object.values(X_EFFECT_WORKFLOW_IDS)) {
      expect(runScript(workflowId, 'assertAccount', { account: 'greyson', matches: [{ text: 'Other @greyson_extra' }] }).status).not.toBe(0);
      expect(runScript(workflowId, 'assertAccount', { account: 'greyson', matches: [{ text: 'Greyson @greyson' }] }).status).toBe(0);
      expect(runScript(workflowId, 'assertAccount', { account: 'Greyson', matches: [{ text: 'Greyson @greyson' }] }).status).toBe(0);
    }
  });

  test('installs only explicit X effect workflows and scopes remote writes to click/fill', () => {
    const controllerHome = mkdtempSync(join(tmpdir(), 'forge-x-effect-workflows-'));
    homes.push(controllerHome);

    for (const [workflowId, expectedEffects] of [
      [X_EFFECT_WORKFLOW_IDS.publishPost, ['submit-post']],
      [X_EFFECT_WORKFLOW_IDS.replyToComment, ['open-reply-composer', 'submit-reply']],
    ] as const) {
      const asset = materializedReleaseGrowthWorkflow(workflowId);
      const installed = ensureReleaseGrowthWorkflowInstalled(controllerHome, workflowId);
      expect(installed.value.contentDigest).toBe(asset.contentDigest);
      expect(installed.value.bindings.map(binding => binding.capabilityId).sort()).toEqual(workflowCapabilityDependencies(asset));
      expect(installed.value.bindings.every(binding => binding.pluginId === 'browser')).toBe(true);
      const writeActions = installed.value.bindings
        .map(binding => binding.actionId)
        .filter((actionId): actionId is string => actionId === 'click' || actionId === 'fill')
        .sort();
      expect(writeActions).toEqual(['click', 'fill']);
      expect(asset.steps.filter(step => step.idempotency === 'non_idempotent').map(step => step.stepId))
        .toEqual([...expectedEffects]);
      expect(asset.steps.filter(step => step.idempotency === 'non_idempotent').every(step =>
        step.reconcileWithCapabilityId === 'browser.reconcile_effect')).toBe(true);
      expect(asset.credentialRefs).toBeUndefined();
      const repeated = ensureReleaseGrowthWorkflowInstalled(controllerHome, workflowId);
      expect(repeated.value.contentDigest).toBe(asset.contentDigest);
      expect(repeated.value.bindings).toEqual(installed.value.bindings);
    }
  });

  test('rh_work route installs both X effect assets before validating inputs', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'forge-x-effect-route-'));
    homes.push(workspace);
    const controllerHome = join(workspace, 'controller-home');
    const repoRoot = join(workspace, 'repo');
    mkdirSync(controllerHome, { recursive: true });
    mkdirSync(repoRoot, { recursive: true });

    const git = (...args: string[]) => {
      const result = spawnSync('git', ['-C', repoRoot, ...args], { encoding: 'utf8' });
      if (result.status !== 0) throw new Error(result.stderr || 'GIT_FIXTURE_FAILED');
    };
    git('init', '-b', 'main');
    git('config', 'user.name', 'Forge Test');
    git('config', 'user.email', 'forge-test@example.com');
    writeFileSync(join(repoRoot, 'README.md'), 'fixture\n');
    git('add', 'README.md');
    git('commit', '-m', 'fixture');

    const repository = registerRepository({ path: repoRoot, controllerHome, defaultBranch: 'main' });
    const context = { controllerHome } as unknown as MultiRepositoryMcpToolContext;
    for (const workflowId of Object.values(X_EFFECT_WORKFLOW_IDS)) {
      const response = await callRhWorkWorkflowOperation(context, repository, 'workflow_execute', {
        workflow_id: workflowId,
        workflow_run_id: 'route-install-' + workflowId,
        workflow_inputs: {},
      });
      const installed = readWorkflowRegistryEntry(controllerHome, { kind: 'controller' }, workflowId);
      expect(response).toBeDefined();
      expect(installed?.value.status).toBe('active');
      expect(installed?.value.contentDigest).toBe(materializedReleaseGrowthWorkflow(workflowId).contentDigest);
      expect(installed?.value.bindings.map(binding => binding.capabilityId)).toContain('browser.click');
      expect(installed?.value.bindings.map(binding => binding.capabilityId)).toContain('browser.reconcile_effect');
    }

    const targetCommentId = '2097000000000000001';
    const targetCommentUrl = 'https://x.com/other_user/status/' + targetCommentId;
    const replyInputs = { account, comment_url: targetCommentUrl };
    const wrongRun = await callRhWorkWorkflowOperation(context, repository, 'workflow_execute', {
      workflow_id: X_EFFECT_WORKFLOW_IDS.replyToComment,
      workflow_run_id: 'random-reply-run',
      workflow_inputs: replyInputs,
    });
    expect(JSON.stringify(wrongRun)).toContain('X_REPLY_WORKFLOW_RUN_ID_MUST_BIND_COMMENT');

    const canonicalRun = await callRhWorkWorkflowOperation(context, repository, 'workflow_execute', {
      workflow_id: X_EFFECT_WORKFLOW_IDS.replyToComment,
      workflow_run_id: 'x-reply-' + account + '-' + targetCommentId,
      workflow_inputs: replyInputs,
    });
    expect(JSON.stringify(canonicalRun)).not.toContain('X_REPLY_WORKFLOW_RUN_ID_MUST_BIND_COMMENT');

    const replyAsset = materializedReleaseGrowthWorkflow(X_EFFECT_WORKFLOW_IDS.replyToComment);
    expect(replyAsset.resources?.importancePolicy).toContain('substantive question');
    expect(replyAsset.resources?.workflowRunIdentityPolicy).toContain('x-reply-');
  });

  test('publish copy validation and duplicate detection fail closed', () => {
    const id = X_EFFECT_WORKFLOW_IDS.publishPost;
    const valid = runScript(id, 'validatePost', { account, text: postText });
    expect(valid.status).toBe(0);
    const prepared = JSON.parse(valid.output);
    expect(prepared.account).toBe(account);
    expect(prepared.profile_url).toBe('https://x.com/' + account);
    expect(prepared.content_digest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(runScript(id, 'validatePost', { account: 'bad/account', text: postText }).status).not.toBe(0);
    expect(runScript(id, 'validatePost', { account, text: '' }).status).not.toBe(0);

    const duplicate = runScript(id, 'assertNoDuplicate', {
      account,
      match_prefix: prepared.match_prefix,
      articles: [{ text: 'Greyson @' + account + ' · Nov 14 ' + postText }],
      links: [{ href: '/' + account + '/status/' + parentId }],
    });
    expect(duplicate.status).not.toBe(0);
    const empty = runScript(id, 'assertNoDuplicate', {
      account, match_prefix: prepared.match_prefix, articles: [], links: [],
    });
    expect(empty.status).toBe(0);
    expect(JSON.parse(empty.output)).toEqual({ checked_posts: 0 });
  });

  test('publish success produces a content-bound publication receipt; unknown submit is never replayed', async () => {
    const inputs = { account, text: postText, session_id: sessionId };
    const success = await executeAsset(X_EFFECT_WORKFLOW_IDS.publishPost, inputs);
    expect(success.result.status).toBe('succeeded');
    expect(success.result.publicationReceipt).toMatchObject({
      channel: 'x',
      account,
      postId: '2097000000000000003',
      postUrl: 'https://x.com/' + account + '/status/2097000000000000003',
      effectReceiptRef: 'X-POST-EFFECT-1',
    });
    expect(success.result.publicationReceipt?.contentDigest).toMatch(/^sha256:[a-f0-9]{64}$/);

    const unknown = await executeAsset(X_EFFECT_WORKFLOW_IDS.publishPost, inputs, 'unknown-submit');
    expect(unknown.result.status).toBe('reconcile_required');
    expect(unknown.result.reconcileStepId).toBe('submit-post');
    expect(unknown.calls).toContain('submit-post');
    expect(unknown.calls).not.toContain('open-profile-after-post');
    expect(unknown.result.publicationReceipt).toBeUndefined();

    const duplicate = await executeAsset(X_EFFECT_WORKFLOW_IDS.publishPost, inputs, 'duplicate');
    expect(duplicate.result.status).toBe('failed');
    expect(duplicate.calls).not.toContain('open-composer');
    expect(duplicate.calls).not.toContain('submit-post');
  });

  test('reply requires an exact owned parent and comment URL, then verifies the reply permalink', async () => {
    const inputs = {
      account,
      post_url: 'https://x.com/' + account + '/status/' + parentId,
      comment_url: 'https://x.com/other_user/status/' + commentId,
      comment_text: 'The release notes were clear and useful.',
      reply_text: replyText,
      session_id: sessionId,
    };
    const asset = materializedReleaseGrowthWorkflow(X_EFFECT_WORKFLOW_IDS.replyToComment);
    const valid = runScript(X_EFFECT_WORKFLOW_IDS.replyToComment, 'validateReply', inputs);
    expect(valid.status).toBe(0);
    expect(JSON.parse(valid.output)).toMatchObject({
      account,
      parent_id: parentId,
      comment_id: commentId,
      comment_author: 'other_user',
      parent_url: inputs.post_url,
      comment_url: inputs.comment_url,
    });
    expect(runScript(X_EFFECT_WORKFLOW_IDS.replyToComment, 'validateReply', {
      ...inputs, post_url: 'https://x.com/another_account/status/123',
    }).status).not.toBe(0);
    expect(runScript(X_EFFECT_WORKFLOW_IDS.replyToComment, 'validateReply', {
      ...inputs, comment_url: 'https://evil.example/status/123',
    }).status).not.toBe(0);
    expect(runScript(X_EFFECT_WORKFLOW_IDS.replyToComment, 'validateReply', {
      ...inputs, comment_text: 'x'.repeat(281),
    }).status).not.toBe(0);
    expect(runScript(X_EFFECT_WORKFLOW_IDS.replyToComment, 'validateReply', {
      ...inputs, comment_url: inputs.post_url,
    }).status).not.toBe(0);
    expect(runScript(X_EFFECT_WORKFLOW_IDS.replyToComment, 'validateReply', {
      ...inputs, comment_url: 'https://x.com/' + account + '/status/' + commentId,
    }).status).not.toBe(0);
    const prepared = JSON.parse(valid.output);
    expect(runScript(X_EFFECT_WORKFLOW_IDS.replyToComment, 'assertParent', {
      matches: [], parent_status_href: prepared.parent_status_href,
    }).status).not.toBe(0);
    expect(runScript(X_EFFECT_WORKFLOW_IDS.replyToComment, 'assertComment', {
      article_text: 'Other User @other_user · Nov 14 The release notes were clear and useful.',
      comment_text: inputs.comment_text, comment_author: 'other_user', comment_id: prepared.comment_id,
    }).status).toBe(0);
    expect(runScript(X_EFFECT_WORKFLOW_IDS.replyToComment, 'assertComment', {
      article_text: 'Other User @different_user · Nov 14 The release notes were clear and useful.',
      comment_text: inputs.comment_text, comment_author: 'other_user', comment_id: prepared.comment_id,
    }).status).not.toBe(0);
    expect(runScript(X_EFFECT_WORKFLOW_IDS.replyToComment, 'assertCommentUrl', {
      expected_url: inputs.comment_url, matched: true, observed_url: inputs.comment_url,
    }).status).toBe(0);
    expect(runScript(X_EFFECT_WORKFLOW_IDS.replyToComment, 'assertCommentUrl', {
      expected_url: inputs.comment_url, matched: false, observed_url: 'https://x.com/' + 'i/flow/login',
    }).status).not.toBe(0);
    expect(asset.steps.find(step => step.stepId === 'read-comment')).toMatchObject({
      capabilityId: 'browser.get_text', input: { max_chars: 5000 },
    });
    expect(runScript(X_EFFECT_WORKFLOW_IDS.replyToComment, 'assertNoDuplicateReply', {
      account,
      reply_prefix: prepared.reply_prefix,
      articles: [{ text: 'Greyson @' + account + ' · Nov 14 ' + replyText }],
      links: [{ href: '/' + account + '/status/2097000000000000002' }],
    }).status).not.toBe(0);
    expect(asset.publication).toBeUndefined();

    const wrongPage = await executeAsset(X_EFFECT_WORKFLOW_IDS.replyToComment, inputs, 'wrong-comment-page');
    expect(wrongPage.result.status).toBe('failed');
    expect(wrongPage.calls).not.toContain('read-parent');
    expect(wrongPage.calls).not.toContain('open-reply-composer');

    const wrongParent = await executeAsset(X_EFFECT_WORKFLOW_IDS.replyToComment, inputs, 'wrong-parent');
    expect(wrongParent.result.status).toBe('failed');
    expect(wrongParent.calls).not.toContain('open-reply-composer');

    const success = await executeAsset(X_EFFECT_WORKFLOW_IDS.replyToComment, inputs);
    expect(success.result.status).toBe('succeeded');
    expect(success.result.outputs['finalize-reply']).toMatchObject({
      reply_id: '2097000000000000002',
      reply_url: 'https://x.com/' + account + '/status/2097000000000000002',
      parent_url: inputs.post_url,
      comment_url: inputs.comment_url,
    });

    const unknownComposer = await executeAsset(X_EFFECT_WORKFLOW_IDS.replyToComment, inputs, 'unknown-composer');
    expect(unknownComposer.result.status).toBe('reconcile_required');
    expect(unknownComposer.result.reconcileStepId).toBe('open-reply-composer');
    expect(unknownComposer.calls).not.toContain('fill-reply-composer');
    expect(unknownComposer.calls).not.toContain('submit-reply');

    const unknownSubmit = await executeAsset(X_EFFECT_WORKFLOW_IDS.replyToComment, inputs, 'unknown-submit');
    expect(unknownSubmit.result.status).toBe('reconcile_required');
    expect(unknownSubmit.result.reconcileStepId).toBe('submit-reply');
    expect(unknownSubmit.calls).not.toContain('open-comment-after-reply');
  });
});
