import type { AssistantPluginActionExecutionInput } from './types';
import { executeBrowserPluginAction } from './browser-adapter';
import { isAssistantPluginError } from './errors';

const MAX_REQUEST_BYTES = 1_048_576;

interface BridgeRequest {
  schemaVersion: 1;
  input: AssistantPluginActionExecutionInput;
}

async function readRequest(): Promise<BridgeRequest> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > MAX_REQUEST_BYTES) throw new Error('Browser Node bridge request exceeded the bounded input limit.');
    chunks.push(buffer);
  }
  const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as BridgeRequest;
  if (parsed.schemaVersion !== 1 || !parsed.input || typeof parsed.input !== 'object') {
    throw new Error('Browser Node bridge request was invalid.');
  }
  return parsed;
}

function write(value: unknown): void {
  process.stdout.write(JSON.stringify(value));
}

async function main(): Promise<void> {
  try {
    const request = await readRequest();
    const result = await executeBrowserPluginAction(request.input);
    write({ schemaVersion: 1, ok: true, result });
  } catch (error) {
    if (isAssistantPluginError(error)) {
      write({
        schemaVersion: 1,
        ok: false,
        error: {
          code: error.code,
          message: error.message.replace(`${error.code}: `, ''),
          retryable: error.retryable,
          details: error.details,
        },
      });
    } else {
      write({
        schemaVersion: 1,
        ok: false,
        error: {
          code: 'PLUGIN_BROWSER_NODE_FAILED',
          message: error instanceof Error ? error.message : 'Browser Node bridge failed.',
          retryable: true,
        },
      });
    }
    process.exitCode = 1;
  }
}

void main();
