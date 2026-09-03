import { describe, expect, it } from 'vitest';
import { describeMediaEgress, validateMediaEgressRequest } from '../MediaEgress';

describe('media egress preview', () => {
  it('contains only the destination, class, bounded size/count and optional estimate', () => {
    const request = validateMediaEgressRequest({
      host: 'vision.example.test', provider: 'Example Vision', kind: 'vision', mediaClass: 'image', byteCount: 1024, frameCount: 1,
    });
    expect(describeMediaEgress(request)).toContain('vision.example.test');
    expect(describeMediaEgress(request)).toContain('1,024 bytes');
    expect(describeMediaEgress(request)).toContain('unavailable');
    expect(JSON.stringify(request)).not.toContain('base64');
  });

  it('rejects unsafe or unbounded-looking consent payloads', () => {
    expect(() => validateMediaEgressRequest({ host: '', provider: 'x', kind: 'vision', mediaClass: 'image', byteCount: 1 })).toThrow();
    expect(() => validateMediaEgressRequest({ host: 'x', provider: 'x', kind: 'vision', mediaClass: 'image', byteCount: -1 })).toThrow();
  });
});
