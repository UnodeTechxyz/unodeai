import { describe, expect, it } from 'vitest';
import { firstRunDestination } from '../firstRunDestination';

describe('firstRunDestination', () => {
  it('takes a new user with no team to the Team panel instead of an empty Workbench', () => {
    expect(firstRunDestination(0)).toBe('team-panel');
  });

  it('uses the chat routing path once a team exists so the Workbench preference is honoured', () => {
    expect(firstRunDestination(1)).toBe('chat');
    expect(firstRunDestination(4)).toBe('chat');
  });
});
