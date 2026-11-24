import { describe, expect, test } from 'bun:test';
import { hasPdfEofMarkerAtTail } from '../../src/runtime/plugins/ios-physical-device';

describe('physical iPhone document export PDF EOF framing', () => {
  test('accepts only the six legacy padding bytes after the exact EOF marker', () => {
    const prefix = Buffer.from('fixture-content%%EOF', 'ascii');
    const allowed = new Set([0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20]);
    for (let byte = 0; byte <= 0xff; byte += 1) {
      const candidate = Buffer.concat([prefix, Buffer.from([byte])]);
      expect(hasPdfEofMarkerAtTail(candidate)).toBe(allowed.has(byte));
    }
  });

  test('preserves the empty and mixed-padding cases without accepting arbitrary trailing bytes', () => {
    expect(hasPdfEofMarkerAtTail(Buffer.from('%%EOF', 'ascii'))).toBe(true);
    expect(hasPdfEofMarkerAtTail(Buffer.from('prefix %%EOF', 'ascii'))).toBe(true);
    expect(hasPdfEofMarkerAtTail(Buffer.from('prefix %%EOF\0\t\n\f\r ', 'latin1'))).toBe(true);
    expect(hasPdfEofMarkerAtTail(Buffer.from('prefix %%EOF\0X', 'latin1'))).toBe(false);
    expect(hasPdfEofMarkerAtTail(Buffer.from('prefix %%EOF\v', 'latin1'))).toBe(false);
    expect(hasPdfEofMarkerAtTail(Buffer.from('prefix %%EO', 'ascii'))).toBe(false);
    expect(hasPdfEofMarkerAtTail(Buffer.alloc(0))).toBe(false);
  });

  test('rejects every high-bit alias of the five-byte ASCII EOF marker', () => {
    const marker = Buffer.from('%%EOF', 'ascii');
    for (let index = 0; index < marker.length; index += 1) {
      const candidate = Buffer.from(marker);
      candidate[index] = candidate[index]! | 0x80;
      expect(hasPdfEofMarkerAtTail(candidate)).toBe(false);
    }
  });

  test('requires the EOF marker to occur within the last 2048 physical bytes', () => {
    expect(hasPdfEofMarkerAtTail(Buffer.concat([Buffer.from('%%EOF', 'ascii'), Buffer.alloc(2048, 0x41)]))).toBe(false);
    expect(hasPdfEofMarkerAtTail(Buffer.concat([Buffer.alloc(4096, 0x41), Buffer.from('%%EOF\n', 'ascii')]))).toBe(
      true,
    );
  });
});
