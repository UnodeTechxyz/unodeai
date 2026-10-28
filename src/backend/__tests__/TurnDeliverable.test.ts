import { describe, expect, it } from 'vitest';
import { MessageBus } from '../../bus/MessageBus';
import { CONTENT_RECEIPT_END_CHECK_ERROR, CONTENT_RECEIPT_PENDING_ERROR, TeamTools, TeamView } from '../TeamTools';

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
      verbatim: { start: 13, length: 23 },
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
      // UTF-16 code units of the sliced string: A is one, the emoji two.
      verbatim: { start: 26, length: 3 },
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

// v0.9.88 §5.5: content is shown as exact only when the host knows it reached the model.
describe('content receipt delivery proof', () => {
  it('publishes a shown or partial receipt without framing from offset zero', async () => {
    const tools = coordinatorTools();
    tools.beginTurnContentReceipts();
    const receipt = tools.registerTurnContentReceipt('A😀BC');
    await tools.run('publish_content_receipt', { receipt_id: receipt!.id, state: 'partial', visible_characters: 3 });
    expect(tools.takePublishedTurnDelivery()).toMatchObject({ text: 'A😀B', verbatim: { start: 0, length: 4 } });
  });

  it('refuses a receipt still waiting for the host to observe its delivery, and publishes it once observed', async () => {
    const tools = coordinatorTools();
    tools.beginTurnContentReceipts();
    const receipt = tools.registerTurnContentReceipt('exact', 'pending-observation');
    await expect(tools.run('publish_content_receipt', { receipt_id: receipt!.id, state: 'shown' }))
      .resolves.toContain(CONTENT_RECEIPT_PENDING_ERROR);
    expect(tools.takePublishedTurnDelivery()).toBeUndefined();

    expect(tools.markTurnContentReceiptDelivered(receipt!.id)).toBe(true);
    await expect(tools.run('publish_content_receipt', { receipt_id: receipt!.id, state: 'shown' }))
      .resolves.toMatch(/host is publishing receipt/i);
    expect(tools.takePublishedTurnDelivery()).toMatchObject({ text: 'exact', verbatim: { start: 0, length: 5 } });
  });

  it('lets a pending receipt publish a non-delivery reason, which shows no content', async () => {
    const tools = coordinatorTools();
    tools.beginTurnContentReceipts();
    const receipt = tools.registerTurnContentReceipt('exact', 'pending-observation');
    await tools.run('publish_content_receipt', { receipt_id: receipt!.id, state: 'not-delivered', reason: 'The read was cut.' });
    const delivery = tools.takePublishedTurnDelivery();
    expect(delivery).toMatchObject({ text: 'The read was cut.', state: 'not-delivered' });
    expect(delivery?.verbatim).toBeUndefined();
  });

  it('publishes an end-check receipt only with the code from its own last line', async () => {
    const tools = coordinatorTools();
    tools.beginTurnContentReceipts();
    const receipt = tools.registerTurnContentReceipt('exact', 'end-check');
    const other = tools.registerTurnContentReceipt('other', 'end-check');
    expect(receipt?.endCheck).toMatch(/^[0-9a-f]{12}$/);
    expect(other?.endCheck).not.toBe(receipt?.endCheck);

    for (const end_check of [undefined, 'wrong', other!.endCheck]) {
      await expect(tools.run('publish_content_receipt', { receipt_id: receipt!.id, state: 'shown', end_check }))
        .resolves.toContain(CONTENT_RECEIPT_END_CHECK_ERROR);
    }
    expect(tools.takePublishedTurnDelivery()).toBeUndefined();
    await expect(tools.run('publish_content_receipt', { receipt_id: receipt!.id, state: 'shown', end_check: receipt!.endCheck }))
      .resolves.toMatch(/host is publishing receipt/i);
    expect(tools.takePublishedTurnDelivery()).toMatchObject({ text: 'exact' });
  });

  it('never asks a receipt the host delivered itself for a check code', async () => {
    const tools = coordinatorTools();
    tools.beginTurnContentReceipts();
    const receipt = tools.registerTurnContentReceipt('exact');
    expect(receipt?.endCheck).toBeUndefined();
    await expect(tools.run('publish_content_receipt', { receipt_id: receipt!.id, state: 'shown' }))
      .resolves.toMatch(/host is publishing receipt/i);
  });

  it('marks nothing for an id it did not issue', () => {
    const tools = coordinatorTools();
    tools.beginTurnContentReceipts();
    expect(tools.markTurnContentReceiptDelivered('receipt-not-issued')).toBe(false);
  });
});
