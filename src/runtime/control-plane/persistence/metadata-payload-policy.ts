const FORBIDDEN_FIELD = /(?:^|_)(?:secret|secrets|credential|credentials|password|passwd|access_token|refresh_token|private_key|binary|blob|stdout|stderr|large_log|log_payload)(?:$|_)/i;
const SECRET_TEXT = /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\bgh[pousr]_[A-Za-z0-9]{20,}\b|\bsk-[A-Za-z0-9_-]{20,}\b/;
const MAX_STRING_BYTES = 64 * 1024;
const DEFAULT_MAX_PAYLOAD_BYTES = 2 * 1024 * 1024;

function visit(value: unknown, path: string, seen: Set<object>): void {
  if (value === null || value === undefined || typeof value === 'boolean' || typeof value === 'number') return;
  if (typeof value === 'string') {
    if (Buffer.byteLength(value, 'utf8') > MAX_STRING_BYTES) {
      throw new Error(`CONTROL_PLANE_METADATA_STRING_TOO_LARGE: ${path}`);
    }
    if (SECRET_TEXT.test(value)) throw new Error(`CONTROL_PLANE_METADATA_SECRET_REFUSED: ${path}`);
    return;
  }
  if (typeof value === 'bigint' || typeof value === 'function' || typeof value === 'symbol') {
    throw new Error(`CONTROL_PLANE_METADATA_TYPE_REFUSED: ${path}`);
  }
  if (Buffer.isBuffer(value) || ArrayBuffer.isView(value) || value instanceof ArrayBuffer) {
    throw new Error(`CONTROL_PLANE_METADATA_BINARY_REFUSED: ${path}`);
  }
  if (typeof value !== 'object') return;
  if (seen.has(value)) throw new Error(`CONTROL_PLANE_METADATA_CYCLE_REFUSED: ${path}`);
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      value.forEach((entry, index) => visit(entry, `${path}[${index}]`, seen));
      return;
    }
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (FORBIDDEN_FIELD.test(key)) throw new Error(`CONTROL_PLANE_METADATA_FIELD_REFUSED: ${path}.${key}`);
      visit(entry, `${path}.${key}`, seen);
    }
  } finally {
    seen.delete(value);
  }
}

/**
 * Requirement/Plan migration and offline export are metadata-only surfaces.
 * They must not become an alternate secret store or a transport for logs and
 * binary payloads.
 */
export function assertControlPlaneMetadataPayload(
  value: unknown,
  label: string,
  maxPayloadBytes = DEFAULT_MAX_PAYLOAD_BYTES,
): void {
  visit(value, label, new Set());
  const encoded = JSON.stringify(value);
  if (Buffer.byteLength(encoded, 'utf8') > maxPayloadBytes) {
    throw new Error(`CONTROL_PLANE_METADATA_PAYLOAD_TOO_LARGE: ${label}`);
  }
}
