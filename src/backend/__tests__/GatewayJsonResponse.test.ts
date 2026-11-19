import { describe, expect, it } from 'vitest';
import { GatewayHtmlResponseError, parseGatewayJson } from '../GatewayJsonResponse';

describe('parseGatewayJson', () => {
  it('rejects an HTML 2xx page without reflecting its contents', () => {
    const body = '<!doctype html><html><body>account detail</body></html>';
    expect(() => parseGatewayJson(body, 'https://gateway.example/v1')).toThrow(
      'The gateway at https://gateway.example/v1 returned HTML, not JSON',
    );
    try {
      parseGatewayJson(body, 'https://gateway.example/v1');
    } catch (error) {
      expect(error).toBeInstanceOf(GatewayHtmlResponseError);
      expect(String(error)).not.toContain('account detail');
    }
  });
});
