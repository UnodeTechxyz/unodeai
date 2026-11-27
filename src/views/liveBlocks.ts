/**
 * Source injected into the chat webview for live markdown-block rendering. Keeping this here (instead
 * of hand-copying it inside ChatViewProvider.getHtml) lets unit tests exercise the exact code that
 * production runs.
 */
export const WEBVIEW_LIVE_BLOCKS_SOURCE = String.raw`
    function replaceLiveBlocks(root, replaceFrom, blocks) {
      const requestedKeep = Math.max(0, Math.min(Number(replaceFrom) || 0, root.children.length));
      const nextBlocks = blocks || [];
      const renderedBlocks = root.__unodeLiveBlocks || [];
      let keep = requestedKeep;
      let tail = nextBlocks;

      // A paced open paragraph is re-parsed into a new block object on every animation frame. Preserve
      // its element only when the already-rendered spans are structurally unchanged and its trailing
      // text span grew by a prefix. This keeps a selection inside inline markup alive without treating a
      // Markdown reparse (for example, text becoming emphasis) as an append-only update.
      if (keep < root.children.length
        && renderedBlocks[keep]
        && nextBlocks[0]
        && extendTextPrefixBlock(root.children[keep], renderedBlocks[keep], nextBlocks[0])) {
        keep++;
        tail = nextBlocks.slice(1);
      }

      while (root.children.length > keep) {
        root.removeChild(root.lastChild);
      }
      const renderedTail = renderBlocks(tail);
      while (renderedTail.firstChild) {
        root.appendChild(renderedTail.firstChild);
      }
      root.__unodeLiveBlocks = renderedBlocks.slice(0, requestedKeep).concat(nextBlocks);
      root.dataset.blockCount = String(root.children.length);
    }

    function extendTextPrefixBlock(node, previous, next) {
      if (!previous || !next || previous.type !== next.type) return false;
      if (previous.type !== 'paragraph' && previous.type !== 'heading') return false;
      const previousSpans = previous.spans || [];
      const nextSpans = next.spans || [];
      if (previousSpans.length === 0 || previousSpans.length > nextSpans.length) return false;
      // A file link's result note and its actions button are the page's own, beside its link; neither is a span of the reply.
      const kids = Array.prototype.filter.call(node.childNodes, (child) => !isFileLinkNote(child) && !isFileLinkMore(child));
      if (kids.length !== previousSpans.length) return false;

      let grownAt = -1;
      for (let index = 0; index < previousSpans.length; index++) {
        const oldSpan = previousSpans[index];
        const newSpan = nextSpans[index];
        if (!sameSpan(oldSpan, newSpan)) {
          // Only the boundary text span can grow. A change to an existing element's type, text, or href
          // is a Markdown reparse, and preserving the old node would render stale structure.
          if (index !== previousSpans.length - 1
            || oldSpan.type !== 'text'
            || newSpan.type !== 'text'
            || typeof oldSpan.text !== 'string'
            || typeof newSpan.text !== 'string'
            || !newSpan.text.startsWith(oldSpan.text)) return false;
          grownAt = index;
        }
        if (!spanMatchesNode(kids[index], oldSpan)) return false;
      }
      if (grownAt < 0) return false;

      kids[grownAt].textContent = nextSpans[grownAt].text;
      appendSpans(node, nextSpans.slice(previousSpans.length));
      return true;
    }

    function sameSpan(previous, next) {
      return !!previous && !!next
        && previous.type === next.type
        && previous.text === next.text
        && previous.href === next.href
        && previous.ref === next.ref
        && previous.target === next.target
        && previous.note === next.note;
    }

    function spanMatchesNode(node, span) {
      if (!node || !span) return false;
      if (span.type === 'linkRefused') {
        return node.nodeType === 1 && node.className === 'md-link-refused' && node.dataset.linkText === span.text;
      }
      if (node.textContent !== (span.text || '')) return false;
      if (span.type === 'text') return node.nodeType === 3;
      if (node.nodeType !== 1) return false;
      const tags = { strong: 'strong', em: 'em', code: 'code', link: 'a', fileLink: span.ref ? 'a' : 'span' };
      if (String(node.tagName || '').toLowerCase() !== tags[span.type]) return false;
      if (span.type === 'fileLink') return (node.dataset.fileRef || '') === (span.ref || '');
      return span.type !== 'link' || node.href === span.href;
    }

    function renderBlocks(blocks) {
      const root = document.createElement('div');
      root.className = 'md';
      for (const block of blocks) {
        if (block.type === 'heading') {
          const h = document.createElement('h' + block.level);
          appendSpans(h, block.spans);
          root.appendChild(h);
        } else if (block.type === 'paragraph') {
          const p = document.createElement('p');
          appendSpans(p, block.spans);
          root.appendChild(p);
        } else if (block.type === 'list') {
          const ul = document.createElement('ul');
          for (const item of block.items) {
            const li = document.createElement('li');
            appendSpans(li, item);
            ul.appendChild(li);
          }
          root.appendChild(ul);
        } else if (block.type === 'code') {
          root.appendChild(renderCode(block));
        } else if (block.type === 'verbatim') {
          root.appendChild(renderVerbatim(block));
        } else if (block.type === 'table') {
          const table = document.createElement('table');
          const thead = document.createElement('thead');
          const htr = document.createElement('tr');
          (block.header || []).forEach((cell, idx) => {
            const th = document.createElement('th');
            if (block.align && block.align[idx]) th.style.textAlign = block.align[idx];
            appendSpans(th, cell);
            htr.appendChild(th);
          });
          thead.appendChild(htr);
          table.appendChild(thead);
          const tbody = document.createElement('tbody');
          for (const row of (block.rows || [])) {
            const tr = document.createElement('tr');
            (row || []).forEach((cell, idx) => {
              const td = document.createElement('td');
              if (block.align && block.align[idx]) td.style.textAlign = block.align[idx];
              appendSpans(td, cell);
              tr.appendChild(td);
            });
            tbody.appendChild(tr);
          }
          table.appendChild(tbody);
          root.appendChild(table);
        }
      }
      return root;
    }

    function appendSpans(parent, spans) {
      for (const span of spans) {
        if (span.type === 'text') {
          parent.appendChild(document.createTextNode(span.text));
        } else if (span.type === 'strong') {
          const node = document.createElement('strong');
          node.textContent = span.text;
          parent.appendChild(node);
        } else if (span.type === 'em') {
          const node = document.createElement('em');
          node.textContent = span.text;
          parent.appendChild(node);
        } else if (span.type === 'code') {
          const node = document.createElement('code');
          node.className = 'inline';
          node.textContent = span.text;
          parent.appendChild(node);
        } else if (span.type === 'link') {
          const node = document.createElement('a');
          node.href = span.href;
          node.textContent = span.text;
          parent.appendChild(node);
        } else if (span.type === 'fileLink') {
          const link = renderFileLink(span);
          parent.appendChild(link);
          // v0.9.108 (L1): a file the reply links to offers its actions from a button right after the link.
          const more = span.ref ? fileLinkMoreButton(link, span) : null;
          if (more) parent.appendChild(more);
          // A click's result is kept by link id, so a link rendered again (a reparse while the reply streams, or the
          // finished reply replacing the live one) shows it again.
          const kept = span.ref ? keptFileLinkResult(span.ref) : null;
          if (kept) parent.appendChild(fileLinkNote(link, kept));
        } else if (span.type === 'linkRefused') {
          parent.appendChild(renderRefusedLink(span));
        }
      }
    }

    // v0.9.97: a file link in a reply carries only the id the host gave it. Activating it, by mouse or by Enter,
    // asks the host to open it; the page names no path, and has no href to follow. Without an id (an Analysis card,
    // a file preview) there is no reply to resolve it against, and it is text.
    function renderFileLink(span) {
      if (!span.ref) {
        const text = document.createElement('span');
        text.className = 'md-file-ref';
        text.title = span.target;
        text.textContent = span.text;
        return text;
      }
      const link = document.createElement('a');
      link.className = 'md-file-link';
      link.dataset.fileRef = span.ref;
      link.setAttribute('role', 'link');
      link.tabIndex = 0;
      link.title = 'Open ' + span.target;
      link.textContent = span.text;
      link.addEventListener('click', (event) => {
        event.preventDefault();
        activateFileLink(link, requestFileLinkOpen);
      });
      link.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter') return;
        event.preventDefault();
        activateFileLink(link, requestFileLinkOpen);
      });
      return link;
    }

    // v0.9.102: what a click on a file link came to, when it did not simply open, is shown beside that link until the
    // next click on it or Dismiss: the reason, Copy path when the host found the link, and Reveal when the file opens
    // neither in the editor nor in an app. A click clears the last result first, so a result is always this click's.
    let lastFileLinkClicked = null;
    // The results shown for the conversation in view, by link id; a link rendered again shows its result again.
    const fileLinkResults = new Map();
    const FILE_LINK_RESULTS_KEPT = 64;

    function fileLinkResultKey(referenceId) {
      const agentId = typeof state === 'object' && state ? state.selectedAgentId || '' : '';
      return agentId + '\n' + referenceId;
    }

    function keptFileLinkResult(referenceId) {
      return fileLinkResults.get(fileLinkResultKey(referenceId)) || null;
    }

    function keepFileLinkResult(result) {
      const key = fileLinkResultKey(result.referenceId);
      fileLinkResults.delete(key);
      fileLinkResults.set(key, result);
      while (fileLinkResults.size > FILE_LINK_RESULTS_KEPT) fileLinkResults.delete(fileLinkResults.keys().next().value);
    }

    function forgetFileLinkResult(referenceId) {
      fileLinkResults.delete(fileLinkResultKey(referenceId));
    }

    function activateFileLink(link, request) {
      clearFileLinkNote(link);
      forgetFileLinkResult(link.dataset.fileRef);
      lastFileLinkClicked = link;
      request(link.dataset.fileRef);
    }

    function isFileLinkNote(node) {
      return !!node && node.nodeType === 1 && node.className === 'md-file-link-note';
    }

    function isFileLinkMore(node) {
      return !!node && node.nodeType === 1 && node.className === 'md-file-link-more';
    }

    // A link's note goes after the link, and after its actions button when it has one.
    function fileLinkNoteAnchor(link) {
      return isFileLinkMore(link.nextSibling) ? link.nextSibling : link;
    }

    function clearFileLinkNote(link) {
      const next = fileLinkNoteAnchor(link).nextSibling;
      if (isFileLinkNote(next)) next.parentNode.removeChild(next);
      const more = fileLinkNoteAnchor(link);
      if (more !== link) more.setAttribute('aria-expanded', 'false');
    }

    // v0.9.108 (L1): the host's file-action facts for this page: the Reveal words for the platform, whether Export PDF
    // exists here, and which link targets are documents and which can be exported. Every file link offers Open and
    // Reveal: a document opens with its default app, any other file in the editor. A page without the facts offers none.
    function fileLinkActionsFor(span) {
      const facts = typeof FILE_LINK_ACTIONS === 'object' && FILE_LINK_ACTIONS ? FILE_LINK_ACTIONS : null;
      if (!facts || !Array.isArray(facts.documents)) return null;
      const target = String(span.target || '').split('#')[0].toLowerCase();
      const dot = target.lastIndexOf('.');
      const extension = dot >= 0 && dot > target.lastIndexOf('/') ? target.slice(dot) : '';
      return {
        open: facts.documents.includes(extension) ? 'Open with default app' : 'Open in editor',
        reveal: String(facts.reveal || ''),
        exportPdf: facts.exportPdf === true && Array.isArray(facts.pdfSources) && facts.pdfSources.includes(extension),
      };
    }

    function fileLinkMoreButton(link, span) {
      const actions = fileLinkActionsFor(span);
      if (!actions) return null;
      const more = document.createElement('button');
      more.type = 'button';
      more.className = 'md-file-link-more';
      more.textContent = '⋯';
      more.title = 'Actions for ' + span.text;
      more.setAttribute('aria-label', 'Actions for ' + span.text);
      more.setAttribute('aria-haspopup', 'true');
      more.setAttribute('aria-expanded', 'false');
      more.addEventListener('click', (event) => {
        event.preventDefault();
        const shown = more.nextSibling;
        const open = isFileLinkNote(shown) && shown.dataset.actions === 'true';
        clearFileLinkNote(link);
        if (open) return;
        more.parentNode.insertBefore(fileActionsNote(link, span, actions), more.nextSibling);
        more.setAttribute('aria-expanded', 'true');
      });
      return more;
    }

    // The actions of one file link. Each asks the host by the link's id alone, as a click on the link does.
    function fileActionsNote(link, span, actions) {
      const note = document.createElement('span');
      note.className = 'md-file-link-note';
      note.dataset.actions = 'true';
      note.setAttribute('role', 'group');
      note.setAttribute('aria-label', 'Actions for ' + span.text);
      const offer = (label, request) => {
        const button = fileLinkNoteButton(label);
        button.addEventListener('click', (event) => {
          event.preventDefault();
          activateFileLink(link, request);
        });
        note.appendChild(button);
      };
      offer(actions.open, requestFileLinkOpen);
      offer(actions.reveal, requestFileLinkReveal);
      if (actions.exportPdf) offer('Export PDF', requestFileLinkExportPdf);
      const dismiss = fileLinkNoteButton('×');
      dismiss.title = 'Dismiss';
      dismiss.setAttribute('aria-label', 'Dismiss');
      dismiss.addEventListener('click', (event) => {
        event.preventDefault();
        clearFileLinkNote(link);
      });
      note.appendChild(dismiss);
      return note;
    }

    function isInside(root, node) {
      for (let at = node; at; at = at.parentNode) {
        if (at === root) return true;
      }
      return false;
    }

    function findFileLinkElement(root, referenceId) {
      for (const child of root.children) {
        if (child.className === 'md-file-link' && child.dataset.fileRef === referenceId) return child;
        const found = findFileLinkElement(child, referenceId);
        if (found) return found;
      }
      return null;
    }

    function showFileLinkResult(root, result) {
      if (!root || !result || typeof result.message !== 'string' || typeof result.referenceId !== 'string') return;
      keepFileLinkResult(result);
      const link = lastFileLinkClicked && lastFileLinkClicked.dataset.fileRef === result.referenceId
        && isInside(root, lastFileLinkClicked) ? lastFileLinkClicked : findFileLinkElement(root, result.referenceId);
      if (!link || !link.parentNode) return;
      clearFileLinkNote(link);
      link.parentNode.insertBefore(fileLinkNote(link, result), fileLinkNoteAnchor(link).nextSibling);
    }

    // v0.9.108 (L1): VS Code's words for Reveal on this platform, as the host gave them; its generic words otherwise.
    function revealLabel() {
      const facts = typeof FILE_LINK_ACTIONS === 'object' && FILE_LINK_ACTIONS ? FILE_LINK_ACTIONS : null;
      return facts && typeof facts.reveal === 'string' && facts.reveal ? facts.reveal : 'Open Containing Folder';
    }

    function fileLinkNoteButton(label) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = label;
      return button;
    }

    function fileLinkNote(link, result) {
      const note = document.createElement('span');
      note.className = 'md-file-link-note';
      note.setAttribute('role', 'status');
      const text = document.createElement('span');
      text.textContent = result.message;
      note.appendChild(text);
      if (typeof result.path === 'string' && result.path) {
        const copy = fileLinkNoteButton('Copy path');
        copy.addEventListener('click', (event) => {
          event.preventDefault();
          navigator.clipboard.writeText(result.path).then(() => {
            copy.textContent = 'Copied';
            setTimeout(() => { copy.textContent = 'Copy path'; }, 1200);
          }, () => { copy.textContent = 'Copy failed'; });
        });
        note.appendChild(copy);
      }
      if (result.reveal === true) {
        const reveal = fileLinkNoteButton(revealLabel());
        reveal.addEventListener('click', (event) => {
          event.preventDefault();
          activateFileLink(link, requestFileLinkReveal);
        });
        note.appendChild(reveal);
      }
      const dismiss = fileLinkNoteButton('\u00d7');
      dismiss.title = 'Dismiss';
      dismiss.setAttribute('aria-label', 'Dismiss');
      dismiss.addEventListener('click', (event) => {
        event.preventDefault();
        forgetFileLinkResult(link.dataset.fileRef);
        if (note.parentNode) note.parentNode.removeChild(note);
      });
      note.appendChild(dismiss);
      return note;
    }

    // A link that is never followed is text, with the host's reason beside it. One node per span, so a growing
    // paragraph can keep it.
    function renderRefusedLink(span) {
      const node = document.createElement('span');
      node.className = 'md-link-refused';
      node.dataset.linkText = span.text;
      const text = document.createElement('span');
      text.className = 'md-link-text';
      text.textContent = span.text;
      const note = document.createElement('span');
      note.className = 'md-link-note';
      note.textContent = ' (' + span.note + ')';
      node.append(text, note);
      return node;
    }

    // v0.9.88 §5.5: content the host published from a content receipt, shown with its exact characters and line
    // breaks. It is never Markdown, so a line starting with #, * or 1. stays as written.
    function renderVerbatim(block) {
      const wrap = document.createElement('div');
      wrap.className = 'code verbatim';
      wrap.setAttribute('role', 'group');
      wrap.setAttribute('aria-label', block.caption);
      const head = document.createElement('div');
      head.className = 'code-head';
      const caption = document.createElement('span');
      caption.textContent = block.caption;
      head.append(caption);
      const pre = document.createElement('pre');
      pre.textContent = block.text;
      wrap.append(head, pre);
      return wrap;
    }

    function renderCode(block) {
      const wrap = document.createElement('div');
      wrap.className = 'code';
      const head = document.createElement('div');
      head.className = 'code-head';
      const lang = document.createElement('span');
      lang.textContent = block.language || 'code';
      const copy = document.createElement('button');
      copy.type = 'button';
      copy.textContent = 'Copy';
      copy.addEventListener('click', () => {
        navigator.clipboard.writeText(block.code).then(() => {
          copy.textContent = 'Copied';
          setTimeout(() => { copy.textContent = 'Copy'; }, 1200);
        });
      });
      head.append(lang, copy);
      const pre = document.createElement('pre');
      pre.textContent = block.code;
      wrap.append(head, pre);
      return wrap;
    }
`;
