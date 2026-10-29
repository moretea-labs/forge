#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * GitHub recognizes issue closing keywords lexically, even inside a negation.
 * This narrow guard detects an accidental negated closing reference; it does
 * not decide whether a positive closing reference is authorized.
 */
export function findNegatedClosingReferences(text) {
  const pattern = /\b(?:do\s+not|does\s+not|must\s+not|should\s+not|never|don't)\s+(?:automatically\s+)?(?:close(?:s|d)?|fix(?:es|ed)?|resolv(?:e|es|ed))\s+((?:[\w.-]+\/[\w.-]+)?#\d+|https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/issues\/\d+)/gi;
  return Array.from(new Set(Array.from(text.matchAll(pattern), match => match[1])));
}

function currentPullRequestDescription() {
  const values = [process.env.FORGE_PR_TITLE ?? '', process.env.FORGE_PR_BODY ?? ''];
  if (process.env.GITHUB_EVENT_NAME === 'pull_request') {
    if (!process.env.GITHUB_EVENT_PATH) {
      throw new Error('GITHUB_EVENT_PATH_MISSING: cannot validate PR closing references');
    }
    const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
    if (!event.pull_request || typeof event.pull_request !== 'object') {
      throw new Error('GITHUB_PR_EVENT_INVALID: cannot validate PR closing references');
    }
    values.push(String(event.pull_request.title ?? ''), String(event.pull_request.body ?? ''));
  }
  return values.join('\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const references = findNegatedClosingReferences(currentPullRequestDescription());
    if (references.length) {
      console.error('[pr-closing-intent] misleading negated issue-closing references: ' + references.join(', '));
      console.error('[pr-closing-intent] GitHub may close these issues on merge. Use non-closing wording, such as "Issue #123 remains OPEN".');
      process.exitCode = 1;
    } else {
      console.log('[pr-closing-intent] ok');
    }
  } catch (error) {
    console.error('[pr-closing-intent] ' + (error instanceof Error ? error.message : String(error)));
    process.exitCode = 1;
  }
}
