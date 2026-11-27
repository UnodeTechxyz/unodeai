import { describe, it, expect } from 'vitest';
import { StreamJsonParser } from '../StreamJsonParser';

describe('StreamJsonParser', () => {
  it('parses one complete line', () => {
    const p = new StreamJsonParser();
    const { objects } = p.push('{"type":"system","subtype":"init"}\n');
    expect(objects).toEqual([{ type: 'system', subtype: 'init' }]);
  });

  it('buffers a line split across two chunks', () => {
    const p = new StreamJsonParser();
    expect(p.push('{"type":"assi').objects).toEqual([]);
    const { objects } = p.push('stant","x":1}\n');
    expect(objects).toEqual([{ type: 'assistant', x: 1 }]);
  });

  it('emits multiple objects from one chunk and keeps the trailing partial', () => {
    const p = new StreamJsonParser();
    const { objects } = p.push('{"a":1}\n{"b":2}\n{"c":');
    expect(objects).toEqual([{ a: 1 }, { b: 2 }]);
    // Trailing partial is retained until completed.
    expect(p.push('3}\n').objects).toEqual([{ c: 3 }]);
  });

  it('routes non-JSON lines to garbage without throwing', () => {
    const p = new StreamJsonParser();
    const { objects, garbage } = p.push('npm warn deprecated\n{"ok":true}\n');
    expect(objects).toEqual([{ ok: true }]);
    expect(garbage).toEqual(['npm warn deprecated']);
  });

  it('flush() returns a final newline-less object', () => {
    const p = new StreamJsonParser();
    p.push('{"partial":');
    expect(p.flush().objects).toEqual([]); // invalid JSON -> garbage
    const p2 = new StreamJsonParser();
    p2.push('{"done":true}');
    expect(p2.flush().objects).toEqual([{ done: true }]);
  });
});
