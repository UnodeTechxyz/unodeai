import { describe, it, expect } from 'vitest';
import { BoundedStderrTail, minimalInheritedEnv, normalizeMcpToolResult } from '../RealMcpClient';

describe('minimalInheritedEnv', () => {
  it('keeps OS launch essentials and drops unrelated secrets', () => {
    const env = minimalInheritedEnv({
      PATH: 'C:\\bin',
      SystemRoot: 'C:\\Windows',
      TEMP: 'C:\\Temp',
      OPENAI_API_KEY: 'secret',
      GITHUB_TOKEN: 'secret',
    });

    expect(env.PATH).toBe('C:\\bin');
    expect(env.SystemRoot).toBe('C:\\Windows');
    expect(env.TEMP).toBe('C:\\Temp');
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.GITHUB_TOKEN).toBeUndefined();
  });
});

describe('MCP result normalization', () => {
  it('passes text through and summarizes binary/resource content without bytes', () => {
    const result = normalizeMcpToolResult({
      content: [
        { type: 'text', text: 'created issue 42' },
        { type: 'image', mimeType: 'image/png', data: Buffer.from('secret pixels').toString('base64') },
        { type: 'resource', resource: { uri: 'file:///report.txt', text: 'hello' } },
      ],
    });
    expect(result).toEqual({
      output: 'created issue 42\n[image: image/png, 13 bytes]\n[resource: file:///report.txt, 5 bytes]',
      isError: false,
    });
    expect(result.output).not.toContain(Buffer.from('secret pixels').toString('base64'));
  });

  it('uses structuredContent when there is no text and retains the protocol error flag', () => {
    expect(normalizeMcpToolResult({
      isError: true,
      content: [{ type: 'image', mimeType: 'image/png', data: 'YQ==' }],
      structuredContent: { code: 'not_allowed', retryable: false },
    })).toEqual({
      output: '[image: image/png, 1 bytes]\n[structured content from MCP server]\n{"code":"not_allowed","retryable":false}',
      isError: true,
    });
  });
});

describe('bounded MCP stderr', () => {
  it('retains only a bounded plain-text tail and redacts resolved secret values', () => {
    const tail = new BoundedStderrTail(['fixture-secret'], 2, 80);
    tail.append('old line\nfixture-secret failed\nlast line\n');
    expect(tail.text()).toBe('last line');
    const redacted = new BoundedStderrTail(['fixture-secret'], 20, 80);
    redacted.append('token=fixture-secret\nconnection closed');
    expect(redacted.text()).toContain('token=[redacted]');
    expect(redacted.text()).not.toContain('fixture-secret');
  });

  it('redacts a resolved secret even when the child splits it across stderr chunks', () => {
    const tail = new BoundedStderrTail(['fixture-secret']);
    tail.append('token=fixture-');
    tail.append('secret failed');
    expect(tail.text()).toBe('token=[redacted] failed');
  });

  it('keeps ordinary environment literals while redacting only resolved SecretStorage values', () => {
    const tail = new BoundedStderrTail(['fixture-secret']);
    tail.append('DEBUG=1 TOKEN=fixture-secret attempt 1');
    expect(tail.text()).toBe('DEBUG=1 TOKEN=[redacted] attempt 1');
  });

  it('does not reveal a partial secret when startup fails between chunks', () => {
    const tail = new BoundedStderrTail(['fixture-secret']);
    tail.append('token=fixture-');
    expect(tail.text()).toBe('token=[redacted]');
  });
});
