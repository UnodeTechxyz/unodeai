import { describe, expect, it } from 'vitest';
import { restoreTeamRoster } from '../TeamRosterRestore';

describe('restoreTeamRoster', () => {
  it('replaces and persists the roster on success', async () => {
    let active = ['old'];
    let persisted = 0;
    await restoreTeamRoster(['one', 'two'], {
      current: () => active,
      removeAll: async () => { active = []; },
      createLoaded: (member) => { active.push(member); },
      createRollback: (member) => { active.push(member); },
      persist: async () => { persisted++; },
    });
    expect(active).toEqual(['one', 'two']);
    expect(persisted).toBe(1);
  });

  it('removes a partial load and restores the exact outgoing roster when creation fails', async () => {
    const outgoing = [{ id: 'old', permission: 'full' }];
    let active = [...outgoing];
    let persisted = 0;
    expect.assertions(3);
    await expect(restoreTeamRoster([{ id: 'one' }, { id: 'bad' }], {
      current: () => active,
      removeAll: async () => { active = []; },
      createLoaded: (member) => {
        if (member.id === 'bad') throw new Error('invalid member');
        active.push(member);
      },
      createRollback: (member) => { active.push(member); },
      persist: async () => { persisted++; },
    })).rejects.toThrow('invalid member');
    expect(active).toEqual(outgoing);
    expect(persisted).toBe(1);
  });
});
