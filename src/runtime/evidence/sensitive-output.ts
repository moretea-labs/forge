import { createHash } from 'crypto';
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from 'fs';
import { StringDecoder } from 'string_decoder';

export interface SensitiveRedactionCount {
  type: string;
  count: number;
}

export interface SensitiveTextRedactionResult {
  text: string;
  redactions: SensitiveRedactionCount[];
  changed: boolean;
}

interface SensitivePattern {
  type: string;
  pattern: RegExp;
  replacement: string;
}

const PRIVATE_KEY_PATTERN = /-----BEGIN\s+(?:RSA\s+|OPENSSH\s+|EC\s+)?PRIVATE\s+KEY-----[\s\S]*?-----END\s+(?:RSA\s+|OPENSSH\s+|EC\s+)?PRIVATE\s+KEY-----/gi;
const SENSITIVE_PATTERNS: readonly SensitivePattern[] = [
  {
    type: 'private_key',
    pattern: PRIVATE_KEY_PATTERN,
    replacement: '[PRIVATE KEY REDACTED]',
  },
  {
    type: 'authorization_header',
    pattern: /(\b(?:proxy-)?authorization\s*[:=]\s*)(bearer|basic)\s+[^\s,;]+/gi,
    replacement: '$1$2 [REDACTED]',
  },
  {
    type: 'authorization_assignment',
    pattern: /(\b(?:proxy-)?authorization\s*(?:=>|:=|=|:)\s*)(?!(?:bearer|basic)\s+)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,}\r\n]+)/gi,
    replacement: '$1[REDACTED]',
  },
  {
    type: 'cookie_header',
    pattern: /(\b(?:set-)?cookie\s*:\s*)[^\r\n]+/gi,
    replacement: '$1[REDACTED]',
  },
  {
    type: 'cli_secret_option',
    pattern: /(\B--?(?:api[_-]?key|access[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|private[_-]?key|password|passwd|secret|credentials?|authorization|auth[_-]?token|token|cookie)(?:=|\s+))(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,}\r\n]+)/gi,
    replacement: '$1[REDACTED]',
  },
  {
    type: 'secret_assignment',
    pattern: /((?:^|[^\w]))(["']?)([A-Za-z0-9_.-]*(?:api[_-]?key|access[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|private[_-]?key|password|passwd|secret|credentials?|auth[_-]?token|token|cookie)[A-Za-z0-9_.-]*)\2(\s*(?:=>|:=|=|:)\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,}\r\n]+)/gim,
    replacement: '$1$2$3$2$4[REDACTED]',
  },
  {
    type: 'database_url_assignment',
    pattern: /((?:^|[^\w]))(["']?)((?:DATABASE_URL|POSTGRES_URL|MONGODB_URI|REDIS_URL))\2(\s*(?:=>|:=|=|:)\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,}\r\n]+)/gim,
    replacement: '$1$2$3$2$4[REDACTED]',
  },
  {
    type: 'url_userinfo',
    pattern: /(\b[a-z][a-z0-9+.-]*:\/\/)(?:[^\s/@:]+(?::[^\s/@]*)?@)/gi,
    replacement: '$1[REDACTED]@',
  },
  {
    type: 'openai_style_key',
    pattern: /\bsk-[A-Za-z0-9_-]{16,}\b/g,
    replacement: 'sk-[REDACTED]',
  },
  {
    type: 'github_token',
    pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{24,})\b/g,
    replacement: '[GITHUB TOKEN REDACTED]',
  },
  {
    type: 'slack_token',
    pattern: /\bxox[baprs]-[A-Za-z0-9-]{16,}\b/g,
    replacement: '[SLACK TOKEN REDACTED]',
  },
  {
    type: 'aws_access_key',
    pattern: /\bAKIA[0-9A-Z]{16}\b/g,
    replacement: 'AKIA[REDACTED]',
  },
  {
    type: 'jwt_token',
    pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
    replacement: '[JWT REDACTED]',
  },
];

const SENSITIVE_KEY = /(?:^|[_\-.])(?:api[_-]?key|access[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|private[_-]?key|password|passwd|secret|credentials?|authorization|auth[_-]?token|token|cookie)(?:$|[_\-.])|(?:apiKey|accessKey|accessToken|refreshToken|clientSecret|privateKey|password|passwd|secret|credentials?|authorization|authToken|token|cookie)$/i;
const NON_SECRET_CONTROL_TOKEN_KEY = /^(?:continuationToken|nextToken|pageToken|cursorToken|resumeToken|terminalFenceToken|fencingToken)$/i;
const MAX_STREAM_CARRY_CHARS = 64 * 1024;
const STREAM_BOUNDARY_CARRY_CHARS = 4 * 1024;

function mergeCounts(target: Map<string, number>, entries: readonly SensitiveRedactionCount[]): void {
  for (const entry of entries) target.set(entry.type, (target.get(entry.type) ?? 0) + entry.count);
}

const SAFE_AUTHORIZATION_LABEL = /^(?:readonly|policy|full_access|goal_delegation|gpt_risk_delegate|user_confirmation|confirmed_plan|confirmed|denied|allow|deny)$/i;
const SAFE_AUTHORIZATION_DECISION_KEYS = new Set([
  'decision', 'source', 'reason', 'reasons', 'risk', 'classification', 'required', 'confirmed',
]);

function isSafeAuthorizationDiagnostic(key: string, value: unknown): boolean {
  if (!/^authorization$/i.test(key.trim())) return false;
  if (typeof value === 'string') return SAFE_AUTHORIZATION_LABEL.test(value.trim());
  if (!value || typeof value !== 'object' || Array.isArray(value) || Buffer.isBuffer(value)) return false;
  const entries = Object.entries(value as Record<string, unknown>);
  if (!entries.length || entries.some(([entryKey]) => !SAFE_AUTHORIZATION_DECISION_KEYS.has(entryKey))) return false;
  return entries.every(([, entryValue]) => (
    typeof entryValue === 'string'
    || typeof entryValue === 'boolean'
    || (Array.isArray(entryValue) && entryValue.every((item) => typeof item === 'string'))
  ));
}

export function isSensitiveOutputKey(key: string): boolean {
  const normalized = key.trim();
  if (NON_SECRET_CONTROL_TOKEN_KEY.test(normalized)) return false;
  return SENSITIVE_KEY.test(normalized);
}

export function redactSensitiveText(input: string): SensitiveTextRedactionResult {
  let text = input;
  const counts = new Map<string, number>();
  for (const entry of SENSITIVE_PATTERNS) {
    const matches = text.match(entry.pattern);
    if (!matches?.length) continue;
    counts.set(entry.type, (counts.get(entry.type) ?? 0) + matches.length);
    text = text.replace(entry.pattern, entry.replacement);
  }
  return {
    text,
    redactions: [...counts.entries()].map(([type, count]) => ({ type, count })),
    changed: text !== input,
  };
}

export function redactSensitiveValue<T>(input: T): {
  value: T;
  redactions: SensitiveRedactionCount[];
  changed: boolean;
} {
  const counts = new Map<string, number>();
  const active = new WeakSet<object>();
  let changed = false;

  const visit = (value: unknown, key?: string, depth = 0): unknown => {
    if (key && isSensitiveOutputKey(key) && value !== null && value !== undefined && !isSafeAuthorizationDiagnostic(key, value)) {
      // The canonical placeholder is already safe. Treating it as a fresh
      // redaction would make historical result maintenance rewrite the same
      // payload and metadata on every pass.
      if (value === '[REDACTED]') return value;
      changed = true;
      counts.set('sensitive_key', (counts.get('sensitive_key') ?? 0) + 1);
      return '[REDACTED]';
    }
    if (typeof value === 'string') {
      const redacted = redactSensitiveText(value);
      if (redacted.changed) changed = true;
      mergeCounts(counts, redacted.redactions);
      return redacted.text;
    }
    if (!value || typeof value !== 'object' || depth >= 32) return value;
    if (value instanceof Date) return value.toISOString();
    if (value instanceof Error) {
      return {
        name: redactSensitiveText(value.name).text,
        message: redactSensitiveText(value.message).text,
        ...(value.stack ? { stack: redactSensitiveText(value.stack).text } : {}),
      };
    }
    if (Buffer.isBuffer(value)) {
      const redacted = redactSensitiveText(value.toString('utf8'));
      if (redacted.changed) changed = true;
      mergeCounts(counts, redacted.redactions);
      return redacted.text;
    }
    if (active.has(value)) {
      changed = true;
      counts.set('circular_value', (counts.get('circular_value') ?? 0) + 1);
      return '[CIRCULAR]';
    }
    active.add(value);
    try {
      if (Array.isArray(value)) return value.map((entry) => visit(entry, undefined, depth + 1));
      const result: Record<string, unknown> = {};
      for (const [entryKey, entryValue] of Object.entries(value as Record<string, unknown>)) {
        result[entryKey] = visit(entryValue, entryKey, depth + 1);
      }
      return result;
    } finally {
      active.delete(value);
    }
  };

  const value = visit(input) as T;
  return {
    value,
    redactions: [...counts.entries()].map(([type, count]) => ({ type, count })),
    changed,
  };
}

export class StreamingSensitiveTextRedactor {
  private readonly decoder = new StringDecoder('utf8');
  private carry = '';
  private insidePrivateKey = false;
  private readonly counts = new Map<string, number>();

  write(chunk: Buffer | string): string {
    const decoded = typeof chunk === 'string' ? chunk : this.decoder.write(chunk);
    return this.consume(decoded, false);
  }

  end(): string {
    return this.consume(this.decoder.end(), true);
  }

  redactions(): SensitiveRedactionCount[] {
    return [...this.counts.entries()].map(([type, count]) => ({ type, count }));
  }

  private redactLine(line: string): string {
    if (this.insidePrivateKey) {
      if (/-----END\s+(?:RSA\s+|OPENSSH\s+|EC\s+)?PRIVATE\s+KEY-----/i.test(line)) this.insidePrivateKey = false;
      return '';
    }
    if (/-----BEGIN\s+(?:RSA\s+|OPENSSH\s+|EC\s+)?PRIVATE\s+KEY-----/i.test(line)) {
      this.insidePrivateKey = !/-----END\s+(?:RSA\s+|OPENSSH\s+|EC\s+)?PRIVATE\s+KEY-----/i.test(line);
      this.counts.set('private_key', (this.counts.get('private_key') ?? 0) + 1);
      return '[PRIVATE KEY REDACTED]';
    }
    const redacted = redactSensitiveText(line);
    mergeCounts(this.counts, redacted.redactions);
    return redacted.text;
  }

  private consume(value: string, final: boolean): string {
    this.carry += value;
    let output = '';
    while (true) {
      const newline = this.carry.indexOf('\n');
      if (newline < 0) break;
      const line = this.carry.slice(0, newline);
      this.carry = this.carry.slice(newline + 1);
      output += `${this.redactLine(line)}\n`;
    }
    if (!final && this.carry.length > MAX_STREAM_CARRY_CHARS) {
      const flushLength = this.carry.length - STREAM_BOUNDARY_CARRY_CHARS;
      output += this.redactLine(this.carry.slice(0, flushLength));
      this.carry = this.carry.slice(flushLength);
    }
    if (final && this.carry) {
      output += this.redactLine(this.carry);
      this.carry = '';
    }
    if (final && this.insidePrivateKey) this.insidePrivateKey = false;
    return output;
  }
}

export interface SensitiveFileSanitization {
  path: string;
  exists: boolean;
  changed: boolean;
  rawBytes: number;
  storedBytes: number;
  redactions: SensitiveRedactionCount[];
  rawSha256?: string;
  redactedSha256?: string;
}

/**
 * Replace a text artifact with a redacted version without ever returning its
 * contents. The original path is preserved, permissions are forced to 0600,
 * and a failed migration leaves the original file untouched.
 */
export function sanitizeSensitiveTextFileInPlace(path: string): SensitiveFileSanitization {
  if (!path || !existsSync(path)) return { path, exists: false, changed: false, rawBytes: 0, storedBytes: 0, redactions: [] };
  const rawBytes = statSync(path).size;
  const temporary = `${path}.${process.pid}.${Date.now()}.redacting`;
  let inputFd: number | undefined;
  let outputFd: number | undefined;
  const rawHash = createHash('sha256');
  const redactedHash = createHash('sha256');
  const redactor = new StreamingSensitiveTextRedactor();
  let storedBytes = 0;
  try {
    inputFd = openSync(path, 'r');
    outputFd = openSync(temporary, 'wx', 0o600);
    const buffer = Buffer.alloc(64 * 1024);
    while (true) {
      const bytesRead = readSync(inputFd, buffer, 0, buffer.length, null);
      if (bytesRead <= 0) break;
      const chunk = Buffer.from(buffer.subarray(0, bytesRead));
      rawHash.update(chunk);
      const output = redactor.write(chunk);
      if (output) {
        const encoded = Buffer.from(output, 'utf8');
        writeSync(outputFd, encoded);
        redactedHash.update(encoded);
        storedBytes += encoded.length;
      }
    }
    const final = redactor.end();
    if (final) {
      const encoded = Buffer.from(final, 'utf8');
      writeSync(outputFd, encoded);
      redactedHash.update(encoded);
      storedBytes += encoded.length;
    }
    fsyncSync(outputFd);
    closeSync(inputFd);
    closeSync(outputFd);
    inputFd = undefined;
    outputFd = undefined;
    const redactions = redactor.redactions();
    const rawSha256 = rawHash.digest('hex');
    const redactedSha256 = redactedHash.digest('hex');
    const changed = rawSha256 !== redactedSha256;
    if (changed) renameSync(temporary, path);
    else rmSync(temporary, { force: true });
    chmodSync(path, 0o600);
    return {
      path,
      exists: true,
      changed,
      rawBytes,
      storedBytes: changed ? storedBytes : rawBytes,
      redactions,
      rawSha256,
      redactedSha256: changed ? redactedSha256 : undefined,
    };
  } catch (error) {
    if (inputFd !== undefined) try { closeSync(inputFd); } catch { /* ignore */ }
    if (outputFd !== undefined) try { closeSync(outputFd); } catch { /* ignore */ }
    try { rmSync(temporary, { force: true }); } catch { /* ignore */ }
    throw error;
  }
}
