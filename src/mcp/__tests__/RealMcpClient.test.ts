import { describe, it, expect } from 'vitest';
import { minimalInheritedEnv } from '../RealMcpClient';

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
