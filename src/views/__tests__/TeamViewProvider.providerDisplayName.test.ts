import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({ commands: { executeCommand: vi.fn() } }));

import { MessageBus } from '../../bus/MessageBus';
import { TeamViewProvider } from '../TeamViewProvider';

const CUSTOM_ID = 'custom:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

describe('TeamViewProvider provider display name', () => {
  it('renders a named custom gateway instead of its opaque provider id', () => {
    const provider = new TeamViewProvider(
      {} as never,
      {
        getAll: () => [{
          id: 'agent-1',
          status: 'stopped',
          restartCount: 0,
          config: {
            id: 'agent-1', name: 'Developer', role: 'developer', model: 'model-a', provider: { providerId: CUSTOM_ID }, systemPrompt: '',
          },
        }],
      } as never,
      new MessageBus(),
      '',
      undefined,
      () => [],
      (providerId) => providerId === CUSTOM_ID ? 'Personal Gateway' : providerId,
    );

    const html = (provider as any)._getHtml({ cspSource: 'test:' });
    expect(html).toContain('Personal Gateway');
    expect(html).not.toContain(`(${CUSTOM_ID})`);
  });

  it('renders consent_required distinctly in the roster and sets a container badge as a subscriber', () => {
    const provider = new TeamViewProvider(
      {} as never,
      {
        getAll: () => [{
          id: 'agent-1', status: 'consent_required', restartCount: 0, consentMessage: 'Reply to the host dialog.',
          config: {
            id: 'agent-1', name: 'Developer', role: 'developer', model: 'model-a', provider: { providerId: CUSTOM_ID }, systemPrompt: '',
          },
        }],
      } as never,
      new MessageBus(),
    );

    const html = (provider as any)._getHtml({ cspSource: 'test:' });
    expect(html).toContain('🔐 Consent required');
    expect(html).toContain('data-command="focusApproval"');

    const view: any = {};
    (provider as any)._view = view;
    provider.setApprovalBadge(2);
    expect(view.badge).toEqual({ value: 2, tooltip: '2 approvals waiting' });
    provider.setApprovalBadge(0);
    expect(view.badge).toBeUndefined();
  });
});
