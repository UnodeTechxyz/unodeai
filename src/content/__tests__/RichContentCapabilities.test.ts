import { describe, expect, it } from 'vitest';
import { unsupportedRichContentMessage } from '../RichContentCapabilities';

describe('RichContentCapabilities v1 boundary', () => {
  it('does not advertise image or video understanding before a separate capability exists', () => {
    expect(unsupportedRichContentMessage('image')).toMatch(/not converted to binary text|not uploaded/i);
    expect(unsupportedRichContentMessage('video')).toMatch(/not transcribed|not uploaded/i);
  });
});
