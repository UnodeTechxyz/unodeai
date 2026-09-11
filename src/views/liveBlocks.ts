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
      if (node.childNodes.length !== previousSpans.length) return false;

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
        if (!spanMatchesNode(node.childNodes[index], oldSpan)) return false;
      }
      if (grownAt < 0) return false;

      node.childNodes[grownAt].textContent = nextSpans[grownAt].text;
      appendSpans(node, nextSpans.slice(previousSpans.length));
      return true;
    }

    function sameSpan(previous, next) {
      return !!previous && !!next
        && previous.type === next.type
        && previous.text === next.text
        && previous.href === next.href;
    }

    function spanMatchesNode(node, span) {
      if (!node || !span || node.textContent !== (span.text || '')) return false;
      if (span.type === 'text') return node.nodeType === 3;
      if (node.nodeType !== 1) return false;
      const tags = { strong: 'strong', em: 'em', code: 'code', link: 'a' };
      if (String(node.tagName || '').toLowerCase() !== tags[span.type]) return false;
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
        }
      }
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
