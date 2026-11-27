/*---------------------------------------------------------------------------------------------
 *  UnodeAi - Task history inside the Workbench (v0.9.110 H1, design §5)
 *  The Workbench page carries this view: its markup, style and script are added to the Workbench container only
 *  (ChatViewProvider.getHtml), with VS Code's own colours, fonts and spacing. It is opened by "UnodeAi: Task history"
 *  and the Chat history button through the Workbench state (`taskHistoryRequest`), and talks to the host only through
 *  `{ command: 'taskHistory', message }`: task ids, revisions and filter values out, display text in.
 *--------------------------------------------------------------------------------------------*/

export const TASK_HISTORY_STYLE = `
    /* The page fills the window and scrolls inside it. The Workbench centres each child of the body at most 1040px
       wide; on this fixed layer that centring kept it as tall as its content, so a short window cut off its lower
       controls and the wheel could not reach them (v0.9.110 smoke). Stretched, it is exactly the window's size. */
    #th-view { position: fixed; inset: 0; align-self: stretch; justify-self: stretch; width: auto; z-index: 40; overflow: auto;
      overscroll-behavior: contain; padding: 12px 16px;
      background: var(--vscode-editor-background); color: var(--vscode-foreground);
      font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); }
    #th-view[hidden] { display: none; }
    #th-view h1 { font-size: 1.3em; font-weight: 600; margin: 0 0 8px; }
    #th-view .th-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
    #th-view .th-filters { display: flex; flex-wrap: wrap; gap: 8px; align-items: end; margin-bottom: 10px; }
    #th-view .th-filters label { display: flex; flex-direction: column; gap: 2px; font-size: 0.9em; color: var(--vscode-descriptionForeground); }
    #th-view input, #th-view select { font: inherit; color: var(--vscode-input-foreground); background: var(--vscode-input-background);
      border: 1px solid var(--vscode-input-border, transparent); padding: 3px 6px; }
    #th-view button { font: inherit; color: var(--vscode-button-foreground); background: var(--vscode-button-background); border: none;
      padding: 4px 10px; cursor: pointer; }
    #th-view button.secondary, #th-view .th-row button { color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); }
    #th-view button:focus-visible, #th-view input:focus-visible, #th-view select:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 1px; }
    #th-view .th-row { display: flex; gap: 8px; align-items: center; padding: 4px 0; border-bottom: 1px solid var(--vscode-panel-border); }
    #th-view .th-row .th-open { flex: 1; text-align: left; background: transparent; color: var(--vscode-foreground); }
    #th-view .th-meta { color: var(--vscode-descriptionForeground); font-size: 0.9em; }
    #th-view .th-status { color: var(--vscode-descriptionForeground); margin: 6px 0; }
    #th-view section { margin-top: 12px; padding: 8px 0; border-top: 1px solid var(--vscode-panel-border); }
    #th-view section[hidden] { display: none; }
    #th-view .th-message { margin: 6px 0; white-space: pre-wrap; overflow-wrap: anywhere; }
    #th-view .th-from { font-weight: 600; }
    #th-view .th-actions { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
    #th-view.th-narrow .th-secondary { display: none; }
    #th-view.th-narrow .th-filters { flex-direction: column; align-items: stretch; }
`;

export function taskHistoryMarkup(): string {
  return `
  <div id="th-view" role="region" aria-labelledby="th-title" hidden>
    <div class="th-head"><h1 id="th-title" tabindex="-1">Task history</h1>
      <button id="th-close" type="button" class="secondary">Back to chat</button></div>
    <div class="th-filters" role="search">
      <label for="th-search">Search goals and results<input id="th-search" type="search"></label>
      <label for="th-member">Member<select id="th-member"><option value="">All members</option></select></label>
      <label for="th-terminal">State<select id="th-terminal">
        <option value="">Any state</option><option value="completed">Completed</option><option value="unfinished">Not finished</option>
        <option value="interrupted">Interrupted</option><option value="failed">Failed</option><option value="blocked">Blocked</option>
        <option value="running">Running</option></select></label>
      <label for="th-verification">Verification<select id="th-verification">
        <option value="">Any verification</option><option value="verified">Verified</option><option value="failed">Check failed</option>
        <option value="not-verified">Not verified</option><option value="unknown">Verification unknown</option></select></label>
      <label for="th-since">From<input id="th-since" type="date"></label>
      <label for="th-until">To<input id="th-until" type="date"></label>
      <label for="th-favourites"><span>Favourites only</span><input id="th-favourites" type="checkbox"></label>
      <button id="th-apply" type="button">Search</button>
      <button id="th-storageButton" type="button" class="secondary">Manage storage</button>
    </div>
    <div id="th-status" class="th-status" role="status" aria-live="polite"></div>
    <div id="th-list" role="list" aria-label="Tasks"></div>
    <button id="th-more" type="button" class="secondary" hidden>Show more</button>
    <section id="th-details" aria-labelledby="th-detailsTitle" hidden>
      <h2 id="th-detailsTitle" tabindex="-1"></h2>
      <div id="th-detailsMeta" class="th-meta"></div>
      <div id="th-detailsChecks" class="th-meta"></div>
      <div id="th-detailsCoverage" class="th-meta"></div>
      <h3>Result</h3>
      <div id="th-detailsResult" class="th-message"></div>
      <h3>Conversation</h3>
      <div id="th-detailsTranscript"></div>
      <div class="th-actions">
        <button id="th-resume" type="button">Resume…</button>
        <button id="th-detailsFavourite" type="button" class="secondary" aria-pressed="false">Mark as favourite</button>
        <button id="th-deleteView" type="button" class="secondary">Remove conversation view…</button>
        <button id="th-deleteRestore" type="button" class="secondary">Delete restore points…</button>
        <button id="th-deleteBoth" type="button" class="secondary">Delete both…</button>
        <button id="th-closeDetails" type="button" class="secondary">Close (Esc)</button>
      </div>
    </section>
    <section id="th-storage" aria-labelledby="th-storageTitle" hidden>
      <h2 id="th-storageTitle" tabindex="-1">Manage storage</h2>
      <div id="th-storageLines"></div>
      <div class="th-actions"><button id="th-deleteAll" type="button" class="secondary">Delete all history and restore points…</button>
      <button id="th-closeStorage" type="button" class="secondary">Close</button></div>
    </section>
  </div>`;
}

/**
 * The view's script, run inside the Workbench page's one script, where `vscode` and `initialState` already exist. It
 * keeps to its own elements (`th-` ids) and its own messages.
 */
export function taskHistoryScript(): string {
  return `
    (function () {
      const byId = function (id) { return document.getElementById(id); };
      const view = byId('th-view');
      const list = byId('th-list');
      const status = byId('th-status');
      const details = byId('th-details');
      const storage = byId('th-storage');
      let rows = [];
      let current = undefined;
      let lastOpener = undefined;
      let focusNext = false;
      let seenRequest = 0;

      function post(message) { vscode.postMessage({ command: 'taskHistory', message: message }); }
      function filter() {
        return {
          text: byId('th-search').value || undefined,
          agentId: byId('th-member').value || undefined,
          terminal: byId('th-terminal').value || undefined,
          verification: byId('th-verification').value || undefined,
          since: byId('th-since').value || undefined,
          until: byId('th-until').value || undefined,
          favouritesOnly: byId('th-favourites').checked === true,
        };
      }
      function setFavouriteButton(button, on) {
        button.textContent = on ? '★ Favourite' : '☆ Not a favourite';
        button.setAttribute('aria-pressed', on ? 'true' : 'false');
        button.setAttribute('aria-label', on ? 'Favourite: on. Remove the favourite mark' : 'Favourite: off. Mark as favourite');
      }
      function renderRow(row) {
        const item = document.createElement('div');
        item.className = 'th-row';
        item.setAttribute('role', 'listitem');
        const open = document.createElement('button');
        open.type = 'button';
        open.className = 'th-open';
        open.textContent = row.goal;
        open.setAttribute('aria-label', 'Open task: ' + row.goal);
        open.addEventListener('click', function () { lastOpener = open; post({ command: 'details', historyId: row.historyId }); });
        const who = document.createElement('span');
        who.className = 'th-meta';
        who.textContent = row.member + ' · ' + row.terminal;
        const when = document.createElement('span');
        when.className = 'th-meta th-secondary';
        when.textContent = row.date + (row.verification ? ' · ' + row.verification : '');
        const star = document.createElement('button');
        star.type = 'button';
        setFavouriteButton(star, row.favourite);
        star.addEventListener('click', function () { post({ command: 'favourite', historyId: row.historyId, revision: row.revision, value: !row.favourite }); });
        item.appendChild(open);
        item.appendChild(who);
        item.appendChild(when);
        item.appendChild(star);
        list.appendChild(item);
        return { row: row, open: open, star: star };
      }
      function renderPage(message) {
        if (!message.append) { list.replaceChildren(); rows = []; }
        const first = rows.length;
        message.rows.forEach(function (row) { rows.push(renderRow(row)); });
        const member = byId('th-member');
        if (member.options !== undefined && member.options.length <= 1) {
          message.members.forEach(function (m) {
            const option = document.createElement('option');
            option.value = m.id;
            option.textContent = m.name;
            member.appendChild(option);
          });
        }
        byId('th-more').hidden = !message.more;
        const notes = [];
        if (rows.length === 0) notes.push('No saved tasks yet. A task is saved here when you send a request.');
        if (message.gaps > 0) notes.push('Some history could not be read (' + message.gaps + ' gap(s)); what could be read is shown.');
        if (message.readOnly) notes.push(message.readOnly + '.');
        status.textContent = notes.join(' ');
        if (focusNext && rows[first]) rows[first].open.focus();
        focusNext = false;
      }
      function renderDetails(task, refresh) {
        current = task;
        byId('th-detailsTitle').textContent = task.goal;
        byId('th-detailsMeta').textContent = task.member + ' · ' + task.date + ' · ' + task.terminal + (task.verification ? ' · ' + task.verification : '');
        byId('th-detailsChecks').textContent = task.checks;
        byId('th-detailsCoverage').textContent = task.coverage + '. ' + task.coverageDetail;
        byId('th-detailsResult').textContent = task.conclusion === undefined ? 'No result was recorded.' : task.conclusion;
        const transcript = byId('th-detailsTranscript');
        transcript.replaceChildren();
        task.transcript.forEach(function (message) {
          const block = document.createElement('div');
          block.className = 'th-message';
          const from = document.createElement('span');
          from.className = 'th-from';
          from.textContent = message.from + ': ';
          const text = document.createElement('span');
          text.textContent = message.text;
          block.appendChild(from);
          block.appendChild(text);
          transcript.appendChild(block);
        });
        byId('th-resume').textContent = task.memberExists ? 'Resume…' : 'Resume with another member…';
        setFavouriteButton(byId('th-detailsFavourite'), task.favourite);
        details.hidden = false;
        if (!refresh) byId('th-detailsTitle').focus();
      }
      function closeDetails() {
        details.hidden = true;
        current = undefined;
        if (lastOpener) lastOpener.focus();
      }
      function applyWidth() {
        if ((window.innerWidth || 1000) < 520) view.classList.add('th-narrow'); else view.classList.remove('th-narrow');
      }
      function show() {
        view.hidden = false;
        applyWidth();
        byId('th-title').focus();
        post({ command: 'ready' });
      }
      function requested(state) {
        const request = state && Number(state.taskHistoryRequest);
        if (Number.isSafeInteger(request) && request > seenRequest) { seenRequest = request; show(); }
      }

      byId('th-close').addEventListener('click', function () { view.hidden = true; });
      byId('th-apply').addEventListener('click', function () { post({ command: 'query', filter: filter() }); });
      byId('th-search').addEventListener('keydown', function (event) { if (event.key === 'Enter') post({ command: 'query', filter: filter() }); });
      byId('th-more').addEventListener('click', function () { focusNext = true; post({ command: 'more' }); });
      byId('th-closeDetails').addEventListener('click', closeDetails);
      byId('th-resume').addEventListener('click', function () { if (current) post({ command: 'resume', historyId: current.historyId }); });
      byId('th-detailsFavourite').addEventListener('click', function () {
        if (current) post({ command: 'favourite', historyId: current.historyId, revision: current.revision, value: !current.favourite });
      });
      byId('th-deleteView').addEventListener('click', function () { if (current) post({ command: 'delete', historyId: current.historyId, revision: current.revision, scope: 'view' }); });
      byId('th-deleteRestore').addEventListener('click', function () { if (current) post({ command: 'delete', historyId: current.historyId, revision: current.revision, scope: 'restore-points' }); });
      byId('th-deleteBoth').addEventListener('click', function () { if (current) post({ command: 'delete', historyId: current.historyId, revision: current.revision, scope: 'both' }); });
      byId('th-storageButton').addEventListener('click', function () { post({ command: 'storage' }); });
      byId('th-closeStorage').addEventListener('click', function () { storage.hidden = true; byId('th-storageButton').focus(); });
      byId('th-deleteAll').addEventListener('click', function () { post({ command: 'deleteAll' }); });
      document.addEventListener('keydown', function (event) {
        if (event.key === 'Escape' && !view.hidden && !details.hidden) { if (event.preventDefault) event.preventDefault(); closeDetails(); }
      });
      window.addEventListener('resize', applyWidth);
      window.addEventListener('message', function (event) {
        const envelope = event.data;
        if (!envelope || typeof envelope !== 'object') return;
        if (envelope.command === 'state') { requested(envelope.state); return; }
        if (envelope.command !== 'taskHistory') return;
        const message = envelope.message;
        if (!message || typeof message !== 'object') return;
        if (message.command === 'loading') { status.textContent = 'Loading…'; return; }
        if (message.command === 'page') { renderPage(message); return; }
        // A refresh after a deletion changes only the details still open, never ones the person closed.
        const openHere = function (historyId) { return !details.hidden && !!current && current.historyId === historyId; };
        if (message.command === 'details') {
          if (message.refresh && !openHere(message.task.historyId)) return;
          renderDetails(message.task, !!message.refresh);
          return;
        }
        if (message.command === 'detailsGone') {
          if (message.refresh && !openHere(message.historyId)) return;
          status.textContent = 'That task is no longer in the history.';
          closeDetails();
          return;
        }
        if (message.command === 'favourite') {
          rows.forEach(function (entry) {
            if (entry.row.historyId === message.historyId) { entry.row.favourite = message.favourite; entry.row.revision = message.revision; setFavouriteButton(entry.star, message.favourite); }
          });
          if (current && current.historyId === message.historyId) { current.favourite = message.favourite; current.revision = message.revision; setFavouriteButton(byId('th-detailsFavourite'), message.favourite); }
          if (message.conflict) status.textContent = 'This task changed since it was shown; it is shown as it is now.';
          return;
        }
        if (message.command === 'storage' || message.command === 'report') {
          const lines = byId('th-storageLines');
          lines.replaceChildren();
          message.lines.forEach(function (line) { const p = document.createElement('p'); p.textContent = line; lines.appendChild(p); });
          storage.hidden = false;
          byId('th-storageTitle').focus();
          return;
        }
        if (message.command === 'resumed') { view.hidden = true; return; }
        if (message.command === 'notice') { status.textContent = message.text; }
      });
      requested(typeof initialState === 'undefined' ? undefined : initialState);
    })();
`;
}
