const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const source = fs.readFileSync(path.join(__dirname, '../content/content.js'), 'utf8');
const diffSource = fs.readFileSync(path.join(__dirname, '../lib/diff_match_patch.js'), 'utf8');
const rovoTooltip = fs.readFileSync(path.join(__dirname, 'fixtures/rovo-field-tooltip.html'), 'utf8');

async function setup(t, html) {
  const dom = new JSDOM(html, {
    url: 'https://example.atlassian.net/browse/TEST-1',
    runScripts: 'outside-only',
  });
  t.after(() => dom.window.close());
  const settings = { extensionEnabled: false, diffView: 'side-by-side' };
  const originals = {};
  let messageListener;
  const storage = data => ({
    async get(key) {
      return Object.fromEntries((Array.isArray(key) ? key : [key]).map(item => [item, data[item]]));
    },
    async set(values) { Object.assign(data, values); },
    async remove(key) { delete data[key]; },
  });
  dom.window.chrome = {
    runtime: { id: 'test-extension', onMessage: { addListener(fn) { messageListener = fn; } } },
    storage: { sync: storage(settings), local: storage(originals) },
  };
  dom.window.eval(diffSource);
  dom.window.eval(source);
  dom.window.highlighter = dom.window.__jiraDiffContentScript.highlighter;
  // Let initialization finish with the extension disabled, then run it explicitly.
  await new Promise(resolve => setImmediate(resolve));
  settings.extensionEnabled = true;
  return {
    window: dom.window,
    document: dom.window.document,
    highlighter: dom.window.highlighter,
    settings,
    message: request => new Promise(resolve => messageListener(request, {}, resolve)),
  };
}

function row(field, oldValue = 'Before', newValue = 'After', update = 'updated') {
  return `<section class="history-row"><div><span>Alice ${update} the </span><strong>${field}</strong></div>
    <div class="values"><div>${oldValue}</div><span>→</span><div>${newValue}</div></div></section>`;
}

test('blank and null saved domains do not throw during page initialization', async t => {
  const { highlighter, settings } = await setup(t, '');
  for (const allowedDomains of [[null, '', ' ', 123, 'atlassian.net'], ',atlassian.net,\n', [null, '', ' ']]) {
    settings.allowedDomains = allowedDomains;
    assert.equal(await highlighter.isAllowedJiraPage(), true);
  }
});

test('enhances every field independently without needing a Description entry', async t => {
  const fields = ['Acceptance Criteria', 'Product Copy', 'Custom field 12345', 'Priority', 'Description'];
  const { document, highlighter } = await setup(t, fields.map(field => row(field)).join(''));
  assert.equal(highlighter.findDiffContainers().length, fields.length);
  await highlighter.enhanceDiff();
  assert.equal(document.querySelectorAll('.enhanced-diff').length, fields.length);
  for (const entry of document.querySelectorAll('.history-row')) {
    assert.equal(entry.querySelector('.diff-before .diff-line-text').textContent, 'Before');
    assert.equal(entry.querySelector('.diff-after .diff-line-text').textContent, 'After');
    assert.ok(entry.querySelector('.diff-removed'));
    assert.ok(entry.querySelector('.diff-added'));
  }
  await highlighter.enhanceDiff();
  assert.equal(document.querySelectorAll('.enhanced-diff').length, fields.length);
});

test('supports populating and clearing custom fields', async t => {
  const { document, highlighter } = await setup(t,
    row('Acceptance Criteria', '', 'New criteria') + row('Product Copy', 'Old copy', '') + row('Empty', '', ''));
  await highlighter.enhanceDiff();
  const panes = document.querySelectorAll('.enhanced-diff');
  assert.equal(panes.length, 2);
  assert.equal(panes[0].querySelector('.diff-before').textContent, '');
  assert.equal(panes[0].querySelector('.diff-added .diff-line-text').textContent, 'New criteria');
  assert.equal(panes[1].querySelector('.diff-removed .diff-line-text').textContent, 'Old copy');
  assert.equal(panes[1].querySelector('.diff-after').textContent, '');
});

test('recognizes changed, added, removed and cleared history actions', async t => {
  const { document, highlighter } = await setup(t,
    row('Acceptance Criteria', 'Old', 'New', 'changed') +
    row('Product Copy', '', 'Copy', 'added') +
    row('Other field', 'Old', '', 'removed') +
    row('Another field', 'Old', '', 'cleared'));
  await highlighter.enhanceDiff();
  assert.equal(document.querySelectorAll('.enhanced-diff').length, 4);
});

test('keeps localized update detection independent of custom field names', async t => {
  const updates = ['actualizado', 'aktualisiert', 'mis à jour', 'aggiornato', 'atualizou', 'обновил', '更新', 'bijgewerkt'];
  const { document, highlighter } = await setup(t, updates.map(update => row('Team-specific field', 'Old', 'New', update)).join(''));
  await highlighter.enhanceDiff();
  assert.equal(document.querySelectorAll('.enhanced-diff').length, updates.length);
});

test('supports wrapped history headers and icon separators', async t => {
  const { document, highlighter } = await setup(t, `<section>
    <div><div><div>Alice</div><div>updated Acceptance Criteria</div></div><div>Yesterday</div></div>
    <div class="values"><div>Before</div><span><svg aria-label="to"></svg></span><div>After</div></div>
  </section>`);
  await highlighter.enhanceDiff();
  assert.equal(document.querySelectorAll('.enhanced-diff').length, 1);
});

test('leaves creation forms, interactive controls, comments and unrelated layouts alone', async t => {
  const html = `<div data-testid="issue-create.dialog">${row('Product Copy')}</div>
    ${row('Interactive', '<input value="Before">', 'After')}
    ${row('Editable', '<div contenteditable="true">Before</div>', 'After')}
    <section><div>Alice commented on Product Copy</div><div><div>Old</div><span>→</span><div>New</div></div></section>
    <section><div>Alice updated Product Copy</div><div><div>First</div><div>Second</div><div>Third</div></div></section>
    <div><div>First</div><span>→</span><div>Third</div></div>`;
  const { document, highlighter } = await setup(t, html);
  const original = document.body.innerHTML;
  await highlighter.enhanceDiff();
  assert.equal(document.body.innerHTML, original);
});

test('treats field values as text and retains large change toggles', async t => {
  const copy = '&lt;img src=x onerror="alert(1)"&gt;' + 'x'.repeat(600);
  const { document, highlighter } = await setup(t, row('Product Copy', '', copy));
  await highlighter.enhanceDiff();
  assert.equal(document.querySelector('.enhanced-diff img'), null);
  const button = document.querySelector('.large-change-toggle');
  assert.equal(button.getAttribute('aria-expanded'), 'false');
  button.click();
  assert.equal(button.getAttribute('aria-expanded'), 'true');
  assert.equal(document.querySelector('.large-change-full-text .diff-line-text').textContent, '<img src=x onerror="alert(1)">' + 'x'.repeat(600));
  button.click();
  assert.equal(document.querySelector('.large-change-full-text'), null);
});

test('restores custom field values and resumes observing after a toggle', async t => {
  const { document, highlighter, message, window } = await setup(t, row('Product Copy'));
  const original = document.querySelector('.values').innerHTML;
  await highlighter.enhanceDiff();
  highlighter.setupObserver();
  assert.equal((await message({ action: 'toggleExtension', enabled: false })).status, 'success');
  assert.equal(document.querySelector('.values').innerHTML, original);
  assert.equal(document.querySelector('.enhanced-diff'), null);
  assert.equal(window.diffObserver, null);
  await message({ action: 'toggleExtension', enabled: true });
  document.body.insertAdjacentHTML('beforeend', row('Acceptance Criteria'));
  await new Promise(resolve => setTimeout(resolve, 350));
  assert.equal(document.querySelectorAll('.enhanced-diff').length, 2);
  // Jira may change a text node in an existing history entry after rendering.
  const values = document.createElement('section');
  values.innerHTML = row('Late field', 'Previous', 'Next', 'viewed');
  document.body.append(values);
  await new Promise(resolve => setTimeout(resolve, 350));
  values.querySelector('span').firstChild.data = 'Alice updated the ';
  await new Promise(resolve => setTimeout(resolve, 350));
  assert.equal(document.querySelectorAll('.enhanced-diff').length, 3);
});

test('reapplies the preview when Jira replaces an enhanced row', async t => {
  const { document, highlighter } = await setup(t, row('Product Copy'));
  await highlighter.enhanceDiff();
  highlighter.setupObserver();
  document.querySelector('.values').innerHTML = '<div>Old copy</div><span>→</span><div>Revised copy</div>';
  await new Promise(resolve => setTimeout(resolve, 350));
  assert.equal(document.querySelectorAll('.enhanced-diff').length, 1);
  assert.equal(document.querySelector('.diff-after .diff-line-text').textContent, 'Revised copy');
});

test('unified Git hunks support three context lines and correct line numbers', async t => {
  const oldLines = Array.from({ length: 14 }, (_, i) => `Line ${i + 1}`);
  const newLines = [...oldLines];
  newLines[7] = 'Revised line 8';
  const { document, highlighter, settings } = await setup(t,
    row('Acceptance Criteria', oldLines.join('\n') + '\n', newLines.join('\n') + '\n'));
  Object.assign(settings, { diffView: 'changes', contextLines: 3 });
  await highlighter.enhanceDiff();
  assert.ok(document.querySelector('.unified-diff'));
  assert.equal(document.querySelector('.diff-hunk-header').textContent, '@@ -5,7 +5,7 @@');
  assert.equal(document.querySelectorAll('.diff-line').length, 8);
  assert.equal(document.querySelectorAll('.diff-context').length, 6);
  assert.equal(document.querySelector('.diff-removed .diff-old-number').textContent, '8');
  assert.equal(document.querySelector('.diff-removed .diff-new-number').textContent, '');
  assert.equal(document.querySelector('.diff-added .diff-new-number').textContent, '8');
  assert.deepEqual([...document.querySelectorAll('.diff-gap button')].map(button => button.textContent),
    ['Show 4 unchanged lines', 'Show 3 unchanged lines']);
  const gap = document.querySelector('.diff-gap button');
  gap.click();
  assert.equal(document.querySelectorAll('.diff-line').length, 12);
  gap.click();
  assert.equal(document.querySelectorAll('.diff-line').length, 8);
  document.querySelector('.diff-view-toggle').click();
  assert.equal(document.querySelectorAll('.diff-line').length, 15);
  assert.equal(document.querySelector('.diff-gap'), null);
  document.querySelector('.diff-view-toggle').click();
  assert.equal(document.querySelectorAll('.diff-line').length, 8);
});

test('zero context shows only changes in separate hunks and highlights changed words', async t => {
  const { document, highlighter, settings } = await setup(t,
    row('Product Copy', 'Heading\nBuy red shoes\nSame\nLast old\nFooter\n', 'Heading\nBuy blue shoes\nSame\nLast new\nFooter\n'));
  Object.assign(settings, { diffView: 'changes', contextLines: 0 });
  await highlighter.enhanceDiff();
  assert.equal(document.querySelector('.diff-context'), null);
  assert.equal(document.querySelectorAll('.diff-line').length, 4);
  assert.deepEqual([...document.querySelectorAll('.diff-hunk-header')].map(header => header.textContent),
    ['@@ -2,1 +2,1 @@', '@@ -4,1 +4,1 @@']);
  assert.equal(document.querySelector('.diff-word-removed').textContent, 'red');
  assert.equal(document.querySelector('.diff-word-added').textContent, 'blue');
});

test('large preview expands Git diffs without changing the page', async t => {
  const { document, highlighter } = await setup(t, row('Product Copy', 'First\nBefore', 'First\nAfter'));
  await highlighter.enhanceDiff();

  assert.equal(document.querySelector('.jira-diff-large-preview-overlay'), null);
  document.querySelector('.diff-large-preview').click();
  assert.equal(document.querySelectorAll('.jira-diff-large-preview-overlay').length, 1);
  assert.equal(document.querySelectorAll('.jira-diff-large-preview-overlay .diff-split-row').length, 2);
  document.querySelector('.jira-diff-preview-close').click();
  assert.equal(document.querySelector('.jira-diff-large-preview-overlay'), null);
});

test('Rovo accept cards gain a read-only large preview', async t => {
  const { document, highlighter } = await setup(t, `
    <article data-testid="rovo-review-card">
      <section><h4>Description</h4><div id="rovo-field" contenteditable="true">Old description</div></section>
      <section>Accept changes</section>
    </article>
  `);
  const card = document.querySelector('[data-testid="rovo-review-card"]');

  highlighter.enhanceRovoPreviews({});
  document.getElementById('rovo-field').textContent = 'New description';
  highlighter.enhanceRovoPreviews({});

  const previewCard = card.querySelector('.jira-diff-rovo-card');
  assert.ok(previewCard);
  assert.equal(previewCard.textContent.includes('Accept changes'), false);
  previewCard.querySelector('.diff-large-preview').click();
  assert.equal(document.querySelector('.jira-diff-large-preview-overlay .diff-removed .diff-line-text').textContent, 'Old description');
  assert.equal(document.querySelector('.jira-diff-large-preview-overlay .diff-added .diff-line-text').textContent, 'New description');
});

test('Rovo preview setting adds and removes acceptance preview cards', async t => {
  const { document, highlighter, settings } = await setup(t, `
    <article data-testid="rovo-review-card">
      <section><h4>Description</h4><div id="rovo-field" contenteditable="true">Old description</div></section>
      <section>Accept changes</section>
    </article>
  `);
  const card = document.querySelector('[data-testid="rovo-review-card"]');

  settings.rovoPreviewsEnabled = false;
  document.getElementById('rovo-field').textContent = 'New description';
  await highlighter.enhanceDiff();
  assert.equal(card.querySelector('.jira-diff-rovo-card'), null);

  settings.rovoPreviewsEnabled = true;
  await highlighter.enhanceDiff();
  assert.equal(card.getAttribute('data-jira-diff-rovo-baseline'), 'New description');

  settings.rovoPreviewsEnabled = false;
  await highlighter.enhanceDiff();
  assert.equal(card.querySelector('.jira-diff-rovo-card'), null);
  assert.equal(card.hasAttribute('data-jira-diff-rovo-baseline'), false);
  assert.equal(document.getElementById('rovo-field').textContent, 'New description');
});

test('Rovo Accept all cards preview current versus suggested values', async t => {
  const { document, highlighter } = await setup(t, `
    <article data-testid="rovo-accept-all">
      <section><h4>Current acceptance criteria</h4><div id="current-criteria">Old criteria</div></section>
      <section><h4>Suggested update</h4><div>New criteria</div></section>
      <button>Accept all</button>
    </article>
  `);
  const card = document.querySelector('[data-testid="rovo-accept-all"]');

  highlighter.enhanceRovoPreviews({});
  document.getElementById('current-criteria').textContent = 'Changed criteria';
  highlighter.enhanceRovoPreviews({});

  const previewCard = card.querySelector('.jira-diff-rovo-card');
  assert.ok(previewCard);
  previewCard.querySelector('.diff-large-preview').click();
  assert.equal(document.querySelector('.jira-diff-large-preview-overlay .diff-removed .diff-line-text').textContent, 'Changed criteria');
  assert.equal(document.querySelector('.jira-diff-large-preview-overlay .diff-added .diff-line-text').textContent, 'New criteria');
});

// Stable Jira hooks from the supplied Rovo card, with issue content redacted.
function rovoActionCard(anchor = '--anchor-test') {
  return `<div data-testid="update-work-item-all-fields-action-renderer.ui.action-card">
    <div data-testid="update-work-item-all-fields-action-renderer.ui.action-card.card-header">
      <button>TEST-1</button><button aria-expanded="true">Collapse suggestions</button>
    </div>
    <div><div tabindex="0" data-testid="update-work-item-all-fields-action-renderer.ui.card-fields-list" style="anchor-name: ${anchor};">
      <span role="img" aria-label="Action completed"></span>
      <span data-testid="update-work-item-all-fields-action-renderer.ui.action-card.card-fields-list.rich-text-field">Update acceptance criteria</span>
      <div data-testid="update-work-item-all-fields-action-renderer.ui.card-fields-list.action-buttons">
        <button disabled><span>Accept</span></button><button disabled><span>Dismiss</span></button>
      </div>
    </div></div>
    <div class="native-card-footer"><button>Dismiss</button><button>Accept all</button></div>
  </div>`;
}

test('supplied Rovo action card gains one launcher without requiring Accept all or changing native controls', async t => {
  const { document, highlighter } = await setup(t, rovoActionCard());
  const card = document.querySelector('[data-testid$="ui.action-card"]');
  const nativeContent = card.innerHTML;
  let nativeClicks = 0;
  card.querySelectorAll('button').forEach(button => button.addEventListener('click', () => nativeClicks++));
  await highlighter.enhanceDiff();
  await highlighter.enhanceDiff();
  assert.equal(card.querySelectorAll('.jira-diff-rovo-card').length, 1);
  const launcher = card.querySelector('.jira-diff-rovo-card');
  assert.equal(launcher.parentElement.className, 'native-card-footer');
  assert.equal(card.querySelector('aside'), null);
  assert.equal(launcher.querySelector('button').textContent, 'View full diff');
  launcher.querySelector('button').click();
  assert.equal(document.querySelector('.jira-diff-large-preview-overlay'), null);
  assert.match(launcher.querySelector('[role="status"]').textContent, /Hover a suggested field/);
  assert.equal(nativeClicks, 0);
  await highlighter.removeEnhancements();
  assert.equal(card.innerHTML, nativeContent);
});

test('Rovo footer survives field and footer replacement without duplicate or stale panels', async t => {
  const { document, highlighter } = await setup(t, rovoActionCard());
  const card = document.querySelector('[data-testid$="ui.action-card"]');
  await highlighter.enhanceDiff();
  const row = card.querySelector('[data-testid$="ui.card-fields-list"]');
  row.replaceWith(row.cloneNode(true));
  card.insertAdjacentHTML('beforeend', '<aside class="jira-diff-rovo-card">Stale description diff</aside>');
  await highlighter.enhanceDiff();
  const footer = card.querySelector('.native-card-footer');
  assert.equal(card.querySelectorAll('.jira-diff-rovo-card').length, 1);
  assert.equal(footer.querySelectorAll('.diff-large-preview').length, 1);
  assert.equal(card.textContent.includes('Stale description diff'), false);
  footer.innerHTML = '<button>Dismiss</button><button>Accept all</button>';
  await highlighter.enhanceDiff();
  await highlighter.enhanceDiff();
  assert.equal(card.querySelectorAll('.diff-large-preview').length, 1);
  assert.deepEqual([...footer.querySelectorAll('button')].map(button => button.textContent), ['View full diff', 'Dismiss', 'Accept all']);
});

test('Rovo shared actions outside the fields renderer still receive one footer button', async t => {
  const { document, highlighter } = await setup(t, `<section id="outer-card">${rovoActionCard()}</section>`);
  const outer = document.getElementById('outer-card');
  outer.appendChild(outer.querySelector('.native-card-footer'));
  await highlighter.enhanceDiff();
  await highlighter.enhanceDiff();
  assert.equal(outer.querySelectorAll('.jira-diff-rovo-card').length, 1);
  assert.equal(outer.querySelector('.diff-large-preview').parentElement.parentElement.className, 'native-card-footer');
});

test('Rovo previews follow the matching portal anchor and retain values after the hover panel closes', async t => {
  const { document, highlighter } = await setup(t, rovoActionCard() + rovoActionCard('--anchor-other'));
  const cards = document.querySelectorAll('[data-testid$="ui.action-card"]');
  highlighter.enhanceRovoPreviews({});
  document.body.insertAdjacentHTML('beforeend', `<div id="portal" style="position-anchor: --anchor-test;">
    <section><h4>Current acceptance criteria</h4><div><p>Unchanged</p><p>Old criteria</p></div></section>
    <section><h4>Suggested update</h4><div><p>Unchanged</p><p>New criteria</p></div></section>
  </div>`);
  highlighter.enhanceRovoPreviews({});
  document.getElementById('portal').remove();
  cards[0].querySelector('.diff-large-preview').click();
  assert.equal(document.querySelector('.jira-diff-large-preview-overlay .diff-removed .diff-line-text').textContent, 'Old criteria');
  assert.equal(document.querySelector('.jira-diff-large-preview-overlay .diff-added .diff-line-text').textContent, 'New criteria');
  assert.ok(document.querySelector('.jira-diff-large-preview-overlay .diff-context'));
  document.querySelector('.jira-diff-preview-close').click();
  cards[1].querySelector('.diff-large-preview').click();
  assert.equal(document.querySelector('.jira-diff-large-preview-overlay'), null);
});

test('supplied unlinked Rovo hover tooltip opens the full values beyond its CSS line clamps', async t => {
  const { document, highlighter } = await setup(t, rovoTooltip);
  const tooltip = document.querySelector('[data-testid$="field-tooltip-content"]');
  const nativeCurrent = tooltip.querySelector('[data-testid$=".current"]');
  const nativeSuggested = tooltip.querySelector('[data-testid$=".suggested"]');
  const originals = [nativeCurrent.innerHTML, nativeSuggested.innerHTML];
  await highlighter.enhanceDiff();
  assert.equal(tooltip.querySelector('.jira-diff-rovo-card'), null);
  const { oldText, newText } = highlighter.getRovoExplicitChange(tooltip);
  highlighter.createLargePreview(oldText, newText);
  const texts = [...document.querySelectorAll('.jira-diff-large-preview-overlay .diff-after .diff-line-text')].map(line => line.textContent);
  assert.equal(texts.at(-1), 'hi');
  assert.ok(texts.includes('Existing question.'));
  assert.ok(texts.includes('## Today'));
  assert.equal(texts.length, 13);
  assert.equal(nativeCurrent.innerHTML, originals[0]);
  assert.equal(nativeSuggested.innerHTML, originals[1]);
});

test('hover capture connects the supplied unlinked tooltip to its field and survives immediate removal', async t => {
  const { document, highlighter, window, message } = await setup(t,
    rovoActionCard().replace('Update acceptance criteria', 'Update description') + rovoActionCard('--anchor-other'));
  const cards = document.querySelectorAll('[data-testid$="ui.action-card"]');
  await highlighter.enhanceDiff();
  highlighter.setupObserver();
  cards[0].querySelector('[data-testid$="ui.card-fields-list"]').dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true }));
  document.body.insertAdjacentHTML('beforeend', rovoTooltip);
  // No debounce wait: the tooltip can close before the 250 ms enhancement.
  await new Promise(resolve => setImmediate(resolve));
  document.querySelector('.Tooltip').remove();
  cards[0].querySelector('.diff-large-preview').click();
  assert.ok([...document.querySelectorAll('.jira-diff-large-preview-overlay .diff-added .diff-line-text')].some(line => line.textContent === 'hi'));
  document.querySelector('.jira-diff-preview-close').click();
  cards[1].querySelector('.diff-large-preview').click();
  assert.equal(document.querySelector('.jira-diff-large-preview-overlay'), null);
  await message({ action: 'toggleExtension', enabled: false });
  assert.equal(document.querySelector('.jira-diff-rovo-card'), null);
  assert.equal(highlighter.rovoInteractionHandler, null);
});

test('multiple fields in one Rovo card retain separate hover comparisons', async t => {
  const { document, highlighter, window } = await setup(t, rovoActionCard());
  const first = document.querySelector('[data-testid$="ui.card-fields-list"]');
  const second = first.cloneNode(true);
  first.querySelector('[data-testid$="card-fields-list.rich-text-field"]').textContent = 'Update description';
  first.parentElement.appendChild(second);
  await highlighter.enhanceDiff();
  highlighter.setupObserver();
  for (const [row, html] of [[first, rovoTooltip], [second, rovoTooltip.replace('Current description', 'Current acceptance criteria').replace('\nhi</span>', '\nNew criteria</span>')]]) {
    row.dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true }));
    document.body.insertAdjacentHTML('beforeend', html);
    await new Promise(resolve => setImmediate(resolve));
    document.querySelector('.Tooltip').remove();
  }
  const launchers = document.querySelectorAll('.jira-diff-rovo-card');
  assert.equal(launchers.length, 1);
  const additions = () => [...document.querySelectorAll('.jira-diff-large-preview-overlay .diff-added .diff-line-text')].map(line => line.textContent);
  launchers[0].querySelector('button').click();
  assert.ok(additions().includes('hi'));
  assert.equal(additions().includes('New criteria'), false);
  const selector = document.querySelector('.jira-diff-preview-field');
  assert.deepEqual([...selector.options].map(option => option.textContent), ['Description', 'Acceptance criteria']);
  selector.selectedIndex = 1;
  selector.dispatchEvent(new window.Event('change'));
  assert.ok(additions().includes('New criteria'));
  assert.equal(additions().includes('hi'), false);
});

test('wrapped Accept changes buttons support Description values already rendered on first detection', async t => {
  const { document, highlighter } = await setup(t, `<article>
    <section><div><span>Current description</span></div><div>Before</div></section>
    <section><div><span>Suggested description</span></div><div>After</div></section>
    <div data-testid="actions"><button data-testid="accept-button"><span>Accept changes</span></button></div>
  </article>`);
  await highlighter.enhanceDiff();
  document.querySelector('.jira-diff-rovo-card button').click();
  assert.equal(document.querySelector('.jira-diff-large-preview-overlay .diff-removed .diff-line-text').textContent, 'Before');
  assert.equal(document.querySelector('.jira-diff-large-preview-overlay .diff-added .diff-line-text').textContent, 'After');
});

test('Rovo explicit comparisons support empty original or suggested values', async t => {
  const { document, highlighter } = await setup(t, `<article>
    <section><h4>Current description</h4><div>Before</div></section>
    <section><h4>Suggested update</h4><div></div></section>
    <button>Accept changes</button>
  </article>`);
  await highlighter.enhanceDiff();
  document.querySelector('.jira-diff-rovo-card button').click();
  assert.equal(document.querySelector('.jira-diff-large-preview-overlay .diff-removed .diff-line-text').textContent, 'Before');
  assert.equal(document.querySelector('.jira-diff-large-preview-overlay .diff-added'), null);
});

test('Rovo native rich-text insertions and deletions reconstruct both versions', async t => {
  const { document, highlighter } = await setup(t, `<article>
    <div class="ak-renderer-document"><p>Same</p><p>Buy <del>red</del><ins>blue</ins> shoes</p><p>Footer</p></div>
    <button>Accept changes</button>
  </article>`);
  const native = document.querySelector('.ak-renderer-document');
  const original = native.innerHTML;
  await highlighter.enhanceDiff();
  document.querySelector('.jira-diff-rovo-card button').click();
  assert.equal(document.querySelector('.jira-diff-large-preview-overlay .diff-removed .diff-line-text').textContent, 'Buy red shoes');
  assert.equal(document.querySelector('.jira-diff-large-preview-overlay .diff-added .diff-line-text').textContent, 'Buy blue shoes');
  assert.equal(native.innerHTML, original);
});

test('full previews show long changes immediately, trap focus and close on disable', async t => {
  const { document, highlighter, window, message } = await setup(t, '<button id="opener">Open</button>');
  document.getElementById('opener').focus();
  highlighter.createLargePreview('Same\n' + 'Old '.repeat(160), 'Same\n' + 'New '.repeat(160), { diffView: 'original' });
  const overlay = document.querySelector('.jira-diff-large-preview-overlay');
  assert.ok(overlay.querySelector('.diff-context'));
  assert.equal(overlay.querySelector('.large-change-toggle'), null);
  assert.equal(overlay.querySelector('.diff-added .diff-line-text').textContent, 'New '.repeat(160));
  const controls = [...overlay.querySelectorAll('button, [tabindex="0"]')];
  document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, cancelable: true }));
  assert.equal(document.activeElement, controls.at(-1));
  await message({ action: 'toggleExtension', enabled: false });
  assert.equal(document.querySelector('.jira-diff-large-preview-overlay'), null);
  assert.equal(document.body.classList.contains('jira-diff-preview-open'), false);
  assert.equal(document.activeElement.id, 'opener');
});

test('line diff preserves whitespace, blank lines, repeated lines and final newline changes', async t => {
  const { highlighter } = await setup(t, '');
  const pairs = [
    ['', 'one\ntwo\n'], ['one\ntwo\n', ''],
    ['  * copy  \n\n\tIndented\n', '  * copy \n\n\tNew\n'],
    ['repeat\nrepeat\nend', 'repeat\nchanged\nrepeat\nend'],
    ['line\n', 'line'], ['line', 'line\n'], ['\n\n', '\n'],
  ];
  for (const [oldText, newText] of pairs) {
    const rows = highlighter.getLineDiff(oldText, newText);
    const reconstruct = operation => rows.filter(row => row.operation !== operation)
      .map(row => row.text + (row.hasNewline ? '\n' : '')).join('');
    assert.equal(reconstruct(1), oldText);
    assert.equal(reconstruct(-1), newText);
  }
});

test('renders additions, deletions, whitespace-only edits and missing newline markers', async t => {
  const { document, highlighter, settings } = await setup(t,
    row('Added', '', 'one\ntwo\n') + row('Removed', 'one\ntwo\n', '') +
    row('Whitespace', '  ', ' ') + row('Newline', 'line\n', 'line'));
  Object.assign(settings, { diffView: 'changes', contextLines: 0 });
  await highlighter.enhanceDiff();
  assert.equal(document.querySelectorAll('.unified-diff').length, 4);
  const headers = [...document.querySelectorAll('.diff-hunk-header')].map(header => header.textContent);
  assert.deepEqual(headers.slice(0, 2), ['@@ -0,0 +1,2 @@', '@@ -1,2 +0,0 @@']);
  assert.equal(document.querySelectorAll('.history-row')[2].querySelector('.diff-removed .diff-line-text').textContent, '  ');
  assert.ok(document.querySelectorAll('.history-row')[3].querySelector('.diff-newline-marker'));
});

test('preserves line breaks in rich-text history values', async t => {
  const { document, highlighter, settings } = await setup(t,
    row('Acceptance Criteria', '<p>First<br>Second</p><p>Third</p>', '<p>First<br>Revised</p><p>Third</p>'));
  settings.diffView = 'full';
  await highlighter.enhanceDiff();
  const texts = [...document.querySelectorAll('.diff-line-text')].map(line => line.textContent);
  assert.deepEqual(texts, ['First', 'Second', 'Revised', 'Third']);
});

test('unified full view retains large-change expansion and safely renders literal HTML', async t => {
  const { document, highlighter, settings } = await setup(t,
    row('Product Copy', 'Heading\n', 'Heading\n&lt;img src=x&gt;\n' + 'x'.repeat(600) + '\n'));
  settings.diffView = 'full';
  await highlighter.enhanceDiff();
  assert.equal(document.querySelector('.diff-view-toggle').textContent, 'Show changed lines');
  const button = document.querySelector('.large-change-toggle');
  assert.equal(document.querySelector('.diff-added'), null);
  button.click();
  assert.equal(document.querySelectorAll('.diff-added').length, 2);
  assert.equal(document.querySelector('.diff-added .diff-new-number').textContent, '2');
  assert.equal(document.querySelector('.diff-added .diff-line-text').textContent, '<img src=x>');
  assert.equal(document.querySelector('.enhanced-diff img'), null);
  button.click();
  assert.equal(document.querySelector('.diff-added'), null);
});

test('saved preview settings refresh existing rows and the original view remains restorable', async t => {
  const { document, highlighter, settings, message } = await setup(t,
    row('Product Copy', 'Same\nOld\n', 'Same\nNew\n'));
  const original = document.querySelector('.values').innerHTML;
  await highlighter.enhanceDiff();
  assert.ok(document.querySelector('.split-diff'));
  Object.assign(settings, { diffView: 'changes', contextLines: 0 });
  await message({ action: 'checkExtensionState' });
  assert.ok(document.querySelector('.unified-diff'));
  assert.equal(document.querySelector('.diff-context'), null);
  settings.diffView = 'full';
  await message({ action: 'checkExtensionState' });
  assert.ok(document.querySelector('.diff-context'));
  await message({ action: 'toggleExtension', enabled: false });
  assert.equal(document.querySelector('.values').innerHTML, original);
});

test('default preview aligns changed lines side-by-side with no unchanged lines', async t => {
  const { document, highlighter, settings } = await setup(t,
    row('Product Copy', 'Heading\nOld copy\nFooter\n', 'Heading\nNew copy\nExtra copy\nFooter\n'));
  delete settings.diffView;
  await highlighter.enhanceDiff();
  assert.ok(document.querySelector('.split-diff'));
  assert.equal(document.querySelector('.diff-context'), null);
  const pairs = document.querySelectorAll('.diff-split-row');
  assert.equal(pairs.length, 2);
  assert.equal(pairs[0].querySelector('.diff-before .diff-line-text').textContent, 'Old copy');
  assert.equal(pairs[0].querySelector('.diff-after .diff-line-text').textContent, 'New copy');
  assert.equal(pairs[0].querySelector('.diff-before .diff-old-number').textContent, '2');
  assert.equal(pairs[0].querySelector('.diff-after .diff-new-number').textContent, '2');
  assert.ok(pairs[1].querySelector('.diff-before.diff-empty-side'));
  assert.equal(pairs[1].querySelector('.diff-after .diff-new-number').textContent, '3');
  assert.equal(document.querySelector('.diff-hunk-header').textContent, '@@ -2,1 +2,2 @@');
  assert.equal(document.querySelector('.diff-word-removed').textContent, 'Old');
  assert.equal(document.querySelector('.diff-word-added').textContent, 'New');
  document.querySelector('.diff-view-toggle').click();
  assert.equal(document.querySelectorAll('.diff-split-row').length, 4);
  assert.equal(document.querySelectorAll('.diff-context').length, 4);
  document.querySelector('.diff-view-toggle').click();
  assert.equal(document.querySelectorAll('.diff-split-row').length, 2);
});

test('original preview restores Jira markup and allows an inline Git preview', async t => {
  const { document, highlighter, settings } = await setup(t,
    row('Product Copy', '<p>Before</p>', '<p>After</p>'));
  settings.diffView = 'original';
  await highlighter.enhanceDiff();

  const container = document.querySelector('.values');
  const enhanced = highlighter.createEnhancedDiff('Before', 'After', 500, settings);
  assert.ok(enhanced.classList.contains('original-diff'));
  assert.equal(enhanced.querySelector('.diff-toolbar-title').textContent, 'Original values');
  assert.equal(enhanced.querySelector('img'), null);
  container.replaceChild(enhanced, container.children[0]);
  while (container.children.length > 1) container.removeChild(container.lastChild);

  settings.diffView = 'side-by-side-changes';
  enhanced.querySelector('.diff-view-toggle').click();
  await new Promise(resolve => setTimeout(resolve, 300));
  await highlighter.enhanceDiff();
  assert.ok(document.querySelector('.unified-diff'));
  assert.equal(document.querySelector('.diff-before .diff-line-text').textContent, 'Before');

  await highlighter.enhanceDiff();
  container.innerHTML = container.dataset.jiraDiffOriginal;
  assert.equal(container.textContent, 'Before→After');
  delete container.dataset.jiraDiffOriginal;
});

test('split context expansion keeps both sides aligned after deletions', async t => {
  const { document, highlighter, settings } = await setup(t,
    row('Acceptance Criteria', 'First\nRemoved\nSecond\nThird\n', 'First\nSecond\nThird\n'));
  settings.diffView = 'side-by-side-changes';
  await highlighter.enhanceDiff();
  assert.equal(document.querySelectorAll('.diff-split-row').length, 1);
  assert.ok(document.querySelector('.diff-after.diff-empty-side'));
  document.querySelectorAll('.diff-gap button')[1].click();
  const pairs = document.querySelectorAll('.diff-split-row');
  assert.equal(pairs.length, 3);
  assert.equal(pairs[1].querySelector('.diff-before .diff-old-number').textContent, '3');
  assert.equal(pairs[1].querySelector('.diff-after .diff-new-number').textContent, '2');
  assert.equal(pairs[1].querySelector('.diff-before .diff-line-text').textContent, 'Second');
  assert.equal(pairs[1].querySelector('.diff-after .diff-line-text').textContent, 'Second');
});

test('split view preserves raw heading, bullet and whitespace formatting', async t => {
  const { document, highlighter, settings } = await setup(t,
    row('Product Copy', '## Old title\nh2. Jira title\n  * Old bullet  \n', '## New title\nh2. Jira title\n  * New bullet  \n'));
  settings.diffView = 'side-by-side';
  await highlighter.enhanceDiff();
  const texts = side => [...document.querySelectorAll(`.diff-${side} .diff-line-text`)].map(line => line.textContent);
  assert.deepEqual(texts('before'), ['## Old title', 'h2. Jira title', '  * Old bullet  ']);
  assert.deepEqual(texts('after'), ['## New title', 'h2. Jira title', '  * New bullet  ']);
  assert.equal(document.querySelector('.enhanced-diff h2'), null);
  assert.equal(highlighter.fallbackDiffDisplay('  * old  ', '## new').querySelector('.old-text').textContent, '  * old  ');
});

test('rendered headings are represented by literal hashtag markers in history previews', async t => {
  const { document, highlighter } = await setup(t,
    row('Acceptance Criteria', '<h2>Old heading</h2><p>Text</p>', '<h2>New heading</h2><p>Text</p>'));
  await highlighter.enhanceDiff();
  assert.equal(document.querySelector('.diff-before .diff-line-text').textContent, '## Old heading');
  assert.equal(document.querySelector('.diff-after .diff-line-text').textContent, '## New heading');
  assert.equal(document.querySelector('.enhanced-diff h2'), null);
});

test('large split replacements expand as aligned pairs and collapse together', async t => {
  const { document, highlighter, settings } = await setup(t,
    row('Product Copy', 'Old '.repeat(160) + '\nOld second\n', 'New '.repeat(160) + '\n'));
  settings.diffView = 'side-by-side-changes';
  await highlighter.enhanceDiff();
  assert.equal(document.querySelector('.diff-split-row'), null);
  const button = document.querySelector('.large-change-toggle');
  button.click();
  assert.equal(document.querySelectorAll('.diff-split-row').length, 2);
  assert.equal(document.querySelector('.diff-before .diff-line-text').textContent, 'Old '.repeat(160));
  assert.equal(document.querySelector('.diff-after .diff-line-text').textContent, 'New '.repeat(160));
  assert.ok(document.querySelectorAll('.diff-split-row')[1].querySelector('.diff-after.diff-empty-side'));
  button.click();
  assert.equal(document.querySelector('.diff-split-row'), null);
});

test('unchanged values show a clear message and can still display all lines', async t => {
  const { document, highlighter, settings } = await setup(t, row('Product Copy', 'Same\n', 'Same\n'));
  settings.diffView = 'changes';
  await highlighter.enhanceDiff();
  assert.equal(document.querySelector('.diff-empty').textContent, 'No textual changes.');
  assert.equal(document.querySelector('.diff-line'), null);
  document.querySelector('.diff-view-toggle').click();
  assert.equal(document.querySelectorAll('.diff-context').length, 1);
});
