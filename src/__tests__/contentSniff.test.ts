import { describe, expect, it } from 'vitest';
import { decodeUtf8Strict, describeSniffRefusal, sniffContent } from '../contentSniff';

/**
 * One verdict per set of bytes, wherever they arrive from.
 *
 * There were three entrances and three different answers. `fetch_url` decoded first and asked what it was
 * afterwards. `read_file` called `toString('utf8')` on anything. The attachment path had a check that could
 * never fire. This module exists so "is this text" is answered once.
 */

const bytes = (...values: number[]) => new Uint8Array(values);
const text = (value: string) => new TextEncoder().encode(value);

describe('signatures settle it on their own', () => {
  it.each([
    ['PDF', bytes(0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37), 'PDF'],
    ['JPEG', bytes(0xff, 0xd8, 0xff, 0xe0), 'JPEG image'],
    ['PNG', bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a), 'PNG image'],
    ['GIF', bytes(0x47, 0x49, 0x46, 0x38, 0x39, 0x61), 'GIF image'],
    ['ZIP', bytes(0x50, 0x4b, 0x03, 0x04, 0x14), 'ZIP archive'],
    ['gzip', bytes(0x1f, 0x8b, 0x08), 'gzip archive'],
    ['ELF', bytes(0x7f, 0x45, 0x4c, 0x46, 0x02), 'ELF executable'],
    ['Windows exe', bytes(0x4d, 0x5a, 0x90, 0x00), 'Windows executable'],
  ])('detects %s and can name it', (_label, input, expected) => {
    const result = sniffContent(input);
    expect(result.binary).toBe(true);
    expect(result.label).toBe(expected);
    // A refusal that names what it found is actionable; "unsupported" alone is not.
    expect(describeSniffRefusal(result)).toContain(expected);
  });

  // A container's identity is not at offset zero, and reading only the first word gets it wrong.
  it('reads the container brand rather than stopping at the magic word', () => {
    const webp = new Uint8Array(16);
    webp.set(text('RIFF'), 0);
    webp.set(text('WEBP'), 8);
    expect(sniffContent(webp)).toMatchObject({ binary: true, label: 'WebP image' });

    const mp4 = new Uint8Array(16);
    mp4.set(text('ftyp'), 4);
    expect(sniffContent(mp4)).toMatchObject({ binary: true, label: 'MP4/QuickTime video' });
  });
});

describe('bytes no signature recognises', () => {
  it('refuses a NUL byte outright, at any length', () => {
    expect(sniffContent(bytes(0x68, 0x69, 0x00))).toMatchObject({ binary: true, reason: 'nul-byte' });
  });

  it('refuses a high ratio of control characters, and only once there is enough to judge', () => {
    const noisy = new Uint8Array(64).fill(0x01);
    expect(sniffContent(noisy)).toMatchObject({ binary: true, reason: 'control-character-ratio' });

    // Four odd bytes in a short file is not evidence of anything.
    expect(sniffContent(bytes(0x01, 0x02, 0x03, 0x04)).binary).toBe(false);
  });

  it('passes ordinary text, including tabs, newlines and non-Latin scripts', () => {
    for (const value of ['hello', 'a\tb\r\nc', '研发团队', '{"k":[1,2]}', '# Title\n\ntext']) {
      expect(sniffContent(text(value)).binary, value).toBe(false);
    }
    expect(sniffContent(new Uint8Array()).binary).toBe(false);
  });
});

/**
 * The check the attachment path believed it was making.
 *
 * `Buffer.toString('utf8')` does not throw on invalid bytes — it substitutes U+FFFD and returns a string
 * that looks like it worked. An unreachable `catch` is how that survived review, so the difference is
 * asserted here rather than assumed.
 */
describe('strict UTF-8 decoding', () => {
  const invalid = bytes(0xc3, 0x28);

  it('refuses what Buffer.toString would have accepted silently', () => {
    expect(Buffer.from(invalid).toString('utf8')).toContain('�');
    expect(() => Buffer.from(invalid).toString('utf8')).not.toThrow();
    expect(decodeUtf8Strict(invalid)).toBeUndefined();
  });

  it('returns the text when the bytes are valid', () => {
    expect(decodeUtf8Strict(text('合同与合规'))).toBe('合同与合规');
  });
});
