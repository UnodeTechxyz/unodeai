import { describe, expect, it } from 'vitest';
import { composeUserContent, composeUserText } from '../OpenAICompatBackend';
import { composeUserTextAttachments, MAX_INLINE_IMAGE_BYTES, splitUserAttachments, validateUserAttachments } from '../../attachments';

const b64 = (text: string): string => Buffer.from(text, 'utf8').toString('base64');

/**
 * The binary check that could never fire.
 *
 * `decodeTextAttachment` inferred "binary" from a thrown exception, and `Buffer.toString('utf8')` does not
 * throw on invalid bytes — it substitutes U+FFFD. The `(binary attachment, not inlined)` branch was
 * unreachable from the day it was written, and nothing went wrong only because the MIME allowlist in front
 * of it kept catching what it was meant to catch second.
 *
 * **This test fails against the code as it was.** That is the only kind worth writing for a check that never
 * fired: a check nobody can observe failing is not a check.
 */
describe('an attachment that is not text', () => {
  const rawBase64 = (bytes: number[]) => Buffer.from(Uint8Array.from(bytes)).toString('base64');
  const attach = (name: string, dataBase64: string) => [{
    name, mime: 'text/plain', kind: 'file', dataBase64, size: 64,
  }];

  it('is reported as binary rather than inlined as replacement characters', () => {
    // A PNG renamed .txt walks past the MIME allowlist, which only reads the declared type.
    const png = rawBase64([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01, 0x02]);
    const { attachments, errors } = validateUserAttachments(attach('notes.txt', png));
    expect(errors).toEqual([]);

    const text = composeUserText('look at this', { userAttachments: attachments } as never);
    expect(text).toContain('(binary attachment, not inlined)');
    expect(text).not.toContain('\uFFFD');
  });

  it('treats bytes that are merely invalid UTF-8 the same way', () => {
    const { attachments } = validateUserAttachments(attach('notes.txt', rawBase64([0xc3, 0x28, 0xc3, 0x28])));
    expect(composeUserText('x', { userAttachments: attachments } as never))
      .toContain('(binary attachment, not inlined)');
  });

  it('still inlines real text, in any script', () => {
    const { attachments } = validateUserAttachments(
      attach('notes.txt', Buffer.from('研发团队 notes', 'utf8').toString('base64')),
    );
    expect(composeUserText('x', { userAttachments: attachments } as never)).toContain('研发团队 notes');
  });
});

describe('user attachments', () => {
  it('composeUserText inlines a text attachment', () => {
    const text = composeUserText('Summarize this.', {
      userAttachments: [{
        name: 'notes.md',
        mime: 'text/markdown',
        kind: 'file',
        dataBase64: b64('# Heading\nImportant detail'),
        size: 26,
      }],
    });

    expect(text).toContain('Attached text files');
    expect(text).toContain('### notes.md');
    expect(text).toContain('# Heading');
    expect(text).toContain('Important detail');
  });

  it('OpenAICompat user content includes image_url parts for image attachments', () => {
    const content = composeUserContent('Describe this image.', {
      userAttachments: [{
        name: 'screen.png',
        mime: 'image/png',
        kind: 'image',
        dataBase64: 'iVBORw0KGgo=',
        size: 10,
      }],
    });

    expect(Array.isArray(content)).toBe(true);
    expect(content).toEqual([
      { type: 'text', text: 'Describe this image.' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' } },
    ]);
  });

  it('accepts a local PDF for the asset boundary without inlining its bytes or filename', () => {
    const filename = 'private-board-pack.pdf';
    const source = '%PDF-1.7\nnot model context';
    const { attachments, errors } = validateUserAttachments([{
      name: filename,
      // Declared MIME is metadata; ContentAssetStore will adjudicate the bytes.
      mime: 'application/octet-stream',
      kind: 'pdf',
      dataBase64: b64(source),
      size: 1,
    }]);

    expect(errors).toEqual([]);
    expect(attachments).toHaveLength(1);
    const text = composeUserText('Read the attachment.', { userAttachments: attachments });
    expect(text).not.toContain(filename);
    expect(text).not.toContain(source);
    expect(composeUserContent('Read the attachment.', { userAttachments: attachments }))
      .toBe('Read the attachment.');
  });

  it('v0.9.99: host validation takes a file past the former 10 MB limit, counts its size from its bytes, and still refuses a disallowed type', () => {
    const past = Buffer.concat([Buffer.alloc(10 * 1024 * 1024, 0x61), Buffer.from('!')]);
    const result = validateUserAttachments([
      // A reported size is never the decision, small or large: the bytes received are.
      { name: 'huge.txt', mime: 'text/plain', kind: 'file', size: 3, dataBase64: past.toString('base64') },
      { name: 'claims-huge.txt', mime: 'text/plain', kind: 'file', size: 50 * 1024 * 1024, dataBase64: b64('small') },
      { name: 'run.exe', mime: 'application/x-msdownload', kind: 'file', size: 12, dataBase64: b64('binary') },
    ]);

    expect(result.attachments.map((attachment) => [attachment.name, attachment.size])).toEqual([
      ['huge.txt', past.byteLength], ['claims-huge.txt', 5],
    ]);
    expect(Buffer.from(result.attachments[0].dataBase64, 'base64').equals(past)).toBe(true);
    expect(result.errors).toEqual(['run.exe is not a supported text file type.']);
  });

  it('v0.9.99: an image too large for one model request is attached and named in the turn, never put in a request', () => {
    const large = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(MAX_INLINE_IMAGE_BYTES)]);
    const [small, big] = validateUserAttachments([
      { name: 'small.png', mime: 'image/png', kind: 'image', dataBase64: b64('png') },
      { name: 'big.png', mime: 'image/png', kind: 'image', dataBase64: large.toString('base64') },
    ]).attachments;
    const parts = splitUserAttachments([small, big]);
    expect(parts.images).toEqual([small]);
    expect(parts.largeImages).toEqual([big]);
    // An image exactly at the limit is still shown.
    const atLimit = validateUserAttachments([
      { name: 'edge.png', mime: 'image/png', kind: 'image', dataBase64: large.subarray(0, MAX_INLINE_IMAGE_BYTES).toString('base64') },
    ]).attachments;
    expect(splitUserAttachments(atLimit).images).toEqual(atLimit);
    const text = composeUserTextAttachments([small, { ...big, contentAssetId: 'content-7' }]).text;
    expect(text).toContain('[Image big.png (10.0 MB) is attached, but it was not shown to you');
    expect(text).toContain('save_attachment({ asset_id: "content-7", path })');
    expect(text).not.toContain('small.png');
    // The OpenAI-compatible route puts only the small image into the request.
    const content = composeUserContent('Look.', { userAttachments: [small, big] });
    expect(JSON.stringify(content)).toContain(`data:image/png;base64,${small.dataBase64}`);
    expect(JSON.stringify(content)).not.toContain(big.dataBase64.slice(0, 4096));
    expect(JSON.stringify(content)).toContain('[Image big.png (10.0 MB) is attached');
  });
});
