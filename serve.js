// ローカル確認用サーバー。API も同じコード（lib/wiki.js）で動き、データは .data/ フォルダに保存されます。
// 管理者パスワードは .env（ADMIN_NE= / ADMIN_CL= / ADMIN_CH=）から読みます。
// 使い方: node serve.js  →  http://localhost:8080
import http from 'node:http';
import fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { handle } from './lib/wiki.js';
import { renderPage } from './lib/ssr.js';
import { setConfig } from './public/paths.js';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(DIR, 'public');
const DATA = path.join(DIR, '.data');
const PORT = process.env.PORT || 8080;
// 手元ではフォルダなし・API は同じサーバーの /api
setConfig({ site: `http://localhost:${PORT}`, base: '', api: '/api' });
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.txt': 'text/plain; charset=utf-8',
};

const env = { ...process.env };
try {
  for (const line of readFileSync(path.join(DIR, '.env'), 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
    if (m) env[m[1]] = m[2];
  }
} catch { /* .env がなければ管理者ログインは無効 */ }

// Netlify Blobs の代わりにファイルへ保存するストア
const fileOf = key => path.join(DATA, encodeURIComponent(key) + '.json');
const store = {
  async get(key) {
    try { return JSON.parse(await fs.readFile(fileOf(key), 'utf8')); } catch { return null; }
  },
  async set(key, value) {
    await fs.mkdir(DATA, { recursive: true });
    await fs.writeFile(fileOf(key), JSON.stringify(value));
  },
  async delete(key) {
    for (const ext of ['.json', '.bin', '.meta']) await fs.unlink(path.join(DATA, encodeURIComponent(key) + ext)).catch(() => {});
  },
  async list(prefix) {
    const files = await fs.readdir(DATA).catch(() => []);
    return files.filter(f => f.endsWith('.json')).map(f => decodeURIComponent(f.replace(/\.json$/, ''))).filter(k => k.startsWith(prefix));
  },
  async getBlob(key) {
    try {
      const data = await fs.readFile(path.join(DATA, encodeURIComponent(key) + '.bin'));
      const { contentType } = JSON.parse(await fs.readFile(path.join(DATA, encodeURIComponent(key) + '.meta'), 'utf8'));
      return { data, contentType };
    } catch { return null; }
  },
  async setBlob(key, data, contentType) {
    await fs.mkdir(DATA, { recursive: true });
    await fs.writeFile(path.join(DATA, encodeURIComponent(key) + '.bin'), Buffer.from(data));
    await fs.writeFile(path.join(DATA, encodeURIComponent(key) + '.meta'), JSON.stringify({ contentType }));
  },
};

http.createServer(async (req, res) => {
  const p = decodeURIComponent(req.url.split('?')[0]);

  if (p.startsWith('/api/') || p.startsWith('/img/')) {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const request = new Request(`http://localhost${req.url}`, {
      method: req.method, headers: req.headers,
      body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks),
    });
    const r = await handle(request, store, { ip: req.socket.remoteAddress, env });
    res.writeHead(r.status, Object.fromEntries(r.headers));
    return res.end(Buffer.from(await r.arrayBuffer()));
  }

  // 静的ファイルがあればそれを返し、なければページを組み立てる（Netlify の preferStatic と同じ動き）
  const file = path.join(PUBLIC, path.normalize(p));
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
  try {
    const data = await fs.readFile(file);
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    return res.end(data);
  } catch { /* 静的ファイルなし */ }
  await handle(new Request(`http://localhost${req.url}`), store, { env }); // サンプルページの初回投入
  const r = await renderPage(new Request(`http://localhost:${PORT}${req.url}`), store);
  res.writeHead(r.status, Object.fromEntries(r.headers));
  res.end(Buffer.from(await r.arrayBuffer()));
}).listen(PORT, () => console.log(`MOD Wiki: http://localhost:${PORT}`));
