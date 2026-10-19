const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../background.js'), 'utf8');

function setup({ registrationFails = false, firstTabFails = false,
  allowedDomains = ['jira.example.com'], origins = ['https://jira.example.com/*'] } = {}) {
  let installed;
  const injections = [];
  const errors = [];
  const registrations = [];
  const event = () => ({ addListener() {} });
  const chrome = {
    runtime: {
      id: 'test',
      onInstalled: { addListener(fn) { installed = fn; } },
      onStartup: event(), onMessage: event(),
      getManifest() { return { content_scripts: [{ matches: ['https://*.atlassian.net/*'],
        js: ['lib/diff_match_patch.js', 'content/content.js'], css: ['content/styles.css'] }] }; },
    },
    permissions: {
      getAll(callback) { callback({ origins }); },
      contains(origins, callback) { callback(true); },
    },
    storage: { sync: { async get() { return { allowedDomains }; } }, onChanged: event() },
    tabs: {
      async query() { return [{ id: 1, url: 'https://team.atlassian.net/browse/TEST-1' }, { id: 2, url: 'https://team.atlassian.net/browse/TEST-2' }]; },
      onActivated: event(),
    },
    scripting: {
      async unregisterContentScripts() {},
      async registerContentScripts(args) { registrations.push(args); if (registrationFails) throw new Error('Registration failed'); },
      async insertCSS(args) { injections.push({ type: 'css', ...args }); },
      async executeScript(args) {
        injections.push({ type: 'js', ...args });
        if (firstTabFails && args.target.tabId === 1) throw new Error('Tab closed');
      },
    },
  };
  vm.runInNewContext(source, { chrome, console: { error(...args) { errors.push(args); } } });
  return { installed, injections, errors, registrations };
}

test('install injects the stylesheet before JavaScript into each open Jira tab', async () => {
  const { installed, injections, errors } = setup();
  await installed();
  assert.deepEqual(injections.map(call => [call.type, call.target.tabId]), [['css', 1], ['js', 1], ['css', 2], ['js', 2]]);
  assert.equal(injections[0].files[0], 'content/styles.css');
  assert.equal(injections[1].files[1], 'content/content.js');
  assert.equal(errors.length, 0);
});

test('custom-domain registration errors do not prevent injection on Atlassian Jira tabs', async () => {
  const { installed, injections, errors } = setup({ registrationFails: true });
  await installed();
  assert.equal(injections.length, 4);
  assert.equal(errors.length, 1);
  assert.match(errors[0][0], /Failed to register custom Jira domain/);
});

test('an injection failure in one tab does not stop loading other Jira tabs', async () => {
  const { installed, injections, errors } = setup({ firstTabFails: true });
  await installed();
  assert.equal(injections.length, 4);
  assert.equal(errors.length, 1);
  assert.match(errors[0][0], /Failed to inject content script/);
});

test('blank and null domain entries are ignored without blocking registration or injection', async () => {
  for (const allowedDomains of [[null, '', ' ', 'jira.example.com', 123], ',jira.example.com,\n']) {
    const { installed, injections, errors, registrations } = setup({ allowedDomains,
      origins: [null, '', ' ', 'https://jira.example.com/*'] });
    await installed();
    assert.equal(errors.length, 0);
    assert.equal(injections.length, 4);
    assert.deepEqual(Array.from(registrations[0][0].matches), ['https://jira.example.com/*', 'https://*.jira.example.com/*']);
  }
});
