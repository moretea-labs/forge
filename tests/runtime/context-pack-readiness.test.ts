import { afterEach, expect, test } from 'bun:test';
import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { buildControllerContextPack, buildControllerContextPackAsync, type ControllerContextPackOptions } from '../../src/cli/controller/context-pack';
import { getMcpPolicy } from '../../adapters/mcp/policy';
import { exactCodeOwnerEvidence, exactCodeOwnerQueries } from '../../src/cli/controller/context/source-materializer';

const roots: string[] = [];
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });

test('marks exact-known evidence incomplete when an authored required symbol is not materialized', () => {
  const root = mkdtempSync(join(tmpdir(), 'forge-context-exact-known-'));
  roots.push(root);
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'context@example.test'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'Context Test'], { cwd: root });
  mkdirSync(join(root, 'src'), { recursive: true });
  const lines = Array.from({ length: 80 }, (_, index) => `export const ENTRY_MARKER_${index} = 'ENTRY_MARKER';`);
  writeFileSync(join(root, 'src/exact.ts'), `${lines.join('\n')}\n`);
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['commit', '-qm', 'fixture'], { cwd: root });

  const pack = buildControllerContextPack(root, getMcpPolicy('controller'), {
    description: 'Inspect ENTRY_MARKER and MissingOwner in the exact known implementation file.',
    searchTerms: ['ENTRY_MARKER', 'MissingOwner'],
    knownPaths: ['src/exact.ts'],
    retrievalMode: 'implementation',
    structuralContext: 'off',
    maxFiles: 1,
    maxSnippets: 4,
  });

  expect(pack.search.truncated).toBe(true);
  expect(pack.search.evidenceTruncated).toBe(true);
  expect(pack.coverage.exactKnownPaths).toEqual({ requested: ['src/exact.ts'], materialized: ['src/exact.ts'], missing: [] });
  expect(pack.coverage.materialization.completeFiles).toBeGreaterThan(0);
  expect(pack.readiness.retrieval).toMatchObject({ searchTruncated: true, omittedCandidateCount: 0, policyDeniedCandidateCount: 0, likelyRelatedNotInspectedCount: 0 });
  expect(pack.readiness.unresolvedReasonCodes).toContain('retrieval_truncated');
  expect(pack.readiness.unresolvedReasonCodes).toContain('required_symbol_not_materialized');
  expect(pack.readiness.status).toBe('degraded');
  expect(pack.readiness.readyForHighConfidenceMutation).toBe(false);
});


test('recovers late owners and requires emitted owner evidence before accepting exact-known materialization', () => {
  const root = mkdtempSync(join(tmpdir(), 'forge-context-exact-window-'));
  roots.push(root);
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'context@example.test'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'Context Test'], { cwd: root });
  mkdirSync(join(root, 'src'), { recursive: true });
  const lines = [
    ...Array.from({ length: 45 }, (_, index) => `export const PRE_${index} = ${index};`),
    ...Array.from({ length: 80 }, (_, index) => `export function WINDOW_MARKER_${index}() { return 'WINDOW_MARKER'; }`),
    ...Array.from({ length: 45 }, (_, index) => `export const POST_${index} = ${index};`),
  ];
  const saturatedLines = [
    'export function alphaOwner() { return true; }',
    ...Array.from({ length: 170 }, () => 'alphaOwner();'),
    'export function betaMethod() { return true; }',
  ];
  const lateOwnerLines = [
    ...Array.from({ length: 170 }, () => 'alphaOwner();'),
    'export function alphaOwner() { return true; }',
  ];
  const lateMethodOwnerLines = [
    ...Array.from({ length: 170 }, () => 'betaMethod();'),
    'export class Service {',
    '  async betaMethod(',
    '    value: { id: string; count: number },',
    '  ): Promise<{ ok: boolean; count: number }> { return { ok: true, count: 1 }; }',
    '}',
  ];
  const methodOwnerLines = [
    'export class Service {',
    '  async betaMethod(',
    '    value: string,',
    '  ): Promise<boolean> { return value.length > 0; }',
    '}',
  ];
  const objectOwnerLines = [
    'export const service = {',
    '  readValue(',
    '    value: { name: string; active: boolean },',
    '  ): { name: string; active: boolean } { return value; },',
    '};',
  ];
  const arrowOwnerLines = [
    'export class Service {',
    '  readValue = (',
    '    value: { id: string; count: number },',
    '  ): { id: string; count: number } => value;',
    '}',
  ];
  writeFileSync(join(root, 'src/exact-window.ts'), `${lines.join('\n')}\n`);
  writeFileSync(join(root, 'src/saturated.ts'), `${saturatedLines.join('\n')}\n`);
  writeFileSync(join(root, 'src/late-owner.ts'), `${lateOwnerLines.join('\n')}\n`);
  writeFileSync(join(root, 'src/late-method-owner.ts'), `${lateMethodOwnerLines.join('\n')}\n`);
  writeFileSync(join(root, 'src/method-owner.ts'), `${methodOwnerLines.join('\n')}\n`);
  writeFileSync(join(root, 'src/object-owner.ts'), `${objectOwnerLines.join('\n')}\n`);
  writeFileSync(join(root, 'src/arrow-owner.ts'), `${arrowOwnerLines.join('\n')}\n`);
  const multiRequiredLines = [
    ...Array.from({ length: 170 }, () => 'alphaOwner();'),
    ...Array.from({ length: 170 }, () => 'betaMethod();'),
    ...Array.from({ length: 170 }, () => 'gammaHandler();'),
    'export function alphaOwner() { return true; }',
    'export function betaMethod() { return true; }',
    'export function gammaHandler() { return true; }',
  ];
  const multiRequiredCompleteLines = [
    'export function alphaOwner() { return true; }',
    'export function betaMethod() { return true; }',
    'export function gammaHandler() { return true; }',
  ];
  const caseLabelOwnerLines = [
    ...Array.from({ length: 170 }, () => 'gammaHandler();'),
    'function dispatch(kind: string) {',
    '  switch (kind) {',
    "    case 'gammaHandler': return true;",
    '  }',
    '}',
    ...Array.from({ length: 80 }, (_, index) => 'const CASE_LABEL_PAD_' + index + ' = ' + index + ';'),
    'export function gammaHandler() { return true; }',
  ];
  const commentOnlyOwnerLines = [
    '/*',
    'function commentOnlyOwner() { return true; }',
    '*/',
    ...Array.from({ length: 170 }, () => 'commentOnlyOwner();'),
  ];
  const commentBeforeRealOwnerLines = [
    '/*',
    'function commentThenRealOwner() { return true; }',
    '*/',
    ...Array.from({ length: 170 }, () => 'commentThenRealOwner();'),
    'export function commentThenRealOwner() { return true; }',
  ];
  const templateOnlyOwnerLines = [
    'const example = ' + String.fromCharCode(96),
    'function templateOnlyOwner() { return true; }',
    String.fromCharCode(96) + ';',
    ...Array.from({ length: 170 }, () => 'templateOnlyOwner();'),
  ];
  const templateBeforeRealOwnerLines = [
    'const example = ' + String.fromCharCode(96),
    'function templateThenRealOwner() { return true; }',
    String.fromCharCode(96) + ';',
    ...Array.from({ length: 170 }, () => 'templateThenRealOwner();'),
    'export function templateThenRealOwner() { return true; }',
  ];
  writeFileSync(join(root, 'src/multi-required.ts'), `${multiRequiredLines.join('\n')}\n`);
  writeFileSync(join(root, 'src/multi-required-complete.ts'), `${multiRequiredCompleteLines.join('\n')}\n`);
  writeFileSync(join(root, 'src/case-label-owner.ts'), `${caseLabelOwnerLines.join('\n')}\n`);
  writeFileSync(join(root, 'src/comment-only-owner.ts'), commentOnlyOwnerLines.join('\n') + '\n');
  writeFileSync(join(root, 'src/comment-before-real-owner.ts'), commentBeforeRealOwnerLines.join('\n') + '\n');
  writeFileSync(join(root, 'src/template-only-owner.ts'), templateOnlyOwnerLines.join('\n') + '\n');
  writeFileSync(join(root, 'src/template-before-real-owner.ts'), templateBeforeRealOwnerLines.join('\n') + '\n');
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['commit', '-qm', 'fixture'], { cwd: root });

  const pack = buildControllerContextPack(root, getMcpPolicy('controller'), {
    description: 'Inspect alphaOwner and betaMethod in the exact known implementation file.',
    searchTerms: ['alphaOwner', 'betaMethod'],
    knownPaths: ['src/saturated.ts'],
    retrievalMode: 'implementation',
    structuralContext: 'off',
    maxFiles: 1,
    maxSnippets: 2,
    maxCharsPerSnippet: 2400,
  });

  expect(pack.search.truncated).toBe(true);
  expect(pack.files[0]?.snippets.length).toBeGreaterThan(0);
  expect(pack.files[0]?.snippets.every((snippet) => !snippet.truncated)).toBe(true);
  expect(pack.files[0]?.snippets.some((snippet) => snippet.content.includes('alphaOwner'))).toBe(true);
  expect(pack.files[0]?.snippets.some((snippet) => snippet.content.includes('betaMethod'))).toBe(true);
  expect(pack.search.evidenceTruncated).toBe(false);
  expect(pack.readiness.unresolvedReasonCodes).not.toContain('required_symbol_not_materialized');
  // Implementation retrieval is lexical by default: it must not launch a
  // second TypeScript compiler sidecar just to bound ordinary source windows.
  expect(pack.files[0]?.snippets.every((snippet) => snippet.materialization === 'line_window')).toBe(true);
  const reviewed = buildControllerContextPack(root, getMcpPolicy('controller'), {
    description: 'Inspect WINDOW_MARKER_0 in the exact known implementation file.',
    searchTerms: ['WINDOW_MARKER_0'],
    knownPaths: ['src/exact-window.ts'],
    retrievalMode: 'review',
    structuralContext: 'off',
    maxFiles: 1,
    maxSnippets: 2,
    maxCharsPerSnippet: 2400,
  });
  expect(reviewed.files[0]?.snippets.some((snippet) => snippet.materialization === 'symbol')).toBe(true);
  expect(pack.readiness.unresolvedReasonCodes).not.toContain('retrieval_truncated');
  expect(pack.readiness.status).toBe('ready');
  expect(pack.readiness.readyForHighConfidenceMutation).toBe(true);

  const lateOwnerPack = buildControllerContextPack(root, getMcpPolicy('controller'), {
    description: 'Inspect alphaOwner after a dense reference block in the exact known implementation file.',
    searchTerms: ['alphaOwner'],
    knownPaths: ['src/late-owner.ts'],
    retrievalMode: 'implementation',
    structuralContext: 'off',
    maxFiles: 1,
    maxSnippets: 1,
    maxCharsPerSnippet: 2400,
  });
  expect(lateOwnerPack.files[0]?.snippets.some((snippet) => snippet.content.includes('export function alphaOwner'))).toBe(true);
  expect(lateOwnerPack.readiness.unresolvedReasonCodes).not.toContain('required_symbol_not_materialized');
  expect(lateOwnerPack.readiness.status).toBe('ready');
  expect(lateOwnerPack.readiness.readyForHighConfidenceMutation).toBe(true);

  const lateMethodOwnerPack = buildControllerContextPack(root, getMcpPolicy('controller'), {
    description: 'Inspect betaMethod after a dense reference block in the exact known implementation file.',
    searchTerms: ['betaMethod'],
    knownPaths: ['src/late-method-owner.ts'],
    retrievalMode: 'implementation',
    structuralContext: 'off',
    maxFiles: 1,
    maxSnippets: 1,
    maxCharsPerSnippet: 2400,
  });
  expect(lateMethodOwnerPack.files[0]?.snippets.some((snippet) => snippet.content.includes('betaMethod('))).toBe(true);
  expect(lateMethodOwnerPack.readiness.unresolvedReasonCodes).not.toContain('required_symbol_not_materialized');
  expect(lateMethodOwnerPack.readiness.status).toBe('ready');
  expect(lateMethodOwnerPack.readiness.readyForHighConfidenceMutation).toBe(true);

  const methodOwnerPack = buildControllerContextPack(root, getMcpPolicy('controller'), {
    description: 'Inspect betaMethod in the exact known implementation file.',
    searchTerms: ['betaMethod'],
    knownPaths: ['src/method-owner.ts'],
    retrievalMode: 'implementation',
    structuralContext: 'off',
    maxFiles: 1,
    maxSnippets: 1,
    maxCharsPerSnippet: 2400,
  });
  expect(methodOwnerPack.files[0]?.snippets.some((snippet) => snippet.content.includes('betaMethod('))).toBe(true);
  expect(methodOwnerPack.readiness.unresolvedReasonCodes).not.toContain('required_symbol_not_materialized');
  expect(methodOwnerPack.readiness.status).toBe('ready');
  expect(methodOwnerPack.readiness.readyForHighConfidenceMutation).toBe(true);

  const objectOwnerPack = buildControllerContextPack(root, getMcpPolicy('controller'), {
    description: 'Inspect readValue in the exact known implementation file.',
    searchTerms: ['readValue'],
    knownPaths: ['src/object-owner.ts'],
    retrievalMode: 'implementation',
    structuralContext: 'off',
    maxFiles: 1,
    maxSnippets: 1,
    maxCharsPerSnippet: 2400,
  });
  expect(objectOwnerPack.files[0]?.snippets.some((snippet) => snippet.content.includes('readValue('))).toBe(true);
  expect(objectOwnerPack.readiness.unresolvedReasonCodes).not.toContain('required_symbol_not_materialized');
  expect(objectOwnerPack.readiness.status).toBe('ready');
  expect(objectOwnerPack.readiness.readyForHighConfidenceMutation).toBe(true);

  const arrowOwnerPack = buildControllerContextPack(root, getMcpPolicy('controller'), {
    description: 'Inspect readValue arrow property with a multiline inline object type in the exact known implementation file.',
    searchTerms: ['readValue'],
    knownPaths: ['src/arrow-owner.ts'],
    retrievalMode: 'implementation',
    structuralContext: 'off',
    maxFiles: 1,
    maxSnippets: 1,
    maxCharsPerSnippet: 2400,
  });
  expect(arrowOwnerPack.files[0]?.snippets.some((snippet) => snippet.content.includes('readValue = ('))).toBe(true);
  expect(arrowOwnerPack.readiness.unresolvedReasonCodes).not.toContain('required_symbol_not_materialized');
  expect(arrowOwnerPack.readiness.status).toBe('ready');
  expect(arrowOwnerPack.readiness.readyForHighConfidenceMutation).toBe(true);

  const multiRequiredPack = buildControllerContextPack(root, getMcpPolicy('controller'), {
    description: 'Inspect alphaOwner, betaMethod, and gammaHandler in the exact known implementation file.',
    searchTerms: ['alphaOwner', 'betaMethod', 'gammaHandler'],
    knownPaths: ['src/multi-required.ts'],
    retrievalMode: 'implementation',
    structuralContext: 'off',
    maxFiles: 1,
    maxSnippets: 2,
    maxCharsPerSnippet: 2400,
  });
  expect(multiRequiredPack.search.truncated).toBe(true);
  const emittedMultiOwners = [
    multiRequiredPack.files[0]?.snippets.some((snippet) => snippet.content.includes('export function alphaOwner')) ?? false,
    multiRequiredPack.files[0]?.snippets.some((snippet) => snippet.content.includes('export function betaMethod')) ?? false,
    multiRequiredPack.files[0]?.snippets.some((snippet) => snippet.content.includes('export function gammaHandler')) ?? false,
  ];
  expect(emittedMultiOwners.some(Boolean)).toBe(false);
  expect(multiRequiredPack.search.evidenceTruncated).toBe(true);
  expect(multiRequiredPack.readiness.unresolvedReasonCodes).toContain('required_symbol_not_materialized');
  expect(multiRequiredPack.readiness.status).toBe('degraded');
  expect(multiRequiredPack.readiness.readyForHighConfidenceMutation).toBe(false);

  const saturatedThreeOwnerPack = buildControllerContextPack(root, getMcpPolicy('controller'), {
    description: 'Recover all three required owners after saturated earlier references within three exact-known windows.',
    searchTerms: ['alphaOwner', 'betaMethod', 'gammaHandler'],
    knownPaths: ['src/multi-required.ts'],
    retrievalMode: 'implementation',
    structuralContext: 'off',
    maxFiles: 1,
    maxSnippets: 3,
    maxCharsPerSnippet: 2400,
  });
  expect(saturatedThreeOwnerPack.files[0]?.snippets.length).toBeLessThanOrEqual(3);
  for (const symbol of ['alphaOwner', 'betaMethod', 'gammaHandler']) {
    expect(saturatedThreeOwnerPack.files[0]?.snippets.some((snippet) =>
      snippet.content.includes('export function ' + symbol + '('))).toBe(true);
  }
  expect(saturatedThreeOwnerPack.readiness.unresolvedReasonCodes).not.toContain('required_symbol_not_materialized');
  expect(saturatedThreeOwnerPack.readiness.status).toBe('ready');
  expect(saturatedThreeOwnerPack.readiness.readyForHighConfidenceMutation).toBe(true);

  const completeMultiRequiredPack = buildControllerContextPack(root, getMcpPolicy('controller'), {
    description: 'Inspect all three required owners in a complete exact-known implementation file.',
    searchTerms: ['alphaOwner', 'betaMethod', 'gammaHandler'],
    knownPaths: ['src/multi-required-complete.ts'],
    retrievalMode: 'implementation',
    structuralContext: 'off',
    maxFiles: 1,
    maxSnippets: 1,
    maxCharsPerSnippet: 2400,
  });
  expect(completeMultiRequiredPack.files[0]?.snippets.length).toBe(1);
  expect(completeMultiRequiredPack.files[0]?.snippets.some((snippet) =>
    snippet.content.includes('export function alphaOwner')
      && snippet.content.includes('export function betaMethod')
      && snippet.content.includes('export function gammaHandler'))).toBe(true);
  expect(completeMultiRequiredPack.readiness.unresolvedReasonCodes).not.toContain('required_symbol_not_materialized');
  expect(completeMultiRequiredPack.readiness.status).toBe('ready');
  expect(completeMultiRequiredPack.readiness.readyForHighConfidenceMutation).toBe(true);

  const caseLabelOwnerPack = buildControllerContextPack(root, getMcpPolicy('controller'), {
    description: 'Inspect gammaHandler after a matching switch case label and dense references in the exact known implementation file.',
    searchTerms: ['gammaHandler'],
    knownPaths: ['src/case-label-owner.ts'],
    retrievalMode: 'implementation',
    structuralContext: 'off',
    maxFiles: 1,
    maxSnippets: 1,
    maxCharsPerSnippet: 2400,
  });
  expect(caseLabelOwnerPack.files[0]?.snippets.some((snippet) => snippet.content.includes('export function gammaHandler'))).toBe(true);
  expect(caseLabelOwnerPack.files[0]?.snippets.some((snippet) => snippet.content.includes("case 'gammaHandler':"))).toBe(false);
  expect(caseLabelOwnerPack.readiness.unresolvedReasonCodes).not.toContain('required_symbol_not_materialized');
  expect(caseLabelOwnerPack.readiness.status).toBe('ready');
  expect(caseLabelOwnerPack.readiness.readyForHighConfidenceMutation).toBe(true);

  expect(exactCodeOwnerEvidence('/*\nfunction fakeOwner() { return true; }\n*/', 'fakeOwner')).toEqual({ declared: undefined, owner: false });
  expect(exactCodeOwnerEvidence('const example = ' + String.fromCharCode(96) + '\nfunction fakeOwner() { return true; }\n' + String.fromCharCode(96) + ';', 'fakeOwner')).toEqual({ declared: undefined, owner: false });

  const commentOnlyOwnerPack = buildControllerContextPack(root, getMcpPolicy('controller'), {
    description: 'Inspect commentOnlyOwner in the exact known implementation file.',
    searchTerms: ['commentOnlyOwner'],
    knownPaths: ['src/comment-only-owner.ts'],
    retrievalMode: 'implementation',
    structuralContext: 'off',
    maxFiles: 1,
    maxSnippets: 1,
    maxCharsPerSnippet: 2400,
  });
  expect(commentOnlyOwnerPack.files[0]?.snippets.some((snippet) => snippet.content.includes('function commentOnlyOwner'))).toBe(true);
  expect(commentOnlyOwnerPack.readiness.unresolvedReasonCodes).toContain('required_symbol_not_materialized');
  expect(commentOnlyOwnerPack.readiness.status).toBe('degraded');
  expect(commentOnlyOwnerPack.readiness.readyForHighConfidenceMutation).toBe(false);

  const commentBeforeRealOwnerPack = buildControllerContextPack(root, getMcpPolicy('controller'), {
    description: 'Inspect commentThenRealOwner after an earlier commented-out declaration in the exact known implementation file.',
    searchTerms: ['commentThenRealOwner'],
    knownPaths: ['src/comment-before-real-owner.ts'],
    retrievalMode: 'implementation',
    structuralContext: 'off',
    maxFiles: 1,
    maxSnippets: 1,
    maxCharsPerSnippet: 2400,
  });
  expect(commentBeforeRealOwnerPack.files[0]?.snippets.some((snippet) => snippet.content.includes('export function commentThenRealOwner'))).toBe(true);
  expect(commentBeforeRealOwnerPack.readiness.unresolvedReasonCodes).not.toContain('required_symbol_not_materialized');
  expect(commentBeforeRealOwnerPack.readiness.status).toBe('ready');
  expect(commentBeforeRealOwnerPack.readiness.readyForHighConfidenceMutation).toBe(true);

  const templateOnlyOwnerPack = buildControllerContextPack(root, getMcpPolicy('controller'), {
    description: 'Inspect templateOnlyOwner in the exact known implementation file.',
    searchTerms: ['templateOnlyOwner'],
    knownPaths: ['src/template-only-owner.ts'],
    retrievalMode: 'implementation',
    structuralContext: 'off',
    maxFiles: 1,
    maxSnippets: 1,
    maxCharsPerSnippet: 2400,
  });
  expect(templateOnlyOwnerPack.files[0]?.snippets.some((snippet) => snippet.content.includes('function templateOnlyOwner'))).toBe(true);
  expect(templateOnlyOwnerPack.readiness.unresolvedReasonCodes).toContain('required_symbol_not_materialized');
  expect(templateOnlyOwnerPack.readiness.status).toBe('degraded');
  expect(templateOnlyOwnerPack.readiness.readyForHighConfidenceMutation).toBe(false);

  const templateBeforeRealOwnerPack = buildControllerContextPack(root, getMcpPolicy('controller'), {
    description: 'Inspect templateThenRealOwner after earlier template-literal text in the exact known implementation file.',
    searchTerms: ['templateThenRealOwner'],
    knownPaths: ['src/template-before-real-owner.ts'],
    retrievalMode: 'implementation',
    structuralContext: 'off',
    maxFiles: 1,
    maxSnippets: 1,
    maxCharsPerSnippet: 2400,
  });
  expect(templateBeforeRealOwnerPack.files[0]?.snippets.some((snippet) => snippet.content.includes('export function templateThenRealOwner'))).toBe(true);
  expect(templateBeforeRealOwnerPack.readiness.unresolvedReasonCodes).not.toContain('required_symbol_not_materialized');
  expect(templateBeforeRealOwnerPack.readiness.status).toBe('ready');
  expect(templateBeforeRealOwnerPack.readiness.readyForHighConfidenceMutation).toBe(true);
});

test('nested templates never manufacture exact owner declarations and interpolation remains code', () => {
  const tick = String.fromCharCode(96);
  const expression = '$' + '{';
  const source = [
    'const message = ' + tick + 'outer ' + expression + ' (() => {',
    '  const inner = ' + tick,
    'export function fakeNestedOwner() { return true; }',
    tick + ';',
    '  const after = "function fakeQuotedOwner() {}";',
    '  return inner + after;',
    '})() } suffix' + tick + ';',
    'export function realAfterTemplate() { return true; }',
    'const invocation = ' + tick + 'prefix ' + expression + ' (() => {',
    '  function realInsideExpression() { return 1; }',
    '  return realInsideExpression();',
    '})() } suffix' + tick + ';',
  ].join('\n');
  expect(exactCodeOwnerEvidence(source, 'fakeNestedOwner').owner).toBe(false);
  expect(exactCodeOwnerEvidence(source, 'fakeQuotedOwner').owner).toBe(false);
  expect(exactCodeOwnerEvidence(source, 'realAfterTemplate').owner).toBe(true);
  expect(exactCodeOwnerEvidence('1: export function numberedOwner() {}', 'numberedOwner').owner).toBe(true);
  expect(exactCodeOwnerQueries('1: export function numberedOwner() {}', ['numberedOwner'])).toEqual(['numberedOwner']);
  expect(exactCodeOwnerEvidence(source, 'realInsideExpression').owner).toBe(true);
  expect(exactCodeOwnerEvidence('export function gammaHandler() {}', 'GammaHandler').owner).toBe(true);
  expect(exactCodeOwnerQueries('export function gammaHandler() {}', ['GammaHandler'])).toEqual(['GammaHandler']);
  expect(exactCodeOwnerQueries(source, ['fakeNestedOwner', 'realAfterTemplate'])).toEqual(['realAfterTemplate']);
});

test('regex literal braces do not terminate nested template interpolation or invent owner declarations', () => {
  const tick = String.fromCharCode(96);
  const interpolation = '$' + '{';
  for (const pattern of ['/}/', '/\\}/', '/[}]/', '/[\\/}]/']) {
    const source = [
      'const example = ' + tick + 'outer ' + interpolation + ' ' + pattern + '.test(value) ? ' + tick,
      'function fakeRegexNestedOwner() { return true; }',
      tick + ' : "" } suffix' + tick + ';',
      'const division = 4 / 2;',
      'export function actualOwnerAfterRegex() { return division; }',
    ].join('\n');
    expect(exactCodeOwnerEvidence(source, 'fakeRegexNestedOwner').owner).toBe(false);
    expect(exactCodeOwnerQueries(source, ['fakeRegexNestedOwner', 'actualOwnerAfterRegex']))
      .toEqual(['actualOwnerAfterRegex']);
  }

  const controlConditionSource = [
    'const example = ' + tick + interpolation + ' (() => {',
    '  if (condition) /}/.test(condition);',
    '})() + ' + tick,
    'function fakeRegexAfterControlOwner() { return true; }',
    tick + '}' + tick + ';',
    'export function actualOwnerAfterControlRegex() { return true; }',
  ].join('\n');
  expect(exactCodeOwnerEvidence(controlConditionSource, 'fakeRegexAfterControlOwner').owner).toBe(false);
  expect(exactCodeOwnerEvidence(controlConditionSource, 'actualOwnerAfterControlRegex').owner).toBe(true);

  const propertyKeywordDivisionSource = [
    'const quotient = receiver.if(condition) / 2;',
    'export function actualOwnerAfterPropertyKeywordDivision() { return quotient; }',
  ].join('\n');
  expect(exactCodeOwnerEvidence(propertyKeywordDivisionSource, 'actualOwnerAfterPropertyKeywordDivision').owner).toBe(true);
});

test('retains separate explicit code symbols in sync and async discovery beyond the inventory cap', async () => {
  const root = mkdtempSync(join(tmpdir(), 'forge-context-multi-symbol-'));
  roots.push(root);
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'context@example.test'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'Context Test'], { cwd: root });
  mkdirSync(join(root, 'src'), { recursive: true });
  for (let index = 0; index < 840; index += 1) {
    writeFileSync(join(root, `src/a-noise-${String(index).padStart(2, '0')}.ts`), `export const inspect = ${index};\n`);
  }
  for (let index = 0; index < 12; index += 1) {
    writeFileSync(join(root, `src/b-prefix-${index}.ts`), `export const inspectResourceLeaseLegacy${index} = inspectWorkHandleLegacy${index};\n`);
  }
  writeFileSync(join(root, 'src/zz-first.ts'), 'export function inspectResourceLease() { return 1; }\n');
  writeFileSync(join(root, 'src/zz-second.ts'), 'export function inspectWorkHandle() { return 2; }\n');
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['commit', '-qm', 'fixture'], { cwd: root });

  const options = {
    description: 'inspect the two implementation symbols',
    searchTerms: ['inspect inspectResourceLease inspectWorkHandle'],
    retrievalMode: 'implementation',
    structuralContext: 'off',
    maxFiles: 2,
    maxSnippets: 2,
  } satisfies ControllerContextPackOptions;
  const pack = buildControllerContextPack(root, getMcpPolicy('controller'), options);
  expect(pack.files.map((file) => file.path)).toEqual(['src/zz-first.ts', 'src/zz-second.ts']);
  expect(pack.files.every((file) => file.reasons.some((reason) => reason.startsWith('search:inspect')))).toBe(true);
  expect(pack.search.scannedFiles).toBeLessThan(30);
  const asyncPack = await buildControllerContextPackAsync(root, getMcpPolicy('controller'), options);
  expect(asyncPack.files.map((file) => file.path)).toEqual(pack.files.map((file) => file.path));
  expect(asyncPack.search.scannedFiles).toBeLessThan(30);
});

test('ranks the full natural-language discovery result before applying the bounded candidate budget', () => {
  const root = mkdtempSync(join(tmpdir(), 'forge-context-discovery-ranking-'));
  roots.push(root);
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'context@example.test'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'Context Test'], { cwd: root });
  mkdirSync(join(root, 'src'), { recursive: true });
  for (let index = 0; index < 12; index += 1) {
    writeFileSync(join(root, `src/a-noise-${String(index).padStart(2, '0')}.ts`), "export const unrelated = 'App Store Connect';\n");
  }
  writeFileSync(join(root, 'src/z-release-rejection.ts'), "export const releaseSubmission = 'App Store Connect release rejection submission';\n");
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['commit', '-qm', 'fixture'], { cwd: root });

  const pack = buildControllerContextPack(root, getMcpPolicy('controller'), {
    description: 'App Store Connect release rejection submission',
    retrievalMode: 'implementation',
    structuralContext: 'off',
    maxFiles: 4,
    maxSnippets: 4,
  });

  expect(pack.files.map((file) => file.path)).toContain('src/z-release-rejection.ts');
  expect(pack.files[0]?.path).toBe('src/z-release-rejection.ts');
});
