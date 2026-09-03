import { describe, expect, it } from 'vitest';
import { MessageBus } from '../../bus/MessageBus';
import { TeamTools, TeamView } from '../TeamTools';

const view: TeamView = {
  list: () => [{ id: 'pm', role: 'pm', name: 'PM', status: 'running' }],
  resolve: () => undefined,
};

function coordinatorTools(): TeamTools {
  return new TeamTools('pm', view, new MessageBus());
}

describe('host-published content receipts', () => {
  it('publishes the exact host-held shown receipt as assistant text without asking the model to retype it', async () => {
    const tools = coordinatorTools();
    tools.beginTurnContentReceipts();
    const receipt = tools.registerTurnContentReceipt('first line\r\nsecond line');
    expect(receipt?.id).toMatch(/^receipt-/);

    await expect(tools.run('publish_content_receipt', {
      receipt_id: receipt!.id,
      state: 'shown',
      framing: 'Here it is:',
    })).resolves.toMatch(/host is publishing receipt/i);
    expect(tools.takePublishedTurnDelivery()).toEqual({
      text: 'Here it is:\n\nfirst line\r\nsecond line',
      state: 'shown',
      receiptId: receipt!.id,
    });
  });

  it('publishes a partial host prefix in Unicode code points, never a model-supplied slice', async () => {
    const tools = coordinatorTools();
    tools.beginTurnContentReceipts();
    const receipt = tools.registerTurnContentReceipt('A😀BC');

    await expect(tools.run('publish_content_receipt', {
      receipt_id: receipt!.id,
      state: 'partial',
      visible_characters: 2,
      framing: 'The available prefix is:',
    })).resolves.toMatch(/first 2 Unicode code point/i);
    expect(tools.takePublishedTurnDelivery()).toEqual({
      text: 'The available prefix is:\n\nA😀',
      state: 'partial',
      receiptId: receipt!.id,
      visibleCharacters: 2,
    });
  });

  it('refuses non-integral, empty, and whole-receipt partial ranges without rounding', async () => {
    const tools = coordinatorTools();
    tools.beginTurnContentReceipts();
    const receipt = tools.registerTurnContentReceipt('A😀BC');

    for (const visible_characters of [1.5, 0, 4]) {
      await expect(tools.run('publish_content_receipt', {
        receipt_id: receipt!.id,
        state: 'partial',
        visible_characters,
      })).resolves.toMatch(/safe integer from 1 through 3.*not rounded/i);
    }
    expect(tools.takePublishedTurnDelivery()).toBeUndefined();
  });

  it('allows a rejected attempt to name another current-turn receipt before terminal publication succeeds', async () => {
    const tools = coordinatorTools();
    tools.beginTurnContentReceipts();
    const first = tools.registerTurnContentReceipt('first');
    const second = tools.registerTurnContentReceipt('second');

    await expect(tools.run('publish_content_receipt', {
      receipt_id: first!.id,
      state: 'partial',
      visible_characters: 5,
    })).resolves.toMatch(/safe integer/i);
    await expect(tools.run('publish_content_receipt', {
      receipt_id: second!.id,
      state: 'shown',
    })).resolves.toMatch(/publishing receipt/i);
    expect(tools.takePublishedTurnDelivery()).toMatchObject({
      text: 'second', state: 'shown', receiptId: second!.id,
    });
  });

  // E6 / §3b: a terminal state is write-once for the turn. This must fail if the accepted-delivery
  // guard is removed: the second valid payload would otherwise replace the first one after consumption.
  it('E6 refuses a second terminal publication and retains the first accepted state', async () => {
    const tools = coordinatorTools();
    tools.beginTurnContentReceipts();
    const receipt = tools.registerTurnContentReceipt('exact source');

    await expect(tools.run('publish_content_receipt', {
      receipt_id: receipt!.id,
      state: 'shown',
    })).resolves.toMatch(/Publishing receipt/i);
    expect(tools.takePublishedTurnDelivery()).toMatchObject({
      text: 'exact source', state: 'shown', receiptId: receipt!.id,
    });
    await expect(tools.run('publish_content_receipt', {
      receipt_id: receipt!.id,
      state: 'not-delivered',
      reason: 'A contradictory second terminal state is not allowed.',
    })).resolves.toMatch(/terminal content receipt was already accepted/i);
    expect(tools.takePublishedTurnDelivery()).toBeUndefined();
  });

  it('requires a current-turn receipt and a reason for not-delivered', async () => {
    const tools = coordinatorTools();
    tools.beginTurnContentReceipts();
    const receipt = tools.registerTurnContentReceipt('one');
    await expect(tools.run('publish_content_receipt', {
      receipt_id: 'receipt-not-issued', state: 'shown',
    })).resolves.toMatch(/unknown or foreign/i);
    await expect(tools.run('publish_content_receipt', {
      receipt_id: receipt!.id, state: 'not-delivered',
    })).resolves.toMatch(/requires a concrete reason/i);

    tools.beginTurnContentReceipts();
    await expect(tools.run('publish_content_receipt', {
      receipt_id: receipt!.id, state: 'shown',
    })).resolves.toMatch(/unknown or foreign/i);
  });

  it('exposes one optional receipt surface and removes the model-retyping pair', () => {
    const names = coordinatorTools().specs().map((spec) => spec.function.name);
    expect(names).toContain('publish_content_receipt');
    expect(names).not.toContain('declare_turn_deliverable');
    expect(names).not.toContain('deliver_declared_content');
    expect(names).toContain('dispatch_task');
    expect(names).toContain('close_assignment');
  });
});
