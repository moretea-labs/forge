const MAX_NATIVE_MESSAGE_BYTES = 1024 * 1024;

export function encodeNativeMessage(value: unknown): Buffer {
  const payload = Buffer.from(JSON.stringify(value), 'utf8');
  if (payload.length > MAX_NATIVE_MESSAGE_BYTES) throw new Error('WORKFLOW_SUPERVISOR_NATIVE_MESSAGE_TOO_LARGE');
  const frame = Buffer.allocUnsafe(payload.length + 4);
  frame.writeUInt32LE(payload.length, 0);
  payload.copy(frame, 4);
  return frame;
}

export class NativeMessageDecoder {
  private buffer = Buffer.alloc(0);
  push(chunk: Buffer): unknown[] {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const values: unknown[] = [];
    while (this.buffer.length >= 4) {
      const length = this.buffer.readUInt32LE(0);
      if (length > MAX_NATIVE_MESSAGE_BYTES) throw new Error('WORKFLOW_SUPERVISOR_NATIVE_MESSAGE_TOO_LARGE');
      if (this.buffer.length < length + 4) break;
      const raw = this.buffer.subarray(4, length + 4).toString('utf8');
      this.buffer = this.buffer.subarray(length + 4);
      try { values.push(JSON.parse(raw)); } catch { throw new Error('WORKFLOW_SUPERVISOR_NATIVE_MESSAGE_INVALID_JSON'); }
    }
    return values;
  }
}
