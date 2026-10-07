import { describe, expect, it } from 'vitest';

import { renderAgentIcon, sanitizeAgentIcon } from '../agentIcon';

describe('agentIcon', () => {
  it('renders valid data image icons as images', () => {
    const icon = 'data:image/png;base64,eA==';

    expect(renderAgentIcon(icon, 'agent-icon')).toContain('<img');
    expect(renderAgentIcon(icon, 'agent-icon')).toContain(`src="${icon}"`);
  });

  it('renders text icons as escaped text', () => {
    expect(renderAgentIcon('<b>', 'agent-icon')).toBe('<span class="agent-icon">&lt;b&gt;</span>');
  });

  it('rejects invalid data image icons but keeps normal short icons', () => {
    expect(sanitizeAgentIcon('data:image/gif;base64,eA==')).toBeUndefined();
    expect(sanitizeAgentIcon('$(beaker)')).toBe('$(beaker)');
  });
});
