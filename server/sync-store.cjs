'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const COLLECTIONS = ['recipes', 'ingredientMaster', 'tags', 'mealPlans', 'shoppingLists', 'pantryItems', 'cookingHistory', 'importSources'];
const MAX_JSON_BYTES = 5_000_000;
const clone = value => JSON.parse(JSON.stringify(value));
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

class InputError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

function timestamp(value, label) {
  if (value == null || value === '') return;
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value)) || value.length > 40) throw new InputError(label + 'の日時が不正です。');
}

function records(value, label) {
  if (!Array.isArray(value) || value.length > 30000) throw new InputError(label + 'は30,000件以内の配列で指定してください。');
  const ids = new Set();
  for (const item of value) {
    if (!object(item) || typeof item.id !== 'string' || !item.id.trim() || item.id.length > 300) throw new InputError(label + 'のレコードIDが不正です。');
    if (ids.has(item.id)) throw new InputError(label + 'のレコードIDが重複しています。');
    ids.add(item.id);
    for (const key of ['createdAt', 'updatedAt', 'deletedAt']) timestamp(item[key], label);
  }
}

function validateSnapshot(snapshot) {
  if (!object(snapshot) || snapshot.schemaVersion !== 1 || !object(snapshot.data)) throw new InputError('対応する同期JSONではありません。');
  if (snapshot.syncVersion != null && (!Number.isSafeInteger(snapshot.syncVersion) || snapshot.syncVersion < 0)) throw new InputError('syncVersionが不正です。');
  if (snapshot.sourceDeviceId != null && (typeof snapshot.sourceDeviceId !== 'string' || snapshot.sourceDeviceId.length > 300)) throw new InputError('端末IDが不正です。');
  timestamp(snapshot.updatedAt, '同期データ');
  timestamp(snapshot.exportedAt, '同期データ');
  for (const key of COLLECTIONS) records(snapshot.data[key], key);
  if (!object(snapshot.data.settings)) throw new InputError('settingsの形式が不正です。');
  timestamp(snapshot.data.settingsUpdatedAt, '設定');
  for (const recipe of snapshot.data.recipes) {
    if (typeof recipe.title !== 'string' || recipe.title.length > 2000) throw new InputError('レシピ名が不正です。');
    if (!Array.isArray(recipe.ingredients) || !Array.isArray(recipe.steps)) throw new InputError('材料・工程は配列で指定してください。');
    for (const item of recipe.ingredients) {
      if (!object(item) || typeof item.displayName !== 'string' || !item.displayName.trim()) throw new InputError('材料の形式が不正です。');
      if (item.quantity != null && (typeof item.quantity !== 'number' || !Number.isFinite(item.quantity) || item.quantity < 0)) throw new InputError('材料の数量が不正です。');
      for (const key of ['unit', 'note', 'originalText']) if (item[key] != null && typeof item[key] !== 'string') throw new InputError('材料の補足が不正です。');
    }
    for (const step of recipe.steps) if (!object(step) || typeof step.instruction !== 'string') throw new InputError('工程の形式が不正です。');
    for (const key of ['sourceUrl', 'thumbnailUrl']) {
      if (recipe[key] == null || recipe[key] === '') continue;
      if (typeof recipe[key] !== 'string') throw new InputError('レシピURLが不正です。');
      let parsed;
      try { parsed = new URL(recipe[key]); } catch { throw new InputError('レシピURLが不正です。'); }
      if (!['https:', 'http:'].includes(parsed.protocol)) throw new InputError('レシピURLはhttpまたはhttpsで指定してください。');
    }
  }
  for (const list of snapshot.data.shoppingLists) records(list.items, 'shoppingLists.items');
  let serialized;
  try { serialized = JSON.stringify(snapshot); } catch { throw new InputError('同期JSONを読み込めません。'); }
  if (Buffer.byteLength(serialized) > MAX_JSON_BYTES) throw new InputError('同期データが大きすぎます。', 413);
  // A JSON object is data, never an instruction or an object prototype update.
  function inspect(value, depth) {
    if (depth > 64) throw new InputError('同期JSONの階層が深すぎます。');
    if (!value || typeof value !== 'object') return;
    for (const key of Object.keys(value)) {
      if (key === '__proto__') throw new InputError('同期JSONのキーが不正です。');
      inspect(value[key], depth + 1);
    }
  }
  inspect(snapshot, 0);
  return clone(snapshot);
}

function mergeRecords(existing, incoming) {
  const merged = new Map();
  for (const record of existing.concat(incoming)) {
    const previous = merged.get(record.id);
    const date = String(record.updatedAt || record.createdAt || '');
    const previousDate = previous && String(previous.updatedAt || previous.createdAt || '');
    if (!previous || date > previousDate || (date === previousDate && JSON.stringify(record) > JSON.stringify(previous))) merged.set(record.id, clone(record));
  }
  return [...merged.values()];
}

function chooseSettings(existing, incoming) {
  const oldSettings = existing.settings || {};
  const newSettings = incoming.settings || {};
  const oldTime = String(existing.settingsUpdatedAt || '');
  const newTime = String(incoming.settingsUpdatedAt || '');
  // A fresh client's delta has no settings, so it cannot replace saved settings.
  const useNew = Object.keys(newSettings).length > 0 && (
    Object.keys(oldSettings).length === 0 || newTime > oldTime ||
    (newTime === oldTime && JSON.stringify(newSettings) > JSON.stringify(oldSettings))
  );
  return { settings: clone(useNew ? newSettings : oldSettings), settingsUpdatedAt: useNew ? newTime : oldTime };
}

function mergeSnapshots(existing, incoming) {
  if (!existing) {
    const data = Object.fromEntries(COLLECTIONS.map(key => [key, clone(incoming.data[key])]));
    Object.assign(data, chooseSettings({}, incoming.data));
    return { schemaVersion: 1, syncVersion: Number(incoming.syncVersion || 0), sourceDeviceId: incoming.sourceDeviceId || 'local-sync-server', data };
  }
  const data = {};
  for (const key of COLLECTIONS) data[key] = mergeRecords(existing.data[key], incoming.data[key]);
  const oldLists = new Map(existing.data.shoppingLists.map(list => [list.id, list]));
  const newLists = new Map(incoming.data.shoppingLists.map(list => [list.id, list]));
  data.shoppingLists = data.shoppingLists.map(list => ({
    ...list,
    items: mergeRecords(oldLists.get(list.id)?.items || [], newLists.get(list.id)?.items || [])
  }));
  Object.assign(data, chooseSettings(existing.data, incoming.data));
  return {
    schemaVersion: 1,
    syncVersion: Math.max(Number(existing.syncVersion || 0), Number(incoming.syncVersion || 0)),
    sourceDeviceId: incoming.sourceDeviceId || 'local-sync-server',
    data
  };
}

class SyncStore {
  constructor(directory, retention = 20) {
    this.directory = path.resolve(directory);
    this.filename = path.join(this.directory, 'state.json');
    this.backups = path.join(this.directory, 'backups');
    this.lockname = path.join(this.directory, '.server-lock');
    this.retention = retention;
    this.value = { formatVersion: 1, revision: 0, snapshot: null };
    this.pending = Promise.resolve();
    this.lockToken = randomUUID();
  }

  async open() {
    await fs.mkdir(this.directory, { recursive: true });
    try {
      this.lock = await fs.open(this.lockname, 'wx', 0o600);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let previous;
      try { previous = JSON.parse(await fs.readFile(this.lockname, 'utf8')); } catch { throw new Error('同期フォルダーのロックを確認できません。既存プロセスを確認してください。'); }
      if (!Number.isSafeInteger(previous.pid) || previous.pid <= 0) throw new Error('同期フォルダーのロックが不正です。');
      let alive = true;
      try { process.kill(previous.pid, 0); } catch (failure) { if (failure.code === 'ESRCH') alive = false; }
      if (alive) throw new Error('同じ同期フォルダーを使用するサーバーが既に動作しています。');
      await fs.unlink(this.lockname);
      this.lock = await fs.open(this.lockname, 'wx', 0o600);
    }
    await this.lock.writeFile(JSON.stringify({ pid: process.pid, token: this.lockToken }));
    try {
      let saved;
      try { saved = JSON.parse(await fs.readFile(this.filename, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return this; throw error; }
      if (!object(saved) || saved.formatVersion !== 1 || !Number.isSafeInteger(saved.revision) || saved.revision < 1 || !saved.snapshot) throw new Error('同期ファイルの形式が不正です。');
      saved.snapshot = validateSnapshot(saved.snapshot);
      this.value = saved;
      return this;
    } catch (error) {
      await this.close();
      throw new Error('同期ファイルを読み込めません。既存データは変更していません。バックアップを確認してください。', { cause: error });
    }
  }

  read() { return clone({ snapshot: this.value.snapshot, revision: this.value.revision }); }

  merge(incoming) {
    const validated = validateSnapshot(incoming);
    const run = this.pending.then(async () => {
      const nextSnapshot = mergeSnapshots(this.value.snapshot, validated);
      if (this.value.snapshot && JSON.stringify(nextSnapshot.data) === JSON.stringify(this.value.snapshot.data)) return this.read();
      const now = new Date().toISOString();
      Object.assign(nextSnapshot, { syncVersion: nextSnapshot.syncVersion + 1, updatedAt: now, exportedAt: now });
      validateSnapshot(nextSnapshot);
      const next = { formatVersion: 1, revision: this.value.revision + 1, snapshot: nextSnapshot };
      const temporary = path.join(this.directory, '.state-' + randomUUID() + '.tmp');
      let handle;
      try {
        handle = await fs.open(temporary, 'wx', 0o600);
        await handle.writeFile(JSON.stringify(next, null, 2));
        await handle.sync();
        await handle.close();
        handle = null;
        if (this.value.snapshot) {
          await fs.mkdir(this.backups, { recursive: true });
          const name = 'revision-' + String(this.value.revision).padStart(10, '0') + '-' + Date.now() + '-' + randomUUID() + '.json';
          await fs.copyFile(this.filename, path.join(this.backups, name));
        }
        await fs.rename(temporary, this.filename);
        this.value = next;
      } finally {
        if (handle) await handle.close();
        await fs.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
      }
      // Backup cleanup is best effort; a cleanup failure must not turn a committed write into an error.
      try {
        const entries = (await fs.readdir(this.backups)).filter(name => /^revision-\d{10}-\d+-[0-9a-f-]+\.json$/.test(name)).sort();
        for (const name of entries.slice(0, Math.max(0, entries.length - this.retention))) await fs.unlink(path.join(this.backups, name));
      } catch (error) { if (error.code !== 'ENOENT') this.backupCleanupError = error.message; }
      return this.read();
    });
    this.pending = run.catch(() => {});
    return run;
  }

  async close() {
    await this.pending;
    if (this.lock) { await this.lock.close(); this.lock = null; }
    try {
      const current = JSON.parse(await fs.readFile(this.lockname, 'utf8'));
      if (current.token === this.lockToken) await fs.unlink(this.lockname);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

module.exports = { COLLECTIONS, InputError, MAX_JSON_BYTES, SyncStore, validateSnapshot, mergeSnapshots, mergeRecords };
