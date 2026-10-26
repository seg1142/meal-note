'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { createLocalSyncServer } = require('../server/local-sync.cjs');
const { COLLECTIONS, validateSnapshot } = require('../server/sync-store.cjs');

const PUBLIC_ORIGIN = 'https://meal-test.example.ts.net:8443';
const date = second => '2026-10-27T00:00:' + String(second).padStart(2, '0') + '.000Z';
const recipe = (id, second = 1, fields = {}) => ({ id, title: id, ingredients: [], steps: [], createdAt: date(1), updatedAt: date(second), deletedAt: null, ...fields });
function snapshot(recipes = [], fields = {}) {
  return {
    schemaVersion: 1, syncVersion: 1, sourceDeviceId: 'test-device', updatedAt: date(1),
    data: { ...Object.fromEntries(COLLECTIONS.map(key => [key, []])), recipes, settings: { theme: 'dark' }, settingsUpdatedAt: '', ...fields }
  };
}

async function removeTestDirectory(directory) {
  assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
  assert.ok(path.basename(directory).startsWith('meal-note-sync-test-'));
  await fs.rm(directory, { recursive: true, force: true });
}

async function setup(t, options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'meal-note-sync-test-'));
  let app;
  const env = {
    directory,
    async start() {
      app = await createLocalSyncServer({ dataDir: directory, publicOrigin: PUBLIC_ORIGIN, ...options });
      await app.listen(0);
      env.port = app.server.address().port;
      env.origin = 'http://127.0.0.1:' + env.port;
      env.app = app;
    },
    async restart() { await app.close(); await env.start(); }
  };
  t.after(async () => { if (app) await app.close(); await removeTestDirectory(directory); });
  await env.start();
  return env;
}

function request(env, route = '/api/sync', options = {}) {
  return new Promise((resolve, reject) => {
    const body = options.rawBody ?? (options.snapshot ? JSON.stringify({ snapshot: options.snapshot }) : undefined);
    const headers = options.headers || {};
    const req = http.request({
      hostname: '127.0.0.1', port: env.port, path: route,
      method: options.method || (body !== undefined ? 'POST' : 'GET'),
      headers: body !== undefined ? { Origin: env.origin, 'Content-Type': 'application/json', ...headers } : headers
    }, res => {
      const buffers = [];
      res.on('data', chunk => buffers.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(buffers).toString('utf8');
        let json;
        try { json = JSON.parse(text); } catch {}
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on('error', reject);
    if (body !== undefined) req.end(body); else req.end();
  });
}

test('serves only the app shell and dynamic same-origin config; fresh API is empty', async t => {
  const env = await setup(t);
  const empty = await request(env);
  assert.deepEqual(empty.json, { snapshot: null, revision: 0 });
  assert.equal(empty.headers['cache-control'], 'no-store');
  const config = await request(env, '/app-config.js');
  assert.equal(config.status, 200);
  assert.match(config.text, /"enabled":true/);
  assert.match(config.text, /\.\/api\/sync/);
  assert.equal(config.headers['cache-control'], 'no-store');
  assert.match((await request(env, '/')).text, /Meal Note/);
  for (const route of ['/data/local-sync/state.json', '/.git/config', '/server/local-sync.cjs', '/skills/save-recipe/SKILL.md', '/tests/local-sync-server.test.cjs', '/%2e%2e/data/local-sync/state.json']) {
    assert.equal((await request(env, route)).status, 404, route);
  }
});

test('writes persist across restart and unchanged polling does not create revisions or backups', async t => {
  const env = await setup(t);
  const value = snapshot([recipe('recipe-one')]);
  const first = await request(env, '/api/sync', { snapshot: value });
  assert.equal(first.status, 200);
  assert.equal(first.json.revision, 1);
  const second = await request(env, '/api/sync', { snapshot: { ...value, updatedAt: date(40), syncVersion: 999 } });
  assert.equal(second.json.revision, 1);
  assert.deepEqual(second.json.snapshot, first.json.snapshot);
  await env.restart();
  assert.deepEqual((await request(env)).json, first.json);
  await assert.rejects(fs.stat(path.join(env.directory, 'backups')), { code: 'ENOENT' });
});

test('simultaneous updates merge without losing records and stale data cannot revive a tombstone', async t => {
  const env = await setup(t);
  await request(env, '/api/sync', { snapshot: snapshot([recipe('existing')]) });
  const results = await Promise.all([
    request(env, '/api/sync', { snapshot: snapshot([recipe('phone', 2)]) }),
    request(env, '/api/sync', { snapshot: snapshot([recipe('pc', 3)]) })
  ]);
  assert.ok(results.every(result => result.status === 200));
  assert.deepEqual((await request(env)).json.snapshot.data.recipes.map(item => item.id).sort(), ['existing', 'pc', 'phone']);
  await request(env, '/api/sync', { snapshot: snapshot([recipe('phone', 10, { deletedAt: date(10) })]) });
  await request(env, '/api/sync', { snapshot: snapshot([recipe('phone', 2)]) });
  assert.equal((await request(env)).json.snapshot.data.recipes.find(item => item.id === 'phone').deletedAt, date(10));
});

test('shopping items merge independently and empty fresh settings cannot replace existing settings', async t => {
  const env = await setup(t);
  const list = { id: 'shopping', updatedAt: date(1), items: [{ id: 'item-one', checked: false, updatedAt: date(1) }] };
  await request(env, '/api/sync', { snapshot: snapshot([], { shoppingLists: [list], settings: { theme: 'light' }, settingsUpdatedAt: date(20) }) });
  const incomingList = { ...list, items: [{ id: 'item-one', checked: true, updatedAt: date(10) }, { id: 'item-two', checked: false, updatedAt: date(1) }] };
  const merged = await request(env, '/api/sync', { snapshot: snapshot([], { shoppingLists: [incomingList], settings: {}, settingsUpdatedAt: '' }) });
  assert.equal(merged.json.snapshot.data.shoppingLists[0].items.length, 2);
  assert.equal(merged.json.snapshot.data.shoppingLists[0].items.find(item => item.id === 'item-one').checked, true);
  assert.deepEqual(merged.json.snapshot.data.settings, { theme: 'light' });
  const unchanged = await request(env, '/api/sync', { snapshot: { ...snapshot([], { settings: { theme: 'dark' }, settingsUpdatedAt: '' }), updatedAt: date(50) } });
  assert.deepEqual(unchanged.json.snapshot.data.settings, { theme: 'light' });
});

test('rejects foreign origins, fetch metadata, missing origins, DNS rebinding and non-JSON writes', async t => {
  const env = await setup(t);
  for (const headers of [
    { Origin: 'https://attacker.invalid' }, { Origin: 'null' }, { Origin: '' },
    { 'Sec-Fetch-Site': 'cross-site' }, { Host: 'attacker.invalid' }, { 'Content-Type': 'text/plain' }
  ]) {
    const result = await request(env, '/api/sync', { snapshot: snapshot(), headers });
    assert.ok([403, 415].includes(result.status), JSON.stringify(headers));
    assert.equal(typeof result.json.error, 'string');
  }
  assert.equal((await request(env, '/api/sync', { headers: { Origin: 'https://attacker.invalid' } })).status, 403);
  const proxied = await request(env, '/api/sync', { snapshot: snapshot(), headers: { Origin: PUBLIC_ORIGIN, Host: new URL(PUBLIC_ORIGIN).host, 'Sec-Fetch-Site': 'same-origin' } });
  assert.equal(proxied.status, 200);
  assert.equal(proxied.headers['access-control-allow-origin'], undefined);
});

test('invalid and oversized input leave canonical data unchanged', async t => {
  const env = await setup(t, { maxBodyBytes: 2000 });
  const original = await request(env, '/api/sync', { snapshot: snapshot([recipe('valid')]) });
  const invalid = [
    { ...snapshot(), schemaVersion: 9 }, snapshot([recipe('duplicate'), recipe('duplicate')]),
    snapshot([recipe('bad', 1, { ingredients: [null] })]),
    snapshot([recipe('bad', 1, { sourceUrl: 'javascript:alert(1)' })]),
    snapshot([recipe('bad', 1, { updatedAt: 'not-a-date' })])
  ];
  for (const value of invalid) assert.equal((await request(env, '/api/sync', { snapshot: value })).status, 400);
  assert.equal((await request(env, '/api/sync', { rawBody: '{not-json' })).status, 400);
  assert.equal((await request(env, '/api/sync', { snapshot: snapshot([recipe('huge', 1, { description: 'x'.repeat(3000) })]) })).status, 413);
  assert.deepEqual((await request(env)).json, original.json);
});

test('backups contain previous revisions and obey bounded retention', async t => {
  const env = await setup(t, { backupRetention: 2 });
  for (let second = 1; second <= 4; second++) await request(env, '/api/sync', { snapshot: snapshot([recipe('versioned', second, { title: 'version-' + second })]) });
  const names = (await fs.readdir(path.join(env.directory, 'backups'))).sort();
  assert.equal(names.length, 2);
  const revisions = await Promise.all(names.map(async name => JSON.parse(await fs.readFile(path.join(env.directory, 'backups', name), 'utf8'))));
  assert.deepEqual(revisions.map(value => value.revision), [2, 3]);
  assert.equal(revisions[1].snapshot.data.recipes[0].title, 'version-3');
});

test('storage failures return an error and leave the last canonical revision readable', async t => {
  const env = await setup(t);
  const previous = await request(env, '/api/sync', { snapshot: snapshot([recipe('original')]) });
  const filename = path.join(env.directory, 'state.json');
  const saved = path.join(env.directory, 'saved-state.json');
  await fs.rename(filename, saved);
  await fs.mkdir(filename);
  try {
    const failed = await request(env, '/api/sync', { snapshot: snapshot([recipe('new', 2)]) });
    assert.equal(failed.status, 503);
    assert.equal(typeof failed.json.error, 'string');
    assert.deepEqual((await request(env)).json, previous.json);
  } finally {
    await fs.rmdir(filename);
    await fs.rename(saved, filename);
  }
  assert.equal((await request(env, '/api/sync', { snapshot: snapshot([recipe('new', 2)]) })).status, 200);
});

test('corrupt saved data fails closed without overwriting it and releases the startup lock', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'meal-note-sync-test-'));
  t.after(() => removeTestDirectory(directory));
  const filename = path.join(directory, 'state.json');
  await fs.writeFile(filename, '{corrupt');
  await assert.rejects(createLocalSyncServer({ dataDir: directory }), /同期ファイルを読み込めません/);
  assert.equal(await fs.readFile(filename, 'utf8'), '{corrupt');
  await assert.rejects(fs.stat(path.join(directory, '.server-lock')), { code: 'ENOENT' });
});

test('a second process instance cannot use the same canonical directory', async t => {
  const env = await setup(t);
  await assert.rejects(createLocalSyncServer({ dataDir: env.directory }), /既に動作しています/);
  assert.deepEqual((await request(env)).json, { snapshot: null, revision: 0 });
});

test('snapshot validator accepts the existing app data model and rejects prototype keys', () => {
  const value = snapshot([recipe('full', 1, { ingredients: [{ id: 'ingredient', displayName: '塩', quantity: null, unit: '', originalText: '塩 適量', note: '', optional: false }], steps: [{ id: 'step', instruction: '混ぜる', stepNumber: 1, timerSeconds: null }] })]);
  assert.deepEqual(validateSnapshot(value), value);
  const poisoned = JSON.parse(JSON.stringify(value).replace('"theme":"dark"', '"__proto__":{"polluted":true}'));
  assert.throws(() => validateSnapshot(poisoned), /キーが不正/);
  assert.equal({}.polluted, undefined);
});
