const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../content/content.js'), 'utf8');
const styles = fs.readFileSync(path.join(__dirname, '../content/styles.css'), 'utf8');

async function setup(t, { selected = 'Comments', legacy = false, settings: saved = {}, hooks = true, singleDropdown = false, popupGroup = false } = {}) {
  const hook = label => hooks ? `data-testid="issue-activity-feed.ui.buttons.${label.toLowerCase()}"` : '';
  const html = `<section id="activity"><h2>Activity</h2><div id="filters">${legacy
    ? ['All', 'Comments', 'History', 'Work log'].map(label => `<button ${hook(label)} aria-selected="${label === selected}">${label}</button>`).join('')
    : singleDropdown
      ? `<button id="native-filter" aria-haspopup="menu" aria-expanded="false" aria-controls="activity-menu" ${hook(selected)}>${selected}</button>`
      : `<button id="native-filter" ${hook(selected)}>${selected}</button><button id="more" aria-expanded="false" aria-controls="activity-menu">More</button>`
  }</div><div id="feed">Showing ${selected}</div></section>`;
  const dom = new JSDOM(html, { url: 'https://team.atlassian.net/browse/TEST-1', runScripts: 'outside-only' });
  t.after(() => dom.window.close());
  const { window } = dom;
  const { document } = window;
  const stylesheet = document.createElement('style');
  stylesheet.textContent = styles;
  document.head.appendChild(stylesheet);
  const settings = { extensionEnabled: false, ...saved };
  let messageListener;
  const messageListeners = new Set();
  window.chrome = {
    runtime: { id: 'test', onMessage: {
      addListener(fn) { messageListener = fn; messageListeners.add(fn); },
      removeListener(fn) { messageListeners.delete(fn); },
    } },
    storage: { sync: {
      async get(keys) { return Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map(key => [key, settings[key]])); },
      async set(values) { Object.assign(settings, values); },
    } },
  };
  let menuOpenCount = 0;
  const selections = [];
  function choose(label) {
    selections.push(label);
    document.getElementById('feed').textContent = `Showing ${label}`;
    if (legacy) {
      for (const button of document.querySelectorAll('#filters button')) button.setAttribute('aria-selected', String(button.textContent === label));
    } else {
      document.getElementById('native-filter').textContent = label;
      more.setAttribute('aria-expanded', 'false');
      document.getElementById('activity-menu')?.remove();
    }
  }
  const more = document.getElementById('more') || (singleDropdown ? document.getElementById('native-filter') : null);
  more?.addEventListener('click', () => {
    if (more.getAttribute('aria-expanded') === 'true') {
      more.setAttribute('aria-expanded', 'false');
      document.getElementById('activity-menu')?.remove();
      return;
    }
    more.setAttribute('aria-expanded', 'true');
    menuOpenCount++;
    window.setTimeout(() => {
      if (more.getAttribute('aria-expanded') !== 'true') return;
      const menu = document.createElement('div');
      menu.id = 'activity-menu';
      menu.setAttribute('role', popupGroup ? 'group' : 'menu');
      if (popupGroup) menu.setAttribute('data-testid', 'activity-filter-popup-content');
      for (const label of ['All', 'Comments', 'History', 'Work log', 'Approvals']) {
        const item = document.createElement('button');
        item.setAttribute('role', 'menuitemradio');
        item.textContent = label;
        item.addEventListener('click', () => choose(label));
        menu.appendChild(item);
      }
      document.body.appendChild(menu); // Jira portals its dropdown outside the toolbar.
    }, 20);
  });
  for (const button of document.querySelectorAll('#filters button:not(#more)')) {
    if (button === more) continue;
    button.addEventListener('click', () => choose(legacy ? button.textContent : document.getElementById('native-filter').textContent));
  }
  window.eval(source);
  window.highlighter = window.__jiraDiffContentScript.highlighter;
  window.activityControls = window.__jiraDiffContentScript.activityControls;
  await new Promise(resolve => setImmediate(resolve));
  settings.extensionEnabled = true;
  return {
    window, document, settings, selections, messageListeners, dom,
    highlighter: window.highlighter, controls: window.activityControls,
    menuOpenCount: () => menuOpenCount,
    message: request => new Promise(resolve => messageListener(request, {}, resolve)),
  };
}

async function settled(controls) {
  for (let i = 0; (controls.pending || controls.defaultTasks.size) && i < 100; i++) await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(controls.pending, null);
  assert.equal(controls.defaultTasks.size, 0);
}

test('new dropdown layout exposes three filters and defaults to All through Jira', async t => {
  const { document, controls, highlighter, selections } = await setup(t);
  await highlighter.enhanceDiff();
  await settled(controls);
  await highlighter.enhanceDiff();
  assert.deepEqual([...document.querySelectorAll('.jira-activity-shortcuts button')].map(button => button.textContent), ['All', 'Comments', 'History']);
  assert.deepEqual(selections, ['All']);
  assert.equal(document.querySelector('#feed').textContent, 'Showing All');
  assert.equal(document.querySelector('.jira-activity-shortcuts button[aria-pressed="true"]').textContent, 'All');
  assert.ok(document.querySelector('#native-filter').classList.contains('jira-activity-native-filter'));
  assert.equal(document.querySelector('#more').getAttribute('aria-expanded'), 'false');
});

test('shortcuts use asynchronous native menus and keep other filters accessible', async t => {
  const { window, document, controls, highlighter, selections } = await setup(t, { selected: 'All', hooks: false });
  await highlighter.enhanceDiff();
  highlighter.setupObserver();
  const comments = document.querySelectorAll('.jira-activity-shortcuts button')[1];
  comments.focus();
  comments.click();
  await settled(controls);
  assert.equal(document.activeElement, comments);
  await new Promise(resolve => setTimeout(resolve, 350));
  assert.equal(document.querySelector('.jira-activity-shortcuts button[aria-pressed="true"]').textContent, 'Comments');
  document.querySelectorAll('.jira-activity-shortcuts button')[2].click();
  await settled(controls);
  await highlighter.enhanceDiff();
  assert.equal(document.querySelector('.jira-activity-shortcuts button[aria-pressed="true"]').textContent, 'History');
  document.querySelector('#more').click();
  await new Promise(resolve => window.setTimeout(resolve, 40));
  [...document.querySelectorAll('[role="menuitemradio"]')].find(item => item.textContent === 'Work log').click();
  await highlighter.enhanceDiff();
  assert.equal(document.querySelector('.jira-activity-shortcuts button[aria-pressed="true"]'), null);
  assert.deepEqual(selections, ['Comments', 'History', 'Work log']);
});

test('native legacy tabs are kept intact and default to All', async t => {
  const { document, highlighter, selections, controls } = await setup(t, { selected: 'History', legacy: true });
  await highlighter.enhanceDiff();
  await settled(controls);
  assert.equal(document.querySelector('.jira-activity-shortcuts'), null);
  assert.equal(document.querySelector('#filters [aria-selected="true"]').textContent, 'All');
  assert.deepEqual(selections, ['All']);
  assert.equal(document.querySelectorAll('#filters button').length, 4);
});

test('settings refresh and toolbar replacement preserve the chosen filter; navigation applies the default', async t => {
  const { window, document, controls, highlighter, message } = await setup(t, { selected: 'All' });
  await highlighter.enhanceDiff();
  document.querySelectorAll('.jira-activity-shortcuts button')[2].click();
  await settled(controls);
  await message({ action: 'checkExtensionState' });
  assert.equal(document.querySelector('#feed').textContent, 'Showing History');
  document.querySelector('.jira-activity-shortcuts').remove();
  await highlighter.enhanceDiff();
  assert.equal(document.querySelectorAll('.jira-activity-shortcuts').length, 1);
  assert.equal(document.querySelector('.jira-activity-shortcuts [aria-pressed="true"]').textContent, 'History');
  window.history.pushState({}, '', '/browse/TEST-2');
  await highlighter.enhanceDiff();
  await settled(controls);
  assert.equal(document.querySelector('#feed').textContent, 'Showing All');
});

test('saved defaults, Jira default and disabling activity controls apply without affecting diffs', async t => {
  const { document, settings, controls, highlighter, message } = await setup(t, { selected: 'All', settings: { defaultActivityFilter: 'History' } });
  await highlighter.enhanceDiff();
  await settled(controls);
  assert.equal(document.querySelector('#feed').textContent, 'Showing History');
  settings.defaultActivityFilter = 'Jira default';
  await highlighter.enhanceDiff();
  assert.equal(document.querySelector('#feed').textContent, 'Showing History');
  settings.defaultActivityFilter = 'All';
  await highlighter.enhanceDiff();
  await settled(controls);
  assert.equal(document.querySelector('#feed').textContent, 'Showing All');
  settings.activityTabsEnabled = false;
  await message({ action: 'checkExtensionState' });
  assert.equal(document.querySelector('.jira-activity-shortcuts'), null);
  assert.equal(document.querySelector('.jira-activity-native-filter'), null);
  settings.activityTabsEnabled = true;
  await message({ action: 'checkExtensionState' });
  assert.ok(document.querySelector('.jira-activity-shortcuts'));
  await message({ action: 'toggleExtension', enabled: false });
  assert.equal(document.querySelector('.jira-activity-shortcuts'), null);
  assert.equal(document.querySelector('.jira-activity-native-filter'), null);
});

test('unrelated All and More buttons are untouched outside an Activity section', async t => {
  const { document, highlighter } = await setup(t);
  document.body.innerHTML = '<section><h2>Search results</h2><button>All</button><button>More</button></section>';
  await highlighter.enhanceDiff();
  assert.equal(document.querySelector('.jira-activity-shortcuts'), null);
  assert.equal(document.querySelector('.jira-activity-native-filter'), null);
});

test('shortcuts can use an already-open menu without toggling or selecting an unrelated menu', async t => {
  const { document, controls, highlighter, menuOpenCount } = await setup(t, { selected: 'All' });
  await highlighter.enhanceDiff();
  document.querySelector('#more').removeAttribute('aria-controls');
  document.querySelector('#more').click();
  await new Promise(resolve => setTimeout(resolve, 40));
  document.querySelector('#activity-menu').setAttribute('aria-labelledby', 'more');
  const unrelated = document.createElement('div');
  unrelated.setAttribute('role', 'menu');
  unrelated.innerHTML = '<button role="menuitem">History</button>';
  document.body.appendChild(unrelated);
  let unrelatedClicks = 0;
  unrelated.querySelector('button').addEventListener('click', () => { unrelatedClicks++; });
  await controls.select(document.querySelector('#filters'), 'History');
  assert.equal(document.querySelector('#feed').textContent, 'Showing History');
  assert.equal(menuOpenCount(), 1);
  assert.equal(unrelatedClicks, 0);
});

test('missing filters leave Jira usable and report the failure without changing the feed', async t => {
  const { document, controls, highlighter } = await setup(t, { selected: 'All' });
  await highlighter.enhanceDiff();
  document.querySelector('#more').click();
  await new Promise(resolve => setTimeout(resolve, 40));
  [...document.querySelectorAll('[role="menuitemradio"]')].find(item => item.textContent === 'History').remove();
  assert.equal(await controls.select(document.querySelector('#filters'), 'History'), false);
  assert.equal(document.querySelector('#feed').textContent, 'Showing All');
  assert.match(document.querySelector('.jira-activity-status').textContent, /History is unavailable/);
  assert.equal(document.querySelectorAll('.jira-activity-shortcuts button:disabled').length, 0);
  assert.equal(document.querySelector('#more').getAttribute('aria-expanded'), 'true');
});

test('disabling during menu loading cancels the pending selection and restores native controls', async t => {
  const { document, controls, highlighter, message, selections } = await setup(t, { selected: 'All' });
  await highlighter.enhanceDiff();
  document.querySelectorAll('.jira-activity-shortcuts button')[2].click();
  await message({ action: 'toggleExtension', enabled: false });
  await settled(controls);
  assert.deepEqual(selections, []);
  assert.equal(document.querySelector('.jira-activity-shortcuts'), null);
  assert.equal(document.querySelector('.jira-activity-native-filter'), null);
  assert.equal(document.querySelector('#more').getAttribute('aria-expanded'), 'false');
});

test('detects a deeply wrapped plain Activity title and controls containing SVG labels', async t => {
  const { document, controls, highlighter } = await setup(t, { hooks: false });
  document.querySelector('h2').outerHTML = '<div>'.repeat(6) + '<span>Activity</span>' + '</div>'.repeat(6);
  document.querySelector('#native-filter').innerHTML = '<span>Comments</span><svg><title>Selected activity filter</title></svg>';
  document.querySelector('#more').innerHTML = '<span>More</span><svg><title>Expand dropdown</title></svg>';
  document.querySelector('#feed').insertAdjacentHTML('beforeend', '<button>History</button>');
  await highlighter.enhanceDiff();
  assert.equal(document.querySelectorAll('.jira-activity-shortcuts button').length, 3);
  await settled(controls);
  assert.equal(document.querySelector('#feed').textContent, 'Showing All');
});

test('a single filter dropdown remains usable and shortcuts select its native menu items', async t => {
  const { document, controls, highlighter } = await setup(t, { hooks: false, singleDropdown: true });
  await highlighter.enhanceDiff();
  await settled(controls);
  await highlighter.enhanceDiff();
  assert.equal(document.querySelector('#feed').textContent, 'Showing All');
  assert.equal(document.querySelectorAll('.jira-activity-shortcuts button').length, 3);
  assert.equal(document.querySelector('.jira-activity-native-filter'), null);
  document.querySelectorAll('.jira-activity-shortcuts button')[2].click();
  await settled(controls);
  assert.equal(document.querySelector('#feed').textContent, 'Showing History');
});

test('supports activity popup groups without a menu role or aria-controls', async t => {
  const { document, controls, highlighter } = await setup(t, { popupGroup: true });
  document.querySelector('#more').removeAttribute('aria-controls');
  await highlighter.enhanceDiff();
  await settled(controls);
  assert.equal(document.querySelector('#feed').textContent, 'Showing All');
});

test('opening defaults wait for saved-filter hydration and retry a temporarily disabled native control', async t => {
  const { window, document, controls, highlighter, selections } = await setup(t, { selected: 'All', legacy: true });
  await highlighter.enhanceDiff();
  const buttons = [...document.querySelectorAll('#filters button')];
  const all = buttons.find(button => button.textContent === 'All');
  window.setTimeout(() => {
    buttons.forEach(button => button.setAttribute('aria-selected', String(button.textContent === 'Comments')));
    document.querySelector('#feed').textContent = 'Showing Comments';
    all.disabled = true;
  }, 100);
  window.setTimeout(() => { all.disabled = false; }, 550);
  await settled(controls);
  assert.equal(document.querySelector('#feed').textContent, 'Showing All');
  assert.deepEqual(selections, ['All']);
});

test('an explicit shortcut choice during startup takes precedence over the delayed opening default', async t => {
  const { document, controls, highlighter, selections } = await setup(t, { selected: 'Comments' });
  await highlighter.enhanceDiff();
  document.querySelectorAll('.jira-activity-shortcuts button')[2].click();
  await settled(controls);
  assert.equal(document.querySelector('#feed').textContent, 'Showing History');
  assert.deepEqual(selections, ['History']);
});

test('matches the supplied Jira buttons-with-dropdown markup without an Activity heading', async t => {
  const { document, controls, highlighter } = await setup(t);
  // Keep the native event handlers from the Jira fixture while replacing its
  // surrounding DOM with the structure supplied from the actual issue page.
  const selected = document.querySelector('#native-filter');
  const more = document.querySelector('#more');
  selected.removeAttribute('data-testid');
  selected.className = 'css-1pk6xif';
  more.className = 'css-9kgmbs';
  more.removeAttribute('id');
  more.removeAttribute('aria-controls');
  more.setAttribute('aria-haspopup', 'true');
  more.setAttribute('data-testid', 'issue-activity-feed.ui.buttons-with-dropdown.dropdown-menu-stateless--trigger');
  more.innerHTML = 'More<span aria-hidden="true"><svg role="presentation"><path d="m14.53 6.03-6 6"></path></svg></span>';
  document.querySelector('h2').remove();
  const oldFilters = document.querySelector('#filters');
  const wrapper = document.createElement('div');
  wrapper.innerHTML = '<div><div id="JSW_ACTIVITY_FEED_BUTTONS"><div><div class="css-1sk425d"></div></div></div></div><div><div role="presentation"><div></div></div><div><div role="presentation"><button aria-live="polite" type="button" disabled data-testid="issue-activity-feed.ui.activity-sorting-toggle.sorting-button"><span><span aria-hidden="true"><svg role="presentation"></svg></span><span>Newest first</span></span></button></div></div></div>';
  wrapper.querySelector('.css-1sk425d').append(selected, more);
  oldFilters.replaceWith(wrapper);
  await highlighter.enhanceDiff();
  assert.equal(document.querySelectorAll('#JSW_ACTIVITY_FEED_BUTTONS .jira-activity-shortcuts button').length, 3);
  await settled(controls);
  await highlighter.enhanceDiff();
  assert.equal(document.querySelector('#feed').textContent, 'Showing All');
  assert.equal(document.querySelector('.jira-activity-shortcuts [aria-pressed="true"]').textContent, 'All');
  document.querySelectorAll('.jira-activity-shortcuts button')[2].click();
  await settled(controls);
  assert.equal(document.querySelector('#feed').textContent, 'Showing History');
  assert.equal(document.querySelector('[data-testid*="sorting-button"]').disabled, true);
});

test('reinjecting a classic content script replaces its listener, observer and activity controls', async t => {
  const { window, dom, document, controls, highlighter, messageListeners } = await setup(t, { selected: 'All' });
  await highlighter.enhanceDiff();
  highlighter.setupObserver();
  await settled(controls);
  const oldObserver = window.diffObserver;
  assert.doesNotThrow(() => vm.runInContext(source, dom.getInternalVMContext()));
  await new Promise(resolve => setImmediate(resolve));
  const current = window.__jiraDiffContentScript;
  await settled(current.activityControls);
  assert.equal(highlighter.disposed, true);
  assert.notEqual(current.highlighter, highlighter);
  assert.notEqual(window.diffObserver, oldObserver);
  assert.equal(messageListeners.size, 1);
  assert.equal(document.querySelectorAll('.jira-activity-shortcuts').length, 1);
  assert.equal(document.querySelectorAll('.jira-activity-shortcuts button').length, 3);
});

test('shortcut menus are hidden before rendering and normal More clicks stay visible', async t => {
  const { window, document, controls, highlighter } = await setup(t, { selected: 'All' });
  await highlighter.enhanceDiff();
  await settled(controls);
  document.querySelectorAll('.jira-activity-shortcuts button')[2].click();
  await new Promise(resolve => window.setTimeout(resolve, 30));
  const automaticMenu = document.querySelector('#activity-menu');
  assert.ok(automaticMenu);
  assert.equal(window.getComputedStyle(automaticMenu).visibility, 'hidden');
  await settled(controls);
  assert.equal(document.querySelector('#feed').textContent, 'Showing History');
  assert.equal(document.querySelector('.jira-activity-shortcuts [aria-pressed="true"]').textContent, 'History');
  assert.equal(document.querySelector('.jira-activity-switching-menu'), null);
  document.querySelector('#more').click();
  await new Promise(resolve => window.setTimeout(resolve, 30));
  const manualMenu = document.querySelector('#activity-menu');
  assert.equal(window.getComputedStyle(manualMenu).visibility, 'visible');
  assert.equal(document.querySelector('#filters').classList.contains('jira-activity-toolbar'), true);
  assert.equal(document.querySelector('#more').classList.contains('jira-activity-more'), true);
});

test('silent opening defaults restore focus to the comment editor', async t => {
  const { document, controls, highlighter } = await setup(t);
  const editor = document.createElement('textarea');
  document.body.appendChild(editor);
  editor.focus();
  // Jira's popup can move focus when it mounts.
  document.querySelector('#more').addEventListener('click', () => document.querySelector('#more').focus());
  await highlighter.enhanceDiff();
  await settled(controls);
  assert.equal(document.activeElement, editor);
});
