import { describe, expect, test } from 'bun:test';
import type { AssistantActionProposal } from '../../src/runtime/assistant/action-proposals';
import { buildMimeMessage, encodeMimeHeaderValue } from '../../src/runtime/plugins/gmail-adapter';
import type { AssistantModelAnalysis } from '../../src/runtime/assistant/model-provider';
import {
  buildDeterministicAssistantProposals,
  renderAssistantRoutineReport,
  type GmailMessageSummary,
} from '../../src/runtime/assistant/routine-runtime';

function message(overrides: Partial<GmailMessageSummary> = {}): GmailMessageSummary {
  return {
    id: 'message-1',
    from: 'offers@example.com',
    subject: 'Weekend deals',
    snippet: 'Save 30% this weekend.',
    labelIds: ['INBOX'],
    ...overrides,
  };
}

function archiveProposal(overrides: Partial<AssistantActionProposal> = {}): AssistantActionProposal {
  const timestamp = '2026-08-10T00:00:00.000Z';
  return {
    schemaVersion: 1,
    proposalId: 'proposal-1',
    routineId: 'routine-1',
    runId: 'run-1',
    pluginId: 'gmail',
    actionId: 'archive_message',
    arguments: { message_id: 'message-1' },
    evidenceMessageIds: ['message-1'],
    context: { sender: 'offers@example.com', subject: 'Weekend deals', protected: false },
    reason: 'Archive Gmail Promotions candidate: “Weekend deals”.',
    confidence: 0.98,
    risk: 'remote_write',
    executable: true,
    status: 'proposed',
    expiresAt: timestamp,
    createdAt: timestamp,
    updatedAt: timestamp,
    ...overrides,
  };
}

const rulesAnalysis: AssistantModelAnalysis = {
  schemaVersion: 1,
  usedModel: false,
  provider: 'rules',
  promptVersion: 'gmail-analysis-v1',
  importantMessageIds: [],
  proposals: [],
  analyzedMessageIds: [],
  warnings: [],
};

describe('Gmail assistant routine promotional triage', () => {
  test('treats Gmail CATEGORY_PROMOTIONS as a high-confidence archive signal', () => {
    const proposals = buildDeterministicAssistantProposals([
      message({ labelIds: ['INBOX', 'CATEGORY_PROMOTIONS'] }),
    ]);

    expect(proposals).toContainEqual(expect.objectContaining({
      pluginId: 'gmail',
      actionId: 'archive_message',
      confidence: 0.98,
      arguments: { message_id: 'message-1' },
    }));
  });

  test('never proposes archive for a protected message even in Promotions', () => {
    const proposals = buildDeterministicAssistantProposals([
      message({
        subject: 'Security alert and billing verification',
        snippet: 'Please verify your login and invoice.',
        labelIds: ['INBOX', 'CATEGORY_PROMOTIONS'],
      }),
    ]);

    expect(proposals.some((proposal) => proposal.actionId === 'archive_message')).toBe(false);
  });

  test('protects gift-card messages even when Gmail classifies them as Promotions', () => {
    const proposals = buildDeterministicAssistantProposals([
      message({
        subject: 'A friend sent you an Apple Gift Card.',
        snippet: 'Your gift card is ready to redeem.',
        labelIds: ['INBOX', 'CATEGORY_PROMOTIONS'],
      }),
    ]);

    expect(proposals.some((proposal) => proposal.actionId === 'archive_message')).toBe(false);
  });

  test('keeps the lower-confidence marketing keyword fallback', () => {
    const proposals = buildDeterministicAssistantProposals([
      message({ subject: 'Monthly newsletter', snippet: 'Unsubscribe at any time.' }),
    ]);

    expect(proposals).toContainEqual(expect.objectContaining({
      actionId: 'archive_message',
      confidence: 0.7,
    }));
  });

  test('reports promotional, archive proposal, and automatic archive counts', () => {
    const proposal = archiveProposal();
    const report = renderAssistantRoutineReport(
      [message({ labelIds: ['INBOX', 'CATEGORY_PROMOTIONS'] })],
      [proposal],
      '2026-08-09T00:00:00.000Z',
      '2026-08-10T00:00:00.000Z',
      rulesAnalysis,
      [{ grantId: 'grant-1', proposalId: proposal.proposalId, status: 'submitted', executionJobId: 'job-1' }],
    );

    expect(report).toContain('推广候选：1 封');
    expect(report).toContain('归档建议：1 项');
    expect(report).toContain('自动归档：1 项');
  });
});

describe('Gmail MIME Subject encoding', () => {
  test('keeps ASCII subjects byte-compatible and RFC 2047-encodes Unicode subjects', () => {
    expect(encodeMimeHeaderValue('Gmail morning report 2026-08-12')).toBe('Gmail morning report 2026-08-12');

    const subject = 'Gmail 晨报｜2026-08-12';
    const encoded = `=?UTF-8?B?${Buffer.from(subject, 'utf8').toString('base64')}?=`;
    expect(encodeMimeHeaderValue(subject)).toBe(encoded);

    const mime = buildMimeMessage({
      to: ['recipient@example.com'],
      subject,
      body_text: '正文内容',
    }, { accountEmail: 'sender@example.com' } as never);
    expect(mime).toContain(`Subject: ${encoded}\r\n`);
    expect(mime).toContain('Content-Type: text/plain; charset="UTF-8"');
  });

  test('folds long Unicode subjects into bounded encoded-words and rejects header injection', () => {
    const encoded = encodeMimeHeaderValue('每日晨报｜'.repeat(20));
    const words = encoded.split('\r\n ');
    expect(words.length).toBeGreaterThan(1);
    expect(words.every((word) => word.length <= 75)).toBe(true);
    expect(() => encodeMimeHeaderValue('safe\r\nBcc: attacker@example.com')).toThrow('MIME header values must not contain CR or LF');
  });
});
