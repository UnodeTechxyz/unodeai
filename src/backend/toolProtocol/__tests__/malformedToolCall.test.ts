import { describe, expect, it } from 'vitest';
import { findMalformedKnownToolCall } from '../malformedToolCall';

const known = new Set(['memory_note', 'read_file', 'dispatch_task']);

describe('findMalformedKnownToolCall', () => {
  it('recognizes whitespace only for known tool names', () => {
    expect(findMalformedKnownToolCall('< memory_note>{"note":"x"}</memory_note>', known))
      .toMatchObject({ name: 'memory_note', markup: '< memory_note>' });
    expect(findMalformedKnownToolCall('< ordinary_text>hello</ordinary_text>', known)).toBeUndefined();
  });

  it('does not treat code or quoted examples as calls', () => {
    expect(findMalformedKnownToolCall('`< memory_note>`', known)).toBeUndefined();
    expect(findMalformedKnownToolCall('```xml\n< memory_note>\n```', known)).toBeUndefined();
    expect(findMalformedKnownToolCall('> < memory_note>', known)).toBeUndefined();
    expect(findMalformedKnownToolCall('use < memory_note> syntax', known)).toBeUndefined();
    expect(findMalformedKnownToolCall('Please use < memory_note>{"note":"x"}</memory_note>', known)).toBeUndefined();
  });

  it('finds any advertised known tool and ignores earlier inline examples', () => {
    expect(findMalformedKnownToolCall('Example: `< memory_note>`\n< dispatch_task agent="dev">', known))
      .toMatchObject({ name: 'dispatch_task' });
  });
});
