/* ---------- cross-browser shim ---------- */
if (typeof browser !== 'undefined' && typeof chrome === 'undefined') {
  globalThis.chrome = browser;
}
/* --------------------------------------- */

const isExtensionValid = () => chrome.runtime && chrome.runtime.id;
const DEFAULT_LARGE_CHANGE_LIMIT = 500;
const MIN_LARGE_CHANGE_LIMIT = 1;
const MAX_LARGE_CHANGE_LIMIT = 10000;

const normalizeLargeChangeLimit = value => {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return DEFAULT_LARGE_CHANGE_LIMIT;
  return Math.min(Math.max(parsed, MIN_LARGE_CHANGE_LIMIT), MAX_LARGE_CHANGE_LIMIT);
};

const normalizeDiffView = value => ['original', 'changes', 'full', 'side-by-side', 'side-by-side-changes'].includes(value) ? value : 'side-by-side-changes';
const normalizeContextLines = value => {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? Math.min(Math.max(parsed, 0), 20) : 0;
};

const getDiffSettings = async () => {
  const data = await chrome.storage.sync.get(['largeChangeLimit', 'diffView', 'contextLines']);
  return {
    largeChangeLimit: normalizeLargeChangeLimit(data.largeChangeLimit),
    diffView: normalizeDiffView(data.diffView),
    contextLines: normalizeContextLines(data.contextLines),
  };
};

const normalizeDomainPattern = domain => {
  if (!domain || typeof domain !== 'string') return null;
  // Accept pasted URLs or wildcard origins, but store only the comparable hostname.
  const normalized = domain.trim().replace(/^https?:\/\//i, '').replace(/\/.*$/, '').replace(/^\*\./, '').toLowerCase();
  return normalized || null;
}

const isValidDomainPattern = domain => /^[a-z0-9.-]+$/.test(domain) && !domain.includes('..');

const parseDomainPatterns = raw => {
  if (!raw) return [];
  if (Array.isArray(raw)) {
    return raw.map(normalizeDomainPattern).filter(isValidDomainPattern);
  }
  return String(raw)
    .split(/[\n,]+/)
    .map(normalizeDomainPattern)
    .filter(isValidDomainPattern);
};

const getAllowedDomainPatterns = async () => {
  const { allowedDomains } = await chrome.storage.sync.get('allowedDomains');
  const patterns = parseDomainPatterns(allowedDomains);
  return patterns.length ? patterns : ['atlassian.net'];
};

const urlMatchesAllowedDomain = async url => {
  try {
    const host = new URL(url).hostname.toLowerCase();
    const patterns = await getAllowedDomainPatterns();
    return patterns.some(pattern => host === pattern || host.endsWith(`.${pattern}`));
  } catch {
    return false;
  }
};

const DiffHighlighter = {
  isForbiddenContainer(el) {
    return !!el?.closest('[data-testid*="issue-create"]');
  },

  isLikelyJiraPage() {
    try {
      const path = new URL(window.location.href).pathname;
      if (/(\/browse\/|\/jira\/|\/issues\/|\/secure\/(?:Issue|ViewIssue)\b)/i.test(path)) {
        return true;
      }
    } catch {
      // fall through
    }

    return Boolean(
      document.querySelector('[data-testid*=\"issue-activity-feed.ui.buttons.\"]') ||
      document.querySelector('[data-testid*=\"issue.views.issue-base.foundation.breadcrumbs.breadcrumbs-container\"]')
    );
  },

  async isAllowedJiraPage() {
    const matched = await urlMatchesAllowedDomain(window.location.href);
    if (matched) return true;

    const { allowedDomains } = await chrome.storage.sync.get('allowedDomains');
    if (!Array.isArray(allowedDomains) || allowedDomains.length === 0) {
      return this.isLikelyJiraPage();
    }

    return false;
  },

  async init() {
    try {
      if (!isExtensionValid()) return;
      if (!await this.isAllowedJiraPage()) return;
      const data = await chrome.storage.sync.get('extensionEnabled');
      if (data.extensionEnabled !== false) {
        this.enhanceDiff();
        this.setupObserver();
      }
    } catch (error) {
      console.error('Error initializing DiffHighlighter:', error);
    }
  },

  async enhanceDiff() {
    try {
      if (this.isEnhancing) return;
      this.isEnhancing = true;

      if (!isExtensionValid()) return;

      const { extensionEnabled } = await chrome.storage.sync.get('extensionEnabled');
      if (extensionEnabled === false) return;

      const diffContainers = this.findDiffContainers();
      const settings = await getDiffSettings();

      for (const [index, container] of diffContainers.entries()) {
        if (!container || !(container instanceof HTMLElement)) continue;
        if (container.querySelector('.enhanced-diff')) continue;
        if (this.isForbiddenContainer(container)) continue;

        const values = this.getDiffValues(container);
        if (!values) continue;
        const { oldText, newText } = values;

        container.id = `diff-container-${Date.now()}-${index}`;
        const originalContent = container.innerHTML;
        container.dataset.jiraDiffOriginal = originalContent;

        const enhancedDiff = this.createEnhancedDiff(oldText, newText, settings.largeChangeLimit, settings);

        container.replaceChild(enhancedDiff, container.children[0]);
        if (container.children[1]) container.removeChild(container.children[1]);
        if (container.children[1]) container.removeChild(container.children[1]);

        // Watch this container; if Jira wipes our diff node, quietly re‑apply it
        new MutationObserver((muts, obs) => {
          if (!enhancedDiff.isConnected) {
            obs.disconnect();
            this.debouncedEnhanceDiff();
          }
        }).observe(container, { childList: true });
      }
    } catch (error) {
      console.error('Error enhancing diff:', error);
    } finally {
      this.isEnhancing = false;
    }
  },

  getDiffValues(container) {
    if (!(container instanceof HTMLElement)) return null;
    if (this.isForbiddenContainer(container) || container.closest('.enhanced-diff')) return null;
    if (container.children.length !== 3) return null;
    if (container.querySelector('button, input, textarea, select, [contenteditable="true"]')) return null;

    const [oldNode, separator, newNode] = container.children;
    if (!(oldNode instanceof HTMLElement) || !(newNode instanceof HTMLElement)) return null;

    // Jira renders old value / arrow / new value. The arrow may be an SVG or
    // CSS icon with no text; a nonempty middle value must actually be an arrow.
    const separatorText = separator.textContent?.trim() || '';
    if (separatorText && !/^(?:→|➔|➜|⟶|⇒|->|=>)$/.test(separatorText)) return null;

    const oldText = this.readFieldText(oldNode);
    const newText = this.readFieldText(newNode);
    // Empty values are valid when a field is populated or cleared.
    if (!oldText && !newText) return null;
    return { oldText, newText };
  },

  findDiffContainers() {
    const LANG_MAP = {
      en: ['updated', 'changed', 'added', 'removed', 'cleared'],
      es: ['actualizado'],
      de: ['aktualisiert'],
      fr: ['mis à jour'],
      it: ['aggiornato'],
      pt: ['atualizou'],
      ru: ['обновил'],
      ja: ['更新'],
      zh: ['更新'],
      nl: ['bijgewerkt'],
    };

    /* build flattened accent‑stripped keyword sets */
    const norm = s => String(s ?? '')
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .trim();

    const UPDATE_SET = new Set(
      Object.values(LANG_MAP).flatMap(words => words.map(norm))
    );
    const hasUpdate = text => [...UPDATE_SET].some(word => text.includes(word));

    const candidates = [];

    for (const diff of document.querySelectorAll('div')) {
      if (!this.getDiffValues(diff)) continue;

      // A value pair belongs to the activity header immediately before it.
      // Its nested markup and field name do not matter. Never use an update
      // elsewhere in the page or a neighboring history row as the header.
      const header = diff.previousElementSibling;
      if (!(header instanceof HTMLElement) || header.tagName !== 'DIV') continue;
      if (!hasUpdate(norm(header.textContent))) continue;

      candidates.push(diff);
    }

    return candidates;
  },

  readFieldText(node) {
    // textContent loses line breaks in rendered rich-text fields.
    const blocks = new Set(['DIV', 'P', 'LI', 'UL', 'OL', 'PRE', 'BLOCKQUOTE', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6']);
    let text = '';
    const visit = current => {
      if (current.nodeType === Node.TEXT_NODE) {
        text += current.textContent;
        return;
      }
      if (current.nodeType !== Node.ELEMENT_NODE) return;
      if (current.tagName === 'BR') {
        text += '\n';
        return;
      }
      const block = blocks.has(current.tagName);
      if (block && text && !text.endsWith('\n')) text += '\n';
      // Rendered headings in history represent source formatting. Show their
      // Markdown markers as plain text rather than carrying heading styles over.
      if (/^H[1-6]$/.test(current.tagName) && !/^\s*(?:#{1,6}\s|h[1-6]\.\s)/.test(current.textContent)) {
        text += '#'.repeat(Number(current.tagName[1])) + ' ';
      }
      for (const child of current.childNodes) visit(child);
      if (block && current.nextSibling && !text.endsWith('\n')) text += '\n';
    };
    for (const child of node.childNodes) visit(child);
    return text;
  },

  createEnhancedDiff(oldText, newText, largeChangeLimit = DEFAULT_LARGE_CHANGE_LIMIT, settings = {}) {
    if (normalizeDiffView(settings.diffView) === 'original') {
      return this.createOriginalPreview(settings);
    }
    try {
      return this.createGitDiff(oldText, newText, largeChangeLimit, settings);
    } catch (error) {
      console.error('Failed to compute line diff:', error);
      return this.fallbackDiffDisplay(oldText, newText);
    }
  },

  createOriginalPreview(settings) {
    const container = document.createElement('div');
    container.className = 'enhanced-diff original-diff';
    const toolbar = document.createElement('div');
    toolbar.className = 'diff-toolbar';
    const title = document.createElement('span');
    title.textContent = 'Original values';
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'diff-view-toggle';
    toggle.textContent = 'Show Git diff';
    toggle.setAttribute('aria-pressed', 'false');
    toggle.addEventListener('click', () => {
      const parentContainer = container.closest('div[id^="diff-container-"]');
      if (parentContainer && parentContainer.dataset.jiraDiffOriginal) {
        parentContainer.innerHTML = parentContainer.dataset.jiraDiffOriginal;
        this.debouncedEnhanceDiff();
      }
    });
    toolbar.append(title, toggle);
    container.appendChild(toolbar);
    return container;
  },

  getLineDiff(oldText, newText) {
    const dmp = new diff_match_patch();
    const encoded = dmp.diff_linesToChars_(oldText.replace(/\r\n/g, '\n'), newText.replace(/\r\n/g, '\n'));
    const diffs = dmp.diff_main(encoded.chars1, encoded.chars2, false);
    dmp.diff_charsToLines_(diffs, encoded.lineArray);
    // Keep line boundaries intact: character-level semantic cleanup would
    // shift fragments between lines and corrupt the line numbers.
    const rows = [];
    let oldLine = 1;
    let newLine = 1;
    for (const diff of diffs) {
      const operation = diff[0];
      const text = diff[1];
      const lines = text.match(/[^\n]*\n|[^\n]+$/g) || [];
      for (const line of lines) {
        rows.push({
          operation,
          text: line.endsWith('\n') ? line.slice(0, -1) : line,
          hasNewline: line.endsWith('\n'),
          oldBefore: oldLine - 1,
          newBefore: newLine - 1,
          oldLine: operation === 1 ? null : oldLine++,
          newLine: operation === -1 ? null : newLine++,
        });
      }
    }
    return rows;
  },

  createGitDiff(oldText, newText, largeChangeLimit, settings) {
    const container = document.createElement('div');
    const view = normalizeDiffView(settings.diffView);
    const split = view.startsWith('side-by-side');
    container.className = `enhanced-diff unified-diff${split ? ' split-diff' : ''}`;
    const rows = this.getLineDiff(oldText, newText);
    const wordDiff = new diff_match_patch();
    for (let start = 0; start < rows.length;) {
      if (rows[start].operation === 0) { start++; continue; }
      let end = start;
      while (end < rows.length && rows[end].operation !== 0) end++;
      const removed = rows.slice(start, end).filter(row => row.operation === -1);
      const added = rows.slice(start, end).filter(row => row.operation === 1);
      for (let i = 0; i < Math.min(removed.length, added.length); i++) {
        if (removed[i].text.length + added[i].text.length > 10000) continue;
        const fragments = wordDiff.diff_main(removed[i].text, added[i].text);
        wordDiff.diff_cleanupSemantic(fragments);
        removed[i].fragments = fragments.filter(fragment => fragment[0] !== 1);
        added[i].fragments = fragments.filter(fragment => fragment[0] !== -1);
      }
      start = end;
    }
    const contextLines = normalizeContextLines(settings.contextLines);
    let showAll = view === 'full' || view === 'side-by-side';

    const toolbar = document.createElement('div');
    toolbar.className = 'diff-toolbar';
    const title = document.createElement('span');
    title.textContent = 'Before → After';
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'diff-view-toggle';
    toolbar.append(title, toggle);
    const body = document.createElement('div');
    body.className = 'diff-lines';
    container.appendChild(toolbar);
    if (split) {
      const headings = document.createElement('div');
      headings.className = 'diff-pane-headings';
      for (const label of ['Before', 'After']) {
        const heading = document.createElement('span');
        heading.textContent = label;
        headings.appendChild(heading);
      }
      container.appendChild(headings);
    }
    container.appendChild(body);

    const appendRow = (parent, row) => {
      const line = document.createElement('div');
      line.className = `diff-line diff-${row.operation === 1 ? 'added' : row.operation === -1 ? 'removed' : 'context'}`;
      for (const [className, text] of [
        ['diff-old-number', row.oldLine ?? ''],
        ['diff-new-number', row.newLine ?? ''],
        ['diff-sign', row.operation === 1 ? '+' : row.operation === -1 ? '−' : ' '],
        ['diff-line-text', row.text || '\u200b'],
      ]) {
        const cell = document.createElement('span');
        cell.className = className;
        if (className === 'diff-line-text' && row.fragments) {
          for (const diff of row.fragments) {
            const operation = diff[0];
            const fragment = diff[1];
            const span = document.createElement('span');
            if (operation !== 0) span.className = operation === 1 ? 'diff-word-added' : 'diff-word-removed';
            span.textContent = fragment;
            cell.appendChild(span);
          }
          if (!row.text) cell.textContent = '\u200b';
        } else {
          cell.textContent = text;
        }
        line.appendChild(cell);
      }
      parent.appendChild(line);
      if (!row.hasNewline && row.operation !== 0) {
        const marker = document.createElement('div');
        marker.className = 'diff-newline-marker';
        marker.textContent = '\\ No newline at end of field';
        parent.appendChild(marker);
      }
    };

    const appendUnifiedRows = (parent, visibleRows) => {
      for (let i = 0; i < visibleRows.length;) {
        const row = visibleRows[i];
        let end = i + 1;
        if (row.operation !== 0) {
          while (end < visibleRows.length && visibleRows[end].operation === row.operation) end++;
        }
        const group = visibleRows.slice(i, end);
        const length = group.reduce((sum, item) => sum + item.text.length + Number(item.hasNewline), 0);
        if (row.operation !== 0 && length > largeChangeLimit) {
          const wrapper = document.createElement('div');
          const type = row.operation === 1 ? 'insertion' : 'deletion';
          wrapper.className = `large-change-wrapper large-${type}-wrapper`;
          const indicator = document.createElement('div');
          indicator.className = `large-change-indicator large-${type}-indicator`;
          const label = document.createElement('span');
          label.textContent = `Large ${type} (${length} characters, ${group.length} lines)`;
          const button = document.createElement('button');
          button.type = 'button';
          button.className = 'large-change-toggle';
          button.textContent = 'Show full text';
          button.setAttribute('aria-expanded', 'false');
          button.addEventListener('click', () => {
            const expanded = button.getAttribute('aria-expanded') === 'true';
            button.setAttribute('aria-expanded', String(!expanded));
            button.textContent = expanded ? 'Show full text' : 'Hide full text';
            wrapper.querySelector('.large-change-full-text')?.remove();
            if (!expanded) {
              const fullText = document.createElement('div');
              fullText.className = 'large-change-full-text';
              group.forEach(item => appendRow(fullText, item));
              wrapper.appendChild(fullText);
            }
          });
          indicator.append(label, button);
          wrapper.appendChild(indicator);
          parent.appendChild(wrapper);
        } else {
          group.forEach(item => appendRow(parent, item));
        }
        i = end;
      }
    };

    const appendPair = (parent, before, after) => {
      const pair = document.createElement('div');
      pair.className = 'diff-split-row';
      for (const [side, row] of [['before', before], ['after', after]]) {
        const pane = document.createElement('div');
        pane.className = `diff-${side}${row ? '' : ' diff-empty-side'}`;
        if (row) appendRow(pane, row);
        pair.appendChild(pane);
      }
      parent.appendChild(pair);
    };

    const appendSplitRows = (parent, visibleRows) => {
      for (let i = 0; i < visibleRows.length;) {
        if (visibleRows[i].operation === 0) {
          appendPair(parent, visibleRows[i], visibleRows[i]);
          i++;
          continue;
        }
        let end = i;
        while (end < visibleRows.length && visibleRows[end].operation !== 0) end++;
        const before = visibleRows.slice(i, end).filter(row => row.operation === -1);
        const after = visibleRows.slice(i, end).filter(row => row.operation === 1);
        const lineCount = Math.max(before.length, after.length);
        const lengthOf = lines => lines.reduce((sum, row) => sum + row.text.length + Number(row.hasNewline), 0);
        const beforeLength = lengthOf(before);
        const afterLength = lengthOf(after);
        const appendPairs = target => {
          for (let index = 0; index < lineCount; index++) appendPair(target, before[index], after[index]);
        };
        if (Math.max(beforeLength, afterLength) > largeChangeLimit) {
          const type = before.length === 0 ? 'insertion' : after.length === 0 ? 'deletion' : 'change';
          const wrapper = document.createElement('div');
          wrapper.className = `large-change-wrapper large-${type}-wrapper`;
          const indicator = document.createElement('div');
          indicator.className = `large-change-indicator large-${type}-indicator`;
          const label = document.createElement('span');
          label.textContent = `Large ${type} (${beforeLength + afterLength} characters, ${lineCount} lines)`;
          const button = document.createElement('button');
          button.type = 'button';
          button.className = 'large-change-toggle';
          button.textContent = 'Show full text';
          button.setAttribute('aria-expanded', 'false');
          button.addEventListener('click', () => {
            const expanded = button.getAttribute('aria-expanded') === 'true';
            button.setAttribute('aria-expanded', String(!expanded));
            button.textContent = expanded ? 'Show full text' : 'Hide full text';
            wrapper.querySelector('.large-change-full-text')?.remove();
            if (!expanded) {
              const fullText = document.createElement('div');
              fullText.className = 'large-change-full-text';
              appendPairs(fullText);
              wrapper.appendChild(fullText);
            }
          });
          indicator.append(label, button);
          wrapper.appendChild(indicator);
          parent.appendChild(wrapper);
        } else {
          appendPairs(parent);
        }
        i = end;
      }
    };
    const appendRows = (parent, visibleRows) => {
      if (split) appendSplitRows(parent, visibleRows);
      else appendUnifiedRows(parent, visibleRows);
    };

    const render = () => {
      body.replaceChildren();
      toggle.textContent = showAll ? 'Show changed lines' : 'Show all lines';
      toggle.setAttribute('aria-pressed', String(showAll));
      const ranges = [];
      if (showAll && rows.length) ranges.push([0, rows.length]);
      else rows.forEach((row, index) => {
        if (row.operation === 0) return;
        const start = Math.max(0, index - contextLines);
        const end = Math.min(rows.length, index + contextLines + 1);
        const previous = ranges[ranges.length - 1];
        if (previous && start <= previous[1]) previous[1] = Math.max(previous[1], end);
        else ranges.push([start, end]);
      });

      const appendGap = (start, end) => {
        if (start === end) return;
        const gap = document.createElement('div');
        gap.className = 'diff-gap';
        const button = document.createElement('button');
        button.type = 'button';
        const gapLabel = `${end - start} unchanged ${end - start === 1 ? 'line' : 'lines'}`;
        button.textContent = `Show ${gapLabel}`;
        button.setAttribute('aria-expanded', 'false');
        button.addEventListener('click', () => {
          const expanded = button.getAttribute('aria-expanded') === 'true';
          button.setAttribute('aria-expanded', String(!expanded));
          button.textContent = `${expanded ? 'Show' : 'Hide'} ${gapLabel}`;
          gap.querySelector('.diff-gap-lines')?.remove();
          if (!expanded) {
            const lines = document.createElement('div');
            lines.className = 'diff-gap-lines';
            appendRows(lines, rows.slice(start, end));
            gap.appendChild(lines);
          }
        });
        gap.appendChild(button);
        body.appendChild(gap);
      };

      if (!ranges.length) {
        const empty = document.createElement('div');
        empty.className = 'diff-empty';
        empty.textContent = 'No textual changes.';
        body.appendChild(empty);
        appendGap(0, rows.length);
        return;
      }
      let cursor = 0;
      for (const [start, end] of ranges) {
        appendGap(cursor, start);
        const visibleRows = rows.slice(start, end);
        const oldCount = visibleRows.filter(row => row.oldLine !== null).length;
        const newCount = visibleRows.filter(row => row.newLine !== null).length;
        const header = document.createElement('div');
        header.className = 'diff-hunk-header';
        header.textContent = `@@ -${rows[start].oldBefore + Number(oldCount > 0)},${oldCount} +${rows[start].newBefore + Number(newCount > 0)},${newCount} @@`;
        body.appendChild(header);
        appendRows(body, visibleRows);
        cursor = end;
      }
      appendGap(cursor, rows.length);
    };
    toggle.addEventListener('click', () => {
      showAll = !showAll;
      render();
    });
    render();
    return container;
  },

  fallbackDiffDisplay(oldText, newText) {
    const diffContainer = document.createElement('div');
    diffContainer.className = 'enhanced-diff';

    const oldContainer = document.createElement('div');
    oldContainer.className = 'old-text';
    oldContainer.appendChild(this.createTextFragment(oldText));

    const newContainer = document.createElement('div');
    newContainer.className = 'new-text';
    newContainer.appendChild(this.createTextFragment(newText));

    diffContainer.appendChild(oldContainer);
    diffContainer.appendChild(newContainer);

    return diffContainer;
  },

  createTextFragment(text) {
    // Convert raw text into a DocumentFragment with <br> elements for newlines.
    const textFragment = document.createDocumentFragment();
    const lines = String(text ?? '').split('\n');

    for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
      textFragment.appendChild(document.createTextNode(lines[lineIndex]));
      if (lineIndex < lines.length - 1) {
        textFragment.appendChild(document.createElement('br'));
      }
    }

    return textFragment;
  },

  setupObserver() {
    if (window.diffObserver) return;

    const triggerEnhance = () => {
      if (!this.isEnhancing) this.debouncedEnhanceDiff();
    };

    window.diffObserver = new MutationObserver(muts => {
      const relevant = muts.some(m =>
        (m.addedNodes.length || m.removedNodes.length || m.type === 'characterData') &&
        !(m.target instanceof Element ? m.target : m.target.parentElement)?.closest('.enhanced-diff')
      );
      if (relevant) triggerEnhance();
    });

    window.diffObserver.observe(document.body, {
      childList: true,
      characterData: true,
      subtree: true
    });

    document.addEventListener(
      'click',
      e => {
        const btn = e.target.closest(
          '[data-testid^="issue-activity-feed.ui.buttons."]'
        );
        if (!btn) return;

        setTimeout(triggerEnhance, 200);
      },
      true
    );
  },

  async removeEnhancements() {
    try {
      if (!isExtensionValid()) return;
      for (const enhancedDiff of document.querySelectorAll('.enhanced-diff')) {
        const parentContainer = enhancedDiff.closest('div[id^="diff-container-"]');
        if (parentContainer?.dataset.jiraDiffOriginal) {
          parentContainer.innerHTML = parentContainer.dataset.jiraDiffOriginal;
          delete parentContainer.dataset.jiraDiffOriginal;
        } else {
          enhancedDiff.remove();
        }
      }
    } catch (error) {
      console.error('Error removing enhancements:', error);
    }
  },

  debouncedEnhanceDiff: null  // set in init
};

const MessageHandler = {
  async handleMessage(request, sender, sendResponse) {
    try {
      if (!isExtensionValid()) return;
      if (request.action === "toggleExtension") {
        await chrome.storage.sync.set({extensionEnabled: request.enabled});
        if (request.enabled) {
          await DiffHighlighter.enhanceDiff();
          DiffHighlighter.setupObserver();
        } else {
          await DiffHighlighter.removeEnhancements();
          if (window.diffObserver) {
            window.diffObserver.disconnect();
            window.diffObserver = null;
          }
        }
        sendResponse({status: "success"});
      } else if (request.action === "checkExtensionState") {
        const data = await chrome.storage.sync.get('extensionEnabled');
        if (data.extensionEnabled !== false) {
          await DiffHighlighter.removeEnhancements();
          await DiffHighlighter.enhanceDiff();
          DiffHighlighter.setupObserver();
        } else {
          await DiffHighlighter.removeEnhancements();
          if (window.diffObserver) {
            window.diffObserver.disconnect();
            window.diffObserver = null;
          }
        }
        sendResponse({status: "success"});
      }
    } catch (error) {
      console.error('Error handling message:', error);
      sendResponse({status: "error", message: error.message});
    }
  }
};

function debounce(func, wait) {
  let timeout;
  return function executedFunction(...args) {
    const later = () => {
      clearTimeout(timeout);
      func.apply(this, args);
    };
    clearTimeout(timeout);
    timeout = setTimeout(later, wait);
  };
}

// Initialize
DiffHighlighter.debouncedEnhanceDiff = debounce(DiffHighlighter.enhanceDiff.bind(DiffHighlighter), 250);
DiffHighlighter.init();

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  MessageHandler.handleMessage(request, sender, sendResponse)
    .catch(error => {
      console.error('Error in message listener:', error);
      sendResponse({status: "error", message: error.message});
    });
  return true;
});
