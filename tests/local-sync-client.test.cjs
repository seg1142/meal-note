const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const plain = value => JSON.parse(JSON.stringify(value));
const source = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8').replace(
  '  registerServiceWorker();',
  '  globalThis.syncTest = { get state() { return state; }, get runtime() { return localSyncRuntime; }, saveState, buildSyncSnapshot, mergeSnapshots, localSyncPatch, syncLocalServer };\n  registerServiceWorker();'
);

function boot({ configured = true, saved = new Map(), fetcher, editing = false } = {}) {
  const nodes = new Map();
  const events = {};
  const calls = [];
  const storage = { fail: false, saved };
  const location = new URL('https://meal.test/#/recipes');
  const node = id => {
    if (!nodes.has(id)) nodes.set(id, { innerHTML: '', textContent: '', dataset: {}, classList: { add() {}, remove() {}, toggle() {} }, addEventListener() {}, open: false });
    return nodes.get(id);
  };
  const document = {
    getElementById: node, querySelectorAll() { return []; },
    querySelector() { return editing ? {} : null; }, activeElement: null,
    visibilityState: 'visible', documentElement: { dataset: {} }, body: node('body'),
    addEventListener(type, listener) { (events[type] ||= []).push(listener); }
  };
  const context = vm.createContext({
    console, URL, URLSearchParams, location, navigator: { onLine: true }, AbortController,
    setTimeout() { return 1; }, clearTimeout() {}, setInterval() { return 1; },
    localStorage: {
      getItem(key) { return saved.get(key) || null; },
      setItem(key, value) { if (storage.fail) throw new Error('Storage full'); saved.set(key, String(value)); }
    }, document,
    fetch: async (url, options) => {
      calls.push({ url, method: options.method, body: options.body ? JSON.parse(options.body) : null, cache: options.cache });
      if (!fetcher) throw new Error('offline');
      const data = await fetcher(options.method, options.body ? JSON.parse(options.body) : null);
      return { ok: true, json: async () => plain(data) };
    },
    window: {
      MEAL_NOTE_CONFIG: configured ? { localSync: { enabled: true, endpoint: './api/sync', pollIntervalMs: 15000 } } : {},
      addEventListener(type, listener) { (events[type] ||= []).push(listener); },
      matchMedia() { return { matches: false, addEventListener() {} }; },
      history: { replaceState(_state, _title, url) { location.href = new URL(url, location.href).href; } }
    }
  });
  vm.runInContext(source, context, { filename: 'app.js' });
  return { app: context.syncTest, calls, node, storage, document, context,
    storageEvent() { (events.storage || []).forEach(listener => listener({ key: 'meal-app-v1', newValue: saved.get('meal-app-v1') })); }
  };
}

function server(initial) {
  const merger = boot({ configured: false }).app;
  let snapshot = plain(initial);
  let revision = 1;
  return {
    get snapshot() { return snapshot; },
    async fetch(method, body) {
      if (method === 'POST') { snapshot = merger.mergeSnapshots(body.snapshot, snapshot); revision++; }
      return { snapshot, revision };
    }
  };
}

function canonical() {
  const snapshot = plain(boot({ configured: false }).app.buildSyncSnapshot());
  snapshot.data.recipes[0].title = 'PCで編集済みの元レシピ';
  snapshot.data.recipes[0].updatedAt = '2025-01-01T00:00:00.000Z';
  return snapshot;
}

function addRecipe(env, id, title) {
  const record = plain(env.app.state.recipes[0]);
  Object.assign(record, { id, title, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), deletedAt: null });
  env.app.state.recipes.push(record);
  assert.equal(env.app.saveState(), true);
  return record;
}

test('fresh browser loads PC data without posting newer seed timestamps', async () => {
  const pc = server(canonical());
  const env = boot({ fetcher: pc.fetch });
  assert.equal(await env.app.syncLocalServer(), true);
  assert.equal(env.app.state.recipes[0].title, 'PCで編集済みの元レシピ');
  assert.equal(env.calls.filter(call => call.method === 'POST').length, 0);
  assert.equal(env.app.state.sync.localServer.initialized, true);
});

test('offline first edits survive reload and only changed records are initially uploaded', async () => {
  const saved = new Map();
  const offline = boot({ saved });
  addRecipe(offline, 'offline-only', 'オフラインで作成');
  assert.equal(await offline.app.syncLocalServer(), false);
  const pc = server(canonical());
  const online = boot({ saved, fetcher: pc.fetch });
  assert.equal(await online.app.syncLocalServer(), true);
  const posted = online.calls.find(call => call.method === 'POST').body.snapshot;
  assert.deepEqual(posted.data.recipes.map(recipe => recipe.id), ['offline-only']);
  assert.deepEqual(posted.data.settings, {});
  assert.equal(online.app.state.recipes.find(recipe => recipe.id === 'offline-only').title, 'オフラインで作成');
  assert.equal(online.app.state.recipes.find(recipe => recipe.id === pc.snapshot.data.recipes.find(recipe => recipe.id !== 'offline-only').id).title, 'PCで編集済みの元レシピ');
  assert.equal(online.app.state.sync.localServer.pending, false);
});

test('two clients exchange additions and deletion tombstones', async () => {
  const pc = server(canonical());
  const first = boot({ fetcher: pc.fetch });
  const second = boot({ fetcher: pc.fetch });
  await first.app.syncLocalServer();
  await second.app.syncLocalServer();
  addRecipe(first, 'from-pc', 'PC追加');
  addRecipe(second, 'from-phone', 'スマホ追加');
  await first.app.syncLocalServer();
  await second.app.syncLocalServer();
  await first.app.syncLocalServer();
  for (const client of [first, second]) assert.ok(client.app.state.recipes.some(recipe => recipe.id === 'from-phone'));
  const removed = first.app.state.recipes.find(recipe => recipe.id === 'from-pc');
  removed.deletedAt = removed.updatedAt = new Date(Date.now() + 1000).toISOString();
  first.app.saveState();
  await first.app.syncLocalServer();
  await second.app.syncLocalServer();
  assert.ok(second.app.state.recipes.find(recipe => recipe.id === 'from-pc').deletedAt);
});

test('edits while POST is pending survive its response and are sent on the next sync', async () => {
  const pc = server(canonical());
  let finishPost;
  let postStarted;
  const started = new Promise(resolve => { postStarted = resolve; });
  let holdPost = false;
  const env = boot({ fetcher: async (method, body) => {
    if (method === 'POST' && holdPost) {
      postStarted();
      await new Promise(resolve => { finishPost = resolve; });
    }
    return pc.fetch(method, body);
  } });
  await env.app.syncLocalServer();
  addRecipe(env, 'before-post', '送信開始前');
  holdPost = true;
  const firstRequest = env.app.syncLocalServer();
  await started;
  addRecipe(env, 'during-post', '送信待機中の追加');
  finishPost();
  await firstRequest;
  assert.ok(env.app.state.recipes.some(recipe => recipe.id === 'during-post'));
  assert.equal(env.app.state.sync.localServer.pending, true);
  holdPost = false;
  await env.app.syncLocalServer();
  assert.ok(pc.snapshot.data.recipes.some(recipe => recipe.id === 'during-post'));
  assert.equal(env.app.state.sync.localServer.pending, false);
});

test('only one sync request runs at a time', async () => {
  let finish;
  const env = boot({ fetcher: () => new Promise(resolve => { finish = resolve; }) });
  const request = env.app.syncLocalServer();
  assert.equal(await env.app.syncLocalServer(), false);
  assert.equal(env.calls.length, 1);
  finish({ snapshot: canonical(), revision: 1 });
  await request;
});

test('storage failure keeps current recipes and does not report successful sync', async () => {
  const env = boot({ fetcher: server(canonical()).fetch });
  const before = plain(env.app.state.recipes);
  env.storage.fail = true;
  assert.equal(await env.app.syncLocalServer(), false);
  assert.deepEqual(plain(env.app.state.recipes), before);
  assert.equal(env.app.state.sync.localServer.initialized, false);
  assert.match(env.app.runtime.error, /保存領域/);
  assert.doesNotMatch(env.node('storageStatus').textContent, /同期済み/);
});

test('sync response does not replace a form being edited', async () => {
  const env = boot({ fetcher: server(canonical()).fetch, editing: true });
  env.node('view').innerHTML = '編集中の未保存テキスト';
  await env.app.syncLocalServer();
  assert.equal(env.node('view').innerHTML, '編集中の未保存テキスト');
});

test('public deployment stays local-only and unchanged settings do not use snapshot creation time', () => {
  const env = boot({ configured: false });
  assert.equal(env.app.runtime, null);
  const first = canonical();
  const second = canonical();
  first.updatedAt = '2099-01-01T00:00:00.000Z';
  first.data.settings = {};
  second.data.settings = { theme: 'light' };
  first.data.settingsUpdatedAt = second.data.settingsUpdatedAt = '';
  assert.deepEqual(plain(env.app.mergeSnapshots(first, second).data.settings), { theme: 'light' });
});

test('offline tabs sharing storage preserve both additions and deletion after reload', async () => {
  const pc = server(canonical());
  const saved = new Map();
  const first = boot({ saved, fetcher: pc.fetch });
  await first.app.syncLocalServer();
  const second = boot({ saved, fetcher: pc.fetch });
  await second.app.syncLocalServer();
  first.context.navigator.onLine = second.context.navigator.onLine = false;
  addRecipe(first, 'offline-a', 'タブAの未送信');
  const removedId = first.app.state.recipes.find(recipe => recipe.id !== 'offline-a').id;
  const removed = first.app.state.recipes.find(recipe => recipe.id === removedId);
  removed.deletedAt = removed.updatedAt = new Date(Date.now() + 1000).toISOString();
  first.app.saveState();
  addRecipe(second, 'offline-b', 'タブBの未送信');
  const reloaded = boot({ saved });
  assert.ok(reloaded.app.state.recipes.some(recipe => recipe.id === 'offline-a'));
  assert.ok(reloaded.app.state.recipes.some(recipe => recipe.id === 'offline-b'));
  assert.ok(reloaded.app.state.recipes.find(recipe => recipe.id === removedId).deletedAt);
  assert.equal(reloaded.app.state.sync.localServer.pending, true);
  assert.ok(reloaded.app.state.sync.localServer.generation > first.app.state.sync.localServer.generation);
});

test('stale fresh tab cannot overwrite another tab bootstrap with untouched seed records', async () => {
  const pc = server(canonical());
  const saved = new Map();
  const stale = boot({ saved });
  const initialized = boot({ saved, fetcher: pc.fetch });
  await initialized.app.syncLocalServer();
  addRecipe(stale, 'from-stale-fresh', '古いタブからの追加');
  const reloaded = boot({ saved });
  assert.equal(reloaded.app.state.sync.localServer.initialized, true);
  assert.equal(reloaded.app.state.sync.localServer.baseline, null);
  assert.ok(reloaded.app.state.recipes.some(recipe => recipe.id === 'from-stale-fresh'));
  assert.equal(reloaded.app.state.recipes.find(recipe => recipe.id === canonical().data.recipes[0].id).title, 'PCで編集済みの元レシピ');
});

test('storage events refresh records without clearing an editing form', async () => {
  const pc = server(canonical());
  const saved = new Map();
  const first = boot({ saved, fetcher: pc.fetch, editing: true });
  await first.app.syncLocalServer();
  const second = boot({ saved, fetcher: pc.fetch });
  first.node('view').innerHTML = 'タブAで入力中';
  addRecipe(second, 'from-other-tab', '別タブで保存');
  first.storageEvent();
  assert.ok(first.app.state.recipes.some(recipe => recipe.id === 'from-other-tab'));
  assert.equal(first.node('view').innerHTML, 'タブAで入力中');
});

test('another tab edits during POST are persisted and remain pending after the response', async () => {
  const pc = server(canonical());
  const saved = new Map();
  let releasePost;
  let signalPost;
  let hold = false;
  const started = new Promise(resolve => { signalPost = resolve; });
  const first = boot({ saved, fetcher: async (method, body) => {
    if (method === 'POST' && hold) { signalPost(); await new Promise(resolve => { releasePost = resolve; }); }
    return pc.fetch(method, body);
  } });
  await first.app.syncLocalServer();
  const second = boot({ saved, fetcher: pc.fetch });
  addRecipe(first, 'tab-a-inflight', 'A送信中');
  hold = true;
  const request = first.app.syncLocalServer();
  await started;
  addRecipe(second, 'tab-b-during-post', 'B未送信追加');
  releasePost();
  await request;
  assert.ok(first.app.state.recipes.some(recipe => recipe.id === 'tab-b-during-post'));
  assert.equal(first.app.state.sync.localServer.pending, true);
  assert.ok(boot({ saved }).app.state.recipes.some(recipe => recipe.id === 'tab-b-during-post'));
  hold = false;
  await first.app.syncLocalServer();
  assert.ok(pc.snapshot.data.recipes.some(recipe => recipe.id === 'tab-b-during-post'));
  assert.equal(first.app.state.sync.localServer.pending, false);
});
