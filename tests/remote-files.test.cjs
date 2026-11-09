const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const install = require('../runtime/files.cjs');

class Element {
  constructor(tag = 'div') {
    this.tagName = tag.toUpperCase(); this.nodeType = 1; this.isConnected = true;
    this.attributes = new Map(); this.children = []; this.style = {}; this.events = new Map();
  }
  setAttribute(key, value) { this.attributes.set(key, value); }
  hasAttribute(key) { return this.attributes.has(key); }
  removeAttribute(key) { this.attributes.delete(key); }
  append(...items) { for (const item of items) { item.parentNode = this; this.children.push(item); } }
  prepend(...items) { for (const item of items.reverse()) { item.parentNode = this; this.children.unshift(item); } }
  remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(x => x !== this); this.isConnected = false; }
  querySelector() { return null; }
  addEventListener(name, listener) { this.events.set(name, listener); }
  async click() { return this.events.get('click')?.(); }
}

function fixture({ top = false, host = 'devbox', frontendHost = host,
  uri = 'file:///home/user/project/report%20one.pdf',
  conversation = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', read, downloader } = {}) {
  const calls = [], saves = [], root = new Element(), pane = new Element(), head = new Element('head');
  const oldDownload = { downloadBlob() { throw Error('CLI host download must not be used'); } };
  const cache = new Map([['pdfViewer', false], ['download', oldDownload]]);
  const features = { getCache: cache, get: key => cache.get(key), featureNames: ['pdfViewer', 'download'] };
  const reader = { readFile: async value => {
    calls.push(value); return read ? read(value) : {content: vm.runInNewContext('new Uint8Array([37,80,68,70,45])')};
  } };
  const values = {memoizedProps: {value: features}, return: {memoizedProps: {value: reader}, return: null}};
  const outer = { memoizedProps: {cascadeId: conversation}, return: values };
  const file = {memoizedProps: {fileUri: uri, tabId: 'file__one'}, stateNode: pane, return: outer};
  outer.child = file;
  root.__reactFiber_fixture = {memoizedProps: {}, child: file, return: values};
  const parentRoot = new Element();
  const parentFeature = { get: key => key === 'download' ? {downloadBlob: async (blob, name) => {
    saves.push({blob, name}); return downloader?.(blob, name);
  }} : undefined, getCache: new Map(), featureNames: ['download'] };
  parentRoot.__reactFiber_fixture = {memoizedProps: {value: parentFeature}, return: null};
  const parent = {document: {querySelector: () => parentRoot}};
  const window = {parent, top: parent}; if (top) window.top = window;
  let callback, scheduled, disconnected = false;
  const document = {head, documentElement: new Element('html'), createElement: tag => new Element(tag), createElementNS: (_,tag) => new Element(tag), querySelector: () => root};
  const location = new URL('https://127.0.0.1:4000/c/11111111-2222-3333-4444-555555555555?__gravrelay_ssh=' + host);
  const context = vm.createContext({window, document, location, URL, Blob, __gravRelayCLIFrontend: {host: frontendHost},
    setTimeout(fn) { scheduled = fn; return 1; }, clearTimeout() { scheduled = null; },
    MutationObserver: class {constructor(fn) {callback = fn} observe() {} disconnect() {disconnected = true}}});
  vm.runInContext('(' + install.toString() + ')()', context);
  const toolbar = () => pane.children.find(x => x.hasAttribute('data-gravrelay-file-toolbar'));
  return {context, cache, oldDownload, pane, head, file, features, calls, saves, toolbar,
    mutate() { callback?.(); const fn = scheduled; scheduled = null; fn?.(); }, disconnected: () => disconnected};
}

test('remote file support never modifies the top-level Mac or another SSH host frame', () => {
  for (const options of [{top: true}, {frontendHost: 'different-host'}, {host: ''}]) {
    const x = fixture(options);
    assert.equal(x.context.__gravRelayRemoteFiles, undefined);
    assert.equal(x.head.children.length, 0);
    assert.equal(x.toolbar(), undefined);
    assert.equal(x.cache.get('download'), x.oldDownload);
    assert.equal(x.cache.get('pdfViewer'), false);
  }
});

test('only hostless file URIs receive SSH file actions', () => {
  for (const uri of ['https://example.test/report.pdf', 'file://another-host/share/report.pdf', 'ssh://devbox/report.pdf', 'not a uri']) {
    const x = fixture({uri});
    assert.equal(x.toolbar(), undefined, uri);
    assert.equal(x.calls.length, 0);
    assert.equal(x.saves.length, 0);
  }
});

test('remote files leave the native PDF viewer feature disabled while bridging downloads', () => {
  const x = fixture();
  assert.equal(x.cache.get('pdfViewer'), false);
  assert.notEqual(x.cache.get('download'), x.oldDownload);
  assert.equal(typeof x.cache.get('download').downloadBlob, 'function');
});

test('download reads the selected remote URI with its own conversation and explicit user intent', async () => {
  const uri = 'file:///home/user/project/report%20one.pdf';
  const x = fixture({uri}), toolbar = x.toolbar(), button = toolbar.children.at(-1);
  assert.match(toolbar.children[0].textContent, /SSH.*devbox/);
  assert.equal(toolbar.children[0].title, 'devbox:/home/user/project/report one.pdf');
  await button.click();
  assert.equal(x.calls.length, 1); assert.equal(x.saves.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(x.calls[0])), {uri, conversationId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', userInitiated: true});
  assert.equal(x.file.memoizedProps.fileUri, uri);
  assert.equal(x.saves[0].name, 'report one.pdf');
  assert.equal(await x.saves[0].blob.text(), '%PDF-');
  assert.equal(button.disabled, false);
});

test('native downloads use the parent service and accept cross-realm content', async () => {
  const x = fixture();
  await x.cache.get('download').downloadText('remote contents', 'notes.txt');
  assert.equal(x.saves.length, 1);
  assert.equal(x.saves[0].name, 'notes.txt');
  assert.equal(await x.saves[0].blob.text(), 'remote contents');
  assert.equal(x.calls.length, 0);
  await x.toolbar().children.at(-1).click();
  assert.equal(x.saves.length, 2);
  assert.equal(await x.saves[1].blob.text(), '%PDF-');
});

test('download failure is visible and re-enables the action without saving false content', async () => {
  const x = fixture({read: async () => {throw Error('Remote file no longer exists')}});
  const bar = x.toolbar(), button = bar.children.at(-1), status = bar.children[1];
  await button.click();
  assert.equal(x.saves.length, 0);
  assert.equal(button.disabled, false);
  assert.equal(status.textContent, 'Remote file no longer exists');
  assert.equal(status.hasAttribute('data-error'), true);
});

test('repeated clicks share one pending read and empty files remain downloadable', async () => {
  let finish;
  const x = fixture({read: () => new Promise(resolve => {finish = resolve})});
  const button = x.toolbar().children.at(-1);
  const first = button.click(); await button.click();
  assert.equal(x.calls.length, 1);
  finish({content: vm.runInNewContext('new Uint8Array(0)')});
  await first;
  assert.equal(x.saves.length, 1);
  assert.equal(x.saves[0].blob.size, 0);
});

test('a pending download keeps the clicked file name when its native pane navigates', async () => {
  let finish;
  const original = 'file:///home/user/first.pdf';
  const x = fixture({uri: original, read: () => new Promise(resolve => {finish = resolve})});
  const pending = x.toolbar().children.at(-1).click();
  x.file.memoizedProps.fileUri = 'file:///home/user/second.pdf'; x.mutate();
  finish({content: new Uint8Array([65])}); await pending;
  assert.equal(x.calls[0].uri, original);
  assert.equal(x.saves[0].name, 'first.pdf');
  assert.equal(await x.saves[0].blob.text(), 'A');
});

test('malformed URI escapes cannot break the whole observer pass', () => {
  assert.doesNotThrow(() => {
    const x = fixture({uri: 'file:///home/user/bad%ZZ.pdf'});
    x.mutate();
  });
});

test('removing the add-on restores only its own changes and removes file chrome', () => {
  const x = fixture(), replacement = {downloadBlob() {}};
  x.cache.set('download', replacement);
  x.context.__gravRelayRemoteFiles.remove();
  assert.equal(x.cache.get('download'), replacement);
  assert.equal(x.cache.get('pdfViewer'), false);
  assert.equal(x.toolbar(), undefined);
  assert.equal(x.pane.hasAttribute('data-gravrelay-file-shell'), false);
  assert.equal(x.head.children.length, 0);
  assert.equal(x.disconnected(), true);
});
