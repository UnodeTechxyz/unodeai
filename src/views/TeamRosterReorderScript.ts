// Included inside the Team panel's existing nonce-protected inline script.
export const TEAM_ROSTER_REORDER_SCRIPT = String.raw`
    function wireTeamReorder(revision) {
      const container = document.getElementById('team-container');
      const status = document.getElementById('roster-order-status');
      if (!container) return;
      const rows = () => Array.from(container.querySelectorAll('.session-item'));
      const ids = () => rows().map(row => row.dataset.agentId);
      const say = text => { if (status) status.textContent = text; };
      const position = row => say(row.dataset.agentName + ', position ' + (rows().indexOf(row) + 1) + ' of ' + rows().length + '.');
      let pending; let suppressClick = false;
      function rememberFocus(row, control) {
        vscode.setState(Object.assign({}, vscode.getState(), { teamOrderFocus: { id: row.dataset.agentId, control } }));
      }
      function commit(row, original, control) {
        const ordered = ids(); position(row);
        if (ordered.every((id, index) => id === original[index])) return;
        rememberFocus(row, control);
        vscode.postMessage({ command: 'reorderAgents', agentIds: ordered, revision });
      }
      function clear() {
        if (pending) {
          pending.row.classList.remove('roster-moving');
          if (pending.row.hasPointerCapture && pending.row.hasPointerCapture(pending.pointerId)) pending.row.releasePointerCapture(pending.pointerId);
        }
        container.classList.remove('roster-dragging');
        rows().forEach(row => row.classList.remove('roster-drop-before', 'roster-drop-after'));
        pending = undefined;
      }
      function cancel() {
        if (!pending) return;
        if (pending.moving) {
          pending.original.forEach(row => container.appendChild(row));
          suppressClick = true; say('Move cancelled.');
        }
        clear();
      }
      document.addEventListener('pointerdown', event => {
        suppressClick = false;
        if (event.button !== 0 || event.target.closest('button,a,input,textarea,select,[contenteditable="true"]')) return;
        const body = event.target.closest('.session-open'); const row = body && body.closest('.session-item');
        if (!row) return;
        pending = { row, x: event.clientX, y: event.clientY, pointerId: event.pointerId, original: rows(), moving: false };
      });
      document.addEventListener('pointermove', event => {
        if (!pending || event.pointerId !== pending.pointerId) return;
        if (!pending.moving) {
          if (Math.hypot(event.clientX - pending.x, event.clientY - pending.y) < 6) return;
          pending.moving = true; pending.row.classList.add('roster-moving'); container.classList.add('roster-dragging');
          if (pending.row.setPointerCapture) pending.row.setPointerCapture(event.pointerId);
        }
        event.preventDefault();
        rows().forEach(row => row.classList.remove('roster-drop-before', 'roster-drop-after'));
        const other = rows().filter(row => row !== pending.row);
        const before = other.find(row => { const rect = row.getBoundingClientRect(); return event.clientY < rect.top + rect.height / 2; });
        container.insertBefore(pending.row, before || null);
        if (before) before.classList.add('roster-drop-before');
        else if (other.length) other[other.length - 1].classList.add('roster-drop-after');
        if (event.clientY < 24) window.scrollBy(0, -16);
        else if (event.clientY > window.innerHeight - 24) window.scrollBy(0, 16);
      });
      document.addEventListener('pointerup', event => {
        if (!pending || event.pointerId !== pending.pointerId) return;
        const drag = pending;
        if (drag.moving) { suppressClick = true; commit(drag.row, drag.original.map(row => row.dataset.agentId), 'open'); }
        clear();
      });
      document.addEventListener('pointercancel', cancel);
      window.addEventListener('blur', cancel);
      document.addEventListener('dragstart', event => { if (event.target.closest('.session-open')) event.preventDefault(); });
      ['click', 'dblclick'].forEach(type => document.addEventListener(type, event => {
        if (suppressClick && event.detail !== 0) { event.preventDefault(); event.stopImmediatePropagation(); }
      }, true));
      document.addEventListener('keydown', event => {
        if (event.key === 'Escape' && pending) { event.preventDefault(); cancel(); return; }
        const body = event.target.closest('.session-open');
        if (!body || !event.altKey || !['ArrowUp', 'ArrowDown'].includes(event.key)) return;
        event.preventDefault(); const row = body.closest('.session-item'); const original = ids(); const ordered = rows(); const index = ordered.indexOf(row);
        if (event.key === 'ArrowUp' && index > 0) container.insertBefore(row, ordered[index - 1]);
        if (event.key === 'ArrowDown' && index < ordered.length - 1) container.insertBefore(ordered[index + 1], row);
        body.focus(); commit(row, original, 'open');
      });
      const focus = (vscode.getState() || {}).teamOrderFocus;
      if (focus) {
        const row = rows().find(row => row.dataset.agentId === focus.id);
        const control = row && row.querySelector('.session-open');
        if (control) { control.focus(); position(row); }
        vscode.setState(Object.assign({}, vscode.getState(), { teamOrderFocus: undefined }));
      }
    }
`;
