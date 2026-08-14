import { createHash } from 'crypto';
import type { RepositoryRecord } from '../../../cli/repositories/types';
import { executeBrowserPluginAction } from '../../plugins/browser-adapter';

export type ScheduledBrowserProbeStatus = 'observed' | 'keepalive' | 'auth_required';

export interface ScheduledBrowserProbeResult {
  status: ScheduledBrowserProbeStatus;
  fingerprint?: string;
  url?: string;
  sessionId: string;
  projectedLineCount: number;
  observedChars: number;
  truncated: boolean;
  authReason?: string;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.map((entry) => String(entry).trim()).filter(Boolean) : [];
}

function boundedNumber(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(min, Math.min(Math.trunc(value), max))
    : fallback;
}

export function buildScheduledBrowserFingerprint(text: string, includeTerms: string[] = [], ignorePatterns: string[] = []): { fingerprint: string; lineCount: number } {
  const terms = includeTerms.map((term) => term.toLocaleLowerCase());
  let lines = text
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  if (terms.length > 0) {
    lines = lines.filter((line) => {
      const normalized = line.toLocaleLowerCase();
      return terms.some((term) => normalized.includes(term));
    });
  }
  for (const pattern of ignorePatterns) {
    try {
      const expression = new RegExp(pattern, 'giu');
      lines = lines.map((line) => line.replace(expression, ' ').replace(/\s+/g, ' ').trim()).filter(Boolean);
    } catch {
      throw new Error(`SCHEDULE_BROWSER_PROBE_IGNORE_PATTERN_INVALID: ${pattern}`);
    }
  }
  lines = [...new Set(lines)].sort((left, right) => left.localeCompare(right));
  return { fingerprint: createHash('sha256').update(lines.join('\n')).digest('hex'), lineCount: lines.length };
}

export function classifyScheduledBrowserObservation(
  previousFingerprint: string | undefined,
  currentFingerprint: string | undefined,
  wakeOnFirstObservation = false,
): { status: 'baseline' | 'unchanged' | 'changed'; shouldWake: boolean } {
  const firstObservation = !previousFingerprint;
  const changed = Boolean(previousFingerprint && currentFingerprint && previousFingerprint !== currentFingerprint);
  return {
    status: firstObservation ? 'baseline' : changed ? 'changed' : 'unchanged',
    shouldWake: changed || (firstObservation && wakeOnFirstObservation),
  };
}

function containsAny(value: string | undefined, terms: string[]): string | undefined {
  if (!value) return undefined;
  const normalized = value.toLocaleLowerCase();
  return terms.find((term) => normalized.includes(term.toLocaleLowerCase()));
}

async function browserAction(
  controllerHome: string,
  repository: RepositoryRecord,
  occurrenceId: string,
  actionId: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  return executeBrowserPluginAction({
    controllerHome,
    repoId: repository.repoId,
    repoRoot: repository.canonicalRoot,
    pluginId: 'browser',
    actionId,
    requestId: `schedule-browser-probe:${occurrenceId}:${actionId}`,
    args,
    origin: { surface: 'schedule', actor: 'browser-probe', correlationId: occurrenceId },
  });
}

/**
 * Bounded read-only browser observation for Schedule. It never interprets page
 * meaning: it only refreshes/navigates, extracts bounded text, projects matching
 * lines, detects configured login markers, and returns a stable fingerprint.
 */
export async function executeScheduledBrowserProbe(input: {
  controllerHome: string;
  repository: RepositoryRecord;
  occurrenceId: string;
  args: Record<string, unknown>;
}): Promise<ScheduledBrowserProbeResult> {
  const requestedSessionId = stringValue(input.args.probe_session_id) ?? stringValue(input.args.session_id);
  const url = stringValue(input.args.probe_url) ?? stringValue(input.args.url);
  if (!requestedSessionId && !url) throw new Error('SCHEDULE_BROWSER_PROBE_TARGET_REQUIRED');

  const waitUntil = stringValue(input.args.wait_until) ?? 'domcontentloaded';
  const timeoutMs = boundedNumber(input.args.timeout_ms, 60_000, 1_000, 120_000);
  let navigation: Record<string, unknown>;
  if (url) {
    navigation = await browserAction(input.controllerHome, input.repository, input.occurrenceId, 'navigate', {
      ...(requestedSessionId ? { session_id: requestedSessionId } : {}),
      url,
      wait_until: waitUntil,
      timeout_ms: timeoutMs,
      retries: 1,
    });
  } else {
    navigation = await browserAction(input.controllerHome, input.repository, input.occurrenceId, 'reload', {
      session_id: requestedSessionId!,
      wait_until: waitUntil,
      timeout_ms: timeoutMs,
    });
  }

  const session = recordValue(navigation.session);
  const sessionId = stringValue(navigation.sessionId) ?? stringValue(session.sessionId) ?? stringValue(session.id) ?? requestedSessionId;
  if (!sessionId) throw new Error('SCHEDULE_BROWSER_PROBE_SESSION_UNAVAILABLE');
  const observedUrl = stringValue(navigation.url) ?? stringValue(session.url) ?? url;
  const loginUrlTerms = stringList(input.args.login_url_terms);
  const urlLoginMarker = containsAny(observedUrl, loginUrlTerms);

  const keepaliveOnly = input.args.keepalive_only === true;
  const loginTextTerms = stringList(input.args.login_text_terms);
  const mustExtractText = !keepaliveOnly || loginTextTerms.length > 0;
  let rawText = '';
  let truncated = false;
  if (mustExtractText) {
    const textResult = await browserAction(input.controllerHome, input.repository, input.occurrenceId, 'get_text', {
      session_id: sessionId,
      ...(stringValue(input.args.selector) ? { selector: stringValue(input.args.selector) } : {}),
      max_chars: boundedNumber(input.args.max_chars, 20_000, 256, 100_000),
    });
    rawText = stringValue(textResult.text) ?? '';
    truncated = textResult.truncated === true;
  }
  const textLoginMarker = containsAny(rawText, loginTextTerms);
  const authMarker = urlLoginMarker ?? textLoginMarker;
  if (authMarker) {
    return {
      status: 'auth_required',
      url: observedUrl,
      sessionId,
      projectedLineCount: 0,
      observedChars: rawText.length,
      truncated,
      authReason: `matched configured login marker: ${authMarker}`,
    };
  }
  if (keepaliveOnly) {
    return { status: 'keepalive', url: observedUrl, sessionId, projectedLineCount: 0, observedChars: rawText.length, truncated };
  }

  const projected = buildScheduledBrowserFingerprint(rawText, stringList(input.args.include_terms), stringList(input.args.ignore_patterns));
  return {
    status: 'observed',
    fingerprint: projected.fingerprint,
    url: observedUrl,
    sessionId,
    projectedLineCount: projected.lineCount,
    observedChars: rawText.length,
    truncated,
  };
}
