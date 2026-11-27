import { it } from 'vitest';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { TEAM_ROSTER_REORDER_SCRIPT } from '../TeamRosterReorderScript';

// Minimal DOM mechanics only; execute the actual shipped event handlers and assert visible order/messages.
it('reorders by pointer and keyboard, cancels Escape, excludes buttons and suppresses post-drag navigation', () => {
function host(initialState: any = { expanded: ['B'] }) {
  const listeners = new Map(); const messages = []; let state = initialState; let focused;
  const classes = () => { const set = new Set(); return { add: name => set.add(name), remove: name => set.delete(name), contains: name => set.has(name) }; };
  const list = []; const container = { classList: classes(), querySelectorAll: () => [...list], appendChild: node => container.insertBefore(node, null), insertBefore(node, before) { const old = list.indexOf(node); if (old >= 0) list.splice(old, 1); const index = before ? list.indexOf(before) : list.length; assert(index >= 0); list.splice(index, 0, node); } };
  for (const id of ['A', 'B', 'C']) {
    const capture = new Set(); const row = { dataset: { agentId: id, agentName: id }, classList: classes(), getBoundingClientRect: () => ({ top: list.indexOf(row) * 100, height: 100 }), setPointerCapture: pointer => capture.add(pointer), hasPointerCapture: pointer => capture.has(pointer), releasePointerCapture: pointer => capture.delete(pointer) };
    row.body = { closest: selector => selector === '.session-open' ? row.body : selector === '.session-item' ? row : null, focus: () => { focused = row.body; } };
    row.action = { closest: selector => selector === '.session-item' ? row : selector.includes('button,') ? row.action : null };
    row.closest = selector => selector === '.session-item' ? row : null; row.querySelector = selector => selector === '.session-open' ? row.body : null; list.push(row);
  }
  const status = { textContent: '' }; const add = (type, fn, capture) => { const records = listeners.get(type) || []; records.push({ fn, capture: !!capture }); listeners.set(type, records); };
  const document = { getElementById: id => id === 'team-container' ? container : status, addEventListener: add };
  vm.runInNewContext(TEAM_ROSTER_REORDER_SCRIPT + '\nwireTeamReorder(7);', { document, window: { addEventListener: (type, fn) => add('window.' + type, fn), innerHeight: 1000, scrollBy() {} }, vscode: { getState: () => state, setState: value => { state = value; }, postMessage: value => messages.push(JSON.parse(JSON.stringify(value))) }, Math });
  const emit = (type, target, extra = {}) => { const event = { target, button: 0, pointerId: 1, clientX: 10, clientY: 10, detail: 1, preventDefault() { this.prevented = true; }, stopImmediatePropagation() { this.stopped = true; }, ...extra }; for (const record of [...listeners.get(type) || []].sort((a, b) => Number(b.capture) - Number(a.capture))) { record.fn(event); if (event.stopped) break; } return event; };
  return { list, messages, status, emit, state: () => state, focused: () => focused, ids: () => list.map(row => row.dataset.agentId) };
}
{
  const h = host(); const a = h.list[0]; h.emit('pointerdown', a.body); h.emit('pointermove', a.body, { clientY: 13 }); h.emit('pointerup', a.body); assert.equal(h.messages.length, 0); assert(!h.emit('click', a.body).stopped);
  h.emit('pointerdown', a.body); h.emit('pointermove', a.body, { clientY: 270 }); assert.deepEqual(h.ids(), ['B', 'C', 'A']); h.emit('pointerup', a.body); assert.deepEqual(h.messages[0], { command: 'reorderAgents', agentIds: ['B', 'C', 'A'], revision: 7 }); assert(h.emit('click', a.body).stopped); assert(h.emit('dblclick', a.body).stopped);
  h.emit('pointerdown', a.body, { clientY: 270 }); h.emit('pointermove', a.body, { clientY: 0 }); assert.deepEqual(h.ids(), ['A', 'B', 'C']); h.emit('pointerup', a.body); assert.equal(h.messages.length, 2); assert.deepEqual(h.state().expanded, ['B']);
}
{
  const h = host(); const a = h.list[0]; h.emit('pointerdown', a.body); h.emit('pointermove', a.body, { clientY: 270 }); h.emit('keydown', a.body, { key: 'Escape' }); assert.deepEqual(h.ids(), ['A', 'B', 'C']); assert.equal(h.messages.length, 0); assert.equal(h.status.textContent, 'Move cancelled.');
  h.emit('pointerdown', a.action); h.emit('pointermove', a.action, { clientY: 270 }); h.emit('pointerup', a.action); assert.deepEqual(h.ids(), ['A', 'B', 'C']); assert.equal(h.messages.length, 0);
  const c = h.list[2]; h.emit('keydown', c.body, { key: 'ArrowUp' }); assert.deepEqual(h.ids(), ['A', 'B', 'C']); assert.equal(h.messages.length, 0);
  h.emit('keydown', c.body, { key: 'ArrowUp', altKey: true }); assert.deepEqual(h.ids(), ['A', 'C', 'B']); assert.equal(h.status.textContent, 'C, position 2 of 3.'); assert.equal(h.focused(), c.body);
  h.emit('keydown', c.body, { key: 'ArrowDown', altKey: true }); assert.deepEqual(h.ids(), ['A', 'B', 'C']); assert.equal(h.messages.length, 2); assert.equal(h.status.textContent, 'C, position 3 of 3.');
}
for (const control of ['move', 'open']) {
  const h = host({ expanded: ['B'], teamOrderFocus: { id: 'B', control } });
  assert.equal(h.focused(), h.list[1].body); assert.equal(h.status.textContent, 'B, position 2 of 3.');
  assert.equal(h.state().teamOrderFocus, undefined); assert.deepEqual(h.state().expanded, ['B']); assert.equal(h.messages.length, 0);
}

});
