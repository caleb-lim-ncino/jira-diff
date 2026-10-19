const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

async function setup(t, settings = {}) {
  const html = fs.readFileSync(path.join(__dirname, '../popup/popup.html'), 'utf8');
  const source = fs.readFileSync(path.join(__dirname, '../popup/popup.js'), 'utf8');
  const dom = new JSDOM(html, { runScripts: 'outside-only' });
  t.after(() => dom.window.close());
  const messages = [];
  dom.window.chrome = {
    storage: { sync: {
      get(keys, callback) { callback(Object.fromEntries(keys.map(key => [key, settings[key]]))); },
      set(values, callback) { Object.assign(settings, values); callback?.(); },
    } },
    permissions: { getAll(callback) { callback({ origins: [] }); } },
    tabs: {
      query(query, callback) { callback([{ id: 1, url: 'https://team.atlassian.net/browse/TEST-1' }]); },
      sendMessage(id, message, callback) { messages.push(message); callback({ status: 'success' }); },
    },
    runtime: {},
  };
  dom.window.eval(source);
  await new Promise(resolve => setImmediate(resolve));
  return { window: dom.window, document: dom.window.document, settings, messages };
}

test('popup declares UTF-8 and defaults to Git side-by-side with zero context', async t => {
  const { document } = await setup(t);
  assert.equal(document.characterSet, 'UTF-8');
  assert.equal(document.querySelector('meta[charset]').getAttribute('charset'), 'UTF-8');
  assert.equal(document.getElementById('diffView').value, 'side-by-side-changes');
  assert.equal(document.getElementById('contextLines').value, '0');
  assert.equal(document.querySelector('#diffView option[value="side-by-side-changes"]').textContent,
    'Git side-by-side - changed lines');
  assert.equal(document.getElementById('contextLinesSetting').hidden, false);
});

test('popup offers and saves the original Jira preview', async t => {
  const { window, document, settings } = await setup(t);
  const option = [...document.querySelectorAll('#diffView option')]
    .find(item => item.value === 'original');
  assert.equal(option?.textContent, 'Original Jira values');

  const view = document.getElementById('diffView');
  view.value = 'original';
  view.dispatchEvent(new window.Event('change'));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settings.diffView, 'original');
  assert.equal(document.getElementById('contextLinesSetting').hidden, true);
});

test('popup saves preview and context options and applies them to the current Jira tab', async t => {
  const { window, document, settings, messages } = await setup(t, { diffView: 'full', contextLines: 5 });
  const view = document.getElementById('diffView');
  const context = document.getElementById('contextLines');
  assert.equal(view.value, 'full');
  assert.equal(document.getElementById('contextLinesSetting').hidden, true);
  view.value = 'changes';
  view.dispatchEvent(new window.Event('change'));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settings.diffView, 'changes');
  assert.equal(document.getElementById('contextLinesSetting').hidden, false);
  context.value = '0';
  context.dispatchEvent(new window.Event('change'));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settings.contextLines, 0);
  context.value = '99';
  context.dispatchEvent(new window.Event('change'));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settings.contextLines, 20);
  assert.equal(context.value, '20');
  assert.equal(messages.length, 3);
  assert.ok(messages.every(message => message.action === 'checkExtensionState'));
});

test('popup recovers from invalid saved preview settings', async t => {
  const { document } = await setup(t, { diffView: 'unknown', contextLines: 'invalid' });
  assert.equal(document.getElementById('diffView').value, 'side-by-side-changes');
  assert.equal(document.getElementById('contextLines').value, '0');
});

test('popup saves split views and offers context for split changed lines', async t => {
  const { document, window, settings } = await setup(t, { diffView: 'side-by-side', contextLines: 2 });
  assert.equal(document.getElementById('contextLinesSetting').hidden, true);
  const view = document.getElementById('diffView');
  view.value = 'side-by-side-changes';
  view.dispatchEvent(new window.Event('change'));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settings.diffView, 'side-by-side-changes');
  assert.equal(document.getElementById('contextLinesSetting').hidden, false);
  assert.equal(document.getElementById('contextLines').value, '2');
});

test('activity controls default to enabled with All, and save changes to the current tab', async t => {
  const { document, window, settings, messages } = await setup(t);
  const toggle = document.getElementById('activityTabsEnabled');
  const filter = document.getElementById('defaultActivityFilter');
  assert.equal(toggle.checked, true);
  assert.equal(filter.value, 'All');
  filter.value = 'History';
  filter.dispatchEvent(new window.Event('change'));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settings.defaultActivityFilter, 'History');
  toggle.checked = false;
  toggle.dispatchEvent(new window.Event('change'));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settings.activityTabsEnabled, false);
  assert.equal(filter.disabled, true);
  assert.equal(messages.length, 2);
  assert.ok(messages.every(message => message.action === 'checkExtensionState'));
});

test('activity options load saved choices and recover from an invalid default', async t => {
  const saved = await setup(t, { activityTabsEnabled: false, defaultActivityFilter: 'Jira default' });
  assert.equal(saved.document.getElementById('activityTabsEnabled').checked, false);
  assert.equal(saved.document.getElementById('defaultActivityFilter').value, 'Jira default');
  assert.equal(saved.document.getElementById('defaultActivityFilter').disabled, true);
  const invalid = await setup(t, { defaultActivityFilter: 'unknown' });
  assert.equal(invalid.document.getElementById('defaultActivityFilter').value, 'All');
});

test('popup ignores null, blank and non-string saved domains', async t => {
  const { document } = await setup(t, { allowedDomains: [null, '', ' ', 123, 'https://jira.example.com/path'] });
  assert.deepEqual([...document.querySelectorAll('.domain-item span')].map(label => label.textContent), ['jira.example.com']);
});
