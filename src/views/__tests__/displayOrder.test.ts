import { describe, expect, it } from 'vitest';
import { byDisplayName } from '../displayOrder';

describe('catalogue lists are alphabetical', () => {
  it('orders case-insensitively and numerically', () => {
    const names = ['zebra', 'Agent 10', 'apple', 'Agent 9', 'Banana'];
    expect([...names].sort(byDisplayName)).toEqual(['Agent 9', 'Agent 10', 'apple', 'Banana', 'zebra']);
  });
});
