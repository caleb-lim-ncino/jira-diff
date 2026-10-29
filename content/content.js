// Content scripts may be reinjected into an open tab after an extension reload.
// Keep declarations private and dispose the preceding instance first.
(() => {
/* ---------- cross-browser shim ---------- */
if (typeof browser !== 'undefined' && typeof chrome === 'undefined') {
  globalThis.chrome = browser;
}
/* --------------------------------------- */
globalThis.__jiraDiffContentScript?.dispose();

const isExtensionValid = () => chrome.runtime && chrome.runtime.id;
const DEFAULT_LARGE_CHANGE_LIMIT = 500;
const MIN_LARGE_CHANGE_LIMIT = 1;
const MAX_LARGE_CHANGE_LIMIT = 10000;
const ROVO_ACTION_CARD = '[data-testid="update-work-item-all-fields-action-renderer.ui.action-card"]';
const ROVO_FIELD_ROW = '[data-testid="update-work-item-all-fields-action-renderer.ui.card-fields-list"]';
const ROVO_TOOLTIP = '[data-testid="update-work-item-all-fields-action-renderer.ui.action-card.card-fields-list.field-tooltip-content"]';

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
  const data = await chrome.storage.sync.get(['largeChangeLimit', 'diffView', 'contextLines', 'rovoPreviewsEnabled']);
  return {
    largeChangeLimit: normalizeLargeChangeLimit(data.largeChangeLimit),
    diffView: normalizeDiffView(data.diffView),
    contextLines: normalizeContextLines(data.contextLines),
    rovoPreviewsEnabled: data.rovoPreviewsEnabled !== false,
  };
};

const normalizeDomainPattern = domain => {
  if (!domain || typeof domain !== 'string') return null;
  // Accept pasted URLs or wildcard origins, but store only the comparable hostname.
  const normalized = domain.trim().replace(/^https?:\/\//i, '').replace(/\/.*$/, '').replace(/^\*\./, '').toLowerCase();
  return normalized || null;
}

const isValidDomainPattern = domain => typeof domain === 'string' && /^[a-z0-9.-]+$/.test(domain) && !domain.includes('..');

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

// Keep Jira responsible for filtering and loading the feed. These shortcuts
// invoke its existing controls, including menu items rendered in a portal.
const ActivityControls = {
  labels: ['All', 'Comments', 'History'],
  initialized: new Set(),
  pending: null,
  generation: 0,
  context: null,
  defaultTasks: new Map(),

  controlText(control) {
    const copy = control.cloneNode(true);
    copy.querySelectorAll('svg, [aria-hidden="true"]').forEach(node => node.remove());
    return copy.textContent.replace(/\s+/g, ' ').trim();
  },

  label(button) {
    const text = this.controlText(button).replace(/\s*\(?\d+\)?$/, '').trim();
    if (/^all comments$/i.test(text)) return 'Comments';
    if (/^all activity$/i.test(text)) return 'All';
    return [...this.labels, 'Work log', 'Zendesk Support', 'Transitions', 'Approvals']
      .find(label => label.toLowerCase() === text.toLowerCase());
  },

  nativeButtons(root) {
    return [...root.querySelectorAll('button, [role="tab"], [role="button"]')]
      .filter(button => !button.closest('.jira-activity-shortcuts, [role="menu"], [role="listbox"], [role^="menuitem"], [role="option"]'));
  },

  moreButton(root) {
    return this.nativeButtons(root).find(button => /^More\b/i.test(this.controlText(button)) ||
      /^More\b/i.test(button.getAttribute('aria-label') || ''));
  },

  dropdownButton(root) {
    return this.moreButton(root) || this.nativeButtons(root).find(button =>
      this.label(button) && ['true', 'menu', 'listbox'].includes(button.getAttribute('aria-haspopup')));
  },

  findToolbars() {
    const roots = new Set();
    // Prefer Jira's activity-specific hooks. The heading fallback supports
    // layouts where the new controls no longer carry the old test IDs.
    const anchors = [...document.querySelectorAll('#JSW_ACTIVITY_FEED_BUTTONS, [data-testid^="issue-activity-feed.ui.buttons"], [data-testid*="issue-activity-feed"]')];
    // The Activity title can be a styled span/div rather than a semantic heading.
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const title = walker.currentNode.parentElement;
      if (walker.currentNode.textContent.trim() === 'Activity' && title.textContent.trim() === 'Activity') anchors.push(title);
    }
    for (const anchor of anchors) {
      if (anchor.closest('.jira-activity-shortcuts, [role="menu"], [role="listbox"], [data-testid*="issue-create"]')) continue;
      let root = anchor;
      for (let depth = 0; root && root !== document.body && depth < 10; depth++, root = root.parentElement) {
        const buttons = this.nativeButtons(root);
        const filters = buttons.filter(button => this.label(button));
        const more = this.dropdownButton(root);
        if (filters.length && (more || filters.length >= 2)) {
          // Scope to the filter row, excluding buttons in history entries or
          // the comment editor below it when the title anchors a whole section.
          let toolbar = (more || filters[0]).parentElement;
          while (toolbar && root.contains(toolbar)) {
            const nearbyFilters = this.nativeButtons(toolbar).filter(button => this.label(button));
            if (nearbyFilters.length && (more || nearbyFilters.length >= 2)) {
              roots.add(toolbar);
              break;
            }
            if (toolbar === root) break;
            toolbar = toolbar.parentElement;
          }
          break;
        }
      }
    }
    // A heading and a test ID can identify overlapping containers.
    return [...roots].filter(root => ![...roots].some(other => other !== root && root.contains(other)));
  },

  selected(root) {
    const filters = this.nativeButtons(root).filter(button => this.label(button));
    const active = filters.find(button => button.getAttribute('aria-selected') === 'true' ||
      button.getAttribute('aria-pressed') === 'true' || button.getAttribute('data-state') === 'active');
    const selected = active || (filters.length === 1 ? filters[0] : null);
    return selected ? this.label(selected) : undefined;
  },

  syncSelection(root) {
    const selected = this.selected(root);
    for (const button of root.querySelectorAll('.jira-activity-shortcuts button')) {
      const pressed = String(button.textContent === selected);
      if (button.getAttribute('aria-pressed') !== pressed) button.setAttribute('aria-pressed', pressed);
    }
  },

  async enhance() {
    const generation = this.generation;
    const settings = await chrome.storage.sync.get(['activityTabsEnabled', 'defaultActivityFilter']);
    if (generation !== this.generation) return;
    if (settings.activityTabsEnabled === false) {
      this.remove();
      this.initialized.clear();
      return;
    }
    const defaultFilter = [...this.labels, 'Jira default'].includes(settings.defaultActivityFilter)
      ? settings.defaultActivityFilter : 'All';
    const context = `${window.location.pathname}${window.location.search}|${defaultFilter}`;
    if (this.context !== context) {
      this.context = context;
      this.initialized.clear();
    }
    for (const root of this.findToolbars()) {
      const buttons = this.nativeButtons(root);
      const filters = buttons.filter(button => this.label(button));
      const more = this.dropdownButton(root);
      // Already-visible native tabs are kept intact.
      if (more && filters.length === 1) {
        root.classList.add('jira-activity-toolbar');
        more.classList.add('jira-activity-more');
        let shortcuts = root.querySelector('.jira-activity-shortcuts');
        if (!shortcuts) {
          shortcuts = document.createElement('span');
          shortcuts.className = 'jira-activity-shortcuts';
          shortcuts.setAttribute('role', 'group');
          shortcuts.setAttribute('aria-label', 'Activity filters');
          for (const label of this.labels) {
            const button = document.createElement('button');
            button.type = 'button';
            button.textContent = label;
            button.addEventListener('click', () => {
              this.initialized.add(this.context); // An explicit choice takes precedence over the opening default.
              this.select(root, label).catch(error => console.error('Could not select Jira activity filter:', error));
            });
            shortcuts.appendChild(button);
          }
          const status = document.createElement('span');
          status.className = 'jira-activity-status';
          status.setAttribute('role', 'status');
          shortcuts.appendChild(status);
          filters[0].before(shortcuts);
        }
        // A single-dropdown layout needs to retain its native trigger for
        // activity types beyond the three shortcuts.
        if (more !== filters[0]) filters[0].classList.add('jira-activity-native-filter');
        this.syncSelection(root);
      } else if (filters.length > 1) {
        root.classList.remove('jira-activity-toolbar');
        this.nativeButtons(root).forEach(button => button.classList.remove('jira-activity-more'));
        root.querySelectorAll('.jira-activity-shortcuts').forEach(element => element.remove());
        filters.forEach(button => button.classList.remove('jira-activity-native-filter'));
      }
      const key = context;
      if (defaultFilter !== 'Jira default' && !this.initialized.has(key) && !this.defaultTasks.has(key)) {
        const task = this.applyDefault(root, defaultFilter, key, this.generation);
        this.defaultTasks.set(key, task);
        task.catch(error => console.error('Could not set Jira activity default:', error))
          .finally(() => {
            if (this.defaultTasks.get(key) === task) this.defaultTasks.delete(key);
          });
      }
    }
  },

  async applyDefault(root, label, context, generation) {
    // Allow Jira to restore its saved filter and attach React handlers first.
    // A failed click must not count as a successfully applied default.
    for (let attempt = 0; attempt < 3; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 300));
      if (generation !== this.generation || context !== this.context || this.initialized.has(context)) return;
      if (!root.isConnected) root = this.findToolbars()[0];
      if (!root) continue;
      if (this.selected(root) !== label) await this.select(root, label);
      await new Promise(resolve => setTimeout(resolve, 100));
      if (generation !== this.generation || context !== this.context) return;
      if (this.selected(root) === label) {
        this.initialized.add(context);
        DiffHighlighter.debouncedEnhanceDiff();
        return;
      }
    }
    // Stop automatic retries, but allow a manual shortcut or setting change.
    this.initialized.add(context);
  },

  async select(root, label) {
    if (this.pending || !root.isConnected) return false;
    if (this.selected(root) === label) return true;
    const native = this.nativeButtons(root).find(button => this.label(button) === label);
    if (native && !native.disabled && native.getAttribute('aria-disabled') !== 'true') {
      native.click();
      DiffHighlighter.debouncedEnhanceDiff();
      return true;
    }
    const more = this.dropdownButton(root);
    if (!more || more.disabled) return false;
    const generation = this.generation;
    this.pending = root;
    const shortcuts = root.querySelector('.jira-activity-shortcuts');
    const status = shortcuts?.querySelector('[role="status"]');
    const previousFocus = document.activeElement;
    const returnFocus = shortcuts?.contains(document.activeElement);
    if (status) status.textContent = '';
    shortcuts?.querySelectorAll('button').forEach(button => { button.disabled = true; });
    let opened = false;
    let selected = false;
    const menuSelector = '[role="menu"], [role="listbox"], [data-testid*="dropdown-menu"]:not(button):not([role="button"]), [data-testid*="popup-content"]';
    const existingMenus = new Set(document.querySelectorAll(menuSelector));
    const quietMenus = new Set();
    // Mark the newly mounted Jira popup in the mutation microtask, before the
    // browser paints it. Keep its layout and native handlers intact.
    const quietMenuObserver = new MutationObserver(() => {
      for (const menu of document.querySelectorAll(menuSelector)) {
        if (!existingMenus.has(menu) && menu !== root && !menu.contains(root)) {
          menu.classList.add('jira-activity-switching-menu');
          quietMenus.add(menu);
        }
      }
    });
    if (more.getAttribute('aria-expanded') !== 'true') {
      const controlled = document.getElementById((more.getAttribute('aria-controls') || '').split(/\s+/)[0]);
      if (controlled && controlled !== root && !controlled.contains(root)) {
        controlled.classList.add('jira-activity-switching-menu');
        quietMenus.add(controlled);
      }
      quietMenuObserver.observe(document.body, { childList: true, subtree: true });
    }
    try {
      if (more.getAttribute('aria-expanded') !== 'true') {
        more.click();
        opened = true;
      }
      // Jira mounts menu items asynchronously, sometimes outside the issue DOM.
      for (let attempt = 0; attempt < 30; attempt++) {
        if (generation !== this.generation || !root.isConnected) return false;
        const controlled = document.getElementById((more.getAttribute('aria-controls') || '').split(/\s+/)[0]);
        const menus = controlled ? [controlled] : [...document.querySelectorAll(menuSelector)]
          .filter(menu => !existingMenus.has(menu) || (more.id && menu.getAttribute('aria-labelledby') === more.id) ||
            (!opened && document.querySelectorAll(menuSelector).length === 1));
        const candidates = menus.flatMap(menu => [...menu.querySelectorAll('[role^="menuitem"], [role="option"], [role="button"], button, a')]);
        const item = candidates.find(button => this.label(button) === label && !button.disabled &&
          button.getAttribute('aria-disabled') !== 'true' && !button.closest('[hidden], [aria-hidden="true"]'));
        if (item) {
          item.click();
          selected = true;
          DiffHighlighter.debouncedEnhanceDiff();
          return true;
        }
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      if (status) status.textContent = `${label} is unavailable. Use Jira's More menu to choose an activity filter.`;
      return false;
    } finally {
      if (opened) {
        // Allow React to unmount the selected item before exposing the popup
        // again. Failure/cancellation also closes only the menu we opened.
        for (let attempt = 0; selected && more.getAttribute('aria-expanded') === 'true' && attempt < 4; attempt++) {
          await new Promise(resolve => setTimeout(resolve, 25));
        }
        if (more.isConnected && more.getAttribute('aria-expanded') === 'true') more.click();
        if ([...quietMenus].some(menu => menu.isConnected)) await new Promise(resolve => setTimeout(resolve, 50));
      }
      quietMenuObserver.disconnect();
      quietMenus.forEach(menu => menu.classList.remove('jira-activity-switching-menu'));
      if (root.isConnected && generation === this.generation) {
        this.syncSelection(root);
        window.requestAnimationFrame?.(() => {
          if (root.isConnected && generation === this.generation) this.syncSelection(root);
        });
      }
      this.pending = null;
      shortcuts?.querySelectorAll('button').forEach(button => { button.disabled = false; });
      if (returnFocus && shortcuts?.isConnected) {
        [...shortcuts.querySelectorAll('button')].find(button => button.textContent === label)?.focus();
      } else if (opened && previousFocus?.isConnected && previousFocus !== document.body) {
        previousFocus.focus({ preventScroll: true });
      }
    }
  },

  remove() {
    this.generation++;
    this.defaultTasks.clear();
    document.querySelectorAll('.jira-activity-shortcuts').forEach(element => element.remove());
    document.querySelectorAll('.jira-activity-native-filter').forEach(element => element.classList.remove('jira-activity-native-filter'));
    document.querySelectorAll('.jira-activity-toolbar').forEach(element => element.classList.remove('jira-activity-toolbar'));
    document.querySelectorAll('.jira-activity-more').forEach(element => element.classList.remove('jira-activity-more'));
  },
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
      document.querySelector('#JSW_ACTIVITY_FEED_BUTTONS, [data-testid^="issue-activity-feed.ui.buttons"]') ||
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
      if (this.disposed) return;
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
      if (this.disposed || this.isEnhancing) return;
      this.isEnhancing = true;

      if (!isExtensionValid()) return;

      const { extensionEnabled } = await chrome.storage.sync.get('extensionEnabled');
      if (this.disposed || extensionEnabled === false) return;

      await ActivityControls.enhance();
      if (this.disposed) return;
      const diffContainers = this.findDiffContainers();
      const settings = await getDiffSettings();
      if (this.disposed) return;
      this.enhanceRovoPreviews(settings);

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
      return this.createOriginalPreview(oldText, newText, settings);
    }
    try {
      return this.createGitDiff(oldText, newText, largeChangeLimit, settings);
    } catch (error) {
      console.error('Failed to compute line diff:', error);
      return this.fallbackDiffDisplay(oldText, newText);
    }
  },

  createLargePreview(oldText, newText, settings = {}, fields = []) {
    this.closeLargePreview?.();
    const overlay = document.createElement('div');
    overlay.className = 'jira-diff-large-preview-overlay';
    const modal = document.createElement('div');
    modal.className = 'jira-diff-large-preview';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-label', 'Full diff preview');
    const header = document.createElement('div');
    header.className = 'jira-diff-preview-header';
    const title = document.createElement('h2');
    title.textContent = 'Full diff preview';
    const closeButton = document.createElement('button');
    closeButton.type = 'button';
    closeButton.className = 'jira-diff-preview-close';
    closeButton.textContent = 'Close';
    const content = document.createElement('div');
    content.className = 'jira-diff-preview-content';
    const previewSettings = {
      ...settings,
      diffView: ['changes', 'full'].includes(settings.diffView) ? 'full' : 'side-by-side',
    };
    const renderPreview = field => {
      content.replaceChildren();
      if (field && field.oldText === undefined) {
        const message = document.createElement('p');
        message.className = 'jira-diff-preview-empty';
        message.textContent = `Hover ${field.label} in the Rovo card to load its comparison, then reopen View full diff.`;
        content.appendChild(message);
        return;
      }
      const preview = this.createGitDiff(field?.oldText ?? oldText, field?.newText ?? newText, Infinity, previewSettings);
      preview.querySelector('.diff-large-preview')?.remove();
      const lines = preview.querySelector('.diff-lines');
      lines.tabIndex = 0;
      lines.setAttribute('role', 'region');
      lines.setAttribute('aria-label', 'Scrollable diff lines');
      content.appendChild(preview);
    };
    header.append(title, closeButton);
    if (fields.length > 1) {
      const select = document.createElement('select');
      select.className = 'jira-diff-preview-field';
      select.setAttribute('aria-label', 'Suggested field');
      fields.forEach((field, index) => {
        const option = document.createElement('option');
        option.value = String(index);
        option.textContent = field.label;
        select.appendChild(option);
      });
      select.selectedIndex = Math.max(0, fields.findIndex(field => field.oldText !== undefined));
      select.addEventListener('change', () => renderPreview(fields[select.selectedIndex]));
      header.insertBefore(select, closeButton);
      renderPreview(fields[select.selectedIndex]);
    } else {
      renderPreview(fields[0]);
    }
    modal.append(header, content);
    overlay.appendChild(modal);
    document.body.appendChild(overlay);
    document.body.classList.add('jira-diff-preview-open');

    const previousFocus = document.activeElement;
    const close = () => {
      document.removeEventListener('keydown', escapeHandler, true);
      overlay.remove();
      document.body.classList.remove('jira-diff-preview-open');
      this.closeLargePreview = null;
      previousFocus?.focus?.({ preventScroll: true });
    };
    const escapeHandler = event => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopImmediatePropagation();
        close();
      } else if (event.key === 'Tab') {
        const controls = [...modal.querySelectorAll('button:not(:disabled), select, [tabindex="0"]')];
        const first = controls[0];
        const last = controls.at(-1);
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    overlay.addEventListener('click', event => {
      if (event.target === overlay) close();
    });
    document.addEventListener('keydown', escapeHandler, true);
    closeButton.addEventListener('click', close);
    this.closeLargePreview = close;
    closeButton.focus();
    return close;
  },

  findRovoConfirmationCards(root = document) {
    const cards = new Set(root.querySelectorAll('[data-testid="update-work-item-all-fields-action-renderer.ui.action-card"]'));
    for (const element of root.querySelectorAll('button, [role="button"], section, div')) {
      if (element.closest('.jira-diff-rovo-card, .jira-activity-shortcuts, .enhanced-diff, .jira-diff-large-preview-overlay') || this.isForbiddenContainer(element)) continue;
      if (!/^(?:accept all|accept changes|review and accept changes)$/i.test(ActivityControls.controlText(element))) continue;
      const nativeCard = element.closest(ROVO_ACTION_CARD);
      if (nativeCard) {
        cards.add(nativeCard);
        continue;
      }
      if (!element.matches('button, [role="button"]') && element.querySelector('button, [role="button"], section, div')) continue;
      // A button's own test ID identifies the control, not the suggestion.
      for (let card = element.parentElement; card && card !== document.body; card = card.parentElement) {
        const containedCards = card.querySelectorAll(ROVO_ACTION_CARD);
        if (containedCards.length) {
          if (containedCards.length === 1) cards.add(containedCards[0]);
          break;
        }
        if (this.getRovoExplicitChange(card) || this.getRovoFieldTarget(card)) {
          cards.add(card);
          break;
        }
        if (card.matches('article, [role="dialog"]')) break;
      }
    }
    return [...cards].filter(card => !this.isForbiddenContainer(card) &&
      ![...cards].some(other => other !== card && card.contains(other)));
  },

  getRovoFieldTarget(card) {
    if (!(card instanceof HTMLElement)) return null;
    const editable = card.querySelector('[contenteditable="true"], textarea');
    if (editable) return editable;

    const headings = [...card.querySelectorAll('h2, h3, h4, h5, h6, label, strong, dt')]
      .filter(label => ['current acceptance criteria', 'description', 'acceptance criteria', 'summary', 'product copy']
        .includes(label.textContent?.replace(/\s+/g, ' ').trim().toLowerCase() || ''));
    if (!headings.length) return null;

    const heading = headings[0];
    const block = ['P', 'DIV', 'SECTION', 'ARTICLE', 'UL', 'OL', 'TEXTAREA'].includes(heading.nextElementSibling?.tagName || '')
      ? heading.nextElementSibling : heading.parentElement;
    return block instanceof HTMLElement ? block : null;
  },

  getRovoExplicitChange(card) {
    if (!(card instanceof window.HTMLElement)) return null;
    const headings = [...card.querySelectorAll('h2, h3, h4, h5, h6, label, strong, dt, span, div')]
      .filter(element => !element.closest('.jira-diff-rovo-card, .enhanced-diff'));
    const findLabeledValue = expression => {
      const heading = headings.find(element => expression.test(element.textContent?.replace(/\s+/g, ' ').trim() || '') &&
        ![...element.children].some(child => expression.test(child.textContent?.replace(/\s+/g, ' ').trim() || '')));
      if (!heading) return null;
      let value = heading?.nextElementSibling;
      if (!value && heading?.parentElement?.textContent.trim() === heading.textContent.trim()) value = heading.parentElement.nextElementSibling;
      return value instanceof HTMLElement ? this.captureRovoFieldText(value) : null;
    };
    const field = '(?:acceptance criteria|description|summary|product copy|value)';
    const oldText = findLabeledValue(new RegExp(`^(?:(?:current|original|old)(?: ${field})?|before):?$`, 'i'));
    const newText = findLabeledValue(new RegExp(`^(?:(?:suggested|proposed|new)(?: (?:update|${field}))?|after):?$`, 'i'));
    if (oldText === null || newText === null) return this.getRovoInlineChange(card);
    return { oldText, newText };
  },

  getRovoInlineChange(root) {
    const containers = [...root.querySelectorAll('.ak-renderer-document, [data-testid*="diff"]')];
    if (root.matches('.ak-renderer-document, [data-testid*="diff"]')) containers.unshift(root);
    const candidates = containers.filter(container => container.querySelector('ins, del') &&
      !container.closest('.jira-diff-rovo-card, .enhanced-diff') &&
      !containers.some(other => other !== container && container.contains(other) && other.querySelector('ins, del')));
    // Do not join unrelated fields or guess a baseline from the new value.
    if (candidates.length !== 1) return null;
    const before = candidates[0].cloneNode(true);
    const after = candidates[0].cloneNode(true);
    before.querySelectorAll('ins').forEach(node => node.remove());
    after.querySelectorAll('del').forEach(node => node.remove());
    return { oldText: this.readFieldText(before), newText: this.readFieldText(after) };
  },

  captureRovoFieldText(field) {
    if (!field) return null;
    const editable = field.isContentEditable ? field : field.querySelector('[contenteditable="true"]');
    const textarea = field.matches('textarea') ? field : field.querySelector?.('textarea');
    if (editable) return this.readFieldText(editable);
    if (textarea) return textarea.value;
    return this.readFieldText(field);
  },

  getRovoLinkedPreview(card) {
    // Atlassian mounts hover previews in a portal. Only follow an explicit
    // association so another work item's suggestion cannot supply these values.
    const roots = new Set();
    for (const tooltip of document.querySelectorAll(ROVO_TOOLTIP)) {
      if (this.rovoTooltipOwners.get(tooltip) === card) roots.add(tooltip);
    }
    const anchors = new Set();
    for (const element of [card, ...card.querySelectorAll('[aria-controls], [aria-describedby], [style]')]) {
      for (const attribute of ['aria-controls', 'aria-describedby']) {
        for (const id of (element.getAttribute(attribute) || '').split(/\s+/).filter(Boolean)) {
          const root = document.getElementById(id);
          if (root) roots.add(root);
        }
      }
      const names = element.style.getPropertyValue('anchor-name');
      names.split(/[,\s]+/).filter(name => name.startsWith('--')).forEach(name => anchors.add(name));
    }
    if (anchors.size) {
      for (const element of document.querySelectorAll('[style], [popover], [role="tooltip"], [data-testid*="preview"], [data-testid*="popover"], [data-testid*="popup"]')) {
        const anchor = element.style.getPropertyValue('position-anchor').trim() ||
          window.getComputedStyle(element).getPropertyValue('position-anchor').trim();
        if (anchors.has(anchor)) roots.add(element);
      }
    }
    for (const root of roots) {
      const change = this.getRovoExplicitChange(root);
      if (change) return change;
    }
    return null;
  },

  rovoPreviewValues: new WeakMap(),
  rovoLaunchers: new WeakMap(),
  rovoTooltipOwners: new WeakMap(),
  activeRovoField: null,

  captureRovoTooltips(mutations = []) {
    if (this.rovoEnabled === false) return;
    for (const tooltip of document.querySelectorAll(ROVO_TOOLTIP)) {
      const changed = mutations.some(mutation => {
        const target = mutation.target instanceof Element ? mutation.target : mutation.target.parentElement;
        if (target?.closest('.jira-diff-rovo-card, .enhanced-diff')) return false;
        const nodes = [...mutation.addedNodes, ...mutation.removedNodes];
        if (nodes.length && nodes.every(node => node instanceof Element && node.matches('.jira-diff-rovo-card, .jira-diff-large-preview-overlay'))) return false;
        return tooltip.contains(mutation.target) ||
          [...mutation.addedNodes].some(node => node === tooltip || node.contains?.(tooltip));
      });
      if (this.activeRovoField?.isConnected && changed) {
        const field = this.activeRovoField.querySelector('[data-testid$="card-fields-list.rich-text-field"]')?.textContent
          ?.replace(/^Update\s+/i, '').trim().toLowerCase();
        const currentLabel = tooltip.querySelector('[data-testid$=".current"] h5')?.textContent?.trim().toLowerCase();
        if (!field || !currentLabel || currentLabel === `current ${field}`) {
          this.rovoTooltipOwners.set(tooltip, this.activeRovoField);
        } else {
          this.rovoTooltipOwners.delete(tooltip);
        }
      }
      const owner = this.rovoTooltipOwners.get(tooltip);
      const change = this.getRovoExplicitChange(tooltip);
      if (owner && change) this.rovoPreviewValues.set(owner, change);
    }
  },

  getRovoChange(card) {
    const change = this.getRovoExplicitChange(card) || this.getRovoLinkedPreview(card);
    if (change) this.rovoPreviewValues.set(card, change);
    return change || this.rovoPreviewValues.get(card) || null;
  },

  addRovoCard(card, settings) {
    if (!(card instanceof window.HTMLElement)) return;
    if (card.matches(ROVO_ACTION_CARD)) {
      card.querySelectorAll(ROVO_FIELD_ROW).forEach(row => this.getRovoChange(row));
      this.renderRovoLauncher(card, null, settings);
      return;
    }
    const explicitChange = this.getRovoChange(card);
    const observedValue = explicitChange?.newText ??
      this.captureRovoFieldText(this.getRovoFieldTarget(card));
    if (observedValue === null) {
      if (card.matches(`${ROVO_ACTION_CARD}, ${ROVO_FIELD_ROW}`)) {
        this.renderRovoLauncher(card, null, settings);
      }
      return;
    }

    let oldText;
    let newText;
    if (explicitChange) {
      oldText = explicitChange.oldText;
      newText = explicitChange.newText;
      card.removeAttribute('data-jira-diff-rovo-baseline');
    } else if (!card.hasAttribute('data-jira-diff-rovo-baseline')) {
      card.setAttribute('data-jira-diff-rovo-baseline', observedValue);
      return;
    } else if (observedValue === card.getAttribute('data-jira-diff-rovo-baseline')) {
      this.rovoLaunchers.get(card)?.remove();
      return;
    } else {
      oldText = card.getAttribute('data-jira-diff-rovo-baseline');
      newText = observedValue;
    }

    if (oldText === newText) {
      this.rovoLaunchers.get(card)?.remove();
      return;
    }
    this.renderRovoLauncher(card, { oldText, newText }, settings);
  },

  renderRovoLauncher(card, change, settings) {
    const buttonsIn = root => [...root.querySelectorAll('button, [role="button"]')]
      .filter(button => !button.closest('.jira-diff-rovo-card, .enhanced-diff') && !button.closest(ROVO_FIELD_ROW));
    let scope = card;
    let nativeButtons = buttonsIn(scope);
    let accept = nativeButtons.find(button => /^(?:accept all|accept changes|review and accept changes)$/i.test(ActivityControls.controlText(button)));
    // Some cards put the shared actions in a sibling of the fields renderer.
    if (!accept && card.matches(ROVO_ACTION_CARD)) {
      for (let parent = card.parentElement, depth = 0; parent && parent !== document.body && depth < 3; parent = parent.parentElement, depth++) {
        if (parent.querySelectorAll(ROVO_ACTION_CARD).length !== 1) break;
        const buttons = buttonsIn(parent);
        const sharedAccept = buttons.find(button => /^accept all$/i.test(ActivityControls.controlText(button)));
        if (sharedAccept) {
          scope = parent;
          nativeButtons = buttons;
          accept = sharedAccept;
          break;
        }
      }
    }
    const dismiss = nativeButtons.find(button => /^dismiss$/i.test(ActivityControls.controlText(button)));
    let footer = accept?.parentElement;
    while (footer && footer !== scope && dismiss && !footer.contains(dismiss)) footer = footer.parentElement;
    if (!footer || !scope.contains(footer)) footer = card;

    // React may replace a field row while leaving an injected sibling behind.
    // Own one launcher per card and remove stale panels from earlier renders.
    const existing = this.rovoLaunchers.get(card);
    scope.querySelectorAll('.jira-diff-rovo-card').forEach(wrapper => {
      if (wrapper !== existing) wrapper.remove();
    });
    const signature = JSON.stringify([change, settings]);
    if (existing?.isConnected && existing.parentElement === footer && existing.jiraDiffSignature === signature) return;
    existing?.remove();

    const wrapper = document.createElement('span');
    wrapper.className = 'jira-diff-rovo-card';
    if (footer === card) wrapper.classList.add('jira-diff-rovo-fallback');
    wrapper.jiraDiffSignature = signature;
    wrapper.setAttribute('aria-label', 'Jira Rovo change preview');
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'diff-large-preview jira-diff-rovo-button';
    button.textContent = 'View full diff';
    button.addEventListener('click', event => {
      event.preventDefault();
      event.stopPropagation();
      const rows = card.matches(ROVO_ACTION_CARD) ? [...card.querySelectorAll(ROVO_FIELD_ROW)] : [];
      const fields = rows.map(row => {
        const label = row.querySelector('[data-testid$="card-fields-list.rich-text-field"]')?.textContent
          ?.replace(/^Update\s+/i, '').trim() || 'Suggested field';
        return { label: label.charAt(0).toUpperCase() + label.slice(1), ...this.getRovoChange(row) };
      });
      const latestChange = rows.length ? fields.find(field => field.oldText !== undefined) : this.getRovoChange(card) || change;
      if (latestChange) {
        body.hidden = true;
        this.createLargePreview(latestChange.oldText, latestChange.newText, settings, fields);
      } else {
        body.hidden = false;
        body.textContent = 'Hover a suggested field to load its comparison, then choose View full diff.';
        body.setAttribute('role', 'status');
      }
    });
    const body = document.createElement('span');
    body.className = 'jira-diff-rovo-status';
    body.hidden = true;
    wrapper.append(button, body);
    this.rovoLaunchers.set(card, wrapper);
    let before = dismiss || accept;
    while (before && before.parentElement !== footer && before !== footer) before = before.parentElement;
    footer.insertBefore(wrapper, before === footer ? null : before || null);
  },

  enhanceRovoPreviews(settings = {}) {
    this.rovoEnabled = settings.rovoPreviewsEnabled !== false;
    const cards = this.findRovoConfirmationCards();
    if (settings.rovoPreviewsEnabled === false) {
      this.rovoPreviewValues = new WeakMap();
      document.querySelectorAll('.jira-diff-rovo-card').forEach(card => card.remove());
      document.querySelectorAll('[data-jira-diff-rovo-baseline]').forEach(card => card.removeAttribute('data-jira-diff-rovo-baseline'));
      return;
    }

    for (const card of cards) {
      this.addRovoCard(card, settings);
    }
  },

  addLargePreviewButton(toolbar, oldText, newText, settings) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'diff-large-preview';
    button.textContent = 'Open large preview';
    button.addEventListener('click', () => this.createLargePreview(oldText, newText, settings));
    toolbar.appendChild(button);
  },

  createOriginalPreview(oldText, newText, settings) {
    const container = document.createElement('div');
    container.className = 'enhanced-diff original-diff';
    const toolbar = document.createElement('div');
    toolbar.className = 'diff-toolbar';
    const title = document.createElement('span');
    title.className = 'diff-toolbar-title';
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
    this.addLargePreviewButton(toolbar, oldText, newText, settings);
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
    title.className = 'diff-toolbar-title';
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'diff-view-toggle';
    toolbar.append(title, toggle);
    this.addLargePreviewButton(toolbar, oldText, newText, settings);
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
    if (this.disposed || window.diffObserver) return;

    const triggerEnhance = () => {
      if (!this.isEnhancing) this.debouncedEnhanceDiff();
    };

    window.diffObserver = new MutationObserver(muts => {
      // Capture native hover text in the mutation microtask, before it can
      // disappear while the user moves to our launcher.
      this.captureRovoTooltips(muts);
      const relevant = muts.some(m =>
        (m.addedNodes.length || m.removedNodes.length || m.type === 'characterData' || m.type === 'attributes') &&
        !(m.target instanceof Element ? m.target : m.target.parentElement)?.closest('.enhanced-diff, .jira-activity-shortcuts, .jira-diff-rovo-card, .jira-diff-large-preview-overlay')
      );
      if (relevant) triggerEnhance();
    });

    window.diffObserver.observe(document.body, {
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['aria-selected', 'aria-pressed', 'aria-expanded', 'aria-controls', 'aria-describedby', 'data-state'],
      subtree: true
    });

    this.activityClickHandler = e => {
      if (!(e.target instanceof Element)) return;
      const control = e.target.closest('button, [role="tab"], [role="button"]');
      if (e.isTrusted && control && ActivityControls.findToolbars().some(root => root.contains(control))) {
        ActivityControls.initialized.add(ActivityControls.context);
      }
      const btn = e.target.closest(
        '#JSW_ACTIVITY_FEED_BUTTONS button, [data-testid^="issue-activity-feed.ui.buttons"]'
      );
      if (!btn) return;

      setTimeout(triggerEnhance, 200);
    };
    document.addEventListener('click', this.activityClickHandler, true);
    this.rovoInteractionHandler = event => {
      if (!(event.target instanceof Element)) return;
      const row = event.target.closest(ROVO_FIELD_ROW);
      if (row) this.activeRovoField = row;
    };
    for (const type of ['pointerover', 'mouseover', 'focusin']) {
      document.addEventListener(type, this.rovoInteractionHandler, true);
    }
  },

  disconnectObserver() {
    window.diffObserver?.disconnect();
    window.diffObserver = null;
    if (this.rovoInteractionHandler) {
      for (const type of ['pointerover', 'mouseover', 'focusin']) {
        document.removeEventListener(type, this.rovoInteractionHandler, true);
      }
      this.rovoInteractionHandler = null;
    }
    if (this.activityClickHandler) {
      document.removeEventListener('click', this.activityClickHandler, true);
      this.activityClickHandler = null;
    }
  },

  async removeEnhancements() {
    try {
      this.closeLargePreview?.();
      this.rovoPreviewValues = new WeakMap();
      this.rovoTooltipOwners = new WeakMap();
      this.activeRovoField = null;
      document.querySelectorAll('.jira-diff-rovo-card').forEach(card => card.remove());
      document.querySelectorAll('[data-jira-diff-rovo-baseline]').forEach(card => card.removeAttribute('data-jira-diff-rovo-baseline'));
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
          ActivityControls.remove();
          ActivityControls.initialized.clear();
          DiffHighlighter.disconnectObserver();
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
          ActivityControls.remove();
          ActivityControls.initialized.clear();
          DiffHighlighter.disconnectObserver();
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
  function executedFunction(...args) {
    const later = () => {
      clearTimeout(timeout);
      func.apply(this, args);
    };
    clearTimeout(timeout);
    timeout = setTimeout(later, wait);
  }
  executedFunction.cancel = () => clearTimeout(timeout);
  return executedFunction;
}

// Initialize
DiffHighlighter.debouncedEnhanceDiff = debounce(DiffHighlighter.enhanceDiff.bind(DiffHighlighter), 250);
const messageListener = (request, sender, sendResponse) => {
  MessageHandler.handleMessage(request, sender, sendResponse)
    .catch(error => {
      console.error('Error in message listener:', error);
      sendResponse({status: "error", message: error.message});
    });
  return true;
};
globalThis.__jiraDiffContentScript = {
  highlighter: DiffHighlighter,
  activityControls: ActivityControls,
  dispose() {
    DiffHighlighter.disposed = true;
    DiffHighlighter.disconnectObserver();
    DiffHighlighter.debouncedEnhanceDiff.cancel();
    DiffHighlighter.removeEnhancements();
    ActivityControls.remove();
    chrome.runtime.onMessage.removeListener?.(messageListener);
  },
};
DiffHighlighter.init();
chrome.runtime.onMessage.addListener(messageListener);
})();
