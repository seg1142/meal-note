'use strict';

const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const { SyncStore, InputError, MAX_JSON_BYTES } = require('./sync-store.cjs');

const STATIC_FILES = new Map([
  ['index.html', 'text/html; charset=utf-8'], ['app.js', 'text/javascript; charset=utf-8'],
  ['styles.css', 'text/css; charset=utf-8'], ['sw.js', 'text/javascript; charset=utf-8'],
  ['manifest.webmanifest', 'application/manifest+json'], ['robots.txt', 'text/plain; charset=utf-8'],
  ...['app-icon-192.png', 'app-icon-512.png', 'app-icon-1024.png'].map(file => [file, 'image/png']),
  ...['icon.svg', 'icon-192.svg', 'icon-512.svg'].map(file => [file, 'image/svg+xml'])
]);

function json(response, status, payload) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(payload));
}

function readJson(request, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const buffers = [];
    let failed = false;
    request.on('data', chunk => {
      size += chunk.length;
      if (size > limit) {
        if (!failed) { failed = true; reject(new InputError('同期データが大きすぎます。', 413)); }
        return;
      }
      if (!failed) buffers.push(chunk);
    });
    request.on('end', () => {
      if (failed) return;
      try { resolve(JSON.parse(Buffer.concat(buffers).toString('utf8'))); } catch { reject(new InputError('JSONを読み込めません。')); }
    });
    request.on('error', reject);
    request.on('aborted', () => reject(new InputError('同期リクエストが中断されました。')));
  });
}

async function createLocalSyncServer(options = {}) {
  const root = path.resolve(options.rootDir || path.join(__dirname, '..'));
  let publicOrigin = '';
  if (options.publicOrigin) {
    const parsed = new URL(options.publicOrigin);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== '/') {
      throw new Error('--public-originにはパスのないHTTPS originを指定してください。');
    }
    publicOrigin = parsed.origin;
  }
  const store = await new SyncStore(options.dataDir || path.join(root, 'data', 'local-sync'), options.backupRetention || 20).open();
  const server = http.createServer(async (request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    try {
      const port = server.address()?.port;
      const localOrigins = new Set(['http://127.0.0.1:' + port, 'http://localhost:' + port]);
      const hosts = new Set([...localOrigins].map(origin => new URL(origin).host));
      if (publicOrigin) hosts.add(new URL(publicOrigin).host);
      const host = String(request.headers.host || '').toLowerCase();
      if (!hosts.has(host)) return json(response, 403, { error: '許可されていないホストです。' });
      const parsed = new URL(request.url, 'http://' + host);
      let pathname;
      try { pathname = decodeURIComponent(parsed.pathname); } catch { throw new InputError('URLの形式が不正です。'); }
      if (pathname === '/api/sync') {
        const origin = String(request.headers.origin || '');
        const allowedOrigin = localOrigins.has(origin) || (publicOrigin && origin === publicOrigin);
        const fetchSite = String(request.headers['sec-fetch-site'] || '');
        if (origin && !allowedOrigin) return json(response, 403, { error: '別のサイトからの同期は許可されていません。' });
        if (fetchSite && fetchSite !== 'same-origin' && fetchSite !== 'none') return json(response, 403, { error: '別のサイトからの同期は許可されていません。' });
        if (request.method === 'GET') return json(response, 200, store.read());
        if (request.method !== 'POST') return json(response, 405, { error: 'GETまたはPOSTを使用してください。' });
        if (!allowedOrigin) return json(response, 403, { error: '同期リクエストのOriginが必要です。' });
        if (String(request.headers['content-type'] || '').split(';')[0].trim().toLowerCase() !== 'application/json') return json(response, 415, { error: 'application/jsonを使用してください。' });
        const payload = await readJson(request, options.maxBodyBytes || MAX_JSON_BYTES);
        if (!payload || typeof payload !== 'object' || Array.isArray(payload) || !payload.snapshot) throw new InputError('snapshotを指定してください。');
        let result;
        try { result = await store.merge(payload.snapshot); } catch (error) {
          if (error instanceof InputError) throw error;
          console.error('Meal Note synchronization write failed:', error.code || error.message);
          return json(response, 503, { error: 'PCの保存先に書き込めませんでした。端末のデータはそのまま保持してください。' });
        }
        return json(response, 200, result);
      }
      if (pathname.startsWith('/api/')) return json(response, 404, { error: '見つかりません。' });
      if (request.method !== 'GET' && request.method !== 'HEAD') return json(response, 405, { error: 'GETを使用してください。' });
      if (pathname === '/app-config.js') {
        response.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store' });
        const config = { googleClientId: '', localSync: { enabled: true, endpoint: './api/sync', pollIntervalMs: 15000 } };
        return response.end(request.method === 'HEAD' ? undefined : 'window.MEAL_NOTE_CONFIG = ' + JSON.stringify(config) + ';\n');
      }
      const file = pathname === '/' ? 'index.html' : pathname.slice(1);
      if (!STATIC_FILES.has(file)) return json(response, 404, { error: '見つかりません。' });
      const bytes = await fs.readFile(path.join(root, file));
      response.writeHead(200, { 'Content-Type': STATIC_FILES.get(file), 'Cache-Control': 'no-cache' });
      response.end(request.method === 'HEAD' ? undefined : bytes);
    } catch (error) {
      if (response.headersSent) { response.end(); return; }
      if (error instanceof InputError) return json(response, error.status, { error: error.message });
      if (error.code === 'ENOENT') return json(response, 404, { error: '見つかりません。' });
      console.error('Meal Note request failed:', error.code || error.message);
      return json(response, 500, { error: 'PCサーバーでエラーが発生しました。' });
    }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  return {
    server,
    store,
    listen(port = options.port ?? 4319) {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', () => { server.off('error', reject); resolve(server.address()); });
      });
    },
    async close() {
      if (server.listening) await new Promise((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve());
        server.closeIdleConnections();
      });
      await store.close();
    }
  };
}

function argumentsFrom(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!['--port', '--data-dir', '--public-origin', '--root-dir'].includes(key) || !argv[index + 1]) throw new Error('Usage: node server/local-sync.cjs [--port 4319] [--data-dir data/local-sync] [--public-origin https://host.ts.net:8443]');
    const value = argv[++index];
    if (key === '--port') {
      const port = Number(value);
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('portは1〜65535で指定してください。');
      options.port = port;
    } else options[{ '--data-dir': 'dataDir', '--public-origin': 'publicOrigin', '--root-dir': 'rootDir' }[key]] = value;
  }
  return options;
}

if (require.main === module) {
  (async () => {
    const options = argumentsFrom(process.argv.slice(2));
    const app = await createLocalSyncServer(options);
    try { await app.listen(); } catch (error) { await app.close(); throw error; }
    const port = app.server.address().port;
    console.log('Meal Note sync server: http://127.0.0.1:' + port + '/');
    console.log('Data directory: ' + app.store.directory);
    let stopping = false;
    const stop = async () => { if (stopping) return; stopping = true; await app.close(); process.exit(0); };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  })().catch(error => { console.error(error.message); process.exitCode = 1; });
}

module.exports = { createLocalSyncServer, argumentsFrom };
